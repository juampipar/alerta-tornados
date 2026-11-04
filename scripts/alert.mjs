// Alertas por Telegram. Corre en el workflow de cada hora, después de build-data.mjs.
// Uso: node scripts/alert.mjs _site
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MIN_SCORE (60), RADIUS_KM (200),
//      ALERT_STATE (archivo donde recuerda lo ya enviado), TEST=1 (manda el resumen igual), DRY_RUN=1 (no envía).
//
// Dos mensajes:
//  1. 🌪️ Día de caza: hoy o mañana alguna zona llega a MIN_SCORE (una vez por día; de nuevo si sube 10).
//     Entre las 23 y las 7 h no se manda: queda para la mañana.
//  2. 🚨 Ya se están formando: SOLO en un día de caza, si el SMN emite un aviso a corto plazo
//     cerca de Leones o de las zonas marcadas. Los avisos del SMN de días comunes no se mandan.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HOME, level, km, driveHours, rumbo, huntZones, placeName, huntOptions, nearestStop, plainKey, sunsetHour } from '../lib/risk.mjs';

const dir = (process.argv[2] || '_site') + '/data';
const env = process.env;
const MIN = +(env.MIN_SCORE || 60);
const RADIUS = +(env.RADIUS_KM || 200);
const NEAR_ZONE = 80; // km: aviso del SMN "cerca" de una zona marcada
const STATE = env.ALERT_STATE || '.alert-state/state.json';
const PANEL = 'https://juampipar.github.io/alerta-tornados/';
const TZ = 'America/Argentina/Cordoba';

const readJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const bearing = (a, b) => (Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360;
const pin = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(3)},${lon.toFixed(3)}`;
const maps = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clock = (min) => { const m = ((Math.round(min / 15) * 15) % 1440 + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const dur = (h) => { const m = Math.round((h * 60) / 10) * 10; return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// "CORDOBA: JUAREZ CELMAN" -> "Cordoba: Juarez Celman" (el SMN escribe todo en mayúsculas)
const title = (s) => String(s ?? '').toLowerCase().replace(/(^|[\s:(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/ (De|Del|La|Las|Los|Y|En|Por|Con) /g, (m) => m.toLowerCase());

const now = new Date(Date.now() - 3 * 3600e3); // hora argentina (UTC−3, sin horario de verano)
const today = now.toISOString().slice(0, 10);
const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayName = (d) => `${new Date(d + 'T12:00:00Z').toLocaleDateString('es-AR', { weekday: 'short', timeZone: 'UTC' })} ${+d.slice(8)}/${+d.slice(5, 7)}`;

const data = await readJson(`${dir}/forecast.json`);
const smn = await readJson(`${dir}/smn.json`);
const state = (await readJson(STATE)) || {};
state.smn ??= {}; state.days ??= {};
// v2: los puntajes guardados antes eran de la zona mal calculada (sobre el río o Uruguay): se olvidan.
if (state.v !== 2) { state.days = {}; state.v = 2; }
const messages = [];
const test = !!env.TEST;
const quiet = nowMin >= 23 * 60 || nowMin < 7 * 60;

/* ---------- Pronóstico ---------- */
// Misma ventana que el panel: de 11 h a 2 h del día siguiente.
function windowIdx(date) {
  const nd = addDays(date, 1);
  return data.times.flatMap((t, i) => {
    const h = +t.slice(11, 13);
    return (t.startsWith(date) && h >= 11) || (t.startsWith(nd) && h <= 2) ? [i] : [];
  });
}
// Para hoy, solo las horas que faltan (desde la hora actual).
function hoursLeft(date) {
  const from = `${today}T${pad(Math.floor(nowMin / 60))}:00`;
  return windowIdx(date).filter((k) => date !== today || data.times[k] >= from);
}
// Zonas de caza del día: igual que el círculo del mapa ("Máx. del día").
function zonesFor(date, max = 2) {
  if (!data.grid) return [];
  const idx = hoursLeft(date);
  const cells = data.grid.pts.map(([lat, lon], k) => {
    let v = 0, i = idx[0];
    for (const j of idx) if ((data.grid.score[k][j] ?? 0) > v) { v = data.grid.score[k][j]; i = j; }
    return { lat, lon, v, i };
  });
  return huntZones(cells, data.towns, max);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Otras zonas a las que se puede ir (2.ª a 4.ª), una línea cada una.
// Opciones (paradas) del día, como en el panel: estación de servicio más cercana al punto ideal
// y primero las que se llega a tiempo desde Leones.
const optCache = {};
async function optionsFor(date) {
  if (optCache[date]) return optCache[date];
  const zs = zonesFor(date, 4);
  if (!zs.length) return (optCache[date] = []);
  const nowH = date === today ? nowMin / 60 : null;
  const base = huntOptions(zs, data.towns, data.times, date, HOME, null, nowH);
  state.stops ??= {}; state.places ??= {};
  for (const o of base) {
    const k = plainKey(o.base);
    if (state.stops[k]) continue;
    await sleep(1100); // OpenStreetMap pide como máximo 1 consulta por segundo
    const st = await nearestStop(o.base, data.towns);
    if (st) state.stops[k] = st;
  }
  const opts = huntOptions(zs, data.towns, data.times, date, HOME, (bp) => state.stops[plainKey(bp)] || null, nowH);
  for (const o of opts) {
    const k = plainKey(o.vp);
    if (!(k in state.places)) { await sleep(1100); state.places[k] = await placeName(o.vp); }
    o.place = state.places[k];
  }
  return (optCache[date] = opts);
}
const stopLine = (o) => `${o.stop?.kind === 'estación' ? '⛽ ' : ''}<b>${esc(o.stop?.label ?? 'punto aproximado')}</b>${o.place ? ` · cerca de ${esc(o.place.place)}${o.place.road ? ` (${esc(o.place.road)})` : ''}` : ''}`;
const ruta = (p) => maps(+p.lat.toFixed(4), +p.lon.toFixed(4));
const timeLine = (o) => !o.reachable ? `no llegás antes del pico` : o.late ? `<b>salí ya</b> (llegás ${clock(o.arriveAt * 60)})` : `salir <b>${clock(o.leave * 60)}</b>`;
function bestTowns(date) {
  const idx = hoursLeft(date);
  return data.towns.map((t) => {
    let i = -1, v = -1;
    for (const k of idx) if ((t.score[k] ?? 0) > v) { v = t.score[k]; i = k; }
    if (i < 0) return null;
    const s = (key) => t[key]?.[i];
    const time = data.times[i];
    const peakMin = (+time.slice(11, 13)) * 60 + (time.startsWith(date) ? 0 : 1440); // minutos desde las 0 h del día
    return { t, i, s, score: Math.max(v, 0), dist: Math.round(km(HOME, t)), peakMin };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.dist - b.dist);
}

// Palabras simples para cada ingrediente (✅ = favorable para tornado).
const words = {
  cape: (v) => (v >= 2500 ? 'muy alta ✅' : v >= 1500 ? 'alta ✅' : v >= 500 ? 'media' : 'baja'),
  shear: (v) => (v >= 20 ? 'fuerte ✅' : v >= 12.5 ? 'moderada' : 'débil ❌'),
  srh: (v) => (v >= 150 ? 'alto ✅' : v >= 75 ? 'moderado' : 'bajo'),
  lcl: (v) => (v < 1000 ? 'baja ✅' : v < 1500 ? 'media' : 'alta (más granizo que tornado)'),
};

// Km desde el pueblo de destino hasta el borde de la zona (0 si está adentro).
const outside = (z, b) => (z ? Math.max(0, Math.round(km(b.t, z.ctr) - z.r)) : 0);

// Puntaje del día = el de la zona de caza principal (o el mejor pueblo si no hay zona).
const dayScore = (date, rank) => zonesFor(date)[0]?.v ?? rank[0]?.score ?? 0;

async function huntMessage(date, label, rank, prev) {
  const opts = await optionsFor(date), o = opts[0];
  if (!o) {
    const b = rank[0];
    return `🧪 <b>Prueba · ${label}</b> <i>${dayName(date)}</i>\nNo hay zona de caza (lo mejor: ${esc(b.t.name)} ${b.score}).\n${PANEL}`;
  }
  const score = o.z.v, lv = level(score), i = o.i, t = o.town;
  const at = (k) => t[k]?.[i];
  const srh = at('srh') == null ? null : Math.max(0, -at('srh')); // helicidad ciclónica (hemisferio sur)
  const ing = [
    `⚡ Energía (CAPE ${at('cape')}): ${words.cape(at('cape'))}`,
    at('shear') != null && `💨 Cizalladura (${Math.round(at('shear'))} m/s): ${words.shear(at('shear'))}`,
    srh != null && `🌀 Giro cerca del suelo (helicidad ${srh}): ${words.srh(srh)}`,
    at('lcl') != null && `☁️ Base de nube (${at('lcl')} m): ${words.lcl(at('lcl'))}`,
  ].filter(Boolean);
  const side = rumbo(o.mdir - 90);
  const others = opts.slice(1).map((x, k) => `${['2️⃣', '3️⃣', '4️⃣'][k]} Zona ${esc(x.z.name)} · <b>${x.z.v}</b> · pico ${clock(x.peakH * 60)} h\n   👁 ${stopLine(x)}\n   ${x.dist} km · ${timeLine(x)}${x.hit ? ' ⚠️' : ''} · <a href="${ruta(x.vp)}">ruta</a>`);
  return [
    score >= MIN ? `🌪️ <b>DÍA DE CAZA · ${label}</b> <i>${dayName(date)}</i>` : `🧪 <b>Prueba · ${label}</b> <i>${dayName(date)}</i> · no llega a día de caza`,
    `Potencial de tornado <b>${lv.label.toUpperCase()} · ${score}/100</b>${prev >= 0 ? ` <i>(subió de ${prev})</i>` : ''}`,
    '',
    `🎯 <b>Zona ${esc(o.z.name)}</b> · pico a las <b>${clock(o.peakH * 60)} h</b>`,
    `👁 Parar en: ${stopLine(o)}`,
    o.stop?.kind === 'pueblo' ? `   (no encontré estación de servicio cerca del punto ideal: es el pueblo más cercano) · <a href="${ruta(o.vp)}">Ruta</a>`
      : `   Al ${side} del camino de las tormentas · <a href="${ruta(o.vp)}">Ruta a la parada</a>`,
    `🚗 ${o.dist} km en línea recta, ~${dur(o.drive)} desde Leones`,
    !o.reachable ? '⏰ <b>Ya no llegás antes del pico</b>: si estás cerca, seguí el radar'
      : o.late ? `⏰ <b>Salí ya</b>: llegás a las ${clock(o.arriveAt * 60)} h`
      : `⏰ Salir a las <b>${clock(o.leave * 60)}</b>${o.safe != null ? ' (antes de que las tormentas crucen tu camino)' : ' para llegar 1 h antes'}`,
    o.hit ? `⚠️ <b>El camino cruza el paso de las tormentas</b> cerca de las ${clock(o.hit.h * 60)} h: entrá por el ${side}, sin cruzar por delante.`
      : o.mspd != null && o.reachable ? '✅ Con ese horario el camino no cruza por delante de las tormentas' : null,
    o.mspd != null ? `➡️ Las tormentas van hacia el <b>${rumbo(o.mdir)}</b> a ${o.mspd} km/h` : null,
    '',
    `<b>Ingredientes de la zona</b> (${esc(t.name)}, ${clock(o.peakH * 60)} h)`,
    ...ing,
    ...(others.length ? ['', '<b>Otras opciones para ir</b>', ...others] : []),
    '',
    `<a href="${ruta(o.vp)}">🗺️ Ruta a la parada</a>  ·  <a href="${PANEL}">📡 Radar y mapa</a>`,
    `<i>Es potencial según el modelo, no un aviso de tornado.</i>`,
  ].filter((x) => x !== false && x != null).join('\n');
}

const ranks = {};
if (data) {
  for (const [off, label] of [[0, 'HOY'], [1, 'MAÑANA']]) {
    const date = addDays(today, off);
    const rank = (ranks[date] = bestTowns(date));
    if (!rank[0]) continue;
    const sc = dayScore(date, rank);
    const prev = state.days[date] ?? -1;
    const fire = sc >= MIN && sc >= prev + 10 && !quiet;
    if (fire) state.days[date] = sc;
    if (fire || (test && (off === 0 || sc >= MIN))) messages.push(await huntMessage(date, label, rank, fire ? prev : -1));
  }
}

/* ---------- Confirmación en vivo: avisos a corto plazo del SMN en un día de caza ---------- */
function inPoly([lat, lon], poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
const pts = (a) => a.areas.flatMap((ar) => ar.polygons.flat());
const distTo = (a, p) => Math.min(Infinity, ...pts(a).map(([lat, lon]) => km(p, { lat, lon })));
const covers = (a, p) => a.areas.some((ar) => ar.polygons.some((poly) => inPoly([p.lat, p.lon], poly)));

const todayRank = ranks[today] ?? [];
const todayScore = data && todayRank[0] ? dayScore(today, todayRank) : 0;
const huntDay = todayScore >= MIN;
const zones = data ? zonesFor(today) : [];
const live = [];
for (const a of smn?.alerts ?? []) {
  if (!a.shortTerm || state.smn[a.id] || !huntDay) continue;
  const home = covers(a, HOME), dHome = Math.round(distTo(a, HOME));
  // Cerca de una zona de caza: dentro del círculo o a menos de NEAR_ZONE km de su borde.
  const zone = zones.map((z) => ({ z, d: covers(a, z.ctr) ? 0 : Math.max(0, distTo(a, z.ctr) - z.r) })).filter((x) => x.d <= NEAR_ZONE).sort((x, y) => x.d - y.d)[0]?.z;
  if (!home && !zone && dHome > RADIUS) continue;
  state.smn[a.id] = a.expires || new Date().toISOString();
  const areas = [...new Set(a.areas.map((x) => title(x.desc).replace(/\.$/, '')).filter(Boolean))];
  live.push(`• <b>${esc(cap((a.event || a.headline || 'Tormentas').toLowerCase()))}</b>: ${esc(areas.slice(0, 4).join(', '))}${areas.length > 4 ? ` +${areas.length - 4}` : ''}` +
    `\n   ${home ? '📍 <b>incluye Leones</b>' : `a ${dHome} km de Leones`}${zone ? ` · en la zona ${esc(zone.name)}` : ''}${a.expires ? ` · hasta las ${hhmm(a.expires)}` : ''}`);
}
if (live.length) {
  messages.push([
    `🚨 <b>¡YA SE ESTÁN FORMANDO!</b>`,
    `Hoy es día de caza (potencial ${todayScore}) y el SMN puso ${live.length === 1 ? 'un aviso' : `${live.length} avisos`} a corto plazo:`,
    '',
    ...live.slice(0, 6),
    ...(live.length > 6 ? [`…y ${live.length - 6} más`] : []),
    '',
    `<a href="${PANEL}">📡 Mirá el radar antes de moverte</a>`,
  ].join('\n'));
}

// Olvida avisos y días viejos.
for (const [id, exp] of Object.entries(state.smn)) if (Date.parse(exp) < Date.now() - 2 * 864e5) delete state.smn[id];
for (const d of Object.keys(state.days)) if (d < addDays(today, -3)) delete state.days[d];
for (const c of ['stops', 'places']) if (state[c] && Object.keys(state[c]).length > 300) state[c] = Object.fromEntries(Object.entries(state[c]).slice(-200));
await mkdir(dirname(STATE), { recursive: true });


/* ---------- Resumen para IA (data/brief.json) y recomendación 🤖 ---------- */
const r0 = (x) => (x == null ? null : Math.round(x));
async function buildBrief() {
  const days = [];
  for (const [off, label] of [[0, 'hoy'], [1, 'mañana']]) {
    const date = addDays(today, off);
    if (!data?.times?.some((t) => t.startsWith(date))) continue;
    const opts = await optionsFor(date);
    days.push({
      dia: label, fecha: date,
      opciones: opts.map((o, k) => ({
        n: k + 1, zona: o.z.name, potencial: o.z.v, radio_km: r0(o.z.r), centro: { lat: +o.z.ctr.lat.toFixed(2), lon: +o.z.ctr.lon.toFixed(2) },
        hora_pico: clock(o.peakH * 60),
        parada: { nombre: o.stop?.label ?? null, tipo: o.stop?.kind ?? null, cerca_de: o.place?.place ?? null, ruta: o.place?.road ?? null, lat: +o.vp.lat.toFixed(3), lon: +o.vp.lon.toFixed(3) },
        km_desde_leones: o.dist, horas_de_viaje: +o.drive.toFixed(1), salir: clock(o.leave * 60), es_tarde: o.late, llega_a_tiempo: o.reachable,
        camino_cruza_tormentas: o.hit ? clock(o.hit.h * 60) : false,
        tormentas_van_hacia: o.mspd != null ? rumbo(o.mdir) : null, velocidad_kmh: o.mspd,
        ingredientes: (() => { const t = o.town, i = o.i; return { pueblo: t.name, cape: t.cape[i], cizalla_0_6km_ms: r0(t.shear[i]), cizalla_0_1km_ms: r0(t.ll[i]), helicidad_0_1km: t.srh?.[i] ?? null, base_nube_m: t.lcl?.[i] ?? null, rocio_c: t.td[i], cin: t.cin[i] }; })(),
      })),
    });
  }
  const acp = (smn?.alerts ?? []).filter((a) => a.shortTerm).map((a) => ({
    evento: a.event || a.headline, zonas: [...new Set(a.areas.map((x) => title(x.desc).replace(/\.$/, '')))].slice(0, 6),
    km_desde_leones: Math.round(distTo(a, HOME)), incluye_leones: covers(a, HOME), hasta: a.expires ? hhmm(a.expires) : null,
  })).sort((x, y) => x.km_desde_leones - y.km_desde_leones).slice(0, 8);
  return {
    generado: new Date().toISOString(), hora_argentina: clock(nowMin), base: { nombre: 'Leones', lat: HOME.lat, lon: HOME.lon },
    puesta_de_sol_aprox: clock(sunsetHour(HOME.lat, HOME.lon, today) * 60), umbral_dia_de_caza: MIN, dias: days, avisos_smn_corto_plazo: acp,
    imagenes: await (async () => { try { return JSON.parse(await readFile(`${dir}/img/meta.json`, 'utf8')).imagenes.map((x) => ({ ...x, url: `data/img/${x.archivo}` })); } catch { return []; } })(),
    nota: 'Potencial 0–100 de supercélulas con rotación según modelos (no es un aviso de tornado). Radar de velocidad no disponible.',
  };
}

const AI_RULES = `Sos un cazador de tormentas experto del Pasillo de los Tornados (Argentina, hemisferio sur) y le hablás a un aficionado
que sale desde Leones (Córdoba). Con el resumen JSON que sigue, decile QUÉ HACER AHORA, en castellano rioplatense, simple y concreto.
Reglas obligatorias:
- Máximo 6 líneas cortas. Nada de introducciones. Empezá con la decisión: "Salí", "Esperá", "Quedate", "Movete" o "Hoy no salgas".
- Usá solo los datos del JSON: nombrá la parada (estación/pueblo), la hora de salida y la ruta si están. No inventes lugares, rutas ni datos.
- Si hay avisos a corto plazo del SMN cerca (< 80 km), priorizalos: decí dónde están y hacia dónde moverse para quedar de costado.
- Seguridad: nunca recomiendes acercarse a menos de 15 km de una tormenta, ponerse delante de su camino, caminos de tierra,
  ni salir o seguir de noche (después de la puesta del sol). Interceptar de costado (lado norte si van al este), nunca perseguir por detrás.
