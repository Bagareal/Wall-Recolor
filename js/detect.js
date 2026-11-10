// Wall detection. Pure module: works on a "work" object built by buildWork(), no DOM.
//
//  work = { W, H, orig (RGBA Uint8ClampedArray), sm (box blur r=2 per channel), sm1 (r=1),
//           ai: Uint8Array wall probability 0..255 from CLIPSeg or null, sam: Uint8Array 0/255 surfaces from SlimSAM or null }

import { boxBlur, components, opening, dilateBox, guidedFilter, coverageOf } from './imgproc.js';
import { labOf } from './color.js';

export function buildWork(orig, W, H) {
  const n = W * H, ch = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) { ch[0][i] = orig[i * 4]; ch[1][i] = orig[i * 4 + 1]; ch[2][i] = orig[i * 4 + 2]; }
  return {
    W, H, orig, ai: null, sam: null,
    sm: { r: boxBlur(ch[0], W, H, 2), g: boxBlur(ch[1], W, H, 2), b: boxBlur(ch[2], W, H, 2) },
    sm1: { r: boxBlur(ch[0], W, H, 1), g: boxBlur(ch[1], W, H, 1), b: boxBlur(ch[2], W, H, 1) }
  };
}

/* ---------- basic colour detection (no AI): dominant smooth blue/grey-blue colour ---------- */
function findCenter(st, opts) {
  const { W, H, sm } = st, R = sm.r, G = sm.g, B = sm.b;
  const BL = 32, BU = 24, top = opts.top ? H * 0.3 : -1;
  const bl = v => Math.min(BL - 1, Math.max(0, (v / 8) | 0));
  const bu = v => Math.min(BU - 1, Math.max(0, ((v + 12) / 4) | 0));
  const Lf = i => (R[i] + G[i] + B[i]) / 3;
  const pass = i => {
    const L = Lf(i), u = B[i] - R[i];
    if (u < opts.uMin || L < 18 || L > 238) return false;
    if (opts.smooth && Math.abs(Lf(i + 1) - Lf(i - 1)) + Math.abs(Lf(i + W) - Lf(i - W)) >= 12) return false;
    return true;
  };
  const hist = new Float32Array(BL * BU);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!pass(i)) continue;
    hist[bl(Lf(i)) * BU + bu(B[i] - R[i])] += (y < top ? 1.5 : 1);
  }
  let best = -1, bi = 0, bj = 0;
  for (let a = 0; a < BL; a++) for (let b = 0; b < BU; b++) {
    let sc = 0;
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
      const aa = a + da, bb = b + db; if (aa >= 0 && aa < BL && bb >= 0 && bb < BU) sc += hist[aa * BU + bb];
    }
    if (sc > best) { best = sc; bi = a; bj = b; }
  }
  if (best <= 0) return null;
  let a = 0, b = 0, c = 0, b2 = 0, c2 = 0, k = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!pass(i)) continue;
    const L = Lf(i), u = B[i] - R[i], w = G[i] - (R[i] + B[i]) / 2;
    if (Math.abs(bl(L) - bi) <= 1 && Math.abs(bu(u) - bj) <= 1) { a += L; b += u; c += w; b2 += u * u; c2 += w * w; k++; }
  }
  if (!k) return null;
  const mu = b / k, mw = c / k;
  return { sL: a / k, sU: mu, sW: mw, sdU: Math.sqrt(Math.max(0, b2 / k - mu * mu)), sdW: Math.sqrt(Math.max(0, c2 / k - mw * mw)), count: k };
}

/* turn a wall colour into a mask: colour match, remove thin leaks, keep big areas,
   follow gradual lighting changes, stop at real edges, fill tiny holes */
