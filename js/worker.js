// Compute worker: AI inference (transformers.js), wall detection, SAM click-selection and full-size export.
// The page never blocks: everything heavy happens here.
//
// Two small open-source models run in the browser through transformers.js (Apache-2.0):
//  - CLIPSeg (CIDAS, Apache-2.0): asked for "a wall", gives a rough heat-map of where the wall is
//  - SlimSAM (Segment Anything, Apache-2.0): cuts out whole surfaces with precise outlines
// Model files: ./models/ when served from localhost (see README), otherwise the Hugging Face hub. Photos never leave the browser.

import { buildWork, autoTune, samPoints, samUnion, samBest, aiMax, AI_MIN } from './detect.js';
import { renderParams, recolor } from './recolor.js';
import { guidedFilter } from './imgproc.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const CLIP = 'Xenova/clipseg-rd64-refined', SAM = 'Xenova/slimsam-77-uniform';
const CLIP_SIZE = 352;                       // CLIPSeg's native input size

let lib = null, libP = null, clipP = null, samP = null;
let aiState = 'loading', aiProgress = 0, useLocal = false;
const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const postAI = () => post({ type: 'ai', state: aiState, p: aiProgress });

function ensureLib() {
  if (!libP) {
    libP = import(CDN).then(m => {
      lib = m;
      m.env.allowLocalModels = useLocal;
      m.env.localModelPath = new URL('../models/', self.location.href).href;
      return m;
    });
    libP.catch(() => { libP = null; });
  }
  return libP;
}
function progressFn(scale, base) {
  const files = {};
  return e => {
    if (e.status === 'progress' && e.total) {
      files[e.file] = { l: e.loaded, t: e.total };
      let l = 0, t = 0; for (const k in files) { l += files[k].l; t += files[k].t; }
      aiProgress = Math.min(100, base + Math.round(l / t * scale)); postAI();
    }
  };
}
function loadClip() {
  if (!clipP) {
    clipP = (async () => {
      await ensureLib();
      const progress_callback = progressFn(90, 0);
      const [tok, proc, model] = await Promise.all([
        lib.AutoTokenizer.from_pretrained(CLIP, { progress_callback }),
        lib.AutoProcessor.from_pretrained(CLIP, { progress_callback }),
        lib.CLIPSegForImageSegmentation.from_pretrained(CLIP, { dtype: 'q8', progress_callback })
      ]);
      return { proc, model, text: tok(['a wall'], { padding: true, truncation: true }) };
    })();
    clipP.catch(() => { clipP = null; });
  }
  return clipP;
}
function loadSam() {
  if (!samP) {
    samP = (async () => {
      await ensureLib();
      const progress_callback = progressFn(10, 90);
      const [model, proc] = await Promise.all([
        lib.SamModel.from_pretrained(SAM, { dtype: 'q8', progress_callback }),
        lib.AutoProcessor.from_pretrained(SAM, { progress_callback })
      ]);
      return { model, proc };
    })();
    samP.catch(() => { samP = null; });
  }
  return samP;
}
async function startAI() {
  try { await loadClip(); await loadSam().catch(() => { }); aiState = 'ready'; aiProgress = 100; }
  catch (e) { aiState = 'off'; }
  postAI();
}
function aiOff() { if (aiState !== 'off') { aiState = 'off'; postAI(); } }

/* ---------- image helpers ---------- */
function rawRGB(orig, W, H) { return new lib.RawImage(new Uint8ClampedArray(orig), W, H, 4).rgb(); }
async function resized(orig, W, H, w, h) {        // high-quality resize through OffscreenCanvas
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(orig), W, H));
  const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, 0, w, h); bmp.close();
  return x.getImageData(0, 0, w, h).data;
}

