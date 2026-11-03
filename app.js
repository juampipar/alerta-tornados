import { HOME, buildDataset, level, scoreColor, verdict, km, driveHours } from './lib/risk.mjs';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const TZ = 'America/Argentina/Cordoba';
const fmt = (iso, o = { weekday: 'short', hour: '2-digit', minute: '2-digit' }) => new Date(iso).toLocaleString('es-AR', { timeZone: TZ, ...o });
const nowArt = () => { const d = new Date(Date.now() - 3 * 3600e3); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };
const WINDOW = [11, 22]; // horas en que se buscan las tormentas

const S = {
  data: null, smn: null, all: false, day: 0, hour: Math.min(22, Math.max(11, nowArt().hour)), max: true,
  origin: { ...HOME, label: 'Leones' },
  layers: { zonas: true, smn: true, radar: true, sat: false, ir: false },
};

/* ---------------- Mapa ---------------- */
const map = L.map('map', { preferCanvas: true, zoomSnap: 0.5 }).setView([-33.4, -61.6], 6);
for (const [n, z] of [['sat', 250], ['grid', 350], ['radar', 380], ['smn', 420], ['labels', 450]]) {
  map.createPane(n).style.zIndex = z;
}
map.getPane('labels').style.pointerEvents = 'none';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
L.tileLayer(ESRI + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Esri, HERE, Garmin, © OpenStreetMap' }).addTo(map);
L.tileLayer(ESRI + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, pane: 'labels' }).addTo(map);

const gridLayer = L.layerGroup().addTo(map);
const townLayer = L.layerGroup().addTo(map);
const smnLayer = L.layerGroup().addTo(map);
let originMarker = null;
function drawOrigin() {
  originMarker?.remove();
  originMarker = L.circleMarker([S.origin.lat, S.origin.lon], { radius: 7, color: '#fff', weight: 3, fillColor: '#5fb4ff', fillOpacity: 1 })
    .bindTooltip(S.origin.label === 'Leones' ? 'Leones (casa)' : 'Tu ubicación').addTo(map);
}
drawOrigin();

// Satélite GOES (NASA GIBS). Probamos variantes de capa/formato y usamos la primera que responde.
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';
const SAT_CANDIDATES = {
  sat: [['GOES-East_ABI_GeoColor', 7, 'png'], ['GOES-East_ABI_GeoColor', 7, 'jpg'], ['GOES-East_ABI_Band2_Red_Visible_1km', 7, 'png']],
  ir: [['GOES-East_ABI_Band13_Clean_Infrared', 6, 'png'], ['GOES-East_ABI_Band13_Clean_Infrared', 6, 'jpg']],
};
const satLayers = {};
const probe = (url) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i.naturalWidth > 0); i.onerror = () => ok(false); i.src = url; });
async function satLayer(kind) {
  if (satLayers[kind]) return satLayers[kind];
  for (const [id, lvl, ext] of SAT_CANDIDATES[kind]) {
    const tpl = `${GIBS}${id}/default/default/GoogleMapsCompatible_Level${lvl}/{z}/{y}/{x}.${ext}`;
    if (await probe(L.Util.template(tpl, { z: 5, y: 19, x: 10 }))) {
      return (satLayers[kind] = L.tileLayer(tpl, { pane: 'sat', maxNativeZoom: lvl, maxZoom: 16, opacity: kind === 'ir' ? 0.7 : 0.85, attribution: 'NOAA GOES / NASA GIBS' }));
    }
  }
  return null;
}
async function setSat(kind, on) {
  const l = await satLayer(kind);
  if (!l) { stamp(`Satélite no disponible ahora. Usá el link de RAMMB.`); return; }
  on ? l.addTo(map) : l.remove();
}
function stamp(t) { $('#radarstamp').textContent = t; }

// Radar (RainViewer).
let frames = [], fi = 0, radarTimer = null, radarTimes = [];
async function loadRadar() {
  try {
    const j = await (await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' })).json();
    frames.forEach((f) => f.remove());
    const past = j.radar?.past ?? [];
    radarTimes = past.map((f) => f.time * 1000);
    frames = past.map((f) => L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { pane: 'radar', opacity: 0, maxNativeZoom: 7, maxZoom: 16 }));
    if (S.layers.radar) frames.forEach((f) => f.addTo(map));
    fi = frames.length - 1;
    clearInterval(radarTimer);
    if (!frames.length) return stamp('Radar sin datos');
    frames[fi].setOpacity(0.8);
    let hold = 0;
    radarTimer = setInterval(() => {
      if (fi === frames.length - 1 && hold++ < 3) return; // pausa en el último cuadro
      hold = 0;
      frames[fi].setOpacity(0);
      fi = (fi + 1) % frames.length;
      frames[fi].setOpacity(0.8);
      stamp(`Radar ${fmt(radarTimes[fi], { hour: '2-digit', minute: '2-digit' })}${fi === frames.length - 1 ? ' · último' : ''}`);
    }, 700);
  } catch { stamp('Radar no disponible'); }
}

