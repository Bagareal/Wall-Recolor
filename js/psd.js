// Wall layer export as PSD (runs in the worker): one layer with the new colour, the wall as layer mask and the chosen
// opacity, at the size of the photo and in its colour profile. In Photoshop it is dragged with Shift into the
// user's own file (TIFF or PSD), which keeps all its layers; Shift-drag aligns it exactly.

import { loadAgPsd } from './libs.js';

/** colour: RGBA pixels (width × height) recoloured everywhere; mask: one byte per pixel; opacity 0..1;
 *  icc: profile to embed; name: layer name. Returns a Blob. */
export async function wallLayerPsd({ width, height, colour, mask, opacity, icc, name }) {
  const { writePsd } = await loadAgPsd();
  const n = width * height, px = data => ({ width, height, data });
  const mask4 = new Uint8ClampedArray(n * 4), composite = new Uint8ClampedArray(n * 4);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    mask4[o] = mask[i];                                         // ag-psd reads a mask from the first channel of RGBA data
    composite[o] = colour[o]; composite[o + 1] = colour[o + 1]; composite[o + 2] = colour[o + 2];
    composite[o + 3] = mask[i] * opacity;                       // what the layer shows, for apps that read only the flattened image
  }
  const buffer = writePsd({
    width, height,
    imageResources: { iccProfile: icc },
    imageData: px(composite),
    children: [{ name, opacity, imageData: px(colour), mask: { top: 0, left: 0, bottom: height, right: width, defaultColor: 0, imageData: px(mask4) } }]
  }, { generateThumbnail: false, noBackground: true });         // a background layer cannot have a mask
  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
}