/* CLIPSeg: wall probability 0..255 at the working size (bilinear from the model's low-res map) */
async function runClip(orig, W, H) {
  const m = await loadClip();
  const small = await resized(orig, W, H, CLIP_SIZE, CLIP_SIZE);
  const vis = await m.proc(rawRGB(small, CLIP_SIZE, CLIP_SIZE));
  const { logits } = await m.model({ ...m.text, ...vis });
  const d = logits.data, w = logits.dims[logits.dims.length - 1], hh = logits.dims[logits.dims.length - 2];
  const r = new Uint8Array(w * hh);
  for (let i = 0; i < r.length; i++) r[i] = Math.round(255 / (1 + Math.exp(-d[i])));
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let gy = (y + 0.5) * hh / H - 0.5; if (gy < 0) gy = 0; if (gy > hh - 1) gy = hh - 1;
    const y0 = Math.floor(gy), y1 = Math.min(hh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < W; x++) {
      let gx = (x + 0.5) * w / W - 0.5; if (gx < 0) gx = 0; if (gx > w - 1) gx = w - 1;
      const x0 = Math.floor(gx), x1 = Math.min(w - 1, x0 + 1), fx = gx - x0;
      out[y * W + x] = (r[y0 * w + x0] * (1 - fx) + r[y0 * w + x1] * fx) * (1 - fy) + (r[y1 * w + x0] * (1 - fx) + r[y1 * w + x1] * fx) * fy;
    }
  }
  return out;
}

/* SlimSAM: image embeddings once per photo (heavy), then masks for points (light) */
const embCache = new Map();                   // photo id -> {image, emb}; only the most recent photo is kept
async function samPrepare(id, orig, W, H) {
  if (embCache.has(id)) return embCache.get(id);
  const { model, proc } = await loadSam();
  const image = rawRGB(orig, W, H);
  const inputs = await proc(image);
  const emb = await model.get_image_embeddings(inputs);
  embCache.clear(); embCache.set(id, { image, emb });
  return embCache.get(id);
}
async function samMasks(hd, points) {
  const { model, proc } = await loadSam();
  const inputs = await proc(hd.image, { input_points: [points.map(p => [p])] });
  const out = await model({ ...hd.emb, input_points: inputs.input_points });
  const masks = await proc.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
  const m = masks[0], d = m.dims;
  return { w: d[d.length - 1], h: d[d.length - 2], k: d[d.length - 3], data: m.data, scores: out.iou_scores.data };
}

/* ---------- analysis of one photo ---------- */
async function analyze({ id, orig, W, H }) {
  const step = p => post({ type: 'analyzing', id, p });   // rough progress by stage, for the page's progress bar
  try {
    step(3);
    const work = buildWork(orig, W, H);
    let P = null, sam = null;
    if (aiState !== 'off') {
      try { P = await runClip(orig, W, H); }
      catch (e) { aiOff(); P = null; }
      step(40);
    }
    if (P) {
      work.ai = P;
      if (aiMax(P) >= AI_MIN) {                // SAM only when CLIPSeg actually sees a wall
        try {
          const hd = await samPrepare(id, orig, W, H), pts = samPoints(P, W, H);
          step(80);
          if (pts.length) sam = samUnion(await samMasks(hd, pts), pts, P, W, H);
          step(90);
        } catch (e) { sam = null; }
      }
      work.sam = sam;
    }
    const t = autoTune(work);
    post({ type: 'analyzed', id, alpha: t.alpha, sens: t.sens, cover: t.cover, viaAI: t.viaAI }, [t.alpha.buffer]);
  } catch (e) {
    post({ type: 'error', id, kind: 'analyze', message: String(e && e.message || e) });
  }
}

/* ---------- SAM click: the surface under one point ---------- */
async function samPoint({ id, orig, W, H, x, y }) {
  try {
    if (aiState === 'off') throw new Error('ai-off');
    const hd = await samPrepare(id, orig, W, H);
    const r = await samMasks(hd, [[x, y]]);
    const mask = samBest(r, W, H);
    post({ type: 'samMask', id, mask }, [mask.buffer]);
  } catch (e) {
    post({ type: 'error', id, kind: 'sam', message: String(e && e.message || e) });
  }
}

