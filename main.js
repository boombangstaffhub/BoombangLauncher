const { app, BrowserWindow, ipcMain, session, shell, safeStorage, net, Tray, Menu, dialog, screen: electronScreen, nativeImage } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_DATA = app.getPath('appData');
const DATA_ROOT = path.join(APP_DATA, 'BoomBangLauncher');
const SESSION_DATA = path.join(DATA_ROOT, 'ChromiumSession');
app.setPath('userData', DATA_ROOT);
app.setPath('sessionData', SESSION_DATA);
app.setAppUserModelId('tv.boombang.launcher');

// V0.11 performance profile: keep the game renderer responsive even when the
// client is behind other windows/minimized by the launcher. These are Chromium
// rendering switches only; no network/debug instrumentation is enabled.
try {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  // Windows only: stops Chromium from throttling the game when another window (the Hub) covers part of it.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
} catch (_) {}

const GAME_URL = 'https://www.boombang.tv/es/game';
const SERVER_URL = 'https://www.boombang.tv/es/game';
const NEWS_URL = 'https://www.boombang.tv/es/news';
const PROFILES_FILE = path.join(DATA_ROOT, 'profiles.json');
const AUTH_STORE = path.join(DATA_ROOT, 'secure-profiles.json');
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const CLIENT_SETTINGS_FILE = path.join(DATA_ROOT, 'client-settings.json');
const HUB_FILE = path.join(DATA_ROOT, 'client-hub.json');
const APP_ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const LAUNCHER_VERSION = app.getVersion();
const { pingHost, RttTracker, DEFAULT_PING_HOST } = require('./rtt');
const { createUpdater, isNewer, notesFor, readConfig } = require('./updater');
const { normalizeConfig: normalizeDropAlert } = require('./drops');
const visual = require('./visual');
const { Worker: ThreadWorker } = require('worker_threads');

const DEFAULT_SETTINGS = {
  autoLogin: true,
  autoclickEnabled: false,   // opt-in: turn it on in Settings
  autoUpdateCheck: true,
  autoclickInterval: 1,
  autoclickKeys: null,       // null = F3 / F1 / F2 (set in the BB Hub)
  dropAlert: null,           // aviso de objetos (BB Hub → Avisos)
  hideLauncherOnGameLaunch: false,
  rememberWindowSize: true,
  checkServerOnStart: true,
  startWithWindows: false,
  minimizeToTray: false
};

const DEFAULT_CLIENT_SETTINGS = {
  fitMode: 'fill',
  zoom: 100,
  showPerformance: false,
  showStatusBar: true,
  cleanMode: false,
  alwaysOnTop: false,
  muted: false,
  performanceMode: false,
  smartBar: true,
  smartBarX: 12,
  smartBarY: 10,
  smartBarCompact: false,
  pingHost: DEFAULT_PING_HOST,
  upperColors: null,
  hotkeys: null,
  smartBarItems: null,
  smartBarShowPing: true,
  smartBarShowGear: true
};

let launcherWindow = null;
let tray = null;
let isQuitting = false;
let serverTimer = null;
const games = new Map();
const closingGames = new Set();
const hubWindows = new Map();
const activeClientSessions = new Map();
const endedClientSessions = new Set();
const focusedUsers = new Map();
const pingTrackers = new Map();
function ensureDataRoot() { fs.mkdirSync(DATA_ROOT, { recursive: true }); }
function safeReadJson(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function safeWriteJson(file, value) {
  ensureDataRoot();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function readProfiles() { return safeReadJson(PROFILES_FILE, []); }
function writeProfiles(value) { safeWriteJson(PROFILES_FILE, value); }
function readSettings() { return { ...DEFAULT_SETTINGS, ...safeReadJson(SETTINGS_FILE, {}) }; }
function writeSettings(value) { safeWriteJson(SETTINGS_FILE, { ...DEFAULT_SETTINGS, ...value }); }
function readClientSettings() { return safeReadJson(CLIENT_SETTINGS_FILE, {}); }
function getClientSettings(profileId) {
  const all = readClientSettings();
  const key = String(profileId);
  const raw = { ...(all[key] || {}) };
  let dirty = false;
  if (raw._v165FitRepair !== true) { raw.fitMode = 'fill'; raw._v165FitRepair = true; dirty = true; }
  for (const legacy of ['visualNav', 'visualChat', 'visualTheme', 'visualHud', 'customCursor']) {
    if (legacy in raw) { delete raw[legacy]; dirty = true; }
  }
  const merged = { ...DEFAULT_CLIENT_SETTINGS, ...raw };
  if (dirty) { all[key] = merged; safeWriteJson(CLIENT_SETTINGS_FILE, all); }
  return merged;
}
function writeClientSettings(profileId, updates) { const all = readClientSettings(); all[profileId] = { ...getClientSettings(profileId), ...(updates || {}) }; safeWriteJson(CLIENT_SETTINGS_FILE, all); return all[profileId]; }

const DEFAULT_HUB_DATA = {
  theme: 'crystal',
  openMode: 'window',
  shortcuts: { gg: 'gg', srt: 'srt {user}' },
  streamerMode: false,
  stats: { totalSeconds: 0, sessions: 0, lastPlayedDate: null, currentStreak: 0 },
  history: []
};
function readHubStore() { return safeReadJson(HUB_FILE, {}); }
function getHubData(profileId) {
  const raw = readHubStore()[String(profileId)] || {};
  const shortcuts = { ...DEFAULT_HUB_DATA.shortcuts, ...(raw.shortcuts || {}) };
  delete shortcuts.brb; delete shortcuts.afk;
  return {
    ...DEFAULT_HUB_DATA,
    openMode: ['overlay', 'window', 'window-top'].includes(raw.openMode) ? raw.openMode : DEFAULT_HUB_DATA.openMode,
    theme: 'crystal',
    streamerMode: Boolean(raw.streamerMode),
    shortcuts,
    stats: { ...DEFAULT_HUB_DATA.stats, ...(raw.stats || {}) },
    history: Array.isArray(raw.history) ? raw.history.slice(0, 100) : []
  };
}
function writeHubData(profileId, updates) {
  const all = readHubStore();
  const current = getHubData(profileId);
  const u = updates && typeof updates === 'object' ? updates : {};
  const next = {
    ...current,
    ...(u.openMode ? { openMode: u.openMode } : {}),
    ...(typeof u.streamerMode === 'boolean' ? { streamerMode: u.streamerMode } : {}),
    shortcuts: { ...current.shortcuts, ...(u.shortcuts || {}) },
    stats: { ...current.stats, ...(u.stats || {}) },
    history: Array.isArray(u.history) ? u.history.slice(0, 100) : current.history
  };
  all[String(profileId)] = next;
  safeWriteJson(HUB_FILE, all);
  return next;
}
function startClientSession(profileId) {
  const id = String(profileId);
  activeClientSessions.set(id, { startedAt: null, ready: false });
}
function markClientSessionReady(profileId) {
  const id = String(profileId);
  const current = activeClientSessions.get(id);
  if (!current) {
    activeClientSessions.set(id, { startedAt: Date.now(), ready: true });
    return true;
  }
  if (!current.ready) {
    current.startedAt = Date.now();
    current.ready = true;
  }
  return true;
}
function endClientSession(profileId, reason = 'closed') {
  const id = String(profileId);
  if (endedClientSessions.has(id)) return getHubData(id);
  const session = activeClientSessions.get(id);
  if (!session || !session.ready || !session.startedAt) {
    activeClientSessions.delete(id);
    return getHubData(id);
  }
  endedClientSessions.add(id);
  activeClientSessions.delete(id);
  const now = Date.now();
  const seconds = Math.max(0, Math.round((now - session.startedAt) / 1000));
  const data = getHubData(id);
  const localDay = date => {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const day = localDay(now);
  const prevDay = data.stats.lastPlayedDate;
  let streak = Number(data.stats.currentStreak) || 0;
  if (!prevDay) streak = 1;
  else if (prevDay === day) streak = Math.max(1, streak);
  else {
    const [py, pm, pd] = String(prevDay).split('-').map(Number);
    const [cy, cm, cd] = String(day).split('-').map(Number);
    const prev = new Date(py, (pm || 1) - 1, pd || 1).getTime();
    const cur = new Date(cy, (cm || 1) - 1, cd || 1).getTime();
    const diff = Math.round((cur - prev) / 86400000);
    streak = diff === 1 ? Math.max(1, streak) + 1 : 1;
  }
  const entry = { startedAt: new Date(session.startedAt).toISOString(), endedAt: new Date(now).toISOString(), seconds, reason };
  const nextHistory = [entry, ...(data.history || [])].slice(0, 100);
  return writeHubData(id, {
    stats: { ...data.stats, totalSeconds: (Number(data.stats.totalSeconds)||0) + seconds, sessions: (Number(data.stats.sessions)||0) + 1, lastPlayedDate: day, currentStreak: streak },
    history: nextHistory
  });
}
function readAuthStore() { return safeReadJson(AUTH_STORE, {}); }
function writeAuthStore(value) { safeWriteJson(AUTH_STORE, value); }

function encryptCredentials(username, password) {
  if (!safeStorage.isEncryptionAvailable()) { console.warn('[BB Launcher] safeStorage no está disponible; no se pueden persistir credenciales de forma segura.'); return null; }
  return safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64');
}
function decryptCredentials(blob) {
  try {
    if (!blob || !safeStorage.isEncryptionAvailable()) return null;
    const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64')));
    if (!parsed.username || !parsed.password) return null;
    return parsed;
  } catch { return null; }
}
function saveCredentials(profileId, username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u || !p) return false;
  const encrypted = encryptCredentials(u, p);
  if (!encrypted) return false;
  const store = readAuthStore(); store[profileId] = encrypted; writeAuthStore(store); return true;
}
function getCredentials(profileId) { return decryptCredentials(readAuthStore()[profileId]); }
function clearCredentials(profileId) {
  const store = readAuthStore(); delete store[profileId]; writeAuthStore(store);
}

function notifyLauncher(channel, payload) {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.webContents.send(channel, payload);
}


function applyStartupSettings(settings = readSettings()) {
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: Boolean(settings.startWithWindows),
        openAsHidden: Boolean(settings.startWithWindows && settings.minimizeToTray)
      });
    }
  } catch (_) {}
}

