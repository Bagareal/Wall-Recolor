import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, makeZip } from '../js/zip.js';

test('crc32 matches the reference check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('makeZip writes valid local, central and end records', async () => {
  const a = new Blob([new TextEncoder().encode('hello')]), b = new Blob([new Uint8Array([1, 2, 3])]);
  const zip = await makeZip([{ name: 'a.txt', blob: a }, { name: 'b.bin', blob: b }], new Date(2024, 0, 2, 3, 4, 6));
  assert.equal(zip.type, 'application/zip');
  const u8 = new Uint8Array(await zip.arrayBuffer()), dv = new DataView(u8.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(14, true), crc32(new TextEncoder().encode('hello')));
  const sizeLocal = (30 + 5 + 5) + (30 + 5 + 3), sizeCentral = (46 + 5) + (46 + 5);
  assert.equal(u8.length, sizeLocal + sizeCentral + 22);
  assert.equal(dv.getUint32(sizeLocal, true), 0x02014b50);
  const end = sizeLocal + sizeCentral;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  assert.equal(dv.getUint16(end + 10, true), 2);
  assert.equal(dv.getUint32(end + 12, true), sizeCentral);
  assert.equal(dv.getUint32(end + 16, true), sizeLocal);
});
