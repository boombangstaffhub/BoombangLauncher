// «Subir datos» en el launcher: cuentas, isla/área, ritmo, registro y estado en directo.
(() => {
  const $ = id => document.getElementById(id);
  const api = window.bb && window.bb.subir;
  if (!api || !$('subirSection')) return;

  let minEspera = 3100;
  let esperas = { 'Beso': 3100, 'Cóctel': 8800, 'Flor': 4900 };   // espera por dato
  let running = false;
  let startedAt = 0;
  let saveTimer = null;
  const say = (msg, kind = 'good', ms = 3500) => (typeof toast === 'function' ? toast(msg, kind, ms) : console.log(msg));
  const STATE_TXT = { 'LISTO': 'En su baldosa', 'NAVEGANDO': 'Yendo al área', 'CAMINANDO': 'Caminando', 'INICIANDO SESIÓN': 'Iniciando sesión', 'CARGANDO': 'Cargando', 'RECARGANDO': 'Reconectando', 'SIN JUEGO': 'Sin conexión', 'CAPTCHA': 'CAPTCHA: resuélvelo', 'INICIO': 'Arrancando', 'ESPERANDO': 'Esperando a la otra' };

  function fillProfiles(list, cfg) {
    for (const [selId, key] of [['subirEmisor', 'emisorId'], ['subirReceptor', 'receptorId']]) {
      const sel = $(selId); sel.innerHTML = '';
      const none = document.createElement('option'); none.value = ''; none.textContent = '— Elige un perfil —'; sel.append(none);
      for (const p of list) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name + (p.hasAuth ? '' : ' (sin auto-login)') + (p.gameOpen ? ' · juego abierto' : '');
        o.disabled = !p.hasAuth;
        sel.append(o);
      }
      sel.value = list.some(p => p.id === cfg[key] && p.hasAuth) ? cfg[key] : '';
    }
    const ready = list.filter(p => p.hasAuth).length;
    $('subirAccountsNote').textContent = ready >= 2
      ? 'Solo se pueden elegir perfiles con el auto-login guardado.'
      : 'Necesitas dos perfiles con el auto-login guardado: ábrelos una vez desde Perfiles e inicia sesión.';
  }

  function fillForm(cfg, hasZonaPass) {
    $('subirIsla').value = cfg.isla || '';
    $('subirZona').value = cfg.zona || '';
    $('subirZonaPass').value = '';
    $('subirZonaPass').placeholder = hasZonaPass ? 'Guardada ✓ (escribe para cambiarla)' : 'Sin contraseña';
    $('subirDato').value = cfg.dato;
    esperas = { ...esperas, ...(cfg.esperas || {}) };
    $('subirEspera').value = esperas[cfg.dato] || minEspera;
    $('subirClicE').value = cfg.clicE;
    $('subirClicR').value = cfg.clicR;
    $('subirAtascoE').value = cfg.atascoE;
    $('subirAtascoR').value = cfg.atascoR;
    $('subirTilesAuto').checked = cfg.baldosasAuto !== false;
    $('subirRx').value = cfg.baldosaR.x; $('subirRy').value = cfg.baldosaR.y;
    $('subirWx').value = cfg.baldosaE.x; $('subirWy').value = cfg.baldosaE.y;
    $('subirTilesManual').classList.toggle('hidden', $('subirTilesAuto').checked);
  }

  function readForm() {
    const n = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) ? v : d; };
    return {
      emisorId: $('subirEmisor').value,
      receptorId: $('subirReceptor').value,
      isla: $('subirIsla').value.trim(),
      zona: $('subirZona').value.trim(),
      dato: $('subirDato').value,
      esperas: { ...esperas, [$('subirDato').value]: Math.max(minEspera, n('subirEspera', minEspera)) },
      clicE: n('subirClicE', 70), clicR: n('subirClicR', 70),
      atascoE: n('subirAtascoE', 5), atascoR: n('subirAtascoR', 120),
      baldosasAuto: $('subirTilesAuto').checked,
      baldosaR: { x: n('subirRx', 13), y: n('subirRy', 10) },
      baldosaE: { x: n('subirWx', 14), y: n('subirWy', 11) }
    };
  }

  function lockSetup(on) {
    for (const id of ['subirEmisor', 'subirReceptor', 'subirIsla', 'subirZona', 'subirZonaPass', 'subirTilesAuto', 'subirRx', 'subirRy', 'subirWx', 'subirWy']) $(id).disabled = on;
  }

  function addLog(line) {
    const box = $('subirLog');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    const div = document.createElement('div');
    div.className = `l-${line.kind}`;
    const t = document.createElement('span'); t.className = 't'; t.textContent = new Date(line.t).toLocaleTimeString('es-ES');
    div.append(t);
    if (line.tag) { const g = document.createElement('span'); g.className = `tag-${line.tag}`; g.textContent = line.tag === 'emisor' ? '[ENVÍA] ' : '[RECIBE] '; div.append(g); }
    div.append(document.createTextNode(line.msg));
    box.append(div);
    while (box.childElementCount > 300) box.firstElementChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(r).padStart(2, '0')}`;
  }

  function applyStatus(st) {
    running = Boolean(st.running);
    // Si el programa ha subido la espera de un dato, lo reflejamos (sin pisar lo que estés escribiendo).
    if (st.cfg && st.cfg.esperas) {
      esperas = { ...esperas, ...st.cfg.esperas };
      if (document.activeElement !== $('subirEspera')) $('subirEspera').value = esperas[$('subirDato').value] || minEspera;
    }
    startedAt = st.startedAt || 0;
    $('subirCount').textContent = st.count || 0;
    $('subirRate').textContent = st.perMin || 0;
    $('subirCancels').textContent = st.cancels || 0;
    const setState = (labelId, stateId, who, label) => {
      $(labelId).textContent = who ? `${label} · ${who.name}` : label;
      const el = $(stateId);
      el.textContent = who ? (STATE_TXT[who.state] || who.state) : '—';
      el.className = `subir-state ${who && who.state === 'LISTO' ? 'ok' : who ? 'wait' : ''}`;
    };
    setState('subirELabel', 'subirEState', running ? st.emisor : null, 'Envía');
    setState('subirRLabel', 'subirRState', running ? st.receptor : null, 'Recibe');
    const btn = $('subirToggle');
    btn.textContent = running ? '■ Parar' : '▶ Empezar';
    btn.classList.toggle('stop', running);
    lockSetup(running);
    if (!running) $('subirTime').textContent = '—';
  }

  async function load() {
    try {
      const d = await api.get();
      minEspera = d.minEspera || 3100;
      $('subirEspera').min = String(minEspera);
      const sel = $('subirDato'); sel.innerHTML = '';
      for (const g of d.gifts) { const o = document.createElement('option'); o.value = g; o.textContent = g; sel.append(o); }
      fillProfiles(d.profiles, d.cfg);
      fillForm(d.cfg, d.hasZonaPass);
      if (!d.cfg.emisorId && !d.cfg.receptorId && !d.status.running) $('subirHelp').classList.remove('hidden');   // primera vez
      applyStatus(d.status);
      $('subirLog').innerHTML = '';
      (d.log || []).forEach(addLog);
      if (!d.log || !d.log.length) addLog({ t: Date.now(), kind: 'info', msg: 'Elige las dos cuentas, la isla y el área, y pulsa Empezar.' });
    } catch (_) {}
  }

  async function refreshProfiles() {
    if (running) return;
    try {
      const d = await api.get();
      fillProfiles(d.profiles, { ...d.cfg, emisorId: $('subirEmisor').value || d.cfg.emisorId, receptorId: $('subirReceptor').value || d.cfg.receptorId });
    } catch (_) {}
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const pass = $('subirZonaPass').value;
      try {
        await api.save(readForm(), pass ? pass : undefined);
        if (pass) { $('subirZonaPass').value = ''; $('subirZonaPass').placeholder = 'Guardada ✓ (escribe para cambiarla)'; }
      } catch (_) {}
    }, 400);
  }

  // ---- eventos
  $('subirDato').addEventListener('change', () => { $('subirEspera').value = esperas[$('subirDato').value] || minEspera; });
  $('subirEspera').addEventListener('input', () => { const v = Number($('subirEspera').value); if (Number.isFinite(v) && v >= minEspera) esperas[$('subirDato').value] = v; });
  $('subirHelpBtn').onclick = () => { $('subirHelp').classList.toggle('hidden'); if (!$('subirHelp').classList.contains('hidden')) $('subirHelp').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('subirHelpClose').onclick = () => $('subirHelp').classList.add('hidden');
  $('subirTilesAuto').addEventListener('change', () => $('subirTilesManual').classList.toggle('hidden', $('subirTilesAuto').checked));
  for (const id of ['subirEmisor', 'subirReceptor', 'subirIsla', 'subirZona', 'subirZonaPass', 'subirDato', 'subirEspera', 'subirClicE', 'subirClicR', 'subirAtascoE', 'subirAtascoR', 'subirTilesAuto', 'subirRx', 'subirRy', 'subirWx', 'subirWy']) {
    $(id).addEventListener('change', scheduleSave);
    if ($(id).tagName === 'INPUT' && $(id).type !== 'checkbox') $(id).addEventListener('input', scheduleSave);
  }
  $('subirEspera').addEventListener('change', () => {
    if (Number($('subirEspera').value) < minEspera) { $('subirEspera').value = minEspera; say(`La espera mínima es ${minEspera} ms: con menos, el juego cuelga los envíos.`, 'bad'); scheduleSave(); }
  });
  $('subirZonaPass').addEventListener('keydown', e => { if (e.key === 'Escape') { $('subirZonaPass').value = ''; } });

  $('subirToggle').onclick = async () => {
    const btn = $('subirToggle');
    btn.disabled = true;
    try {
      if (running) { await api.stop(); }
      else {
        const pass = $('subirZonaPass').value;
        const r = await api.start(readForm(), pass ? pass : undefined);
        if (!r || !r.ok) say((r && r.message) || 'No se pudo empezar.', 'bad', 6000);
        else { $('subirZonaPass').value = ''; say('Subir datos en marcha. Puedes seguir usando el launcher.'); }
      }
    } catch (e) { say(String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'bad', 6000); }
    finally { btn.disabled = false; }
  };

  api.onLog(addLog);
  api.onStatus(applyStatus);
  setInterval(() => { if (running && startedAt) $('subirTime').textContent = fmtTime(Date.now() - startedAt); }, 1000);
  document.querySelector('[data-scroll="subirSection"]')?.addEventListener('click', refreshProfiles);
  window.addEventListener('focus', refreshProfiles);
  load();
})();