function showLauncher() {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    if (launcherWindow.isMinimized()) launcherWindow.restore();
    launcherWindow.show();
    launcherWindow.focus();
    return;
  }
  createLauncher();
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(APP_ICON);
    tray.setToolTip('BoomBang Launcher');
    tray.on('double-click', showLauncher);
    refreshTrayMenu();
  } catch (_) {
    tray = null;
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const profiles = readProfiles();
  const playItems = profiles.slice(0, 20).map(profile => ({
    label: `Jugar · ${profile.name}`,
    click: () => ipcMain.emit('__tray_launch', profile.id)
  }));
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir BoomBang Launcher', click: showLauncher },
    ...(playItems.length ? [{ type: 'separator' }, ...playItems] : []),
    { type: 'separator' },
    { label: 'Abrir web oficial', click: () => shell.openExternal('https://www.boombang.tv/es/') },
    { type: 'separator' },
    { label: 'Salir', click: quitApplication }
  ]);
  tray.setContextMenu(menu);
}

async function quitApplication() {
  isQuitting = true;
  try {
    for (const id of [...games.keys()]) await closeGame(id);
  } catch (_) {}
  try { tray?.destroy(); } catch (_) {}
  tray = null;
  app.quit();
}

ipcMain.on('__tray_launch', (_event, profileId) => {
  const profile = readProfiles().find(p => p.id === profileId);
  if (profile) createGame(profile).catch(error => dialog.showErrorBox('BoomBang Launcher', error?.message || String(error)));
});

function createLauncher() {
  const settings = readSettings();
  launcherWindow = new BrowserWindow({
    width: settings.windowWidth || 1180,
    height: settings.windowHeight || 780,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#071426',
    autoHideMenuBar: true,
    title: 'BoomBang Launcher',
    icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  launcherWindow.loadFile('index.html');
  launcherWindow.on('close', (event) => {
    const settings = readSettings();
    if (!isQuitting && settings.minimizeToTray && tray) {
      event.preventDefault();
      launcherWindow.hide();
    }
  });
  let resizeSaveTimer = null;
  launcherWindow.on('resize', () => {
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      if (!launcherWindow || launcherWindow.isDestroyed() || !readSettings().rememberWindowSize) return;
      const [width, height] = launcherWindow.getSize();
      writeSettings({ ...readSettings(), windowWidth: width, windowHeight: height });
    }, 400);
  });
  launcherWindow.on('closed', () => { launcherWindow = null; });
}

async function createGame(profile) {
  const settings = readSettings();
  const partition = `persist:boombang-profile-${profile.id}`;
  const ses = session.fromPartition(partition);

  let game = games.get(profile.id);
  if (game && !game.isDestroyed()) { game.show(); game.focus(); return; }

  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) { profiles[idx].lastPlayedAt = new Date().toISOString(); writeProfiles(profiles); }

  game = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1012, minHeight: 640,
    backgroundColor: '#000000', title: `BoomBang — ${profile.name}`, icon: APP_ICON,
    frame: true, autoHideMenuBar: true,
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'game-preload.js'),
      additionalArguments: [`--bb-profile=${profile.id}`, `--bb-profile-name=${encodeURIComponent(profile.name)}`],
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true,
      sandbox: false, spellcheck: false, backgroundThrottling: false,
      enableWebSQL: false
    }
  });

  games.set(profile.id, game);
  endedClientSessions.delete(String(profile.id));
  startClientSession(profile.id);
  const initialClientSettings = getClientSettings(profile.id);
  game.webContents.setAudioMuted(Boolean(initialClientSettings.muted));
  try { game.webContents.setFrameRate(60); } catch (_) {}
  game.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  let reloadAttempts = 0;
  let crashRecoveryUsed = false;
  game.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || isClosing || isQuitting) return;
    if (!/^https:\/\/www\.boombang\.tv\/es\/game/i.test(String(validatedURL || '')) && !/^https:\/\/static\.boombang\.tv\//i.test(String(validatedURL || ''))) return;
    if (reloadAttempts >= 3) return;
    reloadAttempts += 1;
    setTimeout(() => { if (!isClosing && !game.isDestroyed()) game.reload(); }, 1500 * reloadAttempts);
  });
  game.webContents.on('did-finish-load', () => { reloadAttempts = 0; });
  game.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || isClosing || crashRecoveryUsed) return;
    crashRecoveryUsed = true;
    notifyLauncher('client:recovered', { profileId: profile.id, reason: details?.reason || 'crashed' });
    setTimeout(() => {
      if (isQuitting) return;
      try { if (!game.isDestroyed()) game.destroy(); } catch (_) {}
      setTimeout(() => {
        const current = games.get(profile.id);
        if (!current && !isQuitting) createGame(profile).catch(() => {});
      }, 500);
    }, 1500);
  });

  let isClosing = false;
  game.on('close', async (event) => {
    if (isClosing || closingGames.has(profile.id)) return;
    event.preventDefault(); closingGames.add(profile.id);
    try { await ses.flushStorageData(); if (ses.cookies?.flushStore) await ses.cookies.flushStore(); } catch (_) {}
    isClosing = true; closingGames.delete(profile.id); game.destroy();
  });
  game.on('closed', () => {
    pingTrackers.delete(String(profile.id));
    focusedUsers.delete(String(profile.id));
    try { endClientSession(profile.id, isClosing ? 'closed' : 'crashed'); } catch (_) {}
    games.delete(profile.id);
    closingGames.delete(profile.id);
    const hub = hubWindows.get(String(profile.id));
    if (hub && !hub.isDestroyed()) hub.close();
    hubWindows.delete(String(profile.id));
  });
  game.maximize();
  // Open the connections before the page asks for them: faster first paint of the game.
  try { const ses = game.webContents.session; ses.preconnect({ url: 'https://www.boombang.tv', numSockets: 2 }); ses.preconnect({ url: 'https://static.boombang.tv', numSockets: 4 }); } catch (_) {}
  await game.loadURL(GAME_URL);
  if (settings.hideLauncherOnGameLaunch && launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide();
}

async function closeGame(profileId) {
  const game = games.get(profileId);
  if (!game || game.isDestroyed()) return;
  game.close();
}

async function clearProfileSession(profileId) {
  const partition = `persist:boombang-profile-${profileId}`;
  const ses = session.fromPartition(partition);
  try { await ses.clearStorageData(); } catch (_) {}
  try { await ses.clearCache(); } catch (_) {}
}

