'use strict';
// "Progreso" (BB Hub): reads the numbers at the top of the game (diamonds, gold, silver) every few seconds so the Hub
// can show how much you won or spent this session, and a summary of past sessions. Read only: it never touches the
// game. The numbers come from the game's picture (PixiJS text, via pixi-hook.js) or, if the game shows them as page
// text, from the page.

const LABELS = ['Diamantes', 'Oro', 'Plata'];

function parseNum(t) {
  const s = String(t || '').replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const n = Number(s.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}
// The first numbers of the top bar, left to right (several pieces on the same row are one number only if they touch).
function pickValues(items) {
  const rows = (items || []).map(i => ({ ...i, n: parseNum(i.text) })).filter(i => i.n !== null);
  if (!rows.length) return null;
  const top = Math.min(...rows.map(r => r.y));
  const row = rows.filter(r => r.y - top < Math.max(30, (rows[0].h || 20) * 1.5)).sort((a, b) => a.x - b.x);
  return row.slice(0, 3).map(r => r.n);
}

function create({ ipcRenderer, getProfileId, injectMainWorld, isGameFrame = () => true, worldLoaded = () => true }) {
  let started = false, injected = false, last = '', candidate = '', domMode = false;

  function domItems() {
    // Text numbers at the top of the game area, in case the game shows them as page elements.
    const stage = document.querySelector('#BoomBangStage') || document.body;
    const sr = stage.getBoundingClientRect(), out = [];
    for (const el of stage.querySelectorAll('div,span,p,b,strong')) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!/^\d[\d.,]*$/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.top > sr.top + sr.height * .14) continue;
      out.push({ text: t, x: r.left, y: r.top, h: r.height });
    }
    return out;
  }

  function report(values) {
    if (!values || values.length < 2) return;
    const sig = values.join('|');
    if (sig !== candidate) { candidate = sig; return; }          // same reading twice in a row: not a counter mid-animation
    if (sig === last) return;
    last = sig;
    try { ipcRenderer.send('progress:sample', getProfileId(), values); } catch (_) {}
  }

  function onHud(e) {
    let m; try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || m.type !== 'hud') return;
    const v = pickValues(m.items);
    if (v && v.length >= 2) { domMode = false; report(v); }
    else { const d = pickValues(domItems()); if (d && d.length >= 2) { domMode = true; report(d); } }
  }

  function tick() {
    if (!worldLoaded()) return;
    if (domMode) { const d = pickValues(domItems()); if (d) report(d); return; }
    if (!injected) { injected = true; try { injectMainWorld(require('./pixi-hook').SOURCE); } catch (_) {} }
    try { document.dispatchEvent(new CustomEvent('__bb_pixi_in', { detail: JSON.stringify({ type: 'hud' }) })); } catch (_) {}
  }

  function start() {
    if (started || !isGameFrame()) return;
    started = true;
    document.addEventListener('__bb_pixi_out', onHud);
    setInterval(tick, 4000);
  }
  return { start };
}

// ---------------------------------------------------------------- launcher side (main process)
// Sessions per account: the first reading is where you started, the last one where you are now. When the game
// closes, the session is kept in a short history (last 20) in progreso.json.
function createTracker({ fs, file }) {
  const live = new Map();     // profile -> { startedAt, start, current, updatedAt }
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; } };
  const write = all => { try { fs.writeFileSync(file, JSON.stringify(all)); } catch (_) {} };

  function sample(profileId, values) {
    const id = String(profileId || ''); if (!id || !Array.isArray(values)) return;
    const v = values.slice(0, 3).map(n => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : null));
    const s = live.get(id);
    if (!s) live.set(id, { startedAt: Date.now(), start: v, current: v, updatedAt: Date.now() });
    else { s.current = v; s.updatedAt = Date.now(); if (s.start.length < v.length) s.start = v.map((n, i) => (s.start[i] ?? n)); }
  }
  function end(profileId) {
    const id = String(profileId || ''), s = live.get(id);
    live.delete(id);
    if (!s) return;
    const seconds = Math.round((s.updatedAt - s.startedAt) / 1000);
    if (seconds < 60) return;                                  // a quick open-and-close isn't a session
    const all = read(), list = Array.isArray(all[id]) ? all[id] : [];
    list.unshift({ at: s.startedAt, seconds, start: s.start, end: s.current });
    all[id] = list.slice(0, 20);
    write(all);
  }
  function get(profileId) {
    const id = String(profileId || ''), s = live.get(id), all = read();
    return { labels: LABELS, session: s ? { ...s, seconds: Math.round((Date.now() - s.startedAt) / 1000) } : null, history: Array.isArray(all[id]) ? all[id] : [] };
  }
  function clear(profileId) { const all = read(); delete all[String(profileId || '')]; write(all); return get(profileId); }
  return { sample, end, get, clear };
}

module.exports = { create, createTracker, pickValues, parseNum, LABELS };
