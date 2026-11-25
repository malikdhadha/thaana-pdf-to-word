// Page clean-up and Thaana-aware line finding.
// Tesseract's own page layout splits fili (vowel marks) into separate "lines",
// so we find text lines ourselves and send each one to the recogniser.

export function grayFromCanvas(c) {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const g = new Float32Array(c.width * c.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}

export function grayToCanvas(g, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(w, h); const d = img.data;
  for (let j = 0, i = 0; j < g.length; j++, i += 4) { const v = g[j]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0); return c;
}

// Even out shadows / yellowed paper, then stretch contrast.
export function normalize(canvas, enhance) {
  const w = canvas.width, h = canvas.height;
  const g = grayFromCanvas(canvas);
  if (enhance) {
    const bg = document.createElement('canvas'); bg.width = w; bg.height = h;
    const bctx = bg.getContext('2d', { willReadFrequently: true });
    bctx.filter = `blur(${Math.round(Math.max(w, h) / 60)}px)`;
    bctx.drawImage(canvas, 0, 0);
    const b = grayFromCanvas(bg);
    for (let j = 0; j < g.length; j++) g[j] = Math.min(255, (g[j] / Math.max(40, b[j])) * 245);
  }
  const hist = new Uint32Array(256); for (const v of g) hist[Math.max(0, Math.min(255, v | 0))]++;
  const n = g.length; let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.01) { hi = v; break; } }
  const span = Math.max(30, hi - lo);
  for (let j = 0; j < n; j++) g[j] = Math.max(0, Math.min(255, ((g[j] - lo) / span) * 255));
  return g;
}

export function otsu(g) {
  const h = new Float64Array(256); for (const v of g) h[Math.max(0, Math.min(255, v | 0))]++;
  let w = 0, m = 0, mt = 0, tot = g.length; for (let i = 0; i < 256; i++) mt += i * h[i];
  let best = 0, t = 128;
  for (let i = 0; i < 255; i++) {
    w += h[i]; m += i * h[i]; if (w === 0 || w === tot) continue;
    const mb = m / w, mf = (mt - m) / (tot - w), v = w * (tot - w) * (mb - mf) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

// Find the rotation (−4°…+4°) that makes text lines most horizontal.
export function findSkew(g, w, h, thr) {
  const s = 1000 / Math.max(w, h);
  const sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
  const bin = new Float32Array(w * h); for (let j = 0; j < g.length; j++) bin[j] = g[j] < thr ? 0 : 255;
  const small = document.createElement('canvas'); small.width = sw; small.height = sh;
  small.getContext('2d').drawImage(grayToCanvas(bin, w, h), 0, 0, sw, sh);
  const work = document.createElement('canvas'); work.width = sw; work.height = sh;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  let best = -1, bestA = 0;
  for (let a = -4; a <= 4.001; a += 0.2) {
    wctx.setTransform(1, 0, 0, 1, 0, 0); wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, sw, sh);
    wctx.translate(sw / 2, sh / 2); wctx.rotate((a * Math.PI) / 180); wctx.drawImage(small, -sw / 2, -sh / 2);
    const d = wctx.getImageData(0, 0, sw, sh).data; let v = 0;
    for (let y = 0; y < sh; y++) { let r = 0; for (let x = 0; x < sw; x++) r += 255 - d[(y * sw + x) * 4]; v += r * r; }
    if (v > best) { best = v; bestA = a; }
  }
  return bestA;
}

export function rotateGray(g, w, h, deg) {
  if (Math.abs(deg) < 0.05) return g;
  const src = grayToCanvas(g, w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2); ctx.rotate((deg * Math.PI) / 180); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -w / 2, -h / 2);
  return grayFromCanvas(c);
}

function linePitch(p) {
  const n = p.length; let mean = 0; for (const v of p) mean += v; mean /= n;
  const q = p.map((v) => v - mean); let a0 = 0; for (const v of q) a0 += v * v; a0 = a0 || 1;
  const ac = (lag) => { let s = 0; for (let i = 0; i + lag < n; i++) s += q[i] * q[i + lag]; return s / a0; };
  let dip = 8; while (dip < n / 2 && ac(dip) >= 0) dip++;
  const hi = Math.min(Math.floor(n / 2), dip * 6 + 20);
  let best = -Infinity, P = 40;
  for (let lag = dip; lag < hi; lag++) { const v = ac(lag); if (v > best) { best = v; P = lag; } }
  return P;
}