function checkServer() {
  return new Promise(resolve => {
    const request = net.request({ method: 'GET', url: SERVER_URL });
    let settled = false;
    const finish = payload => { if (settled) return; settled = true; try { request.abort(); } catch (_) {} resolve(payload); };
    const timer = setTimeout(() => finish({ online: false, status: null, latency: null, checkedAt: new Date().toISOString() }), 9000);
    const start = Date.now();
    request.on('response', response => {
      clearTimeout(timer);
      finish({ online: response.statusCode >= 200 && response.statusCode < 500, status: response.statusCode, latency: Date.now() - start, checkedAt: new Date().toISOString() });
      response.resume();
    });
    request.on('error', () => { clearTimeout(timer); finish({ online: false, status: null, latency: null, checkedAt: new Date().toISOString() }); });
    request.end();
  });
}

async function broadcastServerStatus() { const result = await checkServer(); notifyLauncher('server:status', result); return result; }
function startServerMonitor() {
  if (serverTimer) clearInterval(serverTimer);
  if (!readSettings().checkServerOnStart) return;
  broadcastServerStatus();
  serverTimer = setInterval(broadcastServerStatus, 60000);
}


function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url });
    let body = '';
    const timer = setTimeout(() => { try { request.abort(); } catch (_) {} reject(new Error('Tiempo de espera agotado.')); }, 12000);
    request.on('response', response => {
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 2_000_000) { try { request.abort(); } catch (_) {} } });
      response.on('end', () => { clearTimeout(timer); if (response.statusCode >= 200 && response.statusCode < 400) resolve(body); else reject(new Error(`HTTP ${response.statusCode}`)); });
      response.on('error', error => { clearTimeout(timer); reject(error); });
    });
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

async function fetchNews() {
  try {
    const html = await fetchText(NEWS_URL);
    return { ok: true, html, url: NEWS_URL, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, html: '', url: NEWS_URL, fetchedAt: new Date().toISOString(), error: error?.message || 'No se pudo cargar noticias.' };
  }
}

ipcMain.handle('profiles:list', () => readProfiles().map(p => ({ ...p, _hasAuth: Boolean(getCredentials(p.id)) })));
ipcMain.handle('profiles:add', (_e, name) => {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Escribe un nombre de perfil.');
  const profiles = readProfiles();
  if (profiles.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) throw new Error('Ya existe un perfil con ese nombre.');
  profiles.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: cleanName, createdAt: new Date().toISOString(), lastPlayedAt: null });
  writeProfiles(profiles); refreshTrayMenu(); return profiles;
});
ipcMain.handle('profiles:rename', (_e, id, name) => {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Escribe un nombre de perfil.');
  const profiles = readProfiles();
  if (profiles.some(p => p.id !== id && p.name.toLowerCase() === cleanName.toLowerCase())) throw new Error('Ya existe un perfil con ese nombre.');
  const item = profiles.find(p => p.id === id); if (!item) throw new Error('Perfil no encontrado.');
  item.name = cleanName; writeProfiles(profiles); refreshTrayMenu(); return profiles;
});
ipcMain.handle('profiles:delete', async (_e, id) => {
  await closeGame(id); clearCredentials(id); await clearProfileSession(id);
  const profiles = readProfiles().filter(p => p.id !== id); writeProfiles(profiles); refreshTrayMenu(); return profiles;
});
ipcMain.handle('profiles:logout', async (_e, id) => { clearCredentials(id); await closeGame(id); return true; });
ipcMain.handle('profiles:hasSession', (_e, id) => Boolean(getCredentials(id)));
ipcMain.handle('game:launch', async (_e, id) => {
  const profile = readProfiles().find(p => p.id === id); if (!profile) throw new Error('Perfil no encontrado.');
  await createGame(profile); return true;
});
ipcMain.handle('game:close', (_e, id) => closeGame(id));

// ---- copy the Smart Bar setup to other profiles ----
const COPY_BAR_KEYS = ['smartBarItems', 'smartBarShowPing', 'smartBarShowGear', 'hotkeys', 'pingHost'];
const COPY_CALIB_KEYS = ['upperColors'];
ipcMain.handle('client:copy-settings', async (_e, fromId, toIds, parts) => {
  const from = String(fromId || '');
  const keys = [...(parts && parts.bar ? COPY_BAR_KEYS : []), ...(parts && parts.calib ? COPY_CALIB_KEYS : [])];
  if (!keys.length) return { ok: false, message: 'Elige qué copiar.' };
  const known = new Set(readProfiles().map(p => p.id));
  const targets = (Array.isArray(toIds) ? toIds : []).map(String).filter(id => id && id !== from && known.has(id));
  const source = getClientSettings(from);
  const patch = {};
  for (const k of keys) patch[k] = source[k] === undefined || source[k] === null ? null : JSON.parse(JSON.stringify(source[k]));
  for (const id of targets) {
    writeClientSettings(id, patch);
    if (getGame(id)) { try { await sendClientCommand(id, { type: 'settings', settings: patch }); } catch (_) {} }   // applies live if that profile is open
  }
  return { ok: true, copied: targets.length };
});
ipcMain.handle('launcher:show', showLauncher);
ipcMain.handle('launcher:hide', () => { if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide(); });
ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:save', (_e, updates) => { const next = { ...readSettings(), ...(updates || {}) }; writeSettings(next); applyStartupSettings(next); refreshTrayMenu(); startServerMonitor(); syncAutoclick(); return next; });

