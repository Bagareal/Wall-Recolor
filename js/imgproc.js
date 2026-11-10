// Image-processing primitives on flat W*H arrays. Pure module (no DOM).

/** Box blur of a Uint8Array image, radius r, edges averaged over the pixels inside the image. */
export function boxBlur(src, W, H, r) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const o = y * W; let sum = 0;
    for (let x = 0; x <= Math.min(r, W - 1); x++) sum += src[o + x];
    for (let x = 0; x < W; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(W - 1, x + r);
      tmp[o + x] = (sum / (hi - lo + 1) + 0.5) | 0;
      if (x + 1 + r <= W - 1) sum += src[o + x + 1 + r];
      if (x - r >= 0) sum -= src[o + x - r];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, H - 1); y++) sum += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(H - 1, y + r);
      out[y * W + x] = (sum / (hi - lo + 1) + 0.5) | 0;
      if (y + 1 + r <= H - 1) sum += tmp[(y + 1 + r) * W + x];
      if (y - r >= 0) sum -= tmp[(y - r) * W + x];
    }
  }
  return out;
}

/** 4-connected components of the pixels equal to `val`. Returns labels (0 = not part of any), areas[label], border[label]. */
export function components(mask, W, H, val) {
  const n = W * H, labels = new Int32Array(n), stack = new Int32Array(n);
  const areas = [0], border = [false]; let next = 1;
  for (let i = 0; i < n; i++) {
    if (mask[i] !== val || labels[i]) continue;
    let sp = 0, a = 0, b = false; stack[sp++] = i; labels[i] = next;
    while (sp) {
      const p = stack[--sp]; a++;
      const x = p % W, y = (p / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) b = true;
      let q;
      if (x > 0) { q = p - 1; if (mask[q] === val && !labels[q]) { labels[q] = next; stack[sp++] = q; } }
      if (x < W - 1) { q = p + 1; if (mask[q] === val && !labels[q]) { labels[q] = next; stack[sp++] = q; } }
      if (y > 0) { q = p - W; if (mask[q] === val && !labels[q]) { labels[q] = next; stack[sp++] = q; } }
      if (y < H - 1) { q = p + W; if (mask[q] === val && !labels[q]) { labels[q] = next; stack[sp++] = q; } }
    }
    areas.push(a); border.push(b); next++;
  }
  return { labels, areas, border };
}

/** Morphological opening (3x3 erosion then dilation) of a 0/255 mask. */
export function opening(m, W, H) {
  const n = W * H, e = new Uint8Array(n), o = new Uint8Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (m[i] !== 255) continue;
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; if (m[yy * W + xx] !== 255) { ok = false; break; } }
    }
    if (ok) e[i] = 255;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (e[y * W + x] !== 255) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) o[yy * W + xx] = 255; }
    }
  }
  return o;
}

/** Dilation of a mask by a square of half-size r (0/255 output). */
export function dilateBox(src, W, H, r) {
  const n = W * H, tmp = new Uint8Array(n), out = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    const o = y * W; let last = -1e9;
    for (let x = 0; x < W; x++) { if (src[o + x]) last = x; if (x - last <= r) tmp[o + x] = 255; }
    let next = 1e9;
    for (let x = W - 1; x >= 0; x--) { if (src[o + x]) next = x; if (next - x <= r) tmp[o + x] = 255; }
  }
  for (let x = 0; x < W; x++) {
    let last = -1e9;
    for (let y = 0; y < H; y++) { if (tmp[y * W + x]) last = y; if (y - last <= r) out[y * W + x] = 255; }
    let next = 1e9;
    for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) next = y; if (next - y <= r) out[y * W + x] = 255; }
  }
  return out;
}

