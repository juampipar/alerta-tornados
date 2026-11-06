// Red de tormentas: entrar con Google, publicar lo que ves (link de video) con tu ubicación,
// ver lo último en una lista y en el mapa, y a qué pronóstico pertenece cada publicación.
import { SUPA_URL, SUPA_KEY, QUE_VIO, FUERTE } from './red-config.mjs';
import { POINTS, km, rumbo, bearingTo } from './risk.mjs';
import { artDate } from './historial.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const ART = 3 * 3600e3;
const clock = (ms) => { const d = new Date(ms - ART); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const dayLbl = (ms) => { const d = new Date(ms - ART); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `hace ${h} h` : `el ${dayLbl(ms)}`;
}
// "12 km al noroeste de Rafaela" (o "en Rafaela")
function placeTxt(p) {
  const t = POINTS.reduce((a, b) => (km(p, b) < km(p, a) ? b : a));
  const d = Math.round(km(p, t));
  return d < 4 ? `en ${t.name}` : `${d} km al ${rumbo(bearingTo(t, p))} de ${t.name}`;
}
// YouTube se puede ver adentro del panel; Instagram, TikTok, etc. se abren en su app.
function youtubeId(u) {
  const m = String(u).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i);
  return m ? m[1] : null;
}
const siteName = (u) => (/instagram/i.test(u) ? 'Instagram' : /tiktok/i.test(u) ? 'TikTok' : /facebook|fb\.watch/i.test(u) ? 'Facebook' : /(^|\.)x\.com|twitter/i.test(u) ? 'X' : 'YouTube');
const VIDEO_RE = /^https:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|x\.com|twitter\.com)\//i;

let sb = null, session = null, isAdmin = false, ctx = null;
let pubs = [], hist = null, layer = null, layerOn = true, picked = null, rangeH = 24;

/** A qué pronóstico pertenece: la zona de caza de ese día más cercana (del historial). */
export function forecastFor(p, h = hist) {
  const d = h?.dias?.[p.dia_tormenta];
  const pron = d?.pron_manana ?? d?.pron_dia_antes;
  if (!pron) return null;
  const zonas = (pron.zonas ?? []).map((z) => ({ ...z, dist: Math.round(km(p, z.centro)) })).sort((a, b) => a.dist - b.dist);
  const z = zonas[0];
  if (z && z.dist <= (z.radio_km ?? 60) + 40) return { dentro: true, zona: z.zona, potencial: z.potencial, dist: z.dist, hora_pico: z.hora_pico };
  return { dentro: false, max: pron.max_grilla?.v ?? null, zona: z?.zona ?? null, dist: z?.dist ?? null };
}

// Índice del panel en el lugar y la hora de la publicación (lo guarda el historial en GitHub).
const indiceDe = (p) => hist?.dias?.[p.dia_tormenta]?.publicaciones?.find((x) => x.id === p.id)?.indice ?? null;

function forecastHtml(p) {
  const f = forecastFor(p), ix = indiceDe(p);
  const ixTxt = ix ? `<p class="pfc">📈 Índice en ese lugar y hora: <b>${ix.v}</b>${ix.km ? ` (punto de la grilla a ${ix.km} km)` : ''}</p>` : '';
  if (!f) return ixTxt;
  return ixTxt + (f.dentro
    ? `<p class="pfc ok">🎯 Pronóstico de ese día: <b>zona ${esc(f.zona)}</b> · potencial ${f.potencial} · a ${f.dist} km del centro</p>`
    : `<p class="pfc">Fuera de las zonas pronosticadas ese día${f.zona ? ` (la más cerca: ${esc(f.zona)}, a ${f.dist} km)` : ` (potencial máximo ${f.max ?? '–'})`}</p>`);
}