// Returns text line boxes {l,t,r,b} in reading order (top to bottom), plus the line pitch.
// pitchHint: line spacing measured elsewhere (a block of one or two lines cannot show its own).
export function findLines(g, w, h, thr, pitchHint = 0) {
  const p = new Float64Array(h);
  for (let y = 0; y < h; y++) { let s = 0; const o = y * w; for (let x = 0; x < w; x++) if (g[o + x] < thr) s++; p[y] = s; }
  const P = pitchHint || linePitch(Array.from(p));
  const k = Math.max(3, Math.round(P * 0.45));
  const win = Array.from({ length: k }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (k - 1 || 1)));
  const ws = win.reduce((a, b) => a + b, 0) || 1;
  const ps = new Float64Array(h);
  for (let y = 0; y < h; y++) { let s = 0; for (let i = 0; i < k; i++) { const yy = y + i - (k >> 1); if (yy >= 0 && yy < h) s += p[yy] * win[i]; } ps[y] = s / ws; }
  let max = 0; for (const v of ps) max = Math.max(max, v);
  const cand = [];
  for (let y = 1; y < h - 1; y++) if (ps[y] >= ps[y - 1] && ps[y] > ps[y + 1] && ps[y] > 0.12 * max) cand.push(y);
  cand.sort((a, b) => ps[b] - ps[a]);
  const peaks = [];
  for (const y of cand) if (peaks.every((q) => Math.abs(y - q) >= 0.6 * P)) peaks.push(y);
  peaks.sort((a, b) => a - b);
  const cuts = [];
  for (let i = 0; i + 1 < peaks.length; i++) {
    let m = peaks[i]; for (let y = peaks[i]; y < peaks[i + 1]; y++) if (ps[y] < ps[m]) m = y; cuts.push(m);
  }
  const boxes = [];
  peaks.forEach((c, i) => {
    const t = i > 0 ? cuts[i - 1] : Math.max(0, Math.round(c - 0.6 * P));
    const b = i < cuts.length ? cuts[i] : Math.min(h, Math.round(c + 0.6 * P));
    let l = w, r = -1, inkSum = 0;
    for (let x = 0; x < w; x++) {
      let col = 0; for (let y = t; y < b; y++) if (g[y * w + x] < thr) col++;
      if (col > 1) { if (x < l) l = x; r = x; } inkSum += col;
    }
    if (r < 0 || inkSum < 0.02 * P * P) return;
    boxes.push({ l: Math.max(0, l - 20), t, r: Math.min(w, r + 20), b });
  });
  return { boxes, pitch: P };
}

// Crop one line and resize it so the line spacing is ~45 px — the text size the model reads best.
export const TARGET_PITCH = 45;
export function cropToPng(g, w, box, pitch) {
  const cw = box.r - box.l, ch = box.b - box.t;
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = g[(box.t + y) * w + box.l + x];
  const src = grayToCanvas(out, cw, ch);
  const s = pitch ? TARGET_PITCH / pitch : 1;
  if (Math.abs(s - 1) < 0.03) return src.toDataURL('image/png').split(',')[1];
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * s)); c.height = Math.max(1, Math.round(ch * s));
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  // Step down in halves for big reductions (closer to a proper Lanczos resize).
  let cur = src;
  while (cur.width * 0.5 > c.width) {
    const h = document.createElement('canvas'); h.width = Math.round(cur.width / 2); h.height = Math.round(cur.height / 2);
    const hc = h.getContext('2d'); hc.imageSmoothingQuality = 'high'; hc.drawImage(cur, 0, 0, h.width, h.height); cur = h;
  }
  ctx.drawImage(cur, 0, 0, c.width, c.height);
  return c.toDataURL('image/png').split(',')[1];
}

// Decide where paragraphs end: bigger gap than usual, or the previous line stops well short of the left margin.
export function paragraphBreaks(boxes, pitch) {
  if (!boxes.length) return [];
  const minL = Math.min(...boxes.map((b) => b.l)), maxR = Math.max(...boxes.map((b) => b.r));
  const width = maxR - minL || 1;
  return boxes.map((bx, i) => {
    if (i === 0) return false;
    const prev = boxes[i - 1];
    const gap = (bx.t + bx.b) / 2 - (prev.t + prev.b) / 2;
    const prevShort = prev.l - minL > 0.12 * width;
    const thisIndented = maxR - bx.r > 0.08 * width;
    return gap > 1.45 * pitch || prevShort || thisIndented;
  });
}

// Erase long thin horizontal / vertical ruling (notebook lines, margins) so handwriting can be found.
export function removeRuling(g, w, h, thr) {
  const ink = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) ink[i] = g[i] < thr ? 1 : 0;
  // 3x3 dilate (separable)
  const dil = (src, rx, ry) => {
    const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!src[y * w + x]) continue; for (let d = -rx; d <= rx; d++) { const xx = x + d; if (xx >= 0 && xx < w) a[y * w + xx] = 1; } }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!a[y * w + x]) continue; for (let d = -ry; d <= ry; d++) { const yy = y + d; if (yy >= 0 && yy < h) b[yy * w + x] = 1; } }
    return b;
  };
  const d3 = dil(ink, 1, 1);
  // vertical erosion by 3 (keeps only thin-but-continuous strokes ≥3 tall after dilation)
  const e = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) e[y * w + x] = d3[(y - 1) * w + x] & d3[y * w + x] & d3[(y + 1) * w + x];
  const L = Math.max(60, Math.round(w / 7));
  const hr = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!e[y * w + x]) { x++; continue; }
      let s = x; while (x < w && e[y * w + x]) x++;
      if (x - s >= L) for (let k = s; k < x; k++) hr[y * w + k] = 1;
    }
  }
  // vertical rules (margin line)
  const LV = Math.max(60, Math.round(h / 5)), vr = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!(d3[y * w + x] & d3[y * w + Math.min(w - 1, x + 1)] & d3[y * w + Math.max(0, x - 1)])) { y++; continue; }
      let s = y; while (y < h && (d3[y * w + x] & d3[y * w + Math.min(w - 1, x + 1)] & d3[y * w + Math.max(0, x - 1)])) y++;
      if (y - s >= LV) for (let k = s; k < y; k++) vr[k * w + x] = 1;
    }
  }
  const m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = hr[i] | vr[i];
  const mask = dil(m, 2, 2);
  const out = new Float32Array(g);
  for (let i = 0; i < w * h; i++) if (mask[i] && ink[i]) out[i] = 255;
  return out;
}
