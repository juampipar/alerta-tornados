// Entrenamiento del índice con tornados reales de EE.UU. (base pública del SPC) y el ambiente de cada caso
// (archivo de pronósticos de Open-Meteo: los mismos modelos y variables que usa el panel).
// Lógica pura: la usan scripts/entrenar/*.mjs (Actions) y el panel (para aplicar el modelo).
import { km } from './risk.mjs';

/* ---------- Casos ---------- */

/** Parsea el CSV del SPC (1950-20xx_actual_tornadoes.csv). Devuelve tornados con hora UTC. */
export function parseSpc(csv, { desde = 2022, minEF = 1 } = {}) {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const col = (n) => head.indexOf(n);
  const [iy, im, id, it, itz, imag, ilat, ilon] = ['yr', 'mo', 'dy', 'time', 'tz', 'mag', 'slat', 'slon'].map(col);
  const out = [];
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    const yr = +c[iy];
    if (yr < desde || +c[imag] < minEF) continue;
    const lat = +c[ilat], lon = +c[ilon];
    if (!lat || !lon) continue;
    const [hh, mm] = String(c[it]).split(':').map(Number);
    // tz 3 = hora estándar del centro (CST = UTC−6); 9 = UTC.
    const off = +c[itz] === 9 ? 0 : 6;
    const t = Date.UTC(yr, +c[im] - 1, +c[id], hh + off, mm || 0);
    out.push({ t, lat, lon, ef: +c[imag] });
  }
  return out;
}

/** Junta tornados del mismo brote (a menos de 50 km y 2 h): un caso por grupo. */
export function dedupe(torn) {
  const s = [...torn].sort((a, b) => a.t - b.t), out = [];
  for (const x of s) if (!out.some((y) => Math.abs(y.t - x.t) < 2 * 3600e3 && km(x, y) < 50)) out.push(x);
  return out;
}

// Generador de números al azar con semilla (los casos tienen que salir siempre iguales).
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * Casos sin tornado: la mitad "cerca" (mismo día de un tornado, a 300–600 km) y la mitad al azar en la temporada,
 * siempre a más de 300 km y 6 h de cualquier tornado (de cualquier intensidad).
 */
export function negatives(pos, todos, n, seed = 7) {
  const r = rng(seed), out = [];
  const lejos = (p) => !todos.some((x) => Math.abs(x.t - p.t) < 6 * 3600e3 && km(x, p) < 300);
  let tries = 0;
  while (out.length < n && tries++ < n * 200) {
    let p;
    if (out.length % 2 === 0) { // cerca de un tornado del mismo día
      const b = pos[Math.floor(r() * pos.length)], d = 300 + r() * 300, a = r() * 2 * Math.PI;
      p = { t: b.t + Math.round((r() - 0.5) * 4) * 3600e3, lat: b.lat + (d * Math.cos(a)) / 111.2, lon: b.lon + (d * Math.sin(a)) / (111.2 * Math.cos((b.lat * Math.PI) / 180)) };
    } else { // al azar en la temporada, en la tarde
      const b = pos[Math.floor(r() * pos.length)];
      const day = Date.UTC(new Date(b.t).getUTCFullYear(), new Date(b.t).getUTCMonth(), 1 + Math.floor(r() * 28));
      p = { t: day + (21 + Math.floor(r() * 5)) * 3600e3, lat: 29 + r() * 16, lon: -104 + r() * 22 };
    }
    if (p.lat < 26 || p.lat > 48 || p.lon < -106 || p.lon > -76) continue;
    if (lejos(p)) out.push({ ...p, ef: -1 });
  }
  return out;
}

/* ---------- Ambiente de cada caso ---------- */

/** Espeja los vientos del hemisferio norte al sur (refleja norte↔sur): la helicidad tornádica queda negativa como acá. */
export function mirrorHourly(h) {
  const out = { ...h };
  for (const [k, v] of Object.entries(h)) if (k.startsWith('wind_direction')) out[k] = v.map((d) => (d == null ? null : (540 - d) % 360));
  return out;
}

/* ---------- Modelo ---------- */

// Variables que usa el modelo (todas salen de metrics() del panel).
export const FEATURES = [
  ['log_cape', (m) => Math.log1p(Math.max(0, m.cape ?? 0))],
  ['cizalla', (m) => m.shear ?? 0],
  ['cizalla_baja', (m) => m.ll ?? 0],
  ['helicidad', (m) => Math.max(0, -(m.srh ?? 0))], // ciclónica (hemisferio sur)
  ['base_nube', (m) => Math.min(m.lcl ?? 1500, 3000)],
  ['rocio', (m) => m.td ?? 10],
  ['tapa', (m) => Math.min(m.cin ?? 0, 400)],
  ['energia_x_viento', (m) => Math.sqrt(Math.max(0, m.cape ?? 0) / 1000) * (m.shear ?? 0) / 20],
  ['energia_x_giro', (m) => Math.sqrt(Math.max(0, m.cape ?? 0) / 1000) * Math.max(0, -(m.srh ?? 0)) / 100],
];
export const featureRow = (m) => FEATURES.map(([, f]) => f(m));

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Regresión logística con regularización L2 (descenso por gradiente, variables estandarizadas). */
export function trainLogistic(X, y, { epochs = 3000, lr = 0.2, l2 = 1e-3 } = {}) {
  const n = X.length, d = X[0].length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
  const pos = y.reduce((s, v) => s + v, 0), wPos = n / (2 * pos), wNeg = n / (2 * (n - pos)); // clases balanceadas
  let w = new Array(d).fill(0), b = 0;
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(b + Z[i].reduce((s, v, j) => s + v * w[j], 0));
      const err = (p - y[i]) * (y[i] ? wPos : wNeg);
      for (let j = 0; j < d; j++) g[j] += err * Z[i][j];
      gb += err;
    }
    w = w.map((wj, j) => wj - lr * (g[j] / n + l2 * wj));
    b -= (lr * gb) / n;
  }
  return { w, b, mean, std };
}

export function predict(model, row) {
  return sigmoid(model.b + row.reduce((s, v, j) => s + ((v - model.mean[j]) / model.std[j]) * model.w[j], 0));
}

/** Área bajo la curva ROC: probabilidad de que un caso con tornado puntúe más alto que uno sin tornado. */
export function auc(scores, y) {
  const s = scores.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0, nPos = 0;
  for (let i = 0; i < s.length;) {
    let j = i; while (j < s.length && s[j][0] === s[i][0]) j++;
    const avg = (i + 1 + j) / 2; // empates: rango promedio
    for (let k = i; k < j; k++) if (s[k][1]) { sumPos += avg; nPos++; }
    rank = j; i = j;
  }
  const nNeg = s.length - nPos;
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : null;
}
