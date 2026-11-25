// node --test test/
// Needs the fixtures from test/make-fixtures.ps1 + test/make-fixtures.py (skipped when missing).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPdf } from './run-pdf.mjs';
import { joinPdfLines, textLooksComplete } from '../renderer/pdftext.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, 'fixtures', n);
const spec = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8'));
const need = (n) => ({ skip: !fs.existsSync(fx(n)) && `run test/make-fixtures.* first (${n} missing)` });

test('joinPdfLines never joins table rows', () => {
  const long = 'ހ'.repeat(50);
  assert.equal(joinPdfLines([long, 'a\tb', long, long], true), `${long}\na\tb\n${long} ${long}`);
});

test('textLooksComplete', () => {
  assert.equal(textLooksComplete('ދިވެހި'.repeat(40)), true);
  assert.equal(textLooksComplete('ދވހ'.repeat(40)), false);
});

for (const file of ['typed.pdf', 'typed-noborders.pdf']) {
  test(`${file}: every word comes back exactly, table rows stay rows`, need(file), async () => {
    const [pg] = await readPdf(fx(file));
    assert.equal(pg.kind, 'text');
    const lines = pg.text.split('\n');
    // paragraphs: all words with all their vowel signs
    for (const p of spec.paragraphs) assert.ok(pg.text.includes(p), `missing: ${p}\n--- got:\n${pg.text}`);
    assert.ok(lines.includes(spec.after), `missing: ${spec.after}`);
    // table: one line per row, cells in order (right to left), wrapped cell kept whole
    for (const row of spec.table) assert.ok(lines.includes(row.join('\t')), `missing row: ${row.join(' | ')}\n--- got:\n${pg.text}`);
  });
}

test('mixed.pdf: typed page is read, scanned page is left for Read text', need('mixed.pdf'), async () => {
  const pages = await readPdf(fx('mixed.pdf'));
  assert.equal(pages[0].kind, 'text');
  assert.match(pages[1].kind, /^scan/);
});

test('form.pdf: text inside form XObjects lands in the right place', need('form.pdf'), async () => {
  const [pg] = await readPdf(fx('form.pdf'));
  // the two half-size copies sit side by side: each table row twice, each list line twice (as two cells)
  const lines = pg.raw.split('\n');
  for (const row of spec.table) assert.equal(lines.filter((l) => l === row.join('\t')).length, 2, pg.raw);
  assert.ok(lines.includes(`${spec.paragraphs[1]}\t${spec.paragraphs[1]}`), pg.raw);
});
