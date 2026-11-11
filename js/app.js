// Wall Recolor: page logic. Photos are opened, analysed and exported in the worker (js/worker.js).

import { DEFAULT_COLOR, parseColor, colorSlug } from './color.js';
import { boxBlur } from './imgproc.js';
import { wallRef, renderParams, recolor } from './recolor.js';
import { makeZip } from './zip.js';
import { initialLang, translate } from './i18n.js';
import { createAnalysisAnim } from './anim.js';

const MAXWORK = 1280;                  // longest side used for detection + preview
const MAXPIX = 50e6, MAXSIDE = 16384;  // export limits (browser canvas limits)
const UNDO_MAX = 30;
const ADJ0 = { op: 100, sat: 0, light: 0, contrast: 0 };
const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
};

/* ---------- language ---------- */
let lang = initialLang(store.get('wr-lang'));
const t = (k, v) => translate(lang, k, v);
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  $('colIn').placeholder = t('colorPlaceholder');
  showColor(); updateStatus(); updateAiChip(); updateNav(); drawCarousel(false); setPos(pos);
}
document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
  lang = b.dataset.lang; store.set('wr-lang', lang); applyLang();
}));

/* ---------- target colour ---------- */
let target = DEFAULT_COLOR;
{
  const fromUrl = parseColor(new URLSearchParams(location.search).get('color')), saved = parseColor(store.get('wr-color'));
  if (fromUrl) target = fromUrl; else if (saved) target = saved;
}
const colorLabel = () => target.name ? 'Pantone ' + target.name : target.hex;
function showColor() {
  const c = target;
  document.documentElement.style.setProperty('--target', c.hex);
  $('colName').textContent = colorLabel();
  $('colDesc').textContent = c.hex + ' · RGB ' + c.rgb.join(' · ') + ' — ' + t('colorNote');
}
function setColor(c) {
  target = c; store.set('wr-color', c.name || c.hex); showColor(); anim.setTarget(c.rgb);
  if (S) { render(); }
  for (const p of photos) p.thumbStale = true;
  scheduleThumbs(0);
}
$('colForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('colIn'), c = parseColor(inp.value);
  if (!c) { inp.setAttribute('aria-invalid', 'true'); banner(t('colorBad')); return; }
  inp.removeAttribute('aria-invalid'); inp.value = '';
  setColor(c);
});
$('colIn').addEventListener('input', () => $('colIn').removeAttribute('aria-invalid'));

