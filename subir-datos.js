// Subir datos: dos perfiles del launcher en segundo plano.
//   EMISOR   → baldosa BLANCA, envía Beso / Cóctel / Flor
//   RECEPTOR → baldosa ROJA, acepta con el tick verde
// El juego se dibuja "fuera de pantalla" (offscreen): no hay ninguna ventana y no depende
// del monitor, así que sigue funcionando con las pantallas apagadas. Los clics son reales.
// Si sale un CAPTCHA no se salta: se abre una ventana normal con esa cuenta para que lo
// resuelva la persona y, en cuanto entra al juego, vuelve a segundo plano.
const { BrowserWindow, shell, powerSaveBlocker } = require('electron');

const GAME_URL = 'https://static.boombang.tv/betahtml5/index.html?lang=es';
const MIN_ESPERA = 3100;        // por debajo el juego cuelga los envíos

const GIFTS = {
  'Beso':   { img: /\/ficha\/beso\.png/i,     recv: 'receivedKisses' },
  'Cóctel': { img: /\/ficha\/cocktail\.png/i, recv: 'receivedCocktails' },
  'Flor':   { img: /\/ficha\/rosa\.png/i,     recv: 'receivedRoses' }
};

const DEFAULTS = {
  emisorId: '', receptorId: '',
  isla: '', zona: '',
  dato: 'Beso',
  esperas: { 'Beso': 3100, 'Cóctel': 8800, 'Flor': 4900 },   // lo que aguanta el juego sin colgarse (medido)  // ms entre un dato aceptado y el siguiente envío, por dato
  clicE: 70, clicR: 70,       // ms entre clics
  atascoE: 5,                 // s en "Enviado a" → Cancelar y reenviar
  atascoR: 120,               // s con el cartel sin aceptar → X
  baldosasAuto: true,
  baldosaE: { x: 14, y: 11 }, // blanca (si no es automático)
  baldosaR: { x: 13, y: 10 }  // roja
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clampNum = (v, d, min = 0, max = 1e9) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

function normalize(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  c.dato = GIFTS[c.dato] ? c.dato : 'Beso';
  c.isla = String(c.isla || '').trim().slice(0, 40);
  c.zona = String(c.zona || '').trim().slice(0, 40);
  // Cada dato tiene su propia espera (el cóctel y la flor pueden necesitar más que el beso).
  // Compatibilidad: una «espera» suelta de versiones anteriores era la del beso.
  const src = cfg && cfg.esperas && typeof cfg.esperas === 'object' ? cfg.esperas : (cfg && cfg.espera != null ? { 'Beso': cfg.espera } : {});
  c.esperas = {};
  for (const g of Object.keys(GIFTS)) c.esperas[g] = Math.round(clampNum(src[g], DEFAULTS.esperas[g], MIN_ESPERA, 60000));
  delete c.espera;
  c.clicE = clampNum(c.clicE, 70, 10, 2000);
  c.clicR = clampNum(c.clicR, 70, 10, 2000);
  c.atascoE = clampNum(c.atascoE, 5, 2, 600);
  c.atascoR = clampNum(c.atascoR, 120, 5, 3600);
  c.baldosasAuto = c.baldosasAuto !== false;
  const tile = (t, d) => ({ x: Math.round(clampNum(t && t.x, d.x, 0, 200)), y: Math.round(clampNum(t && t.y, d.y, 0, 200)) });
  c.baldosaE = tile(c.baldosaE, DEFAULTS.baldosaE);
  c.baldosaR = tile(c.baldosaR, DEFAULTS.baldosaR);
  return c;
}

// Código que se ejecuta DENTRO del juego para leer su estado.
const PAGE_HELPERS = `
  const __vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05; };
  const __center = el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const __byText = (t, root = document) => [...root.querySelectorAll('button,[role="button"],a,div,span,li,p')]
    .filter(el => __vis(el) && String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase() === String(t).toLowerCase())
    .sort((a, b) => { const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect(); return ar.width * ar.height - br.width * br.height; })[0] || null;
  const __byImg = re => [...document.querySelectorAll('img')].find(i => __vis(i) && re.test(i.src)) || null;
`;

// ------------------------------------------------------------ imagen → píxeles
function bitmapInfo(img) {
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const buf = img.toBitmap();
  const s = Math.sqrt(buf.length / 4 / (size.width * size.height)) || 1;
  return { buf, s, W: Math.round(size.width * s), H: Math.round(size.height * s) };
}
function pixel(info, x, y) {
  const px = Math.round(x * info.s), py = Math.round(y * info.s);
  if (px < 0 || py < 0 || px >= info.W || py >= info.H) return null;
  const i = (py * info.W + px) * 4;                      // BGRA
  return [info.buf[i + 2], info.buf[i + 1], info.buf[i]];
}
const isRed = p => p && p[0] >= 190 && p[1] <= 70 && p[2] <= 70;
const isWhite = p => p && p[0] >= 232 && p[1] >= 232 && p[2] >= 232;

// ------------------------------------------------------------------ Bot
class Bot {
  constructor(mgr, role, profile, creds, tile) {
    Object.assign(this, { mgr, role, profile, creds, tile });
    this.user = String(creds.username || profile.name || '');
    this.win = null;
    this.inZone = false;
    this.lastLogin = 0;
    this.loginTries = 0;
    this.stateSince = Date.now();
    this.state = 'INICIO';
    this.backoff = 30000;
  }
  log(kind, msg) { this.mgr.log(kind, msg, this.role); }
  setState(s) {
    if (s !== this.state) { this.state = s; this.stateSince = Date.now(); this.mgr.pushStatus(); }
  }
  alive() { return this.win && !this.win.isDestroyed(); }
  get stopped() { return this.mgr.stopped; }

  // mode: 'offscreen' (normal, sin ventana) · 'visible' (solo para resolver un CAPTCHA)
  open(mode = 'offscreen') {
    this.mode = mode;
    const visible = mode === 'visible';
    this.win = new BrowserWindow({
      width: 1280, height: 800, useContentSize: true,
      show: visible, skipTaskbar: !visible, focusable: visible,
      title: `BoomBang — resuelve el CAPTCHA de ${this.profile.name}`,
      backgroundColor: '#000000', autoHideMenuBar: true,
      webPreferences: {
        partition: `persist:boombang-profile-${this.profile.id}`,
        offscreen: !visible,
        contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false
      }
    });
    const wc = this.win.webContents;
    wc.setAudioMuted(true);
    if (!visible) {
      try { wc.setFrameRate(12); } catch (_) {}   // para leer la ficha y el cartel basta; gasta mucho menos
      try { wc.startPainting(); } catch (_) {}
      wc.on('paint', (_e, _dirty, image) => { this.frame = image; this.frameAt = Date.now(); });
    }
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    this.win.on('close', e => {
      if (this.stopped || this.swapping) return;
      if (visible) { e.preventDefault(); this.log('warn', 'Resuelve el CAPTCHA en esa ventana; se cerrará sola cuando entre al juego.'); }
    });
    wc.on('render-process-gone', (_e, d) => {
      if (this.stopped) return;
      this.log('fail', `El juego se ha cerrado (${d?.reason || '?'}). Recargo...`);
      this.inZone = false;
      setTimeout(() => this.reload('se cerró el juego'), 2000);
    });
    if (!visible) this.log('info', `Conectando con ${this.profile.name}...`);
    wc.loadURL(GAME_URL).catch(() => {});
  }

  // Cambia entre segundo plano y ventana visible (la sesión se conserva: misma partición).
  reopen(mode) {
    this.swapping = true;
    this.destroy();
    this.swapping = false;
    this.inZone = false;
    this.frame = null;
    this.open(mode);
  }

  destroy() { try { if (this.alive()) this.win.destroy(); } catch (_) {} this.win = null; }

  async reload(reason) {
    if (!this.alive() || this.stopped) return;
    this.inZone = false;
    this.loginTries = 0;
    this.setState('RECARGANDO');
    this.log('info', `Recargando el juego${reason ? ` (${reason})` : ''}...`);
    try { await this.win.webContents.loadURL(GAME_URL); } catch (_) {}
  }

  async js(code) {
    if (!this.alive()) return null;
    try { return await this.win.webContents.executeJavaScript(`(() => { ${PAGE_HELPERS} ${code} })()`, true); }
    catch (_) { return null; }
  }

  // ---- clics "de verdad" (el juego ignora los clics simulados por código)
  async click(pt) {
    if (!pt || !this.alive()) return false;
    const wc = this.win.webContents, x = Math.round(pt.x), y = Math.round(pt.y);
    try {
      wc.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(60);
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await sleep(70);
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return true;
    } catch (_) { return false; }
  }
  async fastClick(pt) {
    if (!pt || !this.alive()) return false;
    const wc = this.win.webContents, x = Math.round(pt.x), y = Math.round(pt.y);
    try {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await sleep(12);
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return true;
    } catch (_) { return false; }
  }
  key(code) {
    const wc = this.win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: code });
    wc.sendInputEvent({ type: 'char', keyCode: code === 'Enter' ? '\r' : code });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code });
  }
  async typeInto(pt, text) {
    await this.click(pt); await sleep(150);
    await this.js(`const a = document.activeElement; if (a && 'value' in a) { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(a), 'value'); d && d.set ? d.set.call(a, '') : (a.value = ''); a.dispatchEvent(new Event('input', { bubbles: true })); } return true;`);
    try { await this.win.webContents.insertText(String(text)); } catch (_) {}
    await sleep(120);
  }
  async clickText(t) { const pt = await this.js(`const el = __byText(${JSON.stringify(t)}); return el ? __center(el) : null;`); return pt ? this.click(pt) : false; }
  async clickImg(re) { const pt = await this.js(`const el = __byImg(${re.toString()}); return el ? __center(el) : null;`); return pt ? this.click(pt) : false; }
  async hasText(t) { return Boolean(await this.js(`return !!__byText(${JSON.stringify(t)});`)); }
  async hasImg(re) { return Boolean(await this.js(`return !!__byImg(${re.toString()});`)); }

  // ---- estado del juego (sala, Kekos, posiciones, contadores)
  async read() {
    return this.js(`
      const out = {};
      out.login = [...document.querySelectorAll('input[type="password"]')].some(__vis);
      out.captcha = [...document.querySelectorAll('iframe')].some(f => /challenges\\.cloudflare\\.com|turnstile|recaptcha|hcaptcha/i.test(f.src || '') && __vis(f)) ||
        /verifique que es un ser humano|no pudimos verificar que no eres un bot/i.test(document.body?.innerText || '');
      let r = null; try { r = window.BoomBang && BoomBang.smr(); } catch (_) {}
      out.game = !!r;
      out.avatars = [];
      if (r && r.avatars) for (const a of r.avatars.values()) {
        const i = a.avatarInfo || {};
        out.avatars.push({ name: String(i.username || ''), x: a.position?.x, y: a.position?.y, sx: a.screenPos?.x, sy: a.screenPos?.y,
          stats: { receivedKisses: i.receivedKisses, receivedCocktails: i.receivedCocktails, receivedRoses: i.receivedRoses } });
      }
      const cv = document.getElementById('BoomBangCanvas') || document.querySelector('canvas');
      if (cv) { const cr = cv.getBoundingClientRect(); const lw = parseFloat(cv.style.width) || cr.width; out.cv = { x: cr.x, y: cr.y, w: cr.width, h: cr.height, k: cr.width / lw }; }
      const chat = [...document.querySelectorAll('input, textarea')].some(e => __vis(e) && /chatear/i.test(e.placeholder || ''));
      out.inRoom = !!(r && r.avatars && r.avatars.size > 0 && (r.spaceModel || chat));
      return out;
    `);
  }
  me(st) {
    const u = this.user.toLowerCase(), n = String(this.profile.name || '').toLowerCase();
    return st?.avatars?.find(a => a.name.toLowerCase() === u) || st?.avatars?.find(a => a.name.toLowerCase() === n) || null;
  }
  find(st, name) { return st?.avatars?.find(a => a.name.toLowerCase() === String(name).toLowerCase()) || null; }

  // Rejilla isométrica de BoomBang: +40 px en X por (x+y) y +20 px en Y por (y-x), tomando mi Keko como referencia.
  tileToGame(st, t) {
    const m = this.me(st); if (!m) return null;
    return { x: m.sx + ((t.x + t.y) - (m.x + m.y)) * 40, y: m.sy + ((t.y - t.x) - (m.y - m.x)) * 20 };
  }
  gameToWin(st, p) { return p && st.cv ? { x: st.cv.x + p.x * st.cv.k, y: st.cv.y + p.y * st.cv.k } : null; }
  tilePoint(st, t) { return this.gameToWin(st, this.tileToGame(st, t)); }
  avatarPoint(st, av) { return this.gameToWin(st, { x: av.sx, y: av.sy }); }   // la sombra de los pies

  // Busca en pantalla la baldosa ROJA y, pegada a ella, la BLANCA.
  async detectTiles() {
    const st = await this.read();
    const m = this.me(st);
    if (!m || !st.cv) return null;
    let img = null;
    if (this.mode !== 'visible') {
      try { this.win.webContents.invalidate(); } catch (_) {}
      const t0 = Date.now();
      while ((!this.frame || this.frameAt < t0) && Date.now() - t0 < 1500) await sleep(50);
      img = this.frame;
    }
    if (!img) { try { img = await this.win.webContents.capturePage(); } catch (_) {} }
    const info = bitmapInfo(img);
    if (!info) return null;
    // Puntos dentro del rombo de la baldosa, lejos del centro (donde podría haber un Keko).
    const PTS = [[-26, 0], [26, 0], [-13, -7], [13, -7], [-13, 7], [13, 7], [0, -11], [0, 11]];
    const score = (t, test) => {
      const g = this.tileToGame(st, t); if (!g) return 0;
      let n = 0;
      for (const [dx, dy] of PTS) if (test(pixel(info, st.cv.x + (g.x + dx) * st.cv.k, st.cv.y + (g.y + dy) * st.cv.k))) n++;
      return n;
    };
    let red = null, best = 0;
    for (let x = 0; x <= 60; x++) for (let y = 0; y <= 60; y++) {
      const g = this.tileToGame(st, { x, y });
      const w = this.gameToWin(st, g);
      if (!w || w.x < st.cv.x || w.y < st.cv.y || w.x > st.cv.x + st.cv.w || w.y > st.cv.y + st.cv.h) continue;
      const s = score({ x, y }, isRed);
      if (s > best) { best = s; red = { x, y }; }
    }
    if (!red || best < 6) return null;
    let white = null, bw = 0;
    for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const t = { x: red.x + dx, y: red.y + dy };
      const s = score(t, isWhite);
      if (s > bw) { bw = s; white = t; }
    }
    if (!white || bw < 6) return null;
    return { red, white };
  }

  async login() {
    this.lastLogin = Date.now();
    this.loginTries++;
    const f = await this.js(`
      const pass = [...document.querySelectorAll('input[type="password"]')].find(__vis);
      const user = [...document.querySelectorAll('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])')].find(__vis);
      const btn = __byText('Jugar');
      return pass && user && btn ? { user: __center(user), pass: __center(pass), btn: __center(btn) } : null;
    `);
    if (!f) return;
    this.log('info', `Iniciando sesión (intento ${this.loginTries})...`);
    await this.typeInto(f.user, this.creds.username);
    await this.typeInto(f.pass, this.creds.password);
    await sleep(300);
    await this.click(f.btn);
  }

  // Un paso de navegación según lo que se vea: sala → brújula → isla → área,
  // o menú → Islas → Favoritas → isla → área.
  async navStep(st) {
    const { isla, zona } = this.mgr.cfg;
    const passBox = await this.js(`const i = [...document.querySelectorAll('input')].find(e => __vis(e) && /contrase/i.test(e.placeholder || '') && e.type !== 'password'); return i ? __center(i) : null;`);
    if (passBox) {
      const zp = this.mgr.zonaPass;
      if (!zp) { this.log('fail', `El área «${zona}» pide contraseña. Ponla en Subir datos o dale permisos a esta cuenta en la isla.`); return 'nopass'; }
      this.log('info', `Escribiendo la contraseña de «${zona}»...`);
      await this.typeInto(passBox, zp);
      this.key('Enter');
      return 'zone';
    }
    if (await this.hasText(isla) && await this.hasText(zona) && await this.js(`return !!__byText('Localizaciones');`)) {
      this.log('info', `Isla ${isla} → entrando en ${zona}...`);
      await this.clickText(zona);
      return 'zone';
    }
    // Pestaña Islas: SIEMPRE filtro Favoritas (en «Todos» puede salir otra isla o no salir).
    if (await this.hasText('Favoritas')) {
      if (!this.favActive) { this.log('info', 'Islas → Favoritas...'); await this.clickText('Favoritas'); this.favActive = true; this.favWaits = 0; return 'step'; }
      if (await this.hasText(isla)) { this.log('info', `Favoritas → ${isla}...`); await this.clickText(isla); this.favActive = false; return 'step'; }
      if (++this.favWaits >= 4) { this.log('warn', `No veo «${isla}» en Favoritas. Añádela a favoritas en la cuenta ${this.profile.name}.`); this.favActive = false; }
      return 'wait';
    }
    if (await this.hasText('Islas')) { this.favActive = false; await this.clickText('Islas'); return 'step'; }
    if (st.inRoom || st.game) { await this.clickImg(/brujula\./i); return 'step'; }
    return 'wait';
  }

  async walkToTile() {
    for (let i = 0; i < 4 && !this.stopped; i++) {
      const st = await this.read(); const m = this.me(st);
      if (!m) return false;
      if (m.x === this.tile.x && m.y === this.tile.y) return true;
      const pt = this.tilePoint(st, this.tile); if (!pt) return false;
      await this.click(pt);
      for (let t = 0; t < 30 && !this.stopped; t++) {
        await sleep(200);
        const m2 = this.me(await this.read());
        if (m2 && m2.x === this.tile.x && m2.y === this.tile.y) {
          this.log('ok', `En la baldosa ${this.role === 'emisor' ? 'blanca' : 'roja'} (${this.tile.x},${this.tile.y}).`);
          return true;
        }
      }
    }
    return false;
  }

  // Deja la cuenta conectada, dentro del área y en su baldosa.
  async ensureReady() {
    let navFails = 0;
    while (!this.stopped) {
      if (!this.alive()) { await sleep(1000); continue; }
      const st = await this.read();
      if (!st) {
        this.setState('SIN JUEGO');
        if (Date.now() - this.stateSince > 45000) { await this.reload('no responde'); await sleep(this.backoff); this.backoff = Math.min(this.backoff * 2, 180000); }
        await sleep(1000); continue;
      }
      if (st.captcha) {
        this.setState('CAPTCHA');
        if (this.mode !== 'visible') {
          this.log('warn', 'Ha salido un CAPTCHA: te abro una ventana con esta cuenta para que lo resuelvas e inicies sesión. Luego vuelve sola a segundo plano.');
          this.reopen('visible');
          await sleep(3000);
        }
        await sleep(2000); continue;
      }
      if (this.mode === 'visible' && st.game && !st.login) {
        this.log('ok', 'Dentro del juego: cierro la ventana y sigo en segundo plano.');
        this.reopen('offscreen');
        await sleep(3000); continue;
      }
      if (st.login) {
        this.setState('INICIANDO SESIÓN'); this.inZone = false;
        const wait = this.loginTries >= 5 ? 60000 : 20000;
        if (Date.now() - this.lastLogin > wait) await this.login();
        await sleep(1500); continue;
      }
      if (!st.game) {
        this.setState('CARGANDO');
        if (Date.now() - this.stateSince > 90000) await this.reload('lleva mucho cargando');
        await sleep(1000); continue;
      }
      this.loginTries = 0; this.backoff = 30000;

      if (this.inZone && st.inRoom && this.me(st)) {
        const tilesOk = await this.mgr.ensureTiles(this);
        if (!tilesOk && this.role === 'receptor') { this.setState('ESPERANDO'); await sleep(2000); continue; }   // se queda en el área hasta que el emisor las encuentre
        if (tilesOk) {
          const m = this.me(await this.read());
          if (m && m.x === this.tile.x && m.y === this.tile.y) { this.setState('LISTO'); return true; }
          this.setState('CAMINANDO');
          if (await this.walkToTile()) { this.setState('LISTO'); return true; }
          this.log('warn', 'No consigo llegar a la baldosa; vuelvo a entrar en el área.');
        }
        this.inZone = false;
      }

      this.setState('NAVEGANDO');
      const r = await this.navStep(st);
      if (r === 'zone') {
        const end = Date.now() + 20000; let loaded = false;
        await sleep(1500);
        while (Date.now() < end && !this.stopped) {
          const s2 = await this.read();
          if (s2?.inRoom && this.me(s2)) { loaded = true; break; }
          if (await this.js(`return [...document.querySelectorAll('input')].some(e => __vis(e) && /contrase/i.test(e.placeholder || '') && e.type !== 'password');`)) break;
          await sleep(500);
        }
        if (loaded) { this.inZone = true; navFails = 0; this.log('ok', `Dentro de ${this.mgr.cfg.isla} → ${this.mgr.cfg.zona}.`); await sleep(1200); continue; }
      }
      if (r === 'nopass') { await sleep(30000); continue; }
      if (++navFails > 25) { navFails = 0; await this.reload('me he perdido navegando'); }
      await sleep(1600);
    }
    return false;
  }
}

