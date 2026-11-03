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

const HOURLY = [
  'cape', 'convective_inhibition', 'lifted_index', 'dew_point_2m', 'precipitation',
  'wind_speed_10m', 'wind_direction_10m', 'wind_speed_850hPa', 'wind_direction_850hPa',
  'wind_speed_500hPa', 'wind_direction_500hPa',
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
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r1 = (x) => Math.round(x * 10) / 10;

export function metrics(h, i) {
  const [u1, v1] = uv(h.wind_speed_10m[i] ?? 0, h.wind_direction_10m[i] ?? 0);
  const [u8, v8] = uv(h.wind_speed_850hPa[i] ?? 0, h.wind_direction_850hPa[i] ?? 0);
  const [u5, v5] = uv(h.wind_speed_500hPa[i] ?? 0, h.wind_direction_500hPa[i] ?? 0);
  return {
    cape: Math.round(h.cape[i] ?? 0),
    cin: Math.round(Math.abs(h.convective_inhibition[i] ?? 0)),
    li: r1(h.lifted_index[i] ?? 5),
    td: r1(h.dew_point_2m[i] ?? 0),
    pr: r1(h.precipitation[i] ?? 0),
    shear: r1(Math.hypot(u5 - u1, v5 - v1)), // cizalladura profunda ~0–5,5 km (m/s)
    ll: r1(Math.hypot(u8 - u1, v8 - v1)), // cizalladura baja ~0–1,5 km (m/s)
  };
}

export function scoreOf(m) {
  let s =
    (Math.min(m.cape, 3000) / 3000) * 35 +
    clamp01((m.shear - 5) / 20) * 30 +
    clamp01((m.ll - 3) / 12) * 15;
  if (m.li <= -6) s += 10; else if (m.li <= -3) s += 5;
  if (m.td >= 18) s += 10; else if (m.td >= 15) s += 5; else if (m.td < 10) s -= 10;
  if (m.pr >= 1) s += 5;
  if (m.cin > 200) s -= 35; else if (m.cin > 100) s -= 20; else if (m.cin > 50) s -= 8;
  if (m.cape < 100) s = Math.min(s, 15);
  return Math.max(0, Math.min(100, Math.round(s)));
}

export const SERIES = ['score', 'cape', 'cin', 'li', 'td', 'pr', 'shear', 'll'];

/** Descarga y procesa todo. Devuelve el mismo formato que data/forecast.json. */
export async function buildDataset(fetchFn = fetch, { grid = true } = {}) {
  const gp = grid ? gridPoints() : [];
  const locs = await fetchMany([...POINTS, ...gp], fetchFn);
  const times = locs[0].hourly.time;
  const towns = POINTS.map((p, k) => {
    const t = { ...p };
    for (const s of SERIES) t[s] = [];
    times.forEach((_, i) => {
      const m = metrics(locs[k].hourly, i);
      m.score = scoreOf(m);
      for (const s of SERIES) t[s].push(m[s]);
    });
    return t;
  });
  const gridScores = gp.map((_, k) => times.map((_, i) => scoreOf(metrics(locs[POINTS.length + k].hourly, i))));
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
