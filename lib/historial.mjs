// Historial: qué pronosticó el panel cada día y qué pasó (avisos del SMN, señales del satélite, reportes).
// Lógica pura, sin red ni archivos: la usan scripts/historial.mjs (Actions) y el panel (para comparar).
import { km } from './risk.mjs';

const ART = 3 * 3600e3; // Argentina, UTC−3 sin horario de verano
export const artDate = (ms) => new Date(ms - ART).toISOString().slice(0, 10);
export const artHour = (ms) => new Date(ms - ART).getUTCHours();
export const artClock = (ms) => new Date(ms - ART).toISOString().slice(11, 16);
// "Día de tormenta": de 6 h a 6 h del día siguiente, porque muchas tormentas siguen después de medianoche.
export const stormDate = (ms) => artDate(ms - 6 * 3600e3);

const MAX_SAT = 60; // señales del satélite guardadas por día
const r2 = (x) => Math.round(x * 100) / 100;

/** Resumen de lo que pronosticaba el panel para `date` (máximos entre las 11 y las 2 h del día siguiente). */
export function forecastSnapshot(forecast, brief, date, generatedMs) {
  if (!forecast?.times?.length) return null;
  const next = artDate(Date.parse(date + 'T12:00:00Z') + 864e5 + ART);
  const idx = forecast.times.flatMap((t, i) => {
    const h = +t.slice(11, 13);
    return (t.startsWith(date) && h >= 11) || (t.startsWith(next) && h <= 2) ? [i] : [];
  });
  if (!idx.some((i) => forecast.times[i].startsWith(date))) return null; // sin horas de ese día: no hay pronóstico
  let town = null;
  for (const t of forecast.towns ?? []) for (const i of idx) if (!town || t.score[i] > town.v) town = { nombre: t.name, v: t.score[i], hora: forecast.times[i].slice(11, 16) };
  let cell = null;
  (forecast.grid?.pts ?? []).forEach(([lat, lon], k) => { for (const i of idx) { const v = forecast.grid.score[k][i]; if (!cell || v > cell.v) cell = { v, lat, lon }; } });
  const day = (brief?.dias ?? []).find((d) => d.fecha === date);
  return {
    generado: new Date(generatedMs).toISOString(),
    max_pueblo: town,
    max_grilla: cell,
    zonas: (day?.opciones ?? []).slice(0, 2).map((o) => ({
      zona: o.zona, potencial: o.potencial, hora_pico: o.hora_pico, centro: o.centro, radio_km: o.radio_km,
      va_hacia: o.tormentas_van_hacia ?? null, kmh: o.velocidad_kmh ?? null,
    })),
  };
}

/** Centro aproximado de un aviso (promedio de los puntos de sus polígonos). */
function alertCenter(a) {
  const pts = (a.areas ?? []).flatMap((x) => (x.polygons ?? []).flat());
  if (!pts.length) return null;
  return { lat: r2(pts.reduce((s, p) => s + p[0], 0) / pts.length), lon: r2(pts.reduce((s, p) => s + p[1], 0) / pts.length) };
}

/** Parsea el cuerpo de un reporte (issue) armado por el formulario del panel. */
export function parseReport(issue) {
  const body = issue.body ?? '';
  // Cada dato en su línea: [ \t] y no \s, para que un campo vacío no se lleve la línea siguiente.
  const get = (k) => body.match(new RegExp(`^[ \\t]*${k}[ \\t]*:[ \\t]*(.*)$`, 'im'))?.[1]?.trim() ?? '';
  const fecha = get('Fecha');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const vio = get('Qué viste').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10);
  return {
    issue: issue.number, url: issue.html_url, creado: issue.created_at, fecha,
    salio: /^s[ií]/i.test(get('¿Saliste\\?')), vio,
    lugar: get('Dónde').slice(0, 120), nota: get('Nota').slice(0, 500),
  };
}

const day = (h, d) => (h.dias[d] ??= { pron_dia_antes: null, pron_manana: null, avisos: [], satelite: [], reportes: [], publicaciones: [] });

/**
 * Suma lo de esta corrida al historial. Devuelve el historial (modificado).
 * - forecast/brief: pronóstico; se guarda el de la noche anterior (último del día antes) y el de la mañana (hasta las 12 h).
 * - smn: avisos vigentes; se acumulan por día de tormenta, sin repetir.
 * - nowcast: tormentas por satélite; se guardan las señales fuertes (topes < −63 °C o topes que sobresalen).
 * - reports: reportes leídos de los issues (null si no se pudieron leer: se dejan los que había).
 * - publicaciones: de la red (Supabase) de los últimos días; reemplazan las de esos días (así un borrado se refleja).
 *   { desde: 'YYYY-MM-DD', items: [...] } o null si no se pudieron leer.
 */
