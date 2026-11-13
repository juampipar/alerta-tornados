// Alertas por Telegram. Corre en el workflow de cada hora, después de build-data.mjs.
// Uso: node scripts/alert.mjs _site
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MIN_SCORE (60), RADIUS_KM (200),
//      ALERT_STATE (archivo donde recuerda lo ya enviado), TEST=1 (manda el resumen igual), DRY_RUN=1 (no envía).
//
// Dos mensajes:
//  1. 🌪️ Día de caza (60+) o 🟠 día posible (MIN_SCORE a 59): hoy o mañana alguna zona llega (una vez por día; de nuevo si sube 10).
//     Entre las 23 y las 7 h no se manda: queda para la mañana.
//  2. 🚨 Ya se están formando: SOLO en un día de caza, si el SMN emite un aviso a corto plazo
//     cerca de Leones o de las zonas marcadas. Los avisos del SMN de días comunes no se mandan.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { HOME, level, km, driveHours, rumbo, huntZones, zoneCells, placeName, huntOptions, ruralStop, plainKey, sunsetHour, coreAt, movePoint } from '../lib/risk.mjs';
import { shiftZone, zoneWindow, correctedWindow } from '../lib/sesgo.mjs';
import { zoneAgreement, widenWindow } from '../lib/modelos.mjs';
import { amenazas, valeAvisar, revisar, aciertos, NIVEL, mejorIntercepcion, peligroGranizo, comoAlejarse, paraMirar, rutaLibre, potencialTornado } from '../lib/tormenta.mjs';

const dir = (process.argv[2] || '_site') + '/data';
const env = process.env;
const MIN = +(env.MIN_SCORE || 60);
const CLARO = Math.max(MIN, 60); // desde acá es un día de caza claro; entre MIN y CLARO, "día posible"
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
const MOD = await readJson(`${dir}/modelos.json`); // índice con GFS, ICON y ECMWF por separado
const state = (await readJson(STATE)) || {};
// Corrección aprendida (zona y hora) del historial publicado. Sin ella, se usa el modelo tal cual.
const BIAS = await (async () => {
  try { const r = await fetch(env.PUBLISHED_HIST || PANEL + 'data/historial.json', { cache: 'no-store' }); return r.ok ? (await r.json()).sesgo ?? null : null; } catch { return null; }
})();
state.smn ??= {}; state.days ??= {};
// v2: los puntajes guardados antes eran de la zona mal calculada (sobre el río o Uruguay): se olvidan.
if (state.v !== 2) { state.days = {}; state.v = 2; }
// Antes el aviso de MAÑANA se guardaba con la fecha sola: pasarlo a "fecha:m" para que llegue también el de HOY.
for (const d of Object.keys(state.days)) if (!d.includes(':') && d > new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) { state.days[`${d}:m`] = state.days[d]; delete state.days[d]; }
const messages = [];
// REPLAY_AT=2026-11-03T21:40 (UTC): repite ese momento en modo caza desde Leones, para probar (no toca el estado).
const REPLAY = env.REPLAY_AT ? Date.parse(env.REPLAY_AT.endsWith('Z') ? env.REPLAY_AT : env.REPLAY_AT + 'Z') : null;
const NOW = REPLAY ? REPLAY + 15 * 60e3 : Date.now(); // en vivo el satélite llega con ~15 min de atraso: se simula igual
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
  const cells = zoneCells(data.grid, data.towns, idx); // grilla + pueblos: la zona n.º 1 es la de mayor puntaje
  // Igual que el panel: ventana de horas y corrección aprendida. ctr_modelo queda para el historial,
  // que mide el error contra el modelo sin corregir (si no, la corrección se mediría contra sí misma).
  const hourOf = (j) => { const t = data.times[j]; return +t.slice(11, 13) + (t.startsWith(date) ? 0 : 24); };
  return huntZones(cells, data.towns, max).map((z) => {
    const dt = BIAS?.aplicado ? BIAS.horas : 0, acuerdo = zoneAgreement(MOD, z.ctr, z.r, date);
    return {
      ...shiftZone(z, BIAS), ctr_modelo: z.ctr, dt, acuerdo,
      ventana: widenWindow(correctedWindow(zoneWindow(z, data.grid.pts, data.grid.score, idx, hourOf), BIAS), acuerdo, dt),
    };
  });
}
function modelsLine(z) {
  const a = z.acuerdo;
  if (!a) return null;
  const per = a.por_modelo.map((m) => `${m.modelo} ${m.v}${m.v >= 45 ? ` (${clock((m.hora + (z.dt ?? 0)) * 60)})` : ''}`).join(' · ');
  const txt = { alto: '✅ coinciden todos', medio: '🟡 coinciden algunos', bajo: '⚠️ solo uno la ve' }[a.acuerdo];
  return `🧮 Modelos: ${per} → ${txt} (${a.coinciden} de ${a.total})`;
}
const ventana = (z) => (z.ventana ? `${clock(z.ventana[0] * 60)}–${clock(z.ventana[1] * 60)}` : null);
function biasLine() {
  if (!BIAS?.aplicado) return null;
  const d = Math.round(Math.hypot(BIAS.este_km, BIAS.norte_km));
  const dir = d ? `${d} km al ${rumbo((Math.atan2(BIAS.este_km, BIAS.norte_km) * 180) / Math.PI)}` : 'en el mismo lugar';
  const hr = Math.abs(BIAS.horas) < 0.25 ? 'a la hora pronosticada' : `${Math.abs(BIAS.horas).toFixed(1).replace('.', ',')} h ${BIAS.horas > 0 ? 'más tarde' : 'más temprano'}`;
  return `📚 <i>Corregido con ${BIAS.dias_usados} días: las tormentas venían apareciendo ${dir} y ${hr}.</i>`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Otras zonas a las que se puede ir (2.ª a 4.ª), una línea cada una.
// Opciones (paradas) del día, como en el panel: estación de servicio más cercana al punto ideal
// y primero las que se llega a tiempo desde Leones.
// ¿Conviene ir? No si el pico es de noche, si es un viaje largo (> 2 h 30) para un día moderado, o si los
// modelos no coinciden (solo uno la ve). Devuelve la lista de motivos (vacía = conviene).
function porQueNo(o, date) {
  const m = [];
  const ocaso = sunsetHour(HOME.lat, HOME.lon, date);
  const inicio = o.z.ventana ? o.z.ventana[0] : o.peakH;
  if (inicio > ocaso - 0.5) m.push(`el pico es de noche (${clock(o.peakH * 60)} h; el sol se pone ${clock(ocaso * 60)} h)`);
  if (o.z.v < 60 && o.drive > 2.5) m.push(`son ${dur(o.drive)} de viaje para un día moderado`);
  if (o.z.acuerdo?.acuerdo === 'bajo') m.push('los modelos no coinciden (solo uno la ve)');
  return m;
}
const optCache = {};
async function optionsFor(date) {
  if (optCache[date]) return optCache[date];
  const zs = zonesFor(date, 4);
  if (!zs.length) return (optCache[date] = []);
  const nowH = date === today ? nowMin / 60 : null;
  const base = huntOptions(zs, data.towns, data.times, date, HOME, null, nowH);
  // Parada rural: sobre ruta asfaltada, lejos de los pueblos, ojalá en un cruce con salida hacia el lado bueno.
  // false = se buscó y no hay (no se vuelve a pedir).
  delete state.stops; state.stopsR ??= {}; state.places ??= {};
  for (const o of base) {
    const k = plainKey(o.base);
    if (k in state.stopsR) continue;
    await sleep(1100); // OpenStreetMap pide como máximo 1 consulta por segundo
    state.stopsR[k] = (await ruralStop(o.base, (o.mdir - 90 + 360) % 360)) || false;
  }
  const opts = huntOptions(zs, data.towns, data.times, date, HOME, (bp) => state.stopsR[plainKey(bp)] || null, nowH);
  for (const o of opts) {
    const k = plainKey(o.vp);
    if (!(k in state.places)) { await sleep(1100); state.places[k] = await placeName(o.vp); }
    o.place = state.places[k];
    o.noConviene = porQueNo(o, date);
  }
  // Primero las que conviene (de día, cerca o día claro, modelos de acuerdo); el resto queda igual.
  opts.sort((a, b) => (a.noConviene.length > 0) - (b.noConviene.length > 0));
  return (optCache[date] = opts);
}
const stopLine = (o) => o.stop?.kind === 'rural' ? `🌾 <b>${esc(o.stop.label)}</b>`
  : `<b>${esc(o.stop?.label ?? 'punto aproximado')}</b>${o.place ? ` · cerca de ${esc(o.place.place)}${o.place.road ? ` (${esc(o.place.road)})` : ''}` : ''}`;
// Qué tiene de bueno la parada rural: cruce, salida y dónde cargar nafta antes.
const stopWhy = (o) => {
  const st = o.stop, away = rumbo(o.mdir - 90);
  if (st?.kind !== 'rural') return `   Punto aproximado al ${away} del camino de las tormentas: buscá cerca una ruta asfaltada con campo abierto, fuera del pueblo`;
  return `   Campo abierto al ${away} del camino de las tormentas${st.cruce ? ' · <b>cruce de rutas</b> (dos salidas)' : ''}${st.escape ? ` · salida hacia el ${away} para alejarte` : ''}`
    + (st.pueblo ? `\n   ⛽ Cargá nafta y comprá algo antes, en ${esc(st.pueblo.name)}` : '');
};
const ruta = (p) => maps(+p.lat.toFixed(4), +p.lon.toFixed(4));
// 🗺️ Mapa para Telegram (scripts/mapa.py): rutas de fondo, tormentas con su camino, vos y adónde ir.
// Sin enviar (panel, DRY_RUN) no se dibuja, salvo MAPA=1 (pruebas).
let mapN = 0;
const RUMBO_DEG = { norte: 0, noreste: 45, este: 90, sudeste: 135, sur: 180, sudoeste: 225, oeste: 270, noroeste: 315 };
const coreSpec = (c) => ({ lat: c.lat, lon: c.lon, fuerza: c.fuerza, mov_deg: c.mov_deg ?? RUMBO_DEG[c.va_hacia] ?? null, kmh: c.kmh ?? null, label: `${c.fuerza} ${c.tope_min_C} °C` });
async function mapa(spec) {
  if (env.DRY_RUN && !env.MAPA) return null;
  try {
    mapN++;
    const out = `${dir}/mapa_${mapN}.png`, req = `${dir}/mapa_${mapN}.json`;
    await writeFile(req, JSON.stringify({ ...spec, out }));
    await promisify(execFile)('python3', [fileURLToPath(new URL('./mapa.py', import.meta.url)), req], { timeout: 90000 });
    return out;
  } catch (e) { console.error('mapa falló:', e.message); return null; }
}
// Pin de Telegram: al tocarlo se abre en el mapa del celular para ir.
const pin2 = (p, title, address = '') => ({ venue: { lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), title: String(title).slice(0, 60), address: String(address).slice(0, 100) } });
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

