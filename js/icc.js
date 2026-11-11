// ICC colour profiles. Photos are recoloured in their own profile, so an Adobe RGB or Display P3 photo stays
// Adobe RGB or Display P3. Pure module: no DOM, usable from the worker and Node tests.
//
// Supported: RGB "matrix + curves" profiles, which is what photos use (sRGB, Adobe RGB, Display P3, ProPhoto…).
// Not supported: profiles built from lookup tables (CMYK, grey, many printer profiles, some v4 profiles);
// photos with those are handled in sRGB.

import { labOfXyz, xyzOfLab, srgb8 } from './color.js';

/* Bradford adaptation from the ICC connection white (D50) to D65, where all Lab maths happens (see color.js) */
const D50_TO_D65 = [0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.0204830, 1.3299098];
const XYZ_TO_SRGB = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570];
/** sRGB primaries adapted to D50, as stored in sRGB ICC profiles (rows X, Y, Z; columns R, G, B). */
export const SRGB_D50 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];

const mul3 = (a, b) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (!det || !isFinite(det)) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

/* ---------- reading ---------- */
const sig = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const ascii = (u8, o, n) => { let s = ''; for (let k = 0; k < n && o + k < u8.length; k++) { const c = u8[o + k]; if (!c) break; s += String.fromCharCode(c); } return s; };

/** Tone curve of one channel ('curv' or 'para' tag) as a function 0..1 -> 0..1, or null. */
function readCurve(u8, dv, o, size) {
  const type = sig(u8, o);
  if (type === 'curv') {
    const n = dv.getUint32(o + 8);
    if (n === 0) return x => x;
    if (n === 1) { const g = dv.getUint16(o + 12) / 256; return x => Math.pow(x, g); }
    if (12 + 2 * n > size) return null;
    const t = new Float32Array(n);
    for (let k = 0; k < n; k++) t[k] = dv.getUint16(o + 12 + 2 * k) / 65535;
    return x => { const p = x * (n - 1), k = Math.min(n - 2, Math.floor(p)), f = p - k; return t[k] + (t[k + 1] - t[k]) * f; };
  }
  if (type === 'para') {
    const fn = dv.getUint16(o + 8), count = [1, 3, 4, 5, 7][fn];
    if (count == null || 12 + 4 * count > size) return null;
    const p = []; for (let k = 0; k < count; k++) p.push(dv.getInt32(o + 12 + 4 * k) / 65536);
    const [g, a, b, c, d, e, f] = p, pw = v => Math.pow(v > 0 ? v : 0, g);
    switch (fn) {
      case 0: return x => pw(x);
      case 1: return x => x >= -b / a ? pw(a * x + b) : 0;
      case 2: return x => x >= -b / a ? pw(a * x + b) + c : c;
      case 3: return x => x >= d ? pw(a * x + b) : c * x;
      case 4: return x => x >= d ? pw(a * x + b) + e : c * x + f;
    }
  }
  return null;
}

/** Profile name from the 'desc' tag (v2 'desc', v4 'mluc', or plain 'text'). */
function readDesc(u8, dv, t) {
  if (!t) return '';
  const o = t.off, type = sig(u8, o);
  if (type === 'desc') return ascii(u8, o + 12, dv.getUint32(o + 8)).trim();
  if (type === 'text') return ascii(u8, o + 8, t.size - 8).trim();
  if (type === 'mluc') {
    const n = dv.getUint32(o + 8), rs = dv.getUint32(o + 12);
    let rec = o + 16;
    for (let k = 0; k < n; k++) if (sig(u8, o + 16 + k * rs).slice(0, 2) === 'en') { rec = o + 16 + k * rs; break; }
    if (!n) return '';
    const len = dv.getUint32(rec + 4), off = o + dv.getUint32(rec + 8);
    let s = ''; for (let k = 0; k + 1 < len && off + k + 1 < u8.length; k += 2) s += String.fromCharCode(dv.getUint16(off + k));
    return s.replace(/\0+$/, '').trim();
  }
  return '';
}

/** Read an ICC profile. Returns {name, space, pcs, matrix, trc} (matrix and trc are null when the profile is not
 *  an RGB matrix profile) or null when the bytes are not an ICC profile. matrix: RGB -> XYZ (D50), rows X, Y, Z. */
