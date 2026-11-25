// Reads every glyph of a PDF page with its position (from pdf.js operator list),
// then rebuilds Thaana text in the right order. Pure JS, no native parts.
const FILI = (c) => c >= 'ަ' && c <= 'ް';
const IGN = new Set('‎‏‪‫‬‭‮⁦⁧⁨⁩'.split(''));
const mul = (a, b) => [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3], a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]];
const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

// some PDFs wrap the matrix in an extra array
const mat = (a) => Array.from(a.length === 1 && a[0] && typeof a[0] === 'object' ? a[0] : a);
const isMatrix = (m) => m && m.length === 6 && Array.from(m).every((v) => Number.isFinite(v));

// Returns { glyphs, rules: { h, v }, images, pageArea }.
//   glyphs: every character drawn, with position (PDF units, y grows upward)
//   rules:  thin horizontal / vertical lines (table borders), used to find table cells
//   images: area of every picture drawn, used to tell a scanned page from a blank one
export async function pageGlyphs(pdfjs, page) {
  const O = pdfjs.OPS, ol = await page.getOperatorList();
  const FILL = new Set([O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke, O.rawFillPath].filter((v) => v !== undefined));
  const STROKE = new Set([O.stroke, O.closeStroke, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke].filter((v) => v !== undefined));
  const IMAGE = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageXObjectRepeat, O.paintJpegXObject].filter((v) => v !== undefined));
  const D = pdfjs.DrawOPS || { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
  let ctm = [1,0,0,1,0,0], stack = [], tm = [1,0,0,1,0,0], tlm = [1,0,0,1,0,0];
  let fs = 1, fm = [0.001,0,0,0.001,0,0], cs = 0, ws = 0, hs = 1, lead = 0, rise = 0, lw = 1;
  const out = [], hRules = [], vRules = [], images = [];
  const fontMatrix = (name) => {
    try { const f = page.commonObjs.get(name); if (f && isMatrix(f.fontMatrix)) return Array.from(f.fontMatrix); } catch {}
    return [0.001,0,0,0.001,0,0];
  };
  const show = (glyphs) => {
    for (const g of glyphs) {
      if (typeof g === 'number') { tm = mul([1,0,0,1,-g/1000*fs*hs,0], tm); continue; }
      if (!g) continue;
      const w = (g.width || 0) * fm[0] * fs;
      const t = mul(tm, ctm);
      const c = g.unicode;
      const sx = Math.hypot(t[0], t[1]), sy = Math.hypot(t[2], t[3]);
      if (c) out.push({ c, x0: t[4], x1: t[4] + w * sx, y: t[5], sz: Math.abs(fs) * sy || Math.abs(fs) });
      const adv = (w + cs + (g.isSpace ? ws : 0)) * hs;
      tm = mul([1,0,0,1,adv,0], tm);
    }
  };
  // Table borders: Word draws them as thin filled rectangles; other programs stroke lines.
  const addRule = (x0, y0, x1, y1, thick) => {
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (h <= thick && w >= 3) hRules.push({ y: (y0 + y1) / 2, x0: Math.min(x0, x1), x1: Math.max(x0, x1) });
    else if (w <= thick && h >= 3) vRules.push({ x: (x0 + x1) / 2, y0: Math.min(y0, y1), y1: Math.max(y0, y1) });
  };
  const path = (op, data) => {
    if (!data || !(FILL.has(op) || STROKE.has(op))) return;
    const subs = []; let cur = null, start = null;
    for (let i = 0; i < data.length;) {
      const k = data[i++];
      if (k === D.moveTo) { cur = [apply(ctm, data[i++], data[i++])]; start = cur[0]; subs.push(cur); }
      else if (k === D.lineTo) { const p = apply(ctm, data[i++], data[i++]); (cur || (cur = [p], subs.push(cur), cur)).push(p); }
      else if (k === D.curveTo) { i += 6; cur = null; }         // curves are never table borders
      else if (k === D.quadraticCurveTo) { i += 4; cur = null; }
      else if (k === D.closePath) { if (cur && start) cur.push(start); }
      else break;
    }
    for (const s of subs) {
      if (!s || s.length < 2) continue;
      if (STROKE.has(op)) for (let j = 1; j < s.length; j++) addRule(s[j - 1][0], s[j - 1][1], s[j][0], s[j][1], 1);
      if (FILL.has(op) && s.length >= 4) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of s) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        addRule(x0, y0, x1, y1, 3);
      }
    }
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i]; let a = ol.argsArray[i];
    switch (f) {
      case O.save: stack.push([ctm, fs, fm, cs, ws, hs, lead, rise, lw]); break;
      case O.restore: if (stack.length) [ctm, fs, fm, cs, ws, hs, lead, rise, lw] = stack.pop(); break;
      case O.transform: ctm = mul(mat(a), ctm); break;
      // Text and lines inside a form XObject are drawn with the form's own matrix.
      case O.paintFormXObjectBegin: stack.push([ctm, fs, fm, cs, ws, hs, lead, rise, lw]); if (a && isMatrix(a[0])) ctm = mul(Array.from(a[0]), ctm); break;
      case O.paintFormXObjectEnd: if (stack.length) [ctm, fs, fm, cs, ws, hs, lead, rise, lw] = stack.pop(); break;
      case O.setLineWidth: lw = a[0]; break;
      case O.beginText: tm = [1,0,0,1,0,0]; tlm = tm; break;
      case O.setFont: fs = a[1]; fm = fontMatrix(a[0]); break;
      case O.setCharSpacing: cs = a[0]; break;
      case O.setWordSpacing: ws = a[0]; break;
      case O.setHScale: hs = a[0] / 100; break;
      case O.setLeading: lead = a[0]; break;
      case O.setTextRise: rise = a[0]; break;
      case O.setTextMatrix: tm = mat(a); tlm = tm; break;
      case O.moveText: tlm = mul([1,0,0,1,a[0],a[1]], tlm); tm = tlm; break;
      case O.setLeadingMoveText: lead = -a[1]; tlm = mul([1,0,0,1,a[0],a[1]], tlm); tm = tlm; break;
      case O.nextLine: tlm = mul([1,0,0,1,0,-lead], tlm); tm = tlm; break;
      case O.showText: show(a[0]); break;
      case O.showSpacedText: show(a[0]); break;
      case O.nextLineShowText: tlm = mul([1,0,0,1,0,-lead], tlm); tm = tlm; show(a[0]); break;
      case O.nextLineSetSpacingShowText: ws = a[0]; cs = a[1]; tlm = mul([1,0,0,1,0,-lead], tlm); tm = tlm; show(a[2]); break;
      case O.constructPath: if (a) path(a[0], a[1] && a[1][0]); break;
      default: if (IMAGE.has(f)) images.push({ area: Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) });
    }
  }
  const [vx0, vy0, vx1, vy1] = page.view || [0, 0, 0, 0];
  return { glyphs: out.reverse(), rules: { h: hRules, v: vRules }, images, pageArea: Math.abs((vx1 - vx0) * (vy1 - vy0)) };
}