// 📋 Plan de caza con pasos y horarios, como hacen los cazadores: base rural, esperar, decidir, moverse, volver.
function planDe(o, opts, date) {
  const ocaso = sunsetHour(HOME.lat, HOME.lon, date);
  const inicio = o.z.ventana ? o.z.ventana[0] : o.peakH - 1;
  const decision = Math.min(ocaso - 1, Math.max(inicio + 1.5, o.arriveAt + 0.5));
  // Plan B: otra zona que convenga, a menos de 1 h 30 de la base, con pico después de la hora de decidir.
  const b = opts.find((x) => x !== o && !x.noConviene?.length && x.z.v >= MIN && x.peakH >= decision && driveHours(km(o.vp, x.vp)) <= 1.5);
  const planB = b ? { zona: b.z.name, v: b.z.v, vp: b.vp, label: b.stop?.label ?? null, km: Math.round(km(o.vp, b.vp)), pico: b.peakH } : null;
  return { inicio, decision, ocaso, planB, from: rumbo(o.mdir + 180) };
}
function planLines(o, p) {
  return [
    '📋 <b>TU PLAN</b>',
    `1️⃣ <b>${o.late ? 'Ahora' : clock(o.leave * 60)}</b> · Salí de Leones a la base: ${stopLine(o)} (~${dur(o.drive)})`,
    `2️⃣ <b>${clock(o.arriveAt * 60)}–${clock(p.decision * 60)}</b> · Esperá en la base mirando el cielo hacia el <b>${p.from}</b>. No hace falta mirar el celular: si nace algo, te aviso.`,
    `3️⃣ <b>Si nace una tormenta</b>, te llega 🎯 con el punto para verla, el mapa y la ruta. Andá ahí: de costado, nunca adelante.`,
    `4️⃣ <b>${clock(p.decision * 60)}</b> · Decisión: si no nació nada a menos de 60 km, ${p.planB ? `andá al plan B: Zona ${esc(p.planB.zona)} (${p.planB.v}), a ${p.planB.km} km de la base` : '<b>volvé</b>'}. Te aviso a esa hora.`,
    `5️⃣ <b>${clock(p.ocaso * 60)}</b> · Se pone el sol: volvé aunque siga.`,
    '🛡️ <b>Seguridad</b>: viajás con el cielo seco (llegás 1 h 30 antes de que nazcan). Si en el camino aparece una tormenta, te aviso que esperes bajo techo. ⚡ Adentro del auto estás protegido de los rayos: no te bajes si hay rayos cerca. 🧊 Siempre te dejo del lado sin granizo.',
    '<i>Al salir mandá /caza y compartí la ubicación en tiempo real: así todo se calcula desde donde estés.</i>',
  ];
}
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
  const others = opts.slice(1).map((x, k) => `${['2️⃣', '3️⃣', '4️⃣'][k]} Zona ${esc(x.z.name)} · <b>${x.z.v}</b> · pico ${clock(x.peakH * 60)} h${x.noConviene?.length ? ` · ⚠️ no conviene: ${x.noConviene[0]}` : ''}\n   👁 ${stopLine(x)}\n   ${x.dist} km · ${timeLine(x)}${x.hit ? ' ⚠️' : ''} · <a href="${ruta(x.vp)}">ruta</a>`);
  return [
    score >= CLARO ? `🌪️ <b>DÍA DE CAZA · ${label}</b> <i>${dayName(date)}</i>`
      : score >= MIN ? `🟠 <b>DÍA POSIBLE · ${label}</b> <i>${dayName(date)}</i>\n<i>Potencial moderado: no es un día claro. Vale si estás cerca o con ganas de probar. Si sube a ${CLARO}+, te aviso de nuevo.</i>`
      : `🧪 <b>Prueba · ${label}</b> <i>${dayName(date)}</i> · no llega a día de caza`,
    `Potencial de tornado <b>${lv.label.toUpperCase()} · ${score}/100</b>${prev >= 0 ? ` <i>(subió de ${prev})</i>` : ''}`,
    '',
    `🎯 <b>Zona ${esc(o.z.name)}</b> · pico a las <b>${clock(o.peakH * 60)} h</b>${ventana(o.z) ? ` · ventana ${ventana(o.z)}` : ''}`,
    modelsLine(o.z),
    biasLine(),
    ...(o.noConviene?.length ? [`⚠️ <b>No conviene ir</b>: ${o.noConviene.join('; ')}.`] : ['', ...planLines(o, planDe(o, opts, date)), '']),
    `👁 Parar en: ${stopLine(o)}`,
    `${stopWhy(o)} · <a href="${ruta(o.vp)}">Ruta a la parada</a>`,
    `🚗 ${o.dist} km en línea recta, ~${dur(o.drive)} desde Leones`,
    !o.reachable ? '⏰ <b>Ya no llegás antes del pico</b>: si estás cerca, seguí el radar'
      : o.late ? `⏰ <b>Salí ya</b>: llegás a las ${clock(o.arriveAt * 60)} h`
      : `⏰ Salir a las <b>${clock(o.leave * 60)}</b>${o.safe != null ? ' (antes de que las tormentas crucen tu camino)' : ' para llegar 1 h antes'}`,
    o.hit ? `⚠️ <b>El camino cruza el paso de las tormentas</b> cerca de las ${clock(o.hit.h * 60)} h: entrá por el ${side}, sin cruzar por delante.`
      : o.mspd != null && o.reachable ? '✅ Con ese horario el camino no cruza por delante de las tormentas' : null,
    o.mspd != null ? `➡️ Las tormentas van hacia el <b>${rumbo(o.mdir)}</b> a ${o.mspd} km/h` : null,
    '',
    `<b>Ingredientes de la zona</b> (${esc(t.name)}, ${clock((o.peakH - (o.z.dt ?? 0)) * 60)} h, según el modelo)`,
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
    // El aviso de MAÑANA y el de HOY (con el plan y los horarios actualizados) se mandan los dos.
    const k = off === 0 ? date : `${date}:m`;
    const prev = state.days[k] ?? -1;
    const fire = sc >= MIN && sc >= prev + 10 && !quiet;
    if (fire) state.days[k] = sc;
    if (fire || (test && (off === 0 || sc >= MIN))) messages.push(await huntMessage(date, label, rank, fire ? prev : -1));
    // Plan de hoy (para avisar si después cambia): la zona y la parada que se mandaron.
    if (fire && off === 0) {
      const o = (await optionsFor(date))[0];
      if (o) { const pl = planDe(o, await optionsFor(date), date);
        state.plan = { date, zona: o.z.name, ctr: o.z.ctr, v: o.z.v, stop: o.stop?.label ?? null, base: { lat: o.vp.lat, lon: o.vp.lon }, llegada: o.arriveAt, inicio: pl.inicio, decision: pl.decision, ocaso: pl.ocaso, planB: pl.planB, t: NOW }; messages.push(pin2(o.vp, `Parada · Zona ${o.z.name}`, o.stop?.label ?? 'punto aproximado')); }
    }
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
        hora_pico: clock(o.peakH * 60), ventana_horas: ventana(o.z),
        modelos: o.z.acuerdo ? { coinciden: o.z.acuerdo.coinciden, de: o.z.acuerdo.total, acuerdo: o.z.acuerdo.acuerdo, por_modelo: o.z.acuerdo.por_modelo.map((m) => ({ modelo: m.modelo, potencial: m.v, hora_pico: clock((m.hora + (o.z.dt ?? 0)) * 60) })) } : null,
        // Sin la corrección aprendida: el historial mide el error contra esto.
        hora_pico_modelo: clock((o.peakH - (o.z.dt ?? 0)) * 60), centro_modelo: { lat: +o.z.ctr_modelo.lat.toFixed(2), lon: +o.z.ctr_modelo.lon.toFixed(2) },
        parada: { nombre: o.stop?.label ?? null, tipo: o.stop?.kind ?? null, cerca_de: o.place?.place ?? null, ruta: o.place?.road ?? null, lat: +o.vp.lat.toFixed(3), lon: +o.vp.lon.toFixed(3) },
        conviene: !(o.noConviene?.length), por_que_no_conviene: o.noConviene ?? [],
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
    nucleos_satelite: await (async () => {
      try {
        const n = JSON.parse(await readFile(`${dir}/nowcast.json`, 'utf8'));
        const r3 = (p) => ({ lat: +p.lat.toFixed(2), lon: +p.lon.toFixed(2) });
        return { hora: n.hora, hora_anterior: n.hora_anterior, como_leer: n.como_leer, nucleos: n.celulas.slice(0, 12).map((c) => {
          if (!n.hora_utc || c.mov_deg == null || !c.kmh) return c;
          const now = coreAt(c, n.hora_utc, NOW);
          return { ...c, ahora_estimado: r3(now), en_30_min: r3(movePoint(now, c.mov_deg, c.kmh / 2)), en_60_min: r3(movePoint(now, c.mov_deg, c.kmh)), atraso_min: Math.round(now.edadMin) };
        }) };
      } catch { return null; }
    })(),
    plan: state.plan?.date === today && !state.plan.cerrado ? { zona: state.plan.zona, base: state.plan.stop, hora_de_decidir: state.plan.decision != null ? clock(state.plan.decision * 60) : null, puesta_de_sol: state.plan.ocaso != null ? clock(state.plan.ocaso * 60) : null, plan_b: state.plan.planB?.zona ?? null } : null,
    escape: ESCAPE,
    intercepcion: INTER ? {
      tormenta: { lat: +INTER.c.lat.toFixed(2), lon: +INTER.c.lon.toFixed(2), aislada: INTER.aislada, fuerza: INTER.c.fuerza, va_hacia: rumbo(INTER.mdir), kmh: INTER.c.kmh, km_desde: INTER.d, rumbo_desde: INTER.desde },
      desde: INTER.desde_quien, quedate: INTER.quedate,
      punto: { nombre: INTER.stop?.label ?? 'punto aproximado', lat: +INTER.p.lat.toFixed(3), lon: +INTER.p.lon.toFixed(3), cruce: INTER.stop?.cruce ?? false },
      chances_tornado: INTER.tornado ? { nivel: INTER.tornado.nivel, ambiente: INTER.tornado.env, por_que: INTER.tornado.motivos } : null,
      llegas_en_min: INTER.llegas_min, la_tormenta_pasa_en_min: INTER.pasa_min, pasa_por_el: rumbo(INTER.mdir + 90), escapar_hacia: rumbo(INTER.away),
    } : null,
    vos: state.chase?.on && state.chase.loc ? { lat: +state.chase.loc.lat.toFixed(3), lon: +state.chase.loc.lon.toFixed(3), hace_min: Math.round((Date.now() - state.chase.loc.t) / 60000), modo_caza: true } : null,
    imagenes: await (async () => { try { return JSON.parse(await readFile(`${dir}/img/meta.json`, 'utf8')).imagenes.map((x) => ({ ...x, url: `data/img/${x.archivo}` })); } catch { return []; } })(),
    nota: 'Potencial 0–100 de supercélulas con rotación según modelos (no es un aviso de tornado). Radar de velocidad no disponible.',
  };
}

