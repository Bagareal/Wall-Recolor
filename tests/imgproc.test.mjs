import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBlur, components, opening, dilateBox, guidedFilter, resizeBilinear, coverageOf } from '../js/imgproc.js';

test('boxBlur keeps a constant image constant', () => {
  const W = 7, H = 5, src = new Uint8Array(W * H).fill(90);
  assert.deepEqual([...boxBlur(src, W, H, 2)], [...src]);
});

test('boxBlur averages a single bright pixel over its window', () => {
  const W = 9, H = 9, src = new Uint8Array(W * H); src[4 * W + 4] = 255;
  const out = boxBlur(src, W, H, 1);
  assert.equal(out[4 * W + 4], Math.round(255 / 9));
  assert.equal(out[0], 0);
});

test('components counts 4-connected blobs and flags border contact', () => {
  const W = 6, H = 4, m = new Uint8Array(W * H);
  m[1 * W + 1] = 255; m[1 * W + 2] = 255;         // inner blob of 2
  m[3 * W + 5] = 255;                              // corner pixel touching the border
  m[0 * W + 4] = 255;                              // diagonal to nothing, touching border
  const cc = components(m, W, H, 255);
  assert.equal(cc.areas.length - 1, 3);
  const inner = cc.labels[1 * W + 1];
  assert.equal(cc.areas[inner], 2); assert.equal(cc.border[inner], false);
  assert.equal(cc.border[cc.labels[3 * W + 5]], true);
});

test('opening removes isolated pixels and keeps solid blocks', () => {
  const W = 10, H = 10, m = new Uint8Array(W * H);
  m[2 * W + 2] = 255;
  for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) m[y * W + x] = 255;
  const o = opening(m, W, H);
  assert.equal(o[2 * W + 2], 0);
  assert.equal(o[6 * W + 6], 255); assert.equal(o[5 * W + 5], 255);
});

test('dilateBox grows a pixel into a square', () => {
  const W = 7, H = 7, m = new Uint8Array(W * H); m[3 * W + 3] = 255;
  const d = dilateBox(m, W, H, 1);
  assert.equal(coverageOf(d), 9 / 49);
});

test('guidedFilter follows the guide edge', () => {
  const W = 16, H = 4, n = W * H, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), p = new Float32Array(n);
  for (let i = 0; i < n; i++) { const left = (i % W) < 8; R[i] = G[i] = B[i] = left ? 0.2 : 0.8; p[i] = left ? 1 : 0; }
  const q = guidedFilter([R, G, B], p, W, H, 2, 1e-4);
  assert.ok(q[1] > 0.9 && q[W - 2] < 0.1, 'far from the edge the mask is unchanged');
  assert.ok(q[7] > q[8], 'the edge stays where the guide changes');
});

test('resizeBilinear preserves a constant image', () => {
  const src = new Uint8Array(4 * 4).fill(77);
  assert.deepEqual([...resizeBilinear(src, 4, 4, 9, 7)], new Array(63).fill(77));
});