function cardHtml(p) {
  const mine = session && p.user_id === session.user.id;
  const t = Date.parse(p.visto_en), c = Date.parse(p.creado);
  const yt = p.video_url && youtubeId(p.video_url);
  const strong = p.que_vio.some((x) => FUERTE.includes(x));
  const o = ctx.getOrigin();
  return `<li class="pub${strong ? ' fuerte' : ''}${p.oculto ? ' oculto' : ''}" id="pub-${p.id}">
    <div class="phead">
      ${p.autor_avatar ? `<img src="${esc(p.autor_avatar)}" alt="" width="32" height="32" referrerpolicy="no-referrer" loading="lazy">` : '<span class="noav">👤</span>'}
      <div><b>${esc(p.autor_nombre ?? 'Anónimo')}</b>
        <small>Vio a las ${clock(t)} (${dayLbl(t)}) · publicado ${ago(c)}</small></div>
    </div>
    <p class="pplace">📍 ${esc(placeTxt(p))}${o && !o.fallback ? ` · a ${Math.round(km(o, p))} km de vos` : ''}</p>
    ${p.que_vio.length ? `<p class="pchips">${p.que_vio.map((x) => `<span class="${FUERTE.includes(x) ? 'hot' : ''}">${esc(x)}</span>`).join('')}</p>` : ''}
    ${p.descripcion ? `<p class="pdesc">${esc(p.descripcion)}</p>` : ''}
    ${yt ? `<div class="pvideo"><iframe src="https://www.youtube-nocookie.com/embed/${yt}" title="Video" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
      : p.video_url ? `<a class="pvlink" href="${esc(p.video_url)}" target="_blank" rel="noopener nofollow">▶ Ver el video en ${siteName(p.video_url)} ↗</a>` : ''}
    ${forecastHtml(p)}
    ${p.oculto ? '<p class="pfc warn">Oculta para los demás (denuncias o moderación).</p>' : ''}
    <div class="pact">
      <button class="chip" data-map="${p.id}">Ver en el mapa</button>
      ${mine || isAdmin ? `<button class="chip" data-del="${p.id}">Borrar</button>` : ''}
      ${isAdmin ? `<button class="chip" data-hide="${p.id}" data-v="${p.oculto ? 0 : 1}">${p.oculto ? 'Mostrar' : 'Ocultar'}</button>` : ''}
      ${session && !mine ? `<button class="chip" data-rep="${p.id}">Denunciar</button>` : ''}
    </div>
  </li>`;
}

function renderLayer() {
  if (!layer) return;
  layer.clearLayers();
  if (!layerOn) return;
  // Actividad: lo de la última hora late; lo de hoy se ve fuerte; lo de días anteriores, apagado.
  for (const p of [...pubs].reverse()) {
    const strong = p.que_vio.some((x) => FUERTE.includes(x));
    const h = (Date.now() - Date.parse(p.visto_en)) / 3600e3;
    const age = h < 1 ? ' nuevo' : h < 24 ? '' : ' viejo';
    const icon = L.divIcon({ className: 'pubpin' + (strong ? ' fuerte' : '') + age, html: '🎥', iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([p.lat, p.lon], { icon, title: p.que_vio.join(', '), zIndexOffset: h < 1 ? 1000 : h < 24 ? 500 : 0 })
      .bindPopup(`<b>${esc(p.autor_nombre ?? 'Anónimo')}</b> · vio a las ${clock(Date.parse(p.visto_en))} (${ago(Date.parse(p.visto_en))})<br>${esc(p.que_vio.join(', ') || 'sin detalle')}<br><a href="${esc(p.video_url)}" target="_blank" rel="noopener nofollow">▶ Ver video</a> · <a href="#pub-${p.id}">Publicación ↓</a>`)
      .addTo(layer);
  }
}
export function setRedLayer(on) { layerOn = on; renderLayer(); }

function renderFeed() {
  const el = $('#redlist');
  const since = Date.now() - rangeH * 3600e3;
  const list = pubs.filter((p) => Date.parse(p.visto_en) >= since);
  const fuertes = list.filter((p) => p.que_vio.some((x) => FUERTE.includes(x))).length;
  $('#redsum').textContent = list.length
    ? `${list.length} ${list.length === 1 ? 'publicación' : 'publicaciones'}${fuertes ? ` · ${fuertes} con rotación, embudo o tornado` : ''}`
    : `Nada publicado en ${rangeH === 24 ? 'las últimas 24 h' : 'los últimos 7 días'}.`;
  el.innerHTML = list.map(cardHtml).join('');
  $$('[data-map]', el).forEach((b) => (b.onclick = () => { const p = pubs.find((x) => x.id === +b.dataset.map); ctx.showOnMap(p); }));
  $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
    if (!confirm('¿Borrar esta publicación?')) return;
    const p = pubs.find((x) => x.id === +b.dataset.del);
    const { error } = await sb.from('publicaciones').delete().eq('id', p.id);
    if (error) return alert('No se pudo borrar: ' + error.message);
    load();
  }));
  $$('[data-hide]', el).forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('publicaciones').update({ oculto: b.dataset.v === '1' }).eq('id', +b.dataset.hide);
    if (error) alert('No se pudo: ' + error.message); else load();
  }));
  $$('[data-rep]', el).forEach((b) => (b.onclick = async () => {
    const motivo = prompt('¿Por qué la denunciás? (spam, ofensiva, no es de una tormenta, ubicación falsa…)');
    if (motivo == null) return;
    const { error } = await sb.from('denuncias').insert({ publicacion_id: +b.dataset.rep, motivo: motivo.slice(0, 200) });
    alert(error ? (error.code === '23505' ? 'Ya la habías denunciado.' : 'No se pudo: ' + error.message) : 'Gracias. Con 3 denuncias se oculta hasta que se revise.');
  }));
}

export async function load() {
  if (!sb) return;
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data, error } = await sb.from('publicaciones').select('*').gte('visto_en', since).order('visto_en', { ascending: false }).limit(200);
  if (error) { $('#redsum').textContent = 'No se pudieron leer las publicaciones.'; return; }
  pubs = data ?? [];
  renderFeed(); renderLayer();
}

function renderAuth() {
  const btn = $('#authbtn'), form = $('#redform');
  if (session) {
    const m = session.user.user_metadata ?? {};
    btn.innerHTML = `${m.avatar_url ? `<img src="${esc(m.avatar_url)}" alt="" width="20" height="20" referrerpolicy="no-referrer">` : '👤'} ${esc((m.full_name || m.name || 'Vos').split(' ')[0])}`;
    btn.title = 'Tocá para salir';
  } else { btn.textContent = '👤 Entrar'; btn.title = 'Entrar con Google para publicar'; }
  $('#redlogin').hidden = !!session;
  form.hidden = !session;
}

async function login() {
  try { sessionStorage.setItem('redAbrir', '1'); } catch { /* sin almacenamiento */ }
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  if (error) alert('No se pudo entrar: ' + error.message);
}

function setPicked(p, how) {
  picked = p;
  $('#redloc').innerHTML = p ? `✅ ${esc(placeTxt(p))} <small>(${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}${p.precision_m ? `, ±${Math.round(p.precision_m)} m` : ''} · ${how})</small>` : 'Todavía no elegiste dónde.';
}

function nowLocalInput() { const d = new Date(Date.now() - ART); return d.toISOString().slice(0, 16); }

async function submit(e) {
  e.preventDefault();
  const f = e.target, out = $('#redmsg');
  const vio = $$('input[name="vio"]:checked', f).map((x) => x.value);
  const video = f.video.value.trim();
  if (!picked) return (out.textContent = 'Falta la ubicación: tocá “Usar mi ubicación” o elegí el punto en el mapa.');
  if (!video) return (out.textContent = 'Falta el link del video.');
  if (!VIDEO_RE.test(video)) return (out.textContent = 'El link tiene que ser de YouTube, Instagram, TikTok, Facebook o X.');
  const visto = new Date(f.visto.value + ':00-03:00');
  if (!(visto <= new Date(Date.now() + 5 * 60e3)) || visto < new Date(Date.now() - 7 * 864e5)) return (out.textContent = 'La hora tiene que ser de los últimos 7 días.');
  const btn = $('button[type="submit"]', f); btn.disabled = true; out.textContent = 'Publicando…';
  try {
    const row = { lat: +picked.lat.toFixed(5), lon: +picked.lon.toFixed(5), precision_m: picked.precision_m ?? null, visto_en: visto.toISOString(), que_vio: vio, descripcion: f.desc.value.trim() || null, video_url: video };
    const { error } = await sb.from('publicaciones').insert(row);
    if (error) throw new Error(error.message);
    out.textContent = '✅ Publicado.';
    f.reset(); f.visto.value = nowLocalInput(); setPicked(null);
    rangeH = 24; $$('#redrange button').forEach((x) => x.classList.toggle('on', x.dataset.h === '24'));
    await load();
  } catch (err) {
    out.textContent = 'No se pudo publicar: ' + err.message;
  } finally { btn.disabled = false; }
}

function formHtml() {
  return `<form id="redform" class="redform" hidden>
    <p class="safe">⚠️ <b>Nada vale más que tu vida.</b> Filmá de lejos (15 km o más), de costado y con salida libre. Nunca en el camino de la tormenta ni adentro de la lluvia o el granizo.</p>
    <div class="locrow">
      <button type="button" class="go" id="redgps">📍 Usar mi ubicación exacta</button>
      <button type="button" class="chip" id="redpick">📌 Elegir en el mapa</button>
      <span id="redloc" class="muted">Todavía no elegiste dónde.</span>
    </div>
    <p class="muted">Poné dónde estabas vos cuando lo viste. La ubicación exacta se muestra en el mapa público.</p>
    <label>¿Cuándo lo viste? <input type="datetime-local" name="visto" required></label>
    <fieldset><legend>¿Qué viste?</legend>${QUE_VIO.map((x) => `<label><input type="checkbox" name="vio" value="${x}"> ${x[0].toUpperCase() + x.slice(1)}</label>`).join('')}</fieldset>
    <label>Link del video <small>(subilo a YouTube, Instagram, TikTok, Facebook o X y pegá el link acá)</small><input type="url" name="video" maxlength="300" required placeholder="https://youtube.com/shorts/…"></label>
    <label>Descripción <textarea name="desc" maxlength="500" rows="3" placeholder="Hacia dónde iba, si giraba, granizo de qué tamaño…"></textarea></label>
    <button class="go" type="submit">Publicar</button>
    <p id="redmsg" class="muted" aria-live="polite"></p>
  </form>`;
}

/**
 * Arranca la red. opts: { map, getOrigin() → {lat, lon, fallback}, showOnMap(p), pickOnMap(cb) }
 */
export async function initRed(el, opts) {
  ctx = opts;
  el.innerHTML = `<div class="card">
    <div class="redhead"><h2>🎥 Red de tormentas</h2>
      <div class="seg small" id="redrange"><button data-h="24" class="on">Últimas 24 h</button><button data-h="168">7 días</button></div></div>
    <p class="muted">Videos de la gente que está mirando las tormentas, con su ubicación y la hora. En el mapa, 🎥 que late = última hora. Cada video se une solo al pronóstico de ese lugar y ese día, y alimenta el historial para ajustar el índice.</p>
    <details class="hform" id="redpub"><summary>➕ Publicar lo que estás viendo</summary>
      <div id="redlogin"><p>Para publicar entrá con tu cuenta de Google.</p><button class="go" id="redloginbtn" type="button">Entrar con Google</button></div>
      ${formHtml()}
    </details>
    <p id="redsum" class="muted">Cargando…</p>
    <ol class="publist" id="redlist"></ol>
  </div>`;
  // Cualquier botón "Publicar" del panel (por ejemplo, el del historial) abre el formulario.
  document.addEventListener('click', (e) => { if (e.target.closest('[data-publicar]')) $('#redpub').open = true; });
  $$('#redrange button', el).forEach((b) => (b.onclick = () => { rangeH = +b.dataset.h; $$('#redrange button', el).forEach((x) => x.classList.toggle('on', x === b)); renderFeed(); }));
  if (!window.supabase?.createClient) { $('#redsum').textContent = 'La red no está disponible ahora (no cargó la conexión).'; $('#authbtn').hidden = true; return; }
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  layer = L.layerGroup().addTo(opts.map);

  const f = $('#redform');
  f.visto.value = nowLocalInput();
  f.onsubmit = submit;
  $('#redloginbtn').onclick = login;
  $('#authbtn').onclick = async () => {
    if (!session) return login();
    if (confirm('¿Salir de tu cuenta?')) await sb.auth.signOut();
  };
  $('#redgps').onclick = () => {
    if (!navigator.geolocation) return alert('Tu navegador no da la ubicación. Elegí el punto en el mapa.');
    $('#redloc').textContent = 'Buscando tu ubicación…';
    navigator.geolocation.getCurrentPosition(
      (p) => setPicked({ lat: p.coords.latitude, lon: p.coords.longitude, precision_m: p.coords.accuracy }, 'GPS'),
      () => { setPicked(null); alert('No se pudo obtener la ubicación. Elegí el punto en el mapa.'); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  };
  $('#redpick').onclick = () => opts.pickOnMap((p) => { setPicked(p, 'elegida en el mapa'); $('#redpub').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_ev, s) => { session = s; setAdmin(); renderAuth(); renderFeed(); });
  setAdmin(); renderAuth();
  // Si volvió del login de Google, abrir el formulario para publicar.
  let abrir = null;
  try { abrir = sessionStorage.getItem('redAbrir'); sessionStorage.removeItem('redAbrir'); } catch { /* sin almacenamiento */ }
  if (session && abrir) { $('#redpub').open = true; el.scrollIntoView({ block: 'start' }); }

  try { const r = await fetch('data/historial.json', { cache: 'no-store' }); if (r.ok) hist = await r.json(); } catch { /* sin historial */ }
  await load();
  setInterval(load, 2 * 60e3);
}

// Solo para mostrar los botones de moderación: quién puede moderar lo decide la base (tabla admins).
const ADMINS = ['juampipar@gmail.com'];
function setAdmin() { isAdmin = ADMINS.includes(session?.user?.email); }