export function parseIcc(bytes) {
  if (!bytes || bytes.length < 132) return null;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (sig(u8, 36) !== 'acsp') return null;
  const space = sig(u8, 16).trim(), pcs = sig(u8, 20).trim(), count = dv.getUint32(128), tags = {};
  for (let k = 0; k < count && 132 + 12 * k + 12 <= u8.length; k++) {
    const o = 132 + 12 * k, off = dv.getUint32(o + 4), size = dv.getUint32(o + 8);
    if (off + size <= u8.length && size >= 8) tags[sig(u8, o)] = { off, size };
  }
  const xyz = s => { const t = tags[s]; return t && t.size >= 20 && sig(u8, t.off) === 'XYZ ' ? [0, 1, 2].map(k => dv.getInt32(t.off + 8 + 4 * k) / 65536) : null; };
  const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ');
  const trc = ['rTRC', 'gTRC', 'bTRC'].map(s => tags[s] ? readCurve(u8, dv, tags[s].off, tags[s].size) : null);
  const ok = space === 'RGB' && pcs === 'XYZ' && r && g && b && trc.every(Boolean);
  return { name: readDesc(u8, dv, tags.desc), space, pcs, matrix: ok ? [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]] : null, trc: ok ? trc : null };
}

/* ---------- colour space ---------- */
const INV_N = 4096;                          // inverse curve table, indexed by sqrt(linear) for precision in the shadows
function inverseTable(lin) {
  const t = new Uint8Array(INV_N + 1);
  let k = 0;
  for (let i = 0; i <= INV_N; i++) {
    const l = (i / INV_N) * (i / INV_N);
    while (k < 255 && lin[k + 1] <= l) k++;
    t[i] = k < 255 && l - lin[k] > lin[k + 1] - l ? k + 1 : k;
  }
  return t;
}

/** Colour space of a parsed matrix profile: {name, labOf, rgbOfLab, toSrgb}, the same shape as SRGB_SPACE in color.js.
 *  Returns null for profiles that are not supported. */
export function colorSpaceOf(profile) {
  if (!profile || !profile.matrix) return null;
  const m = mul3(D50_TO_D65, profile.matrix), mi = inv3(m);
  if (!mi) return null;
  const lin = profile.trc.map(f => {
    const t = new Float32Array(256);
    for (let k = 0; k < 256; k++) { const v = f(k / 255); t[k] = v > 0 ? (v < 1 ? v : 1) : 0; }
    return t;
  });
  const [l0, l1, l2] = lin, [e0, e1, e2] = lin.map(inverseTable);
  const enc = (t, v) => v <= 0 ? 0 : t[v >= 1 ? INV_N : (Math.sqrt(v) * INV_N + 0.5) | 0];
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m, [n0, n1, n2, n3, n4, n5, n6, n7, n8] = mi;
  const s = mul3(XYZ_TO_SRGB, m);
  return {
    name: profile.name || 'RGB',
    labOf(r, g, b, out) {
      const R = l0[r], G = l1[g], B = l2[b];
      return labOfXyz(m0 * R + m1 * G + m2 * B, m3 * R + m4 * G + m5 * B, m6 * R + m7 * G + m8 * B, out);
    },
    rgbOfLab(L, a, b, out) {
      xyzOfLab(L, a, b, out); const x = out[0], y = out[1], z = out[2];
      out[0] = enc(e0, n0 * x + n1 * y + n2 * z); out[1] = enc(e1, n3 * x + n4 * y + n5 * z); out[2] = enc(e2, n6 * x + n7 * y + n8 * z);
      return out;
    },
    /** Convert RGBA pixels from this space to sRGB, in place (out-of-gamut colours are clipped). */
    toSrgb(d) {
      for (let o = 0; o < d.length; o += 4) {
        const R = l0[d[o]], G = l1[d[o + 1]], B = l2[d[o + 2]];
        d[o] = srgb8(s[0] * R + s[1] * G + s[2] * B); d[o + 1] = srgb8(s[3] * R + s[4] * G + s[5] * B); d[o + 2] = srgb8(s[6] * R + s[7] * G + s[8] * B);
      }
    }
  };
}