const AI_RULES = `Sos un cazador de tormentas experto del Pasillo de los Tornados (Argentina, hemisferio sur) y le hablás a un aficionado
que sale desde Leones (Córdoba). Con el resumen JSON que sigue, decile QUÉ HACER AHORA, en castellano rioplatense, simple y concreto.
Reglas obligatorias:
- Máximo 6 líneas cortas. Nada de introducciones. Empezá con la decisión: "Salí", "Esperá", "Quedate", "Movete" o "Hoy no salgas".
- Usá solo los datos del JSON: nombrá la parada, la hora de salida y la ruta si están. No inventes lugares, rutas ni datos.
- Las paradas son RURALES (sobre ruta asfaltada, afuera de los pueblos, ojalá en un cruce): nunca mandes a esperar adentro de una ciudad,
  porque ahí no se ve nada y cuando llega la tormenta no se puede salir. A los pueblos solo se va a cargar nafta antes.
- Si existe "plan", el usuario está siguiendo ese plan: no lo contradigas. Decile en qué paso está (ir a la base, esperar,
  interceptar si nació algo, decidir a la "hora_de_decidir", volver antes de la "puesta_de_sol"). Solo cambialo si hay una
  tormenta o un aviso nuevo que lo justifique, y decí por qué.
- Si existe "escape", hay una tormenta encima o muy cerca: decí EXACTAMENTE hacia dónde moverse (rumbo, km y el punto si tiene
  nombre), con esas palabras. Nunca digas solo "movete" sin rumbo ni distancia.
- Si NO existe "intercepcion", NUNCA recomiendes ir a buscar ninguna tormenta del satélite: o se aleja, o no se llega a
  tiempo de costado, y perseguirla de atrás mete al usuario en la lluvia y el granizo. Decí que no conviene.
- Es una app de TORNADOS: decí siempre las "chances_tornado" de la tormenta (alta/media) y por qué. Las tormentas sin
  chances de tornado no se van a buscar.
- Si existe "intercepcion", ese es el punto CALCULADO para ver la mejor tormenta (al costado de su camino, adelante, llegando antes
  que ella y sin cruzarse por delante): recomendá ESE punto con su nombre, cuánto tardás, cuándo pasa la tormenta y hacia dónde escapar.
  No inventes otro punto. Si "aislada" es false, aclará que hay otras tormentas cerca y que es más difícil de ver.
- Si hay avisos a corto plazo del SMN cerca (< 80 km), priorizalos: decí dónde están y hacia dónde moverse para quedar de costado.
- Seguridad: nunca recomiendes acercarse a menos de 15 km de una tormenta, ponerse delante de su camino, caminos de tierra,
  ni salir o seguir de noche (después de la puesta del sol). Interceptar de costado (lado norte si van al este), nunca perseguir por detrás.
- Si ninguna opción llega a tiempo o el potencial es < 45, decí que hoy no conviene.
- NUNCA recomiendes una opción con "conviene": false (pico de noche, viaje largo para un día moderado o modelos que
  no coinciden): si todas son así, decí "Hoy no salgas" y por qué.
- No prometas tornados: hablá de "chances".
- "nucleos_satelite" son tormentas detectadas AHORA por satélite (topes fríos). Si "vos" existe, es la ubicación del usuario:
  decí a qué distancia y rumbo desde él está la mejor tormenta y si conviene quedarse o moverse (rumbo y km aproximados) para
  quedar de costado y adelante de ella, a unos 20 km. Si una viene hacia él, avisá cuánto falta y hacia dónde correrse.`;

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
- "zoom satélite alta resolución, tormenta N": recorte de ~300 km en infrarrojo realzado (cruz negra = núcleo; colores: celeste/azul
  −30/−52 °C, verde −52/−58, amarillo −58/−63, naranja −63/−70, rojo −70/−75, magenta/blanco < −75). Buscá señales de supercelda:
  un punto mucho más frío y aislado (tope que sobresale), una "V" o "U" fría abierta hacia atrás del movimiento (enhanced-V / cold-U),
  un anillo frío, y si el núcleo está aislado o metido en una línea. El gancho de radar NO se ve en satélite: no lo menciones como visto.
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


/* ---------- 🎯 Punto para ver una tormenta en vivo (modo caza y aviso del satélite) ---------- */
// La mejor tormenta aislada a la que llegás: punto al costado de su camino, adelante, enganchado a una ruta rural.
let INTER = null, ESCAPE = null;
async function intercept(me, nc) {
  const x = mejorIntercepcion({ me, nc, now: NOW, moderadas: true, data });
  if (!x) return null;
  const st = await ruralStop(x.base, x.away, fetch, 8);
  const p = st ?? x.base;
  return (INTER = { ...x, stop: st, p, desde_quien: me === HOME ? 'Leones' : 'vos' });
}
function interceptLines(x) {
  const c = x.c, pasaDir = rumbo(x.mdir + 90);
  const sig = [c.topes_sobresalientes ? '⚡ topes que sobresalen (un "chichón" arriba: sube con mucha fuerza)' : null, c.salto_rayos ? '⚡⚡ salto de rayos' : null].filter(Boolean).join(', ');
  return [
    ...(x.tornado ? [`🌪️ <b>Chances de tornado de esta tormenta: ${x.tornado.nivel.toUpperCase()}</b> · ${esc(x.tornado.motivos.join(', '))}`] : []),
    ...(x.moderada ? ['🎯 <i>Tormenta moderada aislada: para ir a mirarla, con pocas chances de tornado (en el radar puede verse más fuerte que en el satélite).</i>'] : []),
    '✅ <b>Camino y punto sin lluvia ni granizo</b> (según el satélite, contando el tamaño de cada tormenta y cómo se mueve).',
    `🎯 <b>Para verla:</b> ${x.aislada ? '<b>tormenta aislada</b>' : x.puntaNorte ? 'tormenta del <b>extremo norte</b> del grupo (la que mejor recibe el aire cálido)' : 'tormenta (hay otras cerca)'} ${esc(c.fuerza)} a ${x.d} km al ${x.desde} ${x.desde_quien === 'vos' ? 'tuyo' : 'de Leones'}, va al <b>${rumbo(x.mdir)}</b> a ~${c.kmh} km/h${sig ? ` · ${sig}` : ''}`,
    x.quedate ? `   <b>Quedate donde estás</b>: pasa a ~${x.lado} km al ${pasaDir} tuyo en ~${x.pasa_min} min`
      : `   Andá a ${x.stop ? `🌾 <b>${esc(x.stop.label)}</b>${x.stop.cruce ? ' (cruce, dos salidas)' : ''}` : 'este punto'} · llegás en ~${x.llegas_min} min, ella pasa a ~${x.lado} km al <b>${pasaDir}</b> tuyo en ~${x.pasa_min} min`,
    `   🧊 El granizo cae del lado ${pasaDir} de la tormenta: vos quedás del otro lado${x.granizo_grande ? `, a ${x.lado} km porque tiene señales de <b>granizo grande</b>` : ''}.`,
    `   Si se te acerca, escapá hacia el <b>${rumbo(x.away)}</b>. Nunca te cruces por delante. <a href="${ruta(x.p)}">🗺️ Ruta al punto</a>`,
  ];
}

