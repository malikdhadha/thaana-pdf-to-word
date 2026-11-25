import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.mjs';
import { pageGlyphs, rebuild } from './pdfglyphs.js';
import { Repairer } from './repair.js';
import { joinPdfLines, textLooksComplete, hasThaana, looksScanned } from './pdftext.js';
import { findBlocks } from './columns.js';
import { removeRuling, grayToCanvas, normalize, otsu, findSkew, rotateGray, findLines, cropToPng, paragraphBreaks } from './segment.js';

const $ = (id) => document.getElementById(id);
const pagesEl = $('pages'), textEl = $('text'), statusEl = $('status'), bar = $('bar');
const btn = { open: $('btnOpen'), read: $('btnRead'), copy: $('btnCopy'), docx: $('btnDocx'), txt: $('btnTxt'), clear: $('btnClear'), label: $('btnLabel') };

let pages = [];          // { id, name, canvas, rotation, text, el }
let busy = false;
let baseName = 'thaana-text';
let repairer = null;
async function getRepairer() {
  // \r?\n: a Windows checkout has CRLF line endings, and "word\r" never matches anything
  if (!repairer) repairer = new Repairer((await window.ocr.readWords()).split(/\r?\n/).filter(Boolean));
  return repairer;
}
function refreshPdfText() {
  const t = pages.map((p) => p.text).filter(Boolean).join('\n\n');
  if (t) textEl.value = t;
}

function setStatus(msg, warn = false) { statusEl.textContent = msg; statusEl.classList.toggle('warn', warn); }
function refreshButtons() {
  const hasText = textEl.value.trim().length > 0;
  btn.read.disabled = busy || pages.length === 0;
  btn.open.disabled = busy;
  btn.label.disabled = busy || !pages.some((p) => !p.fromPdf);
  btn.copy.disabled = btn.docx.disabled = btn.txt.disabled = busy || !hasText;
  $('emptyHint').style.display = pages.length ? 'none' : '';
  const words = textEl.value.trim() ? textEl.value.trim().split(/\s+/).length : 0;
  $('counts').textContent = words ? `${words} words` : '';
}

