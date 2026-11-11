import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, iccFromJpeg, jpegWithIcc, iccFromPng, pngWithIcc, iccFromWebp, iccOf } from '../js/formats.js';
import { crc32 } from '../js/zip.js';

const bytes = (...parts) => {
  const arr = parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : Array.from(p));
  return new Uint8Array(arr);
};
const fakeIcc = n => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 7 + 3) & 255; return u; };

/* a JPEG skeleton: SOI, JFIF APP0, DQT, start of scan with a few bytes, EOI (enough for the segment walker) */
const app0 = bytes([0xFF, 0xE0, 0, 16], 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]);
const dqt = bytes([0xFF, 0xDB, 0, 4, 0, 0]);
const scan = bytes([0xFF, 0xDA, 0, 2, 1, 2, 3, 4, 0xFF, 0xD9]);
const jpeg = bytes([0xFF, 0xD8], app0, dqt, scan);

/* a PNG skeleton: signature, IHDR, sRGB, IDAT, IEND (chunk CRCs are real) */
const chunk = (type, data) => {
  const body = bytes(type, data), len = data.length;
  const crc = crc32(body);
  return bytes([len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], body, [crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]);
};
const png = bytes('\x89PNG\r\n\x1a\n', chunk('IHDR', new Uint8Array(13)), chunk('sRGB', [0]), chunk('IDAT', [1, 2, 3]), chunk('IEND', []));

test('detectFormat recognises files from their first bytes', () => {
  assert.equal(detectFormat(jpeg), 'jpeg');
  assert.equal(detectFormat(png), 'png');
  assert.equal(detectFormat(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'webp');
  assert.equal(detectFormat(bytes('II*\0', new Uint8Array(8))), 'tiff');
  assert.equal(detectFormat(bytes('MM\0*', new Uint8Array(8))), 'tiff');
  assert.equal(detectFormat(bytes('8BPS', new Uint8Array(8))), 'psd');
  assert.equal(detectFormat(bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0])), 'heic');
  assert.equal(detectFormat(bytes([0, 0, 0, 24], 'ftypavif', [0, 0, 0, 0])), 'avif');
  assert.equal(detectFormat(bytes('hello world!')), 'other');
});

test('a profile embedded in a JPEG comes back intact, also when it needs several segments', () => {
  for (const n of [3000, 150000]) {
    const icc = fakeIcc(n), out = jpegWithIcc(jpeg, icc);
    assert.deepEqual(iccFromJpeg(out), icc);
    assert.deepEqual(out.subarray(0, 2 + app0.length), bytes([0xFF, 0xD8], app0), 'JFIF header stays first');
    assert.deepEqual(out.subarray(out.length - scan.length), scan, 'image data untouched');
  }
  assert.equal(iccFromJpeg(jpeg), null);
});

test('embedding a profile in a JPEG replaces the one it had', () => {
  const twice = jpegWithIcc(jpegWithIcc(jpeg, fakeIcc(500)), fakeIcc(900));
  assert.equal(iccFromJpeg(twice).length, 900);
  assert.equal(twice.length, jpeg.length + 18 + 900);
});

test('a profile embedded in a PNG comes back intact; the sRGB chunk is dropped and CRCs are valid', async () => {
  const icc = fakeIcc(4000), out = await pngWithIcc(png, icc);
  assert.deepEqual(await iccFromPng(out), icc);
  assert.deepEqual(await iccOf(out, 'png'), icc);
  const types = [];
  for (let o = 8; o < out.length;) {
    const len = new DataView(out.buffer, out.byteOffset).getUint32(o), type = String.fromCharCode(...out.subarray(o + 4, o + 8));
    const crc = new DataView(out.buffer, out.byteOffset).getUint32(o + 8 + len);
    assert.equal(crc, crc32(out.subarray(o + 4, o + 8 + len)), type + ' CRC');
    types.push(type); o += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'iCCP', 'IDAT', 'IEND']);
  assert.equal(await iccFromPng(png), null);
});

test('the profile of a WebP file is read from its ICCP chunk', async () => {
  const icc = fakeIcc(11), le = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
  const webp = bytes('RIFF', le(0), 'WEBP', 'VP8X', le(10), new Uint8Array(10), 'ICCP', le(11), icc, [0], 'VP8 ', le(2), [9, 9]);
  assert.deepEqual(iccFromWebp(webp), icc);
  assert.deepEqual(await iccOf(webp, 'webp'), icc);
  assert.equal(await iccOf(webp, 'gif'), null);
});