// --------------------------------------------------------------- gestor
function createSubirDatos({ notify, save }) {
  const mgr = {
    cfg: normalize({}),
    zonaPass: '',
    stopped: true,
    running: false,
    E: null, R: null,
    stats: { count: 0, cancels: 0, started: 0 },
    tilesFound: false,
    logLines: [],

    log(kind, msg, tag) {
      const line = { t: Date.now(), kind, tag: tag || '', msg: String(msg) };
      this.logLines.push(line);
      if (this.logLines.length > 300) this.logLines.shift();
      notify('subir:log', line);
    },
    status() {
      const mins = this.stats.started ? (Date.now() - this.stats.started) / 60000 : 0;
      return {
        running: this.running,
        emisor: this.E ? { name: this.E.profile.name, state: this.E.state } : null,
        receptor: this.R ? { name: this.R.profile.name, state: this.R.state } : null,
        count: this.stats.count,
        cancels: this.stats.cancels,
        perMin: mins > 0.05 ? +(this.stats.count / mins).toFixed(1) : 0,
        startedAt: this.stats.started,
        baldosas: this.E ? { blanca: this.E.tile, roja: this.R && this.R.tile } : null,
        cfg: this.cfg
      };
    },
    pushStatus() { notify('subir:status', this.status()); },

    // Las baldosas se buscan una vez por entrada en el área (con el emisor).
    async ensureTiles(bot) {
      if (!this.cfg.baldosasAuto) return true;
      if (this.tilesFound) return true;
      if (bot.role !== 'emisor') {                 // el receptor espera a que el emisor las encuentre
        const end = Date.now() + 60000;
        while (!this.tilesFound && Date.now() < end && !this.stopped) await sleep(300);
        return this.tilesFound;
      }
      for (let i = 0; i < 3 && !this.stopped; i++) {
        const t = await bot.detectTiles();
        if (t) {
          this.E.tile = t.white; this.R.tile = t.red; this.tilesFound = true;
          this.log('ok', `Baldosas encontradas: roja (${t.red.x},${t.red.y}) para ${this.R.profile.name} · blanca (${t.white.x},${t.white.y}) para ${this.E.profile.name}.`);
          this.pushStatus();
          return true;
        }
        await sleep(1500);
      }
      this.log('fail', `No encuentro la baldosa roja con la blanca al lado en «${this.cfg.zona}». Revisa que estén en el área y sin nadie encima, o pon sus posiciones a mano.`);
      await sleep(15000);
      return false;
    },

    async start({ cfg, emisor, receptor, zonaPass }) {
      if (this.running) return { ok: false, message: 'Ya está en marcha.' };
      this.cfg = normalize(cfg);
      this.zonaPass = String(zonaPass || '');
      this.stopped = false; this.running = true; this.tilesFound = false;
      // Que Windows no suspenda el programa mientras sube datos (las pantallas sí se pueden apagar).
      try { this.psb = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) { this.psb = null; }
      this.stats = { count: 0, cancels: 0, started: Date.now() };
      this.E = new Bot(this, 'emisor', emisor.profile, emisor.creds, this.cfg.baldosaE);
      this.R = new Bot(this, 'receptor', receptor.profile, receptor.creds, this.cfg.baldosaR);
      this.log('info', `En marcha: ${this.E.profile.name} envía ${this.cfg.dato} a ${this.R.profile.name} en ${this.cfg.isla} → ${this.cfg.zona}.`);
      this.R.open();
      setTimeout(() => { if (!this.stopped) this.E.open(); }, 2000);
      this.pushStatus();
      this.loop().catch(e => this.log('fail', `Error: ${e && e.message || e}`));
      return { ok: true };
    },

    async stop(reason) {
      if (!this.running) return { ok: true };
      this.stopped = true; this.running = false;
      try { if (this.psb != null && powerSaveBlocker.isStarted(this.psb)) powerSaveBlocker.stop(this.psb); } catch (_) {}
      this.psb = null;
      await sleep(250);
      this.E && this.E.destroy(); this.R && this.R.destroy();
      this.log('info', `Parado${reason ? ` (${reason})` : ''}. ${this.stats.count} datos subidos.`);
      this.pushStatus();
      return { ok: true };
    },

    // Cambios en directo (ritmo, dato…). La isla/área/cuentas necesitan parar y volver a empezar.
    live(patch) {
      const keep = { emisorId: this.cfg.emisorId, receptorId: this.cfg.receptorId, isla: this.cfg.isla, zona: this.cfg.zona, baldosasAuto: this.cfg.baldosasAuto, baldosaE: this.cfg.baldosaE, baldosaR: this.cfg.baldosaR };
      this.cfg = normalize({ ...this.cfg, ...(patch || {}), ...(this.running ? keep : {}) });
      this.pushStatus();
      return this.cfg;
    },

    usesProfile(id) { return this.running && ((this.E && this.E.profile.id === id) || (this.R && this.R.profile.id === id)); },

    async loop() {
      const E = this.E, R = this.R, S = () => this.cfg, gift = () => GIFTS[this.cfg.dato];
      let fails = 0, paused = false;

      const handleFail = async why => {
        fails++;
        this.log('warn', `${why} (fallo ${fails} seguido)`);
        if (fails === 4) {
          paused = true; this.log('warn', 'Recoloco a los dos en sus baldosas.');
          await Promise.all([R.walkToTile(), E.walkToTile()]); paused = false;
        } else if (fails === 7) {
          this.log('warn', 'Vuelvo a entrar en el área con las dos cuentas.');
          E.inZone = false; R.inZone = false; this.tilesFound = false;
        } else if (fails >= 10) {
          paused = true; fails = 0; this.tilesFound = false;
          this.log('warn', 'Sigue fallando: recargo el juego en las dos cuentas.');
          await Promise.all([E.reload('demasiados fallos'), R.reload('demasiados fallos')]);
          await sleep(5000); paused = false;
        } else await sleep(300);
      };

      // RECEPTOR: acepta el cartel en cuanto sale.
      (async () => {
        let since = 0;
        while (!this.stopped) {
          if (paused || R.state !== 'LISTO') { since = 0; await sleep(150); continue; }
          const t = await R.js(`const a = __byImg(/action\\/aceptar\\.svg/i); const x = __byImg(/action\\/cancelar\\.svg/i);
            return a ? { a: __center(a), x: x ? __center(x) : null } : null;`);
          if (t) {
            if (!since) since = Date.now();
            if (Date.now() - since > S().atascoR * 1000 && t.x) {
              R.log('warn', `El cartel lleva ${S().atascoR} s sin aceptarse: le doy a la X para que el otro vuelva a enviar.`);
              await R.fastClick(t.x); since = 0; await sleep(500); continue;
            }
            await R.fastClick(t.a);
          } else since = 0;
          await sleep(S().clicR);
        }
      })();

      // EMISOR: un clic por envío y la espera fija entre datos.
      (async () => {
        let enviadoSince = 0, prevEnv = false, noFicha = 0, cancelled = false, nextAllowed = 0;
        while (!this.stopped) {
          if (paused || E.state !== 'LISTO' || R.state !== 'LISTO') { await sleep(150); continue; }
          const s = await E.js(`const g = __byImg(${gift().img.toString()}); return { g: g ? __center(g) : null, env: !!__byText('Enviado a') };`);
          if (!s) { await sleep(200); continue; }

          if (prevEnv && !s.env && !cancelled) {            // aceptado
            this.stats.count++; fails = 0;
            nextAllowed = Date.now() + S().esperas[S().dato];
            this.log('dato', `Dato #${this.stats.count} (${S().dato})`);
            this.pushStatus();
          }
          if (!s.env) cancelled = false;
          prevEnv = s.env;

          if (s.env) {
            if (!enviadoSince) enviadoSince = Date.now();
            if (Date.now() - enviadoSince > S().atascoE * 1000) {
              this.stats.cancels++;
              E.log('warn', `«Enviado a» colgado ${S().atascoE} s: Cancelar y vuelvo a enviar.`);
              cancelled = true;
              await E.clickText('Cancelar');
              enviadoSince = 0;
              // Se ha colgado: este dato necesita más espera. Subimos 0,3 s (nunca baja de 3100) y se guarda.
              const g = S().dato, before = S().esperas[g];
              if (before < 10000) {
                this.cfg.esperas[g] = Math.min(10000, before + 300);
                this.log('info', `Espera del ${g.toLowerCase()} ajustada a ${this.cfg.esperas[g]} ms.`);
                try { save && save(this.cfg); } catch (_) {}
              }
              nextAllowed = Date.now() + S().esperas[g];
              this.pushStatus();
              await sleep(300); continue;
            }
            await sleep(30); continue;
          }
          enviadoSince = 0;

          if (s.g) {
            noFicha = 0;
            if (Date.now() < nextAllowed) { await sleep(Math.min(50, nextAllowed - Date.now())); continue; }
            await E.fastClick(s.g);
            const until = Date.now() + Math.max(400, S().clicE * 4);
            while (Date.now() < until && !this.stopped) { await sleep(25); if (await E.hasText('Enviado a')) break; }
            await sleep(S().clicE);
            continue;
          }

          // Ficha cerrada → fichar en la sombra de los pies.
          const st = await E.read();
          const target = E.find(st, R.user) || E.find(st, R.profile.name);
          if (!target) { await handleFail(`No veo a ${R.profile.name} en la sala de ${E.profile.name}`); E.inZone = false; continue; }
          await E.click(E.avatarPoint(st, target));
          let ok = false;
          for (let i = 0; i < 25 && !ok; i++) { await sleep(80); ok = await E.hasImg(gift().img); }
          if (!ok && ++noFicha >= 2) { noFicha = 0; await handleFail(`No se abre la ficha de ${R.profile.name}`); }
        }
      })();

      // Vigilante: mantiene las dos cuentas conectadas y en su sitio.
      while (!this.stopped) {
        await Promise.all([R.ensureReady(), E.ensureReady()]);
        this.pushStatus();
        await sleep(2000);
      }
    }
  };
  return mgr;
}

module.exports = { createSubirDatos, normalize, MIN_ESPERA, GIFTS: Object.keys(GIFTS) };