$$('#layers .chip').forEach((b) => (b.onclick = () => {
  const k = b.dataset.l, on = !S.layers[k];
  S.layers[k] = on; b.classList.toggle('on', on);
  if (k === 'zonas') { on ? gridLayer.addTo(map) : gridLayer.remove(); $('#legend').hidden = !on; }
  if (k === 'smn') on ? smnLayer.addTo(map) : smnLayer.remove();
  if (k === 'radar') { frames.forEach((f) => (on ? f.addTo(map) : f.remove())); if (!on) stamp(''); }
  if (k === 'sat' || k === 'ir') setSat(k, on);
}));

/* ---------------- Datos ---------------- */
const dates = () => [...new Set(S.data.times.map((t) => t.slice(0, 10)))];
const curDate = () => dates()[S.day];
const idxAt = (date, h) => S.data.times.indexOf(`${date}T${pad(h)}:00`);
const windowIdx = (date) => S.data.times.flatMap((t, i) => (t.startsWith(date) && +t.slice(11, 13) >= WINDOW[0] && +t.slice(11, 13) <= WINDOW[1] ? [i] : []));
function pick(series, date) {
  if (!S.max) { const i = idxAt(date, S.hour); return { v: series[i] ?? 0, i }; }
  let v = -1, i = -1;
  for (const k of windowIdx(date)) if (series[k] > v) { v = series[k]; i = k; }
  return { v: Math.max(v, 0), i };
}
function townsRanked() {
  const date = curDate();
  return S.data.towns.map((t) => {
    const { v, i } = pick(t.score, date);
    return { t, score: v, i, hour: +S.data.times[i]?.slice(11, 13), cape: t.cape[i], cin: t.cin[i], li: t.li[i], td: t.td[i], shear: t.shear[i], ll: t.ll[i], pr: t.pr[i], dist: Math.round(km(S.origin, t)) };
  }).sort((a, b) => b.score - a.score || a.dist - b.dist);
}

/* ---------------- Render ---------------- */
let rects = [];
function buildGrid() {
  gridLayer.clearLayers();
  const h = S.data.grid.step / 2;
  rects = S.data.grid.pts.map(([lat, lon], k) => {
    const r = L.rectangle([[lat - h, lon - h], [lat + h, lon + h]], { pane: 'grid', stroke: false, fillOpacity: 0, interactive: true });
    r.bindTooltip(() => `Potencial ${r._v ?? 0}`, { sticky: true });
    r._k = k;
    return r.addTo(gridLayer);
  });
}
function renderGrid() {
  const date = curDate();
  for (const r of rects) {
    const v = pick(S.data.grid.score[r._k], date).v;
    r._v = v;
    r.setStyle(v < 20 ? { fillOpacity: 0 } : { fillColor: scoreColor(v), fillOpacity: 0.1 + (v / 100) * 0.5 });
  }
}
function renderTowns(rank) {
  townLayer.clearLayers();
  for (const r of rank) {
    const lv = level(r.score);
    L.circleMarker([r.t.lat, r.t.lon], { radius: 4 + r.score / 14, color: '#0a0f1c', weight: 1.5, fillColor: lv.color, fillOpacity: 0.95 })
      .bindTooltip(`<b>${esc(r.t.name)}</b> · ${r.score} ${lv.label}<br>CAPE ${r.cape} · cizalla ${r.shear}/${r.ll} m/s · ${r.hour} h`)
      .on('click', () => focusTown(r)).addTo(townLayer);
  }
}

