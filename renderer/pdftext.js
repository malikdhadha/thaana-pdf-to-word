// Small text helpers for PDF pages (no DOM, so they can be tested on their own).

// A PDF line that runs nearly the full width continues into the next one; a short line ends a paragraph.
// Table rows (cells separated by tabs) are never joined to anything.
export function joinPdfLines(lines, join) {
  lines = lines.filter((l) => l.trim());
  if (!join) return lines.join('\n');
  const isRow = (l) => l.includes('\t');
  const max = Math.max(...lines.filter((l) => !isRow(l)).map((l) => l.length), 1);
  let out = '';
  lines.forEach((l, i) => {
    out += l;
    if (i === lines.length - 1) return;
    const next = lines[i + 1];
    out += (isRow(l) || isRow(next) || l.length < max * 0.72 || /^\s*\d+[.)]/.test(next)) ? '\n' : ' ';
  });
  return out;
}

// Some PDFs lose most vowel signs in their text layer. Real Dhivehi has about one per letter;
// if far fewer come out, the text can't be trusted and the page is read as a picture instead.
export function textLooksComplete(s) {
  const base = (s.match(/[\u0780-\u07A5\u07B1]/g) || []).length;
  const fili = (s.match(/[\u07A6-\u07B0]/g) || []).length;
  return base < 100 || fili / base >= 0.95;
}

export const hasThaana = (s) => (s.match(/[\u0780-\u07B1]/g) || []).length >= 15;

// A page with no usable text that shows a big picture is a scan: it still has to be read.
export function looksScanned(pg) {
  const area = pg.pageArea || 0;
  return (pg.images || []).some((im) => !area || im.area > 0.15 * area);
}
