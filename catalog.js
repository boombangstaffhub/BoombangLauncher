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
// It doesn't rely on class names or on the pictures (they load late, only when on screen): an item card is the
// smallest box whose text is "<name>" followed by its price line ("Lo pone su dueño" or a number).
const EXTRACT_SOURCE = `(() => {
  const clean = s => String(s || '').replace(/[\\u200b-\\u200d\\ufeff]/g, '').trim();
  const lines = el => clean(el.innerText).split(/\\n+/).map(clean).filter(Boolean);
  const body = clean(document.body.innerText).replace(/\\s+/g, ' ');
  const pm = /P[áa]gina\\s+(\\d+)\\s+de\\s+(\\d+)/i.exec(body);
  const cm = /(\\d[\\d.]*)\\s+objetos?\\s+en\\s+(Único|Unico|Casi único|Casi unico|LTD|Muy rare|Rare|Medallas)/i.exec(body);
  const PRICE = /^((\\d+\\s*)?lo pone su due[ñn]o|\\d[\\d.,]*(\\s*(sacos?( de oro)?|diamantes?|oro))?)$/i;
  const picOf = el => {
    for (const i of el.querySelectorAll('img')) {
      const src = i.currentSrc || i.getAttribute('src') || i.getAttribute('data-src') || i.getAttribute('data-lazy') || i.getAttribute('data-original') || (i.getAttribute('srcset') || '').split(/[ ,]/)[0] || '';
      if (/catalog|objetos|medal/i.test(src)) return new URL(src, location.href).href;
    }
    for (const n of [el, ...el.querySelectorAll('*')]) {
      const m = /url\\(["']?([^"')]+)/.exec(n.style && n.style.backgroundImage || '');
      if (m && /catalog|objetos|medal/i.test(m[1])) return new URL(m[1], location.href).href;
    }
    return '';
  };
  const cands = [];
  for (const el of document.querySelectorAll('div,li,a,article,button,section')) {
    if (el.querySelector('input,textarea')) continue;
    const ls = lines(el);
    if (ls.length < 2 || ls.length > 4) continue;
    // "<name>" then the price block at the end (1 or 2 lines: "1000", or "0" + "Lo pone su dueño").
    let k = ls.length;
    while (k > 1 && ls.length - k < 2 && PRICE.test(ls[k - 1])) k--;
    if (k === ls.length || ls.slice(0, k).some(l => PRICE.test(l))) continue;   // one price block: one card, not a row of cards
    const last = ls.slice(k).join(' ');
    const name = ls.slice(0, k).join(' ').replace(/\\s+/g, ' ');
    if (!name || name.length > 70 || PRICE.test(name) || /^p[áa]gina/i.test(name)) continue;
    cands.push({ el, name, last });
  }
  // Keep the outermost box of each card that is still ONE card (holds no other candidate with another name).
  const items = [], used = new Set();
  for (const c of cands) {
    if (cands.some(o => o !== c && o.el.contains(c.el) && o.name === c.name && !cands.some(z => z !== o && z.name !== o.name && o.el.contains(z.el)))) continue;
    if (used.has(c.el)) continue; used.add(c.el);
    const owner = /pone su due/i.test(c.last);
    const num = /(\\d[\\d.,]*)/.exec(c.last);
    const price = owner || !num ? 0 : Number(num[1].replace(/[.,](?=\\d{3}(\\D|$))/g, '').replace(',', '.')) || 0;
    const alts = [...c.el.querySelectorAll('img')].map(i => (i.getAttribute('alt') || '') + ' ' + (i.getAttribute('src') || '')).join(' ');
    items.push({ name: c.name, img: picOf(c.el), price, owner: !price, currency: /diamant/i.test(alts + ' ' + c.last) ? 'diamantes' : 'sacos de oro' });
  }
  const sig = items.map(i => i.name).join('|');
  return { items, sig, page: pm ? +pm[1] : 1, pages: pm ? +pm[2] : 1, count: cm ? +cm[1].replace(/\\./g, '') : null, category: cm ? cm[2] : '' };
})()`;