/* ---------- loading files ---------- */
// data: base64 (from the Open dialog) or bytes: Uint8Array (drag & drop).
async function addFile({ name, data, bytes, ext }) {
  baseName = name.replace(/\.[^.]+$/, '');
  if (!bytes) bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  if (ext === '.pdf') {
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const useText = $('optPdfText').checked;
    let fromText = 0; const mine = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      setStatus(`Opening ${name} — page ${p} of ${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      let txt = '', incomplete = false, scanned = false;
      if (useText) {
        try {
          const found = await pageGlyphs(pdfjsLib, page);
          const lines = rebuild(found, { dropArabic: $('optNoArabic').checked });
          const raw = lines.join('\n');
          if (hasThaana(raw) && !textLooksComplete(raw)) incomplete = true;
          if (hasThaana(raw) && textLooksComplete(raw)) txt = joinPdfLines((await getRepairer()).fixText(raw).split('\n'), $('optJoin').checked);
          if (!txt && !incomplete) scanned = looksScanned(found);
        } catch (e) { console.warn('PDF text failed on page', p, e); }
      }
      const vp1 = page.getViewport({ scale: 1 });
      const scale = txt ? 0.5 : Math.min(4, 2600 / vp1.width);   // text pages only need a thumbnail
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const pg = addPage(`${name} · p${p}`, c); pg.incomplete = incomplete; pg.scanned = scanned; mine.push(pg);
      if (txt) { pg.text = txt; pg.fromPdf = true; pg.el.className = 'page done'; fromText++; }
    }
    if (fromText) {
      // Pages without text are blank, unless they show a scanned page: those are left for "Read text".
      mine.forEach((pg) => { if (!pg.incomplete && !pg.scanned) { pg.fromPdf = true; pg.el.className = 'page done'; } });
      refreshPdfText();
      const inc = mine.filter((pg) => pg.incomplete).length, scans = mine.filter((pg) => pg.scanned).length;
      const blank = mine.length - fromText - inc - scans;
      const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
      setStatus(`${name}: text taken straight from the PDF (${plural(fromText, 'page')}${blank ? `, ${blank} blank` : ''}) — no reading needed. Copy or save as Word.`
        + (inc ? ` ${plural(inc, 'page')} had damaged text inside the PDF — click “Read text” to read ${inc > 1 ? 'them' : 'it'} as a picture.` : '')
        + (scans ? ` ${plural(scans, 'page')} ${scans > 1 ? 'are scans' : 'is a scan'} — click “Read text” to read ${scans > 1 ? 'them' : 'it'}.` : ''));
    } else if (mine.some((pg) => pg.incomplete)) {
      setStatus(`${name}: the text inside this PDF is damaged (missing vowel signs), so it will be read as a picture. Click “Read text”.`, true);
    }
    return fromText > 0 || mine.some((pg) => pg.incomplete);   // true: the status line already says what to do
  } else {
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : ext.startsWith('.tif') ? 'image/tiff' : 'image/jpeg';
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = await loadImage(url).catch(() => null);
    URL.revokeObjectURL(url);
    if (!img) { setStatus(`Couldn't open ${name} (TIFF files may need converting to PNG/JPG).`, true); return; }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    addPage(name, c);
  }
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
function addPage(name, canvas) {
  const page = { id: crypto.randomUUID(), name, canvas, rotation: 0, text: '' };
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `<img alt=""><div class="row"><span class="name"></span><span class="tools">
    <button data-a="rot" title="Rotate 90°">⟳</button><button data-a="del" title="Remove">✕</button></span></div>`;
  el.querySelector('.name').textContent = name;
  el.querySelector('[data-a=rot]').onclick = () => { page.rotation = (page.rotation + 90) % 360; drawThumb(page); };
  el.querySelector('[data-a=del]').onclick = () => { pages = pages.filter((p) => p !== page); el.remove(); refreshButtons(); };
  page.el = el; pagesEl.appendChild(el); pages.push(page);
  drawThumb(page); refreshButtons();
  return page;
}
function drawThumb(page) {
  const t = rotated(page.canvas, page.rotation, 400 / Math.max(page.canvas.width, page.canvas.height));
  page.el.querySelector('img').src = t.toDataURL('image/jpeg', 0.8);
}
function rotated(src, deg, scale = 1) {
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  const c = document.createElement('canvas');
  const side = deg % 180 !== 0;
  c.width = side ? h : w; c.height = side ? w : h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate((deg * Math.PI) / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  return c;
}

/* ---------- image clean-up + line finding ---------- */
function prepare(page, enhance) {
  // Aim for text big enough for the OCR engine: ~2400–3200 px across a page.
  const longSide = Math.max(page.canvas.width, page.canvas.height);
  const scale = longSide < 2400 ? Math.min(3, 2400 / longSide) : longSide > 3600 ? 3600 / longSide : 1;
  const c = rotated(page.canvas, page.rotation, scale);
  const w = c.width, h = c.height;
  let g = normalize(c, enhance);
  const thr = otsu(g);
  const skew = findSkew(g, w, h, thr);
  g = rotateGray(g, w, h, skew);
  // Newspapers / magazines: split into columns first (right-to-left), then find lines in each block.
  let blocks = [];
  try { blocks = $('optColumns') && $('optColumns').checked ? findBlocks(g, w, h, thr) : []; } catch (e) { console.error(e); }
  if (blocks.length > 1) {
    const subs = blocks.map((bl, bi) => {
      const bw = bl.r - bl.l, bh = bl.b - bl.t; if (bw < 20 || bh < 10) return null;
      const sub = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) sub.set(g.subarray((bl.t + y) * w + bl.l, (bl.t + y) * w + bl.r), y * bw);
      return { bl, bi, bw, bh, sub, own: findLines(sub, bw, bh, thr) };
    }).filter(Boolean);
    // A block of one or two lines cannot show its own line spacing (it would cut the vowel-sign rows
    // off as separate lines). With real columns side by side, use the tallest block's spacing;
    // otherwise the blocks are stacked in one column and the whole page shows the spacing best.
    const tall = subs.reduce((a, s) => (!a || s.bh > a.bh ? s : a), null);
    const sideBySide = subs.some((a) => subs.some((b) => a !== b && a.bl.t < b.bl.b && b.bl.t < a.bl.b && (a.bl.r <= b.bl.l || b.bl.r <= a.bl.l)));
    const ref = sideBySide && tall ? tall.own.pitch : findLines(g, w, h, thr).pitch;
    const boxes = [], lines = [], blk = []; let pitch = 0;
    subs.forEach(({ bl, bi, bw, bh, sub, own }) => {
      const r = bh >= 4 * ref ? own : findLines(sub, bw, bh, thr, ref);
      pitch = pitch || r.pitch;
      r.boxes.forEach((b) => { lines.push(cropToPng(sub, bw, b, r.pitch)); boxes.push({ l: b.l + bl.l, t: b.t + bl.t, r: b.r + bl.l, b: b.b + bl.t }); blk.push(bi); });
    });
    return { lines, boxes, pitch: pitch || 45, skew, blk };
  }
  const { boxes, pitch } = findLines(g, w, h, thr);
  const lines = boxes.map((b) => cropToPng(g, w, b, pitch));
  return { lines, boxes, pitch, skew };
}

/* ---------- OCR ---------- */
let pageIndex = 0, pageCount = 1;
window.ocr.onProgress((p) => { if (busy) bar.style.width = `${((pageIndex + p) / pageCount) * 100}%`; });

function assemble(results, boxes, pitch, joinParas, blk) {
  if (blk) {   // column mode: assemble each block separately, blocks separated by a blank line
    const parts = new Map();
    results.forEach((r, i) => { if (!parts.has(blk[i])) parts.set(blk[i], { r: [], b: [] }); parts.get(blk[i]).r.push(r); parts.get(blk[i]).b.push(boxes[i]); });
    return [...parts.values()].map((p) => assemble(p.r, p.b, pitch, joinParas)).filter(Boolean).join('\n\n');
  }
  if (!joinParas) return results.map((r) => r.text).filter(Boolean).join('\n');
  const breaks = paragraphBreaks(boxes, pitch);
  let out = '';
  results.forEach((r, i) => {
    if (!r.text) return;
    out += out ? (breaks[i] ? '\n' : ' ') + r.text : r.text;
  });
  return out;
}

async function readAll() {
  if (!pages.length) return;
  busy = true; refreshButtons();
  const enhance = $('optEnhance').checked, english = $('optEnglish').checked, joinParas = $('optJoin').checked;
  pageCount = pages.length;
  const out = [];
  const t0 = performance.now();
  try {
    for (pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const page = pages[pageIndex];
      if (page.fromPdf) { out.push(page.text); textEl.value = out.filter(Boolean).join('\n\n'); continue; }
      page.el.className = 'page working';
      setStatus(`Finding text lines on page ${pageIndex + 1} of ${pages.length}…`);
      await new Promise((r) => setTimeout(r, 30));
      const prep = prepare(page, enhance);
      if (!prep.lines.length) { page.el.className = 'page'; out.push(''); continue; }
      setStatus(pageIndex === 0 && !window.__warm ? 'Starting the reader (first time takes a few seconds)…' : `Reading page ${pageIndex + 1} of ${pages.length} (${prep.lines.length} lines)…`);
      const results = await window.ocr.recognizeLines(prep.lines, english);
      window.__warm = true;
      page.text = assemble(results, prep.boxes, prep.pitch, joinParas, prep.blk);
      page.el.className = 'page done';
      out.push(page.text);
      textEl.value = out.filter(Boolean).join('\n\n');
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    setStatus(`Done — ${pages.length} page${pages.length > 1 ? 's' : ''} in ${secs}s. Check the fili before saving.`);
  } catch (e) {
    console.error(e);
    setStatus('Something went wrong while reading: ' + (e.message || e), true);
  } finally {
    busy = false; bar.style.width = '0'; refreshButtons();
  }
}

/* ---------- buttons ---------- */
btn.open.onclick = async () => {
  const files = await window.ocr.openFiles();
  let told = false;
  for (const f of files) told = (await addFile(f)) || told;
  if (files.length && !told && !pages.every((p) => p.fromPdf)) setStatus(`${pages.length} page(s) ready. Click “Read text”.`);
  refreshButtons();
};
btn.read.onclick = readAll;
btn.copy.onclick = async () => { await window.ocr.copy(textEl.value); setStatus('Copied. Paste into Word with ⌘V / Ctrl+V.'); };
btn.docx.onclick = async () => {
  const p = await window.ocr.saveDocx({ text: textEl.value, fontName: $('optFont').value, fontSize: +$('optSize').value || 14, suggestedName: baseName });
  if (p) setStatus('Saved: ' + p);
};
btn.txt.onclick = async () => { const p = await window.ocr.saveTxt({ text: textEl.value, suggestedName: baseName }); if (p) setStatus('Saved: ' + p); };
/* ---------- handwriting labelling ---------- */
const L = { queue: [], i: 0, saved: 0, last: null };
function prepareLabel(page) {
  const longSide = Math.max(page.canvas.width, page.canvas.height);
  const scale = longSide > 3000 ? 3000 / longSide : longSide < 1800 ? Math.min(2, 1800 / longSide) : 1;
  const c = rotated(page.canvas, page.rotation, scale);
  const w = c.width, h = c.height;
  let g = normalize(c, true);
  const thr = otsu(g);
  const skew = findSkew(g, w, h, thr);
  g = rotateGray(g, w, h, skew);
  const gc = removeRuling(g, w, h, thr);
  const { boxes, pitch } = findLines(gc, w, h, thr);
  return { g, gc, w, boxes, pitch };
}
function crop(g, w, b) {
  const cw = b.r - b.l, ch = b.b - b.t, out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = g[(b.t + y) * w + b.l + x];
  return grayToCanvas(out, cw, ch);
}
async function startLabeling() {
  $('labeler').hidden = false; $('lprog').textContent = 'finding lines…';
  await new Promise((r) => setTimeout(r, 30));
  L.queue = [];
  for (const page of pages.filter((p) => !p.fromPdf)) {
    const pr = prepareLabel(page);
    pr.boxes.forEach((b) => L.queue.push({ pngOrig: crop(pr.g, pr.w, b).toDataURL('image/png').split(',')[1], show: crop(pr.gc, pr.w, b).toDataURL('image/png'), pitch: Math.round(pr.pitch), page: page.name }));
  }
  L.i = 0; L.last = null; L.saved = await window.ocr.labelCount(); showLine();
}
function showLine() {
  const it = L.queue[L.i];
  if (!it) { $('lprog').textContent = `all lines done · ${L.saved} saved in total`; $('limg').removeAttribute('src'); $('ltext').value = ''; return; }
  $('limg').src = it.show; $('ltext').value = ''; $('ltext').focus();
  $('lprog').textContent = `line ${L.i + 1} of ${L.queue.length} · ${L.saved} saved in total`;
}
async function saveLine() {
  const it = L.queue[L.i]; const text = $('ltext').value.trim(); if (!it || !text) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await window.ocr.labelSave({ id, png: it.pngOrig, text, meta: `pitch=${it.pitch};src=${it.page}` });
  L.last = id; L.saved++; L.i++; showLine();
}
btn.label.onclick = startLabeling;
$('lsave').onclick = saveLine;
$('ltext').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveLine(); } });
$('lskip').onclick = () => { L.i++; showLine(); };
$('lundo').onclick = async () => { if (L.last) { await window.ocr.labelUndo(L.last); L.last = null; L.saved--; L.i = Math.max(0, L.i - 1); showLine(); } };
$('lfolder').onclick = () => window.ocr.labelShow();
$('lclose').onclick = () => { $('labeler').hidden = true; };

