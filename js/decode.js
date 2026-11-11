// Opening photos (runs in the worker). Browser formats are decoded by the browser, TIFF by the library in libs.js
// (only the flattened image: TIFF layers are not read). PSD files are not opened.
// Every photo carries its colour profile: a supported profile is kept for the export, where the photo is decoded
// without colour conversion and recoloured in its own space (see icc.js).

import { detectFormat, iccOf } from './formats.js';
import { parseIcc, colorSpaceOf, looksSrgb } from './icc.js';
import { SRGB_SPACE } from './color.js';
import { loadUtif } from './libs.js';

/** A failure the page explains with its own message. code: 'heic' | 'psd' | 'lib' | 'open'. */
export class OpenError extends Error { constructor(code) { super(code); this.code = code; } }

async function lib(load) {
  try { return await load(); } catch (e) { throw new OpenError('lib'); }
}
function opaque(data, width, height) {          // transparency is not kept: the recoloured photo is always opaque
  for (let o = 3; o < data.length; o += 4) data[o] = 255;
  return { data, width, height };
}

/* ---------- TIFF (utif2): the largest image of the file, which is the full-size flattened image ---------- */
async function readTiff(bytes) {
  const UTIF = await lib(loadUtif), buf = bytes.buffer, ifds = UTIF.decode(buf);
  let img = null;
  for (const d of ifds) if (d.t256 && d.t257 && (!img || d.t256[0] * d.t257[0] > img.t256[0] * img.t257[0])) img = d;
  if (!img) throw new OpenError('open');
  UTIF.decodeImage(buf, img, ifds);
  const w = img.width, h = img.height, rgba = UTIF.toRGBA8(img);
  if (!w || !h || rgba.length < w * h * 4) throw new OpenError('open');
  return {
    raster: opaque(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h),
    icc: img.t34675 ? Uint8Array.from(img.t34675) : null,
    depth: img.t258 ? img.t258[0] : 8
  };
}

/** Format, colour profile and (TIFF only) the pixels of a file, in the file's own colour space.
 *  space: the colour space to recolour in, null when the photo is handled in sRGB.
 *  profile: {name, kept} for the page, null when the file has no profile. */
async function readSource(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()), fmt = detectFormat(bytes);
  if (fmt === 'heic' || fmt === 'psd') throw new OpenError(fmt);
  let raster = null, icc = null, depth = 8;
  if (fmt === 'tiff') ({ raster, icc, depth } = await readTiff(bytes));
  else icc = await iccOf(bytes, fmt);
  const parsed = parseIcc(icc);
  let space = colorSpaceOf(parsed);
  if (!space && parsed && looksSrgb(parsed.name)) space = SRGB_SPACE;     // e.g. the lookup-table v4 sRGB profile
  return { fmt, raster, depth, space, icc: parsed ? icc : null, profile: parsed ? { name: parsed.name || '?', kept: !!space } : null };
}

async function bitmapOf(file, opts) {
  try { return await createImageBitmap(file, opts); } catch (e) { throw new OpenError('open'); }
}

/** Working copy for detection and the preview: RGBA in sRGB, longest side at most maxWork.
 *  Returns {orig, W, H, nw, nh, fmt, depth, profile}. */
export async function openPreview(file, maxWork) {
  const src = await readSource(file);
  let bmp;
  if (src.raster) {
    const r = src.raster;
    if (src.space && src.space.toSrgb) src.space.toSrgb(r.data);
    bmp = await createImageBitmap(new ImageData(r.data, r.width, r.height));
  } else bmp = await bitmapOf(file, { imageOrientation: 'from-image' });   // the browser converts to sRGB
  try {
    const nw = bmp.width, nh = bmp.height;
    if (!nw || !nh) throw new OpenError('open');
    const k = Math.min(1, maxWork / Math.max(nw, nh)), W = Math.max(1, Math.round(nw * k)), H = Math.max(1, Math.round(nh * k));
    const c = new OffscreenCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, 0, 0, W, H);
    return { orig: x.getImageData(0, 0, W, H).data, W, H, nw, nh, fmt: src.fmt, depth: src.depth, profile: src.profile };
  } finally { bmp.close(); }
}

/** The photo at export size (fw × fh), in its own colour space: {data (RGBA), space, icc}.
 *  icc is the profile to embed in the export, or null when the photo is handled in sRGB. */
export async function openFull(file, fw, fh) {
  const src = await readSource(file), keep = !!(src.icc && src.space), space = src.space || SRGB_SPACE, icc = keep ? src.icc : null;
  let bmp;
  if (src.raster) {
    const r = src.raster;
    if (r.width === fw && r.height === fh) return { data: r.data, space, icc };
    bmp = await createImageBitmap(new ImageData(r.data, r.width, r.height), { resizeWidth: fw, resizeHeight: fh, resizeQuality: 'high', colorSpaceConversion: 'none' });
  } else {
    bmp = await bitmapOf(file, { imageOrientation: 'from-image', colorSpaceConversion: keep ? 'none' : 'default', resizeWidth: fw, resizeHeight: fh, resizeQuality: 'high' });
  }
  const c = new OffscreenCanvas(fw, fh), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0); bmp.close();
  const data = x.getImageData(0, 0, fw, fh).data;
  c.width = c.height = 1;
  return { data, space, icc };
}
