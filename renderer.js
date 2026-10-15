const $ = id => document.getElementById(id);
let profiles = [];
let settings = {};
let editingId = null;
let lastProfileId = null;
let toastTimer = null;
let newsItems = [];
let newsFetchedAt = null;

function fmtDate(iso){ if(!iso) return 'Nunca usado'; try{ return new Date(iso).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); } catch{return 'Nunca usado';} }
function toast(msg, kind='good', ms=2800){ const el=$('toast'); el.textContent=msg; el.className=`toast ${kind}`; clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.add('hidden'),ms); }
const THEMES = [
  { id:'galaxy',    name:'Galaxy Crystal', tag:'GALAXY',    desc:'Estrellas y estrellas fugaces', sw:['#1b1250','#5b46e6','#ff8be0'] },
  { id:'aurora',    name:'Aurora Boreal',  tag:'AURORA',    desc:'Luces del norte en movimiento', sw:['#0b3a36','#3ef0c0','#b48cff'] },
  { id:'inferno',   name:'Inferno',        tag:'INFERNO',   desc:'Brasas que suben',              sw:['#3d0e07','#ff7a2f','#ffc94a'] },
  { id:'ocean',     name:'Océano',         tag:'OCEAN',     desc:'Rayos de luz y burbujas',       sw:['#06305e','#3fb6ff','#5ff0e6'] },
  { id:'sakura',    name:'Sakura',         tag:'SAKURA',    desc:'Pétalos y luna llena',          sw:['#3e1432','#ff8fb8','#ffd1e3'] },
  { id:'neon',      name:'Neon Retro',     tag:'NEON',      desc:'Sol synthwave y rejilla',       sw:['#2c0644','#ff2fd0','#23f0ff'] },
  { id:'halloween', name:'Halloween',      tag:'HALLOWEEN', desc:'Luna, niebla y murciélagos',    sw:['#2c1038','#ff8a1c','#b6ff3b'] }
];
const OLD_THEME = { nebula:'sakura', cosmos:'ocean', midnight:'galaxy', violet:'galaxy', emerald:'aurora' };   // names used by earlier versions
function applyTheme(theme){
  const id = THEMES.some(x=>x.id===theme) ? theme : (OLD_THEME[theme] || 'galaxy');
  const th = THEMES.find(x=>x.id===id);
  document.documentElement.dataset.theme = id;
  const eb=$('themeEyebrow'); if(eb) eb.textContent=`BOOMBANG · ${th.name.toUpperCase()}`;
  const bt=$('brandTag'); if(bt) bt.textContent=`${th.tag} LAUNCHER`;
  const ft=$('footerTheme'); if(ft) ft.textContent=`BoomBang Launcher · ${th.name}`;
  const hid=$('setTheme'); if(hid) hid.value=id;
  document.querySelectorAll('#themeGrid .theme-card').forEach(c=>c.classList.toggle('active', c.dataset.theme===id));
  return id;
}
function renderThemeGrid(){
  const grid=$('themeGrid'); if(!grid) return; grid.innerHTML='';
  for(const th of THEMES){
    const b=document.createElement('button'); b.type='button'; b.className='theme-card'; b.dataset.theme=th.id;
    b.style.setProperty('--s1',th.sw[0]); b.style.setProperty('--s2',th.sw[1]); b.style.setProperty('--s3',th.sw[2]);
    const pv=document.createElement('span'); pv.className='theme-preview';
    const nm=document.createElement('strong'); nm.textContent=th.name;
    const ds=document.createElement('small'); ds.textContent=th.desc;
    b.append(pv,nm,ds);
    b.onclick=async()=>{ const id=applyTheme(th.id); try{ settings=await window.bb.settings.save({theme:id}); }catch(_){ } };
    grid.append(b);
  }
  applyTheme(document.documentElement.dataset.theme);
}
function scrollToId(id){ document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'}); }
const lastProfile = () => profiles.find(p => p.id === lastProfileId) || profiles.find(p => p.lastPlayedAt);

// ------------------------------------------------------------------ dashboard
function updateDashboard(){
  const last = lastProfile();
  $('lastProfileName').textContent = last ? last.name : 'Sin perfil';
  $('lastProfileMeta').textContent = last ? (last._hasAuth ? '✅ Acceso automático listo' : '🔐 Haz login una vez y el launcher lo guardará') : 'Añade una cuenta para empezar';
  $('lastProfileDate').textContent = last?.lastPlayedAt ? `Último uso · ${fmtDate(last.lastPlayedAt)}` : '—';
  $('lastProfileBtn').disabled = !last;
  $('lastProfileBtn').textContent = last ? `Jugar con ${last.name}` : 'Jugar';
  $('lastProfileBtn').onclick = () => last && launch(last);
  $('quickPlay').textContent = last ? `Jugar con ${last.name}` : 'Jugar con último perfil';
}

// ------------------------------------------------------------------ news
function stripText(value){ return String(value||'').replace(/\s+/g,' ').trim(); }
function parseNewsHtml(html){
  if(!html) return [];
  const doc=document.implementation.createHTMLDocument('news');
  doc.documentElement.innerHTML=html;
  const seen=new Set(); const items=[];
  for(const a of [...doc.querySelectorAll('a[href*="/es/news/"]')]){
    const title=stripText(a.textContent);
    const href=a.getAttribute('href')||'';
    if(!title || title.length<10 || /^leer la noticia$/i.test(title) || /^todas las noticias$/i.test(title)) continue;
    const url=new URL(href,'https://www.boombang.tv').href;
    if(!url.includes('/es/news/') || seen.has(url)) continue;
    seen.add(url);
    const context=stripText((a.closest('article,li,section,div') || a.parentElement)?.textContent||'');
    const category=(context.match(/\b(Oficial|General|Eventos|Actualizaciones|Resultados y premios|Rares y ofertas)\b/i)||[])[1] || 'BoomBang';
    const date=(context.match(/\b\d{1,2} de [A-Za-záéíóúñ]+ de 20\d{2}\b/)||[])[0] || '';
    items.push({title,url,category,date});
    if(items.length>=6) break;
  }
  return items;
}
function renderNews(){
  const grid=$('newsGrid'); grid.innerHTML='';
  if(!newsItems.length){
    grid.innerHTML='<div class="news-empty"><div class="empty-icon">📰</div><h3>No se han podido cargar las noticias</h3><p>Comprueba tu conexión o abre la sección oficial de noticias.</p></div>';
  } else {
    for(const item of newsItems.slice(0,6)){
      const card=document.createElement('article'); card.className='news-card';
      const top=document.createElement('div'); top.className='news-top';
      const cat=document.createElement('span'); cat.className='news-cat'; cat.textContent=item.category;
      const date=document.createElement('span'); date.className='news-date'; date.textContent=item.date||'';
      top.append(cat,date);
      const title=document.createElement('h3'); title.textContent=item.title;
      const btn=document.createElement('button'); btn.className='news-read'; btn.textContent='Leer noticia ↗'; btn.onclick=()=>window.bb.app.openExternal(item.url);
      card.append(top,title,btn); grid.append(card);
    }
  }
  $('newsMeta').textContent=newsFetchedAt ? `Fuente oficial · actualizado ${new Date(newsFetchedAt).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}` : 'Fuente oficial de BoomBang';
}
async function loadNews(silent=false){
  if(!silent) $('newsMeta').textContent='Cargando noticias oficiales…';
  try{
    const result=await window.bb.news.fetch();
    if(result.ok){ newsItems=parseNewsHtml(result.html); newsFetchedAt=result.fetchedAt; renderNews(); if(!silent) toast(`Noticias actualizadas (${newsItems.length})`); }
    else { renderNews(); if(!silent) toast(result.error||'No se pudieron cargar las noticias','bad'); }
  }catch(error){ renderNews(); if(!silent) toast('No se pudieron cargar las noticias','bad'); }
}

// ------------------------------------------------------------------ profiles
async function render(){
  const q = $('profileSearch').value.trim().toLowerCase();
  const filtered = profiles.filter(p => !q || p.name.toLowerCase().includes(q));
  const box=$('profileList'); box.innerHTML='';
  if(!filtered.length){ $('emptyState').classList.toggle('hidden',profiles.length!==0); updateDashboard(); return; }
  $('emptyState').classList.add('hidden');
  const authResults = await Promise.all(filtered.map(async p=>({id:p.id, has:await window.bb.profiles.hasSession(p.id)})));
  for(const a of authResults){ const p=filtered.find(x=>x.id===a.id); if(p) p._hasAuth=a.has; }
  for(const p of filtered){
    const card=document.createElement('article'); card.className='profile';
    const avatar=document.createElement('div'); avatar.className='avatar'; avatar.textContent=p.name.slice(0,2).toUpperCase();
    const info=document.createElement('div'); info.className='profile-info';
    const name=document.createElement('div'); name.className='profile-name'; name.textContent=p.name;
    const status=document.createElement('div'); status.className='profile-status'+(p._hasAuth?' ready':''); status.textContent=p._hasAuth?`✅ Auto-login · ${fmtDate(p.lastPlayedAt)}`:`🔐 Login inicial · ${fmtDate(p.lastPlayedAt)}`;
    info.append(name,status);
    const actions=document.createElement('div'); actions.className='profile-actions';
    const play=document.createElement('button'); play.className='play'; play.textContent='Jugar'; play.onclick=()=>launch(p);
    const hub=document.createElement('button'); hub.className='small-action'; hub.title='Abrir BB Hub'; hub.textContent='✦'; hub.onclick=()=>openHub(p);
    const more=document.createElement('button'); more.className='small-action'; more.title='Opciones'; more.textContent='⋯'; more.onclick=ev=>{ev.stopPropagation();openProfileMenu(p,ev.currentTarget);};
    actions.append(play,hub,more); card.append(avatar,info,actions); box.append(card);
  }
  updateDashboard();
}
async function openHub(p){ try{ const ok=await window.bb.client.openPanel(p.id); if(!ok) toast('Primero abre este perfil en BoomBang.','bad'); } catch(_){ toast('No se pudo abrir BB Hub.','bad'); } }
async function launch(profile){
  localStorage.setItem('bb:lastProfileId',profile.id);
  lastProfileId=profile.id;
  try{ await window.bb.game.launch(profile.id); if(settings.hideLauncherOnGameLaunch) toast('BoomBang iniciado'); }
  catch(e){ toast((e.message||'No se pudo iniciar BoomBang').replace(/^Error invoking remote method '[^']+': (Error: )?/,''),'bad',6000); }
}

// ------------------------------------------------------------------ profile menu
function closeProfileMenu(){ document.getElementById('profileMenu')?.remove(); }
function openProfileMenu(profile, anchor){
  closeProfileMenu();
  const menu=document.createElement('div'); menu.id='profileMenu'; menu.className='pmenu';
  const items=[
    ['✏️ Renombrar',()=>openProfileModal(profile)],
    ['🚪 Cerrar sesión',()=>logoutProfile(profile)],
    ['🧹 Limpiar datos del perfil',()=>clearProfile(profile)],
    ['🗑 Borrar perfil',()=>deleteProfile(profile),true]
  ];
  for(const [label,fn,danger] of items){
    const b=document.createElement('button'); b.textContent=label; if(danger) b.className='danger';
    b.onclick=()=>{ closeProfileMenu(); fn(); };
    menu.append(b);
  }
  document.body.append(menu);
  const r=anchor?.getBoundingClientRect?.()||{left:40,bottom:40,right:240};
  const w=menu.offsetWidth||220, h=menu.offsetHeight||170;
  menu.style.left=Math.max(8,Math.min(window.innerWidth-w-8,r.right-w))+'px';
  menu.style.top=Math.max(8,Math.min(window.innerHeight-h-8,r.bottom+6))+'px';
}
document.addEventListener('click',e=>{ if(!e.target.closest?.('#profileMenu')) closeProfileMenu(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeProfileMenu(); });
async function logoutProfile(profile){
  if(!confirm(`Cerrar sesión de ${profile.name}?\nLa cuenta permanecerá en el launcher, pero pedirá login la próxima vez.`))return;
  await window.bb.profiles.logout(profile.id); toast('Sesión cerrada'); await render();
}
async function clearProfile(profile){
  if(!confirm(`Limpiar datos locales de ${profile.name}?\nEsto elimina la sesión web de ese perfil.`))return;
  await window.bb.cache.clear(profile.id); toast('Datos locales limpiados'); await render();
}
async function deleteProfile(profile){
  if(!confirm(`Eliminar completamente el perfil ${profile.name}?\nSe borrarán sus credenciales y datos locales.`))return;
  profiles=await window.bb.profiles.delete(profile.id); toast('Perfil eliminado'); await render();
}

// ------------------------------------------------------------------ profile modal
async function openProfileModal(edit=null){
  editingId=edit?.id||null;
  $('modalTitle').textContent=edit?'Editar perfil':'Añadir cuenta';
  $('modalKicker').textContent=edit?'EDITAR PERFIL':'NUEVO PERFIL';
  $('modalText').textContent=edit?'Cambia el nombre de este perfil.':'Elige un nombre para identificar la cuenta en el launcher.';
  $('profileName').value=edit?.name||''; $('modalError').textContent='';
  $('profileModal').classList.remove('hidden'); $('profileName').focus();
}
function closeProfileModal(){ $('profileModal').classList.add('hidden'); editingId=null; }
async function saveProfile(){
  try{
    const name=$('profileName').value.trim();
    profiles=editingId?await window.bb.profiles.rename(editingId,name):await window.bb.profiles.add(name);
    closeProfileModal(); toast(editingId?'Perfil actualizado':'Perfil creado'); await render();
  } catch(e){ $('modalError').textContent=(e.message||'No se pudo guardar.').replace(/^Error invoking remote method '[^']+': (Error: )?/,''); }
}

// ------------------------------------------------------------------ settings
async function openSettings(){
  settings=await window.bb.settings.get();
  $('setAutoLogin').checked=!!settings.autoLogin; $('setAutoclick').checked=settings.autoclickEnabled!==false; setIntervalInputs(settings.autoclickInterval); syncIntervalRow(); $('setHideLauncher').checked=!!settings.hideLauncherOnGameLaunch; $('setRememberSize').checked=!!settings.rememberWindowSize;
  $('setServerCheck').checked=!!settings.checkServerOnStart; $('setStartWindows').checked=!!settings.startWithWindows; $('setMinimizeTray').checked=!!settings.minimizeToTray;
  $('setAutoUpdate').checked=settings.autoUpdateCheck!==false; $('updateCheckInfo').textContent=appVersion?`Tienes la V${appVersion}.`:'—';
  renderThemeGrid(); applyTheme(settings.theme);
  $('settingsModal').classList.remove('hidden');
}
function clampInterval(v){ const n=Math.round(Number(v)); return Number.isFinite(n)&&n>=1 ? Math.min(1000,n) : 1; }
function setIntervalInputs(v){ const n=clampInterval(v); $('setAutoclickInterval').value=String(n); $('setAutoclickIntervalRange').value=String(Math.min(500,n)); }
function syncIntervalRow(){ $('acIntervalRow').classList.toggle('off',!$('setAutoclick').checked); }
$('setAutoclickIntervalRange').addEventListener('input',e=>{ $('setAutoclickInterval').value=e.target.value; });
$('setAutoclickInterval').addEventListener('input',e=>{ const n=Math.round(Number(e.target.value)); if(Number.isFinite(n)&&n>=1) $('setAutoclickIntervalRange').value=String(Math.min(500,n)); });
$('setAutoclickInterval').addEventListener('change',e=>setIntervalInputs(e.target.value));
$('setAutoclick').addEventListener('change',syncIntervalRow);
function closeSettings(){ $('settingsModal').classList.add('hidden'); }
async function saveSettings(){
  settings=await window.bb.settings.save({autoLogin:$('setAutoLogin').checked,autoclickEnabled:$('setAutoclick').checked,autoclickInterval:clampInterval($('setAutoclickInterval').value),hideLauncherOnGameLaunch:$('setHideLauncher').checked,rememberWindowSize:$('setRememberSize').checked,checkServerOnStart:$('setServerCheck').checked,startWithWindows:$('setStartWindows').checked,minimizeToTray:$('setMinimizeTray').checked,autoUpdateCheck:$('setAutoUpdate').checked,theme:$('setTheme').value});
  applyTheme(settings.theme); closeSettings(); toast('Ajustes guardados');
}
// ------------------------------------------------------------------ diagnostics / server
async function openDiagnostics(){
  try{ const d=await window.bb.diagnostics.get(); $('diagVersion').textContent='V'+d.launcherVersion; $('diagElectron').textContent=d.electron; $('diagChrome').textContent=d.chrome; $('diagNode').textContent=d.node; $('diagPlatform').textContent=`${d.platform} · ${d.arch}`; $('diagProfiles').textContent=String(d.profiles); $('diagGames').textContent=String(d.gamesOpen); $('diagData').textContent=d.dataRoot; $('diagnosticsModal').classList.remove('hidden'); }
  catch(e){ toast('No se pudo abrir diagnóstico','bad'); }
}
function applyServer(data){ $('serverDot').className='dot '+(data.online?'online':'offline'); $('serverText').textContent=data.online?'Servidor online':'Servidor no disponible'; $('serverLatency').textContent=data.latency?`${data.latency} ms`:'—'; }
async function refreshServer(){ applyServer(await window.bb.server.check()); }

// ------------------------------------------------------------------ updates (GitHub)
let appVersion='', pendingUpdate=null, updating=false;
const cleanErr = e => String(e && e.message || e || '').replace(/^Error invoking remote method '[^']+': (Error: )?/,'');
function showUpdate(info){
  if(!info || !info.available || updating) return;
  pendingUpdate=info;
  try{ if(localStorage.getItem('bb:skipUpdate')===info.latest && !info.manual) return; }catch(_){}
  const b=$('updateBanner'); b.classList.remove('hidden','busy','failed');
  $('updateTitle').textContent=`Nueva versión disponible: V${info.latest}`;
  $('updateStatus').textContent=`Tienes la V${info.current}. Pulsa «Actualizar» para instalarla; tus perfiles y ajustes no se tocan.`;
  $('updateNotes').textContent=info.notes||'Sin notas para esta versión.';
  $('updateNotes').classList.add('hidden'); $('updateNotesBtn').textContent='Novedades';
}
function hideUpdate(){ $('updateBanner').classList.add('hidden'); }
async function checkUpdates(){
  const btn=$('checkUpdateBtn'); btn.disabled=true; $('updateCheckInfo').textContent='Buscando…';
  try{
    const r=await window.bb.update.check();
    if(!r.ok){ $('updateCheckInfo').textContent=r.message||'No se pudo comprobar.'; return; }
    if(r.available){ $('updateCheckInfo').textContent=`Hay una versión nueva: V${r.latest} (tienes la V${r.current}).`; showUpdate({...r,manual:true}); closeSettings(); }
    else $('updateCheckInfo').textContent=`Tienes la última versión (V${r.current}).`;
  }catch(e){ $('updateCheckInfo').textContent='No se pudo comprobar: '+cleanErr(e); }
  finally{ btn.disabled=false; }
}
async function applyUpdate(){
  if(updating || !pendingUpdate) return;
  updating=true; const b=$('updateBanner'); b.classList.remove('failed'); b.classList.add('busy');
  $('updateTitle').textContent=`Actualizando a la V${pendingUpdate.latest}…`; $('updateStatus').textContent='Preparando…'; $('updateNotes').classList.add('hidden');
  try{
    const r=await window.bb.update.apply();
    if(r && r.ok){ $('updateTitle').textContent=`V${r.version} instalada`; $('updateStatus').textContent='Reiniciando el launcher…'; return; }
    throw new Error(r && r.message || 'No se pudo actualizar.');
  }catch(e){
    updating=false; b.classList.remove('busy'); b.classList.add('failed');
    $('updateTitle').textContent='La actualización no se completó'; $('updateStatus').textContent=cleanErr(e)+' Tu versión actual sigue intacta.';
    $('updateNowBtn').textContent='Reintentar';
  }
}
$('updateNowBtn').onclick=applyUpdate;
$('updateLaterBtn').onclick=()=>{ try{ if(pendingUpdate) localStorage.setItem('bb:skipUpdate',pendingUpdate.latest); }catch(_){} hideUpdate(); };
$('updateNotesBtn').onclick=()=>{ const n=$('updateNotes'); n.classList.toggle('hidden'); $('updateNotesBtn').textContent=n.classList.contains('hidden')?'Novedades':'Ocultar'; };
$('checkUpdateBtn').onclick=checkUpdates;
window.bb.update.onProgress(step=>{ if(updating) $('updateStatus').textContent=step; });
window.bb.update.onAvailable(showUpdate);

// ------------------------------------------------------------------ boot
async function load(){
  settings = await window.bb.settings.get();
  applyTheme(settings.theme);
  profiles = await window.bb.profiles.list();
  lastProfileId = localStorage.getItem('bb:lastProfileId');
  await render();
  await loadNews(true);
  const v=await window.bb.app.version(); appVersion=v; $('footerVersion').textContent='V'+v;
}

$('profileSearch').addEventListener('input',()=>render());
$('addProfileBtn').onclick=()=>openProfileModal(); $('emptyAddBtn').onclick=()=>openProfileModal();
$('closeModal').onclick=closeProfileModal; $('cancelModal').onclick=closeProfileModal; $('saveProfile').onclick=saveProfile;
$('profileName').addEventListener('keydown',e=>{if(e.key==='Enter')saveProfile();if(e.key==='Escape')closeProfileModal();});
$('settingsBtn').onclick=openSettings; $('sideSettingsBtn').onclick=openSettings; $('closeSettings').onclick=closeSettings; $('saveSettings').onclick=saveSettings;
$('diagnosticsBtn').onclick=openDiagnostics; $('closeDiagnostics').onclick=()=>$('diagnosticsModal').classList.add('hidden'); $('closeDiagnosticsAction').onclick=()=>$('diagnosticsModal').classList.add('hidden');
$('openDataFolder').onclick=()=>window.bb.app.openDataFolder();
$('refreshBtn').onclick=async()=>{ await load(); await refreshServer(); toast('Launcher actualizado'); };
$('officialBtn').onclick=()=>window.bb.app.openExternal('https://www.boombang.tv/es/');
$('quickPlay').onclick=()=>{ const p=lastProfile(); if(p) launch(p); else toast('Aún no tienes un perfil','bad'); };
$('heroProfilesBtn').onclick=()=>scrollToId('profiles');
$('quickHubSidebar').onclick=()=>{ const p=lastProfile(); if(!p) return toast('Aún no tienes un perfil usado.','bad'); openHub(p); };
$('allNewsBtn').onclick=()=>window.bb.app.openExternal('https://www.boombang.tv/es/news');
$('reloadNewsBtn').onclick=()=>loadNews(false);
window.bb.server.onStatus(applyServer);
for (const item of document.querySelectorAll('[data-scroll]')) {
  item.addEventListener('click', () => { scrollToId(item.getAttribute('data-scroll')); document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x === item)); });
}
document.addEventListener('keydown', e=>{
  if(e.ctrlKey && e.shiftKey && e.key.toLowerCase()==='r'){ e.preventDefault(); $('refreshBtn').click(); }
  if(e.ctrlKey && e.key.toLowerCase()==='p'){ e.preventDefault(); $('profileSearch').focus(); $('profileSearch').select(); }
  if(e.key==='Escape'){ closeProfileModal(); closeSettings(); $('diagnosticsModal').classList.add('hidden'); }
});
load().then(refreshServer).catch(()=>{});