// ---- Autoclick CEROSIETE (hidden): F3 saves the position, F1 starts, F2 stops (keys configurable in the BB Hub) ----
let autoclickProc = null, autoclickConf = '';
// Keys the autoclick can use (Windows virtual-key codes). Single keys only: the helper polls them globally.
const AC_KEY_CODES = (() => {
  const m = {};
  for (let i = 1; i <= 12; i++) m['F' + i] = 0x6F + i;
  for (let c = 65; c <= 90; c++) m[String.fromCharCode(c)] = c;
  for (let d = 0; d <= 9; d++) m[String(d)] = 0x30 + d;
  Object.assign(m, { Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Pause: 0x13, ScrollLock: 0x91,
    Mouse3: 0x04, Mouse4: 0x05, Mouse5: 0x06 });
  return m;
})();
const AC_DEFAULT_KEYS = { set: 'F3', start: 'F1', stop: 'F2' };
function autoclickKeys(st = readSettings()) {
  const k = st.autoclickKeys && typeof st.autoclickKeys === 'object' ? st.autoclickKeys : {};
  const out = {};
  for (const role of Object.keys(AC_DEFAULT_KEYS)) out[role] = AC_KEY_CODES[k[role]] ? String(k[role]) : AC_DEFAULT_KEYS[role];
  return new Set(Object.values(out)).size === 3 ? out : { ...AC_DEFAULT_KEYS };   // never two roles on one key
}
const autoclickIntervalOf = st => Math.max(1, Math.min(1000, Math.round(Number(st.autoclickInterval) || 1)));
// 6 clicks per tick like the original; at 1 ms ("máximo") a bit more punch: 8 clicks per tick.
const autoclickClicksFor = interval => (interval <= 1 ? 8 : 6);
let autoclickClicks = 6, autoclickPausedUntil = 0, autoclickPauseTimer = null;
// Clicks for a target inside a BoomBang window go straight into the game: the real mouse is never moved.
function gameAtScreenPoint(dip) {
  let hit = null;
  for (const game of games.values()) {
    if (!game || game.isDestroyed() || !game.isVisible() || game.isMinimized()) continue;
    const b = game.getContentBounds();
    if (dip.x < b.x || dip.y < b.y || dip.x >= b.x + b.width || dip.y >= b.y + b.height) continue;
    if (!hit || game.isFocused()) hit = { game, b };
  }
  return hit;
}
function autoclickInGame(px, py) {
  try {
    const dip = process.platform === 'win32' && electronScreen.screenToDipPoint ? electronScreen.screenToDipPoint({ x: px, y: py }) : { x: px, y: py };
    const hit = gameAtScreenPoint(dip);
    if (!hit) return false;
    const x = Math.round(dip.x - hit.b.x), y = Math.round(dip.y - hit.b.y);
    const wc = hit.game.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    for (let i = 0; i < autoclickClicks; i++) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }
    // Put the game's hover back where your real mouse is, so nothing "sticks" to the target.
    const cur = electronScreen.getCursorScreenPoint();
    const cx = Math.round(cur.x - hit.b.x), cy = Math.round(cur.y - hit.b.y);
    if (cx >= 0 && cy >= 0 && cx < hit.b.width && cy < hit.b.height) wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
    return true;
  } catch (_) { return false; }
}
function onAutoclickLine(line) {
  const m = /^C (-?\d+) (-?\d+)$/.exec(String(line).trim());
  if (m) autoclickInGame(Number(m[1]), Number(m[2]));
}
function stopAutoclick() {
  const proc = autoclickProc; autoclickProc = null; autoclickConf = '';
  if (proc && proc.exitCode === null) {
    try { proc.kill(); } catch (_) {}
    if (process.platform === 'win32' && proc.pid) execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }
}
function syncAutoclick() {
  if (process.platform !== 'win32') return;
  const st = readSettings();
  const interval = autoclickIntervalOf(st), clicks = autoclickClicksFor(interval), keys = autoclickKeys(st);
  const paused = Date.now() < autoclickPausedUntil;      // the Hub is recording a new key
  const conf = st.autoclickEnabled === false || paused ? '' : [interval, clicks, keys.start, keys.stop, keys.set].join('|');
  if (conf === autoclickConf && (conf === '' || autoclickProc)) return;
  stopAutoclick();
  if (!conf) return;
  try {
    // Copy the helper next to the user data so it also works when the app is packaged (asar).
    const dir = path.join(DATA_ROOT, 'helpers'); fs.mkdirSync(dir, { recursive: true });
    for (const f of ['autoclick.cs', 'autoclick.ps1']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', path.join(dir, 'autoclick.ps1'), '-ParentPid', String(process.pid), '-Interval', String(interval),
      '-Clicks', String(clicks), '-StartKey', String(AC_KEY_CODES[keys.start]), '-StopKey', String(AC_KEY_CODES[keys.stop]), '-SetKey', String(AC_KEY_CODES[keys.set])], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    autoclickClicks = clicks;
    autoclickProc = proc; autoclickConf = conf;   // tracked first, so it can always be stopped
    let pending = '';
    if (proc.stdout) proc.stdout.setEncoding('utf8');
    if (proc.stdout) proc.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      if (pending.length > 4096) pending = '';
      for (const line of lines) onAutoclickLine(line);
    });
    proc.on('error', () => { if (autoclickProc === proc) { autoclickProc = null; autoclickConf = ''; } });
    proc.on('exit', () => { if (autoclickProc === proc) { autoclickProc = null; autoclickConf = ''; } });
    autoclickProc = proc; autoclickConf = conf;
  } catch (error) { console.warn('[BB Launcher] autoclick no se pudo iniciar', error); }
}
function autoclickState() {
  const st = readSettings();
  return { enabled: st.autoclickEnabled !== false, interval: autoclickIntervalOf(st), keys: autoclickKeys(st), defaults: { ...AC_DEFAULT_KEYS }, keyNames: Object.keys(AC_KEY_CODES) };
}
function broadcastAutoclickKeys() {
  const keys = autoclickKeys();
  for (const id of games.keys()) sendClientCommand(id, { type: 'autoclick-keys', keys }).catch(() => {});
}
ipcMain.handle('autoclick:get', () => autoclickState());
ipcMain.handle('autoclick:save', (_e, patch) => {
  const p = patch && typeof patch === 'object' ? patch : {};
  const st = readSettings(), next = { ...st };
  if ('enabled' in p) next.autoclickEnabled = Boolean(p.enabled);
  if ('interval' in p) next.autoclickInterval = autoclickIntervalOf({ autoclickInterval: p.interval });
  if ('keys' in p) {
    if (p.keys === null) next.autoclickKeys = null;
    else {
      const k = p.keys && typeof p.keys === 'object' ? p.keys : {};
      const cand = { ...autoclickKeys(st) };
      for (const role of Object.keys(AC_DEFAULT_KEYS)) if (k[role] !== undefined) cand[role] = String(k[role]);
      if (!Object.values(cand).every(v => AC_KEY_CODES[v])) throw new Error('Tecla no válida para el autoclick.');
      if (new Set(Object.values(cand)).size !== 3) throw new Error('Cada acción del autoclick necesita una tecla distinta.');
      next.autoclickKeys = cand;
    }
  }
  clearTimeout(autoclickPauseTimer); autoclickPausedUntil = 0;   // saving ends any key recording
  writeSettings(next); syncAutoclick(); broadcastAutoclickKeys();
  return autoclickState();
});
// While the Hub records a new key the helper is stopped, so pressing a key can't start clicking by accident.
ipcMain.handle('autoclick:pause', (_e, on) => {
  clearTimeout(autoclickPauseTimer);
  autoclickPausedUntil = on ? Date.now() + 30000 : 0;
  syncAutoclick();
  if (on) autoclickPauseTimer = setTimeout(() => { autoclickPausedUntil = 0; syncAutoclick(); }, 30500);
  return true;
});
// ---- Aviso de objetos (drops.js): global, the same for every profile ----
const dropAlertConfig = () => normalizeDropAlert(readSettings().dropAlert || {});
function broadcastDropAlert() {
  const config = dropAlertConfig();
  for (const id of games.keys()) sendClientCommand(id, { type: 'drop-alert-config', config }).catch(() => {});
}
ipcMain.handle('alerts:get', () => dropAlertConfig());
ipcMain.handle('alerts:save', (_e, patch) => {
  const p = patch && typeof patch === 'object' ? patch : {};
  const cur = dropAlertConfig(), next = { ...cur, items: [...cur.items] };
  if ('enabled' in p) next.enabled = Boolean(p.enabled);
  if ('volume' in p) next.volume = p.volume;
  if (Array.isArray(p.items)) next.items = p.items;
  if (p.addItem && typeof p.addItem === 'object') {
    if (!next.items.some(i => i.src === p.addItem.src)) next.items.push({ src: p.addItem.src, cls: p.addItem.cls, label: `Objeto ${next.items.length + 1}` });
    next.enabled = true;                           // teaching an object turns the alert on
  }
  if ('sensitivity' in p) next.sensitivity = p.sensitivity;
  const saved = normalizeDropAlert(next);
  writeSettings({ ...readSettings(), dropAlert: saved });
  broadcastDropAlert(); cleanupTemplates(saved); syncVisualWatch();
  return saved;
});
// A learned object appeared: blink the taskbar button if that window is not in front.
// If the game is muted, the chime is played by the launcher window instead.
ipcMain.handle('alerts:drop', (_e, profileId, info) => {
  const game = getGame(String(profileId || ''));
  const volume = Math.max(0, Math.min(100, Number(info && info.volume) || 0));
  if (game && !game.isDestroyed()) {
    if (!game.isFocused()) {
      try {
        game.flashFrame(true);
        if (!game.__bbFlashing) { game.__bbFlashing = true; game.once('focus', () => { game.__bbFlashing = false; try { game.flashFrame(false); } catch (_) {} }); }
      } catch (_) {}
    }
    if (game.webContents.isAudioMuted()) { notifyLauncher('alerts:chime', volume); return { playHere: false }; }
  }
  return { playHere: true };
});
ipcMain.handle('alerts:debug', (_e, text) => {
  try { const file = path.join(DATA_ROOT, 'drop-debug.txt'); fs.writeFileSync(file, `BoomBang Launcher ${LAUNCHER_VERSION}\n${String(text || '').slice(0, 8000)}\n`); return file; } catch (_) { return ''; }
});
ipcMain.handle('alerts:test', (_e, profileId, volume) => {
  const id = String(profileId || '');
  const game = getGame(id);
  if (game && !game.isDestroyed() && !game.webContents.isAudioMuted()) { sendClientCommand(id, { type: 'drop-alert-test', volume }).catch(() => {}); return 'game'; }
  notifyLauncher('alerts:chime', volume); return 'launcher';
});
ipcMain.handle('alerts:learn', async (_e, profileId) => {
  const id = String(profileId || '');
  const game = getGame(id);
  if (!game || game.isDestroyed()) return false;
  try { game.show(); game.focus(); } catch (_) {}
  return sendClientCommand(id, { type: 'drop-alert-learn' });
});
// ---- Objects painted by the game (canvas): found by their SHAPE in a small copy of the window (visual.js) ----
const TEMPLATE_DIR = path.join(DATA_ROOT, 'drop-templates');
const templateFile = id => path.join(TEMPLATE_DIR, `${id}.png`);
const visCache = new Map();             // id -> prepared template
const visHigh = new Map();              // `${profile}:${id}` -> currently matched (rings only on the way up)
const visLastRing = new Map();          // profile -> time of last chime
const visScores = new Map();            // profile -> { at, ok, scores: { id: best score } }  (shown live in the Hub)
let visWorker = null, visTimer = null, visBusy = false, visJob = 0;
const visPending = new Map();
function loadTemplate(id) {
  if (visCache.has(id)) return visCache.get(id);
  try {
    const img = nativeImage.createFromPath(templateFile(id));
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const t = visual.prepVariants(visual.grayDown(img.toBitmap(), width, height));   // 3 sizes of its outline
    if (!t.some(v => v.norm > 1)) return null;
    visCache.set(id, t);
    return t;
  } catch (_) { return null; }
}
function saveTemplateImage(img) {
  const { width, height } = img.getSize();
  if (width < 16 || height < 16) throw new Error('La imagen es demasiado pequeña.');
  if (width > 400 || height > 400) throw new Error('Recorta solo el objeto (máximo 400×400 píxeles).');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  fs.writeFileSync(templateFile(id), img.toPNG());
  if (!loadTemplate(id)) { try { fs.unlinkSync(templateFile(id)); } catch (_) {} throw new Error('En esa imagen no hay forma suficiente para reconocerla.'); }
  return id;
}
function addVisualItem(id) {
  const cur = dropAlertConfig();
  const saved = normalizeDropAlert({ ...cur, enabled: true, items: [...cur.items, { type: 'visual', id, label: `Objeto ${cur.items.length + 1}` }] });
  writeSettings({ ...readSettings(), dropAlert: saved });
  broadcastDropAlert(); syncVisualWatch();
  return saved;
}
function cleanupTemplates(cfg) {
  const keep = new Set(cfg.items.filter(i => i.type === 'visual').map(i => i.id));
  try { for (const f of fs.readdirSync(TEMPLATE_DIR)) { const id = f.replace(/\.png$/, ''); if (!keep.has(id)) { fs.unlinkSync(path.join(TEMPLATE_DIR, f)); visCache.delete(id); } } } catch (_) {}
}
function runMatch(frame, templates) {
  return new Promise(resolve => {
    if (!visWorker) {
      try {
        visWorker = new ThreadWorker(visual.WORKER_SOURCE, { eval: true });
        visWorker.on('message', m => { const r = visPending.get(m.job); visPending.delete(m.job); if (r) r(m.results); });
        const reset = () => { visWorker = null; for (const r of visPending.values()) r([]); visPending.clear(); };
        visWorker.on('error', reset); visWorker.on('exit', reset);
      } catch (_) { visWorker = null; return resolve([]); }
    }
    const job = ++visJob; visPending.set(job, resolve);
    visWorker.postMessage({ job, frame: frame.data.buffer, w: frame.w, h: frame.h,
      templates: templates.flatMap(t => t.t.map(v => ({ id: t.id, data: v.data.slice().buffer, w: v.w, h: v.h, norm: v.norm }))) }, [frame.data.buffer]);
  });
}
function ringFromMain(profileId, label, volume) {
  const game = getGame(profileId);
  const now = Date.now();
  if (now - (visLastRing.get(profileId) || 0) < 4000) return false;   // rang a moment ago: try again on the next look
  visLastRing.set(profileId, now);
  if (!game || game.isDestroyed()) return false;
  if (!game.isFocused()) {
    try { game.flashFrame(true); if (!game.__bbFlashing) { game.__bbFlashing = true; game.once('focus', () => { game.__bbFlashing = false; try { game.flashFrame(false); } catch (_) {} }); } } catch (_) {}
  }
  if (game.webContents.isAudioMuted()) notifyLauncher('alerts:chime', volume);
  sendClientCommand(profileId, { type: 'drop-alert-ring', label, volume, sound: !game.webContents.isAudioMuted() }).catch(() => {});
  return true;
}
async function visualTick() {
  if (visBusy) return;
  const cfg = dropAlertConfig();
  const tpls = cfg.items.filter(i => i.type === 'visual').map(i => ({ id: i.id, label: i.label, t: loadTemplate(i.id) })).filter(x => x.t);
  if (!cfg.enabled || !tpls.length) return;
  visBusy = true;
  const thr = visual.THRESHOLDS[cfg.sensitivity] || visual.THRESHOLDS.media;
  try {
    for (const [id, game] of games) {
      if (!game || game.isDestroyed()) continue;
      // Also works with the window minimised or behind others: the page is asked for a frame without showing it.
      let img = null;
      try { img = await game.webContents.capturePage(undefined, { stayHidden: true }); } catch (_) { img = null; }
      if ((!img || img.isEmpty()) && !game.isMinimized()) { try { img = await game.webContents.capturePage(); } catch (_) { img = null; } }
      if (!img || img.isEmpty()) {
        // Can't see the game right now: forget what was on screen, so the next object rings even if it looks the same.
        for (const t of tpls) visHigh.set(`${id}:${t.id}`, false);
        visScores.set(id, { at: Date.now(), ok: false, scores: {} });
        continue;
      }
      const { width, height } = img.getSize();
      const frame = visual.edges(visual.grayDown(img.toBitmap(), width, height));
      const results = await runMatch(frame, tpls);
      const best = {};
      for (const r of results) if (!(r.id in best) || r.score > best[r.id]) best[r.id] = r.score;   // best of the 3 sizes
      visScores.set(id, { at: Date.now(), ok: true, scores: best });
      for (const [tid, score] of Object.entries(best)) {
        const key = `${id}:${tid}`, was = visHigh.get(key) === true;
        if (score >= thr && !was) { const t = tpls.find(x => x.id === tid); if (ringFromMain(id, t ? t.label : 'Objeto', cfg.volume)) visHigh.set(key, true); }
        else if (score < visual.REARM && was) visHigh.set(key, false);
      }
    }
  } finally { visBusy = false; }
}
function syncVisualWatch() {
  const cfg = dropAlertConfig();
  const need = cfg.enabled && cfg.items.some(i => i.type === 'visual');
  if (need && !visTimer) visTimer = setInterval(() => { visualTick().catch(() => {}); }, 1000);
  if (!need && visTimer) { clearInterval(visTimer); visTimer = null; if (visWorker) { try { visWorker.terminate(); } catch (_) {} visWorker = null; } }
}
ipcMain.handle('alerts:learn-visual', async (_e, profileId, point) => {
  const game = getGame(String(profileId || ''));
  if (!game || game.isDestroyed() || !point) return null;
  const b = game.getContentBounds();
  const x = Math.round(Number(point.screenX) - b.x), y = Math.round(Number(point.screenY) - b.y), R = 40;
  if (!(x >= 0 && y >= 0 && x < b.width && y < b.height)) return null;
  const rect = { x: Math.max(0, x - R), y: Math.max(0, y - R), width: Math.min(2 * R, b.width - Math.max(0, x - R)), height: Math.min(2 * R, b.height - Math.max(0, y - R)) };
  const img = await game.webContents.capturePage(rect);
  return addVisualItem(saveTemplateImage(img));
});
ipcMain.handle('alerts:add-image', (_e, dataUrl) => {
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|bmp);base64,/i.test(dataUrl) || dataUrl.length > 3 * 1024 * 1024) throw new Error('Formato de imagen no válido.');
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) throw new Error('No se pudo leer la imagen.');
  return addVisualItem(saveTemplateImage(img));
});
ipcMain.handle('alerts:scores', (_e, profileId) => {
  const cfg = dropAlertConfig();
  const v = visScores.get(String(profileId || ''));
  return { threshold: visual.THRESHOLDS[cfg.sensitivity] || visual.THRESHOLDS.media, watching: Boolean(visTimer), ...(v || { at: 0, ok: false, scores: {} }) };
});
ipcMain.handle('alerts:template', (_e, id) => {
  if (!/^[a-z0-9]{6,24}$/.test(String(id || ''))) return '';
  try { const img = nativeImage.createFromPath(templateFile(String(id))); return img.isEmpty() ? '' : img.toDataURL(); } catch (_) { return ''; }
});
ipcMain.handle('server:check', () => broadcastServerStatus());
ipcMain.handle('news:fetch', () => fetchNews());
ipcMain.handle('app:openPath', (_e, target) => {
  if (typeof target !== 'string' || !target) return false;
  shell.openPath(target);
  return true;
});
ipcMain.handle('cache:clear', async (_e, id) => { await clearProfileSession(id); return true; });
ipcMain.handle('client:get-settings', (_e, id) => getClientSettings(String(id || '')));
ipcMain.handle('client:save-settings', (_e, id, updates) => writeClientSettings(String(id || ''), updates));
ipcMain.handle('client:reload', (_e, id) => { const game = games.get(String(id || '')); if (game && !game.isDestroyed()) game.reload(); return true; });
ipcMain.handle('client:fullscreen', (_e, id, force) => { const game = games.get(String(id || '')); if (!game || game.isDestroyed()) return false; const next = typeof force === 'boolean' ? force : !game.isFullScreen(); game.setFullScreen(next); return next; });
ipcMain.handle('client:is-fullscreen', (_e, id) => { const game = games.get(String(id || '')); return Boolean(game && !game.isDestroyed() && game.isFullScreen()); });
ipcMain.handle('client:set-always-on-top', (_e, id, value) => { const game = games.get(String(id || '')); if (!game || game.isDestroyed()) return false; const next = Boolean(value); game.setAlwaysOnTop(next, 'floating'); return next; });
ipcMain.handle('client:is-always-on-top', (_e, id) => { const game = games.get(String(id || '')); return Boolean(game && !game.isDestroyed() && game.isAlwaysOnTop()); });
ipcMain.handle('client:set-muted', (_e, id, value) => { const game = games.get(String(id || '')); if (!game || game.isDestroyed()) return false; const next = Boolean(value); game.webContents.setAudioMuted(next); writeClientSettings(String(id || ''), { muted: next }); return next; });
ipcMain.handle('client:is-muted', (_e, id) => { const game = games.get(String(id || '')); return Boolean(game && !game.isDestroyed() && game.isAudioMuted()); });
ipcMain.handle('client:probe-latency', () => probeClientLatency());
ipcMain.handle('client:session-ready', (_e, id) => markClientSessionReady(String(id || '')));
ipcMain.handle('client:probe-display-ping', (_e, id) => probeDisplayedClientPing(String(id || '')));
ipcMain.handle('client:game-context', async (_e, id) => detectClientGame(String(id || '')));
ipcMain.handle('client:get-focused-user', (_e, id) => focusedUsers.get(String(id || '')) || '');

