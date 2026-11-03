// Lógica compartida (navegador + GitHub Actions).
// El índice es una heurística de POTENCIAL de tormentas severas/rotantes, NO un pronóstico de tornado.

export const HOME = { name: 'Leones', lat: -32.66, lon: -62.3 };
export const TZ = 'America/Argentina/Cordoba';

export const POINTS = [
  { name: 'Leones', lat: -32.66, lon: -62.3 },
  { name: 'Marcos Juárez', lat: -32.7, lon: -62.1 },
  { name: 'Bell Ville', lat: -32.63, lon: -62.69 },
  { name: 'Villa María', lat: -32.41, lon: -63.24 },
  { name: 'Río Cuarto', lat: -33.13, lon: -64.35 },
  { name: 'Córdoba', lat: -31.42, lon: -64.18 },
  { name: 'San Francisco', lat: -31.43, lon: -62.08 },
  { name: 'Rafaela', lat: -31.25, lon: -61.49 },
  { name: 'Santa Fe', lat: -31.63, lon: -60.7 },
  { name: 'Paraná', lat: -31.73, lon: -60.53 },
  { name: 'Rosario', lat: -32.95, lon: -60.64 },
  { name: 'Cañada de Gómez', lat: -32.82, lon: -61.4 },
  { name: 'Casilda', lat: -33.04, lon: -61.17 },
  { name: 'Venado Tuerto', lat: -33.75, lon: -61.97 },
  { name: 'Laboulaye', lat: -34.13, lon: -63.39 },
  { name: 'Rufino', lat: -34.26, lon: -62.71 },
  { name: 'Pergamino', lat: -33.89, lon: -60.57 },
  { name: 'Junín', lat: -34.59, lon: -60.95 },
  { name: 'Rojas', lat: -34.2, lon: -60.73 },
  { name: 'Chivilcoy', lat: -34.9, lon: -60.02 },
  { name: '9 de Julio', lat: -35.45, lon: -60.88 },
  { name: 'Bolívar', lat: -36.23, lon: -61.11 },
  { name: 'Trenque Lauquen', lat: -35.97, lon: -62.73 },
  { name: 'General Pico', lat: -35.66, lon: -63.76 },
  { name: 'Santa Rosa (LP)', lat: -36.62, lon: -64.29 },
  { name: 'Gualeguaychú', lat: -33.01, lon: -58.52 },
];

// Región del Pasillo que se analiza en grilla.
export const BBOX = { s: -37.5, n: -30, w: -66, e: -57 };
export const GRID_STEP = 0.75;

export function gridPoints() {
  const out = [];
  for (let lat = BBOX.n; lat >= BBOX.s - 1e-9; lat -= GRID_STEP)
    for (let lon = BBOX.w; lon <= BBOX.e + 1e-9; lon += GRID_STEP) out.push({ lat: +lat.toFixed(2), lon: +lon.toFixed(2) });
  return out;
}

const LEVELS = [925, 850, 700, 500, 400]; // hPa
const HOURLY = [
  'cape', 'convective_inhibition', 'lifted_index', 'temperature_2m', 'dew_point_2m', 'precipitation', 'surface_pressure',
  'wind_speed_10m', 'wind_direction_10m',
  ...LEVELS.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]),
];

export function forecastUrl(points) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lon).join(','),
    hourly: HOURLY.join(','),
    wind_speed_unit: 'ms',
    timezone: TZ,
    forecast_days: '3',
  });
  return 'https://api.open-meteo.com/v1/forecast?' + q;
}

async function fetchMany(points, fetchFn, chunk = 50) {
  const out = [];
  for (let i = 0; i < points.length; i += chunk) {
    const r = await fetchFn(forecastUrl(points.slice(i, i + chunk)));
    if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
    const j = await r.json();
    out.push(...(Array.isArray(j) ? j : [j]));
  }
  return out;
}

const uv = (s, d) => [-s * Math.sin((d * Math.PI) / 180), -s * Math.cos((d * Math.PI) / 180)];
const r1 = (x) => Math.round(x * 10) / 10;
const num = (x) => (x == null || !Number.isFinite(x) ? null : x);
// Altura estándar (m sobre el mar) por si el modelo no da la geopotencial.
const stdZ = (p) => 44330 * (1 - (p / 1013.25) ** 0.1903);

/**
 * Perfil de viento [z sobre el suelo (m), u, v] desde 10 m hacia arriba.
 * Descarta los niveles que quedan bajo tierra (presión del nivel ≥ presión en superficie):
 * así en las sierras no se usa viento extrapolado.
 */
