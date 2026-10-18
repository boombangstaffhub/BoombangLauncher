'use strict';
// Rare price lookup (":objeto donut" in the game chat).
//
// The launcher reads the public catalogue of the website (Comunidad -> Catálogo) once, in a hidden window, keeps a
// copy in %APPDATA%\BoomBangLauncher\catalogo-cache.json and searches that copy. It only READS the public page,
// the same way you would by scrolling through it. The copy is refreshed in the background once a day.

const CATALOG_URL = 'https://www.boombang.tv/es/community?ver=catalogo';
const CATEGORIES = [
  { rareza: 1, label: 'Único' },
  { rareza: 2, label: 'Casi único' },
  { rareza: 3, label: 'LTD' },
  { rareza: 4, label: 'Muy rare' },
  { rareza: 5, label: 'Rare' },
  { rareza: 0, label: 'Medallas' }
];
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_PAGES = 150;                       // per category, safety stop

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();
}
function catKey(label) { return norm(label).replace(/\s+/g, ''); }

// Runs INSIDE the catalogue page. Reads the items shown on the current page, the page counter and the category.
// It doesn't rely on class names (unknown, and they can change): an item is "a picture from /catalog/ + its title".
const EXTRACT_SOURCE = `(() => {
  const txt = el => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const body = txt(document.body);
  const pm = /P[áa]gina\\s+(\\d+)\\s+de\\s+(\\d+)/i.exec(body);
  const cm = /(\\d[\\d.]*)\\s+objetos?\\s+en\\s+([^\\d\\n]{2,30}?)(?=\\s{1,}|$)/i.exec(body);
  const imgs = [...document.querySelectorAll('img')].filter(i => /\\/catalog\\//i.test(i.getAttribute('src') || i.src || ''));
  const items = [];
  for (const img of imgs) {
    // The item card: the biggest parent that still holds only this one catalogue picture.
    let card = img, p = img.parentElement;
    while (p && p !== document.body) {
      const n = [...p.querySelectorAll('img')].filter(i => /\\/catalog\\//i.test(i.getAttribute('src') || i.src || '')).length;
      if (n > 1) break;
      card = p; p = p.parentElement;
    }
    const h = card.querySelector('h1,h2,h3,h4,h5,h6,strong,b,[class*="name" i],[class*="title" i],[class*="nombre" i]');
    let name = txt(h);
    if (!name || name.length > 60) name = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
    if (!name) continue;
    const rest = txt(card).replace(name, ' ');
    const owner = /pone su due[ñn]o/i.test(rest);
    const num = /(\\d[\\d.,]*)/.exec(rest);
    const price = num ? Number(num[1].replace(/[.,](?=\\d{3}(\\D|$))/g, '').replace(',', '.')) : 0;
    const cur = [...card.querySelectorAll('img')].map(i => (i.getAttribute('alt') || '') + ' ' + (i.getAttribute('src') || '')).join(' ');
    const currency = /diamant/i.test(cur + ' ' + rest) ? 'diamantes' : 'sacos de oro';
    items.push({ name, img: img.src || img.getAttribute('src'), price: Number.isFinite(price) ? price : 0, owner: owner || !price, currency });
  }
  return { items, page: pm ? +pm[1] : 1, pages: pm ? +pm[2] : 1, count: cm ? +cm[1].replace(/\\./g, '') : null, category: cm ? cm[2].trim() : '' };
})()`;

// Runs inside the page: go to the next page (a link is followed, a button is clicked). false = there is none.
const NEXT_SOURCE = `(() => {
  const cands = [...document.querySelectorAll('a,button,span,div,li,i')].filter(e => {
    const t = (e.innerText || e.textContent || '').trim();
    const l = (e.getAttribute('aria-label') || e.getAttribute('title') || '').toLowerCase();
    return (t === '›' || t === '»' || t === '>' || /siguiente|next/.test(l)) && e.children.length <= 1;
  });
  const el = cands[cands.length - 1];
  if (!el) return false;
  const a = el.closest('a[href]');
  if (a && !/^(#|javascript:)/i.test(a.getAttribute('href'))) { location.href = a.href; return 'nav'; }
  el.click(); return 'click';
})()`;

// Runs inside the page: open a category by clicking its tab (used when the ?rareza= link didn't change it).
const CLICK_CATEGORY_SOURCE = label => `(() => {
  const want = ${JSON.stringify(catKey(label))};
  const k = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  const el = [...document.querySelectorAll('a,button,li,span,div')].find(e => e.children.length <= 2 && k(e.innerText || e.textContent) === want);
  if (!el) return false;
  (el.closest('a,button') || el).click(); return true;
})()`;

