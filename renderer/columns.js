// Column / block analysis for newspapers and magazines (XY-cut), right-to-left reading order.
// findBlocks(g, w, h, thr) -> [{l,t,r,b,kind}] in reading order. kind: 'text' | 'head' | 'image' | 'tiny'

function runs(flags, n) {            // runs of true in flags[0..n)
  const out = []; let s = -1;
  for (let i = 0; i < n; i++) { if (flags[i]) { if (s < 0) s = i; } else if (s >= 0) { out.push([s, i]); s = -1; } }
  if (s >= 0) out.push([s, n]);
  return out;
}

function dilate(ink, w, h, kx, ky) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const rx = kx >> 1, ry = ky >> 1;
  for (let y = 0; y < h; y++) {
    const o = y * w; let last = -1e9;
    const pos = new Int32Array(w).fill(-1e9);
    for (let x = 0; x < w; x++) { if (ink[o + x]) last = x; pos[x] = last; }
    let next = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (ink[o + x]) next = x; if (x - pos[x] <= rx || next - x <= rx) tmp[o + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9; const pos = new Int32Array(h);
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; pos[y] = last; }
    let next = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) next = y; if (y - pos[y] <= ry || next - y <= ry) out[y * w + x] = 1; }
  }
  return out;
}

// Connected components (8-neighbour) of the ink; returns boxes [x,y,w,h] of those with >= 6 px.
function components(ink, w, h) {
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), res = [];
  for (let i = 0; i < w * h; i++) {
    if (!ink[i] || seen[i]) continue;
    let sp = 0, n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx; if (ink[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }
    if (n >= 6) res.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1]);
  }
  return res;
}

export function findBlocks(g, w, h, thr) {
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = g[i] < thr ? 1 : 0;
  // Screenshots of a page on a dark background: ignore everything outside the white page.
  { const cw = new Float32Array(w), rw = new Float32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] > 235) { cw[x]++; rw[y]++; }
    let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
    for (let x = 0; x < w; x++) if (cw[x] / h > 0.35) { if (x0 < 0) x0 = x; x1 = x; }
    for (let y = 0; y < h; y++) if (rw[y] / w > 0.35) { if (y0 < 0) y0 = y; y1 = y; }
    if (x0 >= 0 && y0 >= 0 && ((x1 - x0) < 0.9 * w || (y1 - y0) < 0.9 * h) && (x1 - x0) > 0.2 * w && (y1 - y0) > 0.2 * h) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x > x1 || y < y0 || y > y1) raw[y * w + x] = 0;
    } }
  const cc = components(raw, w, h);
  if (cc.length < 20) return [{ l: 0, t: 0, r: w, b: h, kind: 'text' }];
  const medh = (x0, y0, x1, y1) => {
    const hs = [];
    for (const c of cc) if (c[0] >= x0 && c[0] + c[2] <= x1 && c[1] >= y0 && c[1] + c[3] <= y1) hs.push(c[3]);
    // about half of all Thaana ink blobs are vowel signs, so the middle value would be a vowel-sign
    // height: take the upper quarter, which is a letter.
    if (!hs.length) return 15; hs.sort((a, b) => a - b); return hs[Math.floor(hs.length * 0.75)];
  };
  // work at the size where a typical letter is ~15 px, so thresholds match the prototype
  const globalMed = medh(0, 0, w, h);
  const k = Math.max(1, globalMed / 15);       // scale factor from page px to "prototype px"
  const ink = dilate(raw, w, h, Math.max(3, Math.round(9 * k)) | 1, Math.max(1, Math.round(3 * k)) | 1);

  const leaves = [];
  const cut = (x0, y0, x1, y1) => {
    // trim to ink
    let rx0 = x1, rx1 = x0, ry0 = y1, ry1 = y0, cnt = 0;
    for (let y = y0; y < y1; y++) for (let x = x0, o = y * w; x < x1; x++) if (ink[o + x]) { cnt++; if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (y < ry0) ry0 = y; if (y > ry1) ry1 = y; }
    if (cnt < 40 * k * k) return;
    x0 = rx0; x1 = rx1 + 1; y0 = ry0; y1 = ry1 + 1;
    const W = x1 - x0, H = y1 - y0;
    const rowE = new Uint8Array(H), colE = new Uint8Array(W);
    for (let y = 0; y < H; y++) { let e = 1; for (let x = 0; x < W; x++) if (ink[(y0 + y) * w + x0 + x]) { e = 0; break; } rowE[y] = e; }
    for (let x = 0; x < W; x++) { let e = 1; for (let y = 0; y < H; y++) if (ink[(y0 + y) * w + x0 + x]) { e = 0; break; } colE[x] = e; }
    const m = medh(x0, y0, x1, y1);
    const gv = Math.max(14 * k, 0.9 * m), gh = Math.max(12 * k, 1.0 * m);
    const hg = runs(rowE, H).filter((r) => r[1] - r[0] >= gh && r[0] > 0 && r[1] < H);
    const vg = runs(colE, W).filter((r) => r[1] - r[0] >= gv && r[0] > 0 && r[1] < W);
    if (!hg.length && !vg.length) { leaves.push([x0, y0, x1, y1]); return; }
    const big = (a) => a.reduce((b, r) => (!b || r[1] - r[0] > b[1] - b[0] ? r : b), null);
    const bh = big(hg), bv = big(vg);
    if (bh && (!bv || bh[1] - bh[0] >= (bv[1] - bv[0]) * 0.6)) { cut(x0, y0, x1, y0 + bh[0]); cut(x0, y0 + bh[1], x1, y1); }
    else { cut(x0 + bv[1], y0, x1, y1); cut(x0, y0, x0 + bv[0], y1); }   // right column first
  };
  cut(0, 0, w, h);

  // classify leaves
  const blocks = leaves.map(([x0, y0, x1, y1]) => {
    const bw = x1 - x0, bh = y1 - y0; let mid = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const v = g[y * w + x]; n++; if (v > 60 && v < 200) mid++; }
    const midFrac = n ? mid / n : 0;
    // count text lines roughly: rows with ink
    const prof = new Uint8Array(bh);
    for (let y = 0; y < bh; y++) { let c = 0; for (let x = x0; x < x1; x += 2) if (raw[(y0 + y) * w + x]) c++; prof[y] = c > Math.max(1, 0.01 * bw / 2) ? 1 : 0; }
    const lines = runs(prof, bh).filter((r) => r[1] - r[0] > 3 * k).length;
    let kind = midFrac > 0.35 ? 'image' : (lines >= 2 ? 'text' : 'head');
    if (bw < 60 * k && bh < 60 * k) kind = 'tiny';
    return { l: x0, t: y0, r: x1, b: y1, kind, lines };
  });
  // reading order: bands top-down, right-to-left within a band
  const rest = blocks.slice(), out = [];
  while (rest.length) {
    const top = rest.reduce((a, b) => (b.t < a.t ? b : a));
    const band = rest.filter((r) => r.t < top.b - 0.5 * (top.b - top.t) || r.t < top.t + 40 * k);
    band.sort((a, b) => b.r - a.r);
    for (const b of band) { out.push(b); rest.splice(rest.indexOf(b), 1); }
  }
  return out.filter((b) => b.kind === 'text' || b.kind === 'head');
}
