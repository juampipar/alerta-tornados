// Aprender de los errores: cuánto se corren, en promedio, la zona y la hora de las tormentas reales
// respecto de lo pronosticado, y corregir el pronóstico con eso. También la ventana de horas de cada zona.
import { km, movePoint } from './risk.mjs';

const MIN_DIAS = 3; // con menos días no se corrige nada
const MAX_KM = 80, MAX_H = 3; // topes de la corrección
const RADIO_KM = 250; // eventos más lejos que esto del centro pronosticado son otra cosa
const FUERTE = ['tornado', 'embudo', 'rotación'];

// "HH:MM" del día de tormenta → horas desde las 0 h (la madrugada cuenta como 24+).
const hours = (hhmm) => { const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/); if (!m) return null; const h = +m[1] + +m[2] / 60; return h < 6 ? h + 24 : h; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
function wmedian(items) { // [{x, w}]
  const s = [...items].sort((a, b) => a.x - b.x), tot = s.reduce((t, i) => t + i.w, 0);
  let acc = 0;
  for (const i of s) { acc += i.w; if (acc >= tot / 2) return i.x; }
  return null;
}
const r1 = (x) => Math.round(x * 10) / 10;

/** Error de un día: dónde y cuándo aparecieron las tormentas fuertes respecto de la zona pronosticada. */
export function dayError(d) {
  const pron = d.pron_manana ?? d.pron_dia_antes;
  const z = pron?.zonas?.[0];
  const fcH = hours(z?.hora_pico);
  if (!z?.centro || fcH == null) return null;
  const ev = [];
  for (const a of d.avisos ?? []) if (a.corto_plazo && a.centro) ev.push({ ...a.centro, h: hours(a.desde), w: 1 });
  for (const s of d.satelite ?? []) if (s.topes_sobresalientes > 0) ev.push({ lat: s.lat, lon: s.lon, h: hours(s.hora), w: 1 });
  for (const p of d.publicaciones ?? []) ev.push({ lat: p.lat, lon: p.lon, h: hours(p.hora), w: (p.vio ?? []).some((x) => FUERTE.includes(x)) ? 2 : 1 });
  const near = ev.filter((e) => Number.isFinite(e.lat) && km(z.centro, e) <= RADIO_KM);
  const peso = near.reduce((t, e) => t + e.w, 0);
  if (near.length < 2 || peso < 2) return null;
  const lat = near.reduce((t, e) => t + e.lat * e.w, 0) / peso, lon = near.reduce((t, e) => t + e.lon * e.w, 0) / peso;
  const conHora = near.filter((e) => e.h != null);
  const obsH = conHora.length ? wmedian(conHora.map((e) => ({ x: e.h, w: e.w }))) : null;
  return {
    zona: z.zona,
    este_km: Math.round((lon - z.centro.lon) * 111.32 * Math.cos((z.centro.lat * Math.PI) / 180)),
    norte_km: Math.round((lat - z.centro.lat) * 111.32),
    dt_h: obsH == null ? null : r1(obsH - fcH),
    eventos: near.length,
  };
}

/**
 * Corrección aprendida con todos los días anteriores a `today` que tuvieron zona pronosticada y tormentas cerca.
 * Usa la mediana (un día raro no la arrastra) y la achica cuando hay pocos días.
 */
export function computeBias(hist, today) {
  const dias = Object.entries(hist?.dias ?? {}).filter(([f]) => f < today).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([fecha, d]) => { const e = dayError(d); return e && { fecha, ...e }; }).filter(Boolean);
  const n = dias.length;
  const base = { dias_usados: n, minimo: MIN_DIAS, aplicado: false, este_km: 0, norte_km: 0, horas: 0, dispersion_h: null, detalle: dias.slice(-30) };
  if (n < MIN_DIAS) return base;
  const k = n / (n + 3); // con 3 días pesa la mitad; con 30, casi todo
  const clamp = (x, m) => Math.max(-m, Math.min(m, x));
  const dts = dias.map((x) => x.dt_h).filter((x) => x != null);
  const dt = dts.length ? median(dts) : 0;
  return {
    ...base, aplicado: true,
    este_km: Math.round(clamp(median(dias.map((x) => x.este_km)) * k, MAX_KM)),
    norte_km: Math.round(clamp(median(dias.map((x) => x.norte_km)) * k, MAX_KM)),
    horas: r1(clamp(dt * k, MAX_H)),
    dispersion_h: dts.length ? r1(median(dts.map((x) => Math.abs(x - dt)))) : null,
  };
}

/** Corre el centro de una zona según la corrección aprendida. */
export function shiftZone(z, bias) {
  if (!bias?.aplicado || (!bias.este_km && !bias.norte_km)) return z;
  const d = Math.hypot(bias.este_km, bias.norte_km);
  const deg = (Math.atan2(bias.este_km, bias.norte_km) * 180) / Math.PI;
  return { ...z, ctr: movePoint(z.ctr, deg, d), corrida_km: Math.round(d) };
}

/**
 * Ventana de horas de una zona: horas seguidas alrededor del pico en que la zona está a menos de 10 puntos de su máximo
 * (y por encima de 45). Devuelve [desde, hasta] en horas desde las 0 h del día (la madrugada como 24+).
 * cells: [{ lat, lon }] de la grilla; series(k) → puntajes por hora; idx: índices de hora de la ventana del día.
 */
export function zoneWindow(z, pts, score, idx, hourOf) {
  const mem = [];
  pts.forEach(([lat, lon], k) => { if (km(z.ctr, { lat, lon }) <= z.r) mem.push(k); });
  if (!mem.length || !idx.length) return null;
  const zs = idx.map((j) => Math.max(...mem.map((k) => score[k][j] ?? 0)));
  let p = 0;
  zs.forEach((v, n) => { if (v > zs[p]) p = n; });
  const umbral = Math.max(45, zs[p] - 10);
  let a = p, b = p;
  while (a > 0 && zs[a - 1] >= umbral) a--;
  while (b < zs.length - 1 && zs[b + 1] >= umbral) b++;
  return [hourOf(idx[a]), hourOf(idx[b]) + 1];
}

/** Ventana final: la del modelo, corrida por la hora aprendida y ensanchada por cuánto varía el error. */
export function correctedWindow(w, bias) {
  if (!w) return null;
  if (!bias?.aplicado) return w;
  const pad = Math.min(2, (bias.dispersion_h ?? 0) / 2);
  return [Math.max(11, w[0] + bias.horas - pad), w[1] + bias.horas + pad];
}