// ---------------------------------------------------------------- search
function scoreItem(item, q, words) {
  const n = item._n || norm(item.name);
  const file = norm(String(item.img || '').split('/').pop().replace(/catalog\.png.*$/i, ''));
  if (n === q) return 100;
  if (n.startsWith(q)) return 85;
  if (new RegExp(`(^| )${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) return 75;
  if (n.includes(q)) return 60;
  if (words.length > 1 && words.every(w => n.includes(w))) return 55;
  if (file && (file === q.replace(/ /g, '') || file.startsWith(q.replace(/ /g, '')))) return 50;
  if (file && file.includes(q.replace(/ /g, ''))) return 40;
  return 0;
}
function search(items, query, limit = 12) {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ').filter(Boolean);
  return (items || [])
    .map(it => ({ it, s: scoreItem(it, q, words) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.it.name.length - b.it.name.length)
    .slice(0, limit)
    .map(x => { const { _n, ...rest } = x.it; return rest; });
}

// ---------------------------------------------------------------- reading the website (Electron main process)
function createCatalog({ BrowserWindow, session, cacheFile, fs, log = () => {}, debugFile = null }) {
  let cache = null, building = null, progress = '';
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function load() {
    if (cache) return cache;
    try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c && Array.isArray(c.items)) cache = c; } catch (_) {}
    return cache;
  }
  function save(c) { cache = c; try { fs.writeFileSync(cacheFile, JSON.stringify(c)); } catch (_) {} }

  async function crawl() {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { session: session.fromPartition('persist:bb-catalogo'), contextIsolation: true, sandbox: true, backgroundThrottling: false, images: false }
    });
    win.webContents.setAudioMuted(true);
    const exec = async src => { try { return await win.webContents.executeJavaScript(src, true); } catch (_) { return null; } };
    const loaded = async url => { try { await win.loadURL(url); } catch (_) {} };
    const all = new Map();
    try {
      for (const cat of CATEGORIES) {
        progress = `Leyendo ${cat.label}…`;
        await loaded(`${CATALOG_URL}&rareza=${cat.rareza}`);
        let r = await exec(EXTRACT_SOURCE);
        if (r && r.category && catKey(r.category) !== catKey(cat.label)) {      // the link didn't switch: click the tab
          await exec(CLICK_CATEGORY_SOURCE(cat.label));
          for (let i = 0; i < 30; i++) { await wait(250); r = await exec(EXTRACT_SOURCE); if (r && catKey(r.category) === catKey(cat.label)) break; }
        }
        let guard = 0;
        while (r && guard++ < MAX_PAGES) {
          for (const it of r.items) {
            const key = `${cat.rareza}|${it.name}|${it.img}`;
            if (!all.has(key)) all.set(key, { ...it, category: cat.label });
          }
          progress = `Leyendo ${cat.label} · página ${r.page} de ${r.pages}`;
          if (r.page >= r.pages) break;
          const before = r.page, firstBefore = r.items[0] && r.items[0].name;
          const how = await exec(NEXT_SOURCE);
          if (!how) break;
          let next = null;
          for (let i = 0; i < 60; i++) {                      // up to 15 s for the next page
            await wait(250);
            next = await exec(EXTRACT_SOURCE);
            if (next && next.items.length && (next.page !== before || (next.items[0] && next.items[0].name) !== firstBefore)) break;
            next = null;
          }
          r = next;
        }
      }
      if (!all.size && debugFile) {
        try { fs.writeFileSync(debugFile, String(await exec('document.documentElement.outerHTML') || '')); } catch (_) {}
      }
    } finally {
      try { win.destroy(); } catch (_) {}
      progress = '';
    }
    return [...all.values()];
  }

  function refresh() {
    if (building) return building;
    building = crawl().then(items => {
      if (items.length) save({ at: Date.now(), items });
      log(`catálogo: ${items.length} objetos`);
      return items.length;
    }).catch(e => { log(`catálogo: error ${e && e.message}`); return 0; }).finally(() => { building = null; });
    return building;
  }

  async function find(query, { force = false } = {}) {
    const c = load();
    if (force || !c || !c.items.length) await refresh();
    else if (Date.now() - (c.at || 0) > MAX_AGE) refresh();          // old copy: answer now, refresh behind
    const now = load();
    if (!now || !now.items.length) return { ok: false, message: 'No he podido leer el catálogo de la web. Comprueba tu conexión y vuelve a probar.' };
    if (!now._indexed) { for (const it of now.items) it._n = norm(it.name); now._indexed = true; }
    return { ok: true, results: search(now.items, query), total: now.items.length, at: now.at };
  }

  return { find, refresh, status: () => ({ building: !!building, progress, at: (load() || {}).at || 0, total: ((load() || {}).items || []).length }) };
}

// Chat command: ":objeto donut", ":object donut", ":objet donut", ":obj donut", ":rare donut".
const COMMAND_RE = /^\s*:(?:obj|objet|objeto|object|objecto|rare|precio)(?:\s+(.*))?$/i;
function parseCommand(text) {
  const m = COMMAND_RE.exec(String(text || ''));
  if (!m) return null;
  const arg = String(m[1] || '').trim();
  if (/^(actualizar|refrescar|update)$/i.test(arg)) return { refresh: true, query: '' };
  return { refresh: false, query: arg };
}

module.exports = { CATALOG_URL, CATEGORIES, EXTRACT_SOURCE, NEXT_SOURCE, CLICK_CATEGORY_SOURCE, norm, search, createCatalog, parseCommand, COMMAND_RE };
