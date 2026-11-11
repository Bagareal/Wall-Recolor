// "Working" animation shown over the After half while a photo is being analysed.
// The photo turns into big pixels that drift and swap places with their neighbours; now and then a few flash the
// target colour. When the result is ready the pixels settle back and the recoloured photo fades in.
// With "reduce motion" the pixels stay still and only a slow pulse of the target colour is shown.

const COLS = 48;                 // blocks across the photo
const FADE_IN = 450, SETTLE = 350, FADE_OUT = 650;

/** canvas: the overlay canvas (same box as the result canvas). Returns {start, setTarget, finish, stop, running}. */
export function createAnalysisAnim(canvas) {
  const ctx = canvas.getContext('2d');
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0, tiles = [], src = null, B = 16, gx = 0, gy = 0, rgb = [0, 0, 0];
  let t0 = 0, lastSwap = 0, endAt = 0, result = null, onDone = null;

  function start(source, target) {
    stop();
    src = source; rgb = target.slice();
    const W = source.width, H = source.height;
    canvas.width = W; canvas.height = H;
    B = Math.max(6, Math.round(W / COLS)); gx = Math.ceil(W / B); gy = Math.ceil(H / B);
    const s = document.createElement('canvas'); s.width = gx; s.height = gy;
    const sc = s.getContext('2d', { willReadFrequently: true });
    sc.imageSmoothingEnabled = true; sc.imageSmoothingQuality = 'medium';
    sc.drawImage(source, 0, 0, gx, gy);
    const d = sc.getImageData(0, 0, gx, gy).data;
    tiles = [];
    for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
      const k = (y * gx + x) * 4;
      tiles.push({ hx: x * B, hy: y * B, x: x * B, y: y * B, tx: x * B, ty: y * B, r: d[k], g: d[k + 1], b: d[k + 2], tint: 0 });
    }
    t0 = performance.now(); lastSwap = 0; endAt = 0; result = null; onDone = null;
    canvas.style.opacity = '1'; canvas.hidden = false;
    raf = requestAnimationFrame(frame);
  }

  function setTarget(target) { rgb = target.slice(); }

  /** Settle the pixels, fade to `resultCanvas`, then hide and call done(). */
  function finish(resultCanvas, done) {
    if (!raf) { if (done) done(); return; }
    result = resultCanvas; onDone = done || null; endAt = performance.now();
    for (const a of tiles) { a.tx = a.hx; a.ty = a.hy; }
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0; tiles = []; src = null; result = null; onDone = null;
    canvas.hidden = true;
  }

  function shuffle(now) {
    if (now - lastSwap < 110) return;
    lastSwap = now;
    const n = tiles.length;
    for (let i = 0; i < Math.max(4, n / 140); i++) {            // swap with a near neighbour
      const a = tiles[(Math.random() * n) | 0];
      const bx = Math.max(0, Math.min(gx - 1, a.hx / B + ((Math.random() * 5) | 0) - 2));
      const by = Math.max(0, Math.min(gy - 1, a.hy / B + ((Math.random() * 3) | 0) - 1));
      const b = tiles[by * gx + bx];
      [a.tx, b.tx] = [b.tx, a.tx]; [a.ty, b.ty] = [b.ty, a.ty];
    }
    for (let i = 0; i < Math.max(6, n / 60); i++) { const a = tiles[(Math.random() * n) | 0]; a.tx = a.hx; a.ty = a.hy; }
    for (let i = 0; i < Math.max(3, n / 280); i++) tiles[(Math.random() * n) | 0].tint = 1;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const W = canvas.width, H = canvas.height, t = now - t0;
    ctx.globalAlpha = 1;
    ctx.drawImage(src, 0, 0);
    ctx.fillStyle = 'rgba(12,13,14,.6)'; ctx.fillRect(0, 0, W, H);
    if (reduced) {
      const p = 0.12 + 0.1 * Math.sin(t / 600);
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${p})`; ctx.fillRect(0, 0, W, H);
    } else {
      if (!endAt) shuffle(now);
      const g = B > 10 ? 1 : 0;
      for (const a of tiles) {
        a.x += (a.tx - a.x) * 0.14; a.y += (a.ty - a.y) * 0.14; a.tint *= 0.955;
        const m = a.tint * 0.85;
        ctx.fillStyle = `rgb(${(a.r + (rgb[0] - a.r) * m) | 0},${(a.g + (rgb[1] - a.g) * m) | 0},${(a.b + (rgb[2] - a.b) * m) | 0})`;
        ctx.fillRect(a.x + g, a.y + g, B - 2 * g, B - 2 * g);
      }
    }
    if (t < FADE_IN) { ctx.globalAlpha = 1 - t / FADE_IN; ctx.drawImage(src, 0, 0); }
    if (endAt) {
      const q = Math.min(1, (now - endAt - (reduced ? 0 : SETTLE)) / FADE_OUT);
      if (q > 0 && result) { ctx.globalAlpha = q; ctx.drawImage(result, 0, 0); }
      if (q >= 1) { const cb = onDone; stop(); if (cb) cb(); }
    }
    ctx.globalAlpha = 1;
  }

  return { start, setTarget, finish, stop, get running() { return !!raf; } };
}
