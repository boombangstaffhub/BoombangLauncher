'use strict';
// Screen Marker for Sendero Oculto: draw / stamp over the board to remember paths, then go back to the mouse at once.
// Everything is controlled from ONE floating bar inside the game. Quick switches (no need to touch the bar):
//   right click on the game  -> pencil <-> mouse
//   Space (when not typing)  -> pencil <-> mouse
//   hold Shift in mouse mode -> draw while held
// It only draws on its own transparent layer: the game never receives the drawing clicks, and in mouse mode the
// layer lets every click through to BoomBang.

const COLORS = ['#ff4d67', '#ffd34d', '#55d9ff', '#54df94', '#ffffff'];
const SIZES = { s: 3, m: 6, l: 11 };
const STAMPS = { wrong: { char: '✕', bg: '#e25555' }, safe: { char: '✓', bg: '#36c47f' }, maybe: { char: '?', bg: '#f0b43c' }, target: { char: '◎', bg: '#4a9bff' } };
const TOOLS = ['mouse', 'pen', 'wrong', 'safe', 'maybe', 'target'];
const ZONE_WIDTH = { s: 90, m: 127, l: 165 };        // "Marcar zona" uses the vine picture (assets/liana.png), sized with S/M/L

// The vine picture, read once from the app folder (also works from inside the installed app).
let zoneUrl = null;
function zoneImageUrl() {
  if (zoneUrl !== null) return zoneUrl;
  zoneUrl = '';
  try { zoneUrl = 'data:image/png;base64,' + require('fs').readFileSync(require('path').join(__dirname, 'assets', 'liana.png')).toString('base64'); } catch (_) {}
  return zoneUrl;
}

