'use strict';
// Loading screen of the game window: while BoomBang loads, the animated background of the design chosen in the
// launcher (galaxy.js) with "Cargando BoomBang…", instead of a black window. It fades out as soon as the game shows
// the room has finished appearing (or the login, when there is nothing to type in automatically), or after 60 s at most.

const fs = require('fs');
const path = require('path');

function themeColors(theme) {
  // The same colours as the launcher (style.css).
  const out = { bg1: '#1b1250', bg2: '#0b0828', bg3: '#05031a', a: '#9577ff', text: '#f1edff' };
  try {
    const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
    const m = new RegExp(`\\[data-theme="${theme.replace(/[^a-z]/g, '')}"\\]\\{([^}]*)\\}`).exec(css);
    if (m) for (const k of Object.keys(out)) { const v = new RegExp(`--${k}:([^;]+);`).exec(m[1]); if (v) out[k] = v[1].trim(); }
  } catch (_) {}
  return out;
}

function create({ ipcRenderer }) {
  let el = null, done = false, timer = null;

  function remove() {
    if (!el || done) return;
    done = true; clearTimeout(timer);
    el.style.opacity = '0';
    setTimeout(() => {
      try { window.__BB_BG_PAUSE__ && window.__BB_BG_PAUSE__(true); } catch (_) {}   // stop the animation for good
      try { el.remove(); } catch (_) {}
      try { delete document.documentElement.dataset.theme; } catch (_) {}
      el = null;
    }, 700);
  }

  async function show() {
    if (el || done) return;
    let theme = 'galaxy';
    try { theme = String(await ipcRenderer.invoke('hub:launcher-theme') || 'galaxy'); } catch (_) {}
    if (done) return;
    const c = themeColors(theme);
    el = document.createElement('div');
    el.id = '__bb_loading';
    el.innerHTML = `<style>
      #__bb_loading{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;opacity:1;transition:opacity .6s ease;
        background:radial-gradient(120% 90% at 15% 0%,${c.bg1} 0%,${c.bg2} 45%,${c.bg3} 100%);font-family:"Segoe UI",Inter,system-ui,sans-serif;color:${c.text}}
      #__bb_loading canvas{position:absolute;inset:0;width:100%;height:100%}
      #__bb_loading .box{position:relative;text-align:center}
      #__bb_loading .t{font-size:13px;font-weight:800;letter-spacing:.32em;opacity:.75}
      #__bb_loading .h{margin-top:8px;font-size:34px;font-weight:900}
      #__bb_loading .h span{color:${c.a}}
      #__bb_loading .bar{margin:22px auto 0;width:220px;height:4px;border-radius:4px;background:rgba(255,255,255,.12);overflow:hidden}
      #__bb_loading .bar i{display:block;width:40%;height:100%;border-radius:4px;background:${c.a};animation:bbload 1.3s ease-in-out infinite}
      @keyframes bbload{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}
    </style><canvas id="galaxy"></canvas><div class="box"><div class="t">BOOMBANG</div><div class="h">Cargando <span>BoomBang…</span></div><div class="bar"><i></i></div></div>`;
    (document.body || document.documentElement).appendChild(el);
    document.documentElement.dataset.theme = theme;
    // Light on the PC while the game loads behind it: 20 frames a second and normal (not high-DPI) resolution.
    window.__BB_BG_FPS__ = 20; window.__BB_BG_DPR__ = 1;
    try { require('./galaxy.js'); } catch (_) {}     // the same animated scenes as the launcher
    timer = setTimeout(remove, 60000);
  }

  function handleCommand(cmd) { if (cmd && cmd.type === 'loading-done') remove(); }
  return { show, remove, handleCommand };
}

// Game frame: has the game shown the login (with nothing to type in automatically) or the room?
function watchReady({ ipcRenderer, profileId, loginVisible, worldLoaded, autoLoginStarted }) {
  let since = 0, worldAt = 0;
  const iv = setInterval(() => {
    let ready = false;
    try {
      if (worldLoaded()) {
        // The room is there: give it a couple of seconds more to finish drawing (pictures, people) before showing it.
        if (!worldAt) worldAt = Date.now();
        ready = Date.now() - worldAt > 2500;
      } else {
        worldAt = 0;
        if (loginVisible()) { if (!since) since = Date.now(); ready = Date.now() - since > (autoLoginStarted() ? 15000 : 2000); }   // auto-login stuck? show the login anyway
        else since = 0;
      }
    } catch (_) {}
    if (ready) { clearInterval(iv); try { ipcRenderer.send('client:game-ready', profileId); } catch (_) {} }
  }, 400);
  setTimeout(() => clearInterval(iv), 70000);
}

module.exports = { create, watchReady, themeColors };