// Qué hacer con una tormenta que está cerca: hacia dónde, cuántos km y hasta qué punto (sobre ruta asfaltada).
async function escapeLines(c, me) {
  const x = comoAlejarse(c, me);
  if (x.seVa) return ['', '✅ <b>Se está alejando de vos</b>: no hace falta que te muevas.'];
  const dest = await ruralStop(movePoint(me, x.escape, x.km), x.escape, fetch, 8);
  const p = dest ?? movePoint(me, x.escape, x.km);
  ESCAPE = { hacia: x.rumbo_escape, km: x.km, punto: dest?.label ?? null, lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3), fuerte: x.fuerte, pasa_a_km: x.pasa_a, en_min: x.en_min };
  return [
    '',
    x.sinMovimiento ? `No se sabe bien hacia dónde va: <b>alejate en línea recta</b>.`
      : `${x.pasa_a < 3 ? '<b>Viene derecho hacia vos</b>' : `Va a pasar a <b>~${x.pasa_a} km</b> tuyo`}${x.en_min ? `: llega en <b>~${x.en_min} min</b>` : ' (ya está encima)'}${x.lado_granizo ? ' · ❗ estás del lado donde cae el granizo' : ''}.`,
    x.fuerte ? `👉 <b>Movete ya ~${x.km} km hacia el ${x.rumbo_escape}</b>${dest ? `, hasta 🌾 <b>${esc(dest.label)}</b>` : ''}. No la cruces por delante.`
      : `Es <b>moderada</b>: lluvia fuerte y rayos, sin señales de granizo grande.\n👉 Si no querés que te agarre, movete <b>~${x.km} km hacia el ${x.rumbo_escape}</b>${dest ? `, hasta 🌾 <b>${esc(dest.label)}</b>` : ''}.`,
    `<a href="${ruta(p)}">🗺️ Ruta para alejarte</a>`,
  ];
}

// 👀 Guía visual y 📡 cómo leer el radar del SMN, con los rumbos de ESTA tormenta (hemisferio sur: la supercelda
// gira del lado izquierdo-atrás de su camino; el granizo y la lluvia fuerte caen adelante a la derecha).
const RADAR_SMN = 'https://www.smn.gob.ar/radar';
function guiaLines(mdir) {
  const atras = rumbo(mdir + 180), gancho = rumbo(mdir - 135), granizo = rumbo(mdir + 45);
  return [
    '👀 <b>QUÉ MIRAR EN EL CIELO</b>',
    `1. La <b>base</b> de la tormenta del lado <b>${gancho}</b> (atrás, a la izquierda de su camino): ahí sube el aire y es donde se forma el tornado.`,
    '2. <b>Nube pared</b>: un pedazo de la base que baja, oscuro, como un escalón. Si la ves <b>girar</b> o moverse de costado, hay rotación.',
    '3. <b>Tornado</b>: un embudo que baja de la nube pared, o polvo y restos girando en el suelo debajo de ella, aunque no se vea el embudo entero.',
    `4. La <b>cortina blanca o gris</b> del lado <b>${granizo}</b> es lluvia fuerte y granizo: siempre lejos, nunca te metas.`,
    '5. Si el viento sopla cálido <b>hacia</b> la tormenta, estás bien ubicado. Si de golpe sopla frío <b>desde</b> la tormenta, o llueve gordo, alejate.',
    '',
    `📡 <b>CÓMO LEER EL <a href="${RADAR_SMN}">RADAR DEL SMN</a></b> (elegí el radar más cercano: Córdoba, Pergamino o Paraná)`,
    '• Verde = lluvia · amarillo/naranja = fuerte · <b>rojo/violeta/blanco = muy fuerte o granizo</b>.',
    `• <b>Gancho</b>: una "cola" que se curva del lado <b>${gancho}</b> de la tormenta, como una coma o un 6. Es la firma de la supercelda con rotación: ahí puede estar el tornado.`,
    '• Tocá ▶ para ver la animación: si el núcleo se "dobla" y crece rápido, se está organizando.',
    `• Ella viene del <b>${atras}</b>. Vos parate de costado, del lado contrario a la cortina de granizo, a 15–20 km.`,
  ];
}