/* ---------- worker ---------- */
const AI = { state: 'loading', p: 0 };
const isLocal = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const calls = new Map(); let ridN = 0, samPending = null;      // requests answered by the worker: open, export
function callWorker(msg, transfer, onProgress) {
  return new Promise((res, rej) => {
    const id = 'r' + (++ridN);
    calls.set(id, { res, rej, onProgress });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}
function settle(id, value, err) {
  const x = calls.get(id); if (!x) return;
  calls.delete(id);
  if (err) x.rej(err); else x.res(value);
}
const workerError = m => Object.assign(new Error(m.message), { code: m.code });
worker.onmessage = e => {
  const m = e.data;
  switch (m.type) {
    case 'opened': settle(m.id, m); break;
    case 'ai': AI.state = m.state; AI.p = m.p; updateAiChip(); updateStatus(); break;
    case 'analyzing': { const ph = byId(m.id); if (ph && ph.status === 'pending') { ph.prog = Math.max(ph.prog, m.p); if (S && S.ph === ph) updateStatus(); } break; }
    case 'analyzed': onAnalyzed(m); break;
    case 'samMask': onSamMask(m, null); break;
    case 'progress': { const x = calls.get(m.id); if (x && x.onProgress) x.onProgress(m.p); break; }
    case 'exported': settle(m.id, m.blob); break;
    case 'error':
      if (m.kind === 'analyze') onAnalyzeError(m);
      else if (m.kind === 'sam') onSamMask(m, m.message);
      else settle(m.id, null, workerError(m));                   // open, export
      break;
  }
};
worker.onerror = () => {
  AI.state = 'off'; updateAiChip();
  for (const id of [...calls.keys()]) settle(id, null, new Error('worker'));
  for (const p of photos) if (p.status === 'pending') { p.status = 'error'; p.error = 'analyze'; }
  drawCarousel(false); updateNav(); updateStatus();
  banner(t('errAnalyze'));
};
worker.postMessage({ type: 'init', local: isLocal });
function updateAiChip() {
  const el = $('aiChip'); el.dataset.state = AI.state;
  el.textContent = AI.state === 'ready' ? t('aiReady') : (AI.state === 'off' ? t('aiOff') : t('aiLoading', { p: AI.p }));
}

/* ---------- state ---------- */
let S = null;                       // working state of the photo shown on screen
let photos = [], cur = -1, nextId = 1;
let mode = 'compare', tool = 'add', pos = 50, hlOn = false;
const cvRes = $('cvRes'), cvOrig = $('cvOrig'), stage = $('stage');
const anim = createAnalysisAnim($('cvAnim'));
let fmt = 'jpg';
const byId = id => photos.find(p => p.id === id);

/* ---------- photos ---------- */
const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
const isImageFile = f => /^image\//.test(f.type) || isHeic(f) || /\.(tiff?|psd)$/i.test(f.name);   // PSD often has no image/ type
const OPEN_ERRORS = { heic: 'errHeic', psdFlat: 'errPsdFlat', depth32: 'errDepth', lib: 'errLib' };
/* The worker decodes the file (any format, see decode.js) and returns the sRGB working copy plus the file's
   format, bit depth and colour profile. */
async function makePhoto(file) {
  const { orig, W, H, nw, nh, fmt, depth, profile } = await callWorker({ type: 'open', file, maxWork: MAXWORK });
  const k = Math.min(1, Math.sqrt(MAXPIX / (nw * nh)), MAXSIDE / Math.max(nw, nh));
  const fw = Math.max(1, Math.round(nw * k)), fh = Math.max(1, Math.round(nh * k));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(orig, W, H), 0, 0);
  const thumb = thumbOf(c);
  c.width = c.height = 1;
  return {
    id: nextId++, file, name: file.name.replace(/\.[^.]+$/, ''), fmt, depth, profile, nw, nh, fw, fh, W, H, orig, thumb, thumbStale: false,
    status: 'pending', prog: 0, error: null, base: null, sens: 0.4, cover: 0, viaAI: false,
    edits: new Uint8Array(2 * W * H), undo: [], redo: [], adj: { ...ADJ0 }
  };
}
async function addFiles(list) {
  const files = [...list].filter(isImageFile);
  if (!files.length) { banner(t('errType')); return; }
  for (const f of files) {
    try {
      const ph = await makePhoto(f);
      photos.push(ph);
      showStudio(true);
      drawCarousel(false); updateNav();
      if (cur < 0) activate(photos.length - 1);
      worker.postMessage({ type: 'analyze', id: ph.id, orig: ph.orig, W: ph.W, H: ph.H });
      if (ph.profile && !ph.profile.kept) banner(t('profileLost', { name: ph.profile.name, file: f.name }));
    } catch (e) { banner(t(OPEN_ERRORS[e.code] || (isHeic(f) ? 'errHeic' : 'errOpen')) + ' (' + f.name + ')'); }
  }
}
function onAnalyzed(m) {
  const ph = byId(m.id); if (!ph) return;
  ph.base = m.alpha; ph.sens = m.sens; ph.cover = m.cover; ph.viaAI = m.viaAI; ph.status = 'ready'; ph.prog = 100; ph.thumbStale = true;
  if (S && S.ph === ph) { schedule(); updateTools(); anim.finish(cvRes); }
  scheduleThumbs(0); drawCarousel(false); updateNav();
}
function onAnalyzeError(m) {
  const ph = byId(m.id); if (!ph) return;
  ph.status = 'error'; ph.error = 'analyze';
  if (S && S.ph === ph) { anim.stop(); updateStatus(); updateTools(); }
  drawCarousel(false); updateNav(); banner(t('errAnalyze') + ' (' + ph.name + ')');
}

/* final mask = detected mask, overridden by the touch-ups by their weight */
function blendInto(ph, alpha, x0, y0, x1, y1) {
  const { W, H, edits, base } = ph, n = W * H;
  for (let y = y0; y <= y1; y++) {
    const row = y * W;
    for (let i = row + x0; i <= row + x1; i++) { const w = edits[i], b = base ? base[i] : 0; alpha[i] = w ? ((b * (255 - w) + edits[n + i] * w + 127) / 255) | 0 : b; }
  }
}
function activate(i) {
  const ph = photos[i]; if (!ph) return;
  cur = i;
  const { W, H } = ph;
  S = { ph, W, H, orig: ph.orig, alpha: new Uint8Array(W * H), out: new ImageData(W, H), ref: null, cover: 0 };
  cvOrig.width = W; cvOrig.height = H; cvRes.width = W; cvRes.height = H;
  cvOrig.getContext('2d').putImageData(new ImageData(ph.orig, W, H), 0, 0);
  fitStage(); shownProg = 0;
  compose(); render(); updateStatus();
  if (ph.status === 'pending') anim.start(cvOrig, target.rgb); else anim.stop();
  setFmt(ph.fmt === 'psd' ? 'psd' : (ph.fmt === 'png' || ph.fmt === 'tiff') ? 'png' : 'jpg');   // lossless sources stay lossless
  showAdj(); updateTools();
  $('cursor').style.display = 'none';
  resetView();
  drawCarousel(true); updateNav();
}
function compose() {
  const { W, H, alpha } = S, n = W * H;
  blendInto(S.ph, alpha, 0, 0, W - 1, H - 1);
  S.ref = wallRef(W, H, S.orig, alpha);
  let cov = 0; for (let i = 0; i < n; i++) if (alpha[i] >= 128) cov++;
  S.cover = cov / n;
}
function render() { renderRect(cvRes, hlOn, 0, 0, S.W - 1, S.H - 1); }
function renderRect(cv, hl, x0, y0, x1, y1) {
  const { W, orig, alpha, out } = S, P = renderParams(S.ref, target.rgb, S.ph.adj);
  for (let y = y0; y <= y1; y++) recolor(orig, out.data, alpha, y * W + x0, y * W + x1 + 1, P, hl);
  cv.getContext('2d').putImageData(out, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}
let pending = false;
function schedule() {
  if (pending) return; pending = true;
  requestAnimationFrame(() => {
    pending = false; if (!S) return;
    compose(); render(); updateStatus();
    S.ph.thumbStale = true; scheduleThumbs(500);
  });
}
function go(d) { for (let j = cur + d; j >= 0 && j < photos.length; j += d) { if (photos[j].status !== 'error') { activate(j); return; } } }
function removePhoto(ph) {
  const i = photos.indexOf(ph); if (i < 0) return;
  photos.splice(i, 1);
  worker.postMessage({ type: 'drop', id: ph.id });
  if (!photos.length) {
    S = null; cur = -1; anim.stop(); showStudio(false); drawCarousel(false); updateNav(); updateStatus(); updateTools(); return;
  }
  if (i === cur) {
    cur = -1; S = null;
    let j = photos.findIndex((p, k) => k >= i && p.status !== 'error');
    if (j < 0) { for (let k = Math.min(i, photos.length) - 1; k >= 0; k--) if (photos[k].status !== 'error') { j = k; break; } }
    if (j < 0) j = Math.min(i, photos.length - 1);
    activate(j); return;
  } else if (i < cur) cur--;
  drawCarousel(false); updateNav();
}

/* ---------- thumbnails ---------- */
function thumbOf(src) {
  const sc = Math.min(1, 200 / Math.max(src.width, src.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * sc)); c.height = Math.max(1, Math.round(src.height * sc));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
function renderThumb(ph) {
  const { W, H } = ph, n = W * H;
  if (S && S.ph === ph && !hlOn) ph.thumb = thumbOf(cvRes);
  else {
    const alpha = new Uint8Array(n); blendInto(ph, alpha, 0, 0, W - 1, H - 1);
    const out = new ImageData(W, H);
    recolor(ph.orig, out.data, alpha, 0, n, renderParams(wallRef(W, H, ph.orig, alpha), target.rgb, ph.adj), false);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    c.getContext('2d').putImageData(out, 0, 0);
    ph.thumb = thumbOf(c); c.width = c.height = 1;
  }
  ph.thumbStale = false;
  const img = $('strip').querySelector('.thumb[data-id="' + ph.id + '"] img'); if (img) img.src = ph.thumb;
}
let thumbTimer = 0;
function scheduleThumbs(delay) {          // one stale thumbnail at a time, current photo first
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const list = photos.filter(p => p.thumbStale && p.status === 'ready');
    if (!list.length) return;
    const ph = (S && list.includes(S.ph)) ? S.ph : list[0];
    renderThumb(ph);
    if (list.length > 1) scheduleThumbs(40);
  }, delay);
}

/* ---------- layout: drop zone vs photo, photo fitted into the free space ---------- */
function showStudio(on) {
  $('drop').hidden = on; stage.hidden = !on; $('strip').hidden = !on;
}
function fitStage() {
  if (!S) return;
  const box = $('stageBox'), bw = box.clientWidth, bh = box.clientHeight;
  if (!bw || !bh) return;
  const k = Math.min(bw / S.W, bh / S.H);
  stage.style.width = Math.max(1, Math.floor(S.W * k)) + 'px'; stage.style.height = Math.max(1, Math.floor(S.H * k)) + 'px';
  clampView(); applyView();
}

/* ---------- status (footer), title row, carousel, navigation ---------- */
const STAGES = [3, 40, 80, 90, 99];          // worker progress steps; the bar creeps toward the next one
let shownProg = 0, progTimer = 0;
const nextStage = p => STAGES.find(v => v > p) || 99;
function showProgress() {
  const p = Math.floor(shownProg);
  $('status').textContent = t('statusAnalysing', { p });
  $('prog').firstElementChild.style.width = p + '%';
}
function tickProgress() {
  clearTimeout(progTimer);
  const ph = S && S.ph;
  if (!ph || ph.status !== 'pending' || !ph.prog || (AI.state === 'loading' && ph.prog < 40)) return;
  if (shownProg < ph.prog) shownProg = ph.prog;
  else shownProg += (nextStage(ph.prog) - 1 - shownProg) * 0.04;
  showProgress();
  progTimer = setTimeout(tickProgress, 250);
}
function profileLabel(ph) {
  if (!ph.profile) return t('profileNone');
  return ph.profile.kept ? ph.profile.name : t('profileToSrgb', { name: ph.profile.name });
}
function updateStatus() {
  const el = $('status'), bar = $('prog');
  bar.hidden = true; clearTimeout(progTimer);
  if (!S) { el.textContent = ''; $('photoName').textContent = t('subtitle'); $('info').textContent = ''; return; }
  const ph = S.ph;
  $('photoName').textContent = ph.name;
  const size = (ph.fw !== ph.nw || ph.fh !== ph.nh) ? t('infoScaled', { w: ph.nw, h: ph.nh, fw: ph.fw, fh: ph.fh }) : t('info', { w: ph.nw, h: ph.nh });
  $('info').textContent = [t('photoOf', { i: cur + 1, n: photos.length }), size, profileLabel(ph)].concat(ph.depth > 8 ? [t('depthTo8', { b: ph.depth })] : []).join(' · ');
  if (ph.status === 'error') el.textContent = t('statusError');
  else if (ph.status !== 'ready') {
    if (!ph.prog) { shownProg = 0; el.textContent = AI.state === 'loading' ? t('statusWaitAI') : t('statusWait'); }
    else if (AI.state === 'loading' && ph.prog < 40) el.textContent = t('statusWaitAI');
    else { bar.hidden = false; shownProg = Math.max(shownProg, ph.prog); showProgress(); tickProgress(); }
  } else {
    const p = (S.cover * 100).toFixed(1);
    el.textContent = (S.cover < 0.005 ? t('statusNone') : t('statusFound', { p: lang === 'en' ? p : p.replace('.', ',') }))
      + ' · ' + (ph.viaAI ? t('viaAI') : t('viaBasic'));
  }
}
function updateTools() {
  const ready = !!(S && S.ph.status === 'ready');
  for (const id of ['tAdd', 'tErase', 'tPick', 'tRemove', 'bUndo', 'bRedo', 'bPeek', 'bReset', 'aReset', 'dl']) $(id).disabled = !ready;
  for (const id of ['bsize', 'bhard', 'aOp', 'aSat', 'aLight', 'aCon']) $(id).disabled = !ready;
  if (S) { $('bUndo').disabled = !ready || !S.ph.undo.length; $('bRedo').disabled = !ready || !S.ph.redo.length; }
}
function drawCarousel(scroll) {
  const strip = $('strip'), focusInside = strip.contains(document.activeElement);
  strip.textContent = '';
  photos.forEach(ph => {
    const wrap = document.createElement('div'); wrap.className = 'thumbWrap';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'thumb'; b.dataset.id = ph.id; b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(photos[cur] === ph));
    const label = ph.name + (ph.status === 'error' ? ' — ' + t('statusError') : '');
    b.title = label; b.setAttribute('aria-label', label);
    const im = document.createElement('img'); im.src = ph.thumb; im.alt = ''; b.appendChild(im);
    const st = document.createElement('span'); st.className = 'st ' + ph.status; b.appendChild(st);
    b.addEventListener('click', () => activate(photos.indexOf(ph)));
    wrap.appendChild(b);
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'rm'; rm.textContent = '×';
    rm.setAttribute('aria-label', t('remove') + ': ' + ph.name); rm.title = t('remove');
    rm.addEventListener('click', ev => { ev.stopPropagation(); removePhoto(ph); });
    wrap.appendChild(rm);
    strip.appendChild(wrap);
  });
  const add = document.createElement('button'); add.type = 'button'; add.className = 'thumb add'; add.textContent = '+';
  add.setAttribute('aria-label', t('newPhoto')); add.title = t('newPhoto'); add.addEventListener('click', () => fileIn.click());
  strip.appendChild(add);
  const sel = strip.children[cur];
  if (sel && scroll) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (sel && focusInside) sel.firstElementChild.focus({ preventScroll: true });
}
function updateNav() {
  const usable = photos.filter(p => p.status !== 'error').length, ready = photos.filter(p => p.status === 'ready').length, work = photos.filter(p => p.status === 'pending').length;
  $('prev').hidden = $('next').hidden = usable < 2;
  $('batchInfo').textContent = work && photos.length > 1 ? t('batchWorking', { d: photos.length - work, n: photos.length }) : '';
  updateStatus();
  const all = $('dlAll'); all.hidden = ready < 2; all.textContent = t('downloadAll', { n: ready });
}

