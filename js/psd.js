// Layered PSD export (runs in the worker): the original photo and, above it, the new colour with the wall as
// layer mask and the chosen opacity, so the mask can be refined in Photoshop. The flattened image is stored too
// ("Maximize compatibility"), so other apps show the result.

import { loadAgPsd } from './libs.js';

/** original / colour / composite: RGBA pixels (width × height); mask: one byte per pixel; opacity 0..1;
 *  icc: profile to embed; names: {original, wall} layer names. Returns a Blob. */
export async function layeredPsd({ width, height, original, colour, composite, mask, opacity, icc, names }) {
  const { writePsd } = await loadAgPsd();
  const px = data => ({ width, height, data });
  const mask4 = new Uint8ClampedArray(width * height * 4);          // ag-psd reads a mask from the first channel of RGBA data
  for (let i = 0; i < mask.length; i++) mask4[i * 4] = mask[i];
  const buffer = writePsd({
    width, height,
    imageResources: { iccProfile: icc },
    imageData: px(composite),
    children: [
      { name: names.original, imageData: px(original) },
      { name: names.wall, opacity, imageData: px(colour), mask: { top: 0, left: 0, bottom: height, right: width, defaultColor: 0, imageData: px(mask4) } }
    ]
  }, { generateThumbnail: false });
  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
}