// A Thaana letter carries at most one vowel sign. Extra ones are stray pieces of a neighbour
// (usually an abafili ަ next to ް or ި), so keep the sign that is not abafili.
function cleanFili(f) {
  const u = [...new Set(f)];
  if (u.length > 1 && u.includes('\u07A6')) { const r = u.filter((c) => c !== '\u07A6'); return r.join(''); }
  return u.join('');
}

// Arabic script, except the comma, semicolon and question mark that Dhivehi uses too (، ؛ ؟).
const ARABIC = /[\u0600-\u060B\u060D-\u061A\u061C-\u061E\u0620-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_MARK = /[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]/;   // vowel marks, tatweel
const THAANA_LETTER = /[\u0780-\u07A5\u07B1]/;
// Quran-verse fonts map whole words to codes in the presentation-forms blocks: not readable text.
// Real ligature words (ﷲ ﷺ and the like, U+FDF0-FDFD) are kept.
const VERSE_GLYPH = /[\uFB50-\uFDEF\uFDFE\uFDFF\uFE70-\uFEFF]/;

// Merge touching pieces of the same border (Word draws one piece per cell edge).
function mergeRules(list, pos, a, b) {
  const s = [...list].sort((p, q) => p[pos] - q[pos] || p[a] - q[a]); const out = [];
  for (const r of s) {
    const m = out.find((o) => Math.abs(o[pos] - r[pos]) < 1.5 && r[a] <= o[b] + 2 && r[b] >= o[a] - 2);
    if (m) { m[a] = Math.min(m[a], r[a]); m[b] = Math.max(m[b], r[b]); m[pos] = (m[pos] + r[pos]) / 2; } else out.push({ ...r });
  }
  return out;
}
const cluster = (vals, tol) => {
  const s = [...vals].sort((p, q) => p - q); const out = [];
  for (const v of s) { if (out.length && v - out[out.length - 1].at(-1) < tol) out[out.length - 1].push(v); else out.push([v]); }
  return out.map((g) => g.reduce((x, y) => x + y, 0) / g.length);
};

// Bordered tables: rows and columns from the border lines. Returns
// [{ x0, x1, y0, y1, rows: [{ top, bot, cells: [{ r, l, span }] }] }]
export function findTables(rules) {
  if (!rules) return [];
  const H = mergeRules(rules.h, 'y', 'x0', 'x1'), V = mergeRules(rules.v, 'x', 'y0', 'y1');
  if (H.length < 2 || V.length < 2) return [];
  const meets = (h, v) => v.x >= h.x0 - 2 && v.x <= h.x1 + 2 && h.y >= v.y0 - 2 && h.y <= v.y1 + 2;
  // group lines that touch each other into tables
  const all = [...H.map((r) => ({ r, h: true })), ...V.map((r) => ({ r, h: false }))];
  const seen = new Set(), tables = [];
  for (const start of all) {
    if (seen.has(start)) continue;
    const group = [start]; seen.add(start);
    for (let i = 0; i < group.length; i++) {
      const g = group[i];
      for (const o of all) if (!seen.has(o) && o.h !== g.h && (g.h ? meets(g.r, o.r) : meets(o.r, g.r))) { seen.add(o); group.push(o); }
    }
    const hs = group.filter((g) => g.h).map((g) => g.r), vs = group.filter((g) => !g.h).map((g) => g.r);
    if (hs.length < 2 || vs.length < 2) continue;
    const ys = cluster(hs.map((h) => h.y), 1.5).sort((p, q) => q - p);     // top first
    const xs = cluster(vs.map((v) => v.x), 1.5).sort((p, q) => q - p);     // right first
    if (ys.length < 2 || xs.length < 3) continue;                          // one column is just a box around text
    const rows = [];
    for (let i = 0; i + 1 < ys.length; i++) {
      const top = ys[i], bot = ys[i + 1], mid = (top + bot) / 2;
      if (top - bot < 4) continue;
      // a column border that does not cross this row means merged cells
      const cross = xs.filter((x, j) => j === 0 || j === xs.length - 1 || vs.some((v) => Math.abs(v.x - x) < 1.5 && v.y0 <= mid && v.y1 >= mid));
      const cells = [];
      for (let j = 0; j + 1 < cross.length; j++) {
        const span = xs.filter((x) => x <= cross[j] + 0.5 && x > cross[j + 1] + 0.5).length;
        cells.push({ r: cross[j], l: cross[j + 1], span: Math.max(1, span) });
      }
      rows.push({ top, bot, cells });
    }
    if (rows.length) tables.push({ x0: xs[xs.length - 1], x1: xs[0], y0: ys[ys.length - 1], y1: ys[0], rows });
  }
  return tables;
}

export function rebuild(raw, opts = {}) {
  const src = Array.isArray(raw) ? raw : raw.glyphs;
  const items = src.filter(g => !IGN.has(g.c) && !/[\uE000-\uF8FF]/.test(g.c)).flatMap(g => [...g.c].map((ch, k) => ({ ...g, c: ch, f: [], x1: k > 0 && FILI(ch) ? g.x0 : g.x1 })));
  // Fake-bold: some generators draw every glyph 3-4 times with tiny offsets. Keep one copy.
  { const seen = new Map(); const keep = [];
    for (const it of items) {
      const q = Math.max(1, it.sz * 0.3), kx = Math.round(it.x0 / q), ky = Math.round(it.y / q);
      let dup = false;
      for (let a = -1; a <= 1 && !dup; a++) for (let b = -1; b <= 1 && !dup; b++) {
        const l = seen.get(it.c + '|' + (kx + a) + '|' + (ky + b));
        if (l && l.some(o => Math.abs(o.x0 - it.x0) < q && Math.abs(o.y - it.y) < q)) dup = true;
      }
      if (dup) continue;
      const k = it.c + '|' + kx + '|' + ky; (seen.get(k) || seen.set(k, []).get(k)).push(it); keep.push(it);
    }
    items.length = 0; items.push(...keep); }
  const letters = items.filter(i => !FILI(i.c));
  if (!letters.length) return [];
  const med = letters.map(b => b.sz).sort((a, b) => a - b)[letters.length >> 1];
  // Attach each vowel sign to its letter. Distances scale with the text size (0.6 pt at 12 pt).
  let last = null; const orphans = [], wide = [];
  for (const it of items) {
    if (FILI(it.c)) {
      // A vowel sign drawn with its own advance width. Word does this for the last letter of a word
      // in justified text, so it is normally a real vowel sign; it only stands for a word space when
      // the letter before it already has its vowel sign (some generators store the space that way).
      if (it.x1 - it.x0 > 0.12 * it.sz) { wide.push([it, last]); continue; }
      if (last && Math.abs(it.x0 - last.x0) <= 0.05 * it.sz && Math.abs(it.y - last.y) < med) last.f.push(it.c);
      else orphans.push([it, last]);
    } else if (!(it.c === ' ' && it.x1 - it.x0 < 0.05 * it.sz)) last = it;   // Word puts a zero-width "space" between a letter and its last vowel sign
  }
  for (const [f, prev] of orphans) {
    let tgt = null, bd = 1e9;
    for (const b of letters) {
      if (b.c === ' ' || Math.abs(b.y - f.y) >= med * 0.8 || Math.abs(b.x0 - f.x0) > 0.1 * f.sz) continue;
      const d = Math.abs(b.x0 - f.x0); if (d < bd) { bd = d; tgt = b; }
    }
    (tgt || prev)?.f.push(f.c);
  }
  for (const [f, prev] of wide) {
    if (prev && prev.c !== ' ' && !prev.f.length && Math.abs(f.y - prev.y) < med * 0.8 && f.x0 >= prev.x0 - 0.15 * f.sz && f.x0 <= prev.x1 + 0.05 * f.sz) prev.f.push(f.c);
    else { f.c = ' '; f.x1 = f.x0 + 0.25 * f.sz; letters.push(f); }
  }
  const bases = letters;

  const isL = (c) => /[0-9A-Za-z]/.test(c), isN = (c) => /[\s.,:;\/\-+%=*×÷<>^_]/.test(c);
  const logical = (L) => {
    const a = [...L].sort((p, q) => ((q.x0 + q.x1) / 2 - (p.x0 + p.x1) / 2));   // visual right-to-left
    const out = []; let i = 0;
    while (i < a.length) {
      if (isL(a[i].c)) {                                  // LTR run (digits / Latin / formulas): keep left-to-right
        let j = i, end = i;
        while (j < a.length && (isL(a[j].c) || (isN(a[j].c) && j + 1 < a.length && (isL(a[j + 1].c) || isN(a[j + 1].c))))) { if (isL(a[j].c)) end = j; j++; }
        out.push(...a.slice(i, end + 1).reverse()); i = end + 1;
      } else out.push(a[i++]);
    }
    return out;
  };
  // Some PDFs have no space glyphs at all (words are just spread apart): then put spaces back by the gaps.
  // Decided per line, because one page can mix both kinds of line.
  const zeroSpace = (b) => b.c === ' ' && b.x1 - b.x0 < 0.05 * b.sz;
  const joinLine = (L) => {
    // Zero-width "spaces" are left-overs of Word's character mapping; ignore them when the line has real ones.
    if (L.some((b) => b.c === ' ' && !zeroSpace(b))) L = L.filter((b) => !zeroSpace(b));
    // "Ignore Arabic": leave out lines that are mostly Arabic (verses, prayers). Arabic words inside a
    // Dhivehi sentence (such as the name of Allah) are kept, without their vowel marks.
    let droppedArabic = false;
    if (opts.dropArabic) {
      const ar = L.filter((b) => ARABIC.test(b.c) && !ARABIC_MARK.test(b.c)).length;
      const th = L.filter((b) => THAANA_LETTER.test(b.c)).length;
      if (ar) { droppedArabic = ar > th; L = L.filter((b) => !(ARABIC_MARK.test(b.c) || VERSE_GLYPH.test(b.c) || (droppedArabic && ARABIC.test(b.c)))); }
      if (!L.length) return '';
    }
    const a = logical(L); let out = '';
    const noSpaces = a.filter((b) => b.c === ' ').length < a.length * 0.06;
    for (let i = 0; i < a.length; i++) {
      const b = a[i];
      if (noSpaces && i > 0 && b.c !== ' ' && a[i - 1].c !== ' ' && !isL(b.c) && !isL(a[i - 1].c)) {
        const gap = a[i - 1].x0 - b.x1;                       // right-to-left: previous letter is on the right
        if (gap > 0.17 * med) out += ' ';
      }
      out += b.c + cleanFili(b.f);
    }
    out = out.replace(/ +/g, ' ').trim();
    // Wingdings bullets come out as a lone Latin 'z' next to Thaana text
    if (/[\u0780-\u07B1]/.test(out)) out = out.replace(/(?<![A-Za-z0-9])z(?![A-Za-z0-9])/g, '').replace(/ +/g, ' ').trim();
    // brackets stored mirrored: if the first one met is a closing bracket, swap them all in this line
    const first = out.match(/[()\[\]]/);
    if (first && (first[0] === ')' || first[0] === ']')) out = out.replace(/[()\[\]]/g, (c) => ({ '(': ')', ')': '(', '[': ']', ']': '[' }[c]));
    // a full stop / comma drawn at the right-hand end of a Thaana line belongs at its end
    out = out.replace(/^([.\u060C\u061F!])\s*(?=[\u0780-\u07B1])(.*)$/, '$2$1');
    // a full stop never has a space before it after a Thaana word
    out = out.replace(/([\u0780-\u07B1]) +\.(?= |$)/g, '$1.');
    // what is left of an Arabic line is only punctuation and verse numbers
    if (droppedArabic && !/[\u0780-\u07B1A-Za-z]/.test(out)) return '';
    return out;
  };
  const groupLines = (list) => {
    const sorted = [...list].sort((a, b) => b.y - a.y);     // PDF y grows upward => descending
    const lines = [];
    for (const b of sorted) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(b.y - L[L.length - 1].y) < med * 0.7) L.push(b); else lines.push([b]);
    }
    return lines;
  };
  // Bordered tables: put each letter in its cell; lines that wrap inside a cell are joined.
  const out = [];   // { y, text }
  const tables = findTables(raw.rules);
  const inTable = new Set();
  for (const T of tables) {
    for (const row of T.rows) {
      const cells = row.cells.map(() => []);
      for (const b of bases) {
        if (inTable.has(b)) continue;
        const cx = (b.x0 + b.x1) / 2, cy = b.y + 0.3 * b.sz;   // middle of the letter, above the baseline
        if (cy >= row.top || cy <= row.bot) continue;
        const k = row.cells.findIndex((c) => cx < c.r && cx > c.l);
        if (k >= 0) { cells[k].push(b); inTable.add(b); }
      }
      if (!cells.some((c) => c.some((b) => b.c !== ' '))) continue;
      const texts = [];
      row.cells.forEach((c, k) => {
        texts.push(groupLines(cells[k]).map(joinLine).filter(Boolean).join(' '));
        for (let s = 1; s < c.span; s++) texts.push('');           // merged cell: keep the columns lined up
      });
      out.push({ y: row.top, text: texts.map((t) => t.replace(/\t/g, ' ')).join('\t') });
    }
  }
  // Everything else; a very wide gap inside a line still separates cells of tables without borders.
  const cellGap = 1.8 * med;
  const splitCells = (L) => {
    const a = [...L].sort((p, q) => q.x1 - p.x1); const parts = [[a[0]]];
    for (let i = 1; i < a.length; i++) {
      const gap = parts[parts.length - 1].reduce((m, g) => Math.min(m, g.x0), 1e9) - a[i].x1;
      if (gap > cellGap) parts.push([a[i]]); else parts[parts.length - 1].push(a[i]);
    }
    return parts;
  };
  // A line right under a table row with nothing in the row's first (right-hand) column is the
  // rest of cells that wrapped onto a second line: add it to those cells instead of making a new row.
  let row = null;
  const finish = (r) => { if (r) r.entry.text = r.texts.join('\t').replace(/^(\d+[.)]|[-•–])\t/, '$1 '); };   // list numbers are not table cells
  for (const L of groupLines(bases.filter((b) => !inTable.has(b)))) {
    const y = L[0].y, real = L.filter((b) => b.c !== ' ');
    if (row && real.length && row.y - y < 2.5 * med) {
      const bounds = row.cols.slice(1).map((c, k) => (row.cols[k].l + c.r) / 2);     // between neighbouring columns
      const col = (b) => { const x = (b.x0 + b.x1) / 2; const k = bounds.findIndex((v) => x > v); return k < 0 ? bounds.length : k; };
      const inside = real.every((b) => b.x1 > row.cols.at(-1).l - 2 * med && b.x0 < row.cols[0].r + 2 * med);
      if (inside && !real.some((b) => col(b) === 0)) {
        const groups = row.cols.map(() => []);
        for (const b of L) groups[col(b)].push(b);
        groups.forEach((g, k) => { const t = g.length ? joinLine(g) : ''; if (t) row.texts[k] = row.texts[k] ? row.texts[k] + ' ' + t : t; });
        row.y = y; continue;
      }
    }
    finish(row); row = null;
    const parts = splitCells(L), texts = parts.map(joinLine), entry = { y, text: '' };
    out.push(entry);
    const keep = texts.map(Boolean);
    if (texts.filter((t) => /[\u0780-\u07B1A-Za-z0-9]/.test(t)).length >= 2) {
      row = { entry, y, texts: texts.filter((_, k) => keep[k]),
        cols: parts.filter((_, k) => keep[k]).map((p) => ({ r: Math.max(...p.map((g) => g.x1)), l: Math.min(...p.map((g) => g.x0)) })) };
    } else entry.text = texts.filter(Boolean).join('');
  }
  finish(row);
  return out.sort((a, b) => b.y - a.y).map((o) => o.text);
}