btn.clear.onclick = () => { pages = []; pagesEl.querySelectorAll('.page').forEach((e) => e.remove()); textEl.value = ''; setStatus('Cleared.'); refreshButtons(); };
textEl.addEventListener('input', refreshButtons);

/* ---------- drag & drop ---------- */
const exts = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp', '.pdf'];
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (busy) return;
  let told = false;
  for (const file of e.dataTransfer.files) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!exts.includes(ext)) { setStatus(`Skipped ${file.name} — not an image or PDF.`, true); told = true; continue; }
    told = (await addFile({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), ext })) || told;
  }
  if (!told && !pages.every((p) => p.fromPdf)) setStatus(`${pages.length} page(s) ready. Click “Read text”.`);
  refreshButtons();
});

// Paste a screenshot straight from the clipboard (⌘V / Ctrl+V) when the text box isn't focused.
window.addEventListener('paste', async (e) => {
  if (document.activeElement === textEl) return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      const c = document.createElement('canvas');
      const img = await loadImage(URL.createObjectURL(file));
      c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
      addPage('Pasted image', c);
      setStatus('Image pasted. Click “Read text”.');
    }
  }
});

window.ocr.info().then((i) => {
  document.title = `Thaana PDF to Word ${i.version}`;
  if (!i.model) setStatus('Reading scans is not available: the Thaana reading model (lang/div.traineddata) is missing. Typed PDFs still work.', true);
});
refreshButtons();