// Real mouse click inside the game (used by the Smart Bar upper-colour buttons).
// Coordinates are viewport pixels of the game frame, which fills the window.
function performGameClick(profileId, point) {
  const game = getGame(String(profileId || ''));
  if (!game || !point) return { ok: false, message: 'Cliente no disponible.' };
  try {
    const b = game.getContentBounds();
    const x = Math.max(1, Math.min(Math.max(2, b.width - 2), Math.round(Number(point.x))));
    const y = Math.max(1, Math.min(Math.max(2, b.height - 2), Math.round(Number(point.y))));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, message: 'Coordenadas inválidas.' };
    game.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    game.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    game.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return { ok: true, x, y };
  } catch (error) { return { ok: false, message: error?.message || 'No se pudo hacer clic.' }; }
}
ipcMain.handle('client:game-click', (_e, id, point) => performGameClick(id, point));

// Ping to the real game server (ICMP). Median of the last 5 samples.
ipcMain.handle('client:probe-ping', async (_e, id) => {
  const pid = String(id || '');
  const host = String(getClientSettings(pid).pingHost || DEFAULT_PING_HOST);
  const ms = await pingHost(host, 2000);
  let tracker = pingTrackers.get(pid);
  if (!tracker) { tracker = new RttTracker(5); pingTrackers.set(pid, tracker); }
  tracker.add(ms);
  return tracker.median();
});
ipcMain.on('client:focused-user',(_e,profileId,username)=>{ const id=String(profileId||''); const value=String(username||'').trim().slice(0,32); if(value) focusedUsers.set(id,value); else focusedUsers.delete(id); });

