'use strict';
// ":objeto donut" in the game chat -> a small window with the picture and price of that rare (catalog.js does the
// reading). The command is caught BEFORE the game sees it: it is never sent to the chat.

const { parseCommand } = require('./catalog');

function create({ ipcRenderer, notice = () => {}, isGameFrame = () => true }) {
  let host = null, shadow = null, lastField = null, swallowUntil = 0, searchSeq = 0;

  const isField = el => el && el.nodeType === 1 && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.type || '')) || el.isContentEditable);
  const valueOf = el => (el.isContentEditable ? el.innerText : el.value) || '';
  function clearField(el) {
    try {
      if (el.isContentEditable) { el.textContent = ''; }
      else {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        if (setter) setter.call(el, ''); else el.value = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {}
  }
  function consume(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }

  function tryCommand(field) {
    if (!field) return false;
    const cmd = parseCommand(valueOf(field));
    if (!cmd) return false;
    clearField(field);
    swallowUntil = Date.now() + 400;
    run(cmd);
    return true;
  }

  // ---------------------------------------------------------------- catching the command
  function onKeyDown(e) {
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    if (Date.now() < swallowUntil) { consume(e); return; }
    const field = isField(e.target) ? e.target : (isField(document.activeElement) ? document.activeElement : null);
    if (tryCommand(field)) consume(e);
  }
  function onKeyOther(e) { if ((e.key === 'Enter' || e.keyCode === 13) && Date.now() < swallowUntil) consume(e); }
  function onSubmit(e) {
    const field = [...(e.target.querySelectorAll ? e.target.querySelectorAll('input,textarea,[contenteditable="true"]') : [])].find(f => parseCommand(valueOf(f)));
    if (tryCommand(field)) consume(e);
  }
  // Clicking the game's "send" button instead of pressing Enter.
  function onPointer(e) {
    const f = lastField;
    if (!f || !f.isConnected || e.target === f || (host && e.composedPath().includes(host))) return;
    if (!parseCommand(valueOf(f))) return;
    // Only buttons right next to the chat box (its "send" button), not clicks anywhere in the room.
    const fr = f.getBoundingClientRect(), x = e.clientX, y = e.clientY;
    if (!(y > fr.top - 40 && y < fr.bottom + 40 && x > fr.left - 20 && x < fr.right + 160)) return;
    if (e.type === 'click' ? tryCommand(f) : true) consume(e);
  }

  // ---------------------------------------------------------------- the window
  const CSS = `
    :host{all:initial}
    .wrap{position:fixed;right:18px;top:70px;z-index:2147483647;width:340px;max-height:70vh;display:flex;flex-direction:column;border-radius:16px;background:rgba(14,10,30,.96);border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 50px rgba(0,0,0,.5);color:#fff;font:500 12px system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
    .head{display:flex;align-items:center;gap:8px;padding:11px 12px 9px 14px;border-bottom:1px solid rgba(255,255,255,.08);cursor:move;user-select:none}
    .title{flex:1;font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .x{all:unset;cursor:pointer;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-size:16px;color:#cfc8e8;background:rgba(255,255,255,.06)}
    .x:hover{background:rgba(255,90,120,.35);color:#fff}
    .body{overflow:auto;padding:8px}
    .msg{white-space:pre-line;padding:14px 8px;color:#cfc8e8;text-align:center;line-height:1.5}
    .item{display:flex;align-items:center;gap:12px;padding:8px;border-radius:12px}
    .item+.item{margin-top:4px}
    .item:nth-child(odd){background:rgba(255,255,255,.035)}
    .pic{width:64px;height:64px;flex:none;display:grid;place-items:center;border-radius:10px;background:rgba(255,255,255,.06)}
    .pic img{max-width:60px;max-height:60px;image-rendering:auto}
    .info{min-width:0;flex:1}
    .name{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cat{display:inline-block;margin-top:3px;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:800;background:rgba(255,255,255,.1);color:#e9e4ff}
    .cat.u{background:#ff5a7a33;color:#ff9db0}.cat.cu{background:#ff9d3c33;color:#ffc58a}.cat.ltd{background:#38d6ff33;color:#9be9ff}
    .cat.mr{background:#b06bff33;color:#d7b3ff}.cat.r{background:#4ff0a033;color:#a6f7cf}.cat.m{background:#ffd25a33;color:#ffe49a}
    .price{margin-top:4px;font-size:14px;font-weight:900;color:#ffd25a}
    .price small{font-size:11px;font-weight:600;color:#cfc8e8}
    .owner{margin-top:4px;color:#cfc8e8}
    .foot{padding:7px 12px;border-top:1px solid rgba(255,255,255,.08);color:#9a93b8;font-size:10.5px}
  `;
  const CAT_CLASS = { 'Único': 'u', 'Casi único': 'cu', 'LTD': 'ltd', 'Muy rare': 'mr', 'Rare': 'r', 'Medallas': 'm' };

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function ensureWindow() {
    if (host && host.isConnected) return shadow;
    host = document.createElement('div'); host.id = '__bb_objwin';
    shadow = host.attachShadow({ mode: 'open' });
    const style = el('style'); style.textContent = CSS; shadow.appendChild(style);
    const wrap = el('div', 'wrap');
    const head = el('div', 'head'); const title = el('div', 'title', 'Precio de objetos'); const x = el('button', 'x', '✕'); x.title = 'Cerrar';
    x.addEventListener('click', close);
    head.append(title, x);
    wrap.append(head, el('div', 'body'), el('div', 'foot', 'Precios aproximados del catálogo de la web. 0 = lo pone su dueño.'));
    shadow.appendChild(wrap);
    // Drag by the header.
    let drag = null;
    head.addEventListener('pointerdown', e => { if (e.target === x) return; const r = wrap.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove', e => { if (!drag) return; wrap.style.left = `${Math.max(0, e.clientX - drag.dx)}px`; wrap.style.top = `${Math.max(0, e.clientY - drag.dy)}px`; wrap.style.right = 'auto'; });
    head.addEventListener('pointerup', () => { drag = null; });
    // Keys typed in the window never reach the game.
    for (const t of ['keydown', 'keyup', 'keypress']) wrap.addEventListener(t, e => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }
  function close() { searchSeq++; try { host && host.remove(); } catch (_) {} host = null; shadow = null; }
  function setTitle(t) { const s = ensureWindow(); s.querySelector('.title').textContent = t; }
  function setMessage(t) { const b = ensureWindow().querySelector('.body'); b.textContent = ''; b.appendChild(el('div', 'msg', t)); }

  function showResults(query, res) {
    const s = ensureWindow(); const b = s.querySelector('.body'); b.textContent = '';
    setTitle(`«${query}»`);
    if (!res.ok) { setMessage(res.message || 'No se pudo buscar.'); return; }
    if (!res.results.length) { setMessage(`No encuentro «${query}» en el catálogo (${res.total}${res.expected > res.total ? ` de ${res.expected}` : ''} objetos leídos). Prueba con otra parte del nombre.`); return; }
    for (const it of res.results) {
      const row = el('div', 'item');
      const pic = el('div', 'pic'); const img = el('img'); img.alt = ''; img.src = it.img; img.referrerPolicy = 'no-referrer'; pic.appendChild(img);
      const info = el('div', 'info');
      info.appendChild(el('div', 'name', it.name)); info.lastChild.title = it.name;
      info.appendChild(el('span', `cat ${CAT_CLASS[it.category] || ''}`, it.category));
      if (it.price > 0) {
        const p = el('div', 'price', it.price.toLocaleString('es-ES') + ' ');
        p.appendChild(el('small', '', it.currency || 'sacos de oro'));
        info.appendChild(p);
      } else info.appendChild(el('div', 'owner', '0 · lo pone su dueño'));
      row.append(pic, info); b.appendChild(row);
    }
    const age = res.at ? Math.round((Date.now() - res.at) / 3600000) : 0;
    s.querySelector('.foot').textContent = `${res.results.length === 12 ? 'Primeros 12 resultados · ' : ''}Catálogo de la web (${res.total}${res.expected > res.total ? ` de ${res.expected}` : ''} objetos${age ? `, leído hace ${age} h` : ''}). 0 = lo pone su dueño.`;
  }

  async function run(cmd) {
    const seq = ++searchSeq;
    if (!cmd.refresh && !cmd.query) { setTitle('Precio de objetos'); setMessage('Escribe el nombre detrás del comando, por ejemplo  :objeto donut'); return; }
    setTitle(cmd.refresh ? 'Actualizando catálogo' : `Buscando «${cmd.query}»…`);
    setMessage(cmd.refresh ? 'Leyendo el catálogo de la web…' : 'Buscando…');
    // While the catalogue is being read for the first time (can take a little), show how it goes.
    const poll = setInterval(async () => {
      if (seq !== searchSeq) { clearInterval(poll); return; }
      try { const st = await ipcRenderer.invoke('catalog:status'); if (st && st.building && st.progress) setMessage(`${st.progress}\nLa primera vez tarda un poco; después es instantáneo.`); } catch (_) {}
    }, 600);
    let res;
    try { res = await ipcRenderer.invoke('catalog:find', cmd.query, { force: cmd.refresh }); } catch (_) { res = { ok: false, message: 'No se pudo buscar.' }; }
    clearInterval(poll);
    if (seq !== searchSeq) return;
    if (cmd.refresh) { setTitle('Catálogo actualizado'); setMessage(res.ok ? `Listo: ${res.total}${res.expected ? ` de ${res.expected}` : ''} objetos.\nLa copia anterior se ha sustituido por esta.` : res.message); return; }
    showResults(cmd.query, res);
  }

  function start() {
    if (!isGameFrame()) return;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keypress', onKeyOther, true);
    window.addEventListener('keyup', onKeyOther, true);
    window.addEventListener('submit', onSubmit, true);
    window.addEventListener('focusin', e => { if (isField(e.target) && !(host && e.composedPath().includes(host))) lastField = e.target; }, true);
    for (const t of ['pointerdown', 'mousedown', 'click']) window.addEventListener(t, onPointer, true);
  }

  return { start, run, close };
}

module.exports = { create };
