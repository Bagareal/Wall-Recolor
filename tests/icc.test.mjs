import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcc, colorSpaceOf, buildIcc, srgbIcc, SRGB_D50, looksSrgb } from '../js/icc.js';
import { labOf, rgbOfLab } from '../js/color.js';

// Adobe RGB (1998) and Display P3 primaries adapted to D50 (rows X, Y, Z; columns R, G, B)
const ADOBE_D50 = [0.6097559, 0.2052401, 0.1492240, 0.3111145, 0.6256561, 0.0632294, 0.0194702, 0.0608902, 0.7448387];
const P3_D50 = [0.5151, 0.2920, 0.1571, 0.2412, 0.6922, 0.0666, -0.0011, 0.0419, 0.7841];
const adobe = colorSpaceOf(parseIcc(buildIcc('Adobe RGB (1998)', ADOBE_D50, 563 / 256)));
const p3 = colorSpaceOf(parseIcc(buildIcc('Display P3', P3_D50, { para: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] })));
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const samples = [];
for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 15) samples.push([r, g, b]);

test('parseIcc reads the name, primaries and tone curve of a matrix profile', () => {
  const p = parseIcc(buildIcc('Adobe RGB (1998)', ADOBE_D50, 563 / 256));
  assert.equal(p.name, 'Adobe RGB (1998)');
  assert.equal(p.space, 'RGB');
  for (let k = 0; k < 9; k++) assert.ok(Math.abs(p.matrix[k] - ADOBE_D50[k]) < 1e-4);
  assert.ok(Math.abs(p.trc[0](0.5) - Math.pow(0.5, 563 / 256)) < 1e-6);
});

test('profiles that are not RGB matrix profiles are read but not supported; garbage is rejected', () => {
  const cmyk = buildIcc('Fake CMYK', SRGB_D50, 2.2);
  cmyk.set([0x43, 0x4D, 0x59, 0x4B], 16);                      // colour space 'CMYK'
  const p = parseIcc(cmyk);
  assert.equal(p.name, 'Fake CMYK');
  assert.equal(p.matrix, null);
  assert.equal(colorSpaceOf(p), null);
  assert.equal(parseIcc(new Uint8Array(400)), null);
  assert.equal(parseIcc(null), null);
});

test('the sRGB profile gives the same Lab as the built-in sRGB maths', () => {
  const s = colorSpaceOf(parseIcc(srgbIcc()));
  for (const c of samples) assert.ok(dE(s.labOf(...c, [0, 0, 0]), labOf(...c, [0, 0, 0])) < 0.3, c.join(' '));
});

test('every colour survives the trip to Lab and back in its own profile', () => {
  for (const cs of [adobe, p3]) {
    let worst = 0;
    for (const c of samples) {
      const lab = cs.labOf(...c, [0, 0, 0]), back = cs.rgbOfLab(lab[0], lab[1], lab[2], [0, 0, 0]);
      worst = Math.max(worst, ...back.map((v, k) => Math.abs(v - c[k])));
    }
    assert.ok(worst <= 1, cs.name + ' worst ' + worst);
  }
});

test('white is white in every profile, and 432 C has other RGB numbers in Adobe RGB but the same colour', () => {
  for (const cs of [adobe, p3]) {
    const w = cs.labOf(255, 255, 255, [0, 0, 0]);
    assert.ok(Math.abs(w[0] - 100) < 0.2 && Math.abs(w[1]) < 0.3 && Math.abs(w[2]) < 0.3, cs.name);
  }
  const t = labOf(51, 63, 72, [0, 0, 0]), inAdobe = adobe.rgbOfLab(t[0], t[1], t[2], [0, 0, 0]);
  assert.notDeepEqual(inAdobe, [51, 63, 72]);
  assert.ok(dE(adobe.labOf(...inAdobe, [0, 0, 0]), t) < 1);
});

test('toSrgb converts pixels to sRGB without changing their colour', () => {
  const px = new Uint8ClampedArray([120, 140, 160, 255, 200, 180, 150, 255]), before = [0, 4].map(o => adobe.labOf(px[o], px[o + 1], px[o + 2], [0, 0, 0]));
  adobe.toSrgb(px);
  [0, 4].forEach((o, k) => assert.ok(dE(labOf(px[o], px[o + 1], px[o + 2], [0, 0, 0]), before[k]) < 1));
  assert.equal(px[3], 255);
});

test('a v4 profile name stored as mluc is read', () => {
  const name = 'Display P3', u16 = [...name].flatMap(ch => [0, ch.charCodeAt(0)]);
  const mluc = [0x6D, 0x6C, 0x75, 0x63, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 12, 0x65, 0x6E, 0x55, 0x53, 0, 0, 0, u16.length, 0, 0, 0, 28, ...u16];
  const out = new Uint8Array(144 + mluc.length), dv = new DataView(out.buffer);
  dv.setUint32(0, out.length); out.set([0x52, 0x47, 0x42, 0x20, 0x58, 0x59, 0x5A, 0x20], 16); out.set([0x61, 0x63, 0x73, 0x70], 36);
  dv.setUint32(128, 1); out.set([0x64, 0x65, 0x73, 0x63], 132); dv.setUint32(136, 144); dv.setUint32(140, mluc.length);
  out.set(mluc, 144);
  assert.equal(parseIcc(out).name, 'Display P3');
});

test('looksSrgb recognises sRGB profile names', () => {
  assert.ok(looksSrgb('sRGB IEC61966-2.1'));
  assert.ok(looksSrgb('sRGB v4 ICC preference'));
  assert.ok(!looksSrgb('Adobe RGB (1998)'));
  assert.ok(!looksSrgb(''));
});

test('rgbOfLab of the built-in sRGB is unchanged by the refactor', () => {
  assert.deepEqual(rgbOfLab(...labOf(51, 63, 72, [0, 0, 0]), [0, 0, 0]), [51, 63, 72]);
});