function refine(st, sL, sU, sW, s, sdU, sdW) {
  const { W, H, sm1 } = st, n = W * H, R1 = sm1.r, G1 = sm1.g, B1 = sm1.b;
  const sU0 = sdU == null ? 3 : sdU, sW0 = sdW == null ? 3 : sdW, k = 0.6 + 0.8 * s;
  const tolL = (8 + 0.2 * sL) * (0.5 + s), tolU = Math.min(14, Math.max(3, 2 + 3 * sU0)) * k, tolW = Math.min(14, Math.max(3, 2 + 3 * sW0)) * k;
  const barrier = new Uint8Array(n), Tedge = 8 + 14 * s;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = (R1[i + 1] + G1[i + 1] + B1[i + 1] - R1[i - 1] - G1[i - 1] - B1[i - 1]) / 3, gy = (R1[i + W] + G1[i + W] + B1[i + W] - R1[i - W] - G1[i - W] - B1[i - W]) / 3;
    if (Math.abs(gx) + Math.abs(gy) > Tedge) barrier[i] = 1;
  }
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (barrier[i]) continue;
    const r = R1[i], g = G1[i], b = B1[i];
    if (Math.abs((r + g + b) / 3 - sL) <= tolL && Math.abs(b - r - sU) <= tolU && Math.abs(g - (r + b) / 2 - sW) <= tolW) m[i] = 255;
  }
  const op = opening(m, W, H);
  const cc = components(op, W, H, 255), res = new Uint8Array(n);
  let largest = 0; for (let k2 = 1; k2 < cc.areas.length; k2++) if (cc.areas[k2] > largest) largest = cc.areas[k2];
  const minA = Math.max(0.003 * n, 0.12 * largest);
  for (let i = 0; i < n; i++) { const l = cc.labels[i]; if (l && cc.areas[l] >= minA) res[i] = 255; }
  {
    const stepL = 4 + 8 * s, stepC = 2.5 + 3 * s, absL = 2.2 * tolL, absU = 2 * tolU, absW = 2 * tolW;
    const q = new Int32Array(n); let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (res[i]) q[qt++] = i;
    while (qh < qt) {
      const p = q[qh++], x = p % W;
      const pr = R1[p], pg = G1[p], pb = B1[p], pL = (pr + pg + pb) / 3, pu = pb - pr, pw = pg - (pr + pb) / 2;
      for (let k2 = 0; k2 < 4; k2++) {
        let j;
        if (k2 === 0) { if (x === 0) continue; j = p - 1; }
        else if (k2 === 1) { if (x === W - 1) continue; j = p + 1; }
        else if (k2 === 2) { j = p - W; if (j < 0) continue; }
        else { j = p + W; if (j >= n) continue; }
        if (res[j] || barrier[j]) continue;
        const r = R1[j], g = G1[j], b = B1[j], L = (r + g + b) / 3, u = b - r, w = g - (r + b) / 2;
        if (Math.abs(L - pL) <= stepL && Math.abs(u - pu) <= stepC && Math.abs(w - pw) <= stepC &&
          Math.abs(L - sL) <= absL && Math.abs(u - sU) <= absU && Math.abs(w - sW) <= absW) { res[j] = 255; q[qt++] = j; }
      }
    }
  }
  const bg = components(res, W, H, 0), holeMax = 0.0006 * n;
  for (let i = 0; i < n; i++) { const l = bg.labels[i]; if (l && !bg.border[l] && bg.areas[l] <= holeMax) res[i] = 255; }
  const add = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (barrier[i] && !res[i] && (res[i - 1] || res[i + 1] || res[i - W] || res[i + W])) add.push(i);
  }
  for (const i of add) res[i] = 255;
  return res;
}

/* ---------- AI mask: tint model + edges + guided filter ---------- */

/* Pieces of wall cut off from the main wall by people or furniture: found by resemblance to the wall
   in ordinary light (Lab colour divided by lightness), similar smoothness, not brighter than the lit wall. */