/* ---------- busy overlay, banner ---------- */
function busy(msg, progress) {
  const o = $('busy'); if (msg === false) { o.hidden = true; return; }
  o.hidden = false; $('busyTxt').textContent = msg;
  const bar = $('busyBar'); bar.hidden = progress == null;
  if (progress != null) bar.firstElementChild.style.width = progress + '%';
}
let bannerTimer = 0;
function banner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = false; clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { b.hidden = true; }, 7000); }

/* ---------- export (rendered in the worker at full size) ---------- */
function alphaOf(ph) {
  const { W, H } = ph;
  if (S && S.ph === ph) return { alpha: S.alpha.slice(), ref: S.ref };
  const alpha = new Uint8Array(W * H); blendInto(ph, alpha, 0, 0, W - 1, H - 1);
  return { alpha, ref: wallRef(W, H, ph.orig, alpha) };
}
function requestExport(ph, fmt, onProgress) {
  const { alpha, ref } = alphaOf(ph), names = { original: t('layerOriginal'), wall: t('layerWall', { c: colorLabel() }) };
  return callWorker({ type: 'export', file: ph.file, W: ph.W, H: ph.H, fw: ph.fw, fh: ph.fh, alpha, ref, target: target.rgb, adj: ph.adj, fmt, names },
    [alpha.buffer], onProgress);
}
function downloadBlob(blob, filename) {
  const a = document.createElement('a'), u = URL.createObjectURL(blob);
  a.href = u; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 15000);
}
function setFmt(f) { fmt = f; document.querySelectorAll('[data-fmt]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fmt === f))); }
document.querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => setFmt(b.dataset.fmt)));
const outName = (ph, fmt) => ph.name + '-' + colorSlug(target) + '.' + fmt;     // fmt is also the extension: jpg, png, psd
async function exportCurrent() {
  if (!S || S.ph.status !== 'ready') return;
  const ph = S.ph;
  busy(t('exporting', { p: 0 }), 0);
  try {
    const blob = await requestExport(ph, fmt, p => busy(t('exporting', { p }), p));
    downloadBlob(blob, outName(ph, fmt));
    busy(false);
  } catch (e) { busy(false); banner(t('errExport')); }
}
async function exportAll() {
  const list = photos.filter(p => p.status === 'ready'); if (!list.length) return;
  const entries = [], used = new Set();
  try {
    for (let k = 0; k < list.length; k++) {
      const ph = list[k];
      busy(t('exportingN', { i: k + 1, n: list.length, p: 0 }), k / list.length * 100);
      const blob = await requestExport(ph, fmt, p => busy(t('exportingN', { i: k + 1, n: list.length, p }), (k + p / 100) / list.length * 100));
      const base = ph.name + '-' + colorSlug(target); let nm = base + '.' + fmt, c = 2;
      while (used.has(nm)) { nm = base + '-' + c + '.' + fmt; c++; }
      used.add(nm); entries.push({ name: nm, blob });
    }
    busy(t('zipping'));
    downloadBlob(await makeZip(entries), 'wall-recolor-' + colorSlug(target) + '.zip');
    busy(false);
  } catch (e) { busy(false); banner(t('errExport')); }
}

