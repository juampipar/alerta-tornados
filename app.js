import { HOME, POINTS, fetchForecast, rank, level, driveHours } from './lib/risk.mjs';

const $ = (s) => document.querySelector(s);
const ART = () => new Date(Date.now() - 3 * 3600e3);
const dateStr = (off) => new Date(ART().getTime() + off * 864e5).toISOString().slice(0, 10);
let locs = null, day = 0;

// ---- Mapa ----
const map = L.map('map').setView([-33, -62.3], 6);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap © CARTO', maxZoom: 12 }).addTo(map);
L.marker([HOME.lat, HOME.lon]).addTo(map).bindTooltip('Leones 🏠');
const zonas = L.layerGroup().addTo(map);
const gibs = (id, lvl, ext) => () => L.tileLayer(
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${id}/default/{t}/GoogleMapsCompatible_Level${lvl}/{z}/{y}/{x}.${ext}`,
  { maxNativeZoom: lvl, maxZoom: 12, opacity: 0.75, attribution: 'NASA GIBS / NOAA GOES', t: '' });
const sat = gibs('GOES-East_ABI_GeoColor', 7, 'jpg')(), ir = gibs('GOES-East_ABI_Band13_Clean_Infrared', 6, 'png')();
// GIBS: sin fecha explícita usamos "default"; se refresca recreando la capa
for (const l of [sat, ir]) l.getTileUrl = function (c) {
  return L.Util.template(this._url.replace('{t}', 'default'), { z: c.z + 0, x: c.x, y: c.y }) + '?_=' + Math.floor(Date.now() / 600000);
};
let radar = null, frames = [], fi = 0, timer = null;
async function loadRadar() {
  try {
    const j = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
    frames = j.radar.past.map((f) => L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 12, zIndex: 5 }));
    frames.forEach((f) => f.addTo(map));
    clearInterval(timer);
    timer = setInterval(() => { frames[fi].setOpacity(0); fi = (fi + 1) % frames.length; frames[fi].setOpacity(0.7); }, 600);
    radar = true;
    $('#stamp').textContent = 'Radar: ' + new Date(j.radar.past.at(-1).time * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  } catch { $('#stamp').textContent = 'Radar no disponible'; }
}
function toggle(id, layer, on) { $(id).onchange = (e) => (e.target.checked ? layer.addTo(map) : map.removeLayer(layer)); if (!on) return; }
$('#l-zonas').onchange = (e) => (e.target.checked ? zonas.addTo(map) : map.removeLayer(zonas));
toggle('#l-sat', sat); toggle('#l-ir', ir);
$('#l-radar').onchange = (e) => frames.forEach((f) => (e.target.checked ? f.addTo(map) : map.removeLayer(f)));
loadRadar(); setInterval(loadRadar, 5 * 60e3);

// ---- Pronóstico ----
function render() {
  const r = rank(locs, POINTS, dateStr(day));
  zonas.clearLayers();
  for (const p of r) {
    const lv = level(p.score);
    L.circleMarker([p.lat, p.lon], { radius: 6 + p.score / 10, color: lv.color, fillColor: lv.color, fillOpacity: 0.55, weight: 2 })
      .bindTooltip(`${p.name}: ${p.score} · CAPE ${p.cape} · cizalla ${p.shear} m/s`).addTo(zonas);
  }
  const t = r[0];
  $('#best').innerHTML = t
    ? `<div>Mejor zona ${day ? 'mañana' : 'hoy'}</div><div class="big">${t.name} <span class="badge" style="background:${level(t.score).color}">${level(t.score).label} ${t.score}</span></div>
       <small>${t.dist} km de Leones (~${driveHours(t.dist).toFixed(1)} h) · pico a las ${t.hour} h · CAPE ${t.cape} J/kg · cizalla ${t.shear} m/s</small>`
    : 'Sin datos para este día.';
  $('#list').innerHTML = r.map((p) => {
    const lv = level(p.score);
    return `<li class="row"><span class="sc"><span class="badge" style="background:${lv.color}">${p.score}</span></span>
      <span class="info"><b>${p.name}</b> · ${lv.label}<small>${p.dist} km (~${driveHours(p.dist).toFixed(1)} h) · CAPE ${p.cape} · cizalla ${p.shear} m/s · CIN ${p.cin} · pico ${p.hour} h</small></span>
      <a class="go" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}">Ir</a></li>`;
  }).join('');
}
(async () => {
  try { locs = await fetchForecast(); render(); }
  catch (e) { $('#best').textContent = 'No se pudo cargar el pronóstico (' + e.message + ').'; }
})();
document.querySelectorAll('.days button').forEach((b) => (b.onclick = () => {
  day = +b.dataset.d; document.querySelectorAll('.days button').forEach((x) => x.classList.toggle('on', x === b)); if (locs) render();
}));
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  for (const t of ['map', 'windy', 'rayos']) $('#tab-' + t).hidden = t !== b.dataset.t;
  if (b.dataset.t === 'map') map.invalidateSize();
}));
