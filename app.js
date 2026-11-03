import { HOME, buildDataset, level, scoreColor, verdict, km, driveHours, sunsetHour, rumbo, huntZones as findZones, goTo } from './lib/risk.mjs';
import { stormDiagram, radarShapes } from './lib/diagram.mjs';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const TZ = 'America/Argentina/Cordoba';
const fmt = (iso, o = { weekday: 'short', hour: '2-digit', minute: '2-digit' }) => new Date(iso).toLocaleString('es-AR', { timeZone: TZ, ...o });
const nowArt = () => { const d = new Date(Date.now() - 3 * 3600e3); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };
const WINDOW = [11, 2]; // de 11 h a 2 h del día siguiente: en el Pasillo muchas tormentas severas son nocturnas (chorro de bajo nivel)

const S = {
  data: null, smn: null, all: false, day: 0, hour: Math.min(22, Math.max(11, nowArt().hour)), max: true,
  origin: { ...HOME, label: 'Leones' },
  layers: { zonas: true, smn: true, lluvia: false, radar: false, sat: false, ir: false }, // RainViewer casi no cubre el centro de Argentina: apagado de entrada
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

/* ---------------- Distancia segura y movimiento de tormentas ---------------- */
// Círculos de 10 y 20 km alrededor de tu punto, flecha con hacia dónde van las tormentas
// (pronóstico) y, para cada aviso a corto plazo del SMN, dónde estaría en 30 minutos.
const SAFE_KM = 20, CLOSE_KM = 10;
const safeLayer = L.layerGroup().addTo(map);
const dest = (p, deg, d) => {
  const r = (deg * Math.PI) / 180;
  return { lat: p.lat + (d * Math.cos(r)) / 111.2, lon: p.lon + (d * Math.sin(r)) / (111.2 * Math.cos((p.lat * Math.PI) / 180)) };
};
function arrow(from, deg, d, opts, tip) {
  const to = dest(from, deg, d), h = Math.max(2.5, d * 0.25);
  const a1 = dest(to, deg + 155, h), a2 = dest(to, deg - 155, h);
  const g = L.layerGroup([
    L.polyline([[from.lat, from.lon], [to.lat, to.lon]], { pane: 'smn', interactive: !!tip, ...opts }),
    L.polyline([[a1.lat, a1.lon], [to.lat, to.lon], [a2.lat, a2.lon]], { pane: 'smn', interactive: false, ...opts }),
  ]);
  if (tip) g.eachLayer((l) => l.bindTooltip?.(tip, { sticky: true }));
  return g;
}
// Distancia (km) de un punto a un polígono: 0 si está adentro, si no al borde más cercano.
function distToPoly(p, poly) {
  if (inPoly([p.lat, p.lon], poly)) return 0;
  const kx = 111.2 * Math.cos((p.lat * Math.PI) / 180), ky = 111.2;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = (poly[j][1] - p.lon) * kx, ay = (poly[j][0] - p.lat) * ky;
    const bx = (poly[i][1] - p.lon) * kx, by = (poly[i][0] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const centroid = (poly) => ({ lat: poly.reduce((s, q) => s + q[0], 0) / poly.length, lon: poly.reduce((s, q) => s + q[1], 0) / poly.length });
const bearing = (a, b) => (Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360;
// Movimiento de las tormentas del pronóstico en la localidad más cercana a un punto.
function motionNear(p) {
  if (!S.data) return null;
  const t = S.data.towns.reduce((a, b) => (km(p, b) < km(p, a) ? b : a));
  const i = pick(t.score, curDate()).i;
  const dir = t.mdir?.[i], spd = t.mspd?.[i];
  return dir == null || spd == null ? null : { dir, spd, town: t.name };
}

function renderSafety() {
  safeLayer.clearLayers();
  const o = S.origin, mv = motionNear(o);
  L.circle([o.lat, o.lon], { pane: 'smn', radius: SAFE_KM * 1000, color: '#5fb4ff', weight: 2, dashArray: '6 6', fillColor: '#5fb4ff', fillOpacity: 0.05, interactive: false }).addTo(safeLayer);
  L.circle([o.lat, o.lon], { pane: 'smn', radius: CLOSE_KM * 1000, color: '#ff3b5c', weight: 1.5, dashArray: '3 5', fill: false, interactive: false }).addTo(safeLayer);
  if (mv) arrow(o, mv.dir, Math.max(8, mv.spd / 2), { color: '#5fb4ff', weight: 3, opacity: 0.9 },
    `Las tormentas van hacia el <b>${rumbo(mv.dir)}</b> a ${mv.spd} km/h (pronóstico). En 30 min recorren ~${Math.round(mv.spd / 2)} km.`).addTo(safeLayer);

  // Avisos a corto plazo: flecha a 30 min y el más cercano a vos.
  let near = null;
  for (const a of S.smn?.alerts ?? []) {
    if (!a.shortTerm) continue;
    for (const ar of a.areas) for (const poly of ar.polygons) {
      const c = centroid(poly), m = motionNear(c);
      if (m) arrow(c, m.dir, m.spd / 2, { color: '#ff3b5c', weight: 2.5, dashArray: '5 4' },
        `<b>${esc(a.event || 'Aviso a corto plazo')}</b><br>En 30 min se movería ~${Math.round(m.spd / 2)} km hacia el ${rumbo(m.dir)} (según el pronóstico)`).addTo(safeLayer);
      const d = distToPoly(o, poly);
      if (!near || d < near.d) near = { d, c, m, a };
    }
  }
  const el = $('#safeinfo');
  if (!near) {
    el.className = 'safeinfo';
    el.innerHTML = `<b>Círculos:</b> 20 km (distancia segura) y 10 km (muy cerca)${mv ? ` · tormentas → <b>${rumbo(mv.dir)}</b> ${mv.spd} km/h` : ''}<br>Sin avisos a corto plazo del SMN ahora.`;
    return;
  }
  const d = Math.round(near.d), from = rumbo(bearing(o, near.c));
  // ¿Se te acerca? Comparo la dirección de la tormenta con la dirección desde la tormenta hacia vos.
  let coming = '';
  if (near.m) {
    const toMe = bearing(near.c, o), diff = Math.abs(((near.m.dir - toMe + 540) % 360) - 180);
    if (diff < 45 && d > 0) coming = ` · <b>viene hacia vos</b>: llegaría en ~${Math.round((d / near.m.spd) * 60)} min`;
    else if (diff > 120) coming = ' · se aleja';
    else coming = ' · pasa de costado';
  }
  const lvl = d === 0 ? 'in' : d <= CLOSE_KM ? 'close' : d <= SAFE_KM ? 'safe' : 'far';
  const txt = {
    in: '⚠️ <b>Estás dentro de un aviso a corto plazo.</b> Buscá un lugar firme y techado.',
    close: `⚠️ Aviso a corto plazo a <b>${d} km</b> al ${from}: <b>demasiado cerca</b>`,
    safe: `👀 Aviso a corto plazo a <b>${d} km</b> al ${from}: buena distancia para mirar`,
    far: `Aviso a corto plazo más cercano: <b>${d} km</b> al ${from}`,
  }[lvl];
  el.className = 'safeinfo ' + lvl;
  el.innerHTML = txt + (lvl === 'in' ? '' : coming);
}

// Con "Mi ubicación", seguir el GPS mientras manejás.
let gpsWatch = null;
function stopGps() { if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }

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
    if (!frames.length) return S.layers.radar && stamp('Radar sin datos');
    frames[fi].setOpacity(0.8);
    let hold = 0;
    radarTimer = setInterval(() => {
      if (fi === frames.length - 1 && hold++ < 3) return; // pausa en el último cuadro
      hold = 0;
      frames[fi].setOpacity(0);
      fi = (fi + 1) % frames.length;
      frames[fi].setOpacity(0.8);
      if (S.layers.radar) stamp(`Radar ${fmt(radarTimes[fi], { hour: '2-digit', minute: '2-digit' })}${fi === frames.length - 1 ? ' · último' : ''}`);
    }, 700);
  } catch { if (S.layers.radar) stamp('Radar no disponible'); }
}

$$('#layers .chip').forEach((b) => (b.onclick = () => {
  const k = b.dataset.l, on = !S.layers[k];
  S.layers[k] = on; b.classList.toggle('on', on);
  if (k === 'zonas') { on ? gridLayer.addTo(map) : gridLayer.remove(); $('#legend').hidden = !on; renderZones(); }
  if (k === 'lluvia') renderWrf();
  if (k === 'smn') on ? smnLayer.addTo(map) : smnLayer.remove();
  if (k === 'radar') { frames.forEach((f) => (on ? f.addTo(map) : f.remove())); if (!on) stamp(''); }
  if (k === 'sat' || k === 'ir') setSat(k, on);
}));

/* ---------------- Datos ---------------- */
const dates = () => [...new Set(S.data.times.map((t) => t.slice(0, 10)))];
const curDate = () => dates()[S.day];
const idxAt = (date, h) => S.data.times.indexOf(`${date}T${pad(h)}:00`);
const nextDate = (date) => new Date(Date.parse(date + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
const windowIdx = (date) => {
  const nd = nextDate(date);
  return S.data.times.flatMap((t, i) => {
    const h = +t.slice(11, 13);
    return (t.startsWith(date) && h >= WINDOW[0]) || (t.startsWith(nd) && h <= WINDOW[1]) ? [i] : [];
  });
};
// Hora del pico; si cae de madrugada del día siguiente, lo aclara.
const hourTxt = (i, date) => { const t = S.data.times[i]; if (!t) return '–'; const h = +t.slice(11, 13); return t.startsWith(date) ? `${h} h` : `${h} h (madrugada)`; };
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
    return { t, score: v, i, hour: hourTxt(i, date), cape: t.cape[i], cin: t.cin[i], li: t.li[i], td: t.td[i], lcl: t.lcl?.[i], shear: t.shear[i], ll: t.ll[i], srh: t.srh?.[i], pr: t.pr[i], dist: Math.round(km(S.origin, t)) };
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
      .bindTooltip(`<b>${esc(r.t.name)}</b> · ${r.score} ${lv.label}<br>CAPE ${fx('cape', r.cape)} · cizalla ${fx('shear', r.shear)}/${fx('ll', r.ll)} m/s · SRH ${fx('srh', r.srh)} · ${r.hour}`)
      .on('click', () => focusTown(r)).addTo(townLayer);
  }
}

const MET = [
  // etiqueta, clave, unidad, umbral alto, umbral medio, menor es mejor, palabras
  ['CAPE', 'cape', 'J/kg', 2500, 1000, false, ['alto', 'ok', 'bajo']],
  ['Cizalla 0–6 km', 'shear', 'm/s', 20, 12.5, false, ['fuerte', 'ok', 'débil']],
  ['Cizalla 0–1 km', 'll', 'm/s', 10, 7, false, ['fuerte', 'ok', 'débil']],
  ['Helicidad 0–1 km', 'srh', 'm²/s²', -150, -75, true, ['ciclónica', 'algo', 'débil']],
  ['Base de nube (LCL)', 'lcl', 'm', 1000, 1500, true, ['baja', 'media', 'alta']],
  ['Punto de rocío', 'td', '°C', 18, 14, false, ['húmedo', 'ok', 'seco']],
  ['CIN (tapa)', 'cin', 'J/kg', 25, 100, true, ['abierta', 'media', 'fuerte']],
  ['Lifted Index', 'li', '', -6, -3, true, ['muy inestable', 'inestable', 'estable']],
];
// Los modelos no tienen la precisión de un decimal: se muestran valores redondeados.
// (El puntaje y los colores usan el valor sin redondear.)
const STEP = { cape: 100, shear: 1, ll: 1, srh: 10, lcl: 100, td: 1, cin: 10, li: 1 };
const fx = (k, v) => { if (v == null) return '–'; const st = STEP[k] ?? 1, x = Math.round(v / st) * st; return String(Object.is(x, -0) ? 0 : x); };

// Confianza del pronóstico según el día: cuanto más lejos, más se equivoca el modelo en dónde y cuándo.
const CONF = [
  { k: 'alta', txt: 'Confianza alta: el modelo suele ubicar bien la región, aunque la tormenta puede formarse 50–100 km más allá o con horas de diferencia.' },
  { k: 'media', txt: 'Confianza media: sirve para saber si el día tiene potencial, pero la zona puede correrse bastante. Revisalo de nuevo mañana.' },
  { k: 'baja', txt: 'Confianza baja: solo una tendencia. Es común que cambie por completo de un día para el otro.' },
];
const conf = (d) => CONF[Math.min(d, CONF.length - 1)];

function metricsHtml(r) {
  return MET.map(([lbl, k, u, hi, mid, inv, w]) => {
    const v = r[k];
    if (v == null) return `<div class="m"><span>${lbl}</span><b>–</b> ${u}<em>sin dato</em></div>`;
    const c = inv ? (v <= hi ? 0 : v <= mid ? 1 : 2) : v >= hi ? 0 : v >= mid ? 1 : 2;
    return `<div class="m ${['good', 'mid', 'low'][c]}"><span>${lbl}</span><b>${fx(k, v)}</b> ${u}<em>${w[c]}</em></div>`;
  }).join('');
}
const dirLink = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

// Pueblo al que ir: el de la zona de caza principal (o el de más puntaje si no hay zona).
const target = (rank) => (S.zones?.[0] ? goTo(S.zones[0], rank) : rank[0]);
function renderHero(rank) {
  if (!rank[0]) { $('#hero').textContent = 'Sin datos para este día.'; return; }
  const z = S.zones?.[0], z2 = S.zones?.[1], b = target(rank);
  const score = z ? z.v : b.score, lv = level(score);
  const when = S.max ? `pico a las ${b.hour}` : `a las ${S.hour} h`;
  const day = ['hoy', 'mañana', 'pasado mañana'][S.day];
  $('#hero').innerHTML = `
    <div class="gauge" style="--v:${score};--c:${lv.color}"><span>${score}<small>${lv.label}</small></span></div>
    <div>
      <div class="kicker">${z ? 'Zona de caza' : 'Sin zona de caza'} · ${day} <span class="conf conf-${conf(S.day).k}">Confianza ${conf(S.day).k}</span></div>
      <h2>${z ? `Zona ${esc(z.name)}` : esc(b.t.name)}</h2>
      <p class="verdict">${verdict(score)}</p>
      <p class="sub">Ir hacia <b>${esc(b.t.name)}</b>${z && km(b.t, z.ctr) > z.r ? ` (pueblo más cercano: la zona empieza ${Math.round(km(b.t, z.ctr) - z.r)} km al ${rumbo(Math.atan2((z.ctr.lon - b.t.lon) * Math.cos((b.t.lat * Math.PI) / 180), z.ctr.lat - b.t.lat) * 180 / Math.PI)})` : ''}: ${b.dist} km desde ${esc(S.origin.label)} (~${driveHours(b.dist).toFixed(1)} h) · ${when}${z ? ` · círculo de ~${Math.round(z.r)} km` : ''}</p>
      ${z2 ? `<p class="sub">Otra zona: <b>${esc(z2.name)}</b> · ${z2.v}</p>` : ''}
      <p class="sub conftxt">${conf(S.day).txt}</p>
      <a class="go" href="${dirLink(b.t.lat, b.t.lon)}" target="_blank" rel="noopener">Ruta a ${esc(b.t.name)} →</a>
    </div>
    <p class="mlegend">Ingredientes en <b>${esc(b.t.name)}</b>:</p>
    <div class="metrics">${metricsHtml(b)}</div>
    <p class="mlegend"><span class="sw sw-good">rojo</span> favorece tornados · <span class="sw sw-mid">naranja</span> a medias · <span class="sw sw-low">gris</span> no ayuda · <a href="#guia">Guía: cómo leerlo y qué hacer ↓</a></p>
    <details class="how"><summary>¿Cómo se calcula el puntaje?</summary><ul>
      <li><b>Energía × viento:</b> se multiplican. Sin CAPE no hay tormenta por más viento que haya; sin cizalladura la tormenta no se organiza ni rota.</li>
      <li><b>Cizalladura 0–6 km</b> (≥20 m/s ideal) organiza supercélulas. Con menos de 15 m/s el puntaje no pasa de Moderado, y con menos de 10 m/s no pasa de Bajo, por más CAPE que haya.</li>
      <li><b>Helicidad 0–1 km</b> (≤ −150 m²/s² ideal) y <b>cizalladura 0–1 km</b> (≥10 m/s): el giro del viento cerca del suelo, lo que más se asocia a tornados. En el hemisferio sur la supercélula peligrosa es la que se desvía a la izquierda, por eso la helicidad útil es <b>negativa</b>.</li>
      <li><b>Base de nube (LCL)</b>: por debajo de 1000 m es ideal; por encima de 2000 m la tormenta puede rotar pero el tornado casi nunca llega al suelo.</li>
      <li>Suman: Lifted Index muy negativo, rocío ≥18 °C, que el modelo genere lluvia, y días de mucha cizalla con poco CAPE y base baja (típicos de otoño/invierno).</li>
      <li>Restan: aire muy seco y “tapa” fuerte (CIN &gt;100). Las zonas altas de las sierras (&gt;1200 m) no se puntúan: ahí el viento del modelo no es confiable.</li>
      <li>Se toma la mejor hora entre las 11 h y las 2 h del día siguiente. Es un pronóstico de ingredientes, no un aviso de tornado.</li>
      <li>Los valores se muestran redondeados: el modelo no tiene la precisión de un decimal. Tomalos como orden de magnitud (“fuerte”, “bajo”), no como una medición.</li>
    </ul></details>`;
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
  $('#rankinfo').textContent = `${S.max ? 'Máximo entre las 11 h y las 2 h' : `A las ${S.hour} h`} · distancias desde ${S.origin.label}`;
  const shown = S.all ? rank : rank.slice(0, 10);
  $('#list').innerHTML = shown.map((r, k) => {
    const lv = level(r.score);
    return `<li class="row" data-k="${k}">
      <span class="sc" style="background:${lv.color}">${r.score}</span>
      <span><span class="nm">${esc(r.t.name)}</span>${S.zones?.some((z) => km(r.t, z.ctr) <= z.r) ? ' <span class="inzone" title="Dentro de una zona de caza">🎯</span>' : ''} <small>${r.dist} km · ~${driveHours(r.dist).toFixed(1)} h · ${S.max ? 'pico ' : ''}${r.hour} · CAPE ${fx('cape', r.cape)} · cizalla ${fx('shear', r.shear)}/${fx('ll', r.ll)} · base ${fx('lcl', r.lcl)} m</small></span>
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
  $('#days').innerHTML = labels.map((l, i) => `<button data-d="${i}" class="${i === S.day ? 'on' : ''}" title="Confianza ${conf(i).k}">${l[0].toUpperCase() + l.slice(1)}<i class="cdot conf-${conf(i).k}" aria-hidden="true"></i></button>`).join('');
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
  renderGrid(); S.zones = huntZones(); renderTowns(rank); renderHero(rank); renderPlan(); renderList(rank); renderTimebar(); renderSafety(); renderZones(); renderWrf();
}

/* ---------------- Plan de caza ---------------- */
// Arma un plan para novatos con el pico de cada localidad (siempre el máximo del día, sin importar el control de hora).
const hm = (h) => { const m = Math.round((((h % 24) + 24) % 24) * 4) * 15; return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; };
const mapsDir = (o, d) => `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lon}&destination=${d.lat},${d.lon}&travelmode=driving`;
const mapsNear = (q, t) => `https://www.google.com/maps/search/${encodeURIComponent(q)}/@${t.lat},${t.lon},13z`;

function peakFor(t, date) {
  let v = -1, i = -1;
  for (const k of windowIdx(date)) if (t.score[k] > v) { v = t.score[k]; i = k; }
  if (i < 0) return null;
  const ts = S.data.times[i];
  return { t, i, v, h: +ts.slice(11, 13) + (ts.startsWith(date) ? 0 : 24) };
}

// Zonas de caza con el máximo del día (de 11 a 2 h), sin importar el control de hora.
function dayZones(date) {
  const idx = windowIdx(date);
  const cells = S.data.grid.pts.map(([lat, lon], k) => ({ lat, lon, v: Math.max(0, ...idx.map((i) => S.data.grid.score[k][i] ?? 0)) }));
  return findZones(cells, S.data.towns);
}
function renderPlan() {
  const el = $('#plan');
  const date = curDate();
  const peaks = S.data.towns.map((t) => peakFor(t, date)).filter(Boolean).sort((a, b) => b.v - a.v || km(S.origin, a.t) - km(S.origin, b.t));
  // El plan usa siempre el máximo del día: zona de caza del día y su pueblo de destino.
  const dz = dayZones(date)[0];
  const goT = dz && goTo(dz, peaks.map((x) => ({ ...x, score: x.v }))).t;
  const p = (goT && peaks.find((x) => x.t === goT)) || peaks[0];
  if (!p) { el.innerHTML = ''; return; }
  const sc = dz ? dz.v : p.v; // puntaje del día = el de la zona
  const t = p.t, dist = Math.round(km(S.origin, t)), drive = driveHours(dist);
  const dayTxt = ['hoy', 'mañana', 'pasado mañana'][S.day];
  const head = (badge, cls, title) => `<div class="planhead"><h2>Plan de caza · ${dayTxt}</h2><span class="pbadge ${cls}">${badge}</span></div><p class="plantitle">${title}</p>`;

  // ¿Vale la pena?
  if (sc < 45) {
    const other = dates().map((d, k) => ({ k, best: dayZones(d)[0]?.v ?? 0 })).filter((x) => x.k !== S.day && x.best >= 45);
    el.innerHTML = head('No salgas', 'no', `${dayTxt[0].toUpperCase() + dayTxt.slice(1)} no da: el máximo del día es ${sc}. Faltan ingredientes para tormentas que giren.`)
      + (other.length ? `<p class="sub">Mirá ${other.map((x) => `<b>${['hoy', 'mañana', 'pasado mañana'][x.k]}</b>`).join(' y ')}: ahí sí hay potencial.</p>` : '<p class="sub">Ningún día de los próximos tres tiene potencial. Quedate tranquilo.</p>');
    return;
  }

  const sunset = sunsetHour(t.lat, t.lon, date);
  const start = Math.max(11, p.h - 2); // las tormentas suelen arrancar 1–2 h antes del pico
  const arrive = start - 1; // llegar 1 h antes para esperar tranquilo
  const leave = arrive - drive;
  const night = p.h >= sunset + 0.5;
  const now = nowArt(), nowH = S.day === 0 && now.date === date ? now.hour : -1;
  const mdir = t.mdir?.[p.i], mspd = t.mspd?.[p.i];
  const hasMove = mdir != null && mspd != null;
  const from = hasMove ? rumbo(mdir + 180) : 'oeste', to = hasMove ? rumbo(mdir) : 'este';
  const side = hasMove ? rumbo(mdir - 90) : 'norte'; // en el hemisferio sur: lado izquierdo de la trayectoria (entra el aire cálido)
  const hail = hasMove ? rumbo(mdir + 90) : 'sur';

  let badge = 'Vale salir', cls = 'go';
  if (sc < 65) { badge = 'Si estás cerca'; cls = 'maybe'; }
  if (S.day === 2) { badge = 'Todavía no'; cls = 'maybe'; }
  if (night) { badge = 'De noche: no'; cls = 'no'; }

  let late = '';
  if (nowH >= 0 && nowH > p.h) late = `<b>El pico ya pasó</b> (${hm(p.h)}). No salgas ahora.`;
  else if (nowH >= 0 && dist >= 15 && nowH + 0.25 >= leave) late = `<b>Si vas, salí ya:</b> llegás a eso de las ${hm(nowH + drive + 0.25)}.`;

  const moveTxt = hasMove
    ? `<b>Hacia dónde van:</b> vienen del <b>${from}</b> y van hacia el <b>${to}</b> a unos <b>${mspd} km/h</b>.${mspd >= 50 ? ' <b>Son rápidas:</b> no las persigas por detrás, dejá que vengan hacia vos.' : ''}`
    : '<b>Hacia dónde van:</b> en general vienen del oeste/noroeste y van hacia el este/sudeste.';

  const warn = [];
  if (night) warn.push('El pico es <b>de noche</b>: no persigas. Mirá el radar desde un lugar techado.');
  if (S.day === 2) warn.push('Confianza baja: <b>no armes el viaje todavía</b>, volvé a mirar mañana.');
  if (S.day === 1) warn.push('Confianza media: revisá el plan mañana a la mañana antes de salir.');
  if (sc < 65) warn.push('Potencial moderado: vale si estás cerca. Lo más probable es ver tormentas fuertes, no tornados.');
  if (late) warn.unshift(late);
  const warnHtml = warn.length ? `<div class="pwarn">${warn.map((w) => `<p>⚠️ ${w}</p>`).join('')}</div>` : '';
  const foot = '<p class="muted">Es un plan orientativo armado con el pronóstico: el lugar exacto lo define la tormenta el mismo día. Guiate por el radar y los avisos del SMN.</p>';

  if (night) {
    const steps = [
      `Las tormentas pueden arrancar desde las <b>${hm(start)}</b> y el pico es a las <b>${hm(p.h)}</b>, con el sol ya puesto (${hm(sunset)}).`,
      '<b>No salgas a perseguir:</b> de noche los tornados no se ven y acá muchos vienen envueltos en lluvia.',
      'Si estás en la zona, quedate en un <b>lugar techado y firme</b> (no en el auto) y seguí el radar y los avisos del SMN.',
      moveTxt,
    ];
    el.innerHTML = head(badge, cls, `${dz ? `Zona ${esc(dz.name)} · ` : ''}ir hacia <b>${esc(t.name)}</b> · potencial ${sc}`) + warnHtml
      + `<ol class="psteps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>` + foot;
    return;
  }

  // Tu día, hora por hora.
  const station = `<a href="${mapsNear('estación de servicio', t)}" target="_blank" rel="noopener">una estación de servicio de ${esc(t.name)}</a>`;
  const rows = [];
  if (leave >= 11) rows.push(['10:00', 'Mirá el panel: ¿sigue en “Vale salir”? ¿Hay avisos del SMN en la zona?']);
  if (leave >= 12.5) rows.push(['12:00', 'Decidí si vas. Si el puntaje bajó mucho o el plan cambió de zona, no vayas.']);
  if (dist >= 15) rows.push([hm(leave), `<b>Salí</b> desde ${esc(S.origin.label)} hacia ${esc(t.name)} (${dist} km, ~${drive.toFixed(1)} h). Tanque lleno y celular cargado.`]);
  rows.push([hm(arrive), dist >= 15 ? `<b>Llegá</b> a ${station}. Baño, comida y nafta.` : `<b>Estás en la zona:</b> esperá en ${station}. Baño, comida y nafta.`]);
  rows.push([`${hm(start)}–${hm(p.h)}`, `Mirá el radar <b>cada 10 minutos</b>. Buscá una tormenta <b>aislada</b> que crezca rápido, hacia el ${from}.`]);
  rows.push(['Cuando aparece', `Mirá en la animación hacia dónde va. Acercate hasta quedar a <b>~20 km</b>, del lado <b>${side}</b> (mirá el dibujo).`]);
  rows.push(['Mirando', `Buscá la base oscura y baja, y si gira. Si en el radar se te acerca, movete hacia el <b>${side}</b>.`]);
  rows.push([hm(sunset), '<b>Se pone el sol: volvé</b>, aunque la tormenta siga.']);

  el.innerHTML = head(badge, cls, `${dz ? `Zona ${esc(dz.name)} · ` : ''}ir hacia <b>${esc(t.name)}</b> · potencial ${sc}`) + warnHtml
    + `<h3 class="ptitle">Tu día, hora por hora</h3>`
    + `<table class="daytable"><tbody>${rows.map(([h, x]) => `<tr><td>${h}</td><td>${x}</td></tr>`).join('')}</tbody></table>`
    + (dist < 15 ? '' : `<div class="pbtns"><a class="go" href="${mapsDir(S.origin, t)}" target="_blank" rel="noopener">Ruta a ${esc(t.name)} →</a></div>`)
    + `<h3 class="ptitle">Dónde pararte</h3>
      <div class="dwrap">${stormDiagram(hasMove ? mdir : 100)}
        <ul>
          <li>${moveTxt}</li>
          <li><b>Vos</b> (verde): adelante y al costado, del lado <b>${side}</b>, a unos 20 km. Desde ahí se ve la base y entra el aire cálido.</li>
          <li><b>Granizo y lluvia</b> (violeta y celeste): del lado <b>${hail}</b>. No te metas ahí.</li>
          <li><b>Rotación</b> (rojo): atrás, del lado ${side}. En el hemisferio sur gira en sentido <b>horario</b>.</li>
          <li><b>Escape</b>: hacia el <b>${side}</b>, por ruta asfaltada. <b>Nunca</b> te pongas en su camino (al ${to} de la tormenta).</li>
          ${hasMove ? '' : '<li class="muted">Sin dato de movimiento: el dibujo usa la dirección típica.</li>'}
        </ul>
      </div>`
    + `<div class="pcols">
        <div><h3>Llevá</h3><ul><li>Tanque lleno y celular cargado (cargador en el auto)</li><li>Mapas de la zona descargados sin conexión</li><li>Agua, algo para comer y un acompañante</li></ul></div>
        <div><h3>Volvé si…</h3><ul><li>Empieza a caer granizo o no ves nada por la lluvia</li><li>El SMN emite aviso a muy corto plazo justo donde estás</li><li>Se hace de noche o la ruta se inunda</li></ul></div>
        <div><h3>Nunca</h3><ul><li>Caminos de tierra con lluvia</li><li>Entrar al núcleo oscuro del radar</li><li>Parar debajo de un puente</li></ul></div>
      </div>` + foot;
}

/* ---------------- Guía (dibujos fijos) ---------------- */
$('#guide-diagram').innerHTML = stormDiagram(90);
$('#radar-shapes').innerHTML = radarShapes();

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
  queueMicrotask(renderSafety);
  const el = $('#smn'), d = S.smn;
  smnLayer.clearLayers();
  if (!d || !d.ok) {
    el.className = 'card smn';
    el.innerHTML = `<div class="smnhead"><h2>Avisos oficiales SMN</h2></div>
      <p class="muted">No se pudieron leer automáticamente${d?.error ? ` (${esc(d.error)})` : ''}. Revisalos en
      <a href="https://www.smn.gob.ar/alertas" target="_blank" rel="noopener">smn.gob.ar/alertas</a>.</p>`;
    return;
  }
  // El SMN emite un aviso por zona: los agrupamos por tipo + nivel.
  const groups = new Map();
  for (const a of d.alerts) {
    const [c, lbl, rank] = a.shortTerm ? ['#ff3b5c', 'Aviso a corto plazo', -1] : alertColor(a);
    const mine = a.areas.some((ar) => ar.polygons.some((p) => inPoly([S.origin.lat, S.origin.lon], p)));
    for (const ar of a.areas) for (const p of ar.polygons)
      L.polygon(p, { pane: 'smn', color: c, weight: a.shortTerm ? 3 : 1.5, fillColor: c, fillOpacity: a.shortTerm ? 0.25 : 0.12, dashArray: a.shortTerm ? null : '4 4' })
        .bindTooltip(`<b>${esc(a.event || a.headline)}</b><br>${esc(ar.desc)}<br>${esc(lbl)} · hasta ${a.expires ? fmt(a.expires) : '–'}`).addTo(smnLayer);
    const key = `${lbl}|${a.event || a.headline}`;
    const g = groups.get(key) || { c, lbl, rank, event: a.event || a.headline, zones: [], mine: false, expires: 0, desc: a.description, instruction: a.instruction };
    g.zones.push(...a.areas.map((x) => x.desc).filter(Boolean));
    g.mine ||= mine;
    g.expires = Math.max(g.expires, Date.parse(a.expires) || 0);
    groups.set(key, g);
  }
  const gs = [...groups.values()].sort((x, y) => x.rank - y.rank || y.mine - x.mine || y.zones.length - x.zones.length);
  const upd = `actualizado ${fmt(d.fetched, { hour: '2-digit', minute: '2-digit' })}`;
  if (!gs.length) {
    el.className = 'card smn none';
    el.innerHTML = `<div class="smnhead"><h2>✅ Sin avisos oficiales del SMN en el Pasillo</h2><span class="muted">${upd}</span></div>`;
    return;
  }
  const short = gs.some((g) => g.rank < 0);
  el.className = 'card smn' + (short ? ' hot' : '');
  const zonesTxt = (z) => { const u = [...new Set(z)]; return esc(u.slice(0, 6).join(' · ')) + (u.length > 6 ? ` <b>+${u.length - 6} zonas</b>` : ''); };
  el.innerHTML = `<div class="smnhead"><h2>${short ? '🚨' : '⚠️'} Avisos oficiales SMN</h2><span class="muted">${d.alerts.length} zonas · ${upd}</span></div>` +
    gs.map((g) => `
      <details class="al ${g.mine ? 'mine' : ''}" style="--c:${g.c}" ${g.rank < 0 ? 'open' : ''}>
        <summary><span class="tag">${esc(g.lbl)}</span><b>${esc(g.event)}</b> ${new Set(g.zones).size ? `<span class="cnt">${new Set(g.zones).size === 1 ? '1 zona' : new Set(g.zones).size + ' zonas'}</span>` : ''}${g.mine ? ' · <u>incluye tu zona</u>' : ''}</summary>
        <small>${zonesTxt(g.zones)}</small>
        ${g.expires ? `<small>Hasta ${fmt(new Date(g.expires).toISOString())}</small>` : ''}
        ${g.desc ? `<p>${esc(g.desc)}</p>` : ''}${g.instruction ? `<p>${esc(g.instruction)}</p>` : ''}
      </details>`).join('');
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
  $$('#tabs button[data-t]').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
  for (const k of ['map', 'windy']) $('#tab-' + k).hidden = k !== t;
  $('#layers').style.visibility = $('#timebar').style.visibility = t === 'map' ? 'visible' : 'hidden';
  if (t === 'map') map.invalidateSize();
}
$$('#tabs button[data-t]').forEach((b) => (b.onclick = () => showTab(b.dataset.t)));
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
  if (b.dataset.o === 'home') { stopGps(); return set({ ...HOME, label: 'Leones' }); }
  if (!navigator.geolocation) return alert('Tu navegador no da la ubicación.');
  b.textContent = '📍 Buscando…';
  stopGps();
  let first = true, last = null;
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      const o = { lat: p.coords.latitude, lon: p.coords.longitude, label: 'tu ubicación' };
      if (first) { first = false; b.textContent = '📍 Mi ubicación'; last = o; set(o); map.setView([o.lat, o.lon], 9); return; }
      // Mientras manejás: mover el punto y los círculos; recalcular distancias cada 2 km.
      S.origin = o; drawOrigin(); renderSafety();
      if (km(o, last) >= 2) { last = o; render(); }
    },
    (e) => {
      if (!first) return; // ya teníamos ubicación: seguimos esperando la próxima
      b.textContent = '📍 Mi ubicación'; stopGps();
      alert(e.code === 1 ? 'No diste permiso para usar la ubicación.' : 'No se pudo obtener la ubicación.');
    },
    { enableHighAccuracy: true, maximumAge: 30000 });
}));