export function updateHistory(hist, { nowMs, forecast, brief, smn, nowcast, reports, publicaciones }) {
  hist ??= {};
  hist.version = 1;
  hist.dias ??= {};
  const today = artDate(nowMs), hour = artHour(nowMs);

  // Pronóstico
  if (forecast?.times?.length) {
    const gen = Date.parse(forecast.generated) || nowMs;
    const tomorrow = artDate(Date.parse(today + 'T12:00:00Z') + 864e5 + ART);
    const s0 = forecastSnapshot(forecast, brief, today, gen);
    if (s0 && (hour < 12 || !day(hist, today).pron_manana)) day(hist, today).pron_manana = s0;
    const s1 = forecastSnapshot(forecast, brief, tomorrow, gen);
    if (s1) day(hist, tomorrow).pron_dia_antes = s1;
  }

  // Avisos del SMN
  for (const a of smn?.alerts ?? []) {
    const t = Date.parse(a.onset || a.effective || a.sent);
    if (!Number.isFinite(t) || !a.id) continue;
    const d = day(hist, stormDate(t));
    if (d.avisos.some((x) => x.id === a.id)) continue;
    d.avisos.push({
      id: a.id, desde: artClock(t), hasta: a.expires ? artClock(Date.parse(a.expires)) : null,
      evento: (a.event || '').slice(0, 80), titulo: (a.headline || '').slice(0, 140), severidad: a.severity || null,
      corto_plazo: !!a.shortTerm, zonas: [...new Set((a.areas ?? []).map((x) => x.desc))].slice(0, 8), centro: alertCenter(a),
    });
  }

  // Satélite
  if (nowcast?.hora_utc && Array.isArray(nowcast.celulas)) {
    const t = Date.parse(nowcast.hora_utc);
    const d = day(hist, stormDate(t));
    for (const c of nowcast.celulas) {
      const ot = c.topes_sobresalientes ?? 0;
      if (!(ot > 0 || c.tope_min_C <= -63)) continue;
      if (d.satelite.some((x) => x.utc === nowcast.hora_utc && x.lat === c.lat && x.lon === c.lon)) continue;
      d.satelite.push({ utc: nowcast.hora_utc, hora: artClock(t), lat: c.lat, lon: c.lon, tope_C: c.tope_min_C, topes_sobresalientes: ot, cerca_de: c.cerca_de ?? null, tendencia: c.tendencia ?? null });
    }
    // Quedarse con las más significativas: primero las que tienen topes que sobresalen, después las más frías.
    d.satelite.sort((x, y) => y.topes_sobresalientes - x.topes_sobresalientes || x.tope_C - y.tope_C);
    d.satelite = d.satelite.slice(0, MAX_SAT);
  }

  // Reportes (los issues son la fuente: se reconstruyen cada vez)
  if (Array.isArray(reports)) {
    for (const d of Object.values(hist.dias)) d.reportes = [];
    for (const r of reports) day(hist, r.fecha).reportes.push(r);
  }
  // Publicaciones de la red
  if (publicaciones?.desde && Array.isArray(publicaciones.items)) {
    for (const [d, x] of Object.entries(hist.dias)) if (d >= publicaciones.desde) x.publicaciones = [];
    for (const p of publicaciones.items) {
      if (!p.dia_tormenta || p.dia_tormenta < publicaciones.desde) continue;
      day(hist, p.dia_tormenta).publicaciones.push({
        id: p.id, visto: p.visto_en, hora: artClock(Date.parse(p.visto_en)), lat: r2(p.lat), lon: r2(p.lon),
        vio: p.que_vio ?? [], video: !!p.video_url, foto: !!p.foto_path, autor: (p.autor_nombre ?? '').split(' ')[0] || null,
      });
    }
  }
  return hist;
}

/**
 * Comparación de un día: dónde apuntó el pronóstico y si hubo avisos a corto plazo o señales del satélite cerca.
 * `radio` en km alrededor del centro de la zona pronosticada.
 */
export function verifyDay(d, radio = 150) {
  const pron = d.pron_manana ?? d.pron_dia_antes;
  const zona = pron?.zonas?.[0] ?? null;
  const ctr = zona?.centro ?? (pron?.max_grilla ? { lat: pron.max_grilla.lat, lon: pron.max_grilla.lon } : null);
  const near = (p) => ctr && p && km(ctr, p) <= radio;
  const acp = d.avisos.filter((a) => a.corto_plazo);
  const sat = d.satelite ?? [];
  const pubs = d.publicaciones ?? [];
  const fuerte = (p) => p.vio.some((x) => ['tornado', 'embudo', 'rotación'].includes(x));
  return {
    pubs: pubs.length, pubs_cerca: pubs.filter((p) => near(p)).length,
    pubs_fuertes: pubs.filter(fuerte).length, pubs_fuertes_cerca: pubs.filter((p) => fuerte(p) && near(p)).length,
    potencial: zona?.potencial ?? pron?.max_grilla?.v ?? null,
    zona: zona?.zona ?? null,
    acp: acp.length, acp_cerca: acp.filter((a) => near(a.centro)).length,
    sat_ot: sat.filter((s) => s.topes_sobresalientes > 0).length,
    sat_cerca: sat.filter((s) => s.topes_sobresalientes > 0 && near(s)).length,
    tope_min: sat.length ? Math.min(...sat.map((s) => s.tope_C)) : null,
  };
}