/* ---------- writing (a small sRGB profile for files that had none, and test fixtures) ---------- */
/** Build an ICC v2 RGB display profile. matrix: RGB -> XYZ (D50) like SRGB_D50; curve (shared by the three
 *  channels): a gamma number, an array of samples 0..1, or {para: [g, a, b, c, d]} for a parametric curve of type 3. */
export function buildIcc(name, matrix, curve) {
  const enc = new TextEncoder(), tags = [];
  const xyz = v => { const d = new DataView(new ArrayBuffer(20)); d.setUint32(0, 0x58595A20); v.forEach((x, k) => d.setInt32(8 + 4 * k, Math.round(x * 65536))); return new Uint8Array(d.buffer); };
  const nm = enc.encode(name), desc = new Uint8Array(12 + nm.length + 1 + 4 + 4 + 2 + 1 + 67), dd = new DataView(desc.buffer);
  dd.setUint32(0, 0x64657363); dd.setUint32(8, nm.length + 1); desc.set(nm, 12);
  const cp = enc.encode('No copyright, use freely'), cprt = new Uint8Array(8 + cp.length + 1);
  new DataView(cprt.buffer).setUint32(0, 0x74657874); cprt.set(cp, 8);
  let trc;
  if (curve && curve.para) {                                   // 'para' type 3: (aX + b)^g above d, cX below
    trc = new Uint8Array(12 + 4 * 5); const td = new DataView(trc.buffer);
    td.setUint32(0, 0x70617261); td.setUint16(8, 3); curve.para.forEach((v, k) => td.setInt32(12 + 4 * k, Math.round(v * 65536)));
  } else {
    const samples = typeof curve === 'number' ? null : curve;
    trc = new Uint8Array(12 + (samples ? 2 * samples.length : 2)); const td = new DataView(trc.buffer);
    td.setUint32(0, 0x63757276);
    if (samples) { td.setUint32(8, samples.length); samples.forEach((v, k) => td.setUint16(12 + 2 * k, Math.round(Math.max(0, Math.min(1, v)) * 65535))); }
    else { td.setUint32(8, 1); td.setUint16(12, Math.round(curve * 256)); }
  }
  const col = k => [matrix[k], matrix[3 + k], matrix[6 + k]];
  tags.push(['desc', desc], ['cprt', cprt], ['wtpt', xyz([0.9642, 1, 0.8249])], ['rXYZ', xyz(col(0))], ['gXYZ', xyz(col(1))], ['bXYZ', xyz(col(2))], ['rTRC', trc], ['gTRC', trc], ['bTRC', trc]);
  const pad = n => (n + 3) & ~3, offsets = new Map();
  let size = 128 + 4 + 12 * tags.length;
  for (const [, data] of tags) if (!offsets.has(data)) { offsets.set(data, size); size = pad(size + data.length); }
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, size); dv.setUint32(8, 0x02100000);
  out.set(enc.encode('mntrRGB XYZ '), 12); out.set(enc.encode('acsp'), 36);
  [0.9642, 1, 0.8249].forEach((x, k) => dv.setInt32(68 + 4 * k, Math.round(x * 65536)));
  dv.setUint32(128, tags.length);
  tags.forEach(([s, data], k) => {
    const o = 132 + 12 * k; out.set(enc.encode(s), o); dv.setUint32(o + 4, offsets.get(data)); dv.setUint32(o + 8, data.length);
  });
  for (const [data, off] of offsets) out.set(data, off);
  return out;
}

let srgbBytes = null;
/** A compact sRGB profile, embedded in exports of photos that had no profile (or one that could not be kept). */
export function srgbIcc() {
  if (!srgbBytes) srgbBytes = buildIcc('sRGB IEC61966-2.1', SRGB_D50, Array.from({ length: 1024 }, (_, k) => {
    const c = k / 1023; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }));
  return srgbBytes;
}

/** Shared by the decoder: a profile whose name says sRGB is handled with the built-in sRGB maths even when it is
 *  a lookup-table profile (e.g. the v4 sRGB profile). */
export const looksSrgb = name => /\bsRGB\b/i.test(name || '');