function extraPieces(st, bin, op, lum, s) {
  const { W, H, sm, ai } = st, n = W * H, t = [0, 0, 0];
  let pmax = 0; for (let i = 0; i < n; i++) if (ai[i] > pmax) pmax = ai[i];
  const ra = [], rb = [], rl = [];
  for (let i = 0; i < n; i += 3) {
    if (!bin[i] || ai[i] < 0.7 * pmax) continue;
    labOf(sm.r[i], sm.g[i], sm.b[i], t); if (t[0] < 6) continue;
    ra.push(t[1] / t[0]); rb.push(t[2] / t[0]); rl.push(t[0]);
  }
  if (rl.length < 100) return;
  const med = a => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  const pct = (a, p) => a[Math.floor(a.length * p)];
  const cA = med(ra), cB = med(rb); rl.sort((x, y) => x - y);
  const lMin = pct(rl, 0.05) * 0.35, lMax = pct(rl, 0.5) * 1.3 + 5;
  const cC = Math.hypot(cA, cB), cH = Math.atan2(cB, cA), hueTol = (12 + 12 * s) * Math.PI / 180, greyTol = 0.07 + 0.06 * s;
  let gw = 0, cw = 0;
  for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) { const i = y * W + x; if (!bin[i]) continue; gw += Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]); cw++; }
  const gMax = Math.max(4, (cw ? gw / cw : 4) * (1.6 + 1.2 * s) + 1.5);
  const rest = new Uint8Array(n); for (let i = 0; i < n; i++) if (op[i] && !bin[i]) rest[i] = 255;
  const cc = components(rest, W, H, 255), L = cc.areas.length;
  const sL = new Float64Array(L), sA = new Float64Array(L), sB = new Float64Array(L), sg = new Float64Array(L), sP = new Float64Array(L), c = new Int32Array(L);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, l = cc.labels[i]; if (!l || cc.areas[l] < 0.0015 * n) continue;
    labOf(sm.r[i], sm.g[i], sm.b[i], t);
    sL[l] += t[0]; sA[l] += t[1]; sB[l] += t[2]; sg[l] += Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]); sP[l] += ai[i]; c[l]++;
  }
  const keep = new Uint8Array(L);
  for (let l = 1; l < L; l++) {
    if (!c[l]) continue;
    const Lm = sL[l] / c[l], g = sg[l] / c[l];
    if (Lm < lMin || Lm > lMax || g > gMax) continue;
    const pa = sA[l] / c[l] / Lm, pb = sB[l] / c[l] / Lm, pc = Math.hypot(pa, pb);
    let dh = Math.abs(Math.atan2(pb, pa) - cH); if (dh > Math.PI) dh = 2 * Math.PI - dh;
    const ok = cC >= 0.1 ? (dh <= hueTol && pc >= 0.5 * cC && pc <= 2.5 * cC) : (Math.hypot(pa - cA, pb - cB) <= greyTol && sP[l] / c[l] >= 0.12 * pmax);
    if (ok) keep[l] = 1;
  }
  for (let i = 0; i < n; i++) { const l = cc.labels[i]; if (l && keep[l]) bin[i] = 255; }
}

/* SAM (whole surfaces) + the tint rule, combined. */
function samCombine(st, bin, barrier, lum, cr, cg, s) {
  const { W, H, sam } = st, n = W * H, g = new Uint8Array(n), q = new Int32Array(n); let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (sam[i] && bin[i]) { g[i] = 255; q[qt++] = i; }
  const stepL = 3 + 6 * s, stepC = 0.012 + 0.012 * s;
  while (qh < qt) {
    const p = q[qh++], x = p % W;
    for (let k = 0; k < 4; k++) {
      let j;
      if (k === 0) { if (x === 0) continue; j = p - 1; }
      else if (k === 1) { if (x === W - 1) continue; j = p + 1; }
      else if (k === 2) { j = p - W; if (j < 0) continue; }
      else { j = p + W; if (j >= n) continue; }
      if (g[j] || !sam[j] || barrier[j]) continue;
      if (Math.abs(lum[j] - lum[p]) <= stepL && Math.abs(cr[j] - cr[p]) <= stepC && Math.abs(cg[j] - cg[p]) <= stepC) { g[j] = 255; q[qt++] = j; }
    }
  }
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!g[i] && sam[i] && (g[i - 1] === 255 || g[i + 1] === 255 || g[i - W] === 255 || g[i + W] === 255)) g[i] = 128;
  }
  for (let i = 0; i < n; i++) if (g[i] === 128) g[i] = 255;
  const rest = new Uint8Array(n); for (let i = 0; i < n; i++) if (sam[i] && !g[i]) rest[i] = 255;
  const cc = components(rest, W, H, 255);
  for (let i = 0; i < n; i++) { const l = cc.labels[i]; if (l && !cc.border[l]) g[i] = 255; }
  const near = dilateBox(sam, W, H, Math.max(4, Math.round(Math.max(W, H) / 100)));
  for (let i = 0; i < n; i++) if (bin[i] && near[i]) g[i] = 255;
  bin.set(g);
}

