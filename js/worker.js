// Compute worker: opening photos (decode.js), AI inference (transformers.js), wall detection, SAM click-selection
// and full-size export (exporter.js).
// The page never blocks: everything heavy happens here.
//
// Two small open-source models run in the browser through transformers.js (Apache-2.0):
//  - CLIPSeg (CIDAS, Apache-2.0): asked for "a wall", gives a rough heat-map of where the wall is
//  - SlimSAM (Segment Anything, Apache-2.0): cuts out whole surfaces with precise outlines
// Model files: ./models/ when served from localhost (see README), otherwise the Hugging Face hub. Photos never leave the browser.

import { buildWork, autoTune, samPoints, samUnion, samBest, aiMax, AI_MIN } from './detect.js';
import { openPreview, OpenError } from './decode.js';
import { exportPhoto } from './exporter.js';

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

/* ---------- opening a photo (not queued: it must not wait for the analysis of the other photos) ---------- */
async function openPhoto({ id, file, maxWork }) {
  try {
    const r = await openPreview(file, maxWork);
    post({ type: 'opened', id, ...r }, [r.orig.buffer]);
  } catch (e) {
    post({ type: 'error', id, kind: 'open', code: e instanceof OpenError ? e.code : 'open', message: String(e && e.message || e) });
  }
}

/* ---------- full-size export (see exporter.js) ---------- */
async function runExport(m) {
  try {
    const blob = await exportPhoto(m, p => post({ type: 'progress', id: m.id, p: Math.min(99, p) }));
    post({ type: 'exported', id: m.id, blob });
  } catch (e) {
    post({ type: 'error', id: m.id, kind: 'export', message: String(e && e.message || e) });
  }
}

/* ---------- message loop (analyses, SAM clicks and exports run one at a time, in order) ---------- */
let queue = Promise.resolve();
self.onmessage = e => {
  const m = e.data;
  switch (m.type) {
    case 'init': useLocal = !!m.local; startAI(); break;
    case 'open': openPhoto(m); break;
    case 'analyze': queue = queue.then(() => analyze(m)); break;
    case 'samPoint': queue = queue.then(() => samPoint(m)); break;
    case 'export': queue = queue.then(() => runExport(m)); break;
    case 'drop': embCache.delete(m.id); break;
  }
};
