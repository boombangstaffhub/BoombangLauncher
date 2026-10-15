'use strict';
// Runs INSIDE the game page (main world). BoomBang draws the room with PixiJS: every object on screen is a "sprite"
// that has the name of its picture (texture). Here we find the game's scene and, instead of looking at colours or
// shapes, recognise objects by that name. The launcher's code talks to this through DOM events (strings only).
//   in : document '__bb_pixi_in'  {type:'watch', keys:[...]} | {type:'learn', x, y} | {type:'probe'}
//   out: document '__bb_pixi_out' {type:'status'|'hit'|'learned'|'probe', ...}
// It only reads the scene: it never changes, moves or clicks anything in the game.
function pixiHookMain() {
  if (window.__BB_PIXI_HOOK__) return;
  const H = window.__BB_PIXI_HOOK__ = { stage: null, renderer: null, P: null, how: '', keys: [], fam: [], prev: new Set(), primed: false };
  const emit = (type, data) => { try { document.dispatchEvent(new CustomEvent('__bb_pixi_out', { detail: JSON.stringify({ type, ...(data || {}) }) })); } catch (_) {} };

  function grab(renderer, args) {
    try {
      let s = args[0];
      if (s && !s.children && s.container) s = s.container;            // Pixi v8: render({ container })
      if (s && s.children && s !== H.stage && (!H.stage || !s.parent)) { H.stage = s; H.renderer = renderer; if (!H.how) H.how = 'render'; }
    } catch (_) {}
  }
  function patch(proto) {
    if (!proto || proto.__bbPatched || typeof proto.render !== 'function') return false;
    const orig = proto.render;
    proto.render = function (...a) { grab(this, a); return orig.apply(this, a); };
    proto.__bbPatched = true; return true;
  }
  function usePixi(P) {
    if (!P || typeof P !== 'object' || H.P) return;
    H.P = P;
    for (const k of ['Renderer', 'WebGLRenderer', 'WebGPURenderer', 'CanvasRenderer', 'AbstractRenderer']) { try { patch(P[k] && P[k].prototype); } catch (_) {} }
  }
  function find() {
    try { usePixi(window.PIXI); } catch (_) {}
    for (const k of ['__PIXI_APP__', '__PIXI_STAGE__', '__PIXI_RENDERER__']) {
      let v; try { v = window[k]; } catch (_) { continue; }
      if (!v) continue;
      if (v.stage && v.stage.children && !H.stage) { H.stage = v.stage; H.renderer = v.renderer || null; H.how = 'global ' + k; }
      else if (k === '__PIXI_STAGE__' && v.children && !H.stage) { H.stage = v; H.how = 'global ' + k; }
      else if (k === '__PIXI_RENDERER__') { if (!H.renderer) H.renderer = v; patch(Object.getPrototypeOf(v)); }
    }
    if (H.stage) return;
    let keys = []; try { keys = Object.keys(window); } catch (_) {}
    for (const k of keys) {
      let v; try { v = window[k]; } catch (_) { continue; }
      if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
      try {
        if (v.stage && v.stage.children && v.renderer) { H.stage = v.stage; H.renderer = v.renderer; H.how = 'window.' + k; return; }
        if (typeof v.render === 'function' && v.screen && (v.view || v.canvas)) { H.renderer = H.renderer || v; patch(Object.getPrototypeOf(v)); }
        if (v.Sprite && v.Texture && v.Container) usePixi(v);
      } catch (_) {}
    }
  }

  // BoomBang gives its pictures random names every session ("blob:..."), so a name can't be remembered.
  // Instead we take a tiny 16x16 fingerprint of the object's OWN picture (the one stored in the game, not the screen):
  // the same object always gives the same fingerprint, whatever the weather, fog or lighting on screen.
  const fpCache = new WeakMap();
  let fpCanvas = null, fpCtx = null;
  function fingerprint(t) {
    if (!t || (typeof t !== 'object')) return '';
    if (fpCache.has(t)) return fpCache.get(t);
    let k = '';
    try {
      const src = t.source || t.baseTexture;
      let res = src && src.resource;
      if (res && res.source && !res.width) res = res.source;                   // Pixi v7 resource wrapper
      const rw = res && (res.width || res.videoWidth || res.naturalWidth), rh = res && (res.height || res.videoHeight || res.naturalHeight);
      if (res && rw && rh) {
        const f = t.frame || t._frame || { x: 0, y: 0, width: rw, height: rh };
        if (!fpCanvas) { fpCanvas = document.createElement('canvas'); fpCanvas.width = fpCanvas.height = 16; fpCtx = fpCanvas.getContext('2d', { willReadFrequently: true }); }
        fpCtx.imageSmoothingEnabled = false;
        fpCtx.clearRect(0, 0, 16, 16);
        fpCtx.drawImage(res, f.x, f.y, f.width, f.height, 0, 0, 16, 16);
        const d = fpCtx.getImageData(0, 0, 16, 16).data;
        let h1 = 5381, h2 = 52711, ink = 0;
        for (let i = 0; i < d.length; i++) { const v = d[i] >> 3; h1 = ((h1 << 5) + h1 + v) | 0; h2 = ((h2 << 5) + h2) ^ v; if (i % 4 === 3 && d[i] > 16) ink++; }
        if (ink >= 6) k = `px:${Math.round(f.width)}x${Math.round(f.height)}:${(h1 >>> 0).toString(36)}${((h2 | 0) >>> 0).toString(36)}`;
      }
    } catch (_) { k = ''; }
    fpCache.set(t, k);
    return k;
  }
  // The name of the picture a sprite shows (or its fingerprint when the game gives it no stable name).
  function texName(t) {
    const n = rawName(t);
    if (n && !/^(blob:|data:)/i.test(n)) return n;
    return fingerprint(t);
  }
  function rawName(t) {
    if (!t) return '';
    try {
      const ids = t.textureCacheIds;
      if (ids && ids.length) return String(ids[0]).split('?')[0];
      if (t.label) return String(t.label).split('?')[0];
      const b = t.baseTexture || t.source;
      let base = '';
      if (b) base = b.cacheId || b.label || (b.resource && (b.resource.url || b.resource.src || (b.resource.source && b.resource.source.src))) || '';
      if (!base) return '';
      const f = t.frame || t._frame;
      return String(base).split('?')[0] + (f ? `#${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)}` : '');
    } catch (_) { return ''; }
  }
  function keyOf(s) {
    try {
      if (s.textures && s.textures.length) { const f = s.textures[0]; return 'anim:' + texName(f && f.texture ? f.texture : f); }
      return s.texture ? texName(s.texture) : '';
    } catch (_) { return ''; }
  }
  const plain = k => String(k).replace(/^anim:/, '');
  // Where in the game's scene the object lives ("layer"): objects that fall are usually all in the same layer.
  function layerOf(s) {
    const parts = [];
    try {
      for (let o = s.parent; o && o !== H.stage && parts.length < 12; o = o.parent) {
        const p = o.parent; const i = p && p.children ? p.children.indexOf(o) : -1;
        parts.unshift(o.label ? String(o.label).slice(0, 30) : (o.name ? String(o.name).slice(0, 30) : '#' + i));
      }
    } catch (_) {}
    return 'layer:' + parts.join('/');
  }
  const shown = o => o.visible !== false && o.renderable !== false && !(typeof o.worldAlpha === 'number' && o.worldAlpha <= 0.02) && !(typeof o.alpha === 'number' && o.alpha <= 0.02);
  // Every visible sprite, in drawing order (the last one is on top).
  function sprites(limit = 12000) {
    const out = []; if (!H.stage) return out;
    let n = 0;
    (function walk(o) {
      if (!o || n++ > limit || !shown(o)) return;
      if (o.texture || o.textures) out.push(o);
      const c = o.children; if (c) for (let i = 0; i < c.length; i++) walk(c[i]);
    })(H.stage);
    return out;
  }
  function canvasEl() {
    const r = H.renderer;
    return (r && (r.view || r.canvas)) || [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  }
  // Page point -> Pixi point
  function toScene(x, y) {
    const c = canvasEl(); if (!c) return null;
    const r = c.getBoundingClientRect();
    const sw = (H.renderer && H.renderer.screen && H.renderer.screen.width) || c.width, sh = (H.renderer && H.renderer.screen && H.renderer.screen.height) || c.height;
    return { x: (x - r.left) * sw / r.width, y: (y - r.top) * sh / r.height };
  }
  // Small picture of what was learned, so you can see it in the Hub.
  function thumbOf(sp) {
    const t = sp.textures && sp.textures.length ? (sp.textures[0].texture || sp.textures[0]) : sp.texture;
    const src = t && (t.source || t.baseTexture); let res = src && src.resource;
    if (res && res.source && !res.width) res = res.source;
    if (!res) return '';
    const f = t.frame || t._frame || { x: 0, y: 0, width: res.width, height: res.height };
    const c = document.createElement('canvas'), k = 48 / Math.max(f.width, f.height);
    c.width = Math.max(1, Math.round(f.width * k)); c.height = Math.max(1, Math.round(f.height * k));
    c.getContext('2d').drawImage(res, f.x, f.y, f.width, f.height, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/png');
    return url.length < 12000 ? url : '';
  }
  function boundsOf(o) { try { const b = o.getBounds(); return { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (_) { return null; } }

  function tick() {
    if (!H.stage) find();
    const st = `${Boolean(H.stage)}|${Boolean(H.P)}`;
    if (st !== H.reported) { H.reported = st; emit('status', { ok: Boolean(H.stage), pixi: Boolean(H.P), how: H.how }); }
    if (!H.stage) return;
    if (!H.keys.length && !H.fam.length) { H.prev = new Set(); H.primed = false; return; }
    const now = new Set(); let hit = null;
    for (const s of sprites()) {
      const k = keyOf(s); if (!k) continue;
      const exact = H.keys.includes(k);
      const lay = !exact && H.fam.length ? layerOf(s) : '';
      const fam = !exact && lay && H.fam.includes(lay);
      if (!exact && !fam) continue;
      now.add(s);
      if (H.primed && !H.prev.has(s) && !hit) hit = { key: exact ? k : lay, name: k };
    }
    H.prev = now; H.primed = true;
    if (hit) emit('hit', hit);
  }

  document.addEventListener('__bb_pixi_in', e => {
    let m; try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (m.type === 'watch') {
      H.keys = Array.isArray(m.keys) ? m.keys.map(String) : [];
      H.fam = Array.isArray(m.families) ? m.families.map(String) : [];
      H.prev = new Set(); H.primed = false; tick();
    } else if (m.type === 'learn') {
      if (!H.stage) find();
      const p = toScene(Number(m.x), Number(m.y));
      let pick = null;
      if (p) {
        for (const s of sprites()) {                       // last match = the one drawn on top
          const k = keyOf(s); if (!k) continue;
          const b = boundsOf(s); if (!b || b.w < 6 || b.h < 6 || b.w > 320 || b.h > 320) continue;
          if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) pick = { key: k, family: layerOf(s), w: Math.round(b.w), h: Math.round(b.h), sprite: s };
        }
      }
      let thumb = '';
      if (pick) { try { thumb = thumbOf(pick.sprite); } catch (_) {} delete pick.sprite; }
      emit('learned', { ok: Boolean(pick), ...(pick || {}), thumb, stage: Boolean(H.stage) });
    } else if (m.type === 'probe') {
      if (!H.stage) find();
      const rows = []; let total = 0;
      for (const s of sprites()) {
        total++;
        const b = boundsOf(s) || { x: 0, y: 0, w: 0, h: 0 };
        let raw = ''; try { raw = rawName(s.textures && s.textures.length ? (s.textures[0].texture || s.textures[0]) : s.texture); } catch (_) {}
        rows.push(`${(keyOf(s) || '(sin huella)').padEnd(34)} ${String(Math.round(b.w)).padStart(4)}x${String(Math.round(b.h)).padEnd(4)} en ${Math.round(b.x)},${Math.round(b.y)}  ${layerOf(s)}  ${s.constructor && s.constructor.name || ''} ${raw && /^blob:/.test(raw) ? 'blob' : raw.slice(0, 40)}`);
      }
      const list = rows.slice(0, 300);
      let version = ''; try { version = (H.P && H.P.VERSION) || (H.renderer && H.renderer.constructor && H.renderer.constructor.name) || ''; } catch (_) {}
      emit('probe', { ok: Boolean(H.stage), pixi: Boolean(H.P), how: H.how, version: String(version), total, list });
    }
  });
  setInterval(tick, 500);
  find();
}
module.exports = { pixiHookMain, SOURCE: `(${pixiHookMain.toString()})();` };
