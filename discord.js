'use strict';
// Discord chat bubbles (private messages only), like "chat heads".
//
// The launcher keeps the normal Discord website (discord.com) running hidden, in its own session: you sign in there
// once (email or the phone QR code) and it stays signed in. The launcher never sees or stores your Discord password:
// the website keeps its login, like a browser would.
// From that hidden page the launcher reads your private chats (name, picture, unread messages). When someone writes
// to you, a bubble with their profile picture appears over the game. Clicking it opens ONLY that conversation in a
// small window (no server list, no friend list, nothing else). Servers can't be opened at all.

const HOME = 'https://discord.com/channels/@me';
const PARTITION = 'persist:bb-discord';
const BLOCKED_PATH = /^\/(channels\/\d+(\/|$)|guild-discovery|discovery|servers|store|shop|quest-home|nitro)/i;

// Servers are never shown. In "chat" mode only the conversation itself is left (Discord's class names carry a random
// suffix, so they are matched by their start: "sidebar_1a2b3c" -> [class^="sidebar_"]).
const CSS = `
  nav[aria-label*="Servers" i], nav[aria-label*="Servidores" i], [class^="guilds_"], [class*=" guilds_"] { display: none !important; }
  html[data-bb-mode="chat"] [class^="sidebar_"], html[data-bb-mode="chat"] [class*=" sidebar_"],
  html[data-bb-mode="chat"] [class^="sidebarList_"], html[data-bb-mode="chat"] [class*=" sidebarList_"],
  html[data-bb-mode="chat"] [class*="membersWrap"], html[data-bb-mode="chat"] [class*="profilePanel"],
  html[data-bb-mode="chat"] [class*="userPanelOuter"], html[data-bb-mode="chat"] [class*="userProfileOuter"],
  html[data-bb-mode="chat"] [class^="titleBar_"], html[data-bb-mode="chat"] [class*=" titleBar_"],
  html[data-bb-mode="chat"] [class^="toolbar_"], html[data-bb-mode="chat"] [class*=" toolbar_"],
  html[data-bb-mode="chat"] [class^="panels_"], html[data-bb-mode="chat"] [class*=" panels_"],
  html[data-bb-mode="chat"] div[class^="bar_"], html[data-bb-mode="chat"] div[class*=" bar_"] { display: none !important; }
`;

// Runs inside the hidden Discord page: the private chats it shows, with picture and unread messages.
const LIST_SOURCE = `(() => {
  const loggedIn = !/\\/login|\\/register/.test(location.pathname) && !!document.querySelector('a[href*="/channels/@me/"]');
  const out = new Map();
  const numIn = el => { let n = 0; for (const b of el.querySelectorAll('[class*="numberBadge"],[class*="mentionsBadge"],[class*="badge_"]')) { const v = parseInt(b.textContent, 10); if (v > n) n = v; } return n; };
  const pic = el => { const i = el && el.querySelector('img[src*="avatars"],img[src*="channel-icons"],img[src*="icons/"],img[src*="embed/avatars"],img'); return i ? i.src : ''; };
  for (const a of document.querySelectorAll('a[href*="/channels/@me/"]')) {
    const m = /\\/channels\\/@me\\/(\\d+)/.exec(a.getAttribute('href') || ''); if (!m) continue;
    const id = m[1], box = a.closest('li,[role="listitem"]') || a.parentElement || a;
    const label = a.getAttribute('aria-label') || '';
    const lines = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const o = out.get(id) || { id, name: '', avatar: '', unread: 0 };
    if (!o.name) o.name = lines[0] || label.split(/[,(]/)[0].trim();
    if (!o.avatar) o.avatar = pic(box);
    const lm = /(\\d+)\\s*(menci|mention|mensaje|message)/i.exec(label);
    o.unread = Math.max(o.unread, numIn(box), lm ? +lm[1] : 0, /no le[ií]d|unread/i.test(label) ? 1 : 0);
    out.set(id, o);
  }
  // Unread private messages also show up as pictures with a number at the top of the (hidden) server column.
  for (const el of document.querySelectorAll('[data-list-item-id^="guildsnav___"]')) {
    const id = (el.getAttribute('data-list-item-id') || '').split('___')[1];
    const box = el.closest('[class*="listItem"],li,div') || el;
    if (!/^\\d+$/.test(id)) continue;
    const n = numIn(box) || numIn(el.parentElement || el);
    const o = out.get(id);
    if (o) { o.unread = Math.max(o.unread, n); if (!o.avatar) o.avatar = pic(box); }
    else if (n > 0 && /mensaje|message|dm/i.test(el.getAttribute('aria-label') || '')) {
      out.set(id, { id, name: (el.getAttribute('aria-label') || '').split(/[,(]/)[0].trim(), avatar: pic(box), unread: n });
    }
  }
  return { loggedIn, chats: [...out.values()].filter(c => c.name) };
})()`;

