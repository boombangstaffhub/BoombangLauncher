'use strict';
// Discord (private messages only) inside the launcher.
//
// A small window with discord.com (the normal Discord website), in its own session: you sign in there once (email
// or the QR code of the phone app) and it stays signed in. The launcher never sees or stores your Discord password
// or login: the website keeps it, like a browser would. Servers are hidden and can't be opened: only your private
// messages and groups. The bubble in the game shows how many unread messages there are.

const HOME = 'https://discord.com/channels/@me';
const PARTITION = 'persist:bb-discord';
// Everything that is a server (or server browsing) is not allowed here: back to the private messages.
const BLOCKED_PATH = /^\/(channels\/\d+(\/|$)|guild-discovery|discovery|servers|store|shop|quest-home|nitro)/i;
const HIDE_SERVERS_CSS = `
  nav[aria-label*="Servers" i], nav[aria-label*="Servidores" i], nav[aria-label*="servidor" i],
  [class^="guilds_"], [class*=" guilds_"] { display: none !important; }
`;

function isDiscordUrl(u) { try { const x = new URL(u); return /(^|\.)discord\.com$/i.test(x.hostname); } catch (_) { return false; } }
function isBlocked(u) { try { const x = new URL(u); return isDiscordUrl(u) && BLOCKED_PATH.test(x.pathname); } catch (_) { return false; } }
function unreadFromTitle(title) { const m = /^\s*\((\d+)\)/.exec(String(title || '')); return m ? Number(m[1]) : 0; }

function createDiscord({ BrowserWindow, session, shell, getBounds = () => null, saveBounds = () => {}, onUnread = () => {}, icon }) {
  let win = null, unread = 0, parentGame = null;

  function prepareSession() {
    const ses = session.fromPartition(PARTITION);
    if (ses.__bbReady) return ses;
    ses.__bbReady = true;
    // Look like a normal Chrome (Discord shows "browser not supported" to unknown apps).
    try { ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|boombang[\w-]*)\/[\d.]+/gi, '')); } catch (_) {}
    // Only notifications (new message pop-ups) are allowed; no camera, microphone, screen, location…
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'));
    try { ses.setPermissionCheckHandler((_wc, permission) => permission === 'notifications'); } catch (_) {}
    return ses;
  }

  function setUnread(n) { n = Math.max(0, n | 0); if (n !== unread) { unread = n; onUnread(n); } }

  function create() {
    const ses = prepareSession();
    const b = getBounds() || {};
    win = new BrowserWindow({
      width: b.width || 420, height: b.height || 640, x: b.x, y: b.y,
      minWidth: 340, minHeight: 420, show: false, title: 'Discord · Mensajes directos', autoHideMenuBar: true,
      backgroundColor: '#313338', icon,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, spellcheck: true }
    });
    win.setMenuBarVisibility(false);
    const wc = win.webContents;
    const guard = url => { if (isBlocked(url)) { setTimeout(() => { try { wc.loadURL(HOME); } catch (_) {} }, 0); return true; } return false; };
    wc.on('will-navigate', (e, url) => {
      if (!isDiscordUrl(url) && !/hcaptcha|recaptcha|google\.com\/recaptcha/i.test(url)) { e.preventDefault(); shell.openExternal(url).catch(() => {}); return; }
      if (isBlocked(url)) { e.preventDefault(); guard(url); }
    });
    wc.on('did-navigate', (_e, url) => guard(url));
    wc.on('did-navigate-in-page', (_e, url) => guard(url));     // Discord moves between chats without reloading
    wc.on('dom-ready', () => { wc.insertCSS(HIDE_SERVERS_CSS).catch(() => {}); });
    // Links in messages open in your normal browser; Discord's own pop-ups stay inside.
    wc.setWindowOpenHandler(({ url }) => {
      if (isDiscordUrl(url) && !isBlocked(url)) { wc.loadURL(url); return { action: 'deny' }; }
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    win.on('page-title-updated', (e, title) => { e.preventDefault(); setUnread(unreadFromTitle(title)); });
    const remember = () => { try { if (!win.isMinimized() && !win.isFullScreen()) saveBounds(win.getBounds()); } catch (_) {} };
    win.on('resized', remember); win.on('moved', remember);
    // Closing only hides it: it keeps counting new messages for the bubble. It really closes with the launcher.
    win.on('close', e => { if (!win.__bbQuit) { e.preventDefault(); win.hide(); } });
    win.on('closed', () => { win = null; });
    wc.loadURL(HOME);
    return win;
  }

  function placeNear(game) {
    if (!win || !game || game.isDestroyed()) return;
    if (getBounds()) return;                                   // the user already placed it: keep their spot
    try {
      const g = game.getBounds(), w = win.getBounds();
      win.setBounds({ x: g.x + g.width - w.width - 24, y: g.y + 70, width: w.width, height: Math.min(w.height, g.height - 100) });
    } catch (_) {}
  }

  function show(game) {
    if (!win || win.isDestroyed()) create();
    // In front of the game window (a child of it), without being "always on top" of every other app.
    try {
      if (game && !game.isDestroyed() && parentGame !== game) { win.setParentWindow(game); parentGame = game; }
    } catch (_) {}
    placeNear(game);
    win.show(); win.focus();
  }
  function hide() { try { if (win && !win.isDestroyed()) win.hide(); } catch (_) {} }
  function toggle(game) { if (win && !win.isDestroyed() && win.isVisible()) hide(); else show(game); }

  // The game window is closing: don't let Discord close with it (child windows close with their parent).
  function detachFrom(game) {
    if (win && !win.isDestroyed() && parentGame === game) { try { win.setParentWindow(null); } catch (_) {} parentGame = null; hide(); }
  }

  async function logout() {
    const ses = prepareSession();
    try { await ses.clearStorageData(); } catch (_) {}
    try { await ses.clearCache(); } catch (_) {}
    setUnread(0);
    if (win && !win.isDestroyed()) win.webContents.loadURL(HOME);
    return true;
  }

  function quit() { if (win && !win.isDestroyed()) { win.__bbQuit = true; try { win.destroy(); } catch (_) {} } }

  return { show, hide, toggle, detachFrom, logout, quit, unread: () => unread, isOpen: () => !!(win && !win.isDestroyed() && win.isVisible()) };
}

module.exports = { createDiscord, isBlocked, isDiscordUrl, unreadFromTitle, HOME, PARTITION };
