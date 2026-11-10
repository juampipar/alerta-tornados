import { HOME, POINTS, buildDataset, level, scoreColor, verdict, km, driveHours, sunsetHour, rumbo, huntZones as findZones, goTo, viewpoint, routeCheck, safeLeave, placeName, movePoint, huntOptions, ruralStop, plainKey, bearingTo, coreAt } from './lib/risk.mjs';
import { stormDiagram, radarShapes } from './lib/diagram.mjs';
import { loadHistory } from './lib/historial-ui.mjs';
import { initRed, setRedLayer } from './lib/red.mjs';
import { shiftZone, zoneWindow, correctedWindow } from './lib/sesgo.mjs';
import { zoneAgreement, widenWindow } from './lib/modelos.mjs';
import { featureRow, predict } from './lib/entrenar.mjs';
import { amenazas, valeAvisar, NIVEL, mejorIntercepcion } from './lib/tormenta.mjs';

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
  origin: { ...HOME, label: 'Leones', fallback: true }, // respaldo hasta que el usuario elija desde dónde sale
  layers: { zonas: true, smn: true, red: true, nucleos: true, lluvia: false, radar: false, sat: false, ir: false }, // RainViewer casi no cubre el centro de Argentina: apagado de entrada
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
    .bindTooltip(S.origin.fallback ? 'Leones (elegí desde dónde salís)' : `Salís desde ${esc(S.origin.label)}`).addTo(map);
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
  if (k === 'nucleos') { renderNowcast(); renderIntercept(); }
  if (k === 'smn') on ? smnLayer.addTo(map) : smnLayer.remove();
  if (k === 'red') setRedLayer(on);
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
  // Hoy: solo las horas que faltan (desde la hora actual).
  const now = nowArt(), from = date === now.date ? `${now.date}T${pad(now.hour)}:00` : '';
  return S.data.times.flatMap((t, i) => {
    const h = +t.slice(11, 13);
    return ((t.startsWith(date) && h >= WINDOW[0]) || (t.startsWith(nd) && h <= WINDOW[1])) && t >= from ? [i] : [];
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



/* ---------------- Plan fijado ---------------- */
// Guarda la opción elegida para que no cambie con cada actualización del pronóstico.
// Solo avisa si pasa algo que de verdad justifica cambiar.
const PIN_KEY = 'planFijado';
const loadPin = () => { try { return JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); } catch { return null; } };
const savePin = (p) => { try { p ? localStorage.setItem(PIN_KEY, JSON.stringify(p)) : localStorage.removeItem(PIN_KEY); } catch { /* sin almacenamiento */ } };
function pinOption(o) {
  savePin({ date: curDate(), ctr: o.z.ctr, name: o.z.name, v: o.z.v, peakH: o.peakH, vp: o.vp, stop: o.stop, at: nowDec().h });
  render();
}
// Recalcula distancia y horarios hacia la parada fijada.
function retarget(o, pin) {
  const vp = pin.vp, dist = Math.round(km(S.origin, vp)), drive = driveHours(dist);
  const nd = nowDec(), nowH = nd.date === curDate() ? nd.h : null;
  let leave = Math.max(11, o.peakH - 2) - 1 - drive, late = false;
  if (nowH != null && leave < nowH) { leave = nowH; late = true; }
  const hit = o.mspd != null ? routeCheck(S.origin, vp, o.z, o.mdir, o.mspd, leave, o.peakH) : null;
  return { ...o, vp, stop: pin.stop, dist, drive, leave, late, arriveAt: leave + drive, reachable: leave + drive <= o.peakH + 0.5, hit, safe: null };
}
// Aplica el plan fijado: lo pone primero y arma los avisos de "vale cambiar".
function applyPin(opts) {
  const pin = loadPin();
  S.pin = null;
  if (!pin) return opts;
  if (pin.date < nowDec().date) { savePin(null); return opts; } // plan de un día que ya pasó
  if (pin.date !== curDate()) return opts;
  const k = opts.findIndex((o) => km(o.z.ctr, pin.ctr) <= 90);
  const alerts = [];
  let mine = null;
  if (k >= 0) {
    mine = retarget(opts[k], pin);
    opts = [mine, ...opts.filter((_, j) => j !== k)];
    const moved = Math.round(km(pin.ctr, mine.z.ctr));
    if (mine.z.v < 45) alerts.push(['bad', `Tu zona bajó a <b>${mine.z.v}</b>: ya no da. Mirá las otras opciones.`]);
    const better = opts.slice(1).find((o) => o.reachable && o.z.v >= mine.z.v + 10);
    if (better) alerts.push(['bad', `Hay otra zona <b>10+ puntos mejor</b> a la que llegás: Zona ${esc(better.z.name)} (${better.z.v}). Vale pensar en cambiar.`]);
    if (moved >= 25 && mine.z.v >= 45) alerts.push(['info', `La zona se corrió ~${moved} km al ${rumbo(bearingTo(pin.ctr, mine.z.ctr))}. Es normal: no hace falta cambiar de parada.`]);
  } else {
    alerts.push(['bad', `Tu zona (${esc(pin.name)}) <b>ya no aparece</b> en el pronóstico: bajó de 45. Mirá las otras opciones o seguí el radar.`]);
  }
  // Avisos a corto plazo del SMN: ¿en tu zona o en otro lado?
  const acp = (S.smn?.alerts ?? []).filter((a) => a.shortTerm);
  const nearZone = (a, c, r) => a.areas.some((ar) => ar.polygons.some((p) => distToPoly(c, p) <= r));
  if (acp.length) {
    if (acp.some((a) => nearZone(a, pin.ctr, 80))) alerts.unshift(['go', '🚨 <b>Se están formando en tu zona</b> (aviso a corto plazo del SMN). Mirá el radar y acercate con cuidado.']);
    else {
      const other = opts.find((o) => o !== mine && acp.some((a) => nearZone(a, o.z.ctr, 60)));
      if (other) alerts.unshift(['bad', `🚨 <b>Se están formando en otra zona</b>: Zona ${esc(other.z.name)}. Si te queda a mano, vale cambiar.`]);
    }
  }
  S.pin = { ...pin, found: k >= 0, alerts };
  return opts;
}
function pinBanner() {
  if (!S.pin) return '';
  const p = S.pin, ok = !p.alerts.some(([c]) => c === 'bad' || c === 'go');
  return `<div class="pinbox ${ok ? 'ok' : 'warn'}">
    <p>📌 <b>Plan fijado</b> a las ${hm(p.at)}: Zona ${esc(p.name)} · parada ${p.stop ? esc(p.stop.label) : 'punto aproximado'}.${ok ? ' <b>Sin cambios importantes: seguí con tu plan.</b>' : ''}</p>
    ${p.alerts.map(([c, t]) => `<p class="pin-${c}">${t}</p>`).join('')}
    <button class="chip" id="unpin">Soltar plan</button>
  </div>`;
}

/* ---------------- Opciones: dónde parar ---------------- */
// Hora actual (Argentina) con minutos.
const nowDec = () => { const d = new Date(Date.now() - 3 * 3600e3); return { date: d.toISOString().slice(0, 10), h: d.getUTCHours() + d.getUTCMinutes() / 60 }; };
// Paradas encontradas (estación de servicio o pueblo), guardadas también en el navegador.
const stopCache = new Map();
// Paradas rurales (sobre ruta asfaltada, afuera de los pueblos). false = se buscó y no hay.
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('stopsR') || '{}'))) stopCache.set(k, v); } catch { /* sin almacenamiento */ }
const stopPending = new Set();
function buildOptions(date) {
  const now = nowDec();
  return huntOptions(dayZones(date, 4), S.data.towns, S.data.times, date, S.origin, (b) => stopCache.get(plainKey(b)) || null, date === now.date ? now.h : null);
}
// Busca las paradas que falten y vuelve a dibujar cuando llegan.
async function fetchStops() {
  const miss = (S.opts ?? []).filter((o) => !stopCache.has(plainKey(o.base)) && !stopPending.has(plainKey(o.base)));
  if (!miss.length) return;
  for (const o of miss) {
    const k = plainKey(o.base);
    stopPending.add(k);
    const st = await ruralStop(o.base, (o.mdir - 90 + 360) % 360);
    stopPending.delete(k);
    stopCache.set(k, st || false);
    try { localStorage.setItem('stopsR', JSON.stringify(Object.fromEntries([...stopCache].slice(-80)))); } catch { /* sin almacenamiento */ }
  }
  render();
}
const stopTxt = (o) => (o.stop ? `${o.stop.kind === 'rural' ? '🌾 ' : ''}<b>${esc(o.stop.label)}</b>` : '<b>punto aproximado</b>');
const timeTxt = (o) => !o.reachable ? `<span class="owarn">no llegás antes del pico (${hm(o.peakH)})</span>`
  : o.late ? `<b>salí ya</b>: llegás ~${hm(o.arriveAt)}` : `salir a las <b>${hm(o.leave)}</b>`;
