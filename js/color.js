// Colour maths (sRGB <-> linear <-> CIE Lab) and parsing of user-typed colours.
// Pure module: no DOM, usable from the main thread, the worker and Node tests.

export const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export const SN = 8192, SRGB = new Uint8ClampedArray(SN + 1);
for (let i = 0; i <= SN; i++) { const l = i / SN; SRGB[i] = Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255); }

const fLab = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
const iLab = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
const lin8 = v => v <= 0 ? 0 : SRGB[v >= 1 ? SN : (v * SN + 0.5) | 0];

/* Lab is always relative to the D65 white, whatever the photo's colour profile (see icc.js). */
export const XN = 0.95047, ZN = 1.08883;
/** XYZ (D65, Y of white = 1) -> Lab, written into `out` and returned. */
export function labOfXyz(X, Y, Z, out) {
  const fx = fLab(X / XN), fy = fLab(Y), fz = fLab(Z / ZN);
  out[0] = 116 * fy - 16; out[1] = 500 * (fx - fy); out[2] = 200 * (fy - fz); return out;
}
/** Lab -> XYZ (D65), L clamped to 0..100, written into `out` and returned. */
export function xyzOfLab(L, a, b, out) {
  if (L < 0) L = 0; else if (L > 100) L = 100;
  const fy = (L + 16) / 116;
  out[0] = iLab(fy + a / 500) * XN; out[1] = iLab(fy); out[2] = iLab(fy - b / 200) * ZN; return out;
}

/** sRGB 0..255 -> Lab, written into `out` (array of 3) and returned. */
export function labOf(r, g, b, out) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  return labOfXyz(0.4124 * R + 0.3576 * G + 0.1805 * B, 0.2126 * R + 0.7152 * G + 0.0722 * B, 0.0193 * R + 0.1192 * G + 0.9505 * B, out);
}
/** Lab -> sRGB 0..255 (clamped), written into `out` and returned. */
export function rgbOfLab(L, a, b, out) {
  xyzOfLab(L, a, b, out); const x = out[0], y = out[1], z = out[2];
  out[0] = lin8(3.2406 * x - 1.5372 * y - 0.4986 * z); out[1] = lin8(-0.9689 * x + 1.8758 * y + 0.0415 * z); out[2] = lin8(0.0557 * x - 0.2040 * y + 1.0570 * z); return out;
}
/** Linear sRGB (0..1, clamped) -> 8-bit sRGB code. */
export const srgb8 = lin8;

/** The sRGB colour space in the shape every recolouring function expects (other spaces come from icc.js). */
export const SRGB_SPACE = { name: 'sRGB', labOf, rgbOfLab };

export const DEFAULT_COLOR = { rgb: [51, 63, 72], hex: '#333F48', name: '432 C' };

/* Pantone Coated names -> sRGB approximations (Pantone's own on-screen values; partial table).
   Keys are normalised: upper case, single spaces, trailing " C". */
