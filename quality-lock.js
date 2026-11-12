'use strict';
// Calidad fija, runs INSIDE the game page (main world).
// BoomBang lowers its own resolution when it thinks the PC is slow (2 → 1.75 → 1.5 → 1.25 → 1) and raises it again
// later, step by step. It gets fooled by a single hiccup or by the window being minimized, and every change resizes the
// canvas, which the browser clears: that is the black flash. With the lock on, the game keeps its best resolution:
// attempts to LOWER it are ignored; raising it, or resizing the window, works as always.
//   set from the launcher: document '__bb_quality' event, detail '{"lock":true}'
function qualityLockMain() {
  if (window.__bbQuality) return;
  let lock = true, best = 0;
  const Q = window.__bbQuality = { set(v) { lock = Boolean(v); }, get: () => lock, blocked: 0, patched: [] };
  const keep = (cur, want) => {                      // resolution the renderer should end up with
    if (Number.isFinite(cur) && cur > best) best = cur;
    if (!Number.isFinite(want)) return want;
    if (lock && best && want < best) { Q.blocked++; return best; }
    if (want > best) best = want;
    return want;
  };
  function patchProto(proto, name) {
    if (!proto || proto.__bbQualityPatched) return;
    let done = false;
    if (typeof proto.resize === 'function') {
      const resize = proto.resize;
      proto.resize = function (w, h, res) {
        let cur; try { cur = this.resolution; } catch (_) {}
        return resize.call(this, w, h, res === undefined ? res : keep(cur, res));
      };
      done = true;
    }
    const d = Object.getOwnPropertyDescriptor(proto, 'resolution');
    if (d && d.set && d.get && d.configurable) {
      Object.defineProperty(proto, 'resolution', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set(v) {
          let cur; try { cur = d.get.call(this); } catch (_) {}
          const next = keep(cur, v);
          if (next === cur) return;                  // nothing changes: don't touch the canvas
          return d.set.call(this, next);
        }
      });
      done = true;
    }
    if (done) { proto.__bbQualityPatched = true; Q.patched.push(name); }
  }
  function usePixi(P) {
    if (!P || typeof P !== 'object') return false;
    let any = false;
    for (const k of ['AbstractRenderer', 'ViewSystem']) {
      try { if (P[k] && P[k].prototype) { patchProto(P[k].prototype, k); any = true; } } catch (_) {}
    }
    return any;
  }
  function find() {
    try { if (usePixi(window.PIXI)) return true; } catch (_) {}
    let keys = []; try { keys = Object.keys(window); } catch (_) {}
    for (const k of keys) {
      let v; try { v = window[k]; } catch (_) { continue; }
      try { if (v && typeof v === 'object' && v.AbstractRenderer && v.Container && usePixi(v)) return true; } catch (_) {}
    }
    return false;
  }
  let tries = 0;
  (function wait() { if (find() || ++tries > 600) return; setTimeout(wait, 100); })();   // up to ~60 s while the game loads
  document.addEventListener('__bb_quality', e => { try { Q.set(JSON.parse(e.detail).lock); } catch (_) {} });
}
module.exports = { qualityLockMain, SOURCE: `(${qualityLockMain.toString()})();` };
