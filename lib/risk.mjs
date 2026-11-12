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
  // San Luis
  { name: 'San Luis', lat: -33.3, lon: -66.34 },
  { name: 'Villa Mercedes', lat: -33.68, lon: -65.46 },
  { name: 'Merlo', lat: -32.34, lon: -65.01 },
  { name: 'Tilisarao', lat: -32.73, lon: -65.29 },
  { name: 'Justo Daract', lat: -33.86, lon: -65.18 },
];

// Región del Pasillo que se analiza en grilla.
export const BBOX = { s: -37.5, n: -30, w: -67, e: -57 }; // incluye San Luis
export const GRID_STEP = 0.75;

export function gridPoints() {
  const out = [];
  for (let lat = BBOX.n; lat >= BBOX.s - 1e-9; lat -= GRID_STEP)
    for (let lon = BBOX.w; lon <= BBOX.e + 1e-9; lon += GRID_STEP) out.push({ lat: +lat.toFixed(2), lon: +lon.toFixed(2) });
  return out;
}

const LEVELS = [925, 850, 700, 500, 400]; // hPa
export const HOURLY = [
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
/**
 * Puntos para armar las zonas: las celdas de la grilla (~80 km) MÁS los pueblos. La grilla promedia y puede
 * esconder un pico local (p. ej. Trenque Lauquen 93 con la celda en 85); con los pueblos, la zona n.º 1 es siempre
 * la de mayor puntaje, igual que el ranking de pueblos. Devuelve [{ lat, lon, v, i }] (máximo en las horas idx).
 */
export function zoneCells(grid, towns, idx) {
  const best = (arr) => { let v = 0, i = idx[0]; for (const j of idx) if ((arr?.[j] ?? 0) > v) { v = arr[j]; i = j; } return { v, i }; };
  return [
    ...(grid?.pts ?? []).map(([lat, lon], k) => ({ lat, lon, ...best(grid.score[k]) })),
    ...(towns ?? []).map((t) => ({ lat: t.lat, lon: t.lon, ...best(t.score) })),
  ];
}
export const ZONE_NEAR_KM = 110;
export function huntZones(cells, towns, max = 2) {
  // Solo celdas a menos de ZONE_NEAR_KM de algún pueblo del Pasillo: la grilla es un rectángulo y
  // sus bordes caen en Uruguay, el río o el mar, donde el modelo puede dar números altos sin sentido.
  const top = cells.filter((c) => c.v >= 45 && towns.some((t) => km(t, c) <= ZONE_NEAR_KM)).sort((a, b) => b.v - a.v);
  const zones = [];
  for (const c of top) {
    if (zones.length >= max) break;
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

/**
 * A qué pueblo ir dentro de una zona de caza: el de más puntaje dentro del círculo
 * (o a menos de 15 km del borde); si no hay ninguno, el más cercano al centro.
 * ranked: [{ t, score, ... }] ordenado de mayor a menor.
 */
export function goTo(zone, ranked) {
  return ranked.find((r) => km(r.t, zone.ctr) <= zone.r + 15)
    ?? ranked.reduce((a, b) => (km(b.t, zone.ctr) < km(a.t, zone.ctr) ? b : a));
}

/* ---------------- Punto para mirar y chequeo del camino ---------------- */
/** Punto a `d` km de `p` con rumbo `deg` (0 = norte, 90 = este). */
export function movePoint(p, deg, d) {
  const r = (deg * Math.PI) / 180;
  return { lat: p.lat + (d * Math.cos(r)) / 111.2, lon: p.lon + (d * Math.sin(r)) / (111.2 * Math.cos((p.lat * Math.PI) / 180)) };
}
/** Rumbo (0 = norte, 90 = este) de `a` hacia `b`. */
export const bearingTo = (a, b) => ((Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI + 360) % 360;

/**
 * Dónde pararse a mirar: al costado izquierdo del camino de las tormentas (en el hemisferio sur,
 * del lado norte si van al este), un poco adelante. Ahí entra el aire cálido, se ve la base y el
 * granizo queda del otro lado. mdir = hacia dónde van las tormentas.
 */
export function viewpoint(zone, mdir = 90) {
  const side = Math.min(zone.r, 60) * 0.6 + 15;
  return movePoint(movePoint(zone.ctr, mdir - 90, side), mdir, 20);
}

/**
 * ¿El camino de `origin` a `vp` cruza el paso de las tormentas? Supone que nacen en el centro de la
 * zona ~2 h antes del pico y avanzan con el movimiento pronosticado (franja de ~R km de ancho).
 * Las horas son decimales del día (pueden pasar de 24). Devuelve null o { p, h } del primer cruce.
 */
export function routeCheck(origin, vp, zone, mdir, mspd, leaveH, peakH) {
  const R = Math.min(zone.r, 60) * 0.5 + 15, t0 = peakH - 2;
  for (let f = 0; f <= 1.0001; f += 0.04) {
    const p = { lat: origin.lat + (vp.lat - origin.lat) * f, lon: origin.lon + (vp.lon - origin.lon) * f };
    const h = leaveH + driveHours(km(origin, p));
    if (h < t0) continue;
    const c = movePoint(zone.ctr, mdir, mspd * (h - t0));
    if (km(p, c) < R) return { p, h };
  }
  return null;
}

/** Nombre del lugar (pueblo/paraje y ruta) con OpenStreetMap. null si no se pudo. */
export async function placeName(p, fetchFn = fetch) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&zoom=14&accept-language=es`;
    const headers = typeof window === 'undefined' ? { 'user-agent': 'alerta-tornados (panel personal de tormentas)' } : {};
    const r = await fetchFn(url, { headers });
    if (!r.ok) return null;
    const a = (await r.json()).address || {};
    const place = a.village || a.town || a.hamlet || a.isolated_dwelling || a.locality || a.city || a.municipality || a.county || null;
    return place ? { place, road: a.road || null, dept: a.county || a.state_district || null } : null;
  } catch { return null; }
}

/** Si el camino cruza, la última hora de salida (hasta 4 h antes) que lo evita; null si no hay. */
export function safeLeave(origin, vp, zone, mdir, mspd, leaveH, peakH) {
  for (let h = leaveH - 0.25; h >= leaveH - 4; h -= 0.25) if (!routeCheck(origin, vp, zone, mdir, mspd, h, peakH)) return h;
  return null;
}

/**
 * Opciones para ir: para cada zona, hora pico (de su celda más fuerte), movimiento de las tormentas
 * (del pueblo más cercano), 👁 parada (estación de servicio si `snap` la encuentra), distancia,
 * hora de salida y chequeo del camino.
 * - zones: de huntZones, con peak.i = índice horario del máximo; times: horas del pronóstico.
 * - snap(vpBase) → { lat, lon, name, ... } | null: dónde parar de verdad (estación/pueblo).
 * - nowH: hora actual (decimal) si es hoy: la salida no puede ser antes de ahora y las opciones a
 *   las que no llegás a tiempo van al final.
 */
export const plainKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
export function huntOptions(zones, towns, times, date, origin, snap = null, nowH = null) {
  const opts = zones.map((z) => {
    const i = z.peak.i, ts = times[i];
    // Hora pico del modelo, corrida por lo aprendido del historial (z.dt, en horas).
    const peakH = +ts.slice(11, 13) + (ts.startsWith(date) ? 0 : 24) + (z.dt ?? 0);
    const t = towns.reduce((a, b) => (km(b, z.ctr) < km(a, z.ctr) ? b : a));
    const mdir = t.mdir?.[i] ?? 90, mspd = t.mspd?.[i] ?? null;
    const base = viewpoint(z, mdir);
    const stop = snap ? snap(base) : null;
    const vp = stop ? { lat: stop.lat, lon: stop.lon } : base;
    const dist = Math.round(km(origin, vp)), drive = driveHours(dist);
    // Las tormentas arrancan al principio de la ventana de horas (o 2 h antes del pico si no hay ventana).
    // Llegar 1 h 30 antes de que empiecen: se viaja con el cielo seco, antes de que nazcan las tormentas.
    const start = Math.max(11, z.ventana ? Math.min(peakH - 1, z.ventana[0]) : peakH - 2), arrive = start - 1.5;
    let leave = arrive - drive, late = false;
    let hit = mspd != null ? routeCheck(origin, vp, z, mdir, mspd, leave, peakH) : null;
    let safe = hit ? safeLeave(origin, vp, z, mdir, mspd, leave, peakH) : null;
    if (hit && safe != null) leave = safe;
    if (nowH != null && leave < nowH) { // ya es tarde para el horario ideal: salir ahora
      leave = nowH; late = true;
      hit = mspd != null ? routeCheck(origin, vp, z, mdir, mspd, leave, peakH) : null;
      safe = null;
    }
    const arriveAt = leave + drive;
    const reachable = arriveAt <= peakH + 0.5; // llegás a más tardar media hora después del pico
    return { z, i, peakH, mdir, mspd, base, stop, vp, dist, drive, leave, arriveAt, late, reachable, hit, safe, town: t };
  });
  // Primero las que llegás a tiempo; dentro de cada grupo, la de más potencial.
  return opts.sort((a, b) => b.reachable - a.reachable || b.z.v - a.z.v);
}

/**
 * Dónde parar cerca de `p`: la estación de servicio más cercana (OpenStreetMap, hasta 30 km). Si no
 * hay, el pueblo más cercano de la lista. Nunca devuelve un punto en el agua.
 */
export async function nearestStop(p, towns, fetchFn = fetch) {
  try {
    const q = `[out:json][timeout:20];(node(around:30000,${p.lat.toFixed(4)},${p.lon.toFixed(4)})[amenity=fuel];way(around:30000,${p.lat.toFixed(4)},${p.lon.toFixed(4)})[amenity=fuel];);out center 60;`;
    const headers = { 'content-type': 'application/x-www-form-urlencoded', ...(typeof window === 'undefined' ? { 'user-agent': 'alerta-tornados (panel personal de tormentas)' } : {}) };
    const r = await fetchFn('https://overpass-api.de/api/interpreter', { method: 'POST', headers, body: 'data=' + encodeURIComponent(q) });
    if (r.ok) {
      const els = ((await r.json()).elements || []).map((e) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, tags: e.tags || {} })).filter((e) => e.lat != null);
      if (els.length) {
        const e = els.reduce((a, b) => (km(b, p) < km(a, p) ? b : a));
        const brand = e.tags.brand || e.tags.operator || null;
        const name = e.tags.name && e.tags.name !== brand ? e.tags.name : null;
        return { lat: e.lat, lon: e.lon, kind: 'estación', label: [brand || 'Estación de servicio', name].filter(Boolean).join(' · '), road: e.tags['addr:street'] || null };
      }
    }
  } catch { /* sin conexión: usar el pueblo */ }
  if (!towns?.length) return null;
  const t = towns.reduce((a, b) => (km(b, p) < km(a, p) ? b : a));
  return { lat: t.lat, lon: t.lon, kind: 'pueblo', label: t.name, road: null };
}

/* ---------------- Parada rural: sobre ruta asfaltada, afuera de los pueblos ---------------- */
const UNPAVED = /unpaved|dirt|gravel|ground|compacted|earth|sand|grass|mud|fine_gravel|pebblestone/;
const PAVED = /asphalt|paved|concrete|chipseal/;
// Distancia mínima a cada tipo de lugar: en la ciudad no se ve nada y cuando llega la tormenta no se sale.
const TOWN_GAP = { city: 9, town: 6, village: 3, hamlet: 1 };
const roadName = (t) => t.ref ? t.ref.split(';')[0].trim() : t.name || null;

/** Consulta de OpenStreetMap (Overpass) para rutarPunto: rutas asfaltadas y pueblos alrededor de `p`. */
export function ruralQuery(p, radioKm = 18) {
  const c = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, r = Math.round(radioKm * 1000), rp = Math.round((radioKm + 10) * 1000);
  return `[out:json][timeout:25];(way(around:${r},${c})[highway~"^(trunk|primary|secondary|tertiary)$"];)->.w;` +
    `.w out body;.w >;out skel qt;node(around:${rp},${c})[place~"^(city|town|village|hamlet)$"];out body;`;
}

/**
 * Elige el mejor punto rural a partir de la respuesta de Overpass (sin red: se puede probar).
 * - p: punto ideal; away: rumbo hacia donde conviene escapar (alejándose del camino de la tormenta).
 * Puntaje: cerca del punto ideal, en un cruce de dos rutas, y con una ruta que salga hacia `away`.
 * Devuelve { lat, lon, kind: 'rural', label, roads, cruce, escape, pueblo: { name, km, rumbo } } o null.
 */
export function pickRural(els, p, away = null) {
  const nodes = new Map(), ways = [], places = [];
  for (const e of els) {
    if (e.type === 'node' && e.tags?.place) places.push({ lat: e.lat, lon: e.lon, name: e.tags.name, kind: e.tags.place });
    else if (e.type === 'node') nodes.set(e.id, { lat: e.lat, lon: e.lon });
    else if (e.type === 'way') {
      const t = e.tags || {};
      if (UNPAVED.test(t.surface || '')) continue;
      if (t.highway === 'tertiary' && !PAVED.test(t.surface || '')) continue; // terciarias: solo si dicen asfalto
      ways.push({ nodes: e.nodes || [], name: roadName(t), hw: t.highway });
    }
  }
  // En qué rutas está cada nodo y hacia dónde salen desde ahí (rumbo a un nodo ~1 km más allá).
  const at = new Map();
  for (const w of ways) {
    const pts = w.nodes.map((id) => nodes.get(id));
    w.nodes.forEach((id, k) => {
      const n = pts[k];
      if (!n) return;
      const e = at.get(id) || { n, roads: new Set(), dirs: [] };
      e.roads.add(w.name || `${w.hw}#${ways.indexOf(w)}`);
      for (const step of [1, -1]) {
        let j = k + step;
        while (pts[j] && km(n, pts[j]) < 1 && pts[j + step]) j += step;
        if (pts[j]) e.dirs.push(bearingTo(n, pts[j]));
      }
      at.set(id, e);
    });
  }
  const gap = (n) => places.every((pl) => km(n, pl) >= (TOWN_GAP[pl.kind] ?? 3));
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  let best = null;
  for (const e of at.values()) {
    if (!gap(e.n)) continue;
    const d = km(p, e.n), cruce = e.roads.size >= 2;
    const escape = away != null && e.dirs.some((b) => diff(b, away) <= 50);
    const score = d - (cruce ? 6 : 0) - (escape ? 6 : 0);
    if (!best || score < best.score) best = { ...e, d, cruce, escape, score };
  }
  if (!best) return null;
  const roads = [...best.roads].filter((r) => !r.includes('#'));
  const pl = places.filter((x) => x.kind !== 'hamlet').reduce((a, b) => (!a || km(best.n, b) < km(best.n, a) ? b : a), null);
  const pueblo = pl ? { name: pl.name, km: Math.round(km(best.n, pl)), rumbo: rumbo(bearingTo(pl, best.n)) } : null;
  const label = (best.cruce && roads.length >= 2 ? `Cruce ${roads.slice(0, 2).join(' y ')}` : roads[0] ? `Ruta ${roads[0]}` : 'Ruta asfaltada')
    + (pueblo ? ` (${pueblo.km} km al ${pueblo.rumbo} de ${pueblo.name})` : '');
  return { lat: +best.n.lat.toFixed(5), lon: +best.n.lon.toFixed(5), kind: 'rural', label, roads, cruce: best.cruce, escape: best.escape, pueblo, a_km: Math.round(best.d) };
}