/* ---------------- Lluvia pronosticada (modelo WRF del SMN, 4 km) ---------------- */
// Imágenes tipo radar por hora generadas en GitHub Actions (scripts/build-wrf.py).
let wrf = null, wrfOverlay = null;
async function loadWrf() {
  try { wrf = await getJson('data/wrf/meta.json'); } catch { wrf = null; }
  renderWrf();
}
function renderWrf() {
  const leg = $('#rainlegend');
  if (!S.layers.lluvia || !S.data) { wrfOverlay?.remove(); leg.hidden = true; return; }
  leg.hidden = false;
  if (!wrf) { wrfOverlay?.remove(); $('#raintxt').textContent = 'Lluvia SMN: todavía no hay datos del modelo'; return; }
  const date = curDate(), key = `${date}T${pad(S.hour)}`;
  const file = S.max ? wrf.max?.[date] : wrf.hours.includes(key) ? `${key}.png` : null;
  const run = `${wrf.run.slice(11, 13)} UTC del ${+wrf.run.slice(8, 10)}/${+wrf.run.slice(5, 7)}`;
  if (!file) { wrfOverlay?.remove(); $('#raintxt').textContent = `Lluvia SMN: sin pronóstico para ${S.max ? 'este día' : `las ${S.hour} h`}`; return; }
  const url = `data/wrf/${file}?r=${encodeURIComponent(wrf.run)}`;
  if (!wrfOverlay) wrfOverlay = L.imageOverlay(url, wrf.bounds, { pane: 'radar', opacity: 0.8, interactive: false });
  else wrfOverlay.setUrl(url);
  wrfOverlay.addTo(map);
  $('#raintxt').innerHTML = `<b>Lluvia pronosticada</b> ${S.max ? '(lo más fuerte del día)' : `a las ${S.hour} h`} · modelo SMN, corrida ${run}`;
}

