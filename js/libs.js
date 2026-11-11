// Third-party libraries for TIFF and PSD files, loaded from jsDelivr only when a TIFF is opened or a PSD is
// exported. Versions are pinned; both libraries are MIT-licensed (see README).
//  - utif2 (Photopea): TIFF decoding
//  - ag-psd (Agamnentzar): PSD writing (the wall layer export)

const UTIF_URL = 'https://cdn.jsdelivr.net/npm/utif2@4.1.0/+esm';
const AGPSD_URL = 'https://cdn.jsdelivr.net/npm/ag-psd@33.0.0/+esm';

function lazy(url, setup) {
  let p = null;
  return () => {
    if (!p) { p = import(url).then(setup); p.catch(() => { p = null; }); }   // retry on the next call after a network error
    return p;
  };
}

/** UTIF namespace ({decode, decodeImage, toRGBA8, …}). */
export const loadUtif = lazy(UTIF_URL, m => m.default || m);

/** ag-psd module ({writePsd, …}), set up to work inside a worker (no DOM canvas). */
export const loadAgPsd = lazy(AGPSD_URL, m => {
  m.initializeCanvas((w, h) => new OffscreenCanvas(w, h), (w, h) => new ImageData(w, h));
  return m;
});