ipcMain.handle('auth:get', (_e, id) => getCredentials(String(id || '')));
ipcMain.handle('auth:has', (_e, id) => Boolean(getCredentials(String(id || ''))));
ipcMain.handle('auth:save', (_e, payload) => {
  if (!payload?.profileId || !payload?.username || !payload?.password) return false;
  return saveCredentials(String(payload.profileId), payload.username, payload.password);
});
ipcMain.handle('auth:clear', (_e, id) => { clearCredentials(String(id || '')); return true; });


async function detectClientGame(profileId) {
  const game = getGame(profileId);
  if (!game) return { id: 'unknown', label: 'No disponible', confidence: 0 };
  const frames = [];
  try {
    if (game.webContents.mainFrame) frames.push(game.webContents.mainFrame);
    for (const frame of game.webContents.mainFrame?.frames || []) if (!frames.includes(frame)) frames.push(frame);
  } catch (_) {}
  const candidates = [
    ['sendero', 'Sendero Oculto', /sendero\s+oculto/i],
    ['cocos', 'Cocos Locos', /cocos\s+locos/i],
    ['camino', 'Camino Ninja', /camino\s+ninja/i],
    ['simon', 'Simón Dice', /sim[oó]n\s+dice/i],
    ['papa', 'Papa Caliente', /papa\s+caliente/i],
    ['colapso', 'Colapso', /colapso/i],
    ['mano', 'Mano Oculta', /mano\s+oculta/i],
    ['battle', 'Battle Royal', /battle\s+royal/i],
    ['clanwars', 'Clan Wars', /clan\s+wars/i],
    ['ctf', 'Captura la Bandera', /captura\s+la\s+bandera/i]
  ];
  for (const frame of frames) {
    try {
      const result = await frame.executeJavaScript(`(() => ({ active: window.__BB_ACTIVE_MINIGAME__ || 'unknown', body: String(document.body?.innerText || '').slice(-5000), url: location.href }))()`, true);
      const active = String(result?.active || 'unknown');
      const match = candidates.find(([id]) => id === active);
      if (match) return { id: match[0], label: match[1], confidence: 0.98 };
      const body = String(result?.body || '');
    } catch (_) {}
  }
  return { id: 'unknown', label: 'No detectado', confidence: 0 };
}

function probeClientLatency() {
  return new Promise(resolve => {
    const url = 'https://static.boombang.tv/betahtml5/game.html?lang=es&bb_latency_probe=1';
    const request = net.request({ method: 'GET', url });
    let settled = false;
    const start = Date.now();
    const finish = latency => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch (_) {}
      resolve(Number.isFinite(latency) ? latency : null);
    };
    const timer = setTimeout(() => finish(null), 3500);
    request.on('response', response => {
      clearTimeout(timer);
      finish(Date.now() - start);
      try { response.resume(); } catch (_) {}
    });
    request.on('error', () => { clearTimeout(timer); finish(null); });
    request.end();
  });
}


async function probeDisplayedClientPing(profileId) {
  const game = getGame(profileId);
  if (!game) return null;
  const frames = [];
  try {
    if (game.webContents.mainFrame) frames.push(game.webContents.mainFrame);
    for (const frame of game.webContents.mainFrame?.frames || []) {
      if (!frames.includes(frame)) frames.push(frame);
    }
  } catch (_) {}

  const regexSource = String.raw`(?:\\bping\\b|latencia)\\s*[:=]?\\s*(\\d{1,4})\\s*ms`;
  for (const frame of frames) {
    try {
      const value = await frame.executeJavaScript(`(() => {
        const text = String(document.body?.innerText || document.documentElement?.innerText || '').replace(/\\s+/g, ' ');
        const m = text.match(new RegExp(${JSON.stringify(regexSource)}, 'i'));
        return m ? Number(m[1]) : null;
      })()`, true);
      if (Number.isFinite(value)) return value;
    } catch (_) {}
  }
  return null;
}

function getGame(profileId) {
  const game = games.get(String(profileId || ''));
  return game && !game.isDestroyed() ? game : null;
}

async function sendClientCommand(profileId, command) {
  const game = getGame(profileId);
  if (!game) return false;

  let delivered = false;
  try {
    // Keep the old top-level delivery as a harmless fallback.
    game.webContents.send('client-panel:command', command);
    delivered = true;
  } catch (_) {}

  // The actual BoomBang UI lives in a static.boombang.tv child frame.
  // Send the command directly into that frame so Vista/Zoom/status settings
  // are applied to the real client instead of only the outer page.
  try {
    const frames = game.webContents.mainFrame?.frames || [];
    const targets = frames.filter(frame => /static\.boombang\.tv\/betahtml5\/game\.html/i.test(frame.url));
    const payload = JSON.stringify(command);
    for (const frame of targets) {
      try {
        if (typeof game.webContents.sendToFrame === 'function' && frame.routingId != null) {
          game.webContents.sendToFrame(frame.routingId, 'client-panel:command', command);
          delivered = true;
        }
      } catch (_) {}
      try {
        await frame.executeJavaScript(`document.dispatchEvent(new CustomEvent('__bb_launcher_command',{detail:${payload}})); true;`, true);
        delivered = true;
      } catch (_) {}
    }
  } catch (_) {}

  return delivered;
}


