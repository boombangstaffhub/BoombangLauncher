'use strict';
// Drop alert: a soft chime when an object you taught the launcher appears in the room.
//
// It does NOT look at colours (rain, fog and shadows change them). You click the object once in "aprender" mode and
// the launcher remembers WHICH IMAGE the game uses for it (the picture file, not its colour). From then on, every time
// an element with that same image appears (or becomes visible again) in the game, it plays a short, quiet chime and the
// taskbar button blinks if the window is not in front. It never moves, clicks or picks anything up: you do that.

function cleanSrc(src) {
  const s = String(src || '').trim();
  if (!s || /^data:/i.test(s)) return s.slice(0, 200);
  return s.split('#')[0].split('?')[0];
}
function bgUrl(value) {
  const m = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(String(value || ''));
  return m ? cleanSrc(m[1]) : '';
}
function classOf(el) { const c = el && el.className; return String(c && c.baseVal !== undefined ? c.baseVal : c || ''); }

// The picture an element shows: <img src>, or a CSS background-image.
function imageOf(el, computed = true) {
  if (!el || el.nodeType !== 1) return '';
  if (el.tagName === 'IMG') return cleanSrc(el.currentSrc || el.src || el.getAttribute('src'));
  const inline = el.style && el.style.backgroundImage;
  if (inline && inline !== 'none') return bgUrl(inline);
  if (computed) { try { return bgUrl(getComputedStyle(el).backgroundImage); } catch (_) { return ''; } }
  return '';
}
function visible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}
// What did the user click? The clicked element or one of its closest parents that shows a picture.
function signatureFromPath(path) {
  for (const el of path.slice(0, 6)) {
    if (!el || el.nodeType !== 1) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 320 || r.height > 320) continue;    // the room background is not "the object"
    const src = imageOf(el);
    if (src && !/^data:/i.test(src)) {
      // A picture set by a CSS class (not inline) is found later through that class.
      const viaClass = el.tagName !== 'IMG' && !(el.style && el.style.backgroundImage && el.style.backgroundImage !== 'none');
      const cls = viaClass ? (classOf(el).trim().split(/\s+/)[0] || '') : '';
      return { src, cls: /^[A-Za-z_][\w-]{0,60}$/.test(cls) ? cls : '' };
    }
  }
  return null;
}
function describe(path) {
  return path.slice(0, 8).filter(el => el && el.nodeType === 1).map(el => {
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${classOf(el) ? '.' + classOf(el).trim().split(/\s+/).join('.') : ''} ` +
      `[${Math.round(r.width)}x${Math.round(r.height)}] img=${imageOf(el) || '-'}`;
  }).join('\n');
}

const DEFAULT_CONFIG = { enabled: false, volume: 40, sensitivity: 'media', items: [] };
const MAX_ITEMS = 12;
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const items = [];
  const seen = new Set();
  for (const it of Array.isArray(c.items) ? c.items : []) {
    if (it && it.type === 'visual') {                 // learned from a picture (objects painted on a canvas)
      const id = String(it.id || '');
      if (!/^[a-z0-9]{6,24}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      items.push({ type: 'visual', id, label: String(it.label || '').trim().slice(0, 24) || `Objeto ${items.length + 1}` });
      if (items.length >= MAX_ITEMS) break;
      continue;
    }
    const src = cleanSrc(it && it.src);
    if (!src || /^data:/i.test(src) || src.length > 500 || seen.has(src)) continue;
    seen.add(src);
    const cls = /^[A-Za-z_][\w-]{0,60}$/.test(String(it.cls || '')) ? String(it.cls) : '';
    items.push({ src, cls, label: String(it.label || '').trim().slice(0, 24) || `Objeto ${items.length + 1}` });
    if (items.length >= MAX_ITEMS) break;
  }
  const volume = Math.max(0, Math.min(100, Math.round(Number(c.volume))));
  const sensitivity = ['alta', 'media', 'baja'].includes(c.sensitivity) ? c.sensitivity : 'media';
  return { enabled: Boolean(c.enabled), volume: Number.isFinite(volume) ? volume : DEFAULT_CONFIG.volume, sensitivity, items };
}

// A short, soft two-note chime (no samples, nothing loud).
let audioCtx = null;
function chime(volume = 40) {
  const v = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
  if (!v) return false;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    const notes = [[784, 0], [1175, 0.13]];          // G5 then D6
    for (const [freq, at] of notes) {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.22 * v, now + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.55);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at); osc.stop(now + at + 0.6);
    }
    return true;
  } catch (_) { return false; }
}

function create(api) {
  // api: { ipcRenderer, isGameFrame(), getProfileId(), notice(msg) }
  const ipc = api.ipcRenderer;
  let cfg = normalizeConfig(DEFAULT_CONFIG);
  let observer = null, scanTimer = null, throttle = null, lastScan = 0, lastAlert = 0, learning = null, banner = null;
  let shown = new WeakMap();            // element -> was visible at the last scan
  let primed = false;                   // first scan after (re)start only records what is already there
  const inGame = () => (typeof api.isGameFrame === 'function' ? !!api.isGameFrame() : true);
  const COOLDOWN = 4000;

  function candidates() {
    const out = [...document.images];
    for (const el of document.querySelectorAll('[style*="background"]')) out.push(el);
    for (const it of cfg.items) if (it.src && it.cls) for (const el of document.getElementsByClassName(it.cls)) out.push(el);
    return out;
  }
  function scan() {
    lastScan = performance.now();
    if (!cfg.enabled || !cfg.items.length || learning) return;
    const wanted = new Set(cfg.items.filter(i => i.src).map(i => i.src));
    if (!wanted.size) return;
    let hit = null;
    for (const el of candidates()) {
      if (el.closest && el.closest('#__bb_smart_bar,#__bb_hub_root,#__bb_drop_banner')) continue;
      const src = imageOf(el, Boolean(el.className && cfg.items.some(i => i.cls && el.classList && el.classList.contains(i.cls))));
      if (!src || !wanted.has(src)) continue;
      const vis = visible(el), before = shown.get(el) === true;
      shown.set(el, vis);
      if (vis && !before && primed && !hit) hit = cfg.items.find(i => i.src === src);
    }
    primed = true;
    if (hit) alert(hit);
  }
  function scheduleScan() {
    if (throttle) return;
    const wait = Math.max(0, 120 - (performance.now() - lastScan));
    throttle = setTimeout(() => { throttle = null; scan(); }, wait);
  }
  async function alert(item) {
    const now = Date.now();
    if (now - lastAlert < COOLDOWN) return;
    lastAlert = now;
    let playHere = true;
    try { const r = await ipc.invoke('alerts:drop', api.getProfileId(), { label: item.label, volume: cfg.volume }); if (r && r.playHere === false) playHere = false; } catch (_) {}
    if (playHere) chime(cfg.volume);
    api.notice(`🔔 ${item.label}`);
  }

  function start() {
    if (!inGame() || observer) return;
    observer = new MutationObserver(muts => {
      for (const m of muts) { if (m.addedNodes.length || m.type === 'attributes') { scheduleScan(); return; } }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'hidden'] });
    scanTimer = setInterval(scan, 700);      // also catches objects that only move or fade in through inline styles
    ipc.invoke('alerts:get').then(c => setConfig(c)).catch(() => {});
  }
  function setConfig(next) {
    cfg = normalizeConfig(next);
    shown = new WeakMap(); primed = false;
    scan();
  }

  // ------------------------------------------------------------------ learn: click the object once
  function showBanner(text) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = '__bb_drop_banner';
      banner.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:12px;' +
        'font:700 13px "Segoe UI",system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,rgba(124,92,255,.95),rgba(70,52,200,.95));' +
        'box-shadow:0 10px 30px rgba(60,40,180,.45);pointer-events:none';
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.textContent = text;
  }
  function hideBanner() { if (banner) { banner.remove(); banner = null; } }
  function stopLearning() {
    if (!learning) return;
    for (const [t, f] of learning.handlers) window.removeEventListener(t, f, true);
    clearTimeout(learning.timer);
    learning = null; hideBanner();
  }
  function learn() {
    if (!inGame()) return;
    stopLearning();
    showBanner('🔔 Haz clic en el objeto que cae para que lo reconozca · Esc cancela');
    let done = false;
    const swallow = e => { if ((done || learning) && !ours(e)) { e.stopImmediatePropagation(); e.preventDefault(); } };
    const ours = e => ((e.composedPath && e.composedPath()) || []).some(el => el && el.id && /^__bb_(hub_root|hub_button|smart_bar)$/.test(el.id));
    const down = async e => {
      if (!learning || done || ours(e)) return;              // clicks on the Hub / Smart Bar are not the object
      e.stopImmediatePropagation(); e.preventDefault();       // the click must not reach the game (no walking, no picking up)
      done = true;
      const path = (e.composedPath && e.composedPath()) || [e.target];
      // Everything under the pointer, also what sits below an invisible click layer.
      let under = [];
      try { under = document.elementsFromPoint(e.clientX, e.clientY) || []; } catch (_) {}
      under = under.filter(el => { const r = el.getBoundingClientRect(); return r.width <= 320 && r.height <= 320 && !(el.id && /^__bb_/.test(el.id)); });
      const sig = signatureFromPath(path) || signatureFromPath(under);
      setTimeout(stopLearning, 400);
      if (!sig) {
        // The game paints it (canvas): learn it from a picture of that spot instead.
        try { await ipc.invoke('alerts:debug', describe(path) + '\n--- debajo ---\n' + describe(under)); } catch (_) {}
        try {
          const saved = await ipc.invoke('alerts:learn-visual', api.getProfileId(), { screenX: e.screenX, screenY: e.screenY });
          if (saved && saved.items) { setConfig(saved); api.notice('✓ Objeto aprendido por su forma. Sonará cuando vuelva a aparecer.'); return; }
        } catch (_) {}
        api.notice('No he podido aprender ese objeto. Prueba con «Subir imagen» en el BB Hub → Avisos.');
        return;
      }
      try {
        const saved = await ipc.invoke('alerts:save', { addItem: { src: sig.src, cls: sig.cls } });
        if (saved) setConfig(saved);
        api.notice('✓ Objeto aprendido. Sonará cuando vuelva a aparecer.');
      } catch (_) { api.notice('No se pudo guardar el objeto.'); }
    };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); stopLearning(); api.notice('Cancelado'); } };
    learning = { handlers: [['pointerdown', down], ['mousedown', swallow], ['pointerup', swallow], ['mouseup', swallow], ['click', swallow], ['keydown', key]] };
    for (const [t, f] of learning.handlers) window.addEventListener(t, f, true);
    learning.timer = setTimeout(() => { stopLearning(); api.notice('Tiempo agotado. Vuelve a pulsar «Aprender objeto».'); }, 60000);
  }

  function handleCommand(cmd) {
    if (!cmd || !inGame()) return;
    if (cmd.type === 'drop-alert-config') setConfig(cmd.config);
    else if (cmd.type === 'drop-alert-learn') learn();
    else if (cmd.type === 'drop-alert-ring') { if (cmd.sound !== false) chime(cmd.volume != null ? cmd.volume : cfg.volume); api.notice(`🔔 ${cmd.label || 'Objeto'}`); }
    else if (cmd.type === 'drop-alert-test') { chime(cmd.volume != null ? cmd.volume : cfg.volume); api.notice('🔔 Prueba de sonido'); }
  }

  return { start, scan, learn, stopLearning, handleCommand, setConfig, config: () => cfg, _test: { imageOf, signatureFromPath, visible } };
}

module.exports = { create, chime, normalizeConfig, cleanSrc, DEFAULT_CONFIG, MAX_ITEMS };
