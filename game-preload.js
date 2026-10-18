const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const profileArg = process.argv.find(arg => arg.startsWith('--bb-profile='));
const profileNameArg = process.argv.find(arg => arg.startsWith('--bb-profile-name='));
const profileId = profileArg ? profileArg.slice('--bb-profile='.length) : '';
const profileName = profileNameArg ? decodeURIComponent(profileNameArg.slice('--bb-profile-name='.length)) : 'BoomBang';

let autoLoginStarted = false;
let pendingCredentials = null;
let saveCheckRunning = false;
let outerStyleInstalled = false;
let innerStyleInstalled = false;
let clientSettings = { fitMode:'fill', zoom:100, showPerformance:false, showStatusBar:true, cleanMode:false, alwaysOnTop:false, muted:false, performanceMode:false, smartBar:true, smartBarX:10, smartBarY:10, smartBarCompact:false };
const SMARTBAR_BUILD = 'v0.22.0';
let statusHud = null;
let statusMessage = { state: 'connecting', latency: null };
let latencyProbeInFlight = false;
let statusTimer = null;
let connectionTimer = null;
let connectionFailures = 0;
let sessionStartedAt = Date.now();
let fpsFrameCount = 0;
let fpsLastTime = performance.now();
let currentFps = 0;
let clientNotice = null;
let accountUsername = '';
let stageTransformObserver = null;
let lastAppliedStageTransform = '';
let firstConnectionCheckDone = false;
let clientHubInstalled = false;
let fpsLoopId = null;
let loginObserver = null;
let sessionReadySent = false;
let gameAssist = { root: null, mode: 'off', markers: [], timer: null, timerEndsAt: 0, gameId: 'unknown', pointer: null, markerCount: 0, pen: { active: false, color: '#ff4d67', size: 6, strokes: [], drawing: false, current: null, dpr: 1 } };
const SCREEN_MARKER_GAME = 'sendero';
const ASSIST_NAV_HEIGHT = 80;
const screenMarkerAllowed = () => gameAssist.gameId === SCREEN_MARKER_GAME;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Login helpers. These are intentionally defensive because BoomBang has changed
// the markup of its login panel several times. The previous builds called these
// helpers without defining them, which made BOTH auto-login and Smart Bar visibility
// fail through loginVisible().
function visibleElement(el) {
  if (!(el instanceof Element)) return false;
  const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
}
function textOf(el) {
  if (!el) return '';
  return String(el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function findPassword() {
  const candidates = [...document.querySelectorAll('input[type="password"], #BoomBangLogin input[type="password"], form input[type="password"]')];
  return candidates.filter(visibleElement).sort((a,b)=>{
    const score = el => {
      const meta = `${el.name||''} ${el.id||''} ${el.placeholder||''} ${el.getAttribute?.('aria-label')||''}`.toLowerCase();
      return /pass|contraseña|password|clave/.test(meta) ? 20 : 0;
    };
    return score(b)-score(a);
  })[0] || null;
}
function findUsername() {
  const candidates = [...document.querySelectorAll('input:not([type="password"]), textarea, #BoomBangLogin input, form input')]
    .filter(el => visibleElement(el) && String(el.type||'').toLowerCase() !== 'hidden');
  return candidates
    .map(el => ({el,score:(() => {
      const meta = `${el.name||''} ${el.id||''} ${el.placeholder||''} ${el.getAttribute?.('aria-label')||''} ${el.autocomplete||''}`.toLowerCase();
      let n = 0;
      if (/user|usuario|username|nick|nombre|login|email|correo/.test(meta)) n += 20;
      if (/email|correo/.test(meta)) n += 3;
      if (el.closest?.('#BoomBangLogin, form')) n += 4;
      return n;
    })()}))
    .sort((a,b)=>b.score-a.score)[0]?.el || null;
}
function findRealLoginButton() {
  const roots = document.querySelectorAll('#BoomBangLogin, form, body');
  const candidates = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll?.('button, input[type="submit"], [role="button"], a') || []) {
      if (!visibleElement(el)) continue;
      const label = textOf(el);
      const meta = `${label} ${el.value||''} ${el.name||''} ${el.id||''} ${el.className||''} ${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''}`.toLowerCase();
      let score = 0;
      if (/^jugar$|^entrar$|^iniciar sesión$|^iniciar sesion$/.test(label)) score += 100;
      if (/jugar|entrar|iniciar|login|sign.?in|play/.test(meta)) score += 40;
      if (el.form) score += 8;
      if (el.type === 'submit') score += 10;
      const r = el.getBoundingClientRect();
      if (r.bottom > window.innerHeight * 0.25) score += 2;
      if (score > 0) candidates.push({el,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]?.el || null;
}
function nativeValue(el, value) {
  if (!el) return false;
  try {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, String(value ?? ''));
    else el.value = String(value ?? '');
  } catch (_) { try { el.value = String(value ?? ''); } catch (_) { return false; } }
  try {
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  } catch (_) {}
  return true;
}
function loginFieldsPresent() {
  return Boolean(findUsername() && findPassword());
}

// ---- Which password field is the LOGIN one? ----
// Inside the game there are other password fields (the exchange security key, for example). Those must never be read
// as your account: once you are in the game, nothing is captured until the real login screen shows up again.
let inGameSession = false;
const LOGIN_PANEL = '#BoomBangLogin, #bbLoginRoot';
function loginPanel() { return document.querySelector(LOGIN_PANEL); }
function loginPanelVisible() {
  const p = loginPanel();
  if (!p || !visibleElement(p)) return false;
  const pw = p.querySelector('input[type="password"]');
  return Boolean(pw && visibleElement(pw));
}
function markInGame() { if (!inGameSession) { inGameSession = true; pendingCredentials = null; } }
// Login fields only inside the login panel (when the game has one); otherwise only before the world is loaded.
function loginFieldsForCapture() {
  if (inGameSession) return null;
  const panel = loginPanel();
  if (panel) {
    if (!loginPanelVisible()) return null;
    const pw = [...panel.querySelectorAll('input[type="password"]')].find(visibleElement);
    const user = [...panel.querySelectorAll('input:not([type="password"]):not([type="hidden"])')].find(visibleElement);
    return pw && user ? { user, pw } : null;
  }
  const user = findUsername(), pw = findPassword();
  return user && pw ? { user, pw } : null;
}


async function loadAccountUsername() {
  if (!profileId) return '';
  try {
    const auth = await ipcRenderer.invoke('auth:get', profileId);
    accountUsername = String(auth?.username || '').trim();
  } catch (_) {}
  return accountUsername;
}

function loginVisible() {
  if (inGameSession) return loginPanelVisible();      // an in-game password box (exchange key...) is not the login
  const password = findPassword();
  if (password) {
    const style = getComputedStyle(password);
    if (style.display !== 'none' && style.visibility !== 'hidden') return true;
  }
  const overlay = document.querySelector('#BoomBangLogin');
  if (overlay) {
    const s = getComputedStyle(overlay);
    if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return true;
  }
  return false;
}

// The game world is on screen (big canvas), ignoring login state.
function worldLoadedRaw() {
  try { return [...document.querySelectorAll('canvas')].some(c => { const r = c.getBoundingClientRect(); return r.width >= 500 && r.height >= 300; }) && !loginPanelVisible(); } catch (_) { return false; }
}
function worldLoaded() {
  if (loginVisible()) return false;
  try {
    const canvases = [...document.querySelectorAll('canvas')];
    if (canvases.some(canvas => {
      const r = canvas.getBoundingClientRect();
      return r.width >= 500 && r.height >= 300;
    })) return true;
  } catch (_) {}
  const text = String(document.body?.innerText || '');
  return /Áreas\s+Juegos|Juegos\s+Islas|Islas\s+Casas|\bBuscar\b/.test(text)
    || Boolean(document.querySelector('#BoomBangContainer #BoomBangAlerts'));
}
function captureCredentials() {
  if (!profileId || inGameSession) return false;
  const f = loginFieldsForCapture();
  if (!f) return false;
  const user = String(f.user.value || '').trim();
  const pass = String(f.pw.value || '');
  if (!user || !pass) return false;
  pendingCredentials = { username: user, password: pass };
  return true;
}

async function savePendingAfterSuccess() {
  if (inGameSession) { pendingCredentials = null; return; }
  if (!pendingCredentials && loginFieldsPresent()) captureCredentials();
  if (saveCheckRunning || !pendingCredentials || !profileId) return;
  saveCheckRunning = true;
  for (const delay of [300, 700, 1200, 2000, 3000, 4500, 6500, 9000]) {
    await sleep(delay);
    if (worldLoaded()) {
      const creds = pendingCredentials;
      pendingCredentials = null;
      try {
        const ok = await ipcRenderer.invoke('auth:save', { profileId, username: creds.username, password: creds.password });
        console.log(`[BB Launcher] login correcto; credenciales guardadas=${ok}`);
        markInGame();
      } catch (error) {
        console.error('[BB Launcher] no se pudieron guardar credenciales:', error);
      }
      saveCheckRunning = false;
      return;
    }
  }
  saveCheckRunning = false;
}

async function autoLogin() {
  if (!profileId || autoLoginStarted || inGameSession || !loginVisible()) return;
  try {
    const launcherSettings = await ipcRenderer.invoke('settings:get');
    if (launcherSettings && launcherSettings.autoLogin === false) return;
  } catch (_) {}
  let creds = null;
  try { creds = await ipcRenderer.invoke('auth:get', profileId); } catch (error) { console.error('[BB Launcher] auth:get error', error); return; }
  if (!creds?.username || !creds?.password) return;
  const f = loginFieldsForCapture();
  const username = f && f.user, password = f && f.pw;
  const button = findRealLoginButton();
  if (!username || !password || !button) return;
  const label = textOf(button);
  if (!['jugar', 'entrar', 'iniciar sesión'].includes(label)) return;
  autoLoginStarted = true;
  nativeValue(username, creds.username);
  nativeValue(password, creds.password);
  await sleep(250);
  pendingCredentials = { username: creds.username, password: creds.password };
  button.click();
  savePendingAfterSuccess();
}

async function loadClientSettings() {
  if (!profileId) return;
  try {
    const saved = await ipcRenderer.invoke('client:get-settings', profileId);
    if (saved) clientSettings = { ...clientSettings, ...saved };
    if (!clientSettings.smartBarDock) clientSettings.smartBarDock='bottom-center';
    // One-time reset when the bar was redesigned, so an old hidden state cannot leave it invisible.
    if (saved?.smartBarBuild !== SMARTBAR_BUILD) {
      clientSettings.smartBar = true;
      clientSettings.smartBarDock = 'bottom-center';
      clientSettings.smartBarBuild = SMARTBAR_BUILD;
      await saveClientSettings({ smartBar: true, smartBarDock: 'bottom-center', smartBarBuild: SMARTBAR_BUILD });
    }
  } catch (_) {}
}

async function saveClientSettings(updates = {}) {
  clientSettings = { ...clientSettings, ...(updates || {}) };
  if (!profileId) return clientSettings;
  try {
    const saved = await ipcRenderer.invoke('client:save-settings', profileId, clientSettings);
    if (saved) clientSettings = { ...clientSettings, ...saved };
  } catch (_) {}
  return clientSettings;
}

function scaleStage() {
  const target = document.querySelector('#BoomBangStage');
  if (!target) return;
  const vw = Math.max(1, window.innerWidth || 1012);
  const vh = Math.max(1, window.innerHeight || 657);
  const zoom = Math.max(50, Math.min(150, Number(clientSettings.zoom) || 100)) / 100;
  let transform;
  if (clientSettings.fitMode === 'contain') {
    const scale = Math.min(vw / 1012, vh / 657) * zoom;
    transform = `translate(-50%, -50%) scale(${scale})`;
  } else if (clientSettings.fitMode === 'original') {
    transform = `translate(-50%, -50%) scale(${zoom})`;
  } else {
    const scaleX = (vw / 1012) * zoom;
    const scaleY = (vh / 657) * zoom;
    transform = `translate(-50%, -50%) scaleX(${scaleX}) scaleY(${scaleY})`;
  }
  // The scale lives in our stylesheet (through a CSS variable), not in the stage's own style attribute: when the game
  // rewrites that attribute, there is no frame where the stage jumps to the game's own size (that showed as a black flash).
  if (transform === lastAppliedStageTransform) return;
  lastAppliedStageTransform = transform;
  document.documentElement.style.setProperty('--bb-stage-tf', transform);
  if (target.style.getPropertyPriority('transform') === 'important') { target.style.removeProperty('transform'); target.style.removeProperty('transform-origin'); }
  logFlicker('escala', transform);
}

function installStageTransformGuard() {
  // Nothing to fight any more: the stylesheet rule always wins over the game's inline style. Only log it for the
  // flicker report, a few times at most.
  const target = document.querySelector('#BoomBangStage');
  if (!target || stageTransformObserver) return;
  let n = 0;
  stageTransformObserver = new MutationObserver(() => { if (++n <= 20) logFlicker('el juego cambió el estilo del escenario', String(target.getAttribute('style') || '').slice(0, 120)); });
  stageTransformObserver.observe(target, { attributes: true, attributeFilter: ['style'] });
}

// ---- Flicker report (parpadeos-log.txt): what happens in the game page around a black flash ----
const flickerQueue = []; let flickerTimer = null;
function logFlicker(what, detail = '') {
  flickerQueue.push(`${new Date().toLocaleTimeString('es-ES')}.${String(Date.now() % 1000).padStart(3, '0')} ${what}${detail ? ' · ' + detail : ''}`);
  if (flickerQueue.length > 200) flickerQueue.shift();
  if (!flickerTimer) flickerTimer = setTimeout(() => { flickerTimer = null; const lines = flickerQueue.splice(0); ipcRenderer.invoke('diag:flicker-log', lines).catch(() => {}); }, 2000);
}
function watchFlickers() {
  const seen = new WeakSet();
  const hook = c => {
    if (seen.has(c)) return; seen.add(c);
    c.addEventListener('webglcontextlost', () => logFlicker('⚠ el juego perdió la tarjeta gráfica (contexto WebGL perdido)'));
    c.addEventListener('webglcontextrestored', () => logFlicker('contexto WebGL recuperado'));
    let last = `${c.width}x${c.height}`;
    new MutationObserver(() => { const now = `${c.width}x${c.height}`; if (now !== last) { logFlicker('el lienzo del juego cambió de tamaño (se borra un instante)', `${last} → ${now}`); last = now; } })
      .observe(c, { attributes: true, attributeFilter: ['width', 'height'] });
  };
  const scan = () => { for (const c of document.querySelectorAll('canvas')) hook(c); };
  scan(); setInterval(scan, 5000);
  // Main-thread hitches: a pause of more than 150 ms between two frames.
  let prev = 0, hitches = 0;
  const loop = t => { if (prev && t - prev > 150 && document.visibilityState === 'visible' && ++hitches <= 300) logFlicker('tirón', `${Math.round(t - prev)} ms sin dibujar`); prev = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  logFlicker('registro iniciado', `${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || ''}`);
}

function buildStatusHud() {
  if (statusHud) return statusHud;
  statusHud = document.createElement('div');
  statusHud.id = '__bb_status_hud';
  statusHud.innerHTML = '<span class="bbhud-dot"></span><span class="bbhud-text">Comprobando…</span><span class="bbhud-sep">·</span><span class="bbhud-latency">-- ms</span><span class="bbhud-time"></span>';
  const css = document.createElement('style');
  css.textContent = `
    #__bb_status_hud{position:fixed;left:14px;bottom:14px;z-index:2147483646;display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;background:rgba(6,18,34,.78);border:1px solid rgba(255,255,255,.13);box-shadow:0 6px 20px rgba(0,0,0,.28);font:600 11px system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;pointer-events:none;transition:opacity .2s}
    .bbhud-dot{width:8px;height:8px;border-radius:50%;background:#8fa3b5;box-shadow:0 0 0 2px rgba(255,255,255,.06)}
    .bbhud-sep{opacity:.35}.bbhud-latency,.bbhud-time{opacity:.7}
    .bbhud-good .bbhud-dot{background:#49d17d;box-shadow:0 0 8px rgba(73,209,125,.4)}
    .bbhud-warn .bbhud-dot{background:#f2bd5b}.bbhud-bad .bbhud-dot{background:#e96767}
  `;
  document.head.appendChild(css);
  document.body.appendChild(statusHud);
  return statusHud;
}

function renderStatusHud() {
  const hud = buildStatusHud();
  const txt = hud.querySelector('.bbhud-text');
  const lat = hud.querySelector('.bbhud-latency');
  const tm = hud.querySelector('.bbhud-time');
  const mins = Math.floor((Date.now() - sessionStartedAt) / 60000);
  const secs = Math.floor(((Date.now() - sessionStartedAt) % 60000) / 1000);

  const state = statusMessage.state;
  txt.textContent = state === 'connected' ? 'Conectado' : state === 'login' ? 'Esperando login' : state === 'offline' ? 'Sin conexión' : firstConnectionCheckDone ? 'Conectando…' : 'Comprobando…';
  lat.textContent = Number.isFinite(statusMessage.latency) ? `${statusMessage.latency} ms` : '-- ms';
  tm.textContent = `Sesión ${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  hud.classList.toggle('bbhud-good', state === 'connected');
  hud.classList.toggle('bbhud-warn', state === 'connecting' || state === 'login');
  hud.classList.toggle('bbhud-bad', state === 'offline');
  hud.style.display = clientSettings.smartBar ? 'none' : (clientSettings.showStatusBar && !clientSettings.cleanMode ? 'flex' : 'none');
  try { smartbar.setPing(statusMessage.latency); smartbar.applyVisibility(); } catch (_) {}
}

async function probeConnection() {
  if (latencyProbeInFlight) return null;
  latencyProbeInFlight = true;
  try {
    const real = await ipcRenderer.invoke('client:probe-ping', profileId);      // ICMP ping to the game server
    if (Number.isFinite(real)) return real;
    const displayed = await ipcRenderer.invoke('client:probe-display-ping', profileId);  // number shown by the game itself
    return Number.isFinite(displayed) ? displayed : null;
  } catch (_) {
    return null;
  } finally {
    latencyProbeInFlight = false;
  }
}
async function refreshConnectionState() {
  if (loginVisible()) {
    statusMessage = { state: 'login', latency: statusMessage.latency };
    firstConnectionCheckDone = true;
    renderStatusHud();
    return;
  }

  const inWorld = worldLoaded();
  firstConnectionCheckDone = true;

  // A visible BoomBang canvas is our authoritative "connected" signal.
  // Ping is a secondary metric and never downgrades a working client.
  if (inWorld) {
    if (!pendingCredentials) markInGame();          // in the world: stop reading password boxes
    if (!sessionReadySent && profileId) {
      sessionReadySent = true;
      sessionStartedAt = Date.now();
      ipcRenderer.invoke('client:session-ready', profileId).catch(() => {});
    }
    statusMessage = { state: 'connected', latency: statusMessage.latency };
    renderStatusHud();
    const latency = await probeConnection();
    if (Number.isFinite(latency)) {
      connectionFailures = 0;
      statusMessage = { state: 'connected', latency };
      renderStatusHud();
    }
    return;
  }

  connectionFailures += 1;
  if (connectionFailures >= 3) {
    statusMessage = { state: 'offline', latency: statusMessage.latency };
  } else {
    statusMessage = { state: 'connecting', latency: statusMessage.latency };
  }
  renderStatusHud();
}
function ensureGameAssistRoot() {
  if (gameAssist.root && document.body.contains(gameAssist.root)) return gameAssist.root;
  const stage = document.querySelector('#BoomBangStage');
  if (!stage) return null;
  const root = document.createElement('div');
  root.id = '__bb_game_assist';
  root.innerHTML = '<div class="bb-assist-toolbar" aria-label="Marcador de pantalla">'
    + '<span class="bb-assist-title">SCREEN MARKER</span>'
    + '<button type="button" data-marker-mode="pen" title="Lápiz libre">✎</button>'
    + '<button type="button" data-marker-mode="mouse" title="Modo ratón">🖱</button>'
    + '<button type="button" data-marker-mode="wrong" title="Incorrecto">✕</button>'
    + '<button type="button" data-marker-mode="maybe" title="Posible">?</button>'
    + '<button type="button" data-marker-mode="safe" title="Seguro">✓</button>'
    + '<button type="button" data-marker-mode="target" title="Zona / objetivo">◎</button>'
    + '<span class="bb-assist-divider"></span>'
    + '<input class="bb-pen-color" type="color" value="#ff4d67" title="Color del lápiz">'
    + '<select class="bb-pen-size" title="Grosor"><option value="3">3px</option><option value="5">5px</option><option value="7" selected>7px</option><option value="10">10px</option><option value="14">14px</option></select>'
    + '<button type="button" data-pen-action="undo" title="Deshacer trazo">↶</button>'
    + '<button type="button" data-pen-action="clear" title="Borrar dibujo">⌫</button>'
    + '<button type="button" data-marker-action="undo" title="Deshacer último marcador">↶</button>'
    + '<button type="button" data-marker-action="clear" title="Borrar marcadores">🗑</button>'
    + '<button type="button" data-marker-action="close" title="Cerrar marcador">×</button>'
    + '<span class="bb-assist-count">0</span>'
    + '</div><canvas class="bb-assist-canvas" aria-hidden="true"></canvas>'
    + '<div class="bb-assist-marker-layer"></div>'
    + '<div class="bb-assist-timer"><span class="bb-assist-timer-label">TEMPORIZADOR</span><strong>00:00</strong></div>'
    + '<div class="bb-assist-hint"></div>';
  const css = document.createElement('style');
  css.textContent = `
    #__bb_game_assist{position:absolute;inset:0;z-index:2147483645;pointer-events:none;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
    #__bb_game_assist .bb-assist-toolbar{position:absolute;left:12px;top:84px;display:flex;align-items:center;gap:5px;padding:6px 7px;border-radius:12px;background:rgba(5,14,25,.88);border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 22px rgba(0,0,0,.25);pointer-events:auto;opacity:0;transform:translateY(-4px);transition:opacity .15s,transform .15s;white-space:nowrap}
    #__bb_game_assist.active .bb-assist-toolbar{opacity:1;transform:none}
    #__bb_game_assist.pen-draw .bb-assist-canvas{pointer-events:auto}
    #__bb_game_assist .bb-assist-toolbar button{width:30px;height:27px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:rgba(255,255,255,.05);color:#dbeeff;font:900 13px system-ui;cursor:pointer;display:grid;place-items:center;padding:0}
    #__bb_game_assist .bb-assist-toolbar button:hover{background:rgba(116,212,255,.14);border-color:rgba(116,212,255,.3)}
    #__bb_game_assist .bb-assist-toolbar button.active{background:rgba(116,212,255,.2);border-color:rgba(116,212,255,.45);color:#fff}
    #__bb_game_assist .bb-assist-toolbar button[data-marker-mode=mouse]{font-size:12px}
    #__bb_game_assist .bb-assist-title{font-size:7px;letter-spacing:.11em;font-weight:1000;color:#87a2ba;margin:0 2px 0 1px}
    #__bb_game_assist .bb-assist-divider{width:1px;height:18px;background:rgba(255,255,255,.1);margin:0 1px}
    #__bb_game_assist .bb-pen-color{width:27px;height:27px;padding:3px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:rgba(255,255,255,.05);cursor:pointer}
    #__bb_game_assist .bb-pen-size{height:27px;min-width:56px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:#0b1828;color:#dbeeff;font:800 9px system-ui;padding:0 5px;outline:none}
    #__bb_game_assist .bb-assist-count{min-width:18px;text-align:center;font-size:8px;font-weight:1000;color:#8fa8be}
    #__bb_game_assist .bb-assist-canvas{position:absolute;left:0;right:0;top:80px;bottom:0;width:100%;height:calc(100% - 80px);pointer-events:none;touch-action:none;cursor:crosshair}
    #__bb_game_assist .bb-assist-marker-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
    #__bb_game_assist .bb-marker{position:absolute;transform:translate(-50%,-50%);width:31px;height:31px;border-radius:50%;display:grid;place-items:center;font-weight:1000;font-size:15px;text-shadow:0 2px 5px rgba(0,0,0,.4);box-shadow:0 4px 12px rgba(0,0,0,.28),inset 0 0 0 2px rgba(255,255,255,.75);animation:bbMarkerIn .14s ease-out}
    #__bb_game_assist .bb-marker.target{width:38px;height:38px;font-size:24px;background:rgba(90,169,255,.26)!important;border:2px solid rgba(122,195,255,.95);box-shadow:0 0 0 3px rgba(90,169,255,.12),0 5px 16px rgba(0,0,0,.28)}
    #__bb_game_assist.mode-wrong{cursor:not-allowed}
    #__bb_game_assist.mode-maybe{cursor:help}
    #__bb_game_assist.mode-safe{cursor:crosshair}
    #__bb_game_assist.mode-target{cursor:crosshair}
    #__bb_game_assist .bb-assist-timer{position:absolute;left:50%;top:84px;transform:translateX(-50%);min-width:108px;padding:6px 10px;border-radius:12px;background:rgba(5,14,25,.78);border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 20px rgba(0,0,0,.22);color:#e9f4ff;text-align:center;opacity:0;transition:opacity .15s;}
    #__bb_game_assist .bb-assist-timer.show{opacity:1}
    #__bb_game_assist .bb-assist-timer-label{display:block;font-size:7px;letter-spacing:.16em;opacity:.55;margin-bottom:2px}
    #__bb_game_assist .bb-assist-timer strong{font-size:16px;font-variant-numeric:tabular-nums}
    #__bb_game_assist .bb-assist-hint{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);padding:6px 9px;border-radius:999px;background:rgba(5,14,25,.78);border:1px solid rgba(255,255,255,.1);color:#d5e6f5;font-size:9px;font-weight:900;opacity:0;transition:opacity .15s;white-space:nowrap;pointer-events:none}
    #__bb_game_assist.hint .bb-assist-hint{opacity:1}
    #__bb_game_assist.pen-draw .bb-assist-hint{opacity:1}
    @keyframes bbMarkerIn{from{opacity:0;transform:translate(-50%,-50%) scale(.72)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
  `;
  document.head.appendChild(css);
  stage.appendChild(root);
  gameAssist.root = root;
  gameAssist.pointer = null;
  root.style.setProperty('--bb-assist-nav-height', `${ASSIST_NAV_HEIGHT}px`);
  const color = root.querySelector('.bb-pen-color');
  const size = root.querySelector('.bb-pen-size');
  if (color) color.addEventListener('input', () => { gameAssist.pen.color = color.value || '#ff4d67'; });
  if (size) size.addEventListener('change', () => { gameAssist.pen.size = Number(size.value) || 7; });
  installGameAssistPointerHandlers(stage);
  resizeGameAssistCanvas();
  return root;
}

function resizeGameAssistCanvas() {
  const root = gameAssist.root;
  const canvas = root?.querySelector('.bb-assist-canvas');
  if (!root || !canvas) return;

  const width = Math.max(1, canvas.clientWidth || root.clientWidth || 1);
  const height = Math.max(1, canvas.clientHeight || (root.clientHeight - ASSIST_NAV_HEIGHT) || 1);
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const backingWidth = Math.max(1, Math.round(width * dpr));
  const backingHeight = Math.max(1, Math.round(height * dpr));

  gameAssist.pen.dpr = dpr;
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  canvas.style.top = `${ASSIST_NAV_HEIGHT}px`;
  canvas.style.height = `calc(100% - ${ASSIST_NAV_HEIGHT}px)`;
  canvas.style.width = '100%';
  redrawPenCanvas();
}
function penPointFromEvent(event, canvas = gameAssist.root?.querySelector('.bb-assist-canvas')) {
  if (!canvas) return null;
  // client coordinates + the canvas' transformed visual rect are the reliable
  // mapping when the entire BoomBang stage is zoomed/scaled by CSS.
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

function redrawPenCanvas() {
  const canvas = gameAssist.root?.querySelector('.bb-assist-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.clientWidth || gameAssist.root?.clientWidth || 1;
  const height = canvas.clientHeight || gameAssist.root?.clientHeight || 1;
  const dpr = gameAssist.pen.dpr || 1;
  if (!width || !height) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of gameAssist.pen.strokes) {
    if (!stroke.points.length) continue;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const x = p.x * width;
      const y = p.y * height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (stroke.points.length === 1) {
      const x = stroke.points[0].x * width;
      const y = stroke.points[0].y * height;
      ctx.lineTo(x + 0.01, y + 0.01);
    }
    ctx.stroke();
  }
}

function undoPenStroke() { if (gameAssist.pen.strokes.length) { gameAssist.pen.strokes.pop(); redrawPenCanvas(); } }
function clearPenCanvas() { gameAssist.pen.strokes = []; gameAssist.pen.current = null; gameAssist.pen.drawing = false; redrawPenCanvas(); }

function setPenMode(active, forceOff = false) {
  if (!screenMarkerAllowed() && !forceOff) active = false;
  const root = gameAssist.root || (active ? ensureGameAssistRoot() : null); if (!root) { gameAssist.pen.active = false; gameAssist.pen.drawing = false; gameAssist.pen.current = null; return; }
  gameAssist.pen.active = !!active;
  if (active) {
    gameAssist.mode = 'pen';
    root.classList.add('active', 'pen-draw');
    root.classList.remove('mode-wrong','mode-maybe','mode-safe','mode-target');
  } else {
    if (gameAssist.mode === 'pen') gameAssist.mode = 'mouse';
    root.classList.remove('pen-draw');
  }
  root.querySelectorAll('[data-marker-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.markerMode === (gameAssist.pen.active ? 'pen' : gameAssist.mode)));
  const hint = root.querySelector('.bb-assist-hint');
  if (hint) {
    hint.textContent = gameAssist.pen.active ? '✎ Dibuja sobre la pantalla · elige color y grosor' : (gameAssist.mode === 'mouse' ? '🖱 Modo ratón · BoomBang recibe normalmente los clics' : '');
  }
}


function normalizeAssistText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const ASSIST_NAV_LABELS = new Set(['areas', 'juegos', 'islas', 'casas', 'buscar']);
const ASSIST_GAME_LABELS = [
  ['sendero', 'sendero oculto'],
  ['cocos', 'cocos locos'],
  ['camino', 'camino ninja'],
  ['simon', 'simon dice'],
  ['papa', 'papa caliente'],
  ['colapso', 'colapso'],
  ['mano', 'mano oculta'],
  ['battle', 'battle royal'],
  ['clanwars', 'clan wars'],
  ['ctf', 'captura la bandera']
];

function assistTargetText(target) {
  let node = target instanceof Element ? target : target?.parentElement;
  for (let i = 0; node && i < 7; i++, node = node.parentElement) {
    const raw = node.getAttribute?.('aria-label') || node.innerText || node.textContent || '';
    const text = normalizeAssistText(raw);
    if (text && text.length <= 90) return text;
  }
  return '';
}

function markActiveMinigameFromClick(event) {
  const text = assistTargetText(event.target);
  if (!text) return null;

  if (ASSIST_NAV_LABELS.has(text)) {
    window.__BB_ACTIVE_MINIGAME__ = 'unknown';
    return 'navigation';
  }

  for (const [id, label] of ASSIST_GAME_LABELS) {
    if (text === label || text.includes(` ${label} `) || text.startsWith(`${label} `) || text.endsWith(` ${label}`)) {
      window.__BB_ACTIVE_MINIGAME__ = id;
      return id;
    }
  }

  return null;
}

function isAssistNavigationTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('#__bb_game_assist .bb-assist-toolbar, #__bb_hub_root, #__bb_hub_button')) return true;
  if (target.closest('button, a, input, select, textarea, [role="button"], [role="link"], [aria-label]')) return true;
  const text = assistTargetText(target);
  if (ASSIST_NAV_LABELS.has(text)) return true;
  if (/^(areas|juegos|islas|casas|buscar)(\b|\s|$)/i.test(text)) return true;
  try {
    const cursor = getComputedStyle(target).cursor;
    if (cursor === 'pointer' && target.tagName !== 'CANVAS' && target.closest('#BoomBangStage')) {
      const r = target.getBoundingClientRect();
      if (r.top < ASSIST_NAV_HEIGHT) return true;
    }
  } catch (_) {}
  return false;
}

function deactivateAssistForNavigation() {
  window.__BB_ACTIVE_MINIGAME__ = 'unknown';
  gameAssist.gameId = 'unknown';
  setPenMode(false, true);
  gameAssist.mode = 'off';
  clearGameAssistMarkers();
  clearPenCanvas();
  if (gameAssist.root) {
    gameAssist.root.classList.remove('active', 'hint', 'mode-wrong', 'mode-maybe', 'mode-safe', 'mode-target', 'pen-draw');
  }
}

function markerVisual(mode) {
  if (mode === 'wrong') return { char: '✕', bg: 'rgba(236,84,84,.9)', cls: 'wrong' };
  if (mode === 'safe') return { char: '✓', bg: 'rgba(63,206,133,.9)', cls: 'safe' };
  if (mode === 'target') return { char: '◎', bg: 'rgba(90,169,255,.26)', cls: 'target' };
  return { char: '?', bg: 'rgba(246,187,73,.92)', cls: 'maybe' };
}

function renderGameAssistMarkers() {
  const root = ensureGameAssistRoot(); if (!root) return;
  const layer = root.querySelector('.bb-assist-marker-layer');
  layer.innerHTML = '';
  for (const marker of gameAssist.markers) {
    const el = document.createElement('div');
    const v = markerVisual(marker.mode);
    el.className = `bb-marker ${v.cls}`;
    el.textContent = v.char;
    el.style.left = `${marker.x * 100}%`;
    el.style.top = `${marker.y * 100}%`;
    el.style.background = v.bg;
    el.title = marker.mode === 'wrong' ? 'Camino descartado' : marker.mode === 'safe' ? 'Camino seguro' : marker.mode === 'target' ? 'Zona marcada' : 'Posible opción';
    el.dataset.id = marker.id;
    layer.appendChild(el);
  }
  const count = root.querySelector('.bb-assist-count');
  if (count) count.textContent = String(gameAssist.markers.length);
}

function clearGameAssistMarkers() { gameAssist.markers = []; if (gameAssist.root) renderGameAssistMarkers(); }
function undoGameAssistMarker() { if (gameAssist.markers.length) { gameAssist.markers.pop(); if (gameAssist.root) renderGameAssistMarkers(); } }

function addGameAssistMarker(mode, clientX, clientY) {
  if (!screenMarkerAllowed()) return;
  const stage = document.querySelector('#BoomBangStage'); if (!stage) return;
  const rect = stage.getBoundingClientRect(); if (!rect.width || !rect.height) return;
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  gameAssist.markers.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`, mode, x, y });
  if (gameAssist.markers.length > 60) gameAssist.markers.shift();
  renderGameAssistMarkers();
}

function setAssistMode(mode) {
  if (!screenMarkerAllowed()) {
    setPenMode(false, true);
    gameAssist.mode = 'off';
    if (gameAssist.root) gameAssist.root.classList.remove('active', 'hint', 'mode-wrong', 'mode-maybe', 'mode-safe', 'mode-target', 'pen-draw');
    return;
  }
  if (mode === 'pen') { setPenMode(true); return; }
  setPenMode(false);
  gameAssist.mode = ['wrong','maybe','safe','target'].includes(mode) ? mode : 'off';
  const root = ensureGameAssistRoot(); if (!root) return;
  root.classList.toggle('active', gameAssist.mode !== 'off');
  for (const m of ['wrong','maybe','safe','target']) root.classList.toggle(`mode-${m}`, gameAssist.mode === m);
  root.classList.toggle('hint', gameAssist.mode !== 'off');
  root.querySelectorAll('[data-marker-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.markerMode === gameAssist.mode));
  const hint = root.querySelector('.bb-assist-hint');
  if (hint) {
    const text = gameAssist.mode === 'wrong' ? '✕ Haz clic para marcar el camino descartado' : gameAssist.mode === 'safe' ? '✓ Haz clic para marcar el camino seguro' : gameAssist.mode === 'target' ? '◎ Haz clic para marcar una zona u objetivo' : gameAssist.mode === 'maybe' ? '? Haz clic para marcar una posibilidad' : '';
    hint.textContent = text;
  }
}

function startAssistTimer(seconds) {
  const root = ensureGameAssistRoot(); if (!root) return;
  const total = Math.max(1, Math.round(Number(seconds) || 30));
  gameAssist.timerEndsAt = Date.now() + total * 1000;
  const box = root.querySelector('.bb-assist-timer');
  box.classList.add('show');
  const label = root.querySelector('.bb-assist-timer strong');
  clearInterval(gameAssist.timer);
  const tick = () => {
    const left = Math.max(0, gameAssist.timerEndsAt - Date.now());
    const s = Math.ceil(left / 1000);
    label.textContent = `00:${String(s).padStart(2,'0')}`;
    if (!left) { clearInterval(gameAssist.timer); gameAssist.timer = null; box.classList.add('expired'); setTimeout(() => box.classList.remove('show','expired'), 900); }
  };
  tick();
  gameAssist.timer = setInterval(tick, 200);
}

function installGameAssistPointerHandlers(stage) {
  if (stage.__bbAssistHandlers) return;
  const root = gameAssist.root;
  const canvas = root?.querySelector('.bb-assist-canvas');
  if (!root || !canvas) return;

  const localPoint = event => penPointFromEvent(event, canvas);

  const updateHint = event => {
    if (!gameAssist.root) return;
    const rect = stage.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    gameAssist.root.classList.toggle('hint', inside && (gameAssist.mode !== 'off' || gameAssist.pen.active));
  };

  const onPenDown = event => {
    if (!gameAssist.pen.active || event.button !== 0) return;
    const p = localPoint(event);
    gameAssist.pen.drawing = true;
    gameAssist.pen.current = { color: gameAssist.pen.color, size: gameAssist.pen.size, points: [p] };
    gameAssist.pen.strokes.push(gameAssist.pen.current);
    try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    redrawPenCanvas();
    event.preventDefault();
    event.stopPropagation();
  };

  const onPenMove = event => {
    updateHint(event);
    if (!gameAssist.pen.active || !gameAssist.pen.drawing) return;
    const p = localPoint(event);
    const last = gameAssist.pen.current?.points?.[gameAssist.pen.current.points.length - 1];
    if (last && Math.hypot((p.x - last.x) * canvas.clientWidth, (p.y - last.y) * canvas.clientHeight) < 1.25) return;
    gameAssist.pen.current.points.push(p);
    redrawPenCanvas();
    event.preventDefault();
    event.stopPropagation();
  };

  const finishPen = event => {
    if (!gameAssist.pen.drawing) return;
    gameAssist.pen.drawing = false;
    gameAssist.pen.current = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
    event.preventDefault();
    event.stopPropagation();
  };

  canvas.addEventListener('pointerdown', onPenDown, true);
  canvas.addEventListener('pointermove', onPenMove, true);
  canvas.addEventListener('pointerup', finishPen, true);
  canvas.addEventListener('pointercancel', finishPen, true);
  canvas.addEventListener('pointerleave', updateHint, true);

  // Point markers use the document so they work while the drawing canvas is
  // disabled in mouse mode. They are blocked only while the pen is active.
  const click = event => {
    const context = markActiveMinigameFromClick(event);
    if (context === 'navigation' || isAssistNavigationTarget(event.target)) {
      if (context === 'navigation') deactivateAssistForNavigation();
      return;
    }
    if (!screenMarkerAllowed()) return;
    if (gameAssist.pen.active || gameAssist.mode === 'off' || gameAssist.mode === 'mouse') return;
    if (!stage.contains(event.target)) return;
    const rect = stage.getBoundingClientRect();
    if (!(event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) return;
    // The native BoomBang navigation strip sits at the top of the stage.
    // Never place point markers on it, even if it is canvas-rendered.
    if ((event.clientY - rect.top) < 78) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    addGameAssistMarker(gameAssist.mode, event.clientX, event.clientY);
  };

  const moveStage = event => {
    if (event.target?.closest?.('.bb-assist-toolbar')) return;
    updateHint(event);
  };

  document.addEventListener('pointerdown', event => {
    const context = markActiveMinigameFromClick(event);
    if (context === 'navigation') {
      deactivateAssistForNavigation();
      // Never cancel the native navigation event; BoomBang must receive it.
      return;
    }
  }, true);
  document.addEventListener('click', click, true);
  document.addEventListener('pointermove', moveStage, true);

  root.querySelectorAll('[data-marker-mode]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    setAssistMode(btn.dataset.markerMode || 'off');
  }));
  root.querySelector('[data-marker-action="undo"]')?.addEventListener('click', e => { e.stopPropagation(); undoGameAssistMarker(); });
  root.querySelector('[data-marker-action="clear"]')?.addEventListener('click', e => { e.stopPropagation(); clearGameAssistMarkers(); clearPenCanvas(); });
  root.querySelector('[data-marker-action="close"]')?.addEventListener('click', e => { e.stopPropagation(); setAssistMode('off'); });
  root.querySelector('[data-pen-action="undo"]')?.addEventListener('click', e => { e.stopPropagation(); undoPenStroke(); });
  root.querySelector('[data-pen-action="clear"]')?.addEventListener('click', e => { e.stopPropagation(); clearPenCanvas(); });

  window.addEventListener('resize', resizeGameAssistCanvas, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => resizeGameAssistCanvas());
    ro.observe(stage);
    stage.__bbAssistResizeObserver = ro;
  }
  stage.__bbAssistHandlers = true;
}

function handleGameAssistCommand(payload = {}) {
  const action = String(payload.action || '');
  if (/^marker-/.test(action)) { marker.handleCommand(payload); return; }   // the new Screen Marker
  if (action === 'reset' || action === 'close' || action === 'off') {
    gameAssist.gameId = String(payload.gameId || 'unknown');
    setPenMode(false, true);
    gameAssist.mode = 'off';
    clearGameAssistMarkers();
    clearPenCanvas();
    clearInterval(gameAssist.timer);
    gameAssist.timer = null;
    if (gameAssist.root) gameAssist.root.remove();
    gameAssist.root = null;
    return;
  }
  if (payload.gameId) gameAssist.gameId = String(payload.gameId);
  // The marker is opt-in. No command below creates it unless the user explicitly
  // selected a marker feature in the Hub.
  if (!screenMarkerAllowed()) return;
  if (!gameAssist.root) ensureGameAssistRoot();
  if (action === 'mode') setAssistMode(payload.mode);
  else if (action === 'pen') setPenMode(payload.active !== false);
  else if (action === 'pen-color') { gameAssist.pen.color = String(payload.color || '#ff4d67'); const input = gameAssist.root?.querySelector('.bb-pen-color'); if (input) input.value = gameAssist.pen.color; }
  else if (action === 'pen-size') { gameAssist.pen.size = Math.max(1, Math.min(30, Number(payload.size) || 7)); const input = gameAssist.root?.querySelector('.bb-pen-size'); if (input) input.value = String(gameAssist.pen.size); }
  else if (action === 'pen-undo') undoPenStroke();
  else if (action === 'pen-clear') clearPenCanvas();
  else if (action === 'clear') { clearGameAssistMarkers(); clearPenCanvas(); }
  else if (action === 'undo') undoGameAssistMarker();
  else if (action === 'timer') startAssistTimer(payload.seconds || 30);
  else if (action === 'hide-timer') { const box = gameAssist.root?.querySelector('.bb-assist-timer'); if (box) box.classList.remove('show'); }
}

function applyClientVisualSettings(updates = {}) { clientSettings={...clientSettings,...updates}; }

function updatePanelButtonVisibility() {
  // The single Hub button is owned by client-hub.js.
  // The previous game-preload button was removed to prevent duplicates.
}

function startFpsCounter() {
  if (fpsLoopId || !clientSettings.showPerformance) return;
  const tick = () => {
    fpsFrameCount++;
    const now = performance.now();
    if (now - fpsLastTime >= 1000) {
      currentFps = fpsFrameCount;
      const hudFps = document.querySelector('#__bb_client_visual_hud .bbx-fps'); if (hudFps) hudFps.textContent = `FPS ${currentFps}`;
      fpsFrameCount = 0;
      fpsLastTime = now;
    }
    fpsLoopId = requestAnimationFrame(tick);
  };
  fpsLoopId = requestAnimationFrame(tick);
}
function stopFpsCounter() {
  if (fpsLoopId) cancelAnimationFrame(fpsLoopId);
  fpsLoopId = null; currentFps = 0; fpsFrameCount = 0; fpsLastTime = performance.now();
}

function openClientNotice(message) {
  if (!clientNotice) {
    clientNotice = document.createElement('div');
    clientNotice.id = '__bb_client_notice';
    const css = document.createElement('style');
    css.textContent = `#__bb_client_notice{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483646;padding:8px 12px;border-radius:10px;background:rgba(6,18,34,.85);border:1px solid rgba(255,255,255,.15);color:#fff;font:700 11px system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:none;opacity:0;transition:opacity .2s}`;
    document.head.appendChild(css);
    document.body.appendChild(clientNotice);
  }
  clientNotice.textContent = String(message || '');
  clientNotice.style.opacity = '1';
  clearTimeout(clientNotice._timer);
  clientNotice._timer = setTimeout(() => { clientNotice.style.opacity = '0'; }, 2400);
}

async function installClientHub() {
  if (clientHubInstalled) return;
  try {
    const cssPath = path.join(__dirname, 'client-hub.css');
    const jsPath = path.join(__dirname, 'client-hub.js');
    const css = fs.readFileSync(cssPath, 'utf8');
    const code = fs.readFileSync(jsPath, 'utf8');
    window.__BB_HUB_CSS__ = css;
    eval(code);
    clientHubInstalled = true;
  } catch (error) {
    clientHubInstalled = false;
    console.error('[BB Launcher] Client Hub no se pudo instalar:', error);
  }
}

function applyRemoteSettings(settings) {
  if (!settings) return;
  const prevPerformance = !!clientSettings.showPerformance;
  clientSettings = { ...clientSettings, ...settings };
  applyClientVisualSettings(settings);
  if (clientSettings.showPerformance && !prevPerformance) startFpsCounter();
  if (!clientSettings.showPerformance && prevPerformance) stopFpsCounter();
  try { document.dispatchEvent(new CustomEvent('__bb_hub_settings', { detail: clientSettings })); } catch (_) {}
  lastAppliedStageTransform = '';
  scaleStage();
  requestAnimationFrame(scaleStage);
  setTimeout(scaleStage, 0);
  setTimeout(scaleStage, 120);
  setTimeout(scaleStage, 350);
  updatePanelButtonVisibility();
  try { smartbar.ensureMounted(); } catch (_) {}
  renderStatusHud();
}

// ---------------------------------------------------------------------------
// Smart Bar (GG, SRT {user}, upper colours, ping, hotkeys) lives in smartbar.js
// ---------------------------------------------------------------------------
// Keys used by the autoclick (configurable in the BB Hub): the Smart Bar must never react to them.
let autoclickKeys = { set: 'F3', start: 'F1', stop: 'F2' };
ipcRenderer.invoke('autoclick:get').then(st => { if (st && st.keys) autoclickKeys = st.keys; }).catch(() => {});
const smartbar = require('./smartbar').create({
  ipcRenderer,
  autoclickKeys: () => Object.values(autoclickKeys || {}),
  getProfileId: () => profileId,
  getSettings: () => clientSettings,
  saveSettings: patch => saveClientSettings(patch),
  notice: message => openClientNotice(message),
  loginVisible: () => loginVisible(),
  isGameFrame: () => location.hostname === 'static.boombang.tv' && /\/betahtml5\/game\.html/i.test(location.pathname),
  ownNames: () => [accountUsername, profileName]
});
window.__BB_SMARTBAR__ = smartbar;   // used by the in-client BB Hub

// Screen Marker (Sendero Oculto): one floating bar inside the game (marker.js)
const marker = require('./marker').create({
  notice: message => openClientNotice(message),
  isGameFrame: () => location.hostname === 'static.boombang.tv' && /\/betahtml5\/game\.html/i.test(location.pathname)
});

// Aviso de objetos: a soft chime when an object you taught it appears (drops.js)
const drops = require('./drops').create({
  ipcRenderer,
  getProfileId: () => profileId,
  notice: message => openClientNotice(message),
  injectMainWorld: code => { try { require('electron').webFrame.executeJavaScript(code); } catch (_) {} },
  isGameFrame: () => location.hostname === 'static.boombang.tv' && /\/betahtml5\/game\.html/i.test(location.pathname)
});

function handleLauncherCommand(command) {
  if (!command) return;
  if (command.type === 'settings') applyRemoteSettings(command.settings);
  if (command.type === 'notice') openClientNotice(command.message);
  if (command.type === 'fps' && Number.isFinite(command.fps)) sendFps(command.fps);
  if (command.type === 'autoclick-keys' && command.keys && typeof command.keys === 'object') autoclickKeys = command.keys;
  if (command.type === 'game-assist') handleGameAssistCommand(command.payload || {});
  if (command.type === 'client-visual') applyClientVisualSettings(command.payload || {});
  if (command.type === 'hub') { try { if (typeof window.__BB_HUB_OPEN_TAB__ === 'function') window.__BB_HUB_OPEN_TAB__(command.tab || 'home'); } catch (_) {} }
  smartbar.handleCommand(command);   // chat-shortcut, smartbar-learn, smartbar-upper, smartbar-force
  drops.handleCommand(command);      // drop-alert-config, drop-alert-learn, drop-alert-test
}

// Commands from the separate control panel are delivered by the main process
// into the real static.boombang.tv frame. The DOM event bridge lets the
// isolated preload receive those commands reliably even though the panel is
// a separate BrowserWindow.
document.addEventListener('__bb_launcher_command', event => {
  try { handleLauncherCommand(event.detail); } catch (_) {}
});

ipcRenderer.on('client-panel:command', (_event, command) => {
  handleLauncherCommand(command);
});

async function installInnerGameStyle() {
  if (innerStyleInstalled) return;
  innerStyleInstalled = true;
  await loadClientSettings();
  await loadAccountUsername();
  const style = document.createElement('style');
  style.id = '__bb_launcher_inner_fit_v165';
  style.textContent = `
    html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important;background:#000!important}
    #BoomBangStage{transform:var(--bb-stage-tf,translate(-50%,-50%))!important;transform-origin:center center!important}
    #BoomBangStage{position:fixed!important;left:50%!important;top:50%!important;width:1012px!important;height:657px!important;min-width:1012px!important;min-height:657px!important;max-width:1012px!important;max-height:657px!important;margin:0!important;padding:0!important;overflow:hidden!important;transform-origin:center center!important;z-index:1!important}
    #BoomBangContainer,#BoomBangAlerts,#BoomBangLogin,#bbLoginRoot{width:1012px!important;height:657px!important;min-width:1012px!important;min-height:657px!important;max-width:1012px!important;max-height:657px!important;margin:0!important;padding:0!important;transform:none!important}
    #BoomBangStage>div[title*="Arrastra esta esquina"]{display:none!important}
    #BoomBangStage>div[style*="width: 218px"]{display:none!important}
  `;
  (document.head || document.documentElement).appendChild(style);
  buildStatusHud();
  if (clientSettings.showPerformance) startFpsCounter();
  applyClientVisualSettings(clientSettings);
  // Defensive cleanup for a button left by an older launcher version.
  try { document.getElementById('__bb_open_panel')?.remove(); } catch (_) {}
  installClientHub();
  smartbar.start();
  drops.start();
  installStageTransformGuard();
  watchFlickers();
  renderStatusHud();
  clearInterval(statusTimer);
  statusTimer = setInterval(renderStatusHud, 1000);
  clearInterval(connectionTimer);
  connectionTimer = setInterval(refreshConnectionState, 4000);
  const apply = () => { lastAppliedStageTransform = ''; scaleStage(); };
  apply();
  window.addEventListener('resize', apply, { passive: true });
  setTimeout(apply, 100);
  setTimeout(apply, 500);
  setTimeout(apply, 1500);
  refreshConnectionState();
}

function installOuterGameStyle() {
  if (outerStyleInstalled) return;
  outerStyleInstalled = true;
  const style = document.createElement('style');
  style.id = '__bb_launcher_outer_fill_v19';
  style.textContent = `
    html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important;background:#000!important}
    iframe[src*="static.boombang.tv/betahtml5/game.html"]{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;min-width:100%!important;min-height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;display:block!important;background:#000!important}
  `;
  (document.head || document.documentElement).appendChild(style);
}

function startLoginBridge() {
  if (!profileId) return;
  const capture = () => { if (inGameSession) return; try { captureCredentials(); } catch (e) { console.warn('[BB Launcher] captureCredentials failed', e); } };
  const clickHandler = event => {
    const target = event.target?.closest?.('button, input[type="submit"], [role="button"], a');
    if (!target) return;
    const label = textOf(target);
    if (/^(jugar|entrar|iniciar sesión|iniciar sesion|login|sign.?in|play)$/.test(label) || /jugar|entrar|iniciar|login|sign.?in|play/.test(label)) {
      capture();
      setTimeout(() => savePendingAfterSuccess(), 50);
    }
  };
  document.addEventListener('click', clickHandler, true);
  document.addEventListener('submit', () => { capture(); setTimeout(() => savePendingAfterSuccess(), 50); }, true);
  document.addEventListener('input', event => {
    const t = event.target;
    if (t && /password|user|usuario|username|nick|login/i.test(`${t.type||''} ${t.name||''} ${t.id||''} ${t.placeholder||''}`)) capture();
  }, true);
  document.addEventListener('change', event => {
    const t = event.target;
    if (t && /password|user|usuario|username|nick|login/i.test(`${t.type||''} ${t.name||''} ${t.id||''} ${t.placeholder||''}`)) capture();
  }, true);
  const run = () => {
    try {
      // Logged out / kicked back to the real login screen: reading the login is allowed again.
      if (inGameSession && loginPanelVisible() && !worldLoadedRaw()) inGameSession = false;
      if (inGameSession) return;
      if (loginVisible()) {
        if (loginFieldsPresent()) capture();
        autoLogin();
      } else if (pendingCredentials) {
        savePendingAfterSuccess();
      }
    } catch (e) { console.warn('[BB Launcher] login bridge error', e); }
  };
  run();
  [150, 300, 700, 1200, 2000, 3500, 5500, 8000, 12000].forEach(ms => setTimeout(run, ms));
  let observerBusy = false, slowCheck = null;
  const watch = () => { try { loginObserver.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} };
  loginObserver = new MutationObserver(() => {
    if (observerBusy) return;                       // at most one check per 250 ms instead of one per DOM change
    observerBusy = true;
    setTimeout(() => {
      observerBusy = false;
      if (inGameSession) {
        // In the game: stop reacting to every change in the room (crowded events = thousands of changes).
        try { loginObserver.disconnect(); } catch (_) {}
        if (!slowCheck) slowCheck = setInterval(() => { if (loginPanelVisible()) { clearInterval(slowCheck); slowCheck = null; run(); watch(); } }, 3000);
        return;
      }
      if (loginVisible()) run();
      else if (pendingCredentials) savePendingAfterSuccess();
    }, 250);
  });
  watch();
}

// ---- Frame limit (fps-limit.js runs inside the game page) ----
let fpsWanted = null;
function sendFps(n) { fpsWanted = n; try { document.dispatchEvent(new CustomEvent('__bb_fps', { detail: JSON.stringify({ fps: n }) })); } catch (_) {} }
function installFpsLimit() {
  try { require('electron').webFrame.executeJavaScript(require('./fps-limit').SOURCE); } catch (_) {}
  ipcRenderer.invoke('perf:current-fps', profileId).then(n => { if (Number.isFinite(n)) sendFps(n); }).catch(() => {});
  setTimeout(() => { if (fpsWanted !== null) sendFps(fpsWanted); }, 1500);      // again, in case the page was not ready
}

function startFrameLogic() {
  if (window.top === window) {
    installOuterGameStyle();
  } else if (location.hostname === 'static.boombang.tv' && /\/betahtml5\/game\.html/i.test(location.pathname)) {
    installFpsLimit();
    installInnerGameStyle();
    startLoginBridge();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startFrameLogic, { once: true });
else startFrameLogic();