/* Soft wall mask (0..255) from the AI probability map. Returns null when the AI sees no wall. */
function detectAI(st, s) {
  const { W, H, orig, sm1 } = st, n = W * H, P = st.ai;
  let pmax = 0; for (let i = 0; i < n; i++) if (P[i] > pmax) pmax = P[i];
  if (pmax < 90) return null;
  const cr = new Float32Array(n), cg = new Float32Array(n), lum = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = sm1.r[i] + sm1.g[i] + sm1.b[i] + 1; lum[i] = t / 3; cr[i] = sm1.r[i] / t; cg[i] = sm1.g[i] / t; }
  const conf = 0.7 * pmax;
  let mr = 0, mg = 0, vr = 1, vg = 1, k = 0;
  for (let it = 0; it < 4; it++) {
    let a = 0, b = 0, aa = 0, bq = 0; k = 0;
    for (let i = 0; i < n; i++) {
      if (P[i] < conf || lum[i] < 15) continue;
      const dr = cr[i] - mr, dg = cg[i] - mg;
      if (it > 0 && (dr * dr / vr + dg * dg / vg) > 6.25) continue;
      a += cr[i]; b += cg[i]; aa += cr[i] * cr[i]; bq += cg[i] * cg[i]; k++;
    }
    if (k < 50) return null;
    mr = a / k; mg = b / k;
    vr = Math.max(aa / k - mr * mr, 2.5e-5); vg = Math.max(bq / k - mg * mg, 2.5e-5);
  }
  const ls = [];
  for (let i = 0; i < n; i += 3) { if (P[i] < conf) continue; const dr = cr[i] - mr, dg = cg[i] - mg; if (dr * dr / vr + dg * dg / vg <= 6.25) ls.push(lum[i]); }
  ls.sort((x, y) => x - y);
  const lLo = ls[Math.floor(ls.length * 0.03)] * 0.55, lHi = Math.min(250, ls[Math.floor(ls.length * 0.97)] * 1.5 + 10);
  const Tedge = 12 + 14 * s, barrier = new Uint8Array(n);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = lum[i + 1] - lum[i - 1], gy = lum[i + W] - lum[i - W];
    const cx = (cr[i + 1] - cr[i - 1]) * lum[i] * 3, cy = (cg[i + W] - cg[i - W]) * lum[i] * 3;
    if (Math.abs(gx) + Math.abs(gy) + 0.5 * (Math.abs(cx) + Math.abs(cy)) > Tedge) barrier[i] = 1;
  }
  const kk = 2.5 + 2.5 * s;
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (barrier[i] || lum[i] < lLo || lum[i] > lHi) continue;
    const noise = Math.pow(1.5 / (lum[i] * 3), 2);
    const dr = cr[i] - mr, dg = cg[i] - mg;
    if (dr * dr / (vr + noise) + dg * dg / (vg + noise) <= kk * kk) cand[i] = 255;
  }
  const op = opening(cand, W, H);
  const seedT = 0.35 * pmax, stepL = 2.5 + 6 * s;
  const bin = new Uint8Array(n), q0 = new Int32Array(n); let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (op[i] && P[i] >= seedT) { bin[i] = 255; q0[qt++] = i; }
  while (qh < qt) {
    const p = q0[qh++], x = p % W, L = lum[p];
    for (let k2 = 0; k2 < 4; k2++) {
      let j;
      if (k2 === 0) { if (x === 0) continue; j = p - 1; }
      else if (k2 === 1) { if (x === W - 1) continue; j = p + 1; }
      else if (k2 === 2) { j = p - W; if (j < 0) continue; }
      else { j = p + W; if (j >= n) continue; }
      if (bin[j] || !op[j]) continue;
      if (Math.abs(lum[j] - L) <= stepL) { bin[j] = 255; q0[qt++] = j; }
    }
  }
  {
    const cc = components(bin, W, H, 255), L = cc.areas.length, lsum = new Float64Array(L);
    for (let i = 0; i < n; i++) { const l = cc.labels[i]; if (l) lsum[l] += lum[i]; }
    let big = 0; for (let l = 1; l < L; l++) if (!big || cc.areas[l] > cc.areas[big]) big = l;
    const bl = []; for (let i = 0; i < n; i += 2) if (big && cc.labels[i] === big) bl.push(lum[i]);
    bl.sort((a, b) => a - b);
    const lo = bl.length ? bl[Math.floor(bl.length * 0.05)] * 0.9 - 4 : 0, hi = bl.length ? bl[Math.floor(bl.length * 0.95)] * 1.1 + 4 : 0;
    const keep = new Uint8Array(L);
    for (let l = 1; l < L; l++) { const A = cc.areas[l], m = lsum[l] / A; keep[l] = l === big || (A >= 0.002 * n && m >= lo && m <= hi) ? 1 : 0; }
    for (let i = 0; i < n; i++) { const l = cc.labels[i]; if (l && !keep[l]) bin[i] = 0; }
  }
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!bin[i] && barrier[i] && (bin[i - 1] === 255 || bin[i + 1] === 255 || bin[i - W] === 255 || bin[i + W] === 255)) bin[i] = 128;
  }
  for (let i = 0; i < n; i++) if (bin[i] === 128) bin[i] = 255;
  if (st.sam) samCombine(st, bin, barrier, lum, cr, cg, s);
  extraPieces(st, bin, op, lum, s);
  const bg = components(bin, W, H, 0), holeMax = 0.0005 * n;
  for (let i = 0; i < n; i++) { const l = bg.labels[i]; if (l && !bg.border[l] && bg.areas[l] <= holeMax) bin[i] = 255; }
  const I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], p = new Float32Array(n);
  for (let i = 0; i < n; i++) { I[0][i] = orig[i * 4] / 255; I[1][i] = orig[i * 4 + 1] / 255; I[2][i] = orig[i * 4 + 2] / 255; p[i] = bin[i] / 255; }
  const q = guidedFilter(I, p, W, H, Math.max(2, Math.round(Math.max(W, H) / 320)), 2e-3);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const a = (q[i] - 0.5) * 1.6 + 0.5; out[i] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255); }
  return out;
}

