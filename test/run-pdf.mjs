// Prints what the app's PDF reader gets from each page of a PDF, using the app's own modules.
//   node test/run-pdf.mjs test/fixtures/typed.pdf
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pageGlyphs, rebuild } from '../renderer/pdfglyphs.js';
import { Repairer } from '../renderer/repair.js';
import { joinPdfLines, textLooksComplete, hasThaana, looksScanned } from '../renderer/pdftext.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const words = fs.readFileSync(path.join(root, 'lang', 'dhivehi-words.txt'), 'utf8').split(/\r?\n/).filter(Boolean);

export async function readPdf(file, opts = {}) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const rep = new Repairer(words);
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const g = await pageGlyphs(pdfjs, page);
    const lines = rebuild(g, { dropArabic: true, ...opts });
    const raw = lines.join('\n');
    // same decisions as addFile() in renderer.js
    let kind = 'blank', text = '';
    if (hasThaana(raw) && !textLooksComplete(raw)) kind = 'damaged text (read as picture)';
    else if (hasThaana(raw)) { kind = 'text'; text = joinPdfLines(rep.fixText(raw).split('\n'), opts.join ?? true); }
    else if (looksScanned(g)) kind = 'scan (needs Read text)';
    pages.push({ kind, text, raw, glyphs: g.glyphs.length, images: g.images.length });
  }
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
    const pages = await readPdf(f);
    pages.forEach((pg, i) => {
      console.log(`--- ${path.basename(f)} page ${i + 1}: ${pg.kind} (${pg.glyphs} glyphs, ${pg.images} images)`);
      const shown = pg.text || (process.argv.includes('--raw') ? pg.raw : '');
      if (shown) console.log(shown.split('\n').map((l) => '  | ' + l.replace(/\t/g, ' \u21E5 ')).join('\n'));
    });
  }
}
