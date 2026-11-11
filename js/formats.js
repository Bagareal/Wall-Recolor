// File containers: recognise an image from its first bytes, read the ICC profile embedded in JPEG / PNG / WebP
// files, and embed a profile into the JPEG / PNG files the browser encodes (the browser itself writes none).
// Pure module (uses only CompressionStream / DecompressionStream, available in browsers and Node 18+).

import { crc32 } from './zip.js';

const str = (u8, o, n) => String.fromCharCode(...u8.subarray(o, o + n));

/** 'jpeg' | 'png' | 'webp' | 'tiff' | 'psd' | 'gif' | 'bmp' | 'avif' | 'heic' | 'other' */
export function detectFormat(u8) {
  if (u8.length < 12) return 'other';
  if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
  if (str(u8, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (str(u8, 0, 4) === 'RIFF' && str(u8, 8, 4) === 'WEBP') return 'webp';
  if (str(u8, 0, 4) === 'II*\0' || str(u8, 0, 4) === 'MM\0*') return 'tiff';
  if (str(u8, 0, 4) === '8BPS') return 'psd';
  if (str(u8, 0, 4) === 'GIF8') return 'gif';
  if (str(u8, 0, 2) === 'BM') return 'bmp';
  if (str(u8, 4, 4) === 'ftyp') {
    const brand = str(u8, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return 'heic';
  }
  return 'other';
}

const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function pipe(u8, stream) {
  const body = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
const inflate = u8 => pipe(u8, new DecompressionStream('deflate'));
const deflate = u8 => pipe(u8, new CompressionStream('deflate'));

/* ---------- JPEG: the profile is split over APP2 "ICC_PROFILE" segments ---------- */
const ICC_SIG = 'ICC_PROFILE\0', ICC_CHUNK = 65519;           // 65535 - 2 (length) - 12 (signature) - 2 (sequence)

/** Marker segments before the image data: [{start, end, marker, icc}], plus the offset where the scan starts. */
function jpegSegments(u8) {
  const segs = []; let o = 2;
  while (o + 4 <= u8.length && u8[o] === 0xFF) {
    const m = u8[o + 1];
    if (m === 0xFF) { o++; continue; }                          // fill byte
    if (m === 0xDA || m === 0xD9) break;                       // start of scan / end of image
    const end = o + 2 + ((u8[o + 2] << 8) | u8[o + 3]);
    segs.push({ start: o, end, marker: m, icc: m === 0xE2 && end - o >= 18 && str(u8, o + 4, 12) === ICC_SIG });
    o = end;
  }
  return { segs, scan: o };
}

/** The ICC profile of a JPEG file, or null. */
export function iccFromJpeg(u8) {
  const parts = jpegSegments(u8).segs.filter(s => s.icc).map(s => ({ seq: u8[s.start + 16], data: u8.subarray(s.start + 18, s.end) }));
  if (!parts.length) return null;
  parts.sort((a, b) => a.seq - b.seq);
  return concat(parts.map(p => p.data));
}

/** A copy of the JPEG with `icc` embedded (replacing any profile it had), after its JFIF / Exif header. */
export function jpegWithIcc(u8, icc) {
  const { segs, scan } = jpegSegments(u8), count = Math.ceil(icc.length / ICC_CHUNK), out = [u8.subarray(0, 2)];
  let k = 0;
  for (; k < segs.length && (segs[k].marker === 0xE0 || segs[k].marker === 0xE1); k++) out.push(u8.subarray(segs[k].start, segs[k].end));
  for (let n = 0; n < count; n++) {
    const data = icc.subarray(n * ICC_CHUNK, (n + 1) * ICC_CHUNK), len = 2 + 12 + 2 + data.length;
    const head = new Uint8Array(18);
    head.set([0xFF, 0xE2, len >> 8, len & 255]);
    for (let i = 0; i < 12; i++) head[4 + i] = ICC_SIG.charCodeAt(i);
    head[16] = n + 1; head[17] = count;
    out.push(head, data);
  }
  for (; k < segs.length; k++) if (!segs[k].icc) out.push(u8.subarray(segs[k].start, segs[k].end));
  out.push(u8.subarray(scan));
  return concat(out);
}

/* ---------- PNG: one zlib-compressed iCCP chunk ---------- */
function pngChunks(u8) {
  const chunks = [], dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let o = 8; o + 12 <= u8.length;) {
    const len = dv.getUint32(o), type = str(u8, o + 4, 4), end = o + 12 + len;
    if (end > u8.length) break;
    chunks.push({ type, start: o, end, data: u8.subarray(o + 8, o + 8 + len) });
    o = end;
    if (type === 'IEND') break;
  }
  return chunks;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The ICC profile of a PNG file, or null. */
export async function iccFromPng(u8) {
  const c = pngChunks(u8).find(ch => ch.type === 'iCCP');
  if (!c) return null;
  const nul = c.data.indexOf(0);
  if (nul < 0 || c.data[nul + 1] !== 0) return null;              // compression method must be 0 (zlib)
  try { return await inflate(c.data.subarray(nul + 2)); } catch (e) { return null; }
}

/** A copy of the PNG with `icc` embedded right after the header; other colour chunks (sRGB, gAMA, cHRM) are dropped. */
export async function pngWithIcc(u8, icc, name = 'ICC profile') {
  const chunks = pngChunks(u8), nm = new TextEncoder().encode(name), z = await deflate(icc);
  const body = new Uint8Array(nm.length + 2 + z.length);
  body.set(nm, 0); body.set(z, nm.length + 2);                  // name, NUL, method 0, compressed profile
  const out = [u8.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === 'iCCP' || c.type === 'sRGB' || c.type === 'gAMA' || c.type === 'cHRM') continue;
    out.push(u8.subarray(c.start, c.end));
    if (c.type === 'IHDR') out.push(pngChunk('iCCP', body));
  }
  return concat(out);
}

/* ---------- WebP: an ICCP chunk in the RIFF container ---------- */
/** The ICC profile of a WebP file, or null. */
export function iccFromWebp(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let o = 12; o + 8 <= u8.length;) {
    const type = str(u8, o, 4), len = dv.getUint32(o + 4, true);
    if (type === 'ICCP') return u8.slice(o + 8, o + 8 + len);
    o += 8 + len + (len & 1);
  }
  return null;
}

/** The ICC profile of a browser-decodable file (JPEG, PNG, WebP), or null. */
export async function iccOf(u8, format) {
  if (format === 'jpeg') return iccFromJpeg(u8);
  if (format === 'png') return iccFromPng(u8);
  if (format === 'webp') return iccFromWebp(u8);
  return null;
}
