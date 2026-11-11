import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderParams, recolor } from '../js/recolor.js';
import { labOf } from '../js/color.js';

const target = [51, 63, 72];
const ref = labOf(170, 180, 190, [0, 0, 0]);          // a light grey-blue wall
// two wall pixels: one in shadow, one in light
const src = new Uint8ClampedArray([140, 150, 160, 255, 200, 210, 220, 255]);
const alpha = new Uint8Array([255, 255]);
const spread = adj => {
  const dst = new Uint8ClampedArray(8);
  recolor(src, dst, alpha, 0, 2, renderParams(ref, target, adj), false);
  return labOf(dst[4], dst[5], dst[6], [0, 0, 0])[0] - labOf(dst[0], dst[1], dst[2], [0, 0, 0])[0];
};

test('contrast 0 (or missing) gives the same result as before the contrast slider existed', () => {
  const a = new Uint8ClampedArray(8), b = new Uint8ClampedArray(8);
  recolor(src, a, alpha, 0, 2, renderParams(ref, target, { op: 100, sat: 0, light: 0 }), false);
  recolor(src, b, alpha, 0, 2, renderParams(ref, target, { op: 100, sat: 0, light: 0, contrast: 0 }), false);
  assert.deepEqual([...a], [...b]);
});

test('positive contrast widens the light/shadow difference on the wall, negative narrows it', () => {
  const s0 = spread({ op: 100, sat: 0, light: 0, contrast: 0 });
  const sUp = spread({ op: 100, sat: 0, light: 0, contrast: 50 });
  const sDown = spread({ op: 100, sat: 0, light: 0, contrast: -50 });
  assert.ok(s0 > 0);
  assert.ok(sUp > s0 * 1.3, `+50: ${sUp} vs ${s0}`);
  assert.ok(sDown < s0 * 0.7, `-50: ${sDown} vs ${s0}`);
});

test('contrast keeps the wall reference colour on the target', () => {
  const P = renderParams(ref, target, { op: 100, sat: 0, light: 0, contrast: 80 });
  const one = new Uint8ClampedArray(4), dst = new Uint8ClampedArray(4);
  one.set([170, 180, 190, 255]);
  recolor(one, dst, new Uint8Array([255]), 0, 1, P, false);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(dst[k] - target[k]) <= 2, `channel ${k}: ${dst[k]} vs ${target[k]}`);
});
