import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWork, detect, autoTune, hardAlpha, samPoints, samBest, samUnion } from '../js/detect.js';
import { wallRef, renderParams, recolor } from '../js/recolor.js';
import { coverageOf } from '../js/imgproc.js';
import { rgbOfLab } from '../js/color.js';

/* a grey-blue wall (top 60%) with a warm wooden floor (bottom 40%) and a dark picture frame on the wall */
function scene(W = 160, H = 120) {
  const orig = new Uint8ClampedArray(W * H * 4), truth = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4, shade = 1 - 0.15 * x / W;       // gentle lighting gradient
    let r, g, b, wall = y < H * 0.6;
    if (wall) { r = 150 * shade; g = 165 * shade; b = 185 * shade; }
    else { r = 160; g = 110; b = 70; }
    if (x >= 60 && x < 100 && y >= 20 && y < 50) { r = 40; g = 30; b = 25; wall = false; }   // frame
    const noise = ((x * 7 + y * 13) % 5) - 2;
    orig[o] = r + noise; orig[o + 1] = g + noise; orig[o + 2] = b + noise; orig[o + 3] = 255;
    truth[i] = wall ? 255 : 0;
  }
  return { orig, truth, W, H };
}

test('basic colour detection finds the grey-blue wall and not the floor', () => {
  const { orig, truth, W, H } = scene();
  const st = buildWork(orig, W, H);
  const r = detect(st, 0.4);
  assert.equal(r.viaAI, false);
  let agree = 0; for (let i = 0; i < truth.length; i++) if ((r.mask[i] > 0) === (truth[i] > 0)) agree++;
  assert.ok(agree / truth.length > 0.95, 'agreement ' + agree / truth.length);
  assert.equal(r.mask[(H - 5) * W + 10], 0, 'floor is not wall');
  assert.equal(r.mask[35 * W + 80], 0, 'frame is not wall');
});

test('autoTune returns a soft alpha with coverage close to the truth', () => {
  const { orig, truth, W, H } = scene();
  const t = autoTune(buildWork(orig, W, H));
  assert.ok(Math.abs(t.cover - coverageOf(truth)) < 0.05);
  assert.ok([0.4, 0.6, 0.8, 1].includes(t.sens));
  assert.equal(t.alpha.length, W * H);
});

test('AI path with a fake probability map keeps only the wall tint', () => {
  const { orig, truth, W, H } = scene();
  const st = buildWork(orig, W, H);
  st.ai = new Uint8Array(W * H);
  for (let i = 0; i < truth.length; i++) st.ai[i] = truth[i] ? 220 : 40;     // blurry "AI" that also covers the frame a bit
  for (let y = 20; y < 50; y++) for (let x = 60; x < 100; x++) st.ai[y * W + x] = 160;
  const r = detect(st, 0.4);
  assert.equal(r.viaAI, true); assert.equal(r.soft, true);
  assert.ok(r.mask[10 * W + 10] > 200, 'wall is wall');
  assert.ok(r.mask[35 * W + 80] < 60, 'dark frame is excluded by tint');
  assert.ok(r.mask[(H - 5) * W + 10] < 30, 'floor is excluded');
});

test('AI path returns an empty mask when the AI sees no wall', () => {
  const { orig, W, H } = scene();
  const st = buildWork(orig, W, H); st.ai = new Uint8Array(W * H).fill(30);
  assert.equal(coverageOf(detect(st, 0.4).mask), 0);
});

test('hardAlpha keeps the interior solid and softens only the edge', () => {
  const { orig, truth, W, H } = scene();
  const a = hardAlpha(W, H, orig, truth);
  assert.equal(a[10 * W + 10], 255); assert.equal(a[(H - 5) * W + 10], 0);
  const edge = a[Math.floor(H * 0.6) * W + 10];
  assert.ok(edge >= 0 && edge <= 255);
});

test('samPoints picks confident points and SAM helpers map masks back to the image', () => {
  const W = 40, H = 40, P = new Uint8Array(W * H);
  for (let y = 0; y < 20; y++) for (let x = 0; x < W; x++) P[y * W + x] = 200;
  const pts = samPoints(P, W, H);
  assert.ok(pts.length >= 4 && pts.length <= 8);
  assert.ok(pts.every(([, y]) => y < 20));
  const mw = 20, mh = 20, k = 3, data = new Uint8Array(pts.length * k * mw * mh);
  for (let p = 0; p < pts.length; p++) for (let i = 0; i < mw * mh / 2; i++) data[(p * k + 1) * mw * mh + i] = 1;  // proposal 1 = top half
  const u = samUnion({ w: mw, h: mh, k, data }, pts, P, W, H);
  assert.equal(u[5 * W + 5], 255); assert.equal(u[30 * W + 5], 0);
  const best = samBest({ w: mw, h: mh, k, data, scores: [0.1, 0.9, 0.2] }, W, H);
  assert.equal(best[5 * W + 5], 255); assert.equal(best[30 * W + 5], 0);
});

test('recolor maps the wall reference colour exactly to the target and leaves alpha 0 untouched', () => {
  const { orig, truth, W, H } = scene();
  const st = buildWork(orig, W, H);
  const ref = wallRef(W, H, st.sm, truth), target = [51, 63, 72];
  const P = renderParams(ref, target, { op: 100, sat: 0, light: 0 });
  const src = new Uint8ClampedArray(8), dst = new Uint8ClampedArray(8), alpha = new Uint8Array([255, 0]);
  const refRgb = rgbOfLab(ref[0], ref[1], ref[2], [0, 0, 0]);
  src.set([...refRgb, 255, 10, 20, 30, 255]);
  recolor(src, dst, alpha, 0, 2, P, false);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(dst[k] - target[k]) <= 2, `channel ${k}: ${dst[k]} vs ${target[k]}`);
  assert.deepEqual([...dst.slice(4)], [10, 20, 30, 255]);
  recolor(src, dst, alpha, 0, 1, P, true);
  assert.ok(dst[0] > refRgb[0], 'highlight tints toward pink');
});