function create(api) {
  // api: { isGameFrame(), notice(msg), isTyping() }
  let host = null, bar = null, canvas = null, ctx = null, stage = null;
  let open = false, tool = 'mouse', lastDraw = 'pen', color = COLORS[0], size = 'm', shiftDraw = false;
  let items = [], current = null, ro = null, zoneImg = null;
  const inGame = () => (typeof api.isGameFrame === 'function' ? !!api.isGameFrame() : true);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('bbMarker:' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('bbMarker:' + k, JSON.stringify(v)); } catch (_) {} }
  };
  const drawing = () => open && (tool !== 'mouse' || shiftDraw);

  function findStage() { return document.querySelector('#BoomBangStage') || document.querySelector('canvas')?.parentElement || document.body; }

  function build() {
    if (host && host.isConnected) return;
    stage = findStage();
    host = document.createElement('div');
    host.id = '__bb_marker';
    host.innerHTML = `
      <canvas class="mk-canvas"></canvas>
      <div class="mk-bar" role="toolbar" aria-label="Screen Marker">
        <span class="mk-grip" title="Arrastrar">⋮⋮</span>
        <button data-tool="mouse" title="Ratón: jugar normal (clic derecho o Espacio para cambiar)">🖱</button>
        <button data-tool="pen" title="Lápiz (clic derecho o Espacio para cambiar)">✎</button>
        <i class="mk-sep"></i>
        <button data-tool="wrong" class="mk-stamp" style="--c:${STAMPS.wrong.bg}" title="Marcar camino malo">✕</button>
        <button data-tool="safe" class="mk-stamp" style="--c:${STAMPS.safe.bg}" title="Marcar camino bueno">✓</button>
        <button data-tool="maybe" class="mk-stamp" style="--c:${STAMPS.maybe.bg}" title="Marcar duda">?</button>
        <button data-tool="target" class="mk-stamp mk-zone" style="--c:${STAMPS.target.bg}" title="Marcar zona (liana)">${zoneImageUrl() ? `<img src="${zoneImageUrl()}" alt="">` : '◎'}</button>
        <i class="mk-sep"></i>
        ${COLORS.map(c => `<button class="mk-color" data-color="${c}" style="--c:${c}" title="Color"></button>`).join('')}
        <i class="mk-sep"></i>
        ${Object.keys(SIZES).map(k => `<button class="mk-size" data-size="${k}" title="Grosor"><b style="--d:${SIZES[k] + 2}px"></b></button>`).join('')}
        <i class="mk-sep"></i>
        <button data-act="undo" title="Deshacer (Ctrl+Z)">↶</button>
        <button data-act="clear" title="Borrar todo">🗑</button>
        <button data-act="close" title="Cerrar el Screen Marker">×</button>
        <span class="mk-mode"></span>
      </div>`;
    const css = document.createElement('style');
    css.id = '__bb_marker_css';
    css.textContent = `
      #__bb_marker{position:absolute;inset:0;z-index:2147483644;pointer-events:none;font-family:"Segoe UI",system-ui,sans-serif}
      #__bb_marker .mk-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
      #__bb_marker.draw .mk-canvas{pointer-events:auto;cursor:crosshair}
      #__bb_marker .mk-bar{position:absolute;left:50%;top:86px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:5px 7px;border-radius:13px;
        background:rgba(8,12,30,.9);border:1px solid rgba(190,170,255,.32);box-shadow:0 10px 28px rgba(0,0,0,.35);pointer-events:auto;user-select:none;white-space:nowrap}
      #__bb_marker .mk-grip{cursor:grab;color:#9a92c8;font-size:12px;padding:0 3px;letter-spacing:-2px}
      #__bb_marker button{width:28px;height:28px;padding:0;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#eee;
        font:800 14px "Segoe UI",system-ui;cursor:pointer;display:grid;place-items:center}
      #__bb_marker button:hover{background:rgba(150,125,255,.25)}
      #__bb_marker button.on{background:linear-gradient(135deg,#8a6bff,#5a46e6);border-color:#c9b8ff;color:#fff;box-shadow:0 0 0 2px rgba(150,125,255,.35)}
      #__bb_marker .mk-stamp{color:var(--c)}
      #__bb_marker .mk-stamp.on{background:var(--c);color:#fff;border-color:#fff}
      #__bb_marker .mk-color{width:20px;height:20px;border-radius:50%;background:var(--c);border:2px solid rgba(0,0,0,.35)}
      #__bb_marker .mk-color.on{background:var(--c);border-color:#fff;box-shadow:0 0 0 2px var(--c)}
      #__bb_marker .mk-zone img{width:24px;height:auto;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))}
      #__bb_marker .mk-zone.on{background:rgba(255,255,255,.18);border-color:#fff}
      #__bb_marker .mk-size b{display:block;width:var(--d);height:var(--d);border-radius:50%;background:#eee}
      #__bb_marker .mk-sep{width:1px;height:20px;background:rgba(255,255,255,.14);margin:0 2px}
      #__bb_marker .mk-mode{font:800 10px "Segoe UI",system-ui;color:#c9bfff;margin-left:4px;min-width:62px}
      #__bb_marker.draw .mk-mode{color:#ffd34d}`;
    (document.head || document.documentElement).appendChild(css);
    if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
    stage.appendChild(host);
    canvas = host.querySelector('.mk-canvas'); ctx = canvas.getContext('2d');
    if (zoneImageUrl()) { zoneImg = new window.Image(); zoneImg.onload = () => redraw(); zoneImg.src = zoneImageUrl(); }
    bar = host.querySelector('.mk-bar');
    const pos = store.get('pos', null);
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) placeBar(pos.x, pos.y);

    bar.addEventListener('pointerdown', e => e.stopPropagation());
    bar.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool);
      else if (b.dataset.color) { color = b.dataset.color; store.set('color', color); setTool('pen'); }   // a colour means: draw
      else if (b.dataset.size) { size = b.dataset.size; store.set('size', size); if (tool === 'mouse') setTool('pen'); else refresh(); }   // also sizes the vine
      else if (b.dataset.act === 'undo') undo();
      else if (b.dataset.act === 'clear') clear();
      else if (b.dataset.act === 'close') close();
    });
    bar.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    dragBar(host.querySelector('.mk-grip'));

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(resize); ro.observe(stage); }
    window.addEventListener('resize', resize);
    resize();
  }

  // ------------------------------------------------------------------ bar position (draggable, remembered)
  function placeBar(x, y) {
    const r = host.getBoundingClientRect();
    const w = bar.offsetWidth || 500, h = bar.offsetHeight || 40;
    const nx = Math.max(0, Math.min((r.width || 1012) - w, x)), ny = Math.max(0, Math.min((r.height || 657) - h, y));
    bar.style.left = nx + 'px'; bar.style.top = ny + 'px'; bar.style.transform = 'none';
    return { x: nx, y: ny };
  }
  function dragBar(grip) {
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      const r = host.getBoundingClientRect(), b = bar.getBoundingClientRect();
      const dx = e.clientX - b.left, dy = e.clientY - b.top;
      const mv = ev => placeBar(ev.clientX - r.left - dx, ev.clientY - r.top - dy);
      const end = ev => { window.removeEventListener('pointermove', mv, true); window.removeEventListener('pointerup', end, true); const p = placeBar(ev.clientX - r.left - dx, ev.clientY - r.top - dy); store.set('pos', p); };
      window.addEventListener('pointermove', mv, true); window.addEventListener('pointerup', end, true);
    });
    grip.addEventListener('dblclick', () => { bar.style.left = '50%'; bar.style.top = '86px'; bar.style.transform = 'translateX(-50%)'; store.set('pos', null); });
  }

  // ------------------------------------------------------------------ drawing
  function rel(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / (r.width || 1), y: (e.clientY - r.top) / (r.height || 1) }; }
  function down(e) {
    if (!drawing() || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const p = rel(e);
    const t = shiftDraw && tool === 'mouse' ? 'pen' : tool;
    if (STAMPS[t]) { items.push({ type: 'stamp', kind: t, x: p.x, y: p.y, size }); redraw(); return; }
    current = { type: 'stroke', color, w: SIZES[size] || 6, pts: [p] };
    items.push(current);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    redraw();
  }
  function move(e) {
    if (!current) return;
    e.preventDefault(); e.stopPropagation();
    const p = rel(e), last = current.pts[current.pts.length - 1];
    const r = canvas.getBoundingClientRect();
    if (Math.hypot((p.x - last.x) * r.width, (p.y - last.y) * r.height) < 1.5) return;
    current.pts.push(p); redraw();
  }
  function up(e) { if (!current) return; e.preventDefault(); e.stopPropagation(); current = null; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }

  function resize() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    redraw();
  }
  function redraw() {
    if (!ctx) return;
    const W = canvas.width, H = canvas.height, k = W / Math.max(1, canvas.getBoundingClientRect().width || W);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const it of items) {
      if (it.type === 'stroke') {
        ctx.strokeStyle = it.color; ctx.lineWidth = it.w * k;
        ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 3 * k;
        ctx.beginPath();
        it.pts.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
        if (it.pts.length === 1) ctx.lineTo(it.pts[0].x * W + 0.1, it.pts[0].y * H + 0.1);
        ctx.stroke(); ctx.shadowBlur = 0;
      } else if (it.type === 'stamp' && it.kind === 'target' && zoneImg && zoneImg.complete && zoneImg.naturalWidth) {
        const w = (ZONE_WIDTH[it.size] || ZONE_WIDTH.m) * k, h = w * zoneImg.naturalHeight / zoneImg.naturalWidth;
        ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4 * k;
        ctx.drawImage(zoneImg, it.x * W - w / 2, it.y * H - h / 2, w, h);
        ctx.shadowBlur = 0;
      } else if (it.type === 'stamp') {
        const s = STAMPS[it.kind] || STAMPS.maybe, x = it.x * W, y = it.y * H, r = 14 * k;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = it.kind === 'target' ? 'rgba(74,155,255,.28)' : s.bg; ctx.fill();
        ctx.lineWidth = 2.5 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.round(16 * k)}px "Segoe UI",system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(s.char, x, y + 1 * k);
      }
    }
  }
  function undo() { items.pop(); current = null; redraw(); }
  function clear() { items = []; current = null; redraw(); }

  // ------------------------------------------------------------------ tools / modes
  function refresh() {
    if (!host) return;
    host.classList.toggle('draw', drawing());
    const shown = shiftDraw && tool === 'mouse' ? 'pen' : tool;
    for (const b of bar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === shown);
    for (const b of bar.querySelectorAll('[data-color]')) b.classList.toggle('on', b.dataset.color === color);
    for (const b of bar.querySelectorAll('[data-size]')) b.classList.toggle('on', b.dataset.size === size);
    const label = { mouse: 'RATÓN', pen: 'LÁPIZ', wrong: 'MARCA ✕', safe: 'MARCA ✓', maybe: 'MARCA ?', target: 'LIANA' }[shown] || '';
    bar.querySelector('.mk-mode').textContent = label;
  }
  function setTool(t) {
    if (!TOOLS.includes(t)) return;
    tool = t; if (t !== 'mouse') lastDraw = t;
    current = null; refresh();
  }
  function toggleQuick() { setTool(tool === 'mouse' ? lastDraw : 'mouse'); }

  // ------------------------------------------------------------------ quick keys (only while the marker is open)
  function isTyping() {
    try { if (typeof api.isTyping === 'function') return !!api.isTyping(); } catch (_) {}
    const el = document.activeElement;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }
  function onKeyDown(e) {
    if (!open || e.repeat && e.code !== 'ShiftLeft' && e.code !== 'ShiftRight') return;
    if (e.key === 'Shift' && tool === 'mouse' && !shiftDraw && !isTyping()) { shiftDraw = true; refresh(); return; }
    if (isTyping()) return;
    if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); toggleQuick(); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); e.stopImmediatePropagation(); undo(); }
  }
  function onKeyUp(e) { if (e.key === 'Shift' && shiftDraw) { shiftDraw = false; current = null; refresh(); } }
  function onContext(e) {
    if (!open || !host) return;
    if (!stage || !stage.contains(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    toggleQuick();
  }
  function onBlur() { if (shiftDraw) { shiftDraw = false; refresh(); } }

  // ------------------------------------------------------------------ open / close
  function openMarker() {
    if (!inGame()) return false;
    build();
    open = true;
    color = store.get('color', COLORS[0]); if (!COLORS.includes(color)) color = COLORS[0];
    size = store.get('size', 'm'); if (!SIZES[size]) size = 'm';
    host.style.display = '';
    setTool('pen');
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('contextmenu', onContext, true);
    window.addEventListener('blur', onBlur);
    resize();
    if (api.notice) api.notice('✎ Screen Marker · clic derecho o Espacio: lápiz ⇄ ratón');
    return true;
  }
  function close() {
    open = false; shiftDraw = false; current = null;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('contextmenu', onContext, true);
    window.removeEventListener('blur', onBlur);
    if (host) { host.classList.remove('draw'); host.style.display = 'none'; }
  }
  function handleCommand(cmd) {
    if (!cmd || !inGame()) return;
    const a = String(cmd.action || '');
    if (a === 'marker-open') openMarker();
    else if (a === 'marker-close') close();
    else if (a === 'marker-toggle') (open ? close() : openMarker());
    else if (a === 'marker-clear') clear();
  }

  return { open: openMarker, close, toggle: () => (open ? close() : openMarker()), handleCommand, setTool, undo, clear,
    state: () => ({ open, tool, lastDraw, color, size, shiftDraw, items: items.length }) };
}

module.exports = { create, COLORS, SIZES, STAMPS };
