// Drives the real app like a user: drops PDFs on the window, reads the text box,
// clicks "Save as Word" and "Read text". Needs the fixtures (see make-fixtures.*).
//   npx electron test/app-smoke.cjs [extra.pdf ...]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, dialog, BrowserWindow } = require('electron');

const fx = (n) => path.join(__dirname, 'fixtures', n);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thaana-smoke-'));
let saveTo = null;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });   // no dialog in tests
require('../main.js');

// read one file out of a .zip (.docx) with node's zlib
function unzipEntry(buf, name) {
  let e = buf.length - 22; while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0, n = buf.readUInt16LE(e + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28);
    const xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nl) === name) {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + size);
      return (method === 8 ? require('zlib').inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error(name + ' not in zip');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + info}`); };

app.whenReady().then(async () => {
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
  const wc = win.webContents;
  while (wc.isLoading()) await sleep(100);
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const js = (s) => wc.executeJavaScript(s);
  const status = () => js(`document.getElementById('status').textContent`);
  const text = () => js(`document.getElementById('text').value`);
  const until = async (cond, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await sleep(250); } return false; };
  const drop = async (file) => {
    const b64 = fs.readFileSync(file).toString('base64'), name = path.basename(file);
    await js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(name)}));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true })); })()`);
    await until(async () => { const s = await status(); return !s.startsWith('Opening') && (s.includes(name) || s.includes('ready')); });
  };
  const clear = () => js(`document.getElementById('btnClear').click()`);
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

  try {
    // 1. typed PDF with a bordered table
    await drop(fx('typed.pdf'));
    let t = await text();
    check('typed.pdf: paragraph text with all vowel signs', t.includes(spec.paragraphs[0]), t);
    check('typed.pdf: table rows kept as rows (wrapped cell joined)', spec.table.every((r) => t.split('\n').includes(r.join('\t'))), t);

    // 2. Save as Word -> real table in the .docx
    saveTo = path.join(outDir, 'typed.docx');
    await js(`document.getElementById('btnDocx').click()`);
    await until(async () => (await status()).startsWith('Saved'), 20000);
    const xml = unzipEntry(fs.readFileSync(saveTo), 'word/document.xml');
    const rows = (xml.match(/<w:tr[ >]/g) || []).length;
    const cellText = [...xml.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(''));
    check('Save as Word: one table with 3 rows x 4 cells', (xml.match(/<w:tbl>/g) || []).length === 1 && rows === 3 && cellText.length === 12, `tables/rows/cells ${(xml.match(/<w:tbl>/g) || []).length}/${rows}/${cellText.length}`);
    check('Save as Word: wrapped cell is one cell', cellText.includes(spec.table[1][3]), JSON.stringify(cellText));

    // 3. typed page + scanned page
    await clear();
    await drop(fx('mixed.pdf'));
    const s = await status();
    check('mixed.pdf: status says page 2 is a scan', /is a scan/.test(s), s);
    check('mixed.pdf: Read text is enabled', await js(`!document.getElementById('btnRead').disabled`));
    await js(`document.getElementById('btnRead').click()`);
    const done = await until(async () => /^Done|went wrong/.test(await status()), 300000);
    t = await text();
    const parts = t.split('\n\n');
    const ocr = parts.slice(1).join('\n');
    check('Read text: finished without error', done && (await status()).startsWith('Done'), await status());
    check('Read text: typed page text still first', parts[0].includes(spec.paragraphs[0]), parts[0].slice(0, 200));
    check('Read text: scanned page read into Thaana', ((ocr.match(/[ހ-ޱ]/g) || []).length > 200), ocr.slice(0, 300));
    fs.writeFileSync(path.join(outDir, 'mixed-ocr.txt'), t);

    // 4. any extra PDFs given on the command line: just report what came out
    for (const f of process.argv.slice(2).filter((a) => a.toLowerCase().endsWith('.pdf'))) {
      await clear(); await drop(path.resolve(f));
      t = await text();
      fs.writeFileSync(path.join(outDir, path.basename(f) + '.txt'), t);
      check(`${path.basename(f)}: text taken from the PDF`, t.length > 100, await status());
    }
    check('no errors in the window console', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('smoke run', false, e.stack);
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed. Output in ${outDir}`);
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
