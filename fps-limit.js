'use strict';
// Frame limiter, runs INSIDE the game page. BoomBang draws as fast as the screen allows (240 FPS on a 240 Hz screen):
// in crowded events that is a lot of work for the PC. This lets the game draw at most N frames per second
// (and fewer when its window is not the one in front). Animations keep their speed: the game measures real time.
//   set from the launcher:  document '__bb_fps' event, detail '{"fps":60}'   (0 = no limit)
function fpsLimitMain() {
  if (window.__bbFps) return;
  const raf = window.requestAnimationFrame.bind(window);
  let target = 0, last = 0, seq = 0, scheduled = false;
  const pending = new Map();
  function pump(ts) {
    scheduled = false;
    if (!pending.size) return;
    if (target > 0 && ts - last < 1000 / target - 1.5) { scheduled = true; raf(pump); return; }   // not yet: skip this screen refresh
    last = ts;
    const cbs = [...pending.values()]; pending.clear();
    for (const cb of cbs) { try { cb(ts); } catch (e) { setTimeout(() => { throw e; }); } }
  }
  window.requestAnimationFrame = cb => { const id = ++seq; pending.set(id, cb); if (!scheduled) { scheduled = true; raf(pump); } return id; };
  window.cancelAnimationFrame = id => { pending.delete(id); };
  window.__bbFps = { set(n) { target = Math.max(0, Math.min(500, Number(n) || 0)); }, get: () => target };
  document.addEventListener('__bb_fps', e => { try { window.__bbFps.set(JSON.parse(e.detail).fps); } catch (_) {} });
}
module.exports = { fpsLimitMain, SOURCE: `(${fpsLimitMain.toString()})();` };