const routeTxt = (o) => o.hit ? `<span class="owarn">⚠️ el camino cruza el paso de las tormentas (~${hm(o.hit.h)}): entrá por el ${rumbo(o.mdir - 90)}</span>`
  : o.mspd != null && o.reachable ? '<span class="ook">✅ el camino no cruza por delante</span>' : '';
// Ingredientes de la zona: el pueblo más cercano a la hora pico.
const ingAt = (t, i) => ({ cape: t.cape[i], shear: t.shear[i], ll: t.ll[i], srh: t.srh?.[i], lcl: t.lcl?.[i], td: t.td[i], cin: t.cin[i], li: t.li[i] });

// Pueblo al que ir: el de la zona de caza principal (o el de más puntaje si no hay zona).
const target = (rank) => (S.zones?.[0] ? goTo(S.zones[0], rank) : rank[0]);
function renderHero(rank) {
  if (!rank[0]) { $('#hero').textContent = 'Sin datos para este día.'; return; }
  const o = S.opts?.[0], day = ['hoy', 'mañana', 'pasado mañana'][S.day];
  const confLbl = { alta: 'Pronóstico confiable', media: 'Pronóstico más o menos confiable', baja: 'Pronóstico poco confiable' }[conf(S.day).k] ?? `Confianza ${conf(S.day).k}`;
  const confHtml = `<span class="conf conf-${conf(S.day).k}" title="Qué tan seguro es el pronóstico (no si vale salir)">${confLbl}</span>`;
  if (!o) {
    const b = rank[0], lv = level(b.score);
    $('#hero').innerHTML = `
    <div class="gauge" style="--v:${b.score};--c:${lv.color}"><span>${b.score}<small>${lv.label}</small></span></div>
    <div>
      <div class="kicker">Sin zona de caza · ${day} ${confHtml}</div>
      <h2>${S.day === 0 ? 'Hoy' : day[0].toUpperCase() + day.slice(1)} no da</h2>
      <p class="verdict">${verdict(b.score)}</p>
      <p class="sub"><b>No vale salir.</b> Lo mejor es ${esc(b.t.name)} con ${b.score}${S.day === 0 ? ' en lo que queda del día' : ''}.${conf(S.day).k === 'alta' ? ' El pronóstico es confiable: es muy probable que hoy no pase nada importante.' : conf(S.day).k === 'baja' ? ' Igual falta mucho: el pronóstico puede cambiar.' : ''}</p>
    </div>
    <p class="mlegend">Ingredientes en <b>${esc(b.t.name)}</b>:</p>
    <div class="metrics">${metricsHtml(b)}</div>
`;
    return;
  }
  const lv = level(o.z.v);
  $('#hero').innerHTML = `
    <div class="gauge" style="--v:${o.z.v};--c:${lv.color}"><span>${o.z.v}<small>${lv.label}</small></span></div>
    <div>
      ${pinBanner()}
      <div class="kicker">${S.pin?.found ? 'Tu plan' : 'Mejor opción'} · ${day} ${confHtml}</div>
      <h2>Zona ${esc(o.z.name)}</h2>
      <p class="verdict">${verdict(o.z.v)}</p>
      <p class="sub">👁 Parar en ${stopTxt(o)} (${vpSpan(o.vp)})</p>
      <p class="sub">Pico <b>${hm(o.peakH)}</b>${ventTxt(o)} · ${o.dist} km desde ${esc(S.origin.label)} (~${o.drive.toFixed(1)} h) · ${timeTxt(o)}</p>
      ${modelsTxt(o)}
      ${trainedTxt(o)}
      ${biasTxt()}
      ${routeTxt(o) ? `<p class="sub">${routeTxt(o)}</p>` : ''}
      <p class="sub conftxt">${conf(S.day).txt}</p>
      <div class="pbtns"><a class="go" href="${dirLink(o.vp.lat, o.vp.lon)}" target="_blank" rel="noopener">Ruta a la parada →</a> ${S.pin?.found ? '' : '<button class="chip pinbtn" data-k="0">📌 Fijar este plan</button>'} <a class="chip" href="#plan">Plan hora por hora ↓</a></div>
    </div>
    <p class="mlegend">Ingredientes de la zona (en ${esc(o.town.name)} a las ${hm(o.peakH - (o.z.dt ?? 0))}, según el modelo):</p>
    <div class="metrics">${metricsHtml(ingAt(o.town, o.i))}</div>
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
  const opts = S.opts ?? [];
  $('#rankinfo').textContent = opts.length
    ? `Dónde parar ${S.day === 0 ? 'con lo que queda del día' : ''}: primero las que llegás a tiempo · desde ${S.origin.label}`
    : `Sin zonas de caza ${S.day === 0 ? 'en lo que queda del día' : 'este día'}.`;
  const optHtml = opts.map((o, k) => {
    const c = level(o.z.v).color;
    return `<li class="optrow${o.reachable ? '' : ' dim'}" style="--c:${c}">
      <div class="ohead"><span class="sc" style="background:${c}">${o.z.v}</span><b>${k + 1}. Zona ${esc(o.z.name)}</b></div>
      <p>👁 ${stopTxt(o)} · ${vpSpan(o.vp)}</p>
      <p>Pico <b>${hm(o.peakH)}</b>${ventTxt(o)}${modelsTxt(o, true)} · ${o.dist} km (~${o.drive.toFixed(1)} h) · ${timeTxt(o)}</p>
      ${routeTxt(o) ? `<p>${routeTxt(o)}</p>` : ''}
      <div class="pbtns"><a class="go" href="${dirLink(o.vp.lat, o.vp.lon)}" target="_blank" rel="noopener">Ruta →</a> <button class="chip optshow" data-k="${k}">Ver en el mapa</button> ${S.pin?.found && k === 0 ? '<span class="pintag">📌 fijado</span>' : `<button class="chip pinbtn" data-k="${k}">📌 Fijar</button>`}</div>
    </li>`;
  }).join('');
  const shown = S.all ? rank : rank.slice(0, 10);
  const towns = shown.map((r, k) => {
    const lv = level(r.score);
    return `<li class="row" data-k="${k}">
      <span class="sc" style="background:${lv.color}">${r.score}</span>
      <span><span class="nm">${esc(r.t.name)}</span>${S.zones?.some((z) => km(r.t, z.ctr) <= z.r) ? ' <span class="inzone" title="Dentro de una zona de caza">🎯</span>' : ''} <small>${r.dist} km · ~${driveHours(r.dist).toFixed(1)} h · ${S.max ? 'pico ' : ''}${r.hour} · CAPE ${fx('cape', r.cape)} · cizalla ${fx('shear', r.shear)}/${fx('ll', r.ll)} · base ${fx('lcl', r.lcl)} m</small></span>
      <a class="go" href="${dirLink(r.t.lat, r.t.lon)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ir</a>
      ${spark(r.t)}
    </li>`;
  }).join('') + (rank.length > 10 ? `<li><button class="chip more" id="more">${S.all ? 'Ver menos' : `Ver los ${rank.length}`}</button></li>` : '');
  $('#list').innerHTML = optHtml + `<li class="townsbox"><details id="townsd" ${S.townsOpen ? 'open' : ''}><summary>Puntaje por pueblo (${S.max ? 'máximo' : `a las ${S.hour} h`})</summary><ol class="towns">${towns}</ol></details></li>`;
  $('#townsd').ontoggle = (e) => { S.townsOpen = e.target.open; };
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
  $('#days').innerHTML = labels.map((l, i) => `<button data-d="${i}" class="${i === S.day ? 'on' : ''}" title="Pronóstico: confianza ${conf(i).k}">${l[0].toUpperCase() + l.slice(1)}<i class="cdot conf-${conf(i).k}" aria-hidden="true"></i></button>`).join('');
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
  S.opts = applyPin(buildOptions(curDate()));
  S.zones = S.opts.map((o) => o.z); // los círculos del mapa siguen el plan del día (no rotan con la hora)
  S.vp = S.opts[0]?.vp ?? null;
  renderGrid(); renderTowns(rank); renderHero(rank); renderPlan(); renderList(rank);
  renderTimebar(); renderSafety(); renderZones(); renderWrf(); fillPlace();
  const fly = (p) => { showTab('map'); map.flyTo([p.lat, p.lon], 10); $('.mapcard').scrollIntoView({ behavior: 'smooth' }); };
  $$('.optshow').forEach((x) => (x.onclick = (e) => { e.stopPropagation(); fly(S.opts[+x.dataset.k].vp); }));
  $$('.pinbtn').forEach((x) => (x.onclick = (e) => { e.stopPropagation(); pinOption(S.opts[+x.dataset.k]); }));
  if ($('#unpin')) $('#unpin').onclick = () => { savePin(null); render(); };
  fetchStops();
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

// Nombre del 👁 punto para mirar (pueblo/paraje y ruta), con caché.
const placeCache = new Map();
async function fillPlace() {
  for (const e of $$('.vpname[data-ll]')) {
    const key = e.dataset.ll, [lat, lon] = key.split(',').map(Number);
    if (!placeCache.has(key)) placeCache.set(key, placeName({ lat, lon }));
    placeCache.get(key).then((n) => { if (n && e.isConnected) e.textContent = `cerca de ${n.place}${n.road ? `, ${n.road}` : ''}`; });
  }
}
const vpSpan = (vp) => `<span class="vpname" data-ll="${vp.lat.toFixed(2)},${vp.lon.toFixed(2)}">${vp.lat.toFixed(2)}, ${vp.lon.toFixed(2)}</span>`;
// Zonas de caza con el máximo del día (de 11 a 2 h), sin importar el control de hora.
function dayZones(date, max = 2) {
  const idx = windowIdx(date);
  const cells = S.data.grid.pts.map(([lat, lon], k) => {
    let v = 0, i = idx[0];
    for (const j of idx) if ((S.data.grid.score[k][j] ?? 0) > v) { v = S.data.grid.score[k][j]; i = j; }
    return { lat, lon, v, i };
  });
  // Ventana de horas con la zona del modelo; después, la corrección aprendida del historial (zona y hora).
  const hourOf = (j) => { const t = S.data.times[j]; return +t.slice(11, 13) + (t.startsWith(date) ? 0 : 24); };
  return findZones(cells, S.data.towns, max).map((z) => {
    const w = zoneWindow(z, S.data.grid.pts, S.data.grid.score, idx, hourOf);
    const dt = S.bias?.aplicado ? S.bias.horas : 0;
    const acuerdo = zoneAgreement(S.mod, z.ctr, z.r, date); // GFS, ICON y ECMWF por separado
    return { ...shiftZone(z, S.bias), ventana: widenWindow(correctedWindow(w, S.bias), acuerdo, dt), dt, acuerdo };
  });
}
// Modelo entrenado con tornados de EE.UU. (solo si en la prueba le ganó al índice actual).
function trainedTxt(o) {
  const m = S.tmodel;
  if (!m?.mejora) return '';
  const v = Math.round(predict(m, featureRow(ingAt(o.town, o.i))) * 100);
  const n = (m.tornados_entrenamiento + m.tornados_prueba).toLocaleString('es-AR');
  return `<p class="sub">🧠 Parecido a ambientes de tornado de EE.UU.: <b>${v}/100</b> <small>(modelo entrenado con ${n} tornados reales; en la prueba con 2024 acertó más que el índice: ${m.auc_modelo} contra ${m.auc_indice})</small></p>`;
}
// Qué dice cada modelo de la zona y cuántos coinciden.
function modelsTxt(o, short = false) {
  const a = o.z.acuerdo;
  if (!a) return '';
  if (short) return ` · <span class="agree ${a.acuerdo}">${a.coinciden}/${a.total} modelos</span>`;
  const per = a.por_modelo.map((m) => `${m.modelo} <b>${m.v}</b>${m.v >= 45 ? ` (${hm(m.hora + (o.z.dt ?? 0))})` : ''}`).join(' · ');
  const txt = { alto: 'coinciden todos: zona confiable', medio: 'coinciden algunos', bajo: 'solo uno la ve: zona dudosa' }[a.acuerdo];
  return `<p class="sub">🧮 Modelos: ${per} → <span class="agree ${a.acuerdo}">${a.coinciden} de ${a.total} ${txt}</span></p>`;
}
const ventTxt = (o) => (o.z.ventana ? ` · ventana <b>${hm(o.z.ventana[0])}–${hm(o.z.ventana[1])}</b>` : '');
// Qué aprendió el panel de los días anteriores (zona y hora).
function biasTxt() {
  const b = S.bias;
  if (!b) return '';
  if (!b.aplicado) return `<p class="sub biasinfo">📚 Aprendiendo de los errores: ${b.dias_usados} de ${b.minimo} días con tormentas para empezar a corregir zona y hora.</p>`;
  const d = Math.round(Math.hypot(b.este_km, b.norte_km));
  const dir = d ? `${d} km al ${rumbo((Math.atan2(b.este_km, b.norte_km) * 180) / Math.PI)}` : 'sin corrimiento';
  const hr = Math.abs(b.horas) < 0.25 ? 'a la hora' : `${Math.abs(b.horas).toFixed(1).replace('.', ',')} h ${b.horas > 0 ? 'más tarde' : 'más temprano'}`;
  return `<p class="sub biasinfo">📚 Corregido con ${b.dias_usados} días: las tormentas aparecieron ${dir} y ${hr} de lo pronosticado. Zona y horas ya incluyen la corrección.</p>`;
}
function renderPlan() {
  const el = $('#plan');
  const date = curDate();
  const peaks = S.data.towns.map((t) => peakFor(t, date)).filter(Boolean).sort((a, b) => b.v - a.v || km(S.origin, a.t) - km(S.origin, b.t));
  // El plan es la opción 1 de "Dónde ir" (la mejor a la que llegás a tiempo).
  const o = S.opts?.[0], dz = o?.z;
  const p = o ? { t: o.town, i: o.i, h: o.peakH, v: o.z.v } : peaks[0];
  if (!p) { el.innerHTML = ''; return; }
  const sc = p.v;
  const t = p.t, dist = Math.round(km(S.origin, t)), drive = driveHours(dist);
  const dayTxt = ['hoy', 'mañana', 'pasado mañana'][S.day];
  const head = (badge, cls, title) => `<div class="planhead"><h2>Plan de caza · ${dayTxt}</h2><span class="pbadge ${cls}">${badge}</span></div><p class="plantitle">${title}</p>`;

  // ¿Vale la pena?
  if (sc < 45) {
    const other = dates().map((d, k) => ({ k, best: dayZones(d)[0]?.v ?? 0 })).filter((x) => x.k !== S.day && x.best >= 45);
    el.innerHTML = head('No salgas', 'no', `${dayTxt[0].toUpperCase() + dayTxt.slice(1)} no da: el máximo ${S.day === 0 ? 'de lo que queda del día' : 'del día'} es ${sc}. Faltan ingredientes para tormentas que giren.`)
      + (other.length ? `<p class="sub">Mirá ${other.map((x) => `<b>${['hoy', 'mañana', 'pasado mañana'][x.k]}</b>`).join(' y ')}: ahí sí hay potencial.</p>` : '<p class="sub">Ningún día de los próximos tres tiene potencial. Quedate tranquilo.</p>');
    return;
  }

  // Hoy y ya no llegás a ninguna zona antes de su pico: no armar un viaje.
  if (o && !o.reachable) {
    const tomorrow = S.day === 0 && dates()[1] ? (dayZones(dates()[1])[0]?.v ?? 0) : 0;
    el.innerHTML = head('Hoy ya no', 'no', `Las zonas de hoy tienen el pico antes de que llegues desde ${esc(S.origin.label)}. La más cerca: <b>Zona ${esc(dz.name)}</b>, pico ${hm(p.h)}, ${o.dist} km.`)
      + `<p class="sub">Si estás cerca de alguna zona, mirá el radar: puede armarse algo más tarde. ${tomorrow >= 45 ? `<b>Mañana hay potencial (${tomorrow})</b>: tocá “Mañana” arriba para ver el plan.` : ''}</p>`;
    return;
  }
  const sunset = sunsetHour(t.lat, t.lon, date);
  const start = Math.max(11, p.h - 2); // las tormentas suelen arrancar 1–2 h antes del pico
  const arrive = start - 1; // llegar 1 h antes para esperar tranquilo
  const leave = arrive - drive;
  const night = p.h >= sunset + 0.5;
  const nd = nowDec(), nowH = nd.date === date ? nd.h : -1;
  const mdir = o ? o.mdir : t.mdir?.[p.i], mspd = o ? o.mspd : t.mspd?.[p.i];
  const hasMove = mdir != null && mspd != null;
  const from = hasMove ? rumbo(mdir + 180) : 'oeste', to = hasMove ? rumbo(mdir) : 'este';
  const side = hasMove ? rumbo(mdir - 90) : 'norte'; // en el hemisferio sur: lado izquierdo de la trayectoria (entra el aire cálido)
  const hail = hasMove ? rumbo(mdir + 90) : 'sur';
  // 👁 Punto para mirar: al costado del camino de las tormentas, no la ciudad.
  const vp = o ? o.vp : null;
  const vdist = o ? o.dist : dist, vdrive = o ? o.drive : drive;
  const vleave = o ? o.leave : leave;
  const hit = o ? o.hit : null, safe = o ? o.safe : null;
  const vpTxt = o ? `${stopTxt(o)} (${vpSpan(vp)})` : esc(t.name);

  let badge = 'Vale salir', cls = 'go';
  if (sc < 65) { badge = 'Si estás cerca'; cls = 'maybe'; }
  if (S.day === 2) { badge = 'Todavía no'; cls = 'maybe'; }
  if (night) { badge = 'De noche: no'; cls = 'no'; }

  let late = '';
  if (o && !o.reachable) late = `<b>No llegás a tiempo</b> a ninguna zona para su pico. Mirá el radar por si se arma algo más cerca.`;
  else if (o?.late && vdist >= 15) late = `<b>Si vas, salí ya:</b> llegás a eso de las ${hm(o.arriveAt)}.`;

  const moveTxt = hasMove
    ? `<b>Hacia dónde van:</b> vienen del <b>${from}</b> y van hacia el <b>${to}</b> a unos <b>${mspd} km/h</b>.${mspd >= 50 ? ' <b>Son rápidas:</b> no las persigas por detrás, dejá que vengan hacia vos.' : ''}`
    : '<b>Hacia dónde van:</b> en general vienen del oeste/noroeste y van hacia el este/sudeste.';

  const warn = [];
  if (night) warn.push('El pico es <b>de noche</b>: no persigas. Mirá el radar desde un lugar techado.');
  if (S.day === 2) warn.push('Confianza baja: <b>no armes el viaje todavía</b>, volvé a mirar mañana.');
  if (S.day === 1) warn.push('Confianza media: revisá el plan mañana a la mañana antes de salir.');
  if (sc < 65) warn.push('Potencial moderado: vale si estás cerca. Lo más probable es ver tormentas fuertes, no tornados.');
  if (late) warn.unshift(late);
  if (hit && !o?.late) warn.unshift(safe != null
    ? `<b>Salí a las ${hm(safe)} o antes:</b> más tarde tu camino cruza el paso de las tormentas (cerca de las ${hm(hit.h)}). Si salís después, entrá por el <b>${side}</b>, sin cruzar por delante de ellas.`
    : `<b>Tu camino cruza el paso de las tormentas</b> cerca de las ${hm(hit.h)}: entrá por el <b>${side}</b>, sin cruzar por delante de ellas.`);
  const warnHtml = warn.length ? `<div class="pwarn">${warn.map((w) => `<p>⚠️ ${w}</p>`).join('')}</div>` : '';
  const foot = '<p class="muted">Es un plan orientativo armado con el pronóstico: el lugar exacto lo define la tormenta el mismo día. Guiate por el radar y los avisos del SMN.</p>';

  if (night) {
    const steps = [
      `Las tormentas pueden arrancar desde las <b>${hm(start)}</b> y el pico es a las <b>${hm(p.h)}</b>, con el sol ya puesto (${hm(sunset)}).`,
      '<b>No salgas a perseguir:</b> de noche los tornados no se ven y acá muchos vienen envueltos en lluvia.',
      'Si estás en la zona, quedate en un <b>lugar techado y firme</b> (no en el auto) y seguí el radar y los avisos del SMN.',
      moveTxt,
    ];
    el.innerHTML = head(badge, cls, `${dz ? `Zona ${esc(dz.name)} · ` : ''}potencial ${sc}`) + warnHtml
      + `<ol class="psteps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>` + foot;
    return;
  }

  // Tu día, hora por hora.
  const station = `<a href="${mapsNear('estación de servicio', t)}" target="_blank" rel="noopener">una estación de servicio de ${esc(t.name)}</a>`;
  const rows = [];
  const future = (h) => nowH < 0 || h > nowH; // hoy no mostrar pasos que ya pasaron
  if (vleave >= 11 && future(10)) rows.push(['10:00', 'Mirá el panel: ¿sigue en “Vale salir”? ¿Hay avisos del SMN en la zona?']);
  if (vleave >= 12.5 && future(12)) rows.push(['12:00', 'Decidí si vas. Si el puntaje bajó mucho o el plan cambió de zona, no vayas.']);
  if (o) {
    if (vdist >= 15) rows.push([o.late ? 'Ahora' : hm(vleave), `<b>Salí</b> desde ${esc(S.origin.label)} hacia ${vpTxt} (${vdist} km en línea recta, ~${vdrive.toFixed(1)} h). Tanque lleno y celular cargado.`]);
    const st = o.stop;
    if (st?.kind === 'rural' && st.pueblo) rows.push(['Antes', `Cargá nafta, baño y comida en <b>${esc(st.pueblo.name)}</b>. No esperes en el pueblo: ahí no se ve nada y cuando llega la tormenta cuesta salir.`]);
    rows.push([hm(o.arriveAt), `<b>Llegás a la parada</b>${st?.kind === 'rural' ? `: campo abierto sobre ruta asfaltada${st.cruce ? ', en un <b>cruce</b> (dos salidas)' : ''}${st.escape ? `, con salida hacia el <b>${side}</b> para alejarte` : ''}. Parate en una banquina ancha o una entrada de campo, sin cortar el paso.` : `. Es un punto aproximado: buscá cerca una ruta asfaltada con campo abierto, fuera del pueblo (no caminos de tierra).`} Mirá hacia el ${from}. ${hit ? '' : '✅ Con este horario el camino no cruza por delante de las tormentas.'}`]);
  } else {
    if (dist >= 15) rows.push([hm(leave), `<b>Salí</b> desde ${esc(S.origin.label)} hacia ${esc(t.name)} (${dist} km, ~${drive.toFixed(1)} h). Tanque lleno y celular cargado.`]);
    rows.push([hm(arrive), dist >= 15 ? `<b>Llegá</b> a ${station}. Baño, comida y nafta.` : `<b>Estás en la zona:</b> esperá en ${station}. Baño, comida y nafta.`]);
  }
  rows.push([`${hm(start)}–${hm(p.h)}`, `Mirá el radar <b>cada 10 minutos</b>. Buscá una tormenta <b>aislada</b> que crezca rápido, hacia el ${from}.`]);
  rows.push(['Cuando aparece', `Mirá en la animación hacia dónde va. Acercate hasta quedar a <b>~20 km</b>, del lado <b>${side}</b> (mirá el dibujo).`]);
  rows.push(['Mirando', `Buscá la base oscura y baja, y si gira. Si en el radar se te acerca, movete hacia el <b>${side}</b>.`]);
  rows.push([hm(sunset), '<b>Se pone el sol: volvé</b>, aunque la tormenta siga.']);

  el.innerHTML = head(badge, cls, `${o ? `Zona ${esc(dz.name)} · potencial ${sc} · pico ${hm(p.h)}<br><span class="sub">👁 Parar en ${vpTxt}</span>` : `ir hacia <b>${esc(t.name)}</b> · potencial ${sc}`}`) + warnHtml
    + `<h3 class="ptitle">Tu día, hora por hora</h3>`
    + `<table class="daytable"><tbody>${rows.map(([h, x]) => `<tr><td>${h}</td><td>${x}</td></tr>`).join('')}</tbody></table>`
    + (vp ? `<div class="pbtns"><a class="go" href="${mapsDir(S.origin, vp)}" target="_blank" rel="noopener">Ruta a la parada →</a> <button class="chip optshow" data-k="0">Ver en el mapa</button></div>
        <p class="muted">La parada queda a ~${Math.round(km(vp, dz.ctr))} km del centro de la zona, del lado <b>${side}</b>. Otras opciones: en “Dónde ir”. Antes de llegar fijate en el radar que la tormenta no esté ya ahí.</p>`
      : (dist < 15 ? '' : `<div class="pbtns"><a class="go" href="${mapsDir(S.origin, t)}" target="_blank" rel="noopener">Ruta a ${esc(t.name)} →</a></div>`))
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
  // El SMN emite un aviso por zona y no manda el nombre de la zona, solo su dibujo: los agrupamos por tipo + nivel
  // y decimos qué pueblos quedan adentro, cuándo rige y a qué distancia está de vos.
  const groups = new Map();
  const o = S.origin;
  const t0 = (a) => Date.parse(a.onset || a.effective || a.sent) || null;
  for (const a of d.alerts) {
    const [c, lbl, rank] = a.shortTerm ? ['#ff3b5c', 'Aviso a corto plazo', -1] : alertColor(a);
    const polys = a.areas.flatMap((ar) => ar.polygons);
    const mine = polys.some((p) => inPoly([o.lat, o.lon], p));
    for (const ar of a.areas) for (const p of ar.polygons)
      L.polygon(p, { pane: 'smn', color: c, weight: a.shortTerm ? 3 : 1.5, fillColor: c, fillOpacity: a.shortTerm ? 0.25 : 0.12, dashArray: a.shortTerm ? null : '4 4' })
        .bindTooltip(`<b>${esc(a.event || a.headline)}</b> · ${esc(lbl)}<br>${a.expires ? `hasta ${fmt(a.expires)}` : ''}`).addTo(smnLayer);
    const key = `${lbl}|${a.event || a.headline}`;
    const g = groups.get(key) || { c, lbl, rank, event: a.event || a.headline, polys: [], zonas: 0, names: new Set(), mine: false, desde: null, expires: 0, desc: a.description, instruction: a.instruction };
    g.polys.push(...polys);
    g.zonas += Math.max(1, a.areas.length);
    for (const ar of a.areas) if (ar.desc) g.names.add(ar.desc);
    g.mine ||= mine;
    const t = t0(a);
    if (t && (!g.desde || t < g.desde)) g.desde = t;
    g.expires = Math.max(g.expires, Date.parse(a.expires) || 0);
    groups.set(key, g);
  }
  // Pueblos del panel dentro de las zonas (o el más cercano) y distancia desde tu punto de salida.
  for (const g of groups.values()) {
    const pts = g.polys.flat();
    g.dist = g.mine ? 0 : pts.length ? Math.round(Math.min(...pts.map(([lat, lon]) => km(o, { lat, lon })))) : null;
    const inside = POINTS.filter((t) => g.polys.some((p) => inPoly([t.lat, t.lon], p))).map((t) => t.name);
    if (inside.length) g.donde = inside;
    else if (pts.length) {
      const c = { lat: pts.reduce((s, p) => s + p[0], 0) / pts.length, lon: pts.reduce((s, p) => s + p[1], 0) / pts.length };
      const t = POINTS.reduce((a, b) => (km(c, b) < km(c, a) ? b : a));
      g.donde = [`zona a ${Math.round(km(c, t))} km al ${rumbo(bearingTo(t, c))} de ${t.name}`];
    } else g.donde = [...g.names];
    const b = L.latLngBounds(pts);
    g.bounds = pts.length ? b : null;
  }
  const gs = [...groups.values()].sort((x, y) => x.rank - y.rank || y.mine - x.mine || (x.dist ?? 1e9) - (y.dist ?? 1e9));
  const upd = `actualizado ${fmt(d.fetched, { hour: '2-digit', minute: '2-digit' })}`;
  if (!gs.length) {
    el.className = 'card smn none';
    el.innerHTML = `<div class="smnhead"><h2>✅ Sin avisos oficiales del SMN en el Pasillo</h2><span class="muted">${upd}</span></div>`;
    return;
  }
  const short = gs.some((g) => g.rank < 0);
  const MEANS = {
    'Aviso a corto plazo': 'Tormenta severa <b>ya en curso</b> o por empezar en la próxima hora: es lo más cercano a un aviso de tornado.',
    Rojo: 'Fenómenos excepcionales: peligro muy alto.', Naranja: 'Fenómenos peligrosos probables: tomar precauciones.',
    Amarillo: 'Pueden darse fenómenos fuertes: estar atento.', Verde: 'Sin fenómenos peligrosos.',
  };
  const lejos = (g) => g.dist == null ? '' : g.mine ? '<span class="you">📍 incluye tu ubicación</span>' : `<span class="dist">a ${g.dist} km de vos</span>`;
  const cuando = (g) => {
    const f = (ms) => fmt(new Date(ms).toISOString(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return g.desde && g.expires ? `${g.desde > Date.now() ? `desde ${f(g.desde)} ` : 'ahora · '}hasta ${f(g.expires)}` : g.expires ? `hasta ${f(g.expires)}` : '';
  };
  const dondeTxt = (g) => esc(g.donde.slice(0, 5).join(', ')) + (g.donde.length > 5 ? ` y ${g.donde.length - 5} más` : '');
  el.className = 'card smn' + (short ? ' hot' : '');
  el.innerHTML = `<div class="smnhead"><h2>${short ? '🚨' : '⚠️'} Avisos oficiales SMN</h2><span class="muted">${gs.length} ${gs.length === 1 ? 'aviso' : 'avisos'} · ${upd}</span></div>` +
    gs.map((g, k) => `
      <details class="al ${g.mine ? 'mine' : ''} ${g.dist > 300 ? 'far' : ''}" style="--c:${g.c}" ${g.rank < 0 || g.mine ? 'open' : ''}>
        <summary>
          <div class="alrow"><span class="tag">${esc(g.lbl)}</span><b>${esc(g.event)}</b>${lejos(g)}</div>
          <small>📍 ${dondeTxt(g)}${g.zonas > 1 ? ` · ${g.zonas} zonas` : ''}</small>
          ${cuando(g) ? `<small>🕒 ${cuando(g)}</small>` : ''}
        </summary>
        <p class="mean">${MEANS[g.lbl] ?? ''}</p>
        ${g.desc ? `<p>${esc(g.desc)}</p>` : ''}${g.instruction ? `<p class="instr">${esc(g.instruction)}</p>` : ''}
        ${g.bounds ? `<button class="chip almap" data-k="${k}">Ver en el mapa</button>` : ''}
      </details>`).join('');
  $$('.almap', el).forEach((b) => (b.onclick = () => {
    const g = gs[+b.dataset.k];
    showTab('map'); $('.mapcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    map.fitBounds(g.bounds, { padding: [30, 30], maxZoom: 9 });
  }));
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
/* ---------------- Núcleos de tormenta detectados por satélite (scripts/nowcast.py) ---------------- */
const ncLayer = L.layerGroup().addTo(map);
const NC_ANG = { norte: 0, noreste: 45, este: 90, sudeste: 135, sur: 180, sudoeste: 225, oeste: 270, noroeste: 315 };
let nowcast = null;
async function loadNowcast() {
  try { nowcast = await getJson('data/nowcast.json'); } catch { nowcast = null; }
  renderNowcast(); renderStorm(); renderIntercept();
}
function renderNowcast() {
  ncLayer.clearLayers();
  if (!S.layers.nucleos || !nowcast) return;
  for (const c of nowcast.celulas ?? []) {
    const col = c.fuerza === 'muy fuerte' ? '#c040e8' : c.fuerza === 'fuerte' ? '#ff3b5c' : '#ffd43b';
    const r = c.fuerza === 'muy fuerte' ? 11 : c.fuerza === 'fuerte' ? 9 : 6;
    // Posición estimada AHORA a partir del dato del satélite (que llega atrasado) y su movimiento.
    const est = nowcast.hora_utc ? coreAt(c, nowcast.hora_utc) : { lat: c.lat, lon: c.lon, edadMin: 0 };
    const age = Math.round(est.edadMin), moving = c.mov_deg != null && c.kmh && !est.stale;
    const tip = `${est.stale ? `<b>⚠️ Dato viejo</b> (satélite de las ${esc(nowcast.hora)} h, hace ${age} min)<br>` : ''}<b>Tormenta ${esc(c.fuerza)}</b> · ${moving ? `<b>posición estimada ahora</b> (dato del satélite de las ${esc(nowcast.hora)} h, hace ${age} min)` : `satélite ${esc(nowcast.hora)} h`}<br>Tope ${c.tope_min_C} °C · ${esc(c.tendencia)}${c.topes_sobresalientes ? ` · <b>${c.topes_sobresalientes} topes que sobresalen</b> (señal de supercelda)` : ''}${c.rayos_10min != null ? `<br>${c.salto_rayos ? `<b>⚡⚡ Salto de rayos: ${c.rayos_10min} en 10 min</b> (antes ${c.rayos_10min_antes}): suele anticipar granizo, viento o rotación en 10–30 min` : `Rayos: ${c.rayos_10min} en los últimos 10 min (antes ${c.rayos_10min_antes})`}` : ''}<br>${esc(c.cerca_de)}${moving ? `<br>Va al ${esc(c.va_hacia)} a ~${c.kmh} km/h (${esc(c.mov_fuente)}) · puntos: dentro de 30 y 60 min` : ''}`;
    if (moving && age >= 3) {
      // Dónde estaba (dato real, tenue) → dónde estaría ahora.
      L.polyline([[c.lat, c.lon], [est.lat, est.lon]], { pane: 'smn', color: col, weight: 1.5, opacity: 0.5, dashArray: '2 4', interactive: false }).addTo(ncLayer);
      L.circleMarker([c.lat, c.lon], { pane: 'smn', radius: r * 0.6, color: col, weight: 1, fillOpacity: 0.15, interactive: false }).addTo(ncLayer);
    }
    if (moving && c.fuerza === 'moderada') {
      // Moderadas: solo hacia dónde va (sin etiquetas, para no llenar el mapa).
      arrow(est, c.mov_deg, Math.min(25, c.kmh / 2), { color: col, weight: 2, opacity: 0.8 }).addTo(ncLayer);
    } else if (moving) {
      // Trayectoria estimada: +30 y +60 minutos.
      const p30 = movePoint(est, c.mov_deg, c.kmh / 2), p60 = movePoint(est, c.mov_deg, c.kmh);
      L.polyline([[est.lat, est.lon], [p30.lat, p30.lon], [p60.lat, p60.lon]], { pane: 'smn', color: col, weight: 2.5, dashArray: '6 6', interactive: false }).addTo(ncLayer);
      for (const [q, lbl] of [[p30, '+30'], [p60, '+60']]) {
        L.circleMarker([q.lat, q.lon], { pane: 'smn', radius: 3, color: col, weight: 1, fillColor: col, fillOpacity: 0.6, interactive: false }).addTo(ncLayer);
        L.marker([q.lat, q.lon], { pane: 'smn', interactive: false, icon: L.divIcon({ className: 'nclabel', html: `<span style="--c:${col}">${lbl}</span>`, iconSize: null }) }).addTo(ncLayer);
      }
    }
    L.circleMarker([est.lat, est.lon], { pane: 'smn', radius: r, color: '#fff', weight: c.tendencia === 'nueva' || c.tendencia === 'creciendo' ? 3 : 1.5, dashArray: c.tendencia === 'nueva' ? '3 3' : null, fillColor: col, fillOpacity: 0.9 })
      .bindTooltip(tip, { sticky: true }).addTo(ncLayer);
    if (c.topes_sobresalientes || c.salto_rayos) L.marker([est.lat, est.lon], { pane: 'smn', interactive: false, icon: L.divIcon({ className: 'otmark' + (c.salto_rayos ? ' salto' : ''), html: `<span>${c.salto_rayos ? '⚡⚡' : '⚡'}</span>`, iconSize: null }) }).addTo(ncLayer);
  }
}

// ⛈️ Tormenta fuerte o granizo hacia tu punto de salida (la misma cuenta que la alerta de Telegram).
function renderStorm() {
  const el = $('#tormenta');
  if (!el) return;
  if (!nowcast && !S.smn?.ok) { el.hidden = true; return; }
  const o = S.origin, quien = o.fallback || !o.label ? 'Leones' : o.label;
  const xs = amenazas({ me: o, nc: nowcast, smn: S.smn, data: S.data });
  const x = xs.find((t) => valeAvisar(t));
  el.hidden = false;
  const sat = nowcast?.hora ? `satélite de las ${esc(nowcast.hora)} h` : 'sin satélite reciente';
  if (!x) {
    el.className = 'card storm ok';
    el.innerHTML = `<h2>⛈️ Hacia ${esc(quien)}: ✅ ninguna tormenta fuerte en las próximas 2 h</h2><p class="why">${sat} · avisos del SMN</p>`;
    return;
  }
  const n = NIVEL[x.llega], c = x.core;
  const cuando = x.eta == null ? 'en las próximas horas' : x.eta > 0 ? `en ~${x.eta} min (≈ ${fmt(new Date(Date.now() + x.eta * 60e3).toISOString(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} h)` : '<b>ya está encima</b>';
  el.className = 'card storm ' + x.llega;
  el.innerHTML = `<h2>⛈️ Tormenta fuerte hacia ${esc(quien)}</h2>
    <p>${n.emoji} <b>${n.txt}</b> · ${cuando}</p>
    ${x.fuente === 'smn' ? `<p>🚨 Aviso a corto plazo del SMN: ${esc(x.evento || 'tormentas')}</p>` : ''}
    ${c ? `<p>🛰️ ${esc(c.fuerza)} (tope ${c.tope_min_C} °C) · ${esc(c.tendencia)} · ${x.d ? `a ${x.d} km al ${x.desde}` : 'encima'}${c.kmh && x.eta ? ` · viene a ~${c.kmh} km/h` : ''}</p>` : ''}
    <p>🧊 Granizo: <b>${x.granizo.nivel}</b>${x.granizo.señales.length ? ` <span class="why">· ${esc(x.granizo.señales.slice(0, 4).join('; '))}</span>` : ''}</p>
    ${x.porque.length ? `<p class="why">✅ Por qué: ${x.porque.join('; ')}</p>` : ''}
    ${x.dudas.length ? `<p class="why">❓ No es seguro porque: ${x.dudas.join('; ')}</p>` : ''}
    <p class="why">${sat}. El satélite no ve el granizo, da señales: lo confirma un aviso del SMN o alguien que lo vea.</p>`;
}

// 🎯 Dónde pararte para ver la mejor tormenta aislada a la que llegás desde tu punto (la misma cuenta que Telegram).
const interLayer = L.layerGroup().addTo(map);
const interStops = new Map();
function renderIntercept() {
  interLayer.clearLayers();
  if (!S.layers.nucleos || !nowcast) return;
  const x = mejorIntercepcion({ me: S.origin, nc: nowcast });
  if (!x) return;
  const k = plainKey(x.base);
  if (!interStops.has(k)) {
    interStops.set(k, null);
    ruralStop(x.base, x.away, fetch, 8).then((st) => { interStops.set(k, st || false); renderIntercept(); });
  }
  const st = interStops.get(k) || null, p = st ?? x.base, pasa = rumbo(x.mdir + 90);
  const tip = `<b>🎯 Para ver la tormenta ${x.aislada ? 'aislada' : '(hay otras cerca)'}</b> que está a ${x.d} km al ${x.desde} tuyo y va al ${rumbo(x.mdir)} a ~${x.c.kmh} km/h<br>`
    + (x.quedate ? `<b>Quedate donde estás</b>: pasa a ~15 km al ${pasa} en ~${x.pasa_min} min`
      : `Parate en ${st ? `🌾 <b>${esc(st.label)}</b>${st.cruce ? ' (cruce, dos salidas)' : ''}` : 'este punto (buscá ruta asfaltada cerca)'}<br>Llegás en ~${x.llegas_min} min · ella pasa a ~15 km al <b>${pasa}</b> en ~${x.pasa_min} min`)
    + `<br>Si se te acerca, escapá hacia el <b>${rumbo(x.away)}</b>. Nunca te cruces por delante.`;
  L.polyline([[S.origin.lat, S.origin.lon], [p.lat, p.lon]], { pane: 'smn', color: '#3ddc97', weight: 2, dashArray: '4 6', interactive: false }).addTo(interLayer);
  L.marker([p.lat, p.lon], { pane: 'smn', icon: L.divIcon({ className: 'intermark', html: '<span>🎯</span>', iconSize: null }) })
    .bindPopup(`${tip}<br><a href="${mapsDir(S.origin, p)}" target="_blank" rel="noopener">🗺️ Ruta al punto →</a>`, { maxWidth: 260, className: 'intertip' }).addTo(interLayer);
}

async function loadSmn() {
  try { S.smn = await getJson('data/smn.json'); } catch { S.smn = { ok: false, error: 'sin archivo de avisos' }; }
  renderSmn(); renderStatus(); renderStorm();
}

/* ---------------- Controles ---------------- */
function showTab(t) {
  $$('#tabs button[data-t]').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
  for (const k of ['map', 'windy']) $('#tab-' + k).hidden = k !== t;
  if (t === 'windy') setWindy();
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
/* ---------------- Desde dónde salís ---------------- */
// Tu ubicación (GPS, se sigue mientras manejás), un pueblo de la lista o un punto tocado en el mapa.
// Se recuerda en este dispositivo. Leones queda solo como respaldo hasta que elijas.
const ORIGIN_KEY = 'origen';
const saveOrigin = (o) => { try { localStorage.setItem(ORIGIN_KEY, JSON.stringify(o)); } catch { /* sin almacenamiento */ } };
function renderOriginAsk() {
  const el = $('#originask');
  if (el) el.hidden = !S.origin.fallback;
}
function setOrigin(o, mode) {
  S.origin = o;
  $$('#origin [data-o]').forEach((x) => x.classList.toggle('on', x.dataset.o === mode));
  $('#originSel').value = mode === 'town' ? o.label : '';
  $('#originSel').classList.toggle('on', mode === 'town');
  drawOrigin(); render(); if (S.smn) renderSmn(); renderOriginAsk(); renderStorm(); renderIntercept();
}
function startGps(btn = $('#origin [data-o="gps"]'), quiet = false) {
  if (!navigator.geolocation) { if (!quiet) alert('Tu navegador no da la ubicación. Elegí un pueblo o tocá el mapa.'); return; }
  btn.textContent = '📍 Buscando…';
  stopGps();
  let first = true, last = null;
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      const o = { lat: p.coords.latitude, lon: p.coords.longitude, label: 'tu ubicación' };
      if (first) { first = false; btn.textContent = '📍 Mi ubicación'; last = o; saveOrigin({ mode: 'gps' }); setOrigin(o, 'gps'); map.setView([o.lat, o.lon], 8); return; }
      // Mientras manejás: mover el punto y los círculos; recalcular distancias cada 2 km.
      S.origin = o; drawOrigin(); renderSafety();
      if (km(o, last) >= 2) { last = o; render(); }
    },
    (e) => {
      if (!first) return; // ya teníamos ubicación: seguimos esperando la próxima
      btn.textContent = '📍 Mi ubicación'; stopGps();
      if (!quiet) alert(e.code === 1 ? 'No diste permiso para usar la ubicación. Elegí un pueblo o tocá el mapa.' : 'No se pudo obtener la ubicación.');
      renderOriginAsk();
    },
    { enableHighAccuracy: true, maximumAge: 30000 });
}
$('#originSel').innerHTML = '<option value="">🏘️ Elegir pueblo…</option>'
  + [...POINTS].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((p) => `<option>${esc(p.name)}</option>`).join('');
$('#originSel').onchange = (e) => {
  const p = POINTS.find((x) => x.name === e.target.value);
  if (!p) return;
  stopGps(); saveOrigin({ mode: 'town', name: p.name }); setOrigin({ lat: p.lat, lon: p.lon, label: p.name }, 'town');
};
$('#origin [data-o="gps"]').onclick = (e) => startGps(e.currentTarget);
$('#origin [data-o="pick"]').onclick = (e) => {
  const b = e.currentTarget;
  showTab('map');
  $('.mapcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  b.textContent = '📌 Tocá el mapa…';
  map.getContainer().style.cursor = 'crosshair';
  map.once('click', (ev) => {
    map.getContainer().style.cursor = '';
    b.textContent = '📌 En el mapa';
    const o = { lat: +ev.latlng.lat.toFixed(4), lon: +ev.latlng.lng.toFixed(4), label: 'el punto elegido' };
    stopGps(); saveOrigin({ mode: 'pick', lat: o.lat, lon: o.lon }); setOrigin(o, 'pick');
  });
};
$$('[data-origin-gps]').forEach((b) => (b.onclick = () => startGps()));
$$('[data-origin-town]').forEach((b) => (b.onclick = () => { $('#originSel').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#originSel').focus(); }));

// Al entrar: lo último que elegiste; si nunca elegiste pero ya diste permiso de ubicación, usarla.
(async function restoreOrigin() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(ORIGIN_KEY)); } catch { /* nada guardado */ }
  if (saved?.mode === 'town') {
    const p = POINTS.find((x) => x.name === saved.name);
    if (p) return setOrigin({ lat: p.lat, lon: p.lon, label: p.name }, 'town');
  }
  if (saved?.mode === 'pick' && Number.isFinite(saved.lat)) return setOrigin({ lat: saved.lat, lon: saved.lon, label: 'el punto elegido' }, 'pick');
  let granted = false;
  try { granted = (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted'; } catch { /* sin Permissions API */ }
  if (saved?.mode === 'gps' || granted) return startGps(undefined, true);
  renderOriginAsk();
})();


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
function renderZones() {
  zoneLayer.clearLayers();
  if (!S.layers.zonas) return;
  const date = curDate();
  (S.zones ?? []).forEach((z, n) => {
    const lv = level(z.v);
    const ts = S.data.times[z.peak.i] ?? '';
    const ph = ts ? `pico ${+ts.slice(11, 13)} h` : '';
    const tip = `<b>Zona ${esc(z.name)}</b> · máximo ${z.v} (${lv.label.toLowerCase()})${ph ? ` · ${ph}` : ''}<br>Según el pronóstico, adentro de este círculo (~${Math.round(z.r)} km) es donde más chances hay de supercélulas con rotación. El lugar exacto lo define la tormenta el mismo día.`;
    L.circle([z.ctr.lat, z.ctr.lon], { pane: 'smn', radius: z.r * 1000, color: lv.color, weight: n ? 2 : 3, dashArray: '10 7', fillColor: lv.color, fillOpacity: n ? 0.03 : 0.06 })
      .bindTooltip(tip, { sticky: true }).addTo(zoneLayer);
    L.marker([z.ctr.lat + (n % 2 ? -1 : 1) * (z.r / 111.2), z.ctr.lon], { pane: 'smn', interactive: false, icon: L.divIcon({ className: 'zonelabel' + (n % 2 ? ' below' : ''), html: `<span style="--c:${lv.color}">${n + 1}. Zona ${esc(z.name)} · ${z.v}${ph ? ` · ${ph}` : ''}</span>`, iconSize: null }) }).addTo(zoneLayer);
  });
  // 👁 de cada opción del plan del día (siempre el máximo del día, como el plan).
  (S.opts ?? []).forEach((o, k) => {
    L.marker([o.vp.lat, o.vp.lon], { pane: 'smn', icon: L.divIcon({ className: 'vpmark', html: `<span>👁<b>${k + 1}</b></span>`, iconSize: null }) })
      .bindTooltip(`<b>${k + 1}. Punto para mirar · zona ${esc(o.z.name)}</b><br>Pico ${hm(o.peakH)} · salir a las ${hm(o.leave)} · ${o.dist} km<br>Al costado del camino de las tormentas: se ve la base y el granizo queda del otro lado. Es aproximado: buscá cerca un camino asfaltado con vista abierta.`, { sticky: true }).addTo(zoneLayer);
  });
}

loadForecast(); loadSmn(); loadRadar(); loadWrf();
loadHistory($('#historial'));
// Corrección aprendida (la calcula el historial en cada corrida).
fetch('data/historial.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((h) => { if (h?.sesgo) { S.bias = h.sesgo; render(); } }).catch(() => {});
// Modelo entrenado con tornados de EE.UU. (lo genera el workflow "Entrenar índice").
fetch('data/modelo-tornado.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((m) => { if (m?.w) { S.tmodel = m; render(); } }).catch(() => {});
// Índice con cada modelo por separado (GFS, ICON, ECMWF), para ver si coinciden.
fetch('data/modelos.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((m) => { if (m?.score) { S.mod = m; render(); } }).catch(() => {});
initRed($('#red'), {
  map,
  getOrigin: () => S.origin,
  showOnMap: (p) => { showTab('map'); $('.mapcard').scrollIntoView({ behavior: 'smooth', block: 'start' }); map.flyTo([p.lat, p.lon], 10); },
  pickOnMap: (cb) => {
    showTab('map'); $('.mapcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    map.getContainer().style.cursor = 'crosshair';
    map.once('click', (ev) => { map.getContainer().style.cursor = ''; cb({ lat: ev.latlng.lat, lon: ev.latlng.lng }); });
  },
});

// Pestaña Windy: radar ahora (incluye los radares del SMN), tormentas pronosticadas o CAPE,
// centrado en tu zona de caza (opción 1) si hay una; si no, en tu punto de salida.
const WINDY_HINT = {
  radar: 'Lo que llueve <b>ahora</b> (última hora). Tocá ▶ abajo para ver hacia dónde se mueve. Para lo que viene, tocá “Tormentas próximas horas”.',
  rain: '<b>Pronóstico</b> de lluvia y tormentas (⚡ = tormenta). Mové la barra de abajo para ver las próximas horas: donde aparezcan manchas fuertes y ⚡ cerca de tu zona, ahí se esperan.',
  cape: 'Energía para tormentas (pronóstico). Mové la barra de abajo para ver las horas.',
};
let windyO = 'radar';
function windyCenter() {
  const z = S.opts?.[0]?.z?.ctr;
  return z ? { lat: z.lat.toFixed(2), lon: z.lon.toFixed(2) } : { lat: S.origin.lat.toFixed(2), lon: S.origin.lon.toFixed(2) };
}
function setWindy(o = windyO) {
  windyO = o;
  $$('#windysw button').forEach((x) => x.classList.toggle('on', x.dataset.o === o));
  const f = $('#windyframe'), c = windyCenter(), zoom = o === 'radar' ? 7 : 6;
  const src = f.src.replace(/overlay=\w+/, 'overlay=' + o).replace(/zoom=\d+/, 'zoom=' + zoom)
    .replace(/([?&])lat=[-\d.]+/, `$1lat=${c.lat}`).replace(/([?&])lon=[-\d.]+/, `$1lon=${c.lon}`)
    .replace(/detailLat=[-\d.]+/, `detailLat=${c.lat}`).replace(/detailLon=[-\d.]+/, `detailLon=${c.lon}`);
  if (src !== f.src) f.src = src;
  $('#windyopen').href = `https://www.windy.com/${c.lat}/${c.lon}?${o},${c.lat},${c.lon},${zoom}`;
  $('#windyhint').innerHTML = WINDY_HINT[o] + (S.opts?.[0] ? ` · Centrado en tu zona: <b>${esc(S.opts[0].z.name)}</b> (punto).` : '');
}
$$('#windysw button').forEach((b) => (b.onclick = () => setWindy(b.dataset.o)));
setInterval(loadRadar, 5 * 60e3);
setInterval(() => { loadSmn(); loadNowcast(); }, 10 * 60e3);
setInterval(() => { renderNowcast(); renderStorm(); renderIntercept(); }, 60e3); // la posición estimada avanza minuto a minuto
loadNowcast();
setInterval(() => { loadForecast(); loadWrf(); }, 60 * 60e3);
