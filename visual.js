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

// Resize a grey image (bilinear). Used to also try the object a bit smaller / bigger than in its picture.
function resize(img, s) {
  const w = Math.max(4, Math.round(img.w * s)), h = Math.max(4, Math.round(img.h * s)), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.h - 1.001, (y + 0.5) / s - 0.5 < 0 ? 0 : (y + 0.5) / s - 0.5), y0 = Math.floor(fy), ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.w - 1.001, (x + 0.5) / s - 0.5 < 0 ? 0 : (x + 0.5) / s - 0.5), x0 = Math.floor(fx), ax = fx - x0;
      const i = y0 * img.w + x0;
      out[y * w + x] = (img.data[i] * (1 - ax) + img.data[i + 1] * ax) * (1 - ay) + (img.data[i + img.w] * (1 - ax) + img.data[i + img.w + 1] * ax) * ay;
    }
  }
  return { data: out, w, h };
}
const VARIANT_SCALES = [0.88, 1, 1.12];
// Grey picture of the object -> its outline at 3 sizes, ready to compare.
function prepVariants(gray) { return VARIANT_SCALES.map(s => prepTemplate(edges(s === 1 ? gray : resize(gray, s)))); }

// Best normalised cross-correlation of template `t` (prepared) over `frame`. Returns {score, x, y} in frame cells.
// Coarse pass every 2 cells, then a fine pass around the best spot: about 4x cheaper than checking every cell.
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
  const at = (x, y) => {
    const a = y * W1 + x, b = a + w, c = (y + h) * W1 + x, d = c + w;
    const sum = S[d] - S[b] - S[c] + S[a];
    const var_ = SS[d] - SS[b] - SS[c] + SS[a] - (sum * sum) / n;
    if (var_ < n * 4) return -1;                    // flat area (sky, floor): nothing to recognise there
    let num = 0;
    for (let ty = 0; ty < h; ty++) {
      let p = (y + ty) * W + x, q = ty * w;
      for (let tx = 0; tx < w; tx++) num += I[p++] * T[q++];
    }
    return num / (Math.sqrt(var_) * norm);
  };
  const tops = [];                                   // best few coarse spots
  for (let y = 0; y + h <= H; y += 2) {
    for (let x = 0; x + w <= W; x += 2) {
      const sc = at(x, y);
      if (tops.length < 4 || sc > tops[tops.length - 1].s) {
        tops.push({ s: sc, x, y }); tops.sort((p, q) => q.s - p.s); if (tops.length > 4) tops.pop();
      }
    }
  }
  for (const tp of tops) {
    for (let y = Math.max(0, tp.y - 2); y <= Math.min(H - h, tp.y + 2); y++) {
      for (let x = Math.max(0, tp.x - 2); x <= Math.min(W - w, tp.x + 2); x++) {
        const sc = at(x, y);
        if (sc > best) { best = sc; bx = x; by = y; }
      }
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
  const out = msg.templates.map(t => ({ id: t.id, ...bestMatch(frame, { data: new Float32Array(t.data), w: t.w, h: t.h, norm: t.norm }) }));   // one entry per size variant
  parentPort.postMessage({ job: msg.job, results: out });
});`;

module.exports = { SCALE, THRESHOLDS, REARM, VARIANT_SCALES, grayDown, edges, resize, prepTemplate, prepVariants, bestMatch, WORKER_SOURCE };