const MET = [
  // etiqueta, clave, unidad, umbral alto, umbral medio, menor es mejor, palabras
  ['CAPE', 'cape', 'J/kg', 2500, 1000, false, ['alto', 'ok', 'bajo']],
  ['Cizalla 0–6 km', 'shear', 'm/s', 20, 12.5, false, ['fuerte', 'ok', 'débil']],
  ['Cizalla 0–1,5 km', 'll', 'm/s', 10, 7, false, ['fuerte', 'ok', 'débil']],
  ['Punto de rocío', 'td', '°C', 18, 14, false, ['húmedo', 'ok', 'seco']],
  ['CIN (tapa)', 'cin', 'J/kg', 25, 100, true, ['abierta', 'media', 'fuerte']],
  ['Lifted Index', 'li', '', -6, -3, true, ['muy inestable', 'inestable', 'estable']],
];
function metricsHtml(r) {
  return MET.map(([lbl, k, u, hi, mid, inv, w]) => {
    const v = r[k];
    const c = inv ? (v <= hi ? 0 : v <= mid ? 1 : 2) : v >= hi ? 0 : v >= mid ? 1 : 2;
    return `<div class="m ${['good', 'mid', 'low'][c]}"><span>${lbl}</span><b>${v ?? '–'}</b> ${u}<em>${w[c]}</em></div>`;
  }).join('');
}
const dirLink = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

function renderHero(rank) {
  const b = rank[0];
  if (!b) { $('#hero').textContent = 'Sin datos para este día.'; return; }
  const lv = level(b.score);
  // Núcleo de la grilla (puede caer entre localidades).
  const date = curDate();
  let core = null;
  S.data.grid.pts.forEach(([lat, lon], k) => { const v = pick(S.data.grid.score[k], date).v; if (!core || v > core.v) core = { v, lat, lon }; });
  const near = core && S.data.towns.reduce((a, t) => (km(core, t) < km(core, a) ? t : a));
  const coreTxt = core && core.v >= b.score + 8 && core.v >= 30
    ? `<p class="sub">Máximo de la grilla: <b>${core.v}</b> cerca de ${esc(near.name)} (${Math.round(km(near, core))} km). <a href="${dirLink(core.lat, core.lon)}" target="_blank" rel="noopener">Ruta</a></p>` : '';
  const when = S.max ? `pico a las ${b.hour} h` : `a las ${S.hour} h`;
  $('#hero').innerHTML = `
    <div class="gauge" style="--v:${b.score};--c:${lv.color}"><span>${b.score}<small>${lv.label}</small></span></div>
    <div>
      <div class="kicker">Mejor zona · ${['hoy', 'mañana', 'pasado mañana'][S.day]}</div>
      <h2>${esc(b.t.name)}</h2>
      <p class="verdict">${verdict(b.score)}</p>
      <p class="sub">${b.dist} km desde ${esc(S.origin.label)} (~${driveHours(b.dist).toFixed(1)} h) · ${when}</p>
      ${coreTxt}
      <a class="go" href="${dirLink(b.t.lat, b.t.lon)}" target="_blank" rel="noopener">Cómo llegar →</a>
    </div>
    <div class="metrics">${metricsHtml(b)}</div>`;
}

