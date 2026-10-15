'use strict';
// Finds an object inside the game PICTURE by its shape (for objects the game paints on a canvas, which can't be
// recognised by clicking). It compares a small grey-scale copy of the game window with the object's picture using
// normalised cross-correlation of their EDGES (the outline): brightness and contrast changes (fog, night, rain, shadows) don't change the score and
// colours are not used at all. Everything runs in a background thread, about once per second, at 1/4 size.

const SCALE = 4;                                   // work at 1/4 size: light on the CPU, still enough detail
const THRESHOLDS = { alta: 0.62, media: 0.68, baja: 0.75 };   // "sensibilidad" in the Hub
const REARM = 0.5;                                 // must drop below this before it can ring again for that object

// BGRA (Electron's NativeImage.toBitmap) or RGBA -> grey, averaged down by `f` in both directions.
function grayDown(buf, w, h, f = SCALE, order = 'bgra') {
  const W = Math.max(1, Math.floor(w / f)), H = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(W * H);
  const [ri, gi, bi] = order === 'rgba' ? [0, 1, 2] : [2, 1, 0];
  const n = f * f;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = ((y * f + dy) * w + x * f) * 4;
        for (let dx = 0; dx < f; dx++, p += 4) {
          const a = buf[p + 3] / 255;              // transparent pixels of an uploaded PNG count as mid grey
          s += (0.299 * buf[p + ri] + 0.587 * buf[p + gi] + 0.114 * buf[p + bi]) * a + 128 * (1 - a);
        }
      }
      out[y * W + x] = s / n;
    }
  }
  return { data: out, w: W, h: H };
}

// Edge strength (Sobel). Matching edges instead of brightness makes the SHAPE count, not big smooth areas.
function edges(img) {
  const { data: I, w, h } = img, out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = I[i - w + 1] + 2 * I[i + 1] + I[i + w + 1] - I[i - w - 1] - 2 * I[i - 1] - I[i + w - 1];
      const gy = I[i + w - 1] + 2 * I[i + w] + I[i + w + 1] - I[i - w - 1] - 2 * I[i - w] - I[i - w + 1];
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { data: out, w, h };
}

function prepTemplate(img) {
  const { data, w, h } = img, n = w * h;
  let mean = 0; for (let i = 0; i < n; i++) mean += data[i]; mean /= n;
  const t = new Float32Array(n); let ss = 0;
  for (let i = 0; i < n; i++) { const v = data[i] - mean; t[i] = v; ss += v * v; }
  return { data: t, w, h, norm: Math.sqrt(ss) };
}

// Best normalised cross-correlation of template `t` (prepared) over `frame`. Returns {score, x, y} in frame cells.
function bestMatch(frame, t) {
  const { data: I, w: W, h: H } = frame, { data: T, w, h, norm } = t;
  if (w > W || h > H || norm < 1e-3) return { score: 0, x: 0, y: 0 };
  const n = w * h, W1 = W + 1;
  const S = new Float64Array(W1 * (H + 1)), SS = new Float64Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0, rss = 0;
    for (let x = 0; x < W; x++) {
      const v = I[y * W + x]; rs += v; rss += v * v;
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs;
      SS[(y + 1) * W1 + x + 1] = SS[y * W1 + x + 1] + rss;
    }
  }
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y + h <= H; y++) {
    for (let x = 0; x + w <= W; x++) {
      const a = y * W1 + x, b = a + w, c = (y + h) * W1 + x, d = c + w;
      const sum = S[d] - S[b] - S[c] + S[a];
      const var_ = SS[d] - SS[b] - SS[c] + SS[a] - (sum * sum) / n;
      if (var_ < n * 4) continue;                   // flat area (sky, floor): nothing to recognise there
      let num = 0;
      for (let ty = 0; ty < h; ty++) {
        let p = (y + ty) * W + x, q = ty * w;
        for (let tx = 0; tx < w; tx++) num += I[p++] * T[q++];
      }
      const score = num / (Math.sqrt(var_) * norm);
      if (score > best) { best = score; bx = x; by = y; }
    }
  }
  return { score: best, x: bx, y: by };
}

// Source of the background thread (worker_threads, eval: true, so it also works from inside the packaged app).
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads');
${bestMatch.toString()}
parentPort.on('message', msg => {
  const frame = { data: new Float32Array(msg.frame), w: msg.w, h: msg.h };
  const out = msg.templates.map(t => ({ id: t.id, ...bestMatch(frame, { data: new Float32Array(t.data), w: t.w, h: t.h, norm: t.norm }) }));
  parentPort.postMessage({ job: msg.job, results: out });
});`;

module.exports = { SCALE, THRESHOLDS, REARM, grayDown, edges, prepTemplate, bestMatch, WORKER_SOURCE };
