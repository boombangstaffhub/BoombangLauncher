'use strict';
// Discord chat bubbles inside the game ("chat heads"). When someone writes to you privately, a round bubble with
// THEIR profile picture appears, with a red number of unread messages. Clicking it opens only that conversation
// (discord.js). Hover a bubble and press × (or right-click it) to put it away. The small top bubble lists all your
// private chats and is where you sign in the first time. Drag any bubble to move the whole column.

function create({ ipcRenderer, getProfileId, getSettings, saveSettings, isGameFrame = () => true }) {
  let host = null, sh = null, stack = null, menu = null, started = false;
  let state = { loggedIn: false, chats: [] };
  let heads = [];                         // ids of the chats that have a bubble (saved per account)
  const lastUnread = new Map();

  const CSS = `
    :host{all:initial}
    .stack{position:fixed;z-index:2147483645;display:flex;flex-direction:column;align-items:center;gap:10px;user-select:none;touch-action:none;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
    .h{position:relative;width:52px;height:52px;border-radius:50%;cursor:pointer;background:#5865f2 center/cover no-repeat;
       box-shadow:0 6px 18px rgba(0,0,0,.45);border:2px solid #fff;transition:transform .12s;display:grid;place-items:center;color:#fff;font-weight:900;font-size:20px}
    .h:hover{transform:scale(1.07)}
    .h.new{animation:pop .45s ease-out}
    @keyframes pop{0%{transform:scale(.3)}70%{transform:scale(1.12)}100%{transform:scale(1)}}
    .h.m{width:40px;height:40px;background:radial-gradient(circle at 30% 25%,#7d86ff,#5865f2 60%,#3b44c4);border-width:2px}
    .h.m svg{width:20px;height:20px}
    .n{position:absolute;top:-4px;right:-5px;min-width:19px;height:19px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:#f23f43;color:#fff;
       font:800 11px/15px system-ui,sans-serif;text-align:center;border:2px solid #fff;display:none}
    .n.on{display:block}
    .x{position:absolute;top:-6px;left:-6px;width:18px;height:18px;border-radius:50%;background:#1e1f22;color:#fff;border:1.5px solid #fff;font:700 11px/14px sans-serif;
       text-align:center;display:none;cursor:pointer}
    .h:hover .x{display:block}
    .tip{position:absolute;right:62px;top:50%;transform:translateY(-50%);white-space:nowrap;background:rgba(17,18,20,.92);color:#fff;font:600 12px system-ui,sans-serif;
       padding:5px 9px;border-radius:7px;pointer-events:none;opacity:0;transition:opacity .12s}
    .h:hover .tip{opacity:1}
    .stack.drag .h{transition:none;cursor:grabbing}
    .menu{position:fixed;z-index:2147483646;width:260px;max-height:360px;overflow:auto;background:#2b2d31;color:#f2f3f5;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.55);
       border:1px solid rgba(255,255,255,.08);font:500 13px system-ui,-apple-system,Segoe UI,sans-serif;padding:8px}
    .menu .t{font-weight:800;font-size:12px;color:#b5bac1;padding:4px 6px 8px;text-transform:uppercase;letter-spacing:.04em}
    .row{display:flex;align-items:center;gap:9px;padding:6px;border-radius:8px;cursor:pointer}
    .row:hover{background:rgba(255,255,255,.07)}
    .row i{width:30px;height:30px;border-radius:50%;background:#5865f2 center/cover;flex:none}
    .row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .row b{background:#f23f43;border-radius:9px;padding:0 6px;font-size:11px}
    .btn{display:block;width:100%;margin-top:6px;padding:9px;border:0;border-radius:8px;background:#5865f2;color:#fff;font:700 13px system-ui,sans-serif;cursor:pointer}
    .btn.g{background:rgba(255,255,255,.08)}
    .p{color:#b5bac1;padding:4px 6px 6px;line-height:1.4}
  `;
  const ICON = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 6.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/></svg>';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const chatById = id => state.chats.find(c => c.id === id);

  function place() {
    if (!stack) return;
    const s = getSettings() || {};
    const x = Number.isFinite(s.discordBubbleX) ? s.discordBubbleX : 0.965;
    const y = Number.isFinite(s.discordBubbleY) ? s.discordBubbleY : 0.25;
    const W = window.innerWidth, H = window.innerHeight;
    stack.style.left = `${Math.round(Math.min(W - 60, Math.max(4, x * W - 26)))}px`;
    stack.style.top = `${Math.round(Math.min(H - 60, Math.max(4, y * H)))}px`;
  }

  // Dragging moves the column; a short press is a click.
  function draggable(node, onClick) {
    let down = null, moved = false, start = null;
    node.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.classList.contains('x')) return;
      const r = stack.getBoundingClientRect();
      down = { x: e.clientX, y: e.clientY }; start = { l: r.left, t: r.top }; moved = false;
      try { node.setPointerCapture(e.pointerId); } catch (_) {}
      e.stopPropagation(); e.preventDefault();
    });
    node.addEventListener('pointermove', e => {
      if (!down) return;
      if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) return;
      moved = true; stack.classList.add('drag'); closeMenu();
      stack.style.left = `${Math.min(window.innerWidth - 60, Math.max(4, start.l + e.clientX - down.x))}px`;
      stack.style.top = `${Math.min(window.innerHeight - 60, Math.max(4, start.t + e.clientY - down.y))}px`;
    });
    node.addEventListener('pointerup', e => {
      if (!down) return; down = null; stack.classList.remove('drag'); e.stopPropagation();
      if (moved) { const r = stack.getBoundingClientRect(); saveSettings({ discordBubbleX: (r.left + 26) / window.innerWidth, discordBubbleY: r.top / window.innerHeight }); return; }
      onClick(e);
    });
    for (const t of ['click', 'mousedown', 'mouseup', 'dblclick']) node.addEventListener(t, e => { e.stopPropagation(); if (!e.target.classList.contains('x')) e.preventDefault(); });
  }

  function saveHeads() { saveSettings({ discordHeads: heads.slice(0, 8) }); }
  function addHead(id, animate) {
    if (heads.includes(id)) return;
    heads.unshift(id); if (heads.length > 8) heads.length = 8;
    saveHeads(); render(animate ? id : null);
  }
  function removeHead(id) { heads = heads.filter(h => h !== id); saveHeads(); render(); }
  function openChat(id) { const c = chatById(id); addHead(id); ipcRenderer.invoke('discord:open-chat', getProfileId(), id, c ? c.name : '').catch(() => {}); }

  function closeMenu() { try { menu && menu.remove(); } catch (_) {} menu = null; }
  function toggleMenu() {
    if (menu) { closeMenu(); return; }
    menu = el('div', 'menu');
    if (!state.loggedIn) {
      menu.append(el('div', 't', 'Discord'), el('div', 'p', 'Inicia sesión una vez (con el correo o el código QR de la app del móvil). Después, cuando alguien te escriba por privado, saldrá aquí su burbuja.'));
      const b = el('button', 'btn', 'Iniciar sesión en Discord'); b.onclick = () => { closeMenu(); ipcRenderer.invoke('discord:login', getProfileId()).catch(() => {}); };
      menu.appendChild(b);
    } else {
      menu.appendChild(el('div', 't', 'Mensajes directos'));
      if (!state.chats.length) menu.appendChild(el('div', 'p', 'Cargando tus chats…'));
      for (const c of state.chats.slice(0, 40)) {
        const r = el('div', 'row'); const i = el('i'); if (c.avatar) i.style.backgroundImage = `url("${c.avatar}")`;
        r.append(i, el('span', '', c.name)); if (c.unread) r.appendChild(el('b', '', String(c.unread)));
        r.onclick = () => { closeMenu(); openChat(c.id); };
        menu.appendChild(r);
      }
      if (heads.length) { const b = el('button', 'btn g', 'Quitar todas las burbujas'); b.onclick = () => { heads = []; saveHeads(); closeMenu(); render(); }; menu.appendChild(b); }
    }
    for (const t of ['pointerdown', 'mousedown', 'click', 'wheel', 'keydown']) menu.addEventListener(t, e => e.stopPropagation());
    sh.appendChild(menu);
    const r = stack.getBoundingClientRect();
    const left = r.left > 280 ? r.left - 270 : r.right + 10;
    menu.style.left = `${Math.max(4, left)}px`; menu.style.top = `${Math.max(4, Math.min(window.innerHeight - 370, r.top))}px`;
  }

  function render(popId = null) {
    if (!stack) return;
    stack.textContent = '';
    const total = state.chats.reduce((n, c) => n + (c.unread || 0), 0);
    const m = el('div', 'h m'); m.innerHTML = ICON;
    const mn = el('div', 'n'); const hiddenUnread = state.chats.filter(c => !heads.includes(c.id)).reduce((n, c) => n + (c.unread || 0), 0);
    if (hiddenUnread) { mn.textContent = hiddenUnread > 99 ? '99+' : String(hiddenUnread); mn.classList.add('on'); }
    m.appendChild(mn); m.appendChild(el('div', 'tip', state.loggedIn ? `Discord · mensajes directos${total ? ` (${total} sin leer)` : ''}` : 'Discord · inicia sesión'));
    draggable(m, () => toggleMenu());
    stack.appendChild(m);
    for (const id of heads) {
      const c = chatById(id); if (!c && state.loggedIn && state.chats.length) continue;
      const h = el('div', 'h' + (popId === id ? ' new' : ''));
      if (c && c.avatar) h.style.backgroundImage = `url("${c.avatar}")`; else h.textContent = ((c && c.name) || '?').slice(0, 1).toUpperCase();
      const n = el('div', 'n'); if (c && c.unread) { n.textContent = c.unread > 99 ? '99+' : String(c.unread); n.classList.add('on'); }
      const x = el('div', 'x', '×'); x.title = 'Quitar burbuja';
      x.addEventListener('click', e => { e.stopPropagation(); removeHead(id); });
      x.addEventListener('pointerdown', e => e.stopPropagation());
      h.append(n, x, el('div', 'tip', (c && c.name) || 'Chat'));
      h.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); removeHead(id); });
      draggable(h, () => openChat(id));
      stack.appendChild(h);
    }
  }

  function build() {
    if (host && host.isConnected) return;
    host = document.createElement('div'); host.id = '__bb_discord_bubble';
    sh = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style'); st.textContent = CSS; sh.appendChild(st);
    stack = el('div', 'stack'); sh.appendChild(stack);
    (document.body || document.documentElement).appendChild(host);
    place(); render();
  }
  function remove() { closeMenu(); try { host && host.remove(); } catch (_) {} host = null; sh = null; stack = null; }

  // New state from the launcher: someone who wrote to you gets a bubble with their picture.
  function setState(next) {
    if (!next) return;
    state = { loggedIn: !!next.loggedIn, chats: Array.isArray(next.chats) ? next.chats : [] };
    let pop = null;
    for (const c of state.chats) {
      const before = lastUnread.has(c.id) ? lastUnread.get(c.id) : 0;
      if ((c.unread || 0) > before && !heads.includes(c.id)) { heads.unshift(c.id); pop = c.id; }
      lastUnread.set(c.id, c.unread || 0);
    }
    if (heads.length > 8) heads.length = 8;
    if (pop) saveHeads();
    render(pop);
  }

  function apply() {
    if (!isGameFrame()) return;
    const s = getSettings() || {};
    if (Array.isArray(s.discordHeads) && !heads.length) heads = s.discordHeads.map(String).slice(0, 8);
    if (s.discordBubble) { build(); place(); ipcRenderer.invoke('discord:state').then(setState).catch(() => {}); } else remove();
  }
  function start() {
    if (started || !isGameFrame()) return;
    started = true;
    apply();
    window.addEventListener('resize', () => place(), { passive: true });
    window.addEventListener('pointerdown', e => { if (menu && host && !e.composedPath().includes(host)) closeMenu(); }, true);
  }
  function handleCommand(cmd) {
    if (!cmd) return;
    if (cmd.type === 'discord-state') { if (host) setState(cmd.state); }
    if (cmd.type === 'settings') apply();
  }
  return { start, apply, handleCommand, setState };
}

module.exports = { create };