/* ---------------- Zonas de caza ---------------- */
// Círculo alrededor de la zona con más potencial (y una segunda si está lejos de la primera).
const zoneLayer = L.layerGroup().addTo(map);
function huntZones() {
  const date = curDate();
  const cells = S.data.grid.pts.map(([lat, lon], k) => ({ lat, lon, v: pick(S.data.grid.score[k], date).v }));
  return findZones(cells, S.data.towns);
}
function renderZones() {
  zoneLayer.clearLayers();
  if (!S.layers.zonas) return;
  (S.zones ?? []).forEach((z, n) => {
    const lv = level(z.v);
    const tip = `<b>Zona ${esc(z.name)}</b> · máximo ${z.v} (${lv.label.toLowerCase()})<br>Según el pronóstico, adentro de este círculo (~${Math.round(z.r)} km) es donde más chances hay de supercélulas con rotación. El lugar exacto lo define la tormenta el mismo día.<br><i>El ${z.v} es el punto más fuerte del círculo. Los pueblos de la lista tienen su propio puntaje, que puede ser menor si no están justo en ese punto.</i>`;
    L.circle([z.ctr.lat, z.ctr.lon], { pane: 'smn', radius: z.r * 1000, color: lv.color, weight: n ? 2 : 3, dashArray: '10 7', fillColor: lv.color, fillOpacity: 0.06 })
      .bindTooltip(tip, { sticky: true }).addTo(zoneLayer);
    // Etiqueta arriba del círculo; la de la segunda zona, abajo, para que no se pisen.
    L.marker([z.ctr.lat + (n ? -1 : 1) * (z.r / 111.2), z.ctr.lon], { pane: 'smn', interactive: false, icon: L.divIcon({ className: 'zonelabel' + (n ? ' below' : ''), html: `<span style="--c:${lv.color}">Zona ${esc(z.name)} · máx ${z.v}</span>`, iconSize: null }) }).addTo(zoneLayer);
  });
}

loadForecast(); loadSmn(); loadRadar(); loadWrf();

// Pestaña Windy: CAPE o radar (Windy tiene acceso a los radares del SMN).
$$('#windysw button').forEach((b) => (b.onclick = () => {
  $$('#windysw button').forEach((x) => x.classList.toggle('on', x === b));
  const f = $('#windyframe'), o = b.dataset.o;
  f.src = f.src.replace(/overlay=\w+/, 'overlay=' + o).replace(/zoom=\d+/, 'zoom=' + (o === 'radar' ? 7 : 6));
  $('#windyopen').href = `https://www.windy.com/-32.660/-62.300?${o},-32.660,-62.300,7`;
}));
setInterval(loadRadar, 5 * 60e3);
setInterval(() => { loadSmn(); }, 10 * 60e3);
setInterval(() => { loadForecast(); loadWrf(); }, 60 * 60e3);
