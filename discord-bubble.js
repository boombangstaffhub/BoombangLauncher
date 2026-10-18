'use strict';
// The Discord bubble inside the game: a round button you can drag anywhere; a click opens/closes the Discord window
// (private messages, see discord.js). A red badge shows the unread messages.

function create({ ipcRenderer, getProfileId, getSettings, saveSettings, isGameFrame = () => true }) {
  let host = null, btn = null, badge = null, count = 0, started = false;

  const CSS = `
    :host{all:initial}
    .b{position:fixed;z-index:2147483645;width:48px;height:48px;border-radius:50%;display:grid;place-items:center;cursor:pointer;
       background:radial-gradient(circle at 30% 25%,#7d86ff,#5865f2 60%,#3b44c4);box-shadow:0 6px 18px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.35);
       border:2px solid rgba(255,255,255,.85);user-select:none;touch-action:none;transition:transform .12s}
    .b:hover{transform:scale(1.07)}
    .b.drag{transition:none;transform:scale(1.1);cursor:grabbing}
    svg{width:24px;height:24px;pointer-events:none}
    .n{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#f23f43;
       color:#fff;font:800 11px/18px system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;border:2px solid #fff;display:none}
    .n.on{display:block}
  `;
  // A plain chat-bubble icon.
  const ICON = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 6.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/></svg>';

  function place() {
    const s = getSettings() || {};
    const x = Number.isFinite(s.discordBubbleX) ? s.discordBubbleX : 0.965;    // stored as a share of the window size
    const y = Number.isFinite(s.discordBubbleY) ? s.discordBubbleY : 0.62;
    const W = window.innerWidth, H = window.innerHeight;
    btn.style.left = `${Math.round(Math.min(W - 52, Math.max(4, x * W - 24)))}px`;
    btn.style.top = `${Math.round(Math.min(H - 52, Math.max(4, y * H - 24)))}px`;
  }
  function build() {
    if (host && host.isConnected) return;
    host = document.createElement('div'); host.id = '__bb_discord_bubble';
    const sh = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style'); st.textContent = CSS; sh.appendChild(st);
    btn = document.createElement('div'); btn.className = 'b'; btn.title = 'Discord · mensajes directos (arrastra para moverla)'; btn.innerHTML = ICON;
    badge = document.createElement('div'); badge.className = 'n'; btn.appendChild(badge);
    sh.appendChild(btn);
    let down = null, moved = false;
    btn.addEventListener('pointerdown', e => { if (e.button !== 0) return; down = { x: e.clientX, y: e.clientY }; moved = false; btn.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener('pointermove', e => {
      if (!down) return;
      if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) return;
      moved = true; btn.classList.add('drag');
      btn.style.left = `${Math.min(window.innerWidth - 52, Math.max(4, e.clientX - 24))}px`;
      btn.style.top = `${Math.min(window.innerHeight - 52, Math.max(4, e.clientY - 24))}px`;
    });
    btn.addEventListener('pointerup', e => {
      if (!down) return; down = null; btn.classList.remove('drag'); e.stopPropagation();
      if (moved) { const r = btn.getBoundingClientRect(); saveSettings({ discordBubbleX: (r.left + 24) / window.innerWidth, discordBubbleY: (r.top + 24) / window.innerHeight }); return; }
      ipcRenderer.invoke('discord:toggle', getProfileId()).catch(() => {});
    });
    for (const t of ['click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) btn.addEventListener(t, e => { e.stopPropagation(); e.preventDefault(); });
    (document.body || document.documentElement).appendChild(host);
    place(); setCount(count);
  }
  function remove() { try { host && host.remove(); } catch (_) {} host = null; }
  function setCount(n) {
    count = Math.max(0, n | 0);
    if (!badge) return;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('on', count > 0);
  }
  function apply() {
    if (!isGameFrame()) return;
    if ((getSettings() || {}).discordBubble) { build(); place(); } else remove();
  }
  function start() {
    if (started || !isGameFrame()) return;
    started = true;
    apply();
    window.addEventListener('resize', () => { if (host) place(); }, { passive: true });
    ipcRenderer.invoke('discord:unread').then(setCount).catch(() => {});
  }
  function handleCommand(cmd) {
    if (!cmd) return;
    if (cmd.type === 'discord-unread') setCount(cmd.count);
    if (cmd.type === 'settings') apply();
  }
  return { start, apply, handleCommand };
}

module.exports = { create };
