import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, pantoneKey, colorSlug, labOf, rgbOfLab, DEFAULT_COLOR } from '../js/color.js';

test('parseColor reads hex, rgb and pantone forms', () => {
  assert.deepEqual(parseColor('#333F48'), { rgb: [51, 63, 72], hex: '#333F48', name: null });
  assert.deepEqual(parseColor('333f48').rgb, [51, 63, 72]);
  assert.deepEqual(parseColor('#3f4').hex, '#33FF44');
  assert.deepEqual(parseColor('rgb(51, 63, 72)').hex, '#333F48');
  assert.deepEqual(parseColor('51 63 72').hex, '#333F48');
  assert.deepEqual(parseColor('51,63,72').hex, '#333F48');
  assert.deepEqual(parseColor('432 C'), { rgb: [51, 63, 72], hex: '#333F48', name: '432 C' });
  assert.deepEqual(parseColor('Pantone 432c').name, '432 C');
  assert.deepEqual(parseColor('cool gray 9').name, 'COOL GRAY 9 C');
});

test('parseColor rejects bad input without throwing', () => {
  for (const bad of ['', '   ', 'hello', '#12345', 'rgb(300,0,0)', '999 C', null, undefined]) assert.equal(parseColor(bad), null, String(bad));
});

test('pantoneKey normalises names', () => {
  assert.equal(pantoneKey('pantone  432c'), '432 C');
  assert.equal(pantoneKey('432'), '432 C');
  assert.equal(pantoneKey('Cool_Gray-9 c'), 'COOL GRAY 9 C');
});

test('colorSlug gives file-name friendly labels', () => {
  assert.equal(colorSlug(DEFAULT_COLOR), '432C');
  assert.equal(colorSlug(parseColor('#A1B2C3')), 'A1B2C3');
});

test('Lab round trip is exact for 8-bit colours', () => {
  const lab = [0, 0, 0], rgb = [0, 0, 0];
  for (const c of [[51, 63, 72], [0, 0, 0], [255, 255, 255], [200, 30, 90], [12, 250, 128]]) {
    labOf(c[0], c[1], c[2], lab); rgbOfLab(lab[0], lab[1], lab[2], rgb);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(rgb[k] - c[k]) <= 1, `${c} -> ${rgb}`);
  }
  labOf(51, 63, 72, lab);
  assert.ok(lab[0] > 20 && lab[0] < 30, 'L of 432 C is about 26');
});