export const PANTONE = {
  '432 C': '#333F48', '433 C': '#1D252D', '431 C': '#5B6770', '430 C': '#7C878E', '429 C': '#A2AAAD', '428 C': '#C1C6C8', '427 C': '#D0D3D4', '426 C': '#25282A',
  'BLACK C': '#2D2926', 'COOL GRAY 1 C': '#D9D9D6', 'COOL GRAY 2 C': '#D0D0CE', 'COOL GRAY 3 C': '#C8C9C7', 'COOL GRAY 4 C': '#BBBCBC', 'COOL GRAY 5 C': '#B1B3B3',
  'COOL GRAY 6 C': '#A7A8AA', 'COOL GRAY 7 C': '#97999B', 'COOL GRAY 8 C': '#888B8D', 'COOL GRAY 9 C': '#75787B', 'COOL GRAY 10 C': '#63666A', 'COOL GRAY 11 C': '#53565A',
  'WARM GRAY 1 C': '#D7D2CB', 'WARM GRAY 2 C': '#CBC4BC', 'WARM GRAY 3 C': '#BFB8AF', 'WARM GRAY 4 C': '#B6ADA5', 'WARM GRAY 5 C': '#ACA39A', 'WARM GRAY 6 C': '#A59C94',
  'WARM GRAY 7 C': '#968C83', 'WARM GRAY 8 C': '#8C8279', 'WARM GRAY 9 C': '#83786F', 'WARM GRAY 10 C': '#796E65', 'WARM GRAY 11 C': '#6E6259',
  '7540 C': '#4B4F54', '7541 C': '#D9E1E2', '7542 C': '#A4BCC2', '7543 C': '#98A4AE', '7544 C': '#8A99A5', '7545 C': '#425563', '7546 C': '#253746', '7547 C': '#131E29',
  '5405 C': '#4F6D7A', '5415 C': '#5B7F95', '5425 C': '#7A99AC', '5435 C': '#A6BBC8', '5445 C': '#B9C9D5', '5455 C': '#BFCED6',
  '289 C': '#0C2340', '294 C': '#002F6C', '295 C': '#002855', '281 C': '#00205B', '282 C': '#041E42', '533 C': '#1F2A44', '540 C': '#003057', '541 C': '#003A70', '2767 C': '#13294B',
  '286 C': '#0033A0', '293 C': '#003DA5', '300 C': '#005EB8', '301 C': '#004B87', '302 C': '#003B5C', '2945 C': '#004C97', '2955 C': '#003865', 'REFLEX BLUE C': '#001489', 'PROCESS BLUE C': '#0085CA',
  '2728 C': '#0047BB', '2935 C': '#0057B8', '3005 C': '#0077C8', '3015 C': '#00629B', '7462 C': '#00558C', '7463 C': '#002B49', '7686 C': '#1D4F91', '7687 C': '#1D428A',
  '2746 C': '#171C8F', '2747 C': '#001A72', '2748 C': '#001E62', '2758 C': '#001E60', '2766 C': '#141B4D', '2738 C': '#06038D', '2736 C': '#1E22AA', '2726 C': '#485CC7', '2718 C': '#5C88DA',
  '2708 C': '#B8CCEA', '2717 C': '#A7C6ED', '290 C': '#B9D9EB', '291 C': '#9BCBEB', '292 C': '#69B3E7', '297 C': '#71C5E8', '298 C': '#41B6E6', '299 C': '#00A3E0', '306 C': '#00B5E2', '307 C': '#006BA6',
  '3125 C': '#00AEC7', '320 C': '#009CA6', '3262 C': '#00BFB3', '3275 C': '#00B2A9', '3288 C': '#00816D', '3295 C': '#00704A', '339 C': '#00B388', '340 C': '#00965E',
  '347 C': '#009A44', '348 C': '#00843D', '349 C': '#046A38', '354 C': '#00B140', '355 C': '#009639', '356 C': '#007A33', '357 C': '#215732', '361 C': '#43B02A', '368 C': '#78BE20',
  '375 C': '#97D700', '376 C': '#84BD00', '382 C': '#C4D600', '7483 C': '#275D38', '5535 C': '#183028',
  '101 C': '#F7EA48', '102 C': '#FCE300', '107 C': '#FBE122', '108 C': '#FEDB00', '109 C': '#FFD100', '115 C': '#FDDA24', '116 C': '#FFCD00', '120 C': '#FBDB65', '123 C': '#FFC72C',
  '1235 C': '#FFB81C', '124 C': '#EAAA00', '125 C': '#B58500', '130 C': '#F2A900', '131 C': '#CC8A00', '137 C': '#FFA300', '138 C': '#DE7C00', '1375 C': '#FF9E1B', '144 C': '#ED8B00',
  '151 C': '#FF8200', '152 C': '#E57200', '158 C': '#E87722', '1585 C': '#FF6A13', '165 C': '#FF6720', '1655 C': '#FC4C02', '1665 C': '#DC4405', '021 C': '#FE5000', '172 C': '#FA4616', '173 C': '#CF4520',
  '7401 C': '#F5E1A4', '7403 C': '#EED484', '7406 C': '#F1C400', '7408 C': '#F6BE00', '7409 C': '#F0B323', '7413 C': '#DC8633', '7416 C': '#E56A54', '7417 C': '#E4573D', '7579 C': '#DC4405', '7625 C': '#E1523D',
  '185 C': '#E4002B', '186 C': '#C8102E', '187 C': '#A6192E', '188 C': '#76232F', '485 C': '#DA291C', '1785 C': '#F8485E', '1788 C': '#EE2737', '1795 C': '#D22630', '1797 C': '#CB333B',
  '1805 C': '#AF272F', '1807 C': '#A4343A', '199 C': '#D50032', '200 C': '#BA0C2F', '201 C': '#9D2235', '202 C': '#862633', '207 C': '#A50034', '208 C': '#861F41', '209 C': '#6F263D',
  '2347 C': '#E10600', '7621 C': '#AB2328', '7623 C': '#8A2A2B', '7420 C': '#9B2242', '7421 C': '#651D32', '7427 C': '#971B2F',
  '212 C': '#F04E98', '219 C': '#DA1884', '226 C': '#D0006F', '266 C': '#753BBD', '2685 C': '#330072',
  '476 C': '#4E3629', '4625 C': '#4F2C1D', '469 C': '#693F23', '1545 C': '#653819', '7533 C': '#4B3D2A', '7589 C': '#5C462B'
};

const HEX_RE = /^#?([0-9a-f]{6})$/i, HEX3_RE = /^#?([0-9a-f]{3})$/i;
const toHex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const hexToRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Normalise a Pantone name: "pantone 432c", "432 c", "Cool gray 9" -> "432 C", "COOL GRAY 9 C". */
export function pantoneKey(text) {
  let s = String(text).trim().toUpperCase().replace(/^PANTONE\s*/i, '').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/(\d)C$/, '$1 C');                 // "432C" -> "432 C"
  if (!/ C$/.test(s)) s += ' C';                   // "432" -> "432 C"
  return s;
}

/** Parse "#333F48", "333F48", "#3f4", "rgb(51,63,72)", "51 63 72", "51,63,72", "432 C", "Pantone 432 C", "cool gray 9".
 *  Returns {rgb:[r,g,b], hex:'#RRGGBB', name: pantone name or null} or null when unreadable. */
export function parseColor(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  let m;
  if ((m = HEX_RE.exec(s))) { const hex = '#' + m[1].toUpperCase(); return { rgb: hexToRgb(hex), hex, name: null }; }
  if ((m = HEX3_RE.exec(s))) { const hex = '#' + m[1].split('').map(c => c + c).join('').toUpperCase(); return { rgb: hexToRgb(hex), hex, name: null }; }
  if ((m = /^rgba?\s*\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+\s*)?\)$/i.exec(s)) || (m = /^(\d{1,3})\s*[, ;]\s*(\d{1,3})\s*[, ;]\s*(\d{1,3})$/.exec(s))) {
    const rgb = [+m[1], +m[2], +m[3]];
    if (rgb.some(v => v > 255)) return null;
    return { rgb, hex: toHex(rgb), name: null };
  }
  const key = pantoneKey(s), hex = PANTONE[key];
  if (hex) return { rgb: hexToRgb(hex), hex, name: key };
  return null;
}

/** Short label used in file names: "432C" for a Pantone colour, "333F48" for anything else. */
export function colorSlug(c) { return c.name ? c.name.replace(/\s+/g, '') : c.hex.slice(1); }