/**
 * Parada rural cerca de `p`: sobre ruta asfaltada, lejos de los pueblos, ojalá en un cruce y con una
 * salida hacia `away`. Si OpenStreetMap no responde o no hay nada, null (se usa el punto aproximado).
 */
export async function ruralStop(p, away = null, fetchFn = fetch, radioKm = 18) {
  try {
    const headers = { 'content-type': 'application/x-www-form-urlencoded', ...(typeof window === 'undefined' ? { 'user-agent': 'alerta-tornados (panel personal de tormentas)' } : {}) };
    const r = await fetchFn('https://overpass-api.de/api/interpreter', { method: 'POST', headers, body: 'data=' + encodeURIComponent(ruralQuery(p, radioKm)) });
    if (!r.ok) return null;
    return pickRural((await r.json()).elements || [], p, away);
  } catch { return null; }
}

/**
 * Posición estimada de un núcleo del satélite a la hora `t` (ms): mueve el núcleo con su dirección y
 * velocidad desde la hora de la imagen. Devuelve { lat, lon, edadMin } o el mismo punto si no hay movimiento.
 */
export function coreAt(core, imgUtc, t = Date.now()) {
  const edadMin = Math.max(0, (t - Date.parse(imgUtc)) / 60000);
  // Con más de 90 min de atraso el dato es viejo: no se adelanta (la tormenta pudo cambiar mucho).
  if (core.mov_deg == null || !core.kmh || edadMin > 90) return { lat: core.lat, lon: core.lon, edadMin, stale: edadMin > 90 };
  return { ...movePoint(core, core.mov_deg, (core.kmh * edadMin) / 60), edadMin };
}