/* ---------- full-size export, processed in strips ---------- */
async function exportPhoto({ id, file, W, H, fw, fh, alpha, ref, target, adj, fmt }) {
  try {
    const bmp = await createImageBitmap(file, { resizeWidth: fw, resizeHeight: fh, resizeQuality: 'high' });
    const cv = new OffscreenCanvas(fw, fh), ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, fw, fh); bmp.close();
    const P = renderParams(ref, target, adj);
    const X0 = new Int32Array(fw), X1 = new Int32Array(fw), FX = new Float32Array(fw);
    for (let x = 0; x < fw; x++) {
      let g = (x + 0.5) * W / fw - 0.5; if (g < 0) g = 0; if (g > W - 1) g = W - 1;
      const i = Math.floor(g); X0[x] = i; X1[x] = Math.min(W - 1, i + 1); FX[x] = g - i;
    }
    const scale = fw / W, refine = scale > 1.3;                  // re-snap the mask to full-size edges when it was upscaled
    const r = Math.max(2, Math.round(Math.max(fw, fh) / 320)), pad = refine ? 2 * r + 2 : 0;
    const STRIP = Math.max(16, Math.floor(1e6 / fw));
    const rowAlpha = (y, out, off) => {                           // bilinear sample of the low-res alpha for one full-size row
      let gy = (y + 0.5) * H / fh - 0.5; if (gy < 0) gy = 0; if (gy > H - 1) gy = H - 1;
      const yi = Math.floor(gy), fy = gy - yi, rA = yi * W, rB = Math.min(H - 1, yi + 1) * W;
      for (let x = 0; x < fw; x++) {
        const fx = FX[x], x0 = X0[x], x1 = X1[x];
        out[off + x] = (alpha[rA + x0] * (1 - fx) + alpha[rA + x1] * fx) * (1 - fy) + (alpha[rB + x0] * (1 - fx) + alpha[rB + x1] * fx) * fy;
      }
    };
    for (let y0 = 0; y0 < fh; y0 += STRIP) {
      const h = Math.min(STRIP, fh - y0), top = Math.max(0, y0 - pad), bot = Math.min(fh, y0 + h + pad), hh = bot - top;
      const id8 = ctx.getImageData(0, top, fw, hh), d = id8.data, n = fw * hh;
      const a = new Float32Array(n);
      for (let y = 0; y < hh; y++) rowAlpha(top + y, a, y * fw);
      let a8;
      let partial = false; for (let i = 0; i < n && !partial; i++) partial = a[i] > 2 && a[i] < 253;
      if (refine && partial) {
        const I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], p = new Float32Array(n);
        for (let i = 0; i < n; i++) { I[0][i] = d[i * 4] / 255; I[1][i] = d[i * 4 + 1] / 255; I[2][i] = d[i * 4 + 2] / 255; p[i] = a[i] / 255; }
        const q = guidedFilter(I, p, fw, hh, r, 2e-3);
        a8 = new Uint8Array(n);
        for (let i = 0; i < n; i++) { const v = (q[i] - 0.5) * 1.6 + 0.5; a8[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); }
      } else {
        a8 = new Uint8Array(n); for (let i = 0; i < n; i++) a8[i] = a[i] + 0.5;
      }
      const c0 = (y0 - top) * fw, c1 = c0 + h * fw;
      recolor(d, d, a8, c0, c1, P, false);
      ctx.putImageData(id8, 0, top, 0, y0 - top, fw, h);
      post({ type: 'progress', id, p: Math.min(99, Math.round((y0 + h) / fh * 100)) });
    }
    const blob = await cv.convertToBlob({ type: fmt === 'png' ? 'image/png' : 'image/jpeg', quality: 0.95 });
    cv.width = cv.height = 1;
    post({ type: 'exported', id, blob });
  } catch (e) {
    post({ type: 'error', id, kind: 'export', message: String(e && e.message || e) });
  }
}

/* ---------- message loop (analyses run one at a time, in order) ---------- */
let queue = Promise.resolve();
self.onmessage = e => {
  const m = e.data;
  switch (m.type) {
    case 'init': useLocal = !!m.local; startAI(); break;
    case 'analyze': queue = queue.then(() => analyze(m)); break;
    case 'samPoint': queue = queue.then(() => samPoint(m)); break;
    case 'export': queue = queue.then(() => exportPhoto(m)); break;
    case 'drop': embCache.delete(m.id); break;
  }
};