/* ---------- 🎯 Modo caza: ubicación en vivo por Telegram + núcleos del satélite ---------- */
// El usuario comparte su ubicación en tiempo real con el bot (o manda /caza) y el sistema le avisa en cada corrida
// si nace, crece o se acerca una tormenta, con la recomendación de la IA. /fin lo apaga.
state.chase ??= { on: false };
const chaseOut = [];
async function readTelegram() {
  const { TELEGRAM_BOT_TOKEN: tk, TELEGRAM_CHAT_ID: ch } = env;
  if (!tk || !ch) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tk}/getUpdates?offset=${(state.tgOffset ?? 0) + 1}&timeout=0`);
    if (!r.ok) return;
    for (const u of (await r.json()).result ?? []) {
      state.tgOffset = Math.max(state.tgOffset ?? 0, u.update_id);
      const m = u.message || u.edited_message;
      if (!m || String(m.chat?.id) !== String(ch)) continue;
      if (m.location) {
        const was = state.chase.on;
        state.chase.loc = { lat: m.location.latitude, lon: m.location.longitude, t: (m.edit_date || m.date) * 1000 };
        if (!was) { state.chase.on = true; state.chase.since = Date.now(); state.chase.welcome = true; state.chase.guia = false; }
      }
      const txt = (m.text || '').trim().toLowerCase();
      if (/^\/?caza\b/.test(txt)) { state.chase.on = true; state.chase.since = Date.now(); state.chase.welcome = true; state.chase.guia = false; }
      if (/^\/?guia\b|^\/?guía\b/.test(txt)) state.chase.pideGuia = true;
      if (/^\/?(fin|stop|basta)\b/.test(txt)) { state.chase.on = false; chaseOut.push('🏁 <b>Modo caza apagado.</b> Buen regreso.'); }
      if (/^\/?estado\b/.test(txt)) state.chase.force = true;
    }
  } catch (e) { console.error('Telegram (lectura) falló:', e.message); }
}
if (REPLAY) {
  messages.length = 0; // solo lo en vivo (modo caza / satélite)
  state.satSeen = {}; state.satLast = 0;
  state.chase = env.REPLAY_NOCHASE ? { on: false } : { on: true, since: NOW, loc: { lat: HOME.lat, lon: HOME.lon, t: NOW }, force: true, seen: {}, lastMsg: 0 };
} else if (!env.DRY_RUN) await readTelegram(); // sin enviar (panel): no consumir /caza, lo lee el vigía

const ANG = { norte: 0, noreste: 45, este: 90, sudeste: 135, sur: 180, sudoeste: 225, oeste: 270, noroeste: 315 };
if (state.chase.on) {
  const loc = state.chase.loc;
  const stale = loc && NOW - loc.t > 90 * 60e3;
  if (stale || (!loc && Date.now() - (state.chase.since ?? 0) > 3 * 3600e3)) {
    state.chase.on = false;
    chaseOut.push('🏁 <b>Modo caza apagado</b>: hace rato que no recibo tu ubicación. Mandá /caza o compartí la ubicación para volver a prenderlo.');
  } else if (state.chase.welcome) {
    state.chase.welcome = false;
    chaseOut.push(loc ? '🎯 <b>Modo caza activado.</b> Tengo tu ubicación: te aviso si nace, crece o se acerca una tormenta. /fin para apagarlo.'
      : '🎯 <b>Modo caza activado.</b> Compartime tu <b>ubicación en tiempo real</b> (📎 → Ubicación → Compartir en tiempo real) para decirte adónde moverte. /guia: qué mirar en el cielo y en el radar. /fin para apagarlo.');
  }
}

let chaseEvent = null;
// /guia sin tormenta cerca: rumbo típico del Pasillo (van hacia el este).
if (state.chase?.pideGuia && !REPLAY) {
  messages.push(guiaLines(90).join('\n'));
  state.chase.pideGuia = false;
}
if (state.chase.on && state.chase.loc) {
  const me = state.chase.loc;
  let nc = null;
  try { nc = JSON.parse(await readFile(`${dir}/nowcast.json`, 'utf8')); } catch { /* sin satélite */ }
  const ncFresh = nc?.hora_utc && NOW - Date.parse(nc.hora_utc) < 90 * 60e3; // sin dato reciente, no avisar
  const cores = (ncFresh ? nc.celulas : []).map((c0) => {
    // Posición estimada AHORA (el satélite llega con 10–30 min de atraso).
    const est = nc.hora_utc ? coreAt(c0, nc.hora_utc, NOW) : { lat: c0.lat, lon: c0.lon, edadMin: 0 };
    const c = { ...c0, lat: est.lat, lon: est.lon, edadMin: Math.round(est.edadMin) };
    const d = Math.round(km(me, c)), toMe = bearing(c, me);
    const mv = c.mov_deg ?? (c.va_hacia ? ANG[c.va_hacia] : null);
    const diff = mv == null ? null : Math.abs(((mv - toMe + 540) % 360) - 180);
    const coming = diff != null && diff < 45 && c.kmh ? Math.round((d / c.kmh) * 60) : null;
    return { ...c, d, from: rumbo(bearing(me, c)), coming };
  }).filter((c) => c.d <= 150).sort((a, b) => a.d - b.d);
  const strong = (c) => c.fuerza !== 'moderada' || c.topes_sobresalientes > 0;
  state.chase.seen ??= {};
  const key = (c) => `${c.lat.toFixed(1)},${c.lon.toFixed(1)}`;
  // Chances de tornado de cada tormenta (ambiente del pronóstico donde está + señales del satélite).
  for (const c of cores) c.tornado = potencialTornado(c, data, NOW, { aislada: !cores.some((o) => o !== c && km(o, c) < 40) });
  const conChances = (c) => !data || (c.tornado && (c.tornado.nivel === 'alta' || (c.tornado.nivel === 'media' && c.tornado.env >= 60)));
  const news = cores.filter((c) => (c.tendencia === 'nueva' || c.tendencia === 'creciendo') && (strong(c) || c.d <= 60 || (c.d <= 100 && paraMirar(c, cores))) && conChances(c) && !state.chase.seen[key(c)]);
  const danger = cores.find((c) => c.d <= 20 || (c.coming != null && c.coming <= 40 && c.d <= 50));
  const acp = (smn?.alerts ?? []).filter((a) => a.shortTerm && distTo(a, me) <= 60 && !state.chase.seen['acp:' + a.id]);
  // 🌱 Puede estar naciendo una tormenta cerca: una nube que crece rápido en dos imágenes seguidas (no en la misma),
  // a menos de 60 km y con tope ya bajo −30 °C. Probado el 10/11: 1 de cada 3–4 terminó en tormenta, así que es
  // un "mirá hacia allá", no un "andá".
  const nacAhora = (ncFresh ? nc.nacimientos ?? [] : []).filter((n) => km(me, n) <= 60 && n.tope_C <= -30);
  const nacAntes = (state.chase.nacPrev ?? []).filter((p) => NOW - p.t < 60 * 60e3);
  const persiste = nacAhora.filter((n) => nacAntes.some((p) => p.hora !== nc.hora_utc && km(p, n) < 30));
  state.chase.nacPrev = [...nacAntes.filter((p) => p.hora !== nc?.hora_utc), ...nacAhora.map((n) => ({ lat: n.lat, lon: n.lon, t: NOW, hora: nc.hora_utc }))].slice(-30);
  const nKey = (n) => 'nac:' + `${n.lat.toFixed(1)},${n.lon.toFixed(1)}`;
  const nac = persiste.filter((n) => !state.chase.seen[nKey(n)]).sort((a, b) => km(me, a) - km(me, b))[0];
  if (nac && NOW - (state.chase.lastNac ?? 0) > 20 * 60e3) {
    const d = Math.round(km(me, nac)), dir = rumbo(bearing(me, nac));
    chaseOut.push([
      `👉 <b>QUÉ HACER: mirá hacia el ${dir}. Todavía no te muevas</b>`,
      '',
      `🌱 <b>Puede estar naciendo una tormenta</b> a ${d} km al ${dir} tuyo (${esc(nac.cerca_de)}): una nube que crece rápido (tope ${nac.tope_C} °C, se enfrió ${Math.round(nac.enfrio_C)} °C en 30 min).`,
      'Fijate si ves una torre blanca que sube como coliflor. <i>De cada 3–4 nubes así, una termina en tormenta.</i> Si crece, te llega el 🎯 con adónde ir.',
    ].join('\n'));
    state.chase.seen[nKey(nac)] = NOW; state.chase.lastNac = NOW;
  }
  // 🧊 Se te viene el granizo: tiene prioridad sobre todo (no espera el intervalo entre mensajes).
  const gr = peligroGranizo({ me, nc: ncFresh ? nc : null, now: NOW });
  const grKey = gr ? 'gr:' + `${gr.c.lat.toFixed(1)},${gr.c.lon.toFixed(1)}` : null;
  let grSent = false;
  if (gr && NOW - (state.chase.seen[grKey] ?? 0) > 15 * 60e3 && NOW - (state.chase.lastGr ?? 0) > 12 * 60e3) {
    const dest = await ruralStop(movePoint(me, gr.escape, 12), gr.escape, fetch, 8);
    const p = dest ?? movePoint(me, gr.escape, 12);
    const c = gr.c, sig = [c.tope_min_C <= -63 ? `topes muy fríos (${c.tope_min_C} °C)` : null, c.topes_sobresalientes ? 'topes que sobresalen' : null, c.salto_rayos ? 'salto de rayos' : null].filter(Boolean).join(', ');
    chaseOut.push([
      `👉 <b>QUÉ HACER: movete ya ~12 km hacia el ${gr.rumbo_escape}</b>`,
      '',
      `🧊 <b>SE TE VIENE EL GRANIZO</b>`,
      gr.en_min <= 3 ? `La tormenta está <b>encima o a ${gr.d} km</b> tuyo.` : `Una tormenta ${esc(c.fuerza)} ${gr.pasa_a < 3 ? '<b>viene derecho hacia vos</b>' : `va a pasar a <b>~${gr.pasa_a} km</b> tuyo`}: llega en <b>~${gr.en_min} min</b>${c.kmh ? ` (a ${c.kmh} km/h)` : ''}.`,
      ...(gr.grande ? [`⚠️ Señales de granizo grande: ${sig}.`] : []),
      gr.lado_granizo ? '❗ Estás del lado donde cae el granizo.' : null,
      `👉 <b>Movete ya ~12 km hacia el ${gr.rumbo_escape}</b>${dest ? `, hasta 🌾 <b>${esc(dest.label)}</b>` : ''}. No la cruces por delante.`,
      `<a href="${ruta(p)}">🗺️ Ruta para escapar</a>`,
      '<i>Si ya caen piedras: techo firme (estación de servicio, galpón) y lejos de los vidrios.</i>',
    ].filter(Boolean).join('\n'));
    const img = await mapa({ titulo: `Granizo: movete ya ${'~12 km'} al ${gr.rumbo_escape}`, pie: `Satélite ${nc?.hora ?? ''} h`, yo: { ...me, label: 'VOS' }, tormentas: [coreSpec(c)], escape: { ...p, label: dest ? `ESCAPÁ: ${dest.label}` : 'ESCAPÁ' } });
    if (img) chaseOut.push({ photo: img, caption: `🗺️ Azul = vos · círculo = tormenta y su camino (+30/+60 min) · violeta = granizo · flecha verde = hacia dónde escapar.` });
    chaseOut.push(pin2(p, `Escapá hasta acá (${gr.rumbo_escape})`, dest?.label ?? ''));
    state.chase.seen[grKey] = NOW; state.chase.lastGr = NOW; grSent = true;
  }
  const since = Date.now() - (state.chase.lastMsg ?? 0);
  if (grSent) state.chase.lastMsg = Date.now(); // el de granizo ya dice lo urgente
  else if (danger && since > 10 * 60e3) chaseEvent = { tipo: 'cerca', cores: [danger, ...news.filter((c) => c !== danger).slice(0, 2)] };
  else if ((news.length || acp.length) && since > 20 * 60e3) chaseEvent = { tipo: 'novedad', cores: news.slice(0, 3), acp };
  else if (state.chase.force) chaseEvent = { tipo: 'estado', cores: cores.slice(0, 3) };
  state.chase.force = false;
  if (chaseEvent) {
    for (const c of chaseEvent.cores) state.chase.seen[key(c)] = Date.now();
    for (const a of chaseEvent.acp ?? []) state.chase.seen['acp:' + a.id] = Date.now();
    state.chase.lastMsg = Date.now();
    const line = (c) => `• <b>${esc(c.fuerza)}</b> (${c.tope_min_C} °C${c.topes_sobresalientes ? `, ${c.topes_sobresalientes} topes que sobresalen` : ''}) · ${esc(c.tendencia)} · ${esc(c.cerca_de)}${c.tornado ? ` · 🌪️ chances de tornado <b>${c.tornado.nivel}</b>` : ''}\n   a <b>${c.d} km al ${c.from}</b> tuyo${c.va_hacia ? ` · va al ${c.va_hacia}${c.kmh ? ` a ${c.kmh} km/h` : ''}` : ''}${c.coming != null ? ` · <b>se acerca (~${c.coming} min)</b>` : ''}`;
    const age = chaseEvent.cores[0]?.edadMin;
    const conTornado = chaseEvent.cores.some((c) => c.tornado && c.tornado.nivel !== 'baja');
    const head = chaseEvent.tipo === 'cerca' ? '⚠️ <b>Tormenta cerca tuyo</b>' : chaseEvent.tipo === 'estado' ? '📍 <b>Cómo viene todo</b>' : conTornado ? '🌪️ <b>Tormenta con chances de tornado</b>' : '🛰️ <b>Se está formando algo</b>';
    const extra = chaseEvent.tipo === 'cerca' ? await escapeLines(chaseEvent.cores[0], me) : (await intercept(me, nc)) ? ['', ...interceptLines(INTER)] : null;
    const queHacer = chaseEvent.tipo === 'cerca' ? (ESCAPE ? `Movete ~${ESCAPE.km} km hacia el ${ESCAPE.hacia}${ESCAPE.fuerte ? ' ya' : ' (opcional: es moderada)'}` : 'Quedate: se está alejando')
      : INTER ? (INTER.quedate ? 'Quedate donde estás: la vas a ver pasar de costado' : `Andá al punto 🎯${INTER.stop ? ` (${INTER.stop.label})` : ''}: llegás en ~${INTER.llegas_min} min`)
      : 'Quedate: no hay ninguna para ver de costado';
    chaseOut.push([
      `👉 <b>QUÉ HACER: ${esc(queHacer)}</b>`,
      '',
      `${head} <i>(posición estimada ahora · satélite de las ${nc?.hora ?? '–'} h${age ? `, hace ${age} min` : ''})</i>`,
      ...(chaseEvent.cores.length ? chaseEvent.cores.map(line) : ['Sin núcleos de tormenta a menos de 150 km tuyo.']),
      ...(chaseEvent.acp ?? []).map((a) => `• 🚨 Aviso SMN: ${esc(a.event || a.headline)} a ${Math.round(distTo(a, me))} km`),
      ...(extra ? extra
        : chaseEvent.tipo === 'estado' ? ['', 'No hay ninguna tormenta fuerte a la que llegues a tiempo: <b>quedate donde estás</b> y esperá el próximo aviso.']
        : chaseEvent.cores.length ? ['', '➡️ <b>No hay forma de verla de costado con el camino limpio</b> (se aleja, va muy rápido o hay lluvia en el medio): <b>no vayas</b>. Quedate y esperá el próximo aviso.'] : []),
      `<a href="${RADAR_SMN}">📡 Radar SMN</a> · <a href="${PANEL}">🗺️ Panel</a>`,
    ].join('\n'));
    // Mapa con vos, las tormentas y adónde ir (o escapar). Si no sale, el zoom del satélite.
    const dest = chaseEvent.tipo === 'cerca' ? (ESCAPE ? { lat: ESCAPE.lat, lon: ESCAPE.lon, label: ESCAPE.punto ? `ESCAPÁ: ${ESCAPE.punto}` : `ESCAPÁ (${ESCAPE.hacia})`, esc: true } : null)
      : INTER ? { lat: INTER.p.lat, lon: INTER.p.lon, label: INTER.stop ? `IR ACÁ: ${INTER.stop.label}` : 'IR ACÁ (ver de costado)' } : null;
    const img = chaseEvent.cores.length ? await mapa({
      titulo: chaseEvent.tipo === 'cerca' ? (ESCAPE ? `Tormenta cerca: movete ~${ESCAPE.km} km al ${ESCAPE.hacia}` : 'Tormenta cerca: se aleja') : dest ? 'Adónde ir para ver la tormenta' : 'Tormentas cerca tuyo',
      pie: `Satélite ${nc?.hora ?? ''} h`, yo: { ...me, label: 'VOS' }, tormentas: chaseEvent.cores.map(coreSpec),
      ...(dest ? (dest.esc ? { escape: dest } : { destino: dest }) : {}),
    }) : null;
    if (img) chaseOut.push({ photo: img, caption: `🗺️ Azul = vos · círculos = tormentas y su camino (+30/+60 min) · violeta = granizo · verde = ${dest?.esc ? 'hacia dónde escapar' : 'adónde ir'}.` });
    if (dest) chaseOut.push(pin2(dest, dest.esc ? `Alejate hasta acá (${ESCAPE.hacia})` : 'Punto para ver la tormenta', dest.label.replace(/^(IR ACÁ|ESCAPÁ): ?/, '')));
    // Guía visual la primera vez que hay una tormenta en esta salida (o si la pidió con /guia).
    const c0 = chaseEvent.cores[0];
    const mdir0 = c0 ? (c0.mov_deg ?? ANG[c0.va_hacia] ?? 90) : 90;
    if (c0 && (!state.chase.guia || state.chase.pideGuia)) { chaseOut.push(guiaLines(mdir0).join('\n')); state.chase.guia = true; state.chase.pideGuia = false; }
    const z = img ? null : chaseEvent.cores.find((c) => c.imagen);
    if (z) chaseOut.push({ photo: `${dir}/${z.imagen}`, caption: `🛰️ Zoom satélite: ${esc(z.cerca_de)} · tope ${z.tope_min_C} °C${z.topes_sobresalientes ? ` · ⚡ ${z.topes_sobresalientes} topes que sobresalen` : ''}. Blanco/magenta/rojo = topes más fríos (corriente ascendente fuerte).` });
  }
}
for (const m of chaseOut) messages.push(m);

/* ---------- 🔄 Cambió el plan: si la zona que te mandamos bajó (o apareció una mejor), qué hacer AHORA ---------- */
// Si hoy ya salió el aviso del día pero no quedó guardado el plan (aviso de antes de esta versión), se manda una
// actualización con la mejor opción de ahora.
if (!state.plan || state.plan.date !== today) { if ((state.days?.[today] ?? -1) >= MIN) state.plan = { date: today, zona: null, ctr: null, v: state.days[today], t: NOW, semilla: true }; }
// Usa tu ubicación del modo caza si está fresca (si no, Leones). Se fija cada vez que el panel recalcula el pronóstico.
if (!REPLAY && data && state.plan?.date === today && !state.plan.cerrado && !quiet && nowMin < 21 * 60
  && NOW - (state.planMsg ?? 0) > 40 * 60e3) {
  const loc = state.chase?.on && state.chase.loc && NOW - state.chase.loc.t < 90 * 60e3 ? state.chase.loc : null;
  const origin = loc ? { lat: loc.lat, lon: loc.lon } : HOME;
  const zs = zonesFor(today, 4);
  const plan = state.plan;
  const mine = plan.ctr ? zs.find((z) => km(z.ctr, plan.ctr) <= 90) : null;
  const curV = mine?.v ?? 0;
  const nowH = nowMin / 60;
  const pre = huntOptions(zs, data.towns, data.times, today, origin, (bp) => state.stopsR?.[plainKey(bp)] || null, nowH);
  const best = pre.find((o) => o.reachable && o.z.v >= MIN && !porQueNo(o, today).length);
  const bajo = curV < MIN || curV <= plan.v - 10;
  const mejor = best && plan.ctr && (!mine || km(best.z.ctr, plan.ctr) > 90) && best.z.v >= curV + 10;
  // Ya en camino (desde 1 h antes de la ventana): no se cambia el plan por el pronóstico; manda el satélite.
  const enCamino = plan.inicio != null && nowMin / 60 >= plan.inicio - 1;
  if (enCamino && (bajo || mejor) && !plan.avisoEnCamino && !(mejor && best.z.v >= curV + 15)) {
    messages.push([
      `📋 <b>El pronóstico ${bajo ? `bajó (de ${plan.v} a ${curV || 'menos de 45'})` : 'cambió'}, pero seguí el plan</b>`,
      `Ya estás en camino o en la base: desde ahora lo que manda es <b>el satélite</b>, no el pronóstico. Muchas tormentas nacen igual.`,
      `Esperá en la base hasta las <b>${clock(plan.decision * 60)}</b>. Si nace algo, te mando el 🎯. Si a esa hora no nació nada cerca, ${plan.planB ? `andá al plan B (Zona ${esc(plan.planB.zona)})` : 'volvé tranquilo'}.`,
    ].join('\n'));
    plan.avisoEnCamino = true; state.planMsg = NOW;
  } else if ((!enCamino || (mejor && best.z.v >= curV + 15)) && (plan.semilla || bajo || mejor)) {
    let o = best;
    if (o) { // parada rural para la opción nueva (si falta)
      state.stopsR ??= {};
      const k = plainKey(o.base);
      if (!(k in state.stopsR)) state.stopsR[k] = (await ruralStop(o.base, (o.mdir - 90 + 360) % 360)) || false;
      o = huntOptions(zs, data.towns, data.times, today, origin, (bp) => state.stopsR[plainKey(bp)] || null, nowH).find((x) => km(x.z.ctr, o.z.ctr) < 5) ?? o;
    }
    const desde = loc ? 'de vos' : 'de Leones';
    messages.push([
      `🔄 <b>${plan.semilla ? 'ACTUALIZACIÓN DEL PLAN' : 'CAMBIÓ EL PRONÓSTICO'}</b> <i>(${clock(nowMin)} h)</i>`,
      plan.semilla ? `A la mañana el mejor potencial era ${plan.v}. ${best ? `Ahora la mejor zona a la que llegás tiene <b>${best.z.v}</b>.` : `Ahora <b>ninguna zona a la que llegues llega a ${MIN}</b>.`}`
      : bajo ? (mine ? `La zona <b>${esc(plan.zona)}</b> bajó de ${plan.v} a <b>${curV}</b>${curV < MIN ? ': <b>ya no vale la pena ir</b>' : ''}.`
        : `La zona <b>${esc(plan.zona)}</b> ya no aparece (bajó de ${plan.v} a menos de 45): <b>no vale la pena ir</b>.`)
        : `Apareció una zona mejor que <b>${esc(plan.zona)}</b> (${curV}).`,
      '',
      ...(o ? [
        `👉 <b>Mejor opción ahora:</b> Zona ${esc(o.z.name)} · <b>${o.z.v}</b> · pico ${clock(o.peakH * 60)} h`,
        `   ${stopLine(o)} · a ${o.dist} km ${desde} (~${dur(o.drive)})`,
        `   ${timeLine(o)}${o.hit ? ` · ⚠️ entrá por el ${rumbo(o.mdir - 90)}, sin cruzar por delante` : ''}`,
        `   <a href="${ruta(o.vp)}">🗺️ Ruta</a>`,
        '', ...planLines(o, planDe(o, pre, today)).slice(1, -1).map((x) => x.replace(/^1️⃣ (.*) · Salí de Leones a la base/, '1️⃣ $1 · Andá a la base')),
      ] : [
        `👉 <b>No queda ninguna zona buena a la que llegues hoy.</b> Volvé tranquilo o quedate cerca de una ruta asfaltada.`,
        state.chase?.on ? '   Si nace algo cerca igual, el modo caza te avisa adónde ir.' : '   Si nace algo cerca igual, el satélite te avisa.',
      ]),
      `<a href="${PANEL}">📡 Mapa</a>`,
    ].join('\n'));
    if (o) messages.push(pin2(o.vp, `Parada · Zona ${o.z.name}`, o.stop?.label ?? 'punto aproximado'));
    state.planMsg = NOW;
    if (o) { const pl = planDe(o, pre, today); state.plan = { date: today, zona: o.z.name, ctr: o.z.ctr, v: o.z.v, stop: o.stop?.label ?? null, base: { lat: o.vp.lat, lon: o.vp.lon }, inicio: pl.inicio, decision: pl.decision, ocaso: pl.ocaso, planB: pl.planB, t: NOW }; }
    else state.plan = { ...plan, cerrado: true };
  }
}

/* ---------- 📋 Seguimiento del plan: hora de decidir y vuelta ---------- */
if (!REPLAY && state.plan?.date === today && !state.plan.cerrado && state.plan.decision != null) {
  const plan = state.plan;
  const loc = state.chase?.on && state.chase.loc && NOW - state.chase.loc.t < 90 * 60e3 ? state.chase.loc : null;
  const donde = loc ?? plan.base;
  let nc = null;
  try { nc = JSON.parse(await readFile(`${dir}/nowcast.json`, 'utf8')); } catch { /* sin satélite */ }
  const fresco = nc?.hora_utc && NOW - Date.parse(nc.hora_utc) < 60 * 60e3;
  const celdas = fresco ? nc.celulas : [];
  // ¿El camino de vuelta a Leones está libre de tormentas?
  const vuelta = () => {
    const r = rutaLibre(donde, HOME, celdas, { now: NOW, imgUtc: nc?.hora_utc, nube: true });
    return r ? `⚠️ <b>Hay una tormenta en el camino a Leones</b> (la cruzarías en ~${r.en_min} min, ${esc(r.c.cerca_de ?? '')}): <b>esperá bajo techo</b> (estación de servicio) 30–45 min a que pase. No la atravieses.`
      : '✅ El camino de vuelta a Leones está libre de tormentas.';
  };
  // Yendo a la base: ¿el camino pasa por alguna tormenta?
  if (loc && plan.base && km(loc, plan.base) > 10 && nowMin / 60 < plan.decision && NOW - (plan.avisoRuta ?? 0) > 30 * 60e3) {
    const r = rutaLibre(loc, plan.base, celdas, { now: NOW, imgUtc: nc?.hora_utc, nube: true });
    if (r) {
      messages.push([
        `👉 <b>QUÉ HACER: esperá donde estás (bajo techo) ~30 min</b>`,
        '',
        `⚠️ <b>En el camino a la base hay una tormenta</b>: ${esc(r.c.fuerza)} (${esc(r.c.cerca_de ?? '')}), la cruzarías en ~${r.en_min} min.`,
        'No la atravieses: lluvia fuerte, granizo y rayos en la ruta. Parate en una estación de servicio o un lugar techado y esperá a que pase; te aviso cuando el camino esté libre.',
      ].join('\n'));
      plan.avisoRuta = NOW; plan.rutaBloqueada = true;
    } else if (plan.rutaBloqueada) {
      messages.push('✅ <b>El camino a la base ya está libre.</b> Podés seguir viaje.');
      plan.rutaBloqueada = false;
    }
  }
  if (!plan.avisoDecision && nowMin / 60 >= plan.decision) {
    const cerca = (fresco ? nc.celulas : []).map((c0) => { const e = coreAt(c0, nc.hora_utc, NOW); return { ...c0, lat: e.lat, lon: e.lon }; })
      .filter((c) => km(donde, c) <= 60 && c.tendencia !== 'debilitándose' && (c.fuerza !== 'moderada' || c.tendencia === 'creciendo' || c.tendencia === 'nueva' || c.rayos_10min >= 10));
    messages.push(cerca.length ? [
      `📋 <b>Paso 4 · hora de decidir (${clock(plan.decision * 60)})</b>`,
      `Hay ${cerca.length === 1 ? 'una tormenta' : `${cerca.length} tormentas`} a menos de 60 km${loc ? ' tuyo' : ' de la base'}: <b>seguí</b>. Si alguna se pone buena, te llega el 🎯 con adónde ir.`,
      `Volvé a más tardar a las <b>${clock(plan.ocaso * 60)}</b> (se pone el sol).`,
    ].join('\n') : [
      `📋 <b>Paso 4 · hora de decidir (${clock(plan.decision * 60)})</b>`,
      `No nació nada para ver a menos de 60 km${loc ? ' tuyo' : ' de la base'}.`,
      plan.planB ? `👉 Si tenés ganas, andá al <b>plan B: Zona ${esc(plan.planB.zona)}</b> (${plan.planB.v}), a ${plan.planB.km} km de la base${plan.planB.label ? `: 🌾 ${esc(plan.planB.label)}` : ''}. <a href="${ruta(plan.planB.vp)}">🗺️ Ruta</a>`
        : '👉 <b>Volvé tranquilo.</b> Hoy no se armó. Pasa seguido: los cazadores vuelven sin nada la mayoría de los días.',
      ...(cerca.length && !plan.planB ? [] : [vuelta()]),
    ].join('\n'));
    if (!cerca.length && plan.planB) messages.push(pin2(plan.planB.vp, `Plan B · Zona ${plan.planB.zona}`, plan.planB.label ?? ''));
    plan.avisoDecision = true;
  }
  if (!plan.avisoOcaso && loc && nowMin / 60 >= plan.ocaso - 0.5) {
    messages.push(`🌅 <b>Paso 5 · en 30 min se pone el sol</b> (${clock(plan.ocaso * 60)}). Emprendé la vuelta: de noche no se ve la tormenta y es peligroso. Mandá /fin cuando llegues.\n${vuelta()}`);
    plan.avisoOcaso = true;
  }
}

/* ---------- 🛰️ Aviso del satélite en días de caza (sin modo caza) ---------- */
// Tormenta nueva o creciendo, fuerte o con topes que sobresalen, o con un salto de rayos (GLM), en cualquier parte del Pasillo.
// Una vez por tormenta y como máximo un aviso cada 30 min. Si el modo caza está prendido, ese avisa (con tu ubicación).
let satEvent = null;
const satHunt = REPLAY && env.REPLAY_NOCHASE ? true : huntDay;
if (!state.chase.on && satHunt && (REPLAY || !quiet)) {
  let nc = null;
  try { nc = JSON.parse(await readFile(`${dir}/nowcast.json`, 'utf8')); } catch { /* sin satélite */ }
  const fresh = nc?.hora_utc && NOW - Date.parse(nc.hora_utc) < 90 * 60e3;
  state.satSeen ??= {};
  for (const [k, t] of Object.entries(state.satSeen)) if (NOW - t > 4 * 3600e3) delete state.satSeen[k];
  const key = (c) => `${(Math.round(c.lat * 5) / 5).toFixed(1)},${(Math.round(c.lon * 5) / 5).toFixed(1)}`;
  const todasNc = fresh ? nc.celulas : [];
  const cand = todasNc.filter((c) => (c.salto_rayos || ((c.tendencia === 'nueva' || c.tendencia === 'creciendo')
    && (c.fuerza !== 'moderada' || c.topes_sobresalientes > 0)) || (paraMirar(c, todasNc) && km(HOME, c) <= 100)) && !state.satSeen[key(c)]
    && (() => { const e = coreAt(c, nc.hora_utc, NOW); const t = potencialTornado({ ...c, lat: e.lat, lon: e.lon }, data, NOW, { aislada: !todasNc.some((o) => o !== c && km(o, c) < 40) }); c.tornado = t; return !data || (t && (t.nivel === 'alta' || (t.nivel === 'media' && t.env >= 60))); })());
  if (cand.length && NOW - (state.satLast ?? 0) > 30 * 60e3) {
    const cores = cand.sort((a, b) => (b.salto_rayos ? 1 : 0) - (a.salto_rayos ? 1 : 0) || b.topes_sobresalientes - a.topes_sobresalientes || a.tope_min_C - b.tope_min_C).slice(0, 3).map((c0) => {
      const est = coreAt(c0, nc.hora_utc, NOW);
      return { ...c0, lat: est.lat, lon: est.lon, edadMin: Math.round(est.edadMin), d: Math.round(km(HOME, est)), from: rumbo(bearing(HOME, est)) };
    });
    for (const c of cand) state.satSeen[key(c)] = NOW; // las demás de esta tanda tampoco se repiten
    state.satLast = NOW;
    satEvent = { cores };
    const rayos = (c) => (c.rayos_10min == null ? '' : c.salto_rayos ? `\n   ⚡⚡ <b>Salto de rayos</b>: ${c.rayos_10min} en 10 min (antes ${c.rayos_10min_antes}) · suele anticipar granizo, viento o rotación en 10–30 min`
      : c.rayos_10min ? ` · ${c.rayos_10min} rayos en 10 min` : '');
    const line = (c) => `• <b>${esc(c.fuerza)}</b> (${c.tope_min_C} °C${c.topes_sobresalientes ? `, ⚡ ${c.topes_sobresalientes} topes que sobresalen` : ''}) · <b>${esc(c.tendencia)}</b>${c.tornado ? ` · 🌪️ chances de tornado <b>${c.tornado.nivel}</b>` : ''}${rayos(c)}\n   ${esc(c.cerca_de)} · a ${c.d} km al ${c.from} de Leones${c.va_hacia ? ` · va al ${c.va_hacia}${c.kmh ? ` a ~${c.kmh} km/h` : ''}` : ''}`;
    const hay = await intercept(HOME, nc);
    messages.push([
      `👉 <b>QUÉ HACER: ${hay ? (INTER.quedate ? 'quedate en Leones: la vas a ver pasar de costado' : `si querés verla, salí al punto 🎯${INTER.stop ? ` (${esc(INTER.stop.label)})` : ''}: llegás en ~${INTER.llegas_min} min`) : 'quedate: no hay ninguna para ver de costado'}</b>`,
      '',
      `${cores[0].tornado && cores[0].tornado.nivel !== 'baja' ? '🌪️' : '🛰️'} <b>${cores[0].tornado && cores[0].tornado.nivel !== 'baja' ? `Tormenta con chances de tornado (${cores[0].tornado.nivel})` : cores[0].salto_rayos ? 'Salto de rayos en una tormenta' : `Tormenta ${cores[0].tendencia === 'nueva' ? 'nueva' : 'creciendo'}`} en el Pasillo</b> <i>(satélite de las ${nc.hora} h, posición estimada ahora)</i>`,
      ...cores.map(line),
      ...(hay ? ['', ...interceptLines(INTER)] : ['', '➡️ <b>No hay forma de verla de costado con el camino limpio</b> (se aleja, va muy rápido o hay lluvia en el medio): <b>no salgas</b>. Quedate en Leones y esperá el próximo aviso.']),
      `<a href="${RADAR_SMN}">📡 Radar SMN</a> · <a href="${PANEL}">🗺️ Panel</a> · si salís, mandá /caza y compartí tu ubicación (y /guia para saber qué mirar)`,
    ].join('\n'));
    const img = await mapa({ titulo: INTER ? 'Tormenta en el Pasillo: adónde ir para verla' : 'Tormenta en el Pasillo', pie: `Satélite ${nc.hora} h`, yo: { ...HOME, label: 'LEONES' }, tormentas: cores.map(coreSpec),
      ...(INTER ? { destino: { lat: INTER.p.lat, lon: INTER.p.lon, label: INTER.stop ? `IR ACÁ: ${INTER.stop.label}` : 'IR ACÁ (ver de costado)' } } : {}) });
    if (img) messages.push({ photo: img, caption: '🗺️ Círculos = tormentas y su camino (+30/+60 min) · violeta = granizo · verde = adónde ir para verla de costado.' });
    if (INTER) messages.push(pin2(INTER.p, 'Punto para ver la tormenta', INTER.stop?.label ?? ''));
    const z = img ? null : cores.find((c) => c.imagen);
    if (z) messages.push({ photo: `${dir}/${z.imagen}`, caption: `🛰️ Zoom satélite: ${esc(z.cerca_de)} · tope ${z.tope_min_C} °C${z.topes_sobresalientes ? ` · ⚡ ${z.topes_sobresalientes} topes que sobresalen` : ''}.` });
  }
}


let brief = null;
if (data) {
  brief = await buildBrief();
  if (REPLAY) {
    brief.hora_argentina = new Date(NOW - 3 * 3600e3).toISOString().slice(11, 16);
    brief.dias = []; brief.avisos_smn_corto_plazo = [];
    brief.nota = 'REPETICIÓN de un momento pasado para probar el modo caza. Usá solo nucleos_satelite, vos e imágenes.';
  }
  if (!REPLAY) await writeFile(`${dir}/brief.json`, JSON.stringify(brief, null, 1));
}
if (brief && messages.length && !env.DRY_RUN && !(chaseOut.length && !chaseEvent && messages.length === chaseOut.length)) {
  const focus = satEvent && !chaseEvent ? `AVISO DEL SATÉLITE: nació o crece una tormenta fuerte en el Pasillo (ver nucleos_satelite). El usuario está en Leones. Si existe "intercepcion", recomendá ESE punto; si no existe, decí que NO conviene salir (se aleja o no se llega de costado) y que el sistema avisa si aparece una a la que llegue.`
    : chaseEvent ? `MODO CAZA: el usuario está en la ruta (ver "vos"). Decile exactamente qué hacer ahora con las tormentas detectadas por satélite (${chaseEvent.tipo === 'cerca' ? 'hay una tormenta cerca: priorizá su seguridad' : 'hay tormentas nuevas o creciendo'}): si existe "escape", decí hacia dónde moverse; si existe "intercepcion", recomendá ESE punto; si no existe ninguno de los dos, decí que se quede y NO persiga (se aleja o no se llega de costado).`
    : live.length ? 'hay avisos del SMN de tormentas formándose: qué hacer en las próximas 2 horas'
    : 'el día de caza: a dónde ir, a qué hora salir y qué hacer al llegar';
  const adv = await aiAdvice(brief, focus);
  if (adv) messages.push(`🤖 <b>Qué haría yo</b> <i>(IA, con los datos de arriba)</i>\n${esc(adv).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^\s*[*-]\s+/gm, '• ')}\n<i>Es una sugerencia: manda el radar y tu criterio.</i>`);
}

/* ---------- ⛈️ Tormenta fuerte o granizo hacia Leones (todos los días, no solo días de caza) ---------- */
// Avisa con qué seguridad llega y qué tan probable es el granizo, y lleva la cuenta de cuántas veces acertó.
// Con el modo caza prendido no se manda (ese ya avisa con tu ubicación en vivo).
if (!REPLAY) {
  let nc = null;
  try { nc = JSON.parse(await readFile(`${dir}/nowcast.json`, 'utf8')); } catch { /* sin satélite */ }
  const me = HOME;
  state.stormLog = revisar(state.stormLog ?? [], { me, nc, smn, now: NOW }).slice(-60);
  const xs = amenazas({ me, nc, smn, data, now: NOW });
  const x = xs.find((t) => valeAvisar(t, { noche: quiet }));
  const R = { alta: 3, media: 2, baja: 1 }, G = { probable: 3, posible: 2, 'poco probable': 1 };
  const st = state.storm ?? {};
  if (x && !state.chase.on) {
    const sube = R[x.llega] > (st.llega ?? 0) || G[x.granizo.nivel] > (st.gran ?? 0);
    if (!st.activa || sube || NOW - (st.last ?? 0) > 45 * 60e3) {
      const n = NIVEL[x.llega], c = x.core;
      const hora = new Date(NOW + (x.eta ?? 0) * 60e3).toISOString();
      const cuando = x.eta == null ? ' · en las próximas horas' : x.eta > 0 ? ` · en ~${x.eta} min (≈ ${hhmm(hora)} h)` : ' · <b>ya está encima</b>';
      const ac = aciertos(state.stormLog);
      const acTxt = ['alta', 'media', 'baja'].filter((k) => ac[k]).map((k) => `${NIVEL[k].emoji} ${ac[k].llegaron} de ${ac[k].total}`).join(' · ');
      messages.push([
        `👉 <b>QUÉ HACER: ${x.granizo.nivel === 'poco probable' ? 'nada urgente; si querés, guardá el auto' : '<u>guardá el auto bajo techo</u>'}${x.eta ? ` (llega en ~${x.eta} min)` : ''}</b>`,
        '',
        `⛈️ <b>Tormenta fuerte hacia ${esc(me.name)}</b>`,
        `${n.emoji} <b>${n.txt}</b>${cuando}`,
        ...(x.fuente === 'smn' ? [`🚨 Aviso a corto plazo del SMN: ${esc(x.evento || 'tormentas')}${x.hasta ? ` · hasta las ${hhmm(x.hasta)}` : ''}`] : []),
        ...(c ? [`🛰️ ${esc(c.fuerza)} (tope ${c.tope_min_C} °C) · ${esc(c.tendencia)} · ${x.d ? `a ${x.d} km al ${x.desde}` : 'encima'}${c.kmh && x.eta ? ` · viene a ~${c.kmh} km/h` : ''}`] : []),
        `🧊 Granizo: <b>${x.granizo.nivel}</b>${x.granizo.señales.length ? ` · ${esc(x.granizo.señales.slice(0, 4).join('; '))}` : ''}`,
        ...(x.porque.length ? [`✅ Por qué: ${x.porque.join('; ')}`] : []),
        ...(x.dudas.length ? [`❓ No es seguro porque: ${x.dudas.join('; ')}`] : []),
        ...(acTxt ? [`📊 Estas alertas llegaron: ${acTxt}`] : []),
        `<i>El satélite no ve el granizo, da señales: solo un aviso del SMN o alguien que lo vea lo confirma.</i>`,
        `<a href="${PANEL}">📡 Mapa y satélite</a>`,
      ].join('\n'));
      if (c) {
        const img = await mapa({ titulo: `Tormenta hacia ${me.name}: ${n.txt.toLowerCase()}`, pie: `Satélite ${nc?.hora ?? ''} h`, yo: { ...me, label: me.name.toUpperCase() }, tormentas: [coreSpec(c)] });
        if (img) messages.push({ photo: img, caption: '🗺️ Círculo = tormenta y su camino (+30/+60 min) · violeta = donde suele caer el granizo.' });
      }
      state.storm = { activa: true, last: NOW, llega: R[x.llega], gran: G[x.granizo.nivel] };
      state.stormLog.push({ t: NOW, eta: x.eta, llega: x.llega, granizo: x.granizo.nivel, me: { lat: me.lat, lon: me.lon } });
    }
  } else if (st.activa && !xs.length && NOW - (st.last ?? 0) > 20 * 60e3) {
    // La que avisamos ya pasó, se desvió o se deshizo: decirlo una vez (si fue hace poco).
    if (NOW - st.last < 3 * 3600e3 && !state.chase.on) messages.push(`✅ <b>Ya no veo tormentas fuertes yendo hacia ${esc(me.name)}</b> (pasó, se desvió o se debilitó).`);
    state.storm = { activa: false };
  }
}

/* ---------- Envío ---------- */
console.log(messages.length ? messages.map((m) => (m?.venue ? `[pin ${m.venue.lat},${m.venue.lon}] ${m.venue.title}` : typeof m === 'object' ? `[foto ${m.photo}] ${m.caption}` : m)).join('\n\n———\n\n') : `Nada para avisar (umbral ${MIN}, ${clock(nowMin)} h).`);
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = env;
if (REPLAY && messages.length) {
  const when = new Date(NOW - 3 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  messages.unshift(`🔁 <b>REPETICIÓN DE PRUEBA</b> · ${when} h (no es en vivo)\nAsí te hubiera llegado el modo caza estando en Leones.`);
}
if (!messages.length || env.DRY_RUN) { if (!REPLAY) await writeFile(STATE, JSON.stringify(state)); process.exit(0); }
if (!token || !chat) {
  // Sin configurar todavía: no falla el workflow y no marca nada como enviado.
  console.log('Faltan los secretos TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: no se envía.');
  process.exit(0);
}
let ok = true;
for (const m of messages) {
  let r;
  if (m?.venue) {
    r = await fetch(`https://api.telegram.org/bot${token}/sendVenue`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, latitude: m.venue.lat, longitude: m.venue.lon, title: m.venue.title, address: m.venue.address || ' ' }),
    });
  } else if (typeof m === 'object' && m.photo) {
    try {
      const fd = new FormData();
      fd.append('chat_id', String(chat));
      fd.append('caption', m.caption);
      fd.append('parse_mode', 'HTML');
      fd.append('photo', new Blob([await readFile(m.photo)], { type: 'image/png' }), 'mapa.png');
      r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd });
    } catch (e) { console.error('Telegram (foto) falló:', e.message); continue; }
  } else {
    r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: m, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  }
  if (!r.ok) { ok = false; console.error('Telegram error', r.status, await r.text()); }
}
if (!ok) process.exit(1); // si falló, no se guarda el estado: reintenta en la próxima corrida
if (!REPLAY) await writeFile(STATE, JSON.stringify(state));
console.log(`Enviado: ${messages.length} mensaje(s).`);