function spark(t) {
  const d = curDate(), pts = [];
  for (let h = 0; h < 24; h++) { const i = idxAt(d, h); if (i >= 0) pts.push([h, t.score[i]]); }
  const X = (h) => (h / 23) * 300, Y = (v) => 22 - (v / 100) * 20;
  const line = pts.map(([h, v]) => `${X(h).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const mark = S.max ? '' : `<line x1="${X(S.hour)}" x2="${X(S.hour)}" y1="0" y2="22" stroke="#5fb4ff" stroke-width="1.5"/>`;
  return `<svg class="spark" viewBox="0 0 300 22" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="300" y1="${Y(45)}" y2="${Y(45)}" stroke="#2c3a5c" stroke-dasharray="3 3"/>
    <polyline points="${line}" fill="none" stroke="${level(Math.max(...pts.map((p) => p[1]))).color}" stroke-width="2" vector-effect="non-scaling-stroke"/>${mark}</svg>`;
}
function renderList(rank) {
  $('#rankinfo').textContent = `${S.max ? 'Máximo entre las 11 y las 22 h' : `A las ${S.hour} h`} · distancias desde ${S.origin.label}`;
  const shown = S.all ? rank : rank.slice(0, 10);
  $('#list').innerHTML = shown.map((r, k) => {
    const lv = level(r.score);
    return `<li class="row" data-k="${k}">
      <span class="sc" style="background:${lv.color}">${r.score}</span>
      <span><span class="nm">${esc(r.t.name)}</span> <small>${r.dist} km · ~${driveHours(r.dist).toFixed(1)} h · ${S.max ? 'pico ' : ''}${r.hour} h · CAPE ${r.cape} · cizalla ${r.shear}/${r.ll}</small></span>
      <a class="go" href="${dirLink(r.t.lat, r.t.lon)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ir</a>
      ${spark(r.t)}
    </li>`;
  }).join('') + (rank.length > 10 ? `<li><button class="chip more" id="more">${S.all ? 'Ver menos' : `Ver las ${rank.length}`}</button></li>` : '');
  if ($('#more')) $('#more').onclick = () => { S.all = !S.all; renderList(rank); };
  $$('#list .row').forEach((li) => (li.onclick = () => focusTown(rank[+li.dataset.k])));
}
function focusTown(r) {
  if (!$('#tab-map').hidden) map.flyTo([r.t.lat, r.t.lon], 8, { duration: 0.8 });
  else showTab('map'), map.setView([r.t.lat, r.t.lon], 8);
  $('.mapcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderDays() {
  const labels = dates().map((d, i) => (i < 2 ? ['Hoy', 'Mañana'][i] : new Date(d + 'T12:00:00Z').toLocaleDateString('es-AR', { weekday: 'long', timeZone: 'UTC' })));
  $('#days').innerHTML = labels.map((l, i) => `<button data-d="${i}" class="${i === S.day ? 'on' : ''}">${l[0].toUpperCase() + l.slice(1)}</button>`).join('');
  $$('#days button').forEach((b) => (b.onclick = () => { S.day = +b.dataset.d; renderDays(); render(); }));
}
function renderTimebar() {
  $('#hour').value = S.hour;
  $('#hourlbl').textContent = S.max ? 'máx' : `${S.hour} h`;
  $('#maxbtn').classList.toggle('on', S.max);
  $('#timebar').classList.toggle('off', S.max);
}
function render() {
  if (!S.data) return;
  const rank = townsRanked();
  renderGrid(); renderTowns(rank); renderHero(rank); renderList(rank); renderTimebar();
}

/* ---------------- Avisos SMN ---------------- */
const SEV = { Extreme: ['#ff3b5c', 'Rojo', 0], Severe: ['#ff8c1a', 'Naranja', 1], Moderate: ['#ffd43b', 'Amarillo', 2], Minor: ['#3ddc97', 'Verde', 3] };
function alertColor(a) {
  const p = `${Object.values(a.params || {}).join(' ')} ${a.headline}`.toLowerCase();
  if (/rojo|red/.test(p)) return SEV.Extreme;
  if (/naranja|orange/.test(p)) return SEV.Severe;
  if (/amarill|yellow/.test(p)) return SEV.Moderate;
  return SEV[a.severity] || ['#8d9bb8', a.severity || 'Aviso', 4];
}
function inPoly([lat, lon], poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function renderSmn() {
  const el = $('#smn'), d = S.smn;
  smnLayer.clearLayers();
  if (!d || !d.ok) {
    el.className = 'card smn';
    el.innerHTML = `<div class="smnhead"><h2>Avisos oficiales SMN</h2></div>
      <p class="muted">No se pudieron leer automáticamente${d?.error ? ` (${esc(d.error)})` : ''}. Revisalos en
      <a href="https://www.smn.gob.ar/alertas" target="_blank" rel="noopener">smn.gob.ar/alertas</a>.</p>`;
    return;
  }
  const al = d.alerts.map((a) => {
    const [c, lbl, rank] = a.shortTerm ? ['#ff3b5c', 'Aviso a corto plazo', -1] : alertColor(a);
    const mine = a.areas.some((ar) => ar.polygons.some((p) => inPoly([S.origin.lat, S.origin.lon], p)));
    for (const ar of a.areas) for (const p of ar.polygons)
      L.polygon(p, { pane: 'smn', color: c, weight: a.shortTerm ? 3 : 1.5, fillColor: c, fillOpacity: a.shortTerm ? 0.25 : 0.12, dashArray: a.shortTerm ? null : '4 4' })
        .bindTooltip(`<b>${esc(a.event || a.headline)}</b><br>${esc(lbl)} · hasta ${a.expires ? fmt(a.expires) : '–'}`).addTo(smnLayer);
    return { a, c, lbl, rank, mine };
  }).sort((x, y) => x.rank - y.rank || y.mine - x.mine);
  const upd = `actualizado ${fmt(d.fetched, { hour: '2-digit', minute: '2-digit' })}`;
  if (!al.length) {
    el.className = 'card smn none';
    el.innerHTML = `<div class="smnhead"><h2>✅ Sin avisos oficiales del SMN en el Pasillo</h2><span class="muted">${upd}</span></div>`;
    return;
  }
  el.className = 'card smn';
  el.innerHTML = `<div class="smnhead"><h2>⚠️ Avisos oficiales SMN (${al.length})</h2><span class="muted">${upd}</span></div>` +
    al.slice(0, 8).map(({ a, c, lbl, mine }) => `
      <div class="al ${mine ? 'mine' : ''}" style="--c:${c}">
        <b><span class="tag">${esc(lbl)}</span>${esc(a.event || a.headline)}${mine ? ' · <u>incluye tu zona</u>' : ''}</b>
        <small>${esc(a.areas.map((x) => x.desc).filter(Boolean).join(' · ').slice(0, 220))}</small>
        <small>${a.onset || a.effective ? `Desde ${fmt(a.onset || a.effective)} · ` : ''}hasta ${a.expires ? fmt(a.expires) : '–'}</small>
        ${a.description ? `<details><summary>Detalle</summary>${esc(a.description)}${a.instruction ? `<p>${esc(a.instruction)}</p>` : ''}</details>` : ''}
      </div>`).join('') +
    (al.length > 8 ? `<p class="muted">Y ${al.length - 8} más en <a href="https://www.smn.gob.ar/alertas" target="_blank" rel="noopener">smn.gob.ar</a>.</p>` : '');
}

/* ---------------- Estado / carga ---------------- */
function renderStatus() {
  const p = [];
  if (S.data) {
    const age = (Date.now() - Date.parse(S.data.generated)) / 3600e3;
    p.push(`<span class="pill ${age > 3 ? 'warn' : ''}"><i></i>Pronóstico ${fmt(S.data.generated, { hour: '2-digit', minute: '2-digit' })}</span>`);
  }
  if (S.smn) p.push(`<span class="pill ${S.smn.ok ? (S.smn.alerts.length ? 'bad' : '') : 'warn'}"><i></i>SMN: ${S.smn.ok ? S.smn.alerts.length + ' avisos' : 'sin datos'}</span>`);
  $('#status').innerHTML = p.join('');
}
async function getJson(u) { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }

async function loadForecast() {
  try {
    S.data = await getJson('data/forecast.json');
    if ((Date.now() - Date.parse(S.data.generated)) / 3600e3 > 4) throw new Error('viejo');
  } catch {
    try { S.data = await buildDataset(fetch); } // respaldo: directo desde Open-Meteo
    catch (e) { if (!S.data) { $('#hero').textContent = `No se pudo cargar el pronóstico (${e.message}).`; return; } }
  }
  buildGrid(); renderDays(); render(); renderStatus();
}
async function loadSmn() {
  try { S.smn = await getJson('data/smn.json'); } catch { S.smn = { ok: false, error: 'sin archivo de avisos' }; }
  renderSmn(); renderStatus();
}

/* ---------------- Controles ---------------- */
function showTab(t) {
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
  for (const k of ['map', 'windy', 'rayos']) $('#tab-' + k).hidden = k !== t;
  $('#layers').style.visibility = $('#timebar').style.visibility = t === 'map' ? 'visible' : 'hidden';
  if (t === 'map') map.invalidateSize();
}
$$('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.t)));
$('#hour').oninput = (e) => { S.hour = +e.target.value; S.max = false; render(); };
$('#maxbtn').onclick = () => { S.max = !S.max; render(); };
let playT = null;
$('#play').onclick = () => {
  if (playT) { clearInterval(playT); playT = null; $('#play').textContent = '▶'; return; }
  S.max = false; if (S.hour >= 23) S.hour = 9;
  $('#play').textContent = '❚❚';
  playT = setInterval(() => { S.hour = S.hour >= 23 ? 9 : S.hour + 1; render(); }, 900);
};
$$('#origin button').forEach((b) => (b.onclick = () => {
  const set = (o) => { S.origin = o; $$('#origin button').forEach((x) => x.classList.toggle('on', x === b)); drawOrigin(); render(); renderSmn(); };
  if (b.dataset.o === 'home') return set({ ...HOME, label: 'Leones' });
  if (!navigator.geolocation) return alert('Tu navegador no da la ubicación.');
  b.textContent = '📍 Buscando…';
  navigator.geolocation.getCurrentPosition(
    (p) => { b.textContent = '📍 Mi ubicación'; set({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'tu ubicación' }); },
    () => { b.textContent = '📍 Mi ubicación'; alert('No se pudo obtener la ubicación.'); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}));

loadForecast(); loadSmn(); loadRadar();
setInterval(loadRadar, 5 * 60e3);
setInterval(() => { loadSmn(); }, 10 * 60e3);
setInterval(() => { loadForecast(); }, 60 * 60e3);