export function windProfile(h, i, elev = 0) {
  const ps = num(h.surface_pressure?.[i]) ?? 1013.25 * (1 - elev / 44330) ** 5.255;
  const prof = [[10, ...uv(h.wind_speed_10m[i] ?? 0, h.wind_direction_10m[i] ?? 0)]];
  for (const p of LEVELS) {
    const s = num(h[`wind_speed_${p}hPa`]?.[i]), d = num(h[`wind_direction_${p}hPa`]?.[i]);
    if (s == null || d == null || p >= ps - 10) continue;
    const z = (num(h[`geopotential_height_${p}hPa`]?.[i]) ?? stdZ(p)) - elev;
    if (z > prof[prof.length - 1][0] + 50) prof.push([z, ...uv(s, d)]);
  }
  return prof;
}

/** Viento interpolado a una altura (m sobre el suelo). */
export function windAt(prof, z) {
  if (z <= prof[0][0]) return [prof[0][1], prof[0][2]];
  for (let k = 1; k < prof.length; k++) {
    const [z1, u1, v1] = prof[k - 1], [z2, u2, v2] = prof[k];
    if (z <= z2) { const t = (z - z1) / (z2 - z1); return [u1 + (u2 - u1) * t, v1 + (v2 - v1) * t]; }
  }
  const l = prof[prof.length - 1];
  return [l[1], l[2]];
}

const top = (prof) => prof[prof.length - 1][0];

/**
 * Movimiento de tormenta de Bunkers para la supercélula que se desvía a la IZQUIERDA:
 * en el hemisferio sur es la ciclónica (la que da tornados) y su helicidad es negativa.
 */
export function bunkersLeft(prof) {
  let mu = 0, mv = 0, n = 0;
  for (let z = 0; z <= 6000; z += 250) { const [u, v] = windAt(prof, z); mu += u; mv += v; n++; }
  mu /= n; mv /= n;
  const lo = [0, 0], hi = [0, 0];
  for (let z = 0; z <= 500; z += 250) { const w = windAt(prof, z); lo[0] += w[0] / 3; lo[1] += w[1] / 3; }
  for (let z = 5500; z <= 6000; z += 250) { const w = windAt(prof, z); hi[0] += w[0] / 3; hi[1] += w[1] / 3; }
  const su = hi[0] - lo[0], sv = hi[1] - lo[1], s = Math.hypot(su, sv) || 1;
  return [mu - (7.5 * sv) / s, mv + (7.5 * su) / s];
}

/** Helicidad relativa a la tormenta (m²/s²) entre el suelo y `depth` m. */
export function srh(prof, [cu, cv], depth) {
  let tot = 0, [u0, v0] = windAt(prof, 0);
  for (let z = 100; z <= depth; z += 100) {
    const [u1, v1] = windAt(prof, z);
    tot += (u1 - cu) * (v0 - cv) - (u0 - cu) * (v1 - cv);
    u0 = u1; v0 = v1;
  }
  return tot;
}

const bulk = (prof, z) => { const [a, b] = windAt(prof, 0), [c, d] = windAt(prof, z); return Math.hypot(c - a, d - b); };

export function metrics(h, i, elev = 0) {
  const prof = windProfile(h, i, elev);
  const t = num(h.temperature_2m?.[i]), td = num(h.dew_point_2m[i]);
  const cin = num(h.convective_inhibition[i]), li = num(h.lifted_index[i]);
  // Sin datos hasta ~6 km (terreno alto o faltan niveles) la cizalla no es confiable.
  const deepOk = top(prof) >= 5000;
  const sm = deepOk ? bunkersLeft(prof) : null; // movimiento de la tormenta (m/s)
  return {
    cape: Math.round(h.cape[i] ?? 0),
    cin: cin == null ? null : Math.round(Math.abs(cin)), // null = el modelo no lo da (no se asume "tapa abierta")
    li: li == null ? null : r1(li),
    td: td == null ? null : r1(td),
    lcl: t == null || td == null ? null : Math.max(0, Math.round((125 * (t - td)) / 10) * 10), // base de nube (m)
    pr: r1(h.precipitation[i] ?? 0),
    shear: deepOk ? r1(bulk(prof, 6000)) : null, // cizalladura 0–6 km (m/s)
    ll: r1(bulk(prof, 1000)), // cizalladura 0–1 km (m/s)
    srh: sm ? Math.round(srh(prof, sm, 1000)) : null, // helicidad 0–1 km, mov. izquierdo (negativa = ciclónica)
    mdir: sm ? Math.round(((Math.atan2(sm[0], sm[1]) * 180) / Math.PI + 360) % 360) : null, // hacia dónde va la tormenta (0 = norte, 90 = este)
    mspd: sm ? Math.round(Math.hypot(sm[0], sm[1]) * 3.6) : null, // velocidad de la tormenta (km/h)
    hi: elev > 1200 ? 1 : 0, // terreno alto: datos poco confiables
  };
}

