'use strict';
// BB Smart Bar — runs inside the BoomBang game frame (loaded by game-preload.js).
//   GG            -> sends the "gg" text to the public chat
//   SRT           -> sends "srt {user}" with the user whose ficha (profile card) is open
//   Upper colours -> gold / black / brown / orange: opens the "+" of the upper, picks the colour
//   Ping          -> real ping to the game server (measured by the main process)
//
// The game's DOM is not known in advance, so the upper buttons work from a one-time
// guided calibration ("learn"): the launcher remembers what you clicked (image path /
// element signature + position) and replays it with a real mouse click.

// All 17 colours of the upper palette (names/tones read from the game's colour chooser).
const COLOR_CATALOG = [
  { id: 'red', label: 'Rojo', css: '#e3202c', wins: 0 }, { id: 'pink', label: 'Rosa', css: '#ff2fa3', wins: 1 }, { id: 'orange', label: 'Naranja', css: '#ff7a1a', wins: 10 },
  { id: 'green', label: 'Verde', css: '#2fe03c', wins: 25 }, { id: 'blue', label: 'Azul', css: '#5b8dff', wins: 50 }, { id: 'white', label: 'Blanco', css: '#ececf0', wins: 100 },
  { id: 'lavender', label: 'Lila', css: '#c7b3ff', wins: 250 }, { id: 'purple', label: 'Morado', css: '#a321f0', wins: 500 }, { id: 'olive', label: 'Olivo', css: '#8c9c12', wins: 1000 },
  { id: 'darkred', label: 'Rojo oscuro', css: '#a10f12', wins: 2000 }, { id: 'brown', label: 'Marrón', css: '#c2493c', wins: 3000 }, { id: 'teal', label: 'Celeste', css: '#3fd8d8', wins: 4000 },
  { id: 'gray', label: 'Gris', css: '#9c9ca2', wins: 5000 }, { id: 'black', label: 'Negro', css: '#2c2c30', wins: 8000 }, { id: 'gold', label: 'Dorado', css: '#ffac1f', wins: 10000 },
  { id: 'sage', label: 'Transparente', css: '#3f6a64', wins: 13000 }, { id: 'lightpink', label: 'Colorines', css: '#d9dde2', wins: 20000 }
];
const colorOf = id => COLOR_CATALOG.find(c => c.id === id) || null;
const UPPER_COLORS = ['gold', 'black', 'brown', 'orange'].map(colorOf);

// The bar is a list of items you can edit in the Hub: text buttons and upper-colour buttons.
const MAX_ITEMS = 10;
const DEFAULT_ITEMS = [
  { id: 'gg', type: 'text', label: 'GG', text: 'gg' },
  { id: 'srt', type: 'text', label: 'SRT', text: 'srt {user}' },
  ...UPPER_COLORS.map(c => ({ id: c.id, type: 'upper', color: c.id }))
];
// Returns null when there is no custom list (-> defaults); otherwise a cleaned list (may be empty).
function normalizeItems(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [], seen = new Set();
  for (const r of raw.slice(0, MAX_ITEMS)) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'upper') {
      if (!colorOf(r.color) || seen.has(r.color)) continue;
      seen.add(r.color); out.push({ id: r.color, type: 'upper', color: r.color });
    } else if (r.type === 'text') {
      const text = String(r.text == null ? '' : r.text).slice(0, 120);
      if (!text.trim()) continue;
      let id = /^[\w-]{1,24}$/.test(String(r.id || '')) ? String(r.id) : 't' + Math.random().toString(36).slice(2, 8);
      if (seen.has(id) || colorOf(id)) id = 't' + Math.random().toString(36).slice(2, 8);
      seen.add(id);
      const label = String(r.label == null ? '' : r.label).trim().slice(0, 10) || text.trim().slice(0, 6);
      out.push({ id, type: 'text', label, text });
    }
  }
  return out;
}


