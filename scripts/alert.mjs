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
import { HOME, level, km, driveHours, rumbo, huntZones, goTo, viewpoint, routeCheck, safeLeave, placeName, huntOptions } from '../lib/risk.mjs';

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
async function otherOptionsTxt(date) {
  const zs = zonesFor(date, 4);
  if (zs.length < 2) return [];
  const opts = huntOptions(zs, data.towns, data.times, date, HOME).slice(1);
  const lines = [];
  for (const [k, o] of opts.entries()) {
    await sleep(1100); // OpenStreetMap pide como máximo 1 consulta por segundo
    const n = await placeName(o.vp);
    const lugar = n ? `cerca de ${esc(n.place)}` : `${o.vp.lat.toFixed(2)}, ${o.vp.lon.toFixed(2)}`;
    const vp = { lat: +o.vp.lat.toFixed(4), lon: +o.vp.lon.toFixed(4) };
    lines.push(`${['2️⃣', '3️⃣', '4️⃣'][k]} Zona ${esc(o.z.name)} · <b>${o.z.v}</b> · pico ${clock(o.peakH * 60)} h\n   👁 ${lugar} · ${o.dist} km · salir ${clock(o.leave * 60)}${o.hit ? ' ⚠️' : ''} · <a href="${maps(vp.lat, vp.lon)}">ruta</a>`);
  }
  return lines.length ? ['', '<b>Otras opciones para ir</b>', ...lines] : [];
}
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
  const zs = zonesFor(date), z = zs[0];
  const b = z ? goTo(z, rank) : rank[0], score = z ? z.v : b.score, lv = level(score), s = b.s;
  const srh = s('srh') == null ? null : Math.max(0, -s('srh')); // helicidad ciclónica (hemisferio sur)
  const ing = [
    `⚡ Energía (CAPE ${s('cape')}): ${words.cape(s('cape'))}`,
    s('shear') != null && `💨 Cizalladura (${Math.round(s('shear'))} m/s): ${words.shear(s('shear'))}`,
    srh != null && `🌀 Giro cerca del suelo (helicidad ${srh}): ${words.srh(srh)}`,
    s('lcl') != null && `☁️ Base de nube (${s('lcl')} m): ${words.lcl(s('lcl'))}`,
  ].filter(Boolean);
  const mov = s('mdir') == null ? null : `➡️ Las tormentas van hacia el <b>${rumbo(s('mdir'))}</b> a ${s('mspd')} km/h`;
  // Zona de caza: el círculo del mapa.
  const zone = !z ? [] : (() => {
    const dc = Math.round(km(HOME, z.ctr)), edge = Math.max(0, Math.round(dc - z.r));
    return [
      `🎯 <b>Zona de caza: ${esc(z.name)}</b> (círculo de ~${Math.round(z.r)} km)`,
      edge === 0 ? '   <b>Leones está dentro de la zona</b>' : `   El borde está a ${edge} km de Leones, hacia el ${rumbo(bearing(HOME, z.ctr))}`,
      `   <a href="${pin(z.ctr.lat, z.ctr.lon)}">Ver el centro de la zona</a>`,
      '',
    ];
  })();
  // 👁 Punto para mirar (no la ciudad) y chequeo del camino desde Leones.
  const dirM = s('mdir') ?? 90, spd = s('mspd');
  const vp0 = z ? viewpoint(z, dirM) : null;
  const vp = vp0 && { lat: +vp0.lat.toFixed(4), lon: +vp0.lon.toFixed(4) };
  const tgt = vp ?? b.t, vdist = Math.round(km(HOME, tgt)), vdrive = driveHours(vdist);
  const vleaveMin = b.peakMin - 60 - vdrive * 60;
  const lateV = date === today && vleaveMin <= nowMin;
  const hit = vp && spd != null ? routeCheck(HOME, vp, z, dirM, spd, (lateV ? nowMin : vleaveMin) / 60, b.peakMin / 60) : null;
  const safe = hit && !lateV ? safeLeave(HOME, vp, z, dirM, spd, vleaveMin / 60, b.peakMin / 60) : null;
  const name = vp ? await placeName(vp) : null;
  const others = await otherOptionsTxt(date);
  const side = rumbo(dirM - 90);
  const go = [
    vp ? `👁 <b>Punto para mirar:</b> ${name ? `cerca de <b>${esc(name.place)}</b>${name.road ? ` (${esc(name.road)})` : ''}` : `${vp.lat.toFixed(2)}, ${vp.lon.toFixed(2)}`}`
      : `📍 Ir hacia: <b>${esc(b.t.name)}</b>`,
    vp ? `   Al ${side} del camino de las tormentas · <a href="${maps(vp.lat, vp.lon)}">Ruta al punto</a>` : null,
    `   Pico a las ${clock(b.peakMin)} h · nafta y baño en ${esc(b.t.name)}`,
    `🚗 ${vdist} km en línea recta, ~${dur(vdrive)} desde Leones`,
    !lateV ? `⏰ Salir a las <b>${clock(hit && safe != null ? safe * 60 : vleaveMin)}</b> ${hit && safe != null ? 'y esperar en el punto' : 'para llegar 1 h antes'}`
      : nowMin + vdrive * 60 <= b.peakMin + 60 ? `⏰ <b>Salí ya</b>: llegás a las ${clock(nowMin + vdrive * 60)} h, a tiempo para el pico`
      : '⏰ Ya es tarde para llegar al pico: seguí el radar y buscá lo más cercano',
    hit ? (safe != null
      ? `⚠️ Salí a esa hora: <b>más tarde el camino cruza el paso de las tormentas</b> (cerca de las ${clock(hit.h * 60)} h). Si salís después, entrá por el ${side}, sin cruzar por delante.`
      : `⚠️ <b>El camino cruza el paso de las tormentas</b> cerca de las ${clock(hit.h * 60)} h: entrá por el ${side}, sin cruzar por delante.`)
      : vp && spd != null && (!lateV || nowMin + vdrive * 60 <= b.peakMin + 60) ? '✅ Con ese horario el camino no cruza por delante de las tormentas' : null,
  ];
  return [
    score >= MIN ? `🌪️ <b>DÍA DE CAZA · ${label}</b> <i>${dayName(date)}</i>` : `🧪 <b>Prueba · ${label}</b> <i>${dayName(date)}</i> · hoy no da para salir`,
    `Potencial de tornado <b>${lv.label.toUpperCase()} · ${score}/100</b>${prev >= 0 ? ` <i>(subió de ${prev})</i>` : ''}`,
    '',
    ...zone,
    ...go,
    mov,
    '',
    `<b>Ingredientes en ${esc(b.t.name)}</b>`,
    ...ing,
    ...others,
    '',
    `<a href="${maps(tgt.lat, tgt.lon)}">🗺️ Ruta ${vp ? 'al punto para mirar' : `a ${esc(b.t.name)}`}</a>  ·  <a href="${PANEL}">📡 Radar y mapa</a>`,
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
await mkdir(dirname(STATE), { recursive: true });

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
