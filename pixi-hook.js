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

  // The name of the picture a sprite shows. For animated sprites, the first picture of the animation.
  function texName(t) {
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
  const family = k => { const m = /^(.*)[/\\][^/\\]*$/.exec(plain(k)); return m ? m[1] + '/' : ''; };   // folder of the picture
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
      const exact = H.keys.includes(k), fam = !exact && H.fam.some(f => plain(k).startsWith(f));
      if (!exact && !fam) continue;
      now.add(s);
      if (H.primed && !H.prev.has(s) && !hit) hit = { key: exact ? k : H.fam.find(f => plain(k).startsWith(f)), name: k };
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
          if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) pick = { key: k, family: family(k), w: Math.round(b.w), h: Math.round(b.h) };
        }
      }
      emit('learned', { ok: Boolean(pick), ...(pick || {}), stage: Boolean(H.stage) });
    } else if (m.type === 'probe') {
      if (!H.stage) find();
      const count = {}; let total = 0;
      for (const s of sprites()) { const k = keyOf(s) || '(sin nombre)'; count[k] = (count[k] || 0) + 1; total++; }
      const list = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([k, n]) => `${n}x ${k}`);
      let version = ''; try { version = (H.P && H.P.VERSION) || (H.renderer && H.renderer.constructor && H.renderer.constructor.name) || ''; } catch (_) {}
      emit('probe', { ok: Boolean(H.stage), pixi: Boolean(H.P), how: H.how, version: String(version), total, list });
    }
  });
  setInterval(tick, 500);
  find();
}
module.exports = { pixiHookMain, SOURCE: `(${pixiHookMain.toString()})();` };