// ---- hotkeys: stored as text such as "Ctrl+Shift+S", "F2" or "Alt+1" in clientSettings.hotkeys
const DEFAULT_HOTKEYS = { srt: 'Ctrl+Shift+S', gg: 'Ctrl+Shift+G', gold: 'Ctrl+Shift+1', black: 'Ctrl+Shift+2', brown: 'Ctrl+Shift+3', orange: 'Ctrl+Shift+4', toggle: 'Ctrl+Shift+B' };
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;
const KEY_NAMES = { Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Space: 'Space' };
function comboFromEvent(e) {
  const code = String(e.code || '');
  if (!code || MODIFIER_CODES.test(code)) return null;          // a modifier on its own is not a hotkey
  let key = KEY_NAMES[code] || code;
  const m = code.match(/^Key([A-Z])$/) || code.match(/^Digit(\d)$/);
  if (m) key = m[1]; else if (/^Numpad/.test(code)) key = 'Num' + code.slice(6);
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl'); if (e.altKey) parts.push('Alt'); if (e.shiftKey) parts.push('Shift'); if (e.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const normName = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

function visible(el) {
  if (!el || el.nodeType !== 1) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
}
function cleanSrc(src) {
  try { return new URL(String(src || ''), location.href).pathname; } catch (_) { return String(src || '').split(/[?#]/)[0]; }
}
function classOf(el) { const c = el?.className; return String(c && c.baseVal !== undefined ? c.baseVal : c || ''); }
function centre(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

const JUNK_NAMES = /^(perfil|usuario|mensaje|message|cerrar|opciones|boombang|online|offline|jugar|entrar|upper|atacar|golpear|publico|público|ficha|ring|chat|tienda|shop|amigos|nivel|level)$/i;
function cleanUserCandidate(value) {
  const x = String(value || '').replace(/\s+/g, ' ').trim();
  if (!x || x.length > 32) return '';
  // FIX: names made only of numbers ("0", "123") and 1-character names are valid BoomBang users.
  // Only reject UI words and text without any letter or digit.
  if (JUNK_NAMES.test(x) || !/[\p{L}\p{N}]/u.test(x)) return '';
  return x;
}

const BAR_CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{position:fixed;z-index:2147483000;font:600 12px/1 "Segoe UI",system-ui,sans-serif;color:#ece8ff;user-select:none;-webkit-user-select:none;pointer-events:none}
.wrap.hidden{display:none}
.bar{pointer-events:auto;display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:16px;position:relative;overflow:hidden;
  background:linear-gradient(135deg,rgba(58,40,120,.88),rgba(12,20,52,.86) 55%,rgba(30,24,84,.88));
  -webkit-
  border:1px solid rgba(190,170,255,.30);
  box-shadow:0 10px 34px rgba(8,4,36,.55),inset 0 1px 0 rgba(255,255,255,.20),inset 0 -1px 0 rgba(120,90,255,.18)}
.bar::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.16) 50%,transparent 65%);transform:translateX(-120%)}
.bar:hover::after{transition:transform .9s ease;transform:translateX(120%)}
.grip{cursor:grab;padding:4px 3px;letter-spacing:-2px;color:#a898ff;opacity:.8;font-size:13px}
.grip:active{cursor:grabbing}
.chip{all:unset;cursor:pointer;padding:8px 12px;border-radius:11px;font:800 12px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.06em;color:#f4f0ff;
  background:linear-gradient(160deg,rgba(150,120,255,.40),rgba(70,60,190,.34));border:1px solid rgba(200,185,255,.30);
  transition:transform .12s ease,filter .12s ease,box-shadow .12s ease}
.chip:hover{filter:brightness(1.22);transform:translateY(-1px);box-shadow:0 6px 16px rgba(120,90,255,.35)}
.chip:active{transform:translateY(0) scale(.96)}
.sep{width:1px;height:20px;background:linear-gradient(transparent,rgba(190,170,255,.45),transparent);margin:0 2px}
.items{display:contents}
.dot{all:unset;cursor:pointer;width:26px;height:26px;border-radius:50%;position:relative;--hi:color-mix(in srgb,var(--c) 42%,#fff);
  background:radial-gradient(circle at 34% 28%,var(--hi),var(--c) 58%,rgba(0,0,0,.55) 130%);
  border:1.5px solid rgba(255,255,255,.55);box-shadow:0 3px 10px rgba(0,0,0,.45),inset 0 -3px 5px rgba(0,0,0,.28);
  transition:transform .12s ease,box-shadow .12s ease,opacity .2s}
.dot:hover{transform:translateY(-2px) scale(1.12);box-shadow:0 8px 18px rgba(0,0,0,.5),0 0 14px var(--c)}
.dot:active{transform:scale(.92)}
.dot[data-up="sage"]{background:radial-gradient(circle at 30% 30%,rgba(255,255,255,.55) 0 2px,transparent 3px),radial-gradient(circle at 62% 40%,rgba(180,255,230,.7) 0 1.5px,transparent 2.5px),radial-gradient(circle at 45% 68%,rgba(180,255,230,.6) 0 1.5px,transparent 2.5px),radial-gradient(circle at 70% 70%,rgba(255,255,255,.5) 0 1px,transparent 2px),radial-gradient(circle at 34% 28%,#7fa79f,#2e524c 60%,#13221f 130%)}
.dot[data-up="lightpink"]{background:radial-gradient(circle at 34% 28%,#fff,rgba(255,255,255,0) 50%),conic-gradient(from 40deg,#e6e9ee,#ffd6ec,#e6e9ee,#d4f2ff,#e6e9ee,#fff3c9,#e6e9ee),#d9dde2}
.dot.todo{opacity:.55}
.dot.todo::after{content:"?";position:absolute;right:-3px;top:-5px;font:900 9px/12px "Segoe UI",sans-serif;width:12px;height:12px;text-align:center;border-radius:50%;background:#7c5cff;color:#fff}
.dot.busy{animation:pulse .7s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 0 5px rgba(255,255,255,.28),0 0 16px var(--c)}}
.ping{display:flex;align-items:center;gap:5px;padding:0 4px;color:#cfc6ff;font-variant-numeric:tabular-nums}
.pdot{width:7px;height:7px;border-radius:50%;background:#7d7a96;box-shadow:0 0 0 0 transparent;transition:background .3s}
.ping.good .pdot{background:#4ff0a0;box-shadow:0 0 8px #4ff0a0}.ping.mid .pdot{background:#ffd25a;box-shadow:0 0 8px #ffd25a}.ping.bad .pdot{background:#ff6b7a;box-shadow:0 0 8px #ff6b7a}
.ping small{opacity:.6;font-size:10px}
.gear{all:unset;cursor:pointer;width:24px;height:24px;display:grid;place-items:center;border-radius:8px;color:#b9acff;font-size:14px;transition:background .15s,transform .3s}
.gear:hover{background:rgba(160,140,255,.22);transform:rotate(60deg)}
.hint{pointer-events:none;position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);white-space:nowrap;padding:9px 14px;border-radius:12px;font:700 12px/1 "Segoe UI",system-ui,sans-serif;color:#fff;
  background:linear-gradient(135deg,rgba(110,70,255,.92),rgba(60,40,170,.92));border:1px solid rgba(220,205,255,.5);box-shadow:0 10px 30px rgba(60,30,200,.5)}
.hint[hidden]{display:none}
@media (prefers-reduced-motion:reduce){.bar::after,.dot,.chip,.gear{transition:none}.dot.busy{animation:none}}
`;

function create(api) {
  const ipc = api.ipcRenderer;
  let host = null, root = null, wrap = null, hintEl = null;
  let focusedUser = '';
  let moveState = null, justDragged = false;
  let busy = false;
  let learning = null;           // { steps:[{kind,color}], i, onDone }
  let learnHandlers = null;
  let pingValue = null;
  let loginCache = { t: 0, v: false };
  let timers = [];

  // The launcher also broadcasts commands to the OUTER boombang.tv page. The bar must live ONLY in the game frame,
  // otherwise a second (dead) bar appears there whenever settings are saved.
  const inGame = () => (typeof api.isGameFrame === 'function' ? !!api.isGameFrame() : true);
  const pid = () => String(api.getProfileId() || '');
  const settings = () => api.getSettings() || {};
  const items = () => { const n = normalizeItems(settings().smartBarItems); return n === null ? DEFAULT_ITEMS : n; };
  const showPing = () => settings().smartBarShowPing !== false;
  const showGear = () => settings().smartBarShowGear !== false || items().length === 0;   // never lock yourself out of the Hub
  const hotkeys = () => {
    const custom = settings().hotkeys && typeof settings().hotkeys === 'object' ? settings().hotkeys : {};
    const out = {};
    for (const it of items()) out[it.id] = typeof custom[it.id] === 'string' ? custom[it.id] : (DEFAULT_HOTKEYS[it.id] || '');   // '' = no hotkey
    out.toggle = typeof custom.toggle === 'string' ? custom.toggle : DEFAULT_HOTKEYS.toggle;
    return out;
  };
  let titleSig = '', itemsSig = '';
  function refreshTitles() {
    if (!root) return;
    const hk = hotkeys(); const sig = JSON.stringify([hk, items()]);
    if (sig === titleSig) return; titleSig = sig;
    for (const it of items()) {
      const btn = root.querySelector(`[data-item="${it.id}"]`); if (!btn) continue;
      const tag = hk[it.id] ? ` · ${hk[it.id]}` : '';
      btn.title = it.type === 'text'
        ? (it.text.includes('{user}') ? `${it.text} (usuario fichado)` : it.text) + tag
        : `Upper ${colorOf(it.color).label} (${Number(colorOf(it.color).wins).toLocaleString('es-ES')} ${colorOf(it.color).wins === 1 ? 'victoria' : 'victorias'})${tag} · clic derecho: recalibrar`;
    }
  }
  const loginIsVisible = () => {
    const now = performance.now();
    if (now - loginCache.t > 700) { loginCache = { t: now, v: !!api.loginVisible() }; }
    return loginCache.v;
  };

  // ------------------------------------------------------------------ focused user (SRT)
  function panelTitle(rootEl) {
    // The player's name is the BIGGEST text in the ficha header. Only that text is considered:
    // if it is not a usable name we return nothing, instead of falling back to the status bubble.
    const own = new Set(api.ownNames().map(normName).filter(Boolean));
    let bestRaw = '', bestSize = -1, bestTop = 1e9, n = 0;
    for (const el of [rootEl, ...rootEl.querySelectorAll('*')]) {
      if (++n > 400) break;
      let text = '';
      for (const c of el.childNodes) if (c.nodeType === 3) text += c.nodeValue;
      text = text.replace(/\s+/g, ' ').trim();
      if (!text || text.length > 32 || !visible(el)) continue;
      if (own.has(normName(text))) continue;                       // our own name is never the target
      const size = parseFloat(getComputedStyle(el).fontSize) || 0;
      const top = el.getBoundingClientRect().top;
      if (size > bestSize + 0.5 || (Math.abs(size - bestSize) <= 0.5 && top < bestTop)) { bestRaw = text; bestSize = size; bestTop = top; }
    }
    return cleanUserCandidate(bestRaw);
  }
  function scanFocusedUser() {
    try {
      const sel = 'img[src*="/avatars/fichaface/"],img[src*="/avatars/miniface/"],[class*="ficha" i],[id*="ficha" i],[class*="profile-card" i],[class*="user-card" i],[class*="selected-user" i],[data-selected="true"]';
      const seen = new Set();
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        const rootEl = el.closest('[role="dialog"],[class*="ficha" i],[class*="profile" i],[class*="card" i],[class*="panel" i]') || el.parentElement || el;
        if (seen.has(rootEl)) continue; seen.add(rootEl);
        const name = panelTitle(rootEl);
        if (name) {
          if (name !== focusedUser) { focusedUser = name; try { ipc.send('client:focused-user', pid(), name); } catch (_) {} }
          return focusedUser;
        }
      }
    } catch (_) {}
    // FIX: no ficha open (or no readable name) -> forget the previous user, so SRT never goes to the wrong person.
    if (focusedUser) { focusedUser = ''; try { ipc.send('client:focused-user', pid(), ''); } catch (_) {} }
    return '';
  }

  // ------------------------------------------------------------------ chat
  function sendChat(textIn) {
    let value = String(textIn || '').trim();
    if (!value) return false;
    if (value.includes('{user}')) {
      const user = scanFocusedUser();
      if (!user) { api.notice('SRT · Abre la ficha de un jugador y vuelve a pulsar.'); return false; }
      value = value.replaceAll('{user}', user);
    }
    const stage = document.querySelector('#BoomBangStage');
    if (!stage) return false;
    const sr = stage.getBoundingClientRect();
    const inputs = [...stage.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 140 && r.height > 12 && r.bottom > sr.top + sr.height * 0.65 && visible(el);
    });
    const score = el => {
      const meta = `${el.id} ${classOf(el)} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      let n = 0;
      if (/chat|mensaje|message|escrib/.test(meta)) n += 15;
      if (/public|público|publico|chatear/.test(meta)) n += 8;
      const r = el.getBoundingClientRect();
      n += Math.min(8, Math.max(0, (r.bottom - (sr.top + sr.height * 0.65)) / 50));
      n += Math.min(5, r.width / 180);
      return n;
    };
    const chat = inputs.sort((a, b) => score(b) - score(a))[0];
    if (!chat || score(chat) < 3) { api.notice(`${value} · no encuentro el chat público.`); return false; }
    try {
      chat.focus();
      if (chat.isContentEditable) { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value); }
      else {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(chat), 'value')?.set;
        if (setter) setter.call(chat, value); else chat.value = value;
        chat.dispatchEvent(new Event('input', { bubbles: true }));
        chat.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setTimeout(() => {
        try {
          const form = chat.closest?.('form');
          const send = [...stage.querySelectorAll('button,[role="button"]')].find(btn => {
            const meta = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.innerText || ''}`.toLowerCase();
            const r = btn.getBoundingClientRect();
            return r.bottom > sr.top + sr.height * 0.65 && /enviar|send|publicar|chat/.test(meta) && r.width > 20 && r.height > 12;
          });
          if (form?.requestSubmit) { form.requestSubmit(); return; }
          if (send) { send.click(); return; }
          chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        } catch (_) {}
      }, 45);
      api.notice(`Enviado: ${value.length > 40 ? value.slice(0, 40) + '…' : value}`);
      return true;
    } catch (_) { return false; }
  }
  async function runText(it) {
    let text = it.text;
    // Until you customise the bar, GG/SRT keep using the texts saved in the old Hub shortcuts.
    if (!Array.isArray(settings().smartBarItems) && (it.id === 'gg' || it.id === 'srt')) {
      try { const d = await ipc.invoke('hub:get-data', pid()); text = d?.shortcuts?.[it.id] || text; } catch (_) {}
    }
    return sendChat(text);
  }
  function runItem(it) { return it.type === 'text' ? runText(it) : giveUpper(it.color); }
  function runShortcut(kind) { const it = items().find(x => x.id === kind) || DEFAULT_ITEMS.find(x => x.id === kind); return it ? runText(it) : false; }

  // ------------------------------------------------------------------ upper colours
  const learned = () => settings().upperColors || { plus: null, colors: {} };

  function signatureFor(el) {
    let t = el;
    for (let i = 0; i < 4 && t && t !== document.body && t !== document.documentElement; i++) {
      if (t.tagName === 'IMG' || t.tagName === 'BUTTON' || t.getAttribute?.('role') === 'button' || getComputedStyle(t).cursor === 'pointer') break;
      t = t.parentElement;
    }
    if (!t || t === document.body || t === document.documentElement) t = el;
    const r = t.getBoundingClientRect();
    const img = t.tagName === 'IMG' ? t : t.querySelector?.('img');
    return {
      tag: t.tagName, src: cleanSrc(img?.currentSrc || img?.src || ''), cls: classOf(t).slice(0, 140),
      txt: String(t.textContent || '').trim().slice(0, 24),
      nx: (r.left + r.width / 2) / (window.innerWidth || 1), ny: (r.top + r.height / 2) / (window.innerHeight || 1),
      w: Math.round(r.width), h: Math.round(r.height)
    };
  }
  function locate(sig) {
    if (!sig) return null;
    const cx = sig.nx * window.innerWidth, cy = sig.ny * window.innerHeight;
    let pool = [];
    if (sig.src) pool = [...document.querySelectorAll('img')].filter(im => cleanSrc(im.currentSrc || im.src) === sig.src && visible(im));
    else if (sig.cls || sig.txt) {
      pool = [...document.querySelectorAll(String(sig.tag || 'div').toLowerCase())].filter(el =>
        classOf(el).slice(0, 140) === sig.cls && (!sig.txt || String(el.textContent || '').trim().slice(0, 24) === sig.txt) && visible(el));
    }
    let best = null, bd = Infinity;
    for (const el of pool) { const c = centre(el); const d = Math.hypot(c.x - cx, c.y - cy); if (d < bd) { bd = d; best = el; } }
    if (best) return { el: best, ...centre(best) };
    // Not a DOM element we can recognise (e.g. drawn on a canvas): fall back to the learned position.
    if (!sig.src && !sig.cls && !sig.txt) return { el: null, x: cx, y: cy, virtual: true };
    return null;
  }
  async function clickAt(x, y) {
    try { const r = await ipc.invoke('client:game-click', pid(), { x, y }); if (r && r.ok) return true; } catch (_) {}
    const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;   // fallback: synthetic events
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts));
    }
    return true;
  }
  async function giveUpper(colorId) {
    const color = colorOf(colorId);
    if (!color || busy) return false;
    const cfg = learned();
    if (!cfg.plus || !cfg.colors?.[colorId]) {
      api.notice(`Upper ${color.label} · hay que calibrar una vez (⚙ → Smart Bar).`);
      learn(cfg.plus ? [{ kind: 'color', color: colorId }] : [{ kind: 'plus' }, { kind: 'color', color: colorId }]);
      return false;
    }
    busy = true; setBusy(colorId, true);
    try {
      let target = locate(cfg.colors[colorId]);
      if (!target || target.virtual) {                     // colour popup not open yet -> press the "+"
        const plus = locate(cfg.plus);
        if (!plus || plus.virtual) { api.notice('Upper · no veo la ficha. Abre la ficha del jugador primero.'); return false; }
        await clickAt(plus.x, plus.y);
        const sig = cfg.colors[colorId];
        if (!sig.src && !sig.cls && !sig.txt) { await sleep(220); target = locate(sig); }
        else for (let i = 0; i < 24 && !(target && !target.virtual); i++) { await sleep(40); target = locate(sig); }
        if (!target) {
          const sigOnly = cfg.colors[colorId];
          if (!sigOnly.src && !sigOnly.cls && !sigOnly.txt) target = { x: sigOnly.nx * window.innerWidth, y: sigOnly.ny * window.innerHeight };
        }
      }
      if (!target) { api.notice(`Upper ${color.label} · no encuentro el color. Recalibra.`); return false; }
      await clickAt(target.x, target.y);
      api.notice(`Upper ${color.label}`);
      return true;
    } finally { busy = false; setBusy(colorId, false); }
  }

  // ------------------------------------------------------------------ calibration ("learn")
  const STEP_TEXT = {
    plus: 'Pulsa el  +  del upper en la ficha',
    color: c => `Con la paleta abierta, pulsa el color ${(colorOf(c)?.label || c).toUpperCase()}  (no se enviará)`
  };
  function showHint(text) { if (!hintEl) return; hintEl.textContent = text || ''; hintEl.hidden = !text; }
  function stopLearning() {
    if (learnHandlers) { for (const [t, f] of learnHandlers) window.removeEventListener(t, f, true); learnHandlers = null; }
    learning = null; showHint('');
  }
  function learn(steps, onDone) {
    stopLearning();
    if (!steps || !steps.length) return;
    if (!host) install();
    learning = { steps, i: 0, onDone, lastAt: -1000, swallowCurrent: false };
    showHint(stepText());
    const ownEvent = e => e.composedPath && e.composedPath().includes(host);
    const down = e => {
      if (!learning || ownEvent(e)) return;
      const isDown = e.type === 'pointerdown' || e.type === 'mousedown';
      if (isDown && e.timeStamp - learning.lastAt >= 350) {          // a new click (not the duplicate mouse event)
        const step = learning.steps[learning.i];
        if (!step) return;
        const target = (e.composedPath && e.composedPath()[0]) || e.target;   // what the user actually clicked
        const sig = signatureFor(target);
        const cfg = JSON.parse(JSON.stringify(learned()));
        cfg.colors = cfg.colors || {};
        if (step.kind === 'plus') cfg.plus = sig; else cfg.colors[step.color] = sig;
        api.saveSettings({ upperColors: cfg });
        learning.lastAt = e.timeStamp;
        learning.swallowCurrent = step.kind === 'color';             // colour clicks must NOT reach the game (would give an upper)
        learning.i += 1; refreshDots();
        if (learning.i >= learning.steps.length) { const cb = learning.onDone; stopLearningSoon(); api.notice('Calibración guardada ✓'); if (cb) cb(); }
        else showHint(stepText());
      }
      if (learning && learning.swallowCurrent && e.timeStamp - learning.lastAt < 700) { e.stopImmediatePropagation(); e.preventDefault(); }
    };
    const key = e => { if (e.key === 'Escape') { stopLearning(); api.notice('Calibración cancelada'); } };
    learnHandlers = [['pointerdown', down], ['mousedown', down], ['pointerup', down], ['mouseup', down], ['click', down], ['keydown', key]];
    for (const [t, f] of learnHandlers) window.addEventListener(t, f, true);
  }
  function stopLearningSoon() { setTimeout(stopLearning, 700); showHint(''); }
  function stepText() {
    const s = learning.steps[learning.i];
    return `${learning.i + 1}/${learning.steps.length} · ` + (s.kind === 'plus' ? STEP_TEXT.plus : STEP_TEXT.color(s.color)) + '   (Esc cancela)';
  }
  function learnAll() {
    const colors = items().filter(i => i.type === 'upper');
    if (!colors.length) { api.notice('No hay colores de upper en la barra. Añade uno en el Hub.'); return; }
    learn([{ kind: 'plus' }, ...colors.map(c => ({ kind: 'color', color: c.color }))]);
  }
  function resetLearning() { api.saveSettings({ upperColors: null }); refreshDots(); api.notice('Calibración borrada'); }

  // ------------------------------------------------------------------ bar UI
  function build() {
    host = document.createElement('div');
    host.id = '__bb_smart_bar';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${BAR_CSS}</style><div class="wrap"><div class="bar">
      <span class="grip" title="Arrastra para mover · doble clic para centrar">⋮⋮</span>
      <div class="items"></div>
      <i class="sep tail"></i>
      <span class="ping" title="Ping al servidor"><b class="pdot"></b><span class="pv">--</span><small>ms</small></span>
      <button class="gear" data-act="hub" title="Abrir BB Hub">⚙</button>
    </div><div class="hint" hidden></div></div>`;
    wrap = root.querySelector('.wrap'); hintEl = root.querySelector('.hint');
    root.addEventListener('click', e => {
      if (justDragged) return;
      const t = e.target.closest('[data-item],[data-act]'); if (!t) return;
      if (t.dataset.act === 'hub') ipc.invoke('client:panel-action', pid(), 'open-hub', { tab: 'smartbar' }).catch(() => {});
      else if (t.dataset.item) { const it = items().find(x => x.id === t.dataset.item); if (it) runItem(it); }
    });
    root.addEventListener('contextmenu', e => {
      const t = e.target.closest('[data-up]'); if (!t) return;
      e.preventDefault();
      const c = t.dataset.up, cfg = learned();
      learn(cfg.plus ? [{ kind: 'color', color: c }] : [{ kind: 'plus' }, { kind: 'color', color: c }]);
    });
    root.addEventListener('dblclick', e => { if (e.target.closest('.grip')) { api.saveSettings({ smartBarDock: 'bottom-center' }); place(); } });
    root.addEventListener('mousedown', dragStart);
    window.addEventListener('mousemove', dragMove, true);
    window.addEventListener('mouseup', dragEnd, true);
    window.addEventListener('resize', place, { passive: true });
  }
  function place() {
    if (!wrap) return;
    const s = settings();
    if (s.smartBarDock === 'free' && Number.isFinite(s.smartBarX)) {
      const w = wrap.offsetWidth || 420, h = wrap.offsetHeight || 44;
      const x = Math.max(4, Math.min((window.innerWidth || 1012) - w - 4, s.smartBarX));
      const y = Math.max(4, Math.min((window.innerHeight || 657) - h - 4, s.smartBarY));
      Object.assign(wrap.style, { left: x + 'px', top: y + 'px', bottom: 'auto', transform: 'none' });
    } else {
      Object.assign(wrap.style, { left: '50%', top: 'auto', bottom: '48px', transform: 'translateX(-50%)' });
    }
  }
  function dragStart(e) {
    if (e.button !== 0 || !e.target.closest('.grip')) return;
    const r = wrap.getBoundingClientRect();
    moveState = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    e.preventDefault();
  }
  function dragMove(e) {
    if (!moveState) return;
    const dx = e.clientX - moveState.sx, dy = e.clientY - moveState.sy;
    if (!moveState.moved) { if (Math.abs(dx) + Math.abs(dy) < 4) return; moveState.moved = true; }
    const w = wrap.offsetWidth || 420, h = wrap.offsetHeight || 44;
    const x = Math.max(4, Math.min(window.innerWidth - w - 4, moveState.ox + dx));
    const y = Math.max(4, Math.min(window.innerHeight - h - 4, moveState.oy + dy));
    Object.assign(wrap.style, { left: x + 'px', top: y + 'px', bottom: 'auto', transform: 'none' });
    moveState.x = x; moveState.y = y;
  }
  function dragEnd() {
    if (!moveState) return;
    const m = moveState; moveState = null;
    if (!m.moved) return;
    justDragged = true; setTimeout(() => { justDragged = false; }, 80);
    api.saveSettings({ smartBarDock: 'free', smartBarX: m.x, smartBarY: m.y });
  }
  function renderItems() {
    const box = root.querySelector('.items'); if (!box) return;
    box.textContent = '';
    let prev = null;
    for (const it of items()) {
      if (prev && prev !== it.type) { const sep = document.createElement('i'); sep.className = 'sep'; box.appendChild(sep); }
      prev = it.type;
      const b = document.createElement('button'); b.dataset.item = it.id;
      if (it.type === 'text') { b.className = 'chip'; b.textContent = it.label; }
      else { const c = colorOf(it.color); b.className = 'dot'; b.dataset.up = c.id; b.style.setProperty('--c', c.css); }
      box.appendChild(b);
    }
    refreshDots(); titleSig = ''; refreshTitles();
  }
  function syncItems() {
    if (!root) return;
    const sig = JSON.stringify([items(), showPing(), showGear()]);
    if (sig === itemsSig) return; itemsSig = sig;
    renderItems();
    const pingBox = root.querySelector('.ping'), gear = root.querySelector('.gear'), tail = root.querySelector('.tail');
    pingBox.style.display = showPing() ? '' : 'none';
    gear.style.display = showGear() ? '' : 'none';
    tail.style.display = items().length && (showPing() || showGear()) ? '' : 'none';
    place();
  }
  function setBusy(id, on) { root?.querySelector(`[data-up="${id}"]`)?.classList.toggle('busy', on); }
  function refreshDots() {
    if (!root) return;
    const cfg = learned();
    for (const b of root.querySelectorAll('[data-up]')) b.classList.toggle('todo', !(cfg.plus && cfg.colors?.[b.dataset.up]));
  }
  function setPing(ms) {
    pingValue = Number.isFinite(ms) ? ms : null;
    if (!root) return;
    const box = root.querySelector('.ping'); const pv = root.querySelector('.pv');
    pv.textContent = pingValue === null ? '--' : String(pingValue);
    box.classList.remove('good', 'mid', 'bad');
    if (pingValue !== null) box.classList.add(pingValue <= 80 ? 'good' : pingValue <= 160 ? 'mid' : 'bad');
  }
  function isVisible() { return settings().smartBar !== false && !loginIsVisible(); }
  function applyVisibility() { if (wrap) wrap.classList.toggle('hidden', !isVisible()); }
  function install() {
    if (!inGame()) return null;
    if (host && host.isConnected) { applyVisibility(); return host; }
    if (!document.documentElement) return null;
    for (const stray of document.querySelectorAll('#__bb_smart_bar')) if (stray !== host) stray.remove();   // never two bars
    if (!host) build();
    document.documentElement.appendChild(host);
    itemsSig = ''; syncItems(); setPing(pingValue); applyVisibility();
    return host;
  }
  function ensureMounted() { if (!inGame()) return; try { install(); syncItems(); applyVisibility(); refreshTitles(); } catch (_) {} }
  function toggle() {
    const next = !(settings().smartBar !== false);
    api.saveSettings({ smartBar: next });
    api.getSettings().smartBar = next;                 // local copy right away
    applyVisibility();
    api.notice(next ? 'Smart Bar visible' : 'Smart Bar oculta (Ctrl+Shift+B)');
  }

  // ------------------------------------------------------------------ hotkeys (Ctrl+Shift+…)
  function autoclickKeyList() {
    try { const k = typeof api.autoclickKeys === 'function' ? api.autoclickKeys() : null; return Array.isArray(k) && k.length ? k : ['F1', 'F2', 'F3']; } catch (_) { return ['F1', 'F2', 'F3']; }
  }
  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }
  function onKey(e) {
    if (e.repeat || window.__BB_HOTKEY_CAPTURE__) return;            // the Hub is recording a new hotkey
    const combo = comboFromEvent(e);
    if (!combo || autoclickKeyList().includes(combo)) return;   // the autoclick keys (F1/F2/F3 by default) belong to it
    const map = hotkeys();
    const action = Object.keys(map).find(k => map[k] && map[k] === combo);
    if (!action) return;
    // A plain key (no Ctrl/Alt/Meta, not F1-F12) must never steal what you type in the chat.
    const safeAlone = /(^|\+)F\d{1,2}$/.test(combo) || /(Ctrl|Alt|Meta)\+/.test(combo);
    if (!safeAlone && isTyping()) return;
    if (loginIsVisible()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (action === 'toggle') toggle();
    else { const it = items().find(x => x.id === action); if (it) runItem(it); }
  }

  function start() {
    if (!inGame()) return;
    install();
    window.addEventListener('keydown', onKey, true);
    // Cheap upkeep instead of a MutationObserver over the whole page: re-attach if the page removed us.
    timers.push(setInterval(ensureMounted, 1500));
    // Which ficha is open? Re-check right after clicks (ficha opens on click) + a slow safety poll.
    document.addEventListener('click', () => { setTimeout(scanFocusedUser, 250); setTimeout(scanFocusedUser, 900); }, true);
    timers.push(setInterval(() => { if (document.visibilityState === 'visible' && isVisible()) scanFocusedUser(); }, 2500));
  }

  function handleCommand(cmd) {
    if (!cmd || !inGame()) return;
    if (cmd.type === 'chat-shortcut') sendChat(cmd.payload?.text || '');
    else if (cmd.type === 'smartbar-force') { api.getSettings().smartBar = true; api.saveSettings({ smartBar: true }); ensureMounted(); }
    else if (cmd.type === 'smartbar-learn') {
      const p = cmd.payload || {};
      if (p.mode === 'reset') resetLearning();
      else if (p.mode === 'color' && p.color) learn([{ kind: 'color', color: String(p.color) }]);
      else if (p.mode === 'plus') learn([{ kind: 'plus' }]);
      else learnAll();
    }
    else if (cmd.type === 'smartbar-upper') giveUpper(String(cmd.payload?.color || ''));
  }

  const apiOut = {
    start, install, ensureMounted, handleCommand, toggle, setPing, applyVisibility,
    sendChat, runShortcut, giveUpper, learn, learnAll, resetLearning, scanFocusedUser,
    getFocusedUser: () => focusedUser, colors: COLOR_CATALOG, items, hotkeys, runItem,
    _test: { locate, signatureFor, cleanUserCandidate, panelTitle }
  };
  return apiOut;
}

module.exports = { create, UPPER_COLORS, COLOR_CATALOG, DEFAULT_ITEMS, DEFAULT_HOTKEYS, MAX_ITEMS, normalizeItems, comboFromEvent, cleanUserCandidate };