/* binary mask -> soft edges by "unmixing" each edge pixel between the nearby wall and non-wall colours */
export function hardAlpha(W, H, orig, bin) {
  const n = W * H;
  const band = new Uint8Array(n), band2 = new Uint8Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, v = bin[i];
    if ((x > 0 && bin[i - 1] !== v) || (x < W - 1 && bin[i + 1] !== v) || (y > 0 && bin[i - W] !== v) || (y < H - 1 && bin[i + W] !== v)) band[i] = 1;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!band[i]) continue;
    band2[i] = 1; if (x > 0) band2[i - 1] = 1; if (x < W - 1) band2[i + 1] = 1; if (y > 0) band2[i - W] = 1; if (y < H - 1) band2[i + W] = 1;
  }
  const soft = boxBlur(bin, W, H, 1), alpha = new Uint8Array(n);
  alpha.set(bin);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!band2[i]) continue;
    let wr = 0, wg = 0, wb = 0, wc = 0, or = 0, og = 0, ob = 0, oc = 0;
    for (let yy = Math.max(0, y - 3); yy <= Math.min(H - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(W - 1, x + 3); xx++) {
      const j = yy * W + xx; if (band2[j]) continue;
      const o = j * 4;
      if (bin[j]) { wr += orig[o]; wg += orig[o + 1]; wb += orig[o + 2]; wc++; }
      else { or += orig[o]; og += orig[o + 1]; ob += orig[o + 2]; oc++; }
    }
    let a = soft[i];
    if (wc >= 3 && oc >= 3) {
      wr /= wc; wg /= wc; wb /= wc; or /= oc; og /= oc; ob /= oc;
      const dr = wr - or, dg = wg - og, db = wb - ob, den = dr * dr + dg * dg + db * db;
      if (den > 400) {
        const o = i * 4;
        const tt = ((orig[o] - or) * dr + (orig[o + 1] - og) * dg + (orig[o + 2] - ob) * db) / den;
        a = Math.max(0, Math.min(1, tt)) * 255;
      }
    }
    alpha[i] = a;
  }
  return alpha;
}