// Runs inside the page: scroll through it so pictures that load "when on screen" load too.
const SCROLL_SOURCE = `(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); } window.scrollTo(0, 0); return true; })()`;

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
  function save(c) { cache = c; c._indexed = false; try { fs.writeFileSync(cacheFile, JSON.stringify(c)); } catch (_) {} }

  async function crawl() {
    const win = new BrowserWindow({
      show: false, width: 1400, height: 5000,          // tall: the whole page is "on screen", every card is drawn
      webPreferences: { session: session.fromPartition('persist:bb-catalogo'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: false }
    });
    try { win.webContents.setAudioMuted(true); } catch (_) {}
    const exec = async src => { try { return await win.webContents.executeJavaScript(src, true); } catch (_) { return null; } };
    const loaded = async url => { try { await win.loadURL(url); } catch (_) {} };
    // Wait until the page shows `ok(r)` and the list stopped changing.
    const settle = async (ok, tries = 60) => {
      let prev = null;
      for (let i = 0; i < tries; i++) {
        await wait(250);
        const r = await exec(EXTRACT_SOURCE);
        if (r && r.items.length && ok(r)) { if (prev && prev.sig === r.sig) return r; prev = r; } else prev = null;
      }
      return prev;
    };
    const all = new Map(), report = [];
    let expected = 0;
    try {
      for (const cat of CATEGORIES) {
        progress = `Leyendo ${cat.label}…`;
        await loaded(`${CATALOG_URL}&rareza=${cat.rareza}`);
        let r = await settle(() => true, 40);
        if (!r || catKey(r.category) !== catKey(cat.label)) {             // the link didn't switch: click the tab
          await exec(CLICK_CATEGORY_SOURCE(cat.label));
          r = await settle(x => catKey(x.category) === catKey(cat.label));
        }
        if (debugFile && cat === CATEGORIES[0]) { try { fs.writeFileSync(debugFile, String(await exec('document.documentElement.outerHTML') || '')); } catch (_) {} }
        let got = 0, guard = 0;
        const seenPages = new Set();
        while (r && guard++ < MAX_PAGES) {
          await exec(SCROLL_SOURCE);
          const again = await exec(EXTRACT_SOURCE);
          if (again && again.sig === r.sig) r = again;                       // same list, now with pictures
          for (const it of r.items) {
            const key = `${cat.rareza}|${it.name}`;
            const old = all.get(key);
            if (!old) { all.set(key, { ...it, category: cat.label }); got++; }
            else if (!old.img && it.img) old.img = it.img;
          }
          seenPages.add(r.page);
          progress = `Leyendo ${cat.label} · página ${r.page} de ${r.pages}`;
          if (r.page >= r.pages) break;
          const before = r;
          if (!(await exec(NEXT_SOURCE))) break;
          r = await settle(x => x.sig !== before.sig && (x.page !== before.page || x.pages === 1) && catKey(x.category || cat.label) === catKey(cat.label));
        }
        expected += r && r.count != null ? r.count : 0;
        report.push(`${cat.label}: ${got} leídos de ${r && r.count != null ? r.count : '?'} (páginas ${seenPages.size}${r ? ' de ' + r.pages : ''})`);
      }
    } finally {
      try { win.destroy(); } catch (_) {}
      progress = '';
    }
    log(report.join('\n'));
    return { items: [...all.values()], expected };
  }

  function refresh() {
    if (building) return building;
    building = crawl().then(({ items, expected }) => {
      // The new reading REPLACES the old copy completely (nothing piles up). A reading that came out clearly worse
      // than the copy we have (the web failed halfway) is thrown away instead.
      const old = load();
      if (items.length && (!old || !old.items.length || items.length >= old.items.length * 0.9)) save({ at: Date.now(), expected, items });
      log(`Total: ${items.length} objetos${expected ? ` de ${expected}` : ''}`);
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
    return { ok: true, results: search(now.items, query), total: now.items.length, expected: now.expected || 0, at: now.at };
  }

  // Called a little after the launcher starts: reads the catalogue in the background if the copy is missing or old,
  // so ":objeto" answers at once.
  function warmUp() { const c = load(); if (!c || !c.items.length || Date.now() - (c.at || 0) > MAX_AGE) refresh(); }

  return { find, refresh, warmUp, status: () => ({ building: !!building, progress, at: (load() || {}).at || 0, total: ((load() || {}).items || []).length }) };
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

module.exports = { CATALOG_URL, CATEGORIES, EXTRACT_SOURCE, SCROLL_SOURCE, NEXT_SOURCE, CLICK_CATEGORY_SOURCE, norm, search, createCatalog, parseCommand, COMMAND_RE };
