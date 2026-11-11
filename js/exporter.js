// Full-size export (runs in the worker). The original file is decoded at export size in its own colour profile,
// the working-size mask is scaled up (and re-snapped to the edges when it was enlarged), and the photo is
// recoloured in that profile. JPG and PNG embed the photo's profile; PSD is the wall layer alone (see psd.js).

import { openFull } from './decode.js';
import { renderParams, recolor } from './recolor.js';
import { guidedFilter } from './imgproc.js';
import { jpegWithIcc, pngWithIcc } from './formats.js';
import { srgbIcc } from './icc.js';
import { wallLayerPsd } from './psd.js';

/** Full-size mask (one byte per pixel) from the working-size alpha (W × H), processed in strips.
 *  data: the full-size photo (RGBA), used as the guide when the mask is re-snapped. progress(0..1). */
function fullMask(data, fw, fh, alpha, W, H, progress) {
  const X0 = new Int32Array(fw), X1 = new Int32Array(fw), FX = new Float32Array(fw);
  for (let x = 0; x < fw; x++) {
    let g = (x + 0.5) * W / fw - 0.5; if (g < 0) g = 0; if (g > W - 1) g = W - 1;
    const i = Math.floor(g); X0[x] = i; X1[x] = Math.min(W - 1, i + 1); FX[x] = g - i;
  }
  const refine = fw / W > 1.3;                                 // re-snap the mask to full-size edges when it was upscaled
  const r = Math.max(2, Math.round(Math.max(fw, fh) / 320)), pad = refine ? 2 * r + 2 : 0;
  const STRIP = Math.max(16, Math.floor(1e6 / fw)), mask = new Uint8Array(fw * fh);
  const rowAlpha = (y, out, off) => {                          // bilinear sample of the low-res alpha for one full-size row
    let gy = (y + 0.5) * H / fh - 0.5; if (gy < 0) gy = 0; if (gy > H - 1) gy = H - 1;
    const yi = Math.floor(gy), fy = gy - yi, rA = yi * W, rB = Math.min(H - 1, yi + 1) * W;
    for (let x = 0; x < fw; x++) {
      const fx = FX[x], x0 = X0[x], x1 = X1[x];
      out[off + x] = (alpha[rA + x0] * (1 - fx) + alpha[rA + x1] * fx) * (1 - fy) + (alpha[rB + x0] * (1 - fx) + alpha[rB + x1] * fx) * fy;
    }
  };
  for (let y0 = 0; y0 < fh; y0 += STRIP) {
    const h = Math.min(STRIP, fh - y0), top = Math.max(0, y0 - pad), bot = Math.min(fh, y0 + h + pad), hh = bot - top, n = fw * hh;
    const a = new Float32Array(n);
    for (let y = 0; y < hh; y++) rowAlpha(top + y, a, y * fw);
    let partial = false; for (let i = 0; i < n && !partial; i++) partial = a[i] > 2 && a[i] < 253;
    const c0 = (y0 - top) * fw, out = y0 * fw, len = h * fw;
    if (refine && partial) {
      const d = data.subarray(top * fw * 4, bot * fw * 4);
      const I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], p = new Float32Array(n);
      for (let i = 0; i < n; i++) { I[0][i] = d[i * 4] / 255; I[1][i] = d[i * 4 + 1] / 255; I[2][i] = d[i * 4 + 2] / 255; p[i] = a[i] / 255; }
      const q = guidedFilter(I, p, fw, hh, r, 2e-3);
      for (let i = 0; i < len; i++) { const v = (q[c0 + i] - 0.5) * 1.6 + 0.5; mask[out + i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); }
    } else {
      for (let i = 0; i < len; i++) mask[out + i] = a[c0 + i] + 0.5;
    }
    progress((y0 + h) / fh);
  }
  return mask;
}

/** Recolour n pixels of src into dst in chunks (for progress). alpha: one byte per pixel, or null for "everywhere". */
function recolourAll(src, dst, alpha, P, space, n, progress) {
  const CHUNK = 1 << 18, full = alpha ? null : new Uint8Array(CHUNK).fill(255);
  for (let i = 0; i < n; i += CHUNK) {
    const e = Math.min(n, i + CHUNK);
    recolor(src.subarray(i * 4, e * 4), dst.subarray(i * 4, e * 4), alpha ? alpha.subarray(i, e) : full, 0, e - i, P, false, space);
    progress(e / n);
  }
}

/** Render one photo at full size. m: the worker's 'export' message; progress(0..99). Returns a Blob. */
export async function exportPhoto({ file, W, H, fw, fh, alpha, ref, target, adj, fmt, layerName }, progress) {
  const src = await openFull(file, fw, fh), data = src.data, n = fw * fh, icc = src.icc || srgbIcc();
  progress(10);
  const mask = fullMask(data, fw, fh, alpha, W, H, f => progress(10 + Math.round(f * 40)));

  if (fmt === 'psd') {
    // the new colour everywhere: the mask decides where it shows, so the layer over the photo gives exactly the JPG/PNG
    recolourAll(data, data, null, renderParams(ref, target, { ...adj, op: 100 }), src.space, n, f => progress(50 + Math.round(f * 35)));
    return wallLayerPsd({ width: fw, height: fh, colour: data, mask, opacity: adj.op / 100, icc, name: layerName });
  }

  recolourAll(data, data, mask, renderParams(ref, target, adj), src.space, n, f => progress(50 + Math.round(f * 35)));
  const cv = new OffscreenCanvas(fw, fh);
  cv.getContext('2d').putImageData(new ImageData(data, fw, fh), 0, 0);
  const blob = await cv.convertToBlob({ type: fmt === 'png' ? 'image/png' : 'image/jpeg', quality: 0.95 });
  cv.width = cv.height = 1;
  progress(95);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([fmt === 'png' ? await pngWithIcc(bytes, icc) : jpegWithIcc(bytes, icc)], { type: blob.type });
}