function isDiscordUrl(u) { try { return /(^|\.)discord\.com$/i.test(new URL(u).hostname); } catch (_) { return false; } }
function isBlocked(u) { try { const x = new URL(u); return isDiscordUrl(u) && BLOCKED_PATH.test(x.pathname); } catch (_) { return false; } }
function unreadFromTitle(title) { const m = /^\s*\((\d+)\)/.exec(String(title || '')); return m ? Number(m[1]) : 0; }

function createDiscord({ BrowserWindow, session, shell, getBounds = () => null, saveBounds = () => {}, onState = () => {}, icon }) {
  let win = null, parentGame = null, mode = 'list', poll = null, state = { loggedIn: false, chats: [] }, lastSig = '';
  const avatarCache = new Map();

  function prepareSession() {
    const ses = session.fromPartition(PARTITION);
    if (ses.__bbReady) return ses;
    ses.__bbReady = true;
    // Look like a normal Chrome (Discord shows "browser not supported" to unknown apps).
    try { ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|boombang[\w-]*)\/[\d.]+/gi, '')); } catch (_) {}
    // Only notifications are allowed; no camera, microphone, screen, location…
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'));
    try { ses.setPermissionCheckHandler((_wc, permission) => permission === 'notifications'); } catch (_) {}
    return ses;
  }

  // Pictures go to the game as small "data:" images (the game page may not load pictures from discord.com).
  async function avatarData(url) {
    if (!url || !/^https:/i.test(url)) return '';
    const small = url.replace(/([?&])size=\d+/, '$1size=64');
    if (avatarCache.has(small)) return avatarCache.get(small);
    let data = '';
    try {
      const res = await prepareSession().fetch(small);
      if (res.ok) data = `data:${res.headers.get('content-type') || 'image/png'};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    } catch (_) {}
    if (avatarCache.size > 200) avatarCache.clear();
    avatarCache.set(small, data);
    return data;
  }

  async function readChats() {
    if (!win || win.isDestroyed()) return;
    let r = null;
    try { r = await win.webContents.executeJavaScript(LIST_SOURCE, true); } catch (_) { return; }
    if (!r) return;
    const chats = [];
    for (const c of r.chats.slice(0, 60)) chats.push({ id: c.id, name: String(c.name).slice(0, 40), unread: c.unread | 0, avatar: await avatarData(c.avatar) });
    const sig = JSON.stringify([r.loggedIn, chats.map(c => [c.id, c.name, c.unread, c.avatar.length])]);
    state = { loggedIn: !!r.loggedIn, chats };
    if (sig !== lastSig) { lastSig = sig; onState(state); }
  }

  function setMode(m) {
    mode = m;
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-bb-mode', ${JSON.stringify(m)})`).catch(() => {});
  }

  function create() {
    const ses = prepareSession();
    win = new BrowserWindow({
      width: 900, height: 1000, show: false, title: 'Discord', autoHideMenuBar: true, backgroundColor: '#313338', icon,
      minWidth: 300, minHeight: 360,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: true }
    });
    win.setMenuBarVisibility(false);
    const wc = win.webContents;
    const guard = url => { if (isBlocked(url)) { setTimeout(() => { try { wc.loadURL(HOME); } catch (_) {} }, 0); return true; } return false; };
    wc.on('will-navigate', (e, url) => {
      // "discord://…" would open the installed Discord app: never. Everything stays here.
      if (!/^https?:/i.test(url)) { e.preventDefault(); return; }
      if (!isDiscordUrl(url) && !/hcaptcha|recaptcha/i.test(url)) { e.preventDefault(); shell.openExternal(url).catch(() => {}); return; }
      if (isBlocked(url)) { e.preventDefault(); guard(url); }
    });
    wc.on('did-navigate', (_e, url) => guard(url));
    wc.on('did-navigate-in-page', (_e, url) => guard(url));
    wc.on('will-frame-navigate', e => { try { if (!/^https?:|^about:/i.test(e.url)) e.preventDefault(); } catch (_) {} });
    wc.on('dom-ready', () => {
      wc.insertCSS(CSS).catch(() => {});
      setMode(mode);
      // Discord offers to open the installed app: always answer "stay in the browser".
      wc.executeJavaScript(`(function(){const stay=()=>{for(const b of document.querySelectorAll('button,a')){const t=(b.innerText||'').toLowerCase();
          if(/navegador|browser/.test(t)&&/contin|sigue|seguir|abrir|open|usar|use/.test(t)){b.click();return true;}}
          const txt=(document.body&&document.body.innerText||'').toLowerCase();
          if(/aplicaci[oó]n de discord ejecutada|discord app launched|abierto el enlace en tu aplicaci/.test(txt)){location.replace('${HOME}');return true;}return false;};
          if(!stay()){const mo=new MutationObserver(()=>{if(stay())mo.disconnect();});mo.observe(document.documentElement,{childList:true,subtree:true});setTimeout(()=>mo.disconnect(),20000);}})();`).catch(() => {});
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && !isDiscordUrl(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    win.on('page-title-updated', e => e.preventDefault());
    const remember = () => { try { if (mode === 'chat' && win.isVisible() && !win.isMinimized()) saveBounds(win.getBounds()); } catch (_) {} };
    win.on('resized', remember); win.on('moved', remember);
    // Closing only hides it: it keeps reading new messages for the bubbles.
    win.on('close', e => { if (!win.__bbQuit) { e.preventDefault(); hide(); } });
    win.on('closed', () => { win = null; clearInterval(poll); poll = null; });
    wc.loadURL(HOME);
    clearInterval(poll); poll = setInterval(readChats, 3000);
    return win;
  }
  function ensure() { if (!win || win.isDestroyed()) create(); return state; }

  function attach(game) {
    try { if (game && !game.isDestroyed() && parentGame !== game) { win.setParentWindow(game); parentGame = game; } } catch (_) {}
  }

  // One conversation, small, next to the right edge of the game.
  function openChat(id, game, name = '') {
    ensure();
    setMode('chat');
    const url = `${HOME}/${String(id).replace(/\D/g, '')}`;
    const wc = win.webContents;
    wc.executeJavaScript(`(function(){ if (!document.querySelector('a[href*="/channels/@me"]')) return false; history.pushState(null, '', ${JSON.stringify(new URL(url).pathname)}); dispatchEvent(new PopStateEvent('popstate')); return true; })()`)
      .then(ok => { if (!ok) wc.loadURL(url); }).catch(() => wc.loadURL(url));
    attach(game);
    const saved = getBounds();
    try {
      if (saved && saved.width) win.setBounds(saved);
      else if (game && !game.isDestroyed()) { const g = game.getBounds(); win.setBounds({ x: g.x + g.width - 400, y: g.y + 90, width: 370, height: Math.min(560, g.height - 140) }); }
      else win.setSize(370, 560);
    } catch (_) {}
    win.setTitle(name ? `${name} · Discord` : 'Discord');
    win.show(); win.focus();
  }
  // Sign-in (or when there's no chat yet): the normal page, still without servers.
  function openLogin(game) {
    ensure();
    setMode('list');
    attach(game);
    try { if (game && !game.isDestroyed()) { const g = game.getBounds(); win.setBounds({ x: g.x + Math.round(g.width / 2) - 450, y: g.y + 60, width: 900, height: Math.min(720, g.height - 100) }); } } catch (_) {}
    win.setTitle('Discord · inicia sesión');
    win.show(); win.focus();
  }
  function hide() {
    try { if (win && !win.isDestroyed()) { win.hide(); setMode('list'); win.setSize(900, 1000); } } catch (_) {}
    setTimeout(readChats, 500);
  }

  // The game window is closing: don't let the window close with it (child windows close with their parent).
  function detachFrom(game) {
    if (win && !win.isDestroyed() && parentGame === game) { try { win.setParentWindow(null); } catch (_) {} parentGame = null; hide(); }
  }
  async function logout() {
    const ses = prepareSession();
    try { await ses.clearStorageData(); } catch (_) {}
    try { await ses.clearCache(); } catch (_) {}
    avatarCache.clear(); state = { loggedIn: false, chats: [] }; lastSig = ''; onState(state);
    if (win && !win.isDestroyed()) win.webContents.loadURL(HOME);
    return true;
  }
  function quit() { clearInterval(poll); poll = null; if (win && !win.isDestroyed()) { win.__bbQuit = true; try { win.destroy(); } catch (_) {} } }

  return { ensure, openChat, openLogin, hide, detachFrom, logout, quit, state: () => state, readChats, isOpen: () => !!(win && !win.isDestroyed() && win.isVisible()) };
}

module.exports = { createDiscord, isBlocked, isDiscordUrl, unreadFromTitle, LIST_SOURCE, HOME, PARTITION };