/**
 * Índice 0–100 de potencial de supercélulas/tornados. Energía y viento se MULTIPLICAN:
 * sin CAPE no hay tormenta y sin cizalladura no se organiza ni rota.
 *  - energía: CAPE / 2500 (tope 1,2)
 *  - viento:  55% cizalla 0–6 km / 20 m/s + 25% helicidad 0–1 km / 100 + 20% cizalla 0–1 km / 10 m/s
 *  - base = 70 · √(energía · viento) + bonus (LI, rocío, lluvia del modelo, escalados por el viento)
 *  - techo por cizalla profunda: < 10 m/s → máx. 35; < 15 m/s → máx. 55 (no hay supercélulas)
 *  - × base de nube (LCL): < 1000 m ideal; > 2000 m los tornados casi no llegan al suelo
 *  - × tapa (CIN); bonus para días de mucha cizalla y poco CAPE (otoño/invierno)
 */
export function scoreOf(m) {
  if (m.hi || m.shear == null) return 0;
  const cyc = Math.max(0, -(m.srh ?? 0)); // helicidad ciclónica (hemisferio sur)
  const energy = Math.min(m.cape, 3000) / 2500;
  const wind = 0.55 * Math.min(m.shear / 20, 1.25) + 0.25 * Math.min(cyc / 100, 1.25) + 0.2 * Math.min(m.ll / 10, 1.25);
  let s = 70 * Math.sqrt(energy * wind);
  if (m.cape >= 300) {
    let b = 0;
    if (m.li != null) { if (m.li <= -6) b += 8; else if (m.li <= -3) b += 4; }
    if (m.td >= 18) b += 6;
    if (m.pr >= 1) b += 4;
    s += b * Math.min(1, wind);
  }
  // Poco CAPE pero mucha cizalla y base baja: tornados de otoño/invierno.
  if (m.cape >= 200 && m.cape < 1000 && m.shear >= 20 && cyc >= 100 && m.lcl != null && m.lcl < 1000) s += 12;
  s *= Math.min(1, 0.5 + wind); // poco viento: tormentas de "pulso", sin rotación
  if (m.shear < 10) s = Math.min(s, 35);
  else if (m.shear < 15) s = Math.min(s, 55);
  if (m.lcl != null) s *= m.lcl <= 1000 ? 1 : m.lcl >= 2000 ? 0.55 : 1 - (0.45 * (m.lcl - 1000)) / 1000;
  if (m.td != null && m.td < 10) s *= 0.7;
  if (m.cin != null) s *= m.cin > 200 ? 0.35 : m.cin > 100 ? 0.65 : m.cin > 50 ? 0.85 : 1;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export const SERIES = ['score', 'cape', 'cin', 'li', 'td', 'lcl', 'pr', 'shear', 'll', 'srh', 'mdir', 'mspd'];

/** Descarga y procesa todo. Devuelve el mismo formato que data/forecast.json. */
export async function buildDataset(fetchFn = fetch, { grid = true } = {}) {
  const gp = grid ? gridPoints() : [];
  const locs = await fetchMany([...POINTS, ...gp], fetchFn);
  const times = locs[0].hourly.time;
  const towns = POINTS.map((p, k) => {
    const t = { ...p };
    for (const s of SERIES) t[s] = [];
    times.forEach((_, i) => {
      const m = metrics(locs[k].hourly, i, locs[k].elevation ?? 0);
      m.score = scoreOf(m);
      for (const s of SERIES) t[s].push(m[s]);
    });
    return t;
  });
  const gridScores = gp.map((_, k) => times.map((_, i) => scoreOf(metrics(locs[POINTS.length + k].hourly, i, locs[POINTS.length + k].elevation ?? 0))));
  return { generated: new Date().toISOString(), times, towns, grid: { step: GRID_STEP, pts: gp.map((p) => [p.lat, p.lon]), score: gridScores } };
}

export function level(score) {
  if (score >= 65) return { key: 'alto', label: 'Alto', color: '#ff3b5c' };
  if (score >= 45) return { key: 'mod', label: 'Moderado', color: '#ff8c1a' };
  if (score >= 25) return { key: 'bajo', label: 'Bajo', color: '#ffd43b' };
  return { key: 'nulo', label: 'Sin potencial', color: '#5c6b84' };
}

/** Color continuo para la grilla. */
export function scoreColor(s) {
  const stops = [[15, [255, 230, 80]], [35, [255, 170, 40]], [55, [255, 90, 40]], [70, [235, 30, 90]], [85, [190, 40, 220]]];
  if (s <= stops[0][0]) return 'rgb(255,230,80)';
  for (let i = 1; i < stops.length; i++) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i];
    if (s <= b) { const t = (s - a) / (b - a); return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * t)).join(',')})`; }
  }
  return 'rgb(190,40,220)';
}

export function verdict(score) {
  if (score >= 65) return 'Día de caza: hay ingredientes para supercélulas con rotación.';
  if (score >= 45) return 'Vale la pena seguirlo: tormentas fuertes posibles, alguna podría rotar.';
  if (score >= 25) return 'Tormentas posibles, pero la rotación es poco probable.';
  return 'No da: faltan energía o viento en altura.';
}

export function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const driveHours = (kmStraight) => (kmStraight * 1.3) / 90;

/** Puesta del sol, hora local de Argentina (UTC−3) en horas decimales. Fórmula aproximada (±5 min). */
export function sunsetHour(lat, lon, date) {
  const d = new Date(date + 'T12:00:00Z');
  const n = Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const r = Math.PI / 180;
  const decl = 23.44 * Math.sin((2 * Math.PI * (284 + n)) / 365);
  const cosH = (Math.sin(-0.833 * r) - Math.sin(lat * r) * Math.sin(decl * r)) / (Math.cos(lat * r) * Math.cos(decl * r));
  const H = Math.acos(Math.max(-1, Math.min(1, cosH))) / r;
  const B = (2 * Math.PI * (n - 81)) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  return ((720 - 4 * lon - eot + 4 * H) / 60 - 3 + 24) % 24;
}

const RUMBOS = ['norte', 'noreste', 'este', 'sudeste', 'sur', 'sudoeste', 'oeste', 'noroeste'];
/** Nombre del rumbo (0 = norte, 90 = este). */
export const rumbo = (deg) => RUMBOS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/**
 * Zonas de caza: hasta 2 áreas con más potencial (≥ 45), separadas al menos ~120 km.
 * cells: [{ lat, lon, v }] con el puntaje de cada celda de la grilla; towns: localidades.
 * Devuelve [{ ctr: {lat, lon}, r (km), v, town, peak }]. La usan el mapa y las alertas de Telegram.
 */
export function huntZones(cells, towns) {
  const top = cells.filter((c) => c.v >= 45).sort((a, b) => b.v - a.v);
  const zones = [];
  for (const c of top) {
    if (zones.length >= 2) break;
    if (zones.some((z) => km(z.peak, c) < 160)) continue;
    const mem = top.filter((x) => x.v >= Math.max(45, c.v - 10) && km(c, x) <= 120);
    const w = mem.reduce((s, x) => s + x.v, 0);
    const ctr = { lat: mem.reduce((s, x) => s + x.lat * x.v, 0) / w, lon: mem.reduce((s, x) => s + x.lon * x.v, 0) / w };
    const r = Math.min(100, Math.max(35, Math.max(...mem.map((x) => km(ctr, x))) + 35));
    if (zones.some((z) => km(z.ctr, ctr) < 120)) continue; // misma zona vista desde otra celda
    const town = towns.filter((t) => !zones.some((z) => z.town === t)).reduce((a, b) => (km(ctr, b) < km(ctr, a) ? b : a));
    // Nombre: el pueblo más cercano; si el centro queda lejos (> 25 km), "al <rumbo> de <pueblo>".
    const d = km(ctr, town);
    const dir = rumbo((Math.atan2((ctr.lon - town.lon) * Math.cos((town.lat * Math.PI) / 180), ctr.lat - town.lat) * 180) / Math.PI);
    const name = d > 25 ? `al ${dir} de ${town.name}` : town.name;
    zones.push({ peak: c, ctr, r, v: c.v, town, name });
  }
  return zones;
}