/** One detection at sensitivity s (0..1). Returns {mask, soft}: soft masks come from the AI path (already 0..255),
 *  hard masks (0/255) from the colour path. */
export function detect(st, s) {
  const n = st.W * st.H;
  if (st.ai) { const m = detectAI(st, s); return { mask: m || new Uint8Array(n), soft: true, viaAI: true }; }
  const c = findCenter(st, { uMin: -3 - 12 * s, smooth: true, top: true });
  if (!c) return { mask: new Uint8Array(n), soft: false, viaAI: false };
  return { mask: refine(st, c.sL, c.sU, c.sW, s, c.sdU, c.sdW), soft: false, viaAI: false };
}

/** Raise the sensitivity until a reasonable wall area is found. Returns the final alpha (soft, 0..255), sensitivity and coverage. */
export function autoTune(st) {
  let sens = 0.4, r = null;
  for (const cand of [0.4, 0.6, 0.8, 1.0]) {
    sens = cand; r = detect(st, cand);
    if (coverageOf(r.mask) >= 0.04) break;
  }
  const alpha = r.soft ? r.mask : hardAlpha(st.W, st.H, st.orig, r.mask);
  let cov = 0; for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 128) cov++;
  return { alpha, sens, cover: cov / alpha.length, viaAI: r.viaAI };
}

/* ---------- SAM helpers ---------- */
export function aiMax(P) { let pmax = 0; for (let i = 0; i < P.length; i++) if (P[i] > pmax) pmax = P[i]; return pmax; }
export const AI_MIN = 90;   // below this peak probability the AI "sees no wall"

/** Up to 16 points (one per 4x4 cell) where the AI is sure there is wall. */
export function samPoints(P, W, H) {
  const pmax = aiMax(P), pts = [];
  if (pmax < AI_MIN) return pts;
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
    let best = -1, bx = 0, by = 0;
    for (let y = Math.floor(gy * H / 4) + 3; y < Math.floor((gy + 1) * H / 4) - 3; y += 3) for (let x = Math.floor(gx * W / 4) + 3; x < Math.floor((gx + 1) * W / 4) - 3; x += 3) { const p = P[y * W + x]; if (p > best) { best = p; bx = x; by = y; } }
    if (best >= 0.75 * pmax) pts.push([bx, by]);
  }
  return pts;
}

/** Index map from a W*H image to a mw*mh mask (nearest), or null when the sizes match. */
function maskMap(W, H, mw, mh) {
  if (mw === W && mh === H) return null;
  const map = new Int32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) map[y * W + x] = Math.min(mh - 1, Math.floor(y * mh / H)) * mw + Math.min(mw - 1, Math.floor(x * mw / W));
  return map;
}

/** For each point keep, among SAM's k proposals, the one agreeing best with the AI map; union of the winners (0/255). */
export function samUnion(r, pts, P, W, H) {
  const n = W * H, pmax = aiMax(P), { w: mw, h: mh, k, data: md } = r, union = new Uint8Array(n), map = maskMap(W, H, mw, mh);
  for (let p = 0; p < pts.length; p++) {
    let bestK = -1, bestS = 0;
    for (let c = 0; c < k; c++) {
      const off = (p * k + c) * mw * mh; let sc = 0;
      for (let i = 0; i < n; i += 3) { if (md[off + (map ? map[i] : i)]) sc += P[i] / pmax - 0.45; }
      if (sc > bestS) { bestS = sc; bestK = c; }
    }
    if (bestK < 0) continue;
    const off = (p * k + bestK) * mw * mh;
    for (let i = 0; i < n; i++) if (md[off + (map ? map[i] : i)]) union[i] = 255;
  }
  return union;
}

/** For one clicked point: the proposal with the best IoU score, as a 0/255 mask at W*H. */
export function samBest(r, W, H) {
  const n = W * H, { w: mw, h: mh, k, data: md, scores } = r, map = maskMap(W, H, mw, mh), out = new Uint8Array(n);
  let bestK = 0; for (let c = 1; c < k; c++) if (scores[c] > scores[bestK]) bestK = c;
  const off = bestK * mw * mh;
  for (let i = 0; i < n; i++) if (md[off + (map ? map[i] : i)]) out[i] = 255;
  return out;
}