/* ---------- view modes ---------- */
function setPos(p) {
  pos = Math.max(0, Math.min(100, p));
  cvOrig.style.clipPath = 'inset(0 ' + (100 - pos) + '% 0 0)';
  $('divider').style.left = pos + '%';
  const r = Math.round(pos);
  stage.setAttribute('aria-valuenow', String(r));
  stage.setAttribute('aria-valuetext', t('compareValue', { p: r, q: 100 - r }));
}
function setMode(m) {
  mode = m;
  stage.classList.toggle('compare', m === 'compare'); stage.classList.toggle('touch', m === 'touch');
  stage.classList.toggle('pick', m === 'touch' && isPick());
  $('mCompare').setAttribute('aria-pressed', String(m === 'compare'));
  $('mTouch').setAttribute('aria-pressed', String(m === 'touch'));
  $('touchCard').hidden = m !== 'touch';
  $('zoomBar').hidden = m !== 'touch';
  if (m === 'touch') stage.removeAttribute('role'); else { stage.setAttribute('role', 'slider'); resetView(); peek(false); }
  $('cursor').style.display = 'none';
}
$('mCompare').onclick = () => setMode('compare');
$('mTouch').onclick = () => setMode('touch');
$('hl').onchange = e => { hlOn = e.target.checked; if (S) render(); };
const isBrush = () => tool === 'add' || tool === 'erase';
const isPick = () => tool === 'pick' || tool === 'remove';
function setTool(b) {
  tool = b;
  for (const [id, name] of [['tAdd', 'add'], ['tErase', 'erase'], ['tPick', 'pick'], ['tRemove', 'remove']]) $(id).setAttribute('aria-pressed', String(b === name));
  stage.classList.toggle('pick', isPick());
  $('cursor').style.display = 'none';
}
$('tAdd').onclick = () => setTool('add');
$('tErase').onclick = () => setTool('erase');
$('tPick').onclick = () => setTool('pick');
$('tRemove').onclick = () => setTool('remove');

