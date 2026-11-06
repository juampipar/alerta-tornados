// Varios modelos a la vez: el mismo índice calculado con GFS, ICON y ECMWF por separado, en una grilla
// más gruesa (1,5°) más los pueblos. Donde coinciden, la zona y la hora son más confiables.
import { POINTS, BBOX, TZ, km, metrics, scoreOf, forecastUrl } from './risk.mjs';

export const MODELOS = [
  { id: 'gfs_seamless', nombre: 'GFS' },
  { id: 'icon_seamless', nombre: 'ICON' },
  { id: 'ecmwf_ifs025', nombre: 'ECMWF' },
];
const STEP = 1.5;

export function coarsePoints() {
  const out = [];
  for (let lat = BBOX.n; lat >= BBOX.s - 1e-9; lat -= STEP)
    for (let lon = BBOX.w; lon <= BBOX.e + 1e-9; lon += STEP) out.push({ lat: +lat.toFixed(2), lon: +lon.toFixed(2) });
  return out;
}

/** Saca las series de un modelo de una respuesta con varios modelos (las claves vienen como "cape_gfs_seamless"). */
export function hourlyOf(hourly, id) {
  const h = {};
  for (const [k, v] of Object.entries(hourly)) if (k.endsWith('_' + id)) h[k.slice(0, -id.length - 1)] = v;
  return h;
}

/**
 * Descarga y calcula el índice con cada modelo. Un modelo sin datos útiles (si Open-Meteo no da
 * alguna variable) queda con ok: false y no se usa.
 */
export async function buildModels(fetchFn = fetch, { pausa = 61e3, esperarAntes = false } = {}) {
  // Open-Meteo gratis: 600 pedidos por minuto, y cada punto con 3 modelos y ~25 variables cuenta como ~8.
  // Por eso cada tanda va en su propio minuto (y se espera si el pronóstico principal se acaba de bajar).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pts = [...POINTS.map((p) => ({ lat: p.lat, lon: p.lon })), ...coarsePoints()];
  const locs = [];
  if (esperarAntes) await sleep(pausa);
  for (let i = 0; i < pts.length; i += 40) {
    if (i) await sleep(pausa);
    const url = forecastUrl(pts.slice(i, i + 40)) + '&models=' + MODELOS.map((m) => m.id).join(',');
    let r;
    for (let intento = 1; ; intento++) {
      r = await fetchFn(url);
      if (r.status !== 429 || intento >= 3) break;
      await sleep(pausa + 5e3); // límite por minuto: esperar y reintentar
    }
    if (!r.ok) throw new Error('Open-Meteo (modelos) HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    locs.push(...(Array.isArray(j) ? j : [j]));
  }
  const times = locs[0].hourly.time;
  const score = {}, ok = {};
  for (const m of MODELOS) {
    let datos = 0;
    score[m.nombre] = locs.map((loc) => {
      const h = hourlyOf(loc.hourly, m.id);
      if (!h.cape || !h.wind_speed_10m) return times.map(() => null);
      return times.map((_, i) => {
        if (h.cape[i] == null || h.wind_speed_10m[i] == null) return null;
        datos++;
        return scoreOf(metrics(h, i, loc.elevation ?? 0));
      });
    });
    ok[m.nombre] = datos > times.length * pts.length * 0.5; // más de la mitad con datos
  }
  return { generated: new Date().toISOString(), tz: TZ, times, pts: pts.map((p) => [p.lat, p.lon]), modelos: MODELOS.map((m) => m.nombre), ok, score };
}

/**
 * Qué dice cada modelo de una zona de caza en un día: el máximo cerca del centro (radio + 40 km)
 * entre las 11 y las 2 h, y a qué hora. Coinciden los que llegan a 45 o más.
 * ctr: centro de la zona según el modelo principal (sin la corrección aprendida).
 */
export function zoneAgreement(mod, ctr, r, date) {
  if (!mod?.times?.length) return null;
  const nd = new Date(Date.parse(date + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const idx = mod.times.flatMap((t, i) => {
    const h = +t.slice(11, 13);
    return (t.startsWith(date) && h >= 11) || (t.startsWith(nd) && h <= 2) ? [i] : [];
  });
  if (!idx.length) return null;
  const near = mod.pts.map(([lat, lon], k) => (km(ctr, { lat, lon }) <= r + 40 ? k : -1)).filter((k) => k >= 0);
  if (!near.length) return null;
  const hourOf = (j) => { const t = mod.times[j]; return +t.slice(11, 13) + (t.startsWith(date) ? 0 : 24); };
  const por = mod.modelos.filter((n) => mod.ok[n]).map((n) => {
    let v = -1, j = idx[0];
    for (const k of near) for (const i of idx) { const s = mod.score[n][k][i]; if (s != null && s > v) { v = s; j = i; } }
    return { modelo: n, v: Math.max(0, v), hora: hourOf(j) };
  });
  if (!por.length) return null;
  const si = por.filter((x) => x.v >= 45);
  const horas = si.map((x) => x.hora);
  return {
    por_modelo: por,
    coinciden: si.length, total: por.length,
    acuerdo: si.length === por.length && por.length >= 2 ? 'alto' : si.length >= 2 ? 'medio' : 'bajo',
    horas: horas.length ? [Math.min(...horas), Math.max(...horas)] : null,
  };
}

/** Ensancha la ventana de horas para que incluya los picos de los modelos que coinciden (corridos por lo aprendido). */
export function widenWindow(w, ag, dt = 0) {
  if (!w || !ag?.horas) return w;
  return [Math.max(11, Math.min(w[0], ag.horas[0] + dt - 0.5)), Math.max(w[1], ag.horas[1] + dt + 0.5)];
}
