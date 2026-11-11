// Recolouring that keeps the light. Pure module (no DOM).
// In Lab, the wall under ordinary light becomes exactly the target colour and every other spot keeps its
// difference from it: a warm lamp glow stays lighter and warmer, a shadow stays darker.

import { LIN, labOf, SRGB_SPACE } from './color.js';

export const CHROMA_KEEP = 0.85;
export const HL = [236, 72, 153];        // pink used by "show detected area"

/** Mean Lab colour of the solid wall pixels between the 20th and 45th lightness percentile ("ordinary light").
 *  orig = RGBA pixels of the working image, alpha = final mask 0..255. */
export function wallRef(W, H, orig, alpha) {
  const n = W * H, hist = new Uint32Array(401), tmp = [0, 0, 0];
  let tot = 0;
  for (let i = 0; i < n; i += 2) { if (alpha[i] < 230) continue; const o = i * 4; labOf(orig[o], orig[o + 1], orig[o + 2], tmp); hist[Math.max(0, Math.min(400, Math.round(tmp[0] * 4)))]++; tot++; }
  if (!tot) return labOf(128, 128, 128, [0, 0, 0]);
  let acc = 0, lo = 0, hi = 400;
  for (let k = 0; k <= 400; k++) { acc += hist[k]; if (acc < tot * 0.2) lo = k + 1; if (acc >= tot * 0.45) { hi = k; break; } }
  const ref = [0, 0, 0]; let c = 0;
  for (let i = 0; i < n; i += 2) {
    if (alpha[i] < 230) continue; const o = i * 4; labOf(orig[o], orig[o + 1], orig[o + 2], tmp);
    const q = Math.round(tmp[0] * 4); if (q < lo || q > hi) continue;
    ref[0] += tmp[0]; ref[1] += tmp[1]; ref[2] += tmp[2]; c++;
  }
  return c ? [ref[0] / c, ref[1] / c, ref[2] / c] : labOf(128, 128, 128, [0, 0, 0]);
}

/** Mean linear luminance of the solid wall pixels (kept for status/diagnostics). */
export function wallLuminance(orig, alpha) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 230) { const o = i * 4; sum += 0.2126 * LIN[orig[o]] + 0.7152 * LIN[orig[o + 1]] + 0.0722 * LIN[orig[o + 2]]; cnt++; }
  return cnt ? Math.max(sum / cnt, 1e-4) : 0.2;
}

/** Everything the per-pixel loop needs: ref = wall Lab, target = [r,g,b],
 *  adj = {op:0..100, sat:-100..100, light:-100..100, contrast:-100..100 (optional, 0 = none)}.
 *  Contrast scales each wall pixel's lightness difference from the (shifted) target: shadows deeper or softer. */
export function renderParams(ref, target, adj) {
  const T = labOf(target[0], target[1], target[2], [0, 0, 0]), a = adj || { op: 100, sat: 0, light: 0 };
  const TL = T[0] + a.light * 0.25;
  return { dL: TL - ref[0], ka: T[1] - ref[1] * CHROMA_KEEP, kb: T[2] - ref[2] * CHROMA_KEEP, sf: 1 + a.sat / 100, op: a.op / 100,
    TL, kc: 1 + (a.contrast || 0) / 100 };
}

/** Recolour pixels [i0, i1) of src into dst (RGBA, may be the same buffer). alpha[i] 0..255 per pixel; hl = pink overlay instead of recolour.
 *  space: the colour space the pixels are in ({labOf, rgbOfLab}, see color.js / icc.js); sRGB by default. */
export function recolor(src, dst, alpha, i0, i1, P, hl, space = SRGB_SPACE) {
  const lab = [0, 0, 0], rgb = [0, 0, 0], { dL, ka, kb, sf, op, TL, kc } = P, { labOf: toLab, rgbOfLab: toRgb } = space;
  for (let i = i0; i < i1; i++) {
    const o = i * 4, a = alpha[i], r = src[o], g = src[o + 1], b = src[o + 2];
    if (a <= 0) { dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = 255; continue; }
    if (hl) {
      const q = 0.6 * a / 255;
      dst[o] = r + (HL[0] - r) * q; dst[o + 1] = g + (HL[1] - g) * q; dst[o + 2] = b + (HL[2] - b) * q;
    } else {
      const k = a / 255 * op;
      toLab(r, g, b, lab); toRgb(TL + (lab[0] + dL - TL) * kc, (lab[1] * CHROMA_KEEP + ka) * sf, (lab[2] * CHROMA_KEEP + kb) * sf, rgb);
      dst[o] = r + (rgb[0] - r) * k; dst[o + 1] = g + (rgb[1] - g) * k; dst[o + 2] = b + (rgb[2] - b) * k;
    }
    dst[o + 3] = 255;
  }
}