/* ---------- undo / redo: snapshots of the edited rectangle only ---------- */
function snapshot(ph, buf, x0, y0, x1, y1) {
  const { W, H } = ph, n = W * H, w = x1 - x0 + 1, h = y1 - y0 + 1, data = new Uint8Array(2 * w * h);
  for (let y = y0; y <= y1; y++) {
    const row = y * W, k = (y - y0) * w;
    data.set(buf.subarray(row + x0, row + x1 + 1), k);
    data.set(buf.subarray(n + row + x0, n + row + x1 + 1), w * h + k);
  }
  return { x0, y0, x1, y1, w, h, data };
}
function restore(ph, e) {
  const { W, H, edits } = ph, n = W * H;
  for (let y = e.y0; y <= e.y1; y++) {
    const row = y * W, k = (y - e.y0) * e.w;
    edits.set(e.data.subarray(k, k + e.w), row + e.x0);
    edits.set(e.data.subarray(e.w * e.h + k, e.w * e.h + k + e.w), n + row + e.x0);
  }
}
function pushUndo(ph, entry) { ph.undo.push(entry); if (ph.undo.length > UNDO_MAX) ph.undo.shift(); ph.redo.length = 0; updateTools(); }
function undo() {
  if (!S) return; const ph = S.ph, e = ph.undo.pop(); if (!e) return;
  ph.redo.push(snapshot(ph, ph.edits, e.x0, e.y0, e.x1, e.y1)); restore(ph, e); schedule(); updateTools();
}
function redo() {
  if (!S) return; const ph = S.ph, e = ph.redo.pop(); if (!e) return;
  ph.undo.push(snapshot(ph, ph.edits, e.x0, e.y0, e.x1, e.y1)); restore(ph, e); schedule(); updateTools();
}
$('bUndo').onclick = undo;
$('bRedo').onclick = redo;
$('bReset').onclick = () => { if (!S) return; const ph = S.ph; pushUndo(ph, snapshot(ph, ph.edits, 0, 0, ph.W - 1, ph.H - 1)); ph.edits.fill(0); schedule(); };