- Si ninguna opción llega a tiempo o el potencial es < 45, decí que hoy no conviene.
- No prometas tornados: hablá de "chances".`;

// Imágenes para la IA (scripts/build-images.py): satélite ahora y hace 1 h, lluvia del modelo.
async function aiImages() {
  try {
    const meta = JSON.parse(await readFile(`${dir}/img/meta.json`, 'utf8'));
    const out = [];
    for (const im of meta.imagenes ?? []) {
      const buf = await readFile(`${dir}/img/${im.archivo}`);
      out.push({ ...im, data: buf.toString('base64') });
    }
    return out;
  } catch { return []; }
}

const AI_IMAGES_GUIDE = `Además del JSON vas a recibir imágenes del Pasillo (recorte 67°O–57°O, 37,5°S–30°S) con grilla cada 1°,
pueblos marcados, LEONES (la base, rombo celeste) y los avisos a corto plazo del SMN con contorno rojo:
- "Satélite infrarrojo" ahora y 1 hora antes: los topes fríos (colores intensos/blanco brillante) son tormentas profundas.
  Compará las dos: ¿qué núcleos son NUEVOS o CRECIERON (se formaron en la última hora)? ¿hacia dónde se movieron? ¿están aislados o en línea?
- "Satélite visible" (de día): torres de cúmulos y yunques blancos; campos de cúmulos que se organizan en línea indican dónde nace la convección.
- "Lluvia pronosticada por el modelo SMN" +1 h y +3 h: dónde el modelo espera tormentas pronto.
Usá las imágenes para decir DÓNDE se está formando algo ahora (cerca de qué pueblo), si crece, hacia dónde va y si conviene
moverse para quedar de costado. Si las imágenes no muestran nada importante cerca, decilo. No inventes lo que no se ve.`;

async function aiAdvice(brief, focus) {
  const key = env.GEMINI_API_KEY;
  if (!key) return null;
  const imgs = await aiImages();
  const parts = [{ text: `${AI_RULES}\n\n${imgs.length ? AI_IMAGES_GUIDE + '\n\n' : ''}Enfocate en: ${focus}\n\nJSON:\n${JSON.stringify(brief)}` }];
  for (const im of imgs) {
    parts.push({ text: `Imagen: ${im.que_es} (${im.hora} h)` });
    parts.push({ inline_data: { mime_type: 'image/png', data: im.data } });
  }
  // Modelo principal y uno más liviano de respaldo; reintentos si está saturado (503) o con límite (429).
  const models = [...new Set([env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 60000);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.3, maxOutputTokens: 600 } }),
        });
        clearTimeout(timer);
        if (r.ok) {
          const j = await r.json();
          const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim();
          if (txt) { console.log(`IA: ${model} (${imgs.length} imágenes)`); return txt; }
          console.error('IA: respuesta vacía', JSON.stringify(j).slice(0, 300));
        } else {
          console.error(`IA error ${model}`, r.status, (await r.text()).slice(0, 200));
          if (![429, 500, 503].includes(r.status)) break; // error de pedido: probar el otro modelo
        }
      } catch (e) { console.error('IA falló:', e.message); }
      await sleep([5000, 15000, 0][attempt]);
    }
  }
  return null;
}

let brief = null;
if (data) {
  brief = await buildBrief();
  await writeFile(`${dir}/brief.json`, JSON.stringify(brief, null, 1));
}
if (brief && messages.length) {
  const focus = live.length ? 'hay avisos del SMN de tormentas formándose: qué hacer en las próximas 2 horas'
    : 'el día de caza: a dónde ir, a qué hora salir y qué hacer al llegar';
  const adv = await aiAdvice(brief, focus);
  if (adv) messages.push(`🤖 <b>Qué haría yo</b> <i>(IA, con los datos de arriba)</i>\n${esc(adv).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^\s*[*-]\s+/gm, '• ')}\n<i>Es una sugerencia: manda el radar y tu criterio.</i>`);
}

/* ---------- Envío ---------- */
console.log(messages.length ? messages.join('\n\n———\n\n') : `Nada para avisar (umbral ${MIN}, ${clock(nowMin)} h).`);
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = env;
if (!messages.length || env.DRY_RUN) { await writeFile(STATE, JSON.stringify(state)); process.exit(0); }
if (!token || !chat) {
  // Sin configurar todavía: no falla el workflow y no marca nada como enviado.
  console.log('Faltan los secretos TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: no se envía.');
  process.exit(0);
}
let ok = true;
for (const text of messages) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) { ok = false; console.error('Telegram error', r.status, await r.text()); }
}
if (ok) await writeFile(STATE, JSON.stringify(state)); // si falló, reintenta en la próxima hora
else process.exit(1);
console.log(`Enviado: ${messages.length} mensaje(s).`);
