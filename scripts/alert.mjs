// Alertas por Telegram. Corre en el workflow de cada hora, después de build-data.mjs.
// Uso: node scripts/alert.mjs _site
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MIN_SCORE (60), RADIUS_KM (200),
//      ALERT_STATE (archivo donde recuerda lo ya enviado), TEST=1 (manda un resumen igual), DRY_RUN=1 (no envía).
//
// Avisa:
//  1. Aviso a corto plazo del SMN a menos de RADIUS_KM de Leones (a cualquier hora, una vez por aviso).
//  2. Hoy o mañana con una zona ≥ MIN_SCORE (una vez por día; de nuevo si sube 10 puntos o más).
//     Entre las 23 y las 7 h no manda avisos de pronóstico: los guarda para la mañana.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HOME, level, km, driveHours, rumbo } from '../lib/risk.mjs';

const dir = (process.argv[2] || '_site') + '/data';
const env = process.env;
const MIN = +(env.MIN_SCORE || 60);
const RADIUS = +(env.RADIUS_KM || 200);
const STATE = env.ALERT_STATE || '.alert-state/state.json';
const PANEL = 'https://juampipar.github.io/alerta-tornados/';
const TZ = 'America/Argentina/Cordoba';

const readJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const maps = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const now = new Date(Date.now() - 3 * 3600e3); // hora argentina (UTC−3, sin horario de verano)
const today = now.toISOString().slice(0, 10);
const hourNow = now.getUTCHours();
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

const data = await readJson(`${dir}/forecast.json`);
const smn = await readJson(`${dir}/smn.json`);
const state = (await readJson(STATE)) || { smn: {}, days: {} };
const messages = [];

/* ---------- 1. Avisos a corto plazo del SMN cerca de casa ---------- */
function inPoly([lat, lon], poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
const nearest = (a) => Math.min(...a.areas.flatMap((ar) => ar.polygons.flat().map(([lat, lon]) => km(HOME, { lat, lon }))), Infinity);

for (const a of smn?.alerts ?? []) {
  if (!a.shortTerm || state.smn[a.id]) continue;
  const mine = a.areas.some((ar) => ar.polygons.some((p) => inPoly([HOME.lat, HOME.lon], p)));
  const d = Math.round(nearest(a));
  if (!mine && d > RADIUS) continue;
  state.smn[a.id] = a.expires || new Date().toISOString();
  const zonas = [...new Set(a.areas.map((x) => x.desc).filter(Boolean))];
  messages.push([
    `🚨 <b>SMN: ${esc(a.event || a.headline)}</b>`,
    mine ? '<b>Incluye Leones.</b>' : `A ${d} km de Leones.`,
    zonas.length ? esc(zonas.slice(0, 8).join(' · ')) + (zonas.length > 8 ? ` +${zonas.length - 8}` : '') : '',
    a.expires ? `Hasta las ${hhmm(a.expires)} h.` : '',
    a.description ? esc(a.description.slice(0, 600)) : '',
    `\nRadar y mapa: ${PANEL}`,
  ].filter(Boolean).join('\n'));
}

/* ---------- 2. Pronóstico: hoy y mañana ---------- */
// Misma ventana que el panel: de 11 h a 2 h del día siguiente.
function windowIdx(date) {
  const nd = addDays(date, 1);
  return data.times.flatMap((t, i) => {
    const h = +t.slice(11, 13);
    return (t.startsWith(date) && h >= 11) || (t.startsWith(nd) && h <= 2) ? [i] : [];
  });
}
function bestTowns(date) {
  const idx = windowIdx(date);
  return data.towns.map((t) => {
    let i = -1, v = -1;
    for (const k of idx) if ((t.score[k] ?? 0) > v) { v = t.score[k]; i = k; }
    return { t, i, score: Math.max(v, 0), dist: Math.round(km(HOME, t)) };
  }).filter((r) => r.i >= 0).sort((a, b) => b.score - a.score);
}
function townLine(r) {
  const s = (k) => r.t[k]?.[r.i];
  const hora = data.times[r.i].slice(11, 16);
  const srh = s('srh') == null ? '' : ` · helicidad ${Math.max(0, -s('srh'))}`;
  const lcl = s('lcl') == null ? '' : ` · base ${s('lcl')} m`;
  const mov = s('mdir') == null ? '' : `\n   Tormentas hacia el ${rumbo(s('mdir'))} a ${s('mspd')} km/h`;
  return `<b>${r.score}</b> ${esc(r.t.name)} · pico ${hora} h · ${r.dist} km (~${driveHours(r.dist).toFixed(1)} h)\n` +
    `   CAPE ${s('cape')} · cizalla ${s('shear') ?? '–'} m/s${srh}${lcl}${mov}\n` +
    `   <a href="${maps(r.t.lat, r.t.lon)}">Cómo llegar</a>`;
}

const quiet = hourNow >= 23 || hourNow < 7;
const test = !!env.TEST;
if (data) {
  for (const [off, name] of [[0, 'HOY'], [1, 'MAÑANA']]) {
    const date = addDays(today, off);
    const rank = bestTowns(date);
    const top = rank[0];
    if (!top) continue;
    const prev = state.days[date] ?? -1;
    const fire = top.score >= MIN && top.score >= prev + 10 && !quiet;
    if (!fire && !test) continue;
    if (fire) state.days[date] = top.score;
    const lv = level(top.score);
    const subio = prev >= 0 && fire ? ` (subió de ${prev})` : '';
    messages.push([
      `⛈️ <b>${name}: potencial ${lv.label.toUpperCase()} ${top.score}</b>${subio}`,
      ...rank.slice(0, 3).filter((r) => r.score >= 25 || r === top).map(townLine),
      `\nEs un pronóstico de ingredientes, no un aviso de tornado. Confirmá con radar y SMN.\n${PANEL}`,
    ].join('\n'));
  }
} else if (test) {
  messages.push('⚠️ No se pudo leer el pronóstico en esta corrida.');
}

// Olvida avisos y días viejos.
for (const [id, exp] of Object.entries(state.smn)) if (Date.parse(exp) < Date.now() - 2 * 864e5) delete state.smn[id];
for (const d of Object.keys(state.days)) if (d < addDays(today, -3)) delete state.days[d];
await mkdir(dirname(STATE), { recursive: true });

/* ---------- Envío ---------- */
console.log(messages.length ? messages.join('\n\n———\n\n') : `Nada para avisar (umbral ${MIN}, radio ${RADIUS} km, ${pad(hourNow)} h).`);
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