/* ---------- peek at the original ---------- */
function peek(on) { stage.classList.toggle('peek', !!on && mode === 'touch'); }
for (const ev of ['pointerdown']) $('bPeek').addEventListener(ev, () => peek(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('bPeek').addEventListener(ev, () => peek(false));

/* ---------- brush: one stroke = the strongest coverage each pixel received, applied over the state before it ---------- */
let strokeBase = null, strokeA = null, strokeT = 255, strokeRect = null, dirty = null, flushPending = false, stroking = false;
function beginStroke() {
  const n = S.W * S.H;
  if (!strokeBase || strokeBase.length !== 2 * n) strokeBase = new Uint8Array(2 * n);
  strokeBase.set(S.ph.edits);
  if (!strokeA || strokeA.length !== n) strokeA = new Uint8Array(n); else strokeA.fill(0);
  strokeT = tool === 'add' ? 255 : 0; strokeRect = null; stroking = true;
}
function endStroke() {
  if (!stroking) return; stroking = false;
  flushDirty();
  if (strokeRect) { const r = strokeRect; pushUndo(S.ph, snapshot(S.ph, strokeBase, r.x0, r.y0, r.x1, r.y1)); }
  schedule();
}
function cancelStroke() { if (!stroking) return; stroking = false; S.ph.edits.set(strokeBase); dirty = null; schedule(); }
function dab(cx, cy, r) {
  const { W, H } = S, edits = S.ph.edits, n = W * H, hard = +$('bhard').value / 100;
  const inner = r * hard, soft = Math.max(0.8, r - inner), R = inner + soft;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  if (x0 > x1 || y0 > y1) return;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy, row = y * W;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dd = Math.sqrt(dx * dx + dy * dy);
      let a = dd <= inner ? 1 : 1 - (dd - inner) / soft; if (a <= 0) continue;
      if (a < 1) a = a * a * (3 - 2 * a);
      const i = row + x, A = Math.round(a * 255); if (A <= strokeA[i]) continue;
      strokeA[i] = A;
      const aa = A / 255, w0 = strokeBase[i], v0 = strokeBase[n + i], w1 = w0 + (255 - w0) * aa;
      edits[i] = Math.round(w1); edits[n + i] = w1 ? Math.round((v0 * w0 * (1 - aa) + strokeT * 255 * aa) / w1) : strokeT;
    }
  }
  const grow = rc => rc ? { x0: Math.min(rc.x0, x0), y0: Math.min(rc.y0, y0), x1: Math.max(rc.x1, x1), y1: Math.max(rc.y1, y1) } : { x0, y0, x1, y1 };
  dirty = grow(dirty); strokeRect = grow(strokeRect);
  if (!flushPending) { flushPending = true; requestAnimationFrame(flushDirty); }
}
function flushDirty() {
  flushPending = false; if (!S || !dirty) return;
  const d = dirty; dirty = null;
  blendInto(S.ph, S.alpha, d.x0, d.y0, d.x1, d.y1); renderRect(cvRes, hlOn, d.x0, d.y0, d.x1, d.y1);
}

/* ---------- SAM: click a surface ---------- */
function samPick(x, y) {
  const ph = S.ph;
  if (samPending) return;
  if (ph.status !== 'ready') { banner(t('samWait')); return; }
  if (AI.state === 'off') { banner(t('samNeeded')); return; }
  samPending = { ph, add: tool === 'pick' };
  stage.classList.add('wait'); $('status').textContent = t('samWorking');
  worker.postMessage({ type: 'samPoint', id: ph.id, orig: ph.orig, W: ph.W, H: ph.H, x: Math.round(x), y: Math.round(y) });
}
function onSamMask(m, err) {
  const p = samPending; samPending = null; stage.classList.remove('wait');
  if (!p || !photos.includes(p.ph)) return;
  if (err || !m.mask) { banner(t('errSam')); updateStatus(); return; }
  applyMask(p.ph, m.mask, p.add);
}
function applyMask(ph, mask, add) {
  const { W, H, edits } = ph, n = W * H;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) { banner(t('samNone')); updateStatus(); return; }
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(W - 1, x1 + 1); y1 = Math.min(H - 1, y1 + 1);
  const soft = boxBlur(mask, W, H, 1), T = add ? 255 : 0;
  pushUndo(ph, snapshot(ph, edits, x0, y0, x1, y1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x, A = soft[i]; if (!A) continue;
    const aa = A / 255, w0 = edits[i], v0 = edits[n + i], w1 = w0 + (255 - w0) * aa;
    edits[i] = Math.round(w1); edits[n + i] = w1 ? Math.round((v0 * w0 * (1 - aa) + T * 255 * aa) / w1) : T;
  }
  if (S && S.ph === ph) schedule(); else { ph.thumbStale = true; scheduleThumbs(0); }
}

