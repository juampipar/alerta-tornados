// Lógica compartida (navegador + script de alertas). Heurística de "potencial de tormenta severa",
// NO es un pronóstico de tornado.
export const HOME = { name: 'Leones', lat: -32.66, lon: -62.3 };

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
  { name: 'Santa Rosa (LP)', lat: -36.62, lon: -64.29 },
  { name: 'Gualeguaychú', lat: -33.01, lon: -58.52 },
];

export function forecastUrl(points = POINTS) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lon).join(','),
    hourly: 'cape,convective_inhibition,lifted_index,wind_speed_10m,wind_direction_10m,wind_speed_500hPa,wind_direction_500hPa',
    wind_speed_unit: 'ms',
    timezone: 'America/Argentina/Cordoba',
    forecast_days: '3',
  });
  return 'https://api.open-meteo.com/v1/forecast?' + q;
}

export async function fetchForecast(points = POINTS, fetchFn = fetch) {
  const r = await fetchFn(forecastUrl(points));
  if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : [j];
}

const uv = (s, d) => [-s * Math.sin((d * Math.PI) / 180), -s * Math.cos((d * Math.PI) / 180)];

/** Mejor hora (12–21 h locales) del día `date` (YYYY-MM-DD) para un punto. */
export function scoreDay(loc, date) {
  const h = loc.hourly;
  let best = null;
  h.time.forEach((t, i) => {
    if (!t.startsWith(date)) return;
    const hour = +t.slice(11, 13);
    if (hour < 12 || hour > 21) return;
    const cape = h.cape[i] ?? 0;
    const cin = Math.abs(h.convective_inhibition[i] ?? 0);
    const li = h.lifted_index[i] ?? 5;
    const [u1, v1] = uv(h.wind_speed_10m[i] ?? 0, h.wind_direction_10m[i] ?? 0);
    const [u5, v5] = uv(h.wind_speed_500hPa[i] ?? 0, h.wind_direction_500hPa[i] ?? 0);
    const shear = Math.hypot(u5 - u1, v5 - v1); // m/s, cizalladura 10 m → 500 hPa
    let s = (Math.min(cape, 3000) / 3000) * 45 + (Math.min(shear, 25) / 25) * 40;
    if (li <= -6) s += 10; else if (li <= -3) s += 5;
    if (cin > 200) s -= 35; else if (cin > 100) s -= 20; else if (cin > 50) s -= 8;
    s = Math.max(0, Math.min(100, Math.round(s)));
    if (!best || s > best.score) best = { score: s, cape: Math.round(cape), cin: Math.round(cin), shear: +shear.toFixed(1), li, hour };
  });
  return best;
}

export function level(score) {
  if (score >= 65) return { key: 'alto', label: 'Alto', color: '#e5383b' };
  if (score >= 45) return { key: 'mod', label: 'Moderado', color: '#f59f00' };
  if (score >= 25) return { key: 'bajo', label: 'Bajo', color: '#fcc419' };
  return { key: 'nulo', label: 'Sin potencial', color: '#6c757d' };
}

export function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const driveHours = (kmStraight) => (kmStraight * 1.3) / 90;

export function rank(locs, points, date) {
  return locs
    .map((loc, i) => ({ ...points[i], ...scoreDay(loc, date), dist: Math.round(km(HOME, points[i])) }))
    .filter((r) => r.score !== undefined)
    .sort((a, b) => b.score - a.score || a.dist - b.dist);
}