function openHubWindow(profileId, mode = 'window', tab = 'home') {
  const id = String(profileId || '');
  const game = getGame(id);
  if (!game) return false;

  const existing = hubWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    try {
      existing.setAlwaysOnTop(mode === 'window-top', 'floating');
      existing.show();
      existing.focus();
      existing.webContents.send('hub:open-tab', tab);
    } catch (_) {}
    return true;
  }

  const profile = readProfiles().find(p => String(p.id) === id);
  const titleName = profile?.name || 'BoomBang';
  const hub = new BrowserWindow({
    width: 930,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: `BB Hub — ${titleName}`,
    icon: APP_ICON,
    backgroundColor: '#06101b',
    autoHideMenuBar: true,
    frame: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'hub-window-preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  hubWindows.set(id, hub);
  hub.setAlwaysOnTop(mode === 'window-top', 'floating');

  hub.on('closed', () => {
    if (hubWindows.get(id) === hub) hubWindows.delete(id);
  });

  hub.loadFile(path.join(__dirname, 'hub-window.html'), {
    query: {
      profileId: id,
      profileName: titleName,
      tab: tab || 'home'
    }
  }).catch(() => {});

  return true;
}

function openHubForProfile(profileId, requestedTab = 'home') {
  const id = String(profileId || '');
  const game = getGame(id);
  if (!game) return false;
  const mode = getHubData(id).openMode || DEFAULT_HUB_DATA.openMode;

  if (mode === 'overlay') {
    sendClientCommand(id, { type: 'hub', action: 'open', tab: requestedTab }).catch(() => {});
    return true;
  }

  return openHubWindow(id, mode, requestedTab);
}

async function quickAction(profileId, action) {
  const game = getGame(profileId);
  if (!game) return { ok: false, message: 'El cliente no está abierto.' };
  const frames = [];
  try {
    if (game.webContents.mainFrame) frames.push(game.webContents.mainFrame);
    for (const frame of game.webContents.mainFrame?.frames || []) {
      if (!frames.includes(frame)) frames.push(frame);
    }
  } catch (_) {}
  const frame = frames.find(f => /static\.boombang\.tv\/betahtml5\/game\.html/i.test(f.url));
  if (!frame) return { ok: false, message: 'No se encontró el cliente HTML5.' };

  const actionName = String(action || '');
  if (['open-games','games','areas','islands','houses','search'].includes(actionName)) {
    try { await sendClientCommand(profileId, { type: 'game-assist', payload: { action: 'reset', gameId: 'unknown' } }); } catch (_) {}
  }
  const script = `
    (async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const norm = v => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const clickLabel = (label, options = {}) => {
        const wanted = norm(label);
        const contains = !!options.contains;
        const candidates = [...document.querySelectorAll('button,[role="button"],a,[tabindex],div,span')];
        for (const el of candidates) {
          if (!visible(el)) continue;
          const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label'));
          if (!text) continue;
          const match = contains ? text.includes(wanted) : text === wanted;
          if (!match) continue;
          let node = el;
          for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
            if (!visible(node)) continue;
            const r = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            if (style.cursor === 'pointer' || node.matches('button,[role="button"],a')) {
              try { node.click(); return true; } catch (_) {}
              try {
                node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return true;
              } catch (_) {}
            }
            if (r.width > 0 && r.height > 0 && style.pointerEvents !== 'none') {
              try { node.click(); return true; } catch (_) {}
            }
          }
        }
        return false;
      };
      const clickJuegos = () => clickLabel('juegos', { contains: false });
      const openGames = async () => {
        if (clickJuegos()) { await sleep(650); return true; }
        return /\\bjuegos\\b/i.test(String(document.body?.innerText || '')) ? true : false;
      };
      const direct = {
        areas: ['áreas','areas'],
        games: ['juegos'],
        islands: ['islas'],
        houses: ['casas'],
        search: ['buscar']
      };
      const clickDirect = async (key) => {
        const labels = direct[key] || [];
        for (const label of labels) if (clickLabel(label, { contains: false })) return { ok: true, message: label + ' abierto.' };
        return { ok: false, message: 'No encontré ' + key + ' en la interfaz actual.' };
      };

      if (${JSON.stringify(actionName)} === 'open-games') return await openGames().then(ok => ok ? ({ok:true,message:'Menú Juegos abierto.'}) : ({ok:false,message:'No pude abrir el menú Juegos.'}));
      if (${JSON.stringify(actionName)} === 'areas') return await clickDirect('areas');
      if (${JSON.stringify(actionName)} === 'games') return await clickDirect('games');
      if (${JSON.stringify(actionName)} === 'islands') return await clickDirect('islands');
      if (${JSON.stringify(actionName)} === 'houses') return await clickDirect('houses');
      if (${JSON.stringify(actionName)} === 'search') return await clickDirect('search');
      return { ok: false, message: 'Acceso rápido no reconocido.' };
    })()
  `;

  try {
    const result = await frame.executeJavaScript(script, true);
    return result || { ok: false, message: 'Sin respuesta del cliente.' };
  } catch (error) {
    return { ok: false, message: error?.message || 'No se pudo ejecutar el acceso rápido.' };
  }
}

ipcMain.handle('client:open-panel', (_e, id) => openHubForProfile(id, 'home'));
ipcMain.handle('client:panel-action', async (_e, id, action, payload) => {
  const profileId = String(id || '');
  const game = getGame(profileId);
  switch (String(action || '')) {
    case 'get-settings':
      return getClientSettings(profileId);
    case 'set-settings': {
      const updates = payload && typeof payload === 'object' ? payload : {};
      const saved = writeClientSettings(profileId, updates);
      if (Object.prototype.hasOwnProperty.call(updates, 'alwaysOnTop') && game) game.setAlwaysOnTop(Boolean(saved.alwaysOnTop), 'floating');
      await sendClientCommand(profileId, { type: 'settings', settings: saved });
      return saved;
    }
    case 'fullscreen': {
      if (!game) return false;
      const next = typeof payload === 'boolean' ? payload : !game.isFullScreen();
      game.setFullScreen(next);
      return next;
    }
    case 'reload':
      if (game) game.reload();
      return true;
    case 'mute': {
      if (!game) return false;
      const next = typeof payload === 'boolean' ? payload : !game.isAudioMuted();
      game.webContents.setAudioMuted(next);
      writeClientSettings(profileId, { muted: next });
      return next;
    }
    case 'quick-action':
      return await quickAction(profileId, payload);
    case 'diagnostics': {
      const settings = getClientSettings(profileId);
      return {
        launcherVersion: LAUNCHER_VERSION,
        profileId,
        profileName: readProfiles().find(p => p.id === profileId)?.name || '—',
        viewport: game ? game.getContentBounds() : null,
        fitMode: settings.fitMode,
        zoom: settings.zoom,
        showPerformance: settings.showPerformance,
        showStatusBar: settings.showStatusBar,
        cleanMode: settings.cleanMode,
        alwaysOnTop: game ? game.isAlwaysOnTop() : Boolean(settings.alwaysOnTop),
        muted: game ? game.isAudioMuted() : Boolean(settings.muted)
      };
    }
    case 'show-launcher':
      showLauncher();
      return true;
    case 'open-hub':
      return openHubForProfile(profileId, payload?.tab || 'home');
    case 'game-assist': {
      const command = { type: 'game-assist', payload: payload && typeof payload === 'object' ? payload : {} };
      return await sendClientCommand(profileId, command);
    }
    case 'client-visual': {
      const command = { type: 'client-visual', payload: payload && typeof payload === 'object' ? payload : {} };
      return await sendClientCommand(profileId, command);
    }
    case 'chat-shortcut': {
      const command = { type: 'chat-shortcut', payload: { text: String(payload?.text || '') } };
      return await sendClientCommand(profileId, command);
    }
    case 'get-focused-user':
      return focusedUsers.get(profileId) || '';
    case 'smartbar-learn':
      return await sendClientCommand(profileId, { type: 'smartbar-learn', payload: payload && typeof payload === 'object' ? payload : {} });
    case 'smartbar-upper':
      return await sendClientCommand(profileId, { type: 'smartbar-upper', payload: payload && typeof payload === 'object' ? payload : {} });
    case 'focus-game':
      if (game) { game.show(); game.focus(); }
      return true;
    case 'close-panel': {
      const hub = hubWindows.get(profileId);
      if (hub && !hub.isDestroyed()) hub.close();
      return true;
    }
    default:
      return false;
  }
});

ipcMain.handle('hub:get-context', (_e, id) => {
  const profileId = String(id || '');
  const profile = readProfiles().find(p => String(p.id) === profileId);
  const active = activeClientSessions.get(profileId);
  return {
    profileId,
    profileName: profile?.name || 'BoomBang',
    clientSettings: getClientSettings(profileId),
    sessionStartedAt: active?.ready && active.startedAt ? active.startedAt : Date.now(),
    openMode: getHubData(profileId).openMode || DEFAULT_HUB_DATA.openMode
  };
});
ipcMain.handle('hub:get-data', (_e, id) => getHubData(String(id || '')));
ipcMain.handle('hub:save-data', (_e, id, updates) => writeHubData(String(id || ''), updates && typeof updates === 'object' ? updates : {}));
ipcMain.handle('hub:quick-action', async (_e, id, action) => quickAction(String(id || ''), String(action || '')));
ipcMain.handle('hub:open-url', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) { shell.openExternal(url); return true; } return false; });
ipcMain.handle('hub:close-window', (_e, id) => {
  const hub = hubWindows.get(String(id || ''));
  if (hub && !hub.isDestroyed()) {
    hub.close();
    return true;
  }
  return false;
});
ipcMain.handle('hub:focus-window', (_e, id) => {
  const hub = hubWindows.get(String(id || ''));
  if (hub && !hub.isDestroyed()) {
    hub.show();
    hub.focus();
    return true;
  }
  return openHubForProfile(String(id || ''), 'home');
});