/* ---------- zoom & pan (Touch up) ---------- */
let zoom = 1, tx = 0, ty = 0, spaceDown = false, panning = null, pinch = null;
let dragging = false, last = null;
const view = $('view'), ptrs = new Map();
function applyView() {
  view.style.transform = (zoom === 1 && !tx && !ty) ? '' : 'translate(' + tx + 'px,' + ty + 'px) scale(' + zoom + ')';
  $('zLabel').textContent = Math.round(zoom * 100) + '%';
}
function clampView() {
  const w = stage.clientWidth, h = stage.clientHeight;
  tx = Math.min(0, Math.max(w - w * zoom, tx)); ty = Math.min(0, Math.max(h - h * zoom, ty));
}
function zoomAt(nz, cx, cy) {
  nz = Math.max(1, Math.min(16, nz)); const k = nz / zoom;
  tx = cx - (cx - tx) * k; ty = cy - (cy - ty) * k; zoom = nz; clampView(); applyView();
}
function zoomCenter(f) { zoomAt(zoom * f, stage.clientWidth / 2, stage.clientHeight / 2); }
function resetView() { zoom = 1; tx = ty = 0; applyView(); }
$('zIn').onclick = () => zoomCenter(1.5);
$('zOut').onclick = () => zoomCenter(1 / 1.5);
$('zFit').onclick = resetView;
new ResizeObserver(() => fitStage()).observe($('stageBox'));
stage.addEventListener('wheel', e => {
  if (!S || mode !== 'touch') return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(zoom * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
  if (isBrush() && !spaceDown) moveCursor(e);
}, { passive: false });
stage.addEventListener('contextmenu', e => { if (mode === 'touch') e.preventDefault(); });

/* ---------- brush size / hardness ---------- */
const bsize = $('bsize'), bhard = $('bhard');
function showBsize() { $('bsizeVal').textContent = bsize.value + ' px'; $('bhardVal').textContent = bhard.value + '%'; }
let lastCur = null, prevTimer = 0, sizing = null;
function brushPreview(at, keep) {
  if (!S || mode !== 'touch') return;
  const el = $('bprev'), d = +bsize.value, hd = Math.min(99, +bhard.value);
  const mid = { cx: stage.clientWidth / 2, cy: stage.clientHeight / 2 };
  const p = at === 'center' ? mid : (at || lastCur || mid);
  el.style.width = el.style.height = d + 'px'; el.style.left = p.cx + 'px'; el.style.top = p.cy + 'px';
  el.style.background = 'radial-gradient(closest-side, rgba(225,30,30,.7) ' + hd + '%, rgba(225,30,30,0) 100%)';
  el.style.display = 'block';
  $('cursor').style.width = $('cursor').style.height = d + 'px';
  clearTimeout(prevTimer);
  if (!keep) prevTimer = setTimeout(() => { el.style.display = 'none'; }, 900);
}
bsize.addEventListener('input', () => { showBsize(); brushPreview('center'); });
bhard.addEventListener('input', () => { showBsize(); brushPreview('center'); });
showBsize();

/* ---------- keyboard ---------- */
const TOOL_KEYS = { b: 'add', e: 'erase', '+': 'pick', '-': 'remove' };   // B brush, E eraser, + / − area (also numpad)
window.addEventListener('keydown', e => {
  if (!S || infoDlg.open) return;
  const tg = e.target, tag = tg && tg.tagName;
  if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && tg.type !== 'range' && tg.type !== 'checkbox')) return;
  const key = e.key.toLowerCase();
  if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[key] && !e.repeat) {   // tool keys also switch to Touch up
    if (mode !== 'touch') setMode('touch');
    setTool(TOOL_KEYS[key]); e.preventDefault(); return;
  }
  if (mode !== 'touch') return;
  if ((e.ctrlKey || e.metaKey) && key === 'z') { if (e.shiftKey) redo(); else undo(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && key === 'y') { redo(); e.preventDefault(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') {
    if (tag === 'BUTTON') return;
    spaceDown = true; stage.classList.add('pan'); $('cursor').style.display = 'none'; e.preventDefault();
  } else if (key === 'o') { if (!e.repeat) peek(true); e.preventDefault(); }
  else if ((e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') && e.shiftKey) {
    const up = e.key === ']' || e.key === '}';
    bhard.value = Math.max(0, Math.min(100, +bhard.value + (up ? 10 : -10))); showBsize(); brushPreview(); e.preventDefault();
  } else if (e.key === '[' || e.key === ']') {
    bsize.value = Math.round(Math.max(2, Math.min(200, +bsize.value * (e.key === ']' ? 1.25 : 0.8))));
    showBsize(); $('cursor').style.width = $('cursor').style.height = bsize.value + 'px'; brushPreview(); e.preventDefault();
  } else if (e.key === '0') { resetView(); e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') { spaceDown = false; stage.classList.remove('pan'); }
  if (e.key.toLowerCase() === 'o') peek(false);
});
window.addEventListener('blur', () => { spaceDown = false; stage.classList.remove('pan'); peek(false); });

/* ---------- pointer handling on the stage ---------- */
function pt(e) {
  const rc = view.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  return { sx: e.clientX - rc.left, sy: e.clientY - rc.top, k: S.W / rc.width, w: rc.width, cx: e.clientX - sr.left, cy: e.clientY - sr.top };
}
function paint(e) {
  const p = pt(e), r = (+bsize.value / 2) * p.k;   // same size on screen, finer on the photo when zoomed in
  const cx = p.sx * p.k, cy = p.sy * p.k;
  if (last) {
    const dx = cx - last.x, dy = cy - last.y, dist = Math.hypot(dx, dy), step = Math.max(0.5, r / 4), n = Math.ceil(dist / step);
    for (let i = 1; i <= n; i++) dab(last.x + dx * i / n, last.y + dy * i / n, r);
  } else dab(cx, cy, r);
  last = { x: cx, y: cy };
}
function moveCursor(e) {
  const p = pt(e), c = $('cursor'), d = +bsize.value;
  c.style.display = 'block'; c.style.width = c.style.height = d + 'px';
  c.style.left = p.cx + 'px'; c.style.top = p.cy + 'px';
  lastCur = { cx: p.cx, cy: p.cy };
}
function startPinch() {
  const [a, b] = [...ptrs.values()], r = stage.getBoundingClientRect();
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, tx, ty };
}
stage.addEventListener('pointerdown', e => {
  if (!S) return;
  try { stage.setPointerCapture(e.pointerId); } catch (err) { }
  if (mode === 'touch') {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {                                   // two fingers: zoom + move, and cancel the stroke the first finger began
      cancelStroke(); dragging = false; last = null; panning = null;
      startPinch(); $('cursor').style.display = 'none'; return;
    }
    if (ptrs.size > 2) return;
    if (e.button === 2 && e.ctrlKey && isBrush()) {
      const p = pt(e);
      sizing = { x: e.clientX, y: e.clientY, size: +bsize.value, hard: +bhard.value, at: { cx: p.cx, cy: p.cy } };
      $('cursor').style.display = 'none'; brushPreview(sizing.at, true); e.preventDefault(); return;
    }
    if (e.button === 1 || e.button === 2 || spaceDown) {
      panning = { x: e.clientX, y: e.clientY, tx, ty }; stage.classList.add('panning'); e.preventDefault(); return;
    }
  }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (mode === 'compare') { dragging = true; const p = pt(e); setPos(p.sx / p.w * 100); return; }
  if (S.ph.status !== 'ready') return;
  if (isPick()) { const p = pt(e); samPick(p.sx * p.k, p.sy * p.k); return; }
  dragging = true; last = null;
  beginStroke(); moveCursor(e); paint(e);
});
stage.addEventListener('pointermove', e => {
  if (!S) return;
  if (mode === 'compare') { if (dragging) { const p = pt(e); setPos(p.sx / p.w * 100); } return; }
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], r = stage.getBoundingClientRect();
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const nz = Math.max(1, Math.min(16, pinch.z * d / pinch.d)), k = nz / pinch.z;
    tx = pinch.mx - (pinch.mx - pinch.tx) * k + (mx - pinch.mx); ty = pinch.my - (pinch.my - pinch.ty) * k + (my - pinch.my);
    zoom = nz; clampView(); applyView(); return;
  }
  if (sizing) {
    bsize.value = Math.round(Math.max(2, Math.min(200, sizing.size + (e.clientX - sizing.x))));
    bhard.value = Math.round(Math.max(0, Math.min(100, sizing.hard + (e.clientY - sizing.y) * 0.5)));
    showBsize(); brushPreview(sizing.at, true); return;
  }
  if (panning) { tx = panning.tx + e.clientX - panning.x; ty = panning.ty + e.clientY - panning.y; clampView(); applyView(); return; }
  if (isBrush() && !spaceDown) { moveCursor(e); if (dragging && stroking) paint(e); }
});
const endDrag = e => {
  if (e && e.pointerId != null) ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (!ptrs.size) { panning = null; stage.classList.remove('panning'); }
  if (sizing) { const at = sizing.at; sizing = null; brushPreview(at); }
  if (stroking && S) endStroke();
  dragging = false; last = null;
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('pointerleave', () => { if (!dragging) $('cursor').style.display = 'none'; });
stage.addEventListener('keydown', e => {
  if (mode !== 'compare') return;
  if (e.key === 'ArrowLeft') { setPos(pos - 5); e.preventDefault(); }
  if (e.key === 'ArrowRight') { setPos(pos + 5); e.preventDefault(); }
});

/* ---------- colour adjustments ---------- */
const sign = v => (v > 0 ? '+' : '') + v;
function showAdj() {
  const a = S ? S.ph.adj : ADJ0;
  $('aOp').value = a.op; $('aSat').value = a.sat; $('aLight').value = a.light; $('aCon').value = a.contrast;
  $('aOpVal').textContent = a.op + '%';
  $('aSatVal').textContent = sign(a.sat); $('aLightVal').textContent = sign(a.light); $('aConVal').textContent = sign(a.contrast);
}
let adjPending = false;
function adjChanged() {
  if (!S) return;
  S.ph.adj = { op: +$('aOp').value, sat: +$('aSat').value, light: +$('aLight').value, contrast: +$('aCon').value };
  showAdj();
  if (adjPending) return; adjPending = true;
  requestAnimationFrame(() => { adjPending = false; if (S) { render(); S.ph.thumbStale = true; scheduleThumbs(500); } });
}
for (const id of ['aOp', 'aSat', 'aLight', 'aCon']) $(id).addEventListener('input', adjChanged);
$('aReset').onclick = () => { if (!S) return; S.ph.adj = { ...ADJ0 }; showAdj(); render(); S.ph.thumbStale = true; scheduleThumbs(300); };
showAdj();

/* ---------- carousel controls ---------- */
for (const [id, d] of [['prev', -1], ['next', 1]]) {
  const b = $(id);
  b.addEventListener('pointerdown', e => e.stopPropagation());
  b.addEventListener('click', () => go(d));
}
$('strip').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    const b = e.target.closest && e.target.closest('.thumb[data-id]'); if (!b) return;
    const ph = byId(+b.dataset.id); if (ph) { removePhoto(ph); e.preventDefault(); }
  }
});