/** Float box mean over a (2r+1)^2 window, edges handled by averaging only the pixels inside the image. */
export function boxMeanF(src, W, H, r, out, tmp) {
  for (let y = 0; y < H; y++) {
    const o = y * W; let sum = 0;
    for (let x = 0; x <= Math.min(r, W - 1); x++) sum += src[o + x];
    for (let x = 0; x < W; x++) {
      const lo = x - r < 0 ? 0 : x - r, hi = x + r > W - 1 ? W - 1 : x + r;
      tmp[o + x] = sum / (hi - lo + 1);
      if (x + 1 + r <= W - 1) sum += src[o + x + 1 + r];
      if (x - r >= 0) sum -= src[o + x - r];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, H - 1); y++) sum += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      const lo = y - r < 0 ? 0 : y - r, hi = y + r > H - 1 ? H - 1 : y + r;
      out[y * W + x] = sum / (hi - lo + 1);
      if (y + 1 + r <= H - 1) sum += tmp[(y + 1 + r) * W + x];
      if (y - r >= 0) sum -= tmp[(y - r) * W + x];
    }
  }
  return out;
}

/** Colour guided filter (He et al.): smooths p (Float32Array 0..1) while following the edges of the guide I = [R,G,B] (Float32Array 0..1 each). */
export function guidedFilter(I, p, W, H, r, eps) {
  const m = W * H, tmp = new Float32Array(m), prod = new Float32Array(m);
  const box = a => boxMeanF(a, W, H, r, new Float32Array(m), tmp);
  const mul = (a, b) => { for (let i = 0; i < m; i++) prod[i] = a[i] * b[i]; return box(prod); };
  const [R, G, B] = I;
  const mR = box(R), mG = box(G), mB = box(B), mP = box(p);
  const mRP = mul(R, p), mGP = mul(G, p), mBP = mul(B, p);
  const vRR = mul(R, R), vRG = mul(R, G), vRB = mul(R, B), vGG = mul(G, G), vGB = mul(G, B), vBB = mul(B, B);
  const aR = vRR, aG = vRG, aB = vRB, bb = vGG;          // reuse buffers for the coefficients
  for (let i = 0; i < m; i++) {
    const mr = mR[i], mg = mG[i], mb = mB[i], mp = mP[i];
    const cr = mRP[i] - mr * mp, cg = mGP[i] - mg * mp, cb = mBP[i] - mb * mp;
    const a11 = vRR[i] - mr * mr + eps, a12 = vRG[i] - mr * mg, a13 = vRB[i] - mr * mb;
    const a22 = vGG[i] - mg * mg + eps, a23 = vGB[i] - mg * mb, a33 = vBB[i] - mb * mb + eps;
    const i11 = a22 * a33 - a23 * a23, i12 = a13 * a23 - a12 * a33, i13 = a12 * a23 - a13 * a22;
    const i22 = a11 * a33 - a13 * a13, i23 = a12 * a13 - a11 * a23, i33 = a11 * a22 - a12 * a12;
    const det = a11 * i11 + a12 * i12 + a13 * i13;
    const x = (i11 * cr + i12 * cg + i13 * cb) / det, y = (i12 * cr + i22 * cg + i23 * cb) / det, z = (i13 * cr + i23 * cg + i33 * cb) / det;
    aR[i] = x; aG[i] = y; aB[i] = z; bb[i] = mp - x * mr - y * mg - z * mb;
  }
  const maR = box(aR), maG = box(aG), maB = box(aB), mb = box(bb);
  const q = new Float32Array(m);
  for (let i = 0; i < m; i++) q[i] = maR[i] * R[i] + maG[i] * G[i] + maB[i] * B[i] + mb[i];
  return q;
}

/** Bilinear resampling of a Uint8Array image (sw x sh) to dw x dh. */
export function resizeBilinear(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    let gy = (y + 0.5) * sh / dh - 0.5; if (gy < 0) gy = 0; if (gy > sh - 1) gy = sh - 1;
    const y0 = Math.floor(gy), y1 = Math.min(sh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < dw; x++) {
      let gx = (x + 0.5) * sw / dw - 0.5; if (gx < 0) gx = 0; if (gx > sw - 1) gx = sw - 1;
      const x0 = Math.floor(gx), x1 = Math.min(sw - 1, x0 + 1), fx = gx - x0;
      out[y * dw + x] = (src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx) * (1 - fy) + (src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx) * fy;
    }
  }
  return out;
}

/** Fraction of non-zero pixels. */
export function coverageOf(mask) { let c = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) c++; return c / mask.length; }