ipcMain.handle('hub:performance', (_e, id) => {
  const game = getGame(String(id || ''));
  if (!game || game.isDestroyed()) return { ok: false };
  return { ok: true, frameRate: 60, audioMuted: game.isAudioMuted(), fullScreen: game.isFullScreen() };
});

ipcMain.handle('diagnostics:get', () => ({
  launcherVersion: LAUNCHER_VERSION,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  profiles: readProfiles().length,
  gamesOpen: [...games.values()].filter(g => g && !g.isDestroyed()).length,
  dataRoot: DATA_ROOT,
  sessionData: SESSION_DATA
}));
ipcMain.handle('app:openDataFolder', async () => {
  ensureDataRoot();
  await shell.openPath(DATA_ROOT);
  return DATA_ROOT;
});
ipcMain.handle('app:openExternal', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.handle('app:version', () => LAUNCHER_VERSION);

// ---- Updates from GitHub (see updater.js / update.json) ----
function getBuffer(url, limit = 70 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\/(raw\.githubusercontent\.com|codeload\.github\.com)\//.test(url)) return reject(new Error('URL no permitida'));
    const request = net.request({ method: 'GET', url, redirect: 'follow' });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => { try { request.abort(); } catch (_) {} reject(new Error('tiempo de espera agotado')); }, 120000);
    request.on('response', response => {
      if (response.statusCode < 200 || response.statusCode >= 300) { clearTimeout(timer); response.resume?.(); return reject(new Error(`HTTP ${response.statusCode}`)); }
      response.on('data', c => { size += c.length; if (size > limit) { try { request.abort(); } catch (_) {} clearTimeout(timer); reject(new Error('archivo demasiado grande')); } else chunks.push(c); });
      response.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      response.on('error', e => { clearTimeout(timer); reject(e); });
    });
    request.on('error', e => { clearTimeout(timer); reject(e); });
    request.end();
  });
}
function expandZip(zipFile, dest) {
  return new Promise((resolve, reject) => {
    const q = v => `'${String(v).replace(/'/g, "''")}'`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${q(zipFile)} -DestinationPath ${q(dest)} -Force`],
      { windowsHide: true, timeout: 180000 }, error => (error ? reject(new Error('no se pudo descomprimir')) : resolve()));
  });
}
function npmInstall(dir) {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, windowsHide: true, shell: process.platform === 'win32', stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve({ ok: false, message: 'tardó demasiado' }); }, 10 * 60 * 1000);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, message: e.message }); });
    child.on('exit', code => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, message: `código ${code}` }); });
  });
}
const updater = createUpdater({ appDir: __dirname, dataDir: DATA_ROOT, currentVersion: LAUNCHER_VERSION, getBuffer, extract: expandZip, npmInstall });
// Installed version (BoomBang-Launcher-Setup.exe): updates come from GitHub Releases through electron-updater.
// Source version (Iniciar.bat / npm start): updater.js downloads the branch ZIP.
let installedUpdater = null;
function getInstalledUpdater() {
  if (!installedUpdater) {
    installedUpdater = require('electron-updater').autoUpdater;
    installedUpdater.autoDownload = false;
    installedUpdater.autoInstallOnAppQuit = false;
    installedUpdater.on('error', () => {});
  }
  return installedUpdater;
}
async function releaseNotes(version) {
  const cfg = readConfig(__dirname);
  if (!cfg) return '';
  try { return notesFor((await getBuffer(`https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/CHANGELOG.md?t=${Date.now()}`)).toString('utf8'), version); } catch (_) { return ''; }
}
async function checkInstalled() {
  try {
    const result = await getInstalledUpdater().checkForUpdates();
    const latest = String(result && result.updateInfo && result.updateInfo.version || '');
    if (!latest) return { ok: false, configured: true, current: LAUNCHER_VERSION, message: 'No se encontró ninguna versión publicada.' };
    const available = isNewer(latest, LAUNCHER_VERSION);
    return { ok: true, configured: true, current: LAUNCHER_VERSION, latest, available, notes: available ? await releaseNotes(latest) : '' };
  } catch (error) {
    return { ok: false, configured: true, current: LAUNCHER_VERSION, message: `No se pudo comprobar (${String(error && error.message || error).split('\n')[0].slice(0, 160)}).` };
  }
}
let installedBusy = false;
async function applyInstalled() {
  if (installedBusy) return { ok: false, message: 'Ya se está actualizando.' };
  installedBusy = true;
  const u = getInstalledUpdater();
  const onProgress = p => notifyLauncher('update:progress', `Descargando… ${Math.round(p && p.percent || 0)}%`);
  try {
    const check = await u.checkForUpdates();
    const latest = String(check && check.updateInfo && check.updateInfo.version || '');
    if (!isNewer(latest, LAUNCHER_VERSION)) return { ok: false, message: 'No se pudo actualizar: ya tienes la última versión.' };
    notifyLauncher('update:progress', 'Descargando…');
    u.on('download-progress', onProgress);
    await u.downloadUpdate();
    notifyLauncher('update:progress', 'Listo. Instalando y reiniciando…');
    setTimeout(() => { isQuitting = true; stopAutoclick(); try { u.quitAndInstall(true, true); } catch (_) { app.relaunch(); app.exit(0); } }, 1200);
    return { ok: true, version: latest };
  } catch (error) {
    return { ok: false, message: `No se pudo actualizar: ${String(error && error.message || error).split('\n')[0].slice(0, 160)}.` };
  } finally {
    u.removeListener('download-progress', onProgress);
    installedBusy = false;
  }
}
ipcMain.handle('update:check', () => (app.isPackaged ? checkInstalled() : updater.check()));
ipcMain.handle('update:apply', async () => {
  if (games.size) return { ok: false, message: 'Cierra BoomBang antes de actualizar.' };
  if (app.isPackaged) return applyInstalled();
  const r = await updater.apply(step => notifyLauncher('update:progress', step));
  if (r.ok) setTimeout(() => { isQuitting = true; stopAutoclick(); app.relaunch(); app.exit(0); }, 1200);
  return r;
});
function scheduleUpdateCheck() {
  if (readSettings().autoUpdateCheck === false) return;
  setTimeout(async () => {
    try { const r = app.isPackaged ? await checkInstalled() : await updater.check(); if (r.ok && r.available) notifyLauncher('update:available', r); } catch (_) {}
  }, 4000);
}

app.whenReady().then(() => { ensureDataRoot(); const settings = readSettings(); applyStartupSettings(settings); createLauncher(); createTray(); syncAutoclick(); syncVisualWatch(); scheduleUpdateCheck(); startServerMonitor(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createLauncher(); else showLauncher(); }); });
app.on('before-quit', () => {
  isQuitting = true; stopAutoclick(); if (serverTimer) clearInterval(serverTimer); try { tray?.destroy(); } catch (_) {} tray = null;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && (!readSettings().minimizeToTray || isQuitting)) app.quit(); });