/* ---------- file input / drag & drop ---------- */
const fileIn = $('file'), drop = $('drop');
drop.addEventListener('click', () => fileIn.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
$('again').onclick = () => fileIn.click();
$('dl').onclick = exportCurrent;
$('dlAll').onclick = exportAll;
fileIn.addEventListener('change', () => { const fl = [...fileIn.files]; fileIn.value = ''; if (fl.length) addFiles(fl); });
['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
window.addEventListener('drop', e => { const fl = e.dataTransfer && [...e.dataTransfer.files]; if (fl && fl.length) addFiles(fl); });

/* ---------- info dialog (bottom-left "?"): formats, export, colour profiles ---------- */
const infoDlg = $('infoDlg');
$('infoBtn').onclick = () => infoDlg.showModal();
$('infoClose').onclick = () => infoDlg.close();
infoDlg.addEventListener('click', e => {                     // a click on the backdrop (outside the box) closes it
  const r = infoDlg.getBoundingClientRect();
  if (e.target === infoDlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) infoDlg.close();
});

/* ---------- small screens ---------- */
{
  const small = matchMedia('(max-width: 900px)').matches || matchMedia('(pointer: coarse)').matches;
  let dismissed = false; try { dismissed = sessionStorage.getItem('wr-note') === '1'; } catch (e) { }
  if (small && !dismissed) $('desktopNote').hidden = false;
  $('noteClose').onclick = () => { $('desktopNote').hidden = true; try { sessionStorage.setItem('wr-note', '1'); } catch (e) { } };
}

window.__wallRecolor = { addFiles, state: () => S, photos: () => photos, setColor, target: () => target };
setPos(50);
applyLang();
updateTools();
