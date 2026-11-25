// Thaana PDF to Word — main process: windows, OCR engine, saving files.
const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { createWorker, createScheduler, PSM } = require('tesseract.js');
const os = require('os');
const docx = require('docx');

// Language files live in /lang (unpacked from the asar archive when packaged).
const LANG_DIR = path.join(__dirname, 'lang').replace('app.asar', 'app.asar.unpacked');
// divx = the app's own model (not in the source repo); div = Tesseract's standard Dhivehi model.
const THAANA_MODEL = ['divx', 'div'].find((m) => fs.existsSync(path.join(LANG_DIR, m + '.traineddata'))) || null;

let win;
let scheduler = null;
let schedulerLangs = '';
const N_WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));

async function getScheduler(withEnglish) {
  if (!THAANA_MODEL) throw new Error(`No Thaana reading model found. Put div.traineddata in ${LANG_DIR}.`);
  const langs = withEnglish ? `${THAANA_MODEL}+eng` : THAANA_MODEL;
  if (scheduler && schedulerLangs === langs) return scheduler;
  if (scheduler) await scheduler.terminate();
  scheduler = createScheduler();
  const workers = await Promise.all(Array.from({ length: N_WORKERS }, async () => {
    const w = await createWorker(langs, 1, {
      langPath: LANG_DIR,
      cachePath: path.join(app.getPath('userData'), 'ocr-cache'),
      gzip: false,
      cacheMethod: 'none',
    });
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '1' });
    return w;
  }));
  workers.forEach((w) => scheduler.addWorker(w));
  schedulerLangs = langs;
  return scheduler;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Thaana PDF to Word',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Clean up common OCR noise in Thaana output.
function tidy(text) {
  return text
    .replace(/[‎‏‪-‮]/g, '')   // stray direction marks
    .replace(/[ً-ْ]/g, '')               // Arabic harakat the model sometimes invents
    .replace(/ {2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([ހ-ޱ]) ?,/g, '$1،')         // Latin comma after Thaana -> Thaana comma
    .replace(/([ހ-ޱ]) ?\?/g, '$1؟')        // Latin ? after Thaana -> Thaana question mark
    .trim();
}

// Recognise a batch of single text lines (PNG, base64) in parallel.
ipcMain.handle('ocr-lines', async (_e, { lines, withEnglish }) => {
  const sch = await getScheduler(withEnglish);
  let done = 0;
  const results = await Promise.all(lines.map(async (b64) => {
    const { data } = await sch.addJob('recognize', Buffer.from(b64, 'base64'));
    done++;
    if (win) win.webContents.send('ocr-progress', done / lines.length);
    return { text: tidy(data.text).replace(/\n+/g, ' '), confidence: data.confidence };
  }));
  return results;
});

ipcMain.handle('copy-text', (_e, text) => {
  const paras = text.split(/\n/).map((l) => `<p dir="rtl" style="text-align:justify;font-family:Faruma,'MV Boli';font-size:14pt">${escapeHtml(l) || '&nbsp;'}</p>`).join('');
  clipboard.write({ text, html: `<html><body dir="rtl">${paras}</body></html>` });
  return true;
});

ipcMain.handle('save-docx', async (_e, { text, fontName, fontSize, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save as Word document',
    defaultPath: (suggestedName || 'thaana-text') + '.docx',
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  });
  if (canceled || !filePath) return null;
  const size = Math.round((fontSize || 14) * 2); // half-points
  const run = (t) => new docx.TextRun({
    text: t, rightToLeft: true,
    font: { ascii: fontName, hAnsi: fontName, cs: fontName, eastAsia: fontName },
    size, sizeComplexScript: size,
  });
  const para = (t, justify = true) => new docx.Paragraph({
    bidirectional: true,
    alignment: justify ? docx.AlignmentType.BOTH : docx.AlignmentType.START,
    spacing: { after: justify ? 120 : 40, line: justify ? 360 : 300 },
    children: [run(t)],
  });
  // Lines containing tabs are table rows (cells were separated by wide gaps in the PDF).
  const lines = text.split(/\n/); const paragraphs = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].includes('\t')) { paragraphs.push(para(lines[i])); i++; continue; }
    const rows = []; while (i < lines.length && lines[i].includes('\t')) rows.push(lines[i++].split('\t'));
    const cols = Math.max(...rows.map((r) => r.length));
    const bd = { style: docx.BorderStyle.SINGLE, size: 4, color: '999999' };
    paragraphs.push(new docx.Table({
      visuallyRightToLeft: true,
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
      borders: { top: bd, bottom: bd, left: bd, right: bd, insideHorizontal: bd, insideVertical: bd },
      rows: rows.map((r) => new docx.TableRow({
        children: Array.from({ length: cols }, (_, c) => new docx.TableCell({ children: [para(r[c] || '', false)] })),
      })),
    }));
    paragraphs.push(para('', false));
  }
  const doc = new docx.Document({
    styles: {
      default: {
        document: {
          run: { font: { ascii: fontName, hAnsi: fontName, cs: fontName }, size, sizeComplexScript: size, rightToLeft: true },
          paragraph: { bidirectional: true },
        },
      },
    },
    sections: [{ properties: {}, children: paragraphs }],
  });
  fs.writeFileSync(filePath, await docx.Packer.toBuffer(doc));
  return filePath;
});

ipcMain.handle('save-txt', async (_e, { text, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save as text file',
    defaultPath: (suggestedName || 'thaana-text') + '.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, '﻿' + text, 'utf8');
  return filePath;
});

ipcMain.handle('open-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose scans, photos or PDFs',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images and PDFs', extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'pdf'] }],
  });
  if (canceled) return [];
  return filePaths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p).toString('base64'), ext: path.extname(p).toLowerCase() }));
});

ipcMain.handle('read-words', () => {
  try { return fs.readFileSync(path.join(LANG_DIR, 'dhivehi-words.txt'), 'utf8'); } catch { return ''; }
});
// ---- handwriting labelling: one PNG + one line of text per labelled line ----
function labelDir() { const d = path.join(app.getPath('documents'), 'Thaana-handwriting-labels'); fs.mkdirSync(path.join(d, 'images'), { recursive: true }); return d; }
const validId = (id) => typeof id === 'string' && /^[a-z0-9]{4,32}$/.test(id);   // ids become file names
ipcMain.handle('label-save', (_e, { id, png, text, meta }) => {
  if (!validId(id)) throw new Error('bad label id');
  const d = labelDir();
  fs.writeFileSync(path.join(d, 'images', id + '.png'), Buffer.from(png, 'base64'));
  fs.appendFileSync(path.join(d, 'labels.tsv'), `${id}\t${text.replace(/[\t\r\n]+/g, ' ')}\t${meta || ''}\n`, 'utf8');
  return d;
});
ipcMain.handle('label-undo', (_e, id) => {
  if (!validId(id)) return;
  const d = labelDir(); try { fs.unlinkSync(path.join(d, 'images', id + '.png')); } catch {}
  const f = path.join(d, 'labels.tsv');
  try { fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith(id + '\t')).join('\n') + '\n', 'utf8'); } catch {}
});
ipcMain.handle('label-show', () => { const d = labelDir(); require('electron').shell.openPath(d); return d; });
ipcMain.handle('label-count', () => { try { return fs.readFileSync(path.join(labelDir(), 'labels.tsv'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } });
ipcMain.handle('app-info', () => ({ model: THAANA_MODEL, version: app.getVersion() }));

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });   // macOS dock click
app.on('window-all-closed', async () => {
  if (scheduler) await scheduler.terminate();
  app.quit();
});
