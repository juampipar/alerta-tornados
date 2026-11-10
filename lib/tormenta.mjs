// ⛈️ Tormenta fuerte o granizo hacia TU ubicación (no solo tornados).
// Junta tres fuentes y dice qué tan seguro es, para no dar falsas alarmas:
//  1. Avisos a corto plazo del SMN que cubren tu punto (lo más confiable: lo emite un meteorólogo mirando el radar).
//  2. Núcleos del satélite GOES-19 (nowcast.json): dónde está cada tormenta ahora, hacia dónde va, si crece,
//     si tiene topes muy fríos o que sobresalen y si los rayos dan un salto.
//  3. El ambiente pronosticado en el pueblo más cercano (energía y cizalla): sin energía no hay granizo grande.
// El satélite NO ve el granizo: da señales. Por eso nunca decimos "seguro que graniza" sin un aviso oficial.
import { km, rumbo, bearingTo, coreAt } from './risk.mjs';

export const RADIO_KM = 20; // ancho del núcleo de lluvia y granizo + error de posición
export const HORIZONTE_MIN = 120; // más allá, una tormenta cambia demasiado
const ANG = { norte: 0, noreste: 45, este: 90, sudeste: 135, sur: 180, sudoeste: 225, oeste: 270, noroeste: 315 };
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export function inPoly([lat, lon], poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
const cubre = (a, p) => a.areas.some((ar) => ar.polygons.some((poly) => inPoly([p.lat, p.lon], poly)));
const esTormenta = (a) => /tormenta|granizo|convectiv|corto plazo/i.test(`${a.event} ${a.headline} ${a.description}`);
const nombraGranizo = (a) => /granizo/i.test(`${a.event} ${a.headline} ${a.description}`);

// Energía (CAPE) y cizalla 0–6 km pronosticadas en el pueblo más cercano, a la hora más cercana.
export function ambienteEn(data, p, t = Date.now()) {
  if (!data?.towns?.length || !data.times?.length) return null;
  const town = data.towns.reduce((a, b) => (km(p, b) < km(p, a) ? b : a));
  if (km(p, town) > 80) return null;
  // data.times está en hora argentina (UTC−3) sin zona.
  const i = data.times.reduce((best, s, k) => {
    const d = Math.abs(Date.parse(s + ':00-03:00') - t);
    return d < best.d ? { k, d } : best;
  }, { k: -1, d: Infinity });
  if (i.k < 0 || i.d > 3 * 3600e3) return null;
  return { pueblo: town.name, cape: town.cape?.[i.k] ?? null, shear: town.shear?.[i.k] ?? null };
}

// Cuánto se parece a una tormenta con granizo. Devuelve el nivel y las señales que lo explican.
export function granizo(c, amb, avisoGranizo) {
  const s = [];
  let p = 0;
  if (avisoGranizo) { p += 2; s.push('el aviso del SMN nombra granizo'); }
  if (c) {
    if (c.topes_sobresalientes > 0) { p += 2; s.push('topes que sobresalen (corriente ascendente muy fuerte)'); }
    if (c.salto_rayos) { p += 2; s.push(`salto de rayos (${c.rayos_10min} en 10 min, antes ${c.rayos_10min_antes})`); }
    else if (c.rayos_10min >= 40) { p += 1; s.push(`muchos rayos (${c.rayos_10min} en 10 min)`); }
    if (c.tope_min_C <= -63) { p += 2; s.push(`topes muy fríos (${c.tope_min_C} °C)`); }
    else if (c.tope_min_C <= -52) { p += 1; s.push(`topes fríos (${c.tope_min_C} °C)`); }
    if (c.tendencia === 'creciendo') { p += 1; s.push('está creciendo'); }
    if (c.tendencia === 'debilitándose') { p -= 1; s.push('se está debilitando'); }
  }
  if (amb?.cape != null) {
    if (amb.cape >= 2500) { p += 2; s.push(`energía muy alta (${Math.round(amb.cape)} J/kg)`); }
    else if (amb.cape >= 1500) { p += 1; s.push(`energía alta (${Math.round(amb.cape)} J/kg)`); }
    else if (amb.cape < 500) { p -= 1; s.push(`poca energía (${Math.round(amb.cape)} J/kg): difícil que caiga granizo grande`); }
  }
  if (amb?.shear >= 15) { p += 1; s.push(`viento en altura fuerte (${Math.round(amb.shear)} m/s): tormentas que duran`); }
  return { nivel: p >= 5 ? 'probable' : p >= 3 ? 'posible' : 'poco probable', puntos: p, señales: s };
}

const fuerte = (c) => c.fuerza !== 'moderada' || c.topes_sobresalientes > 0 || c.salto_rayos || c.rayos_10min >= 30;

// Tormentas que vienen hacia `me` en las próximas 2 h, de la más segura a la menos.
// Cada una: { fuente, llega: 'alta'|'media'|'baja', eta (min), d (km), pasa_a (km del centro), granizo, porque, dudas }
export function amenazas({ me, nc, smn, data, now = Date.now() }) {
  const out = [];
  const amb = ambienteEn(data, me, now);
  // 1. Aviso a corto plazo del SMN que cubre tu punto.
  for (const a of smn?.alerts ?? []) {
    if (!a.shortTerm || !esTormenta(a) || !cubre(a, me)) continue;
    if (a.expires && Date.parse(a.expires) < now) continue;
    out.push({
      fuente: 'smn', id: a.id, llega: 'alta', eta: null, d: null, hasta: a.expires || null, evento: a.event || a.headline,
      granizo: granizo(null, amb, nombraGranizo(a)),
      porque: ['el SMN puso un <b>aviso a corto plazo</b> que cubre tu ubicación (lo emiten mirando el radar)'], dudas: [],
    });
  }
  // 2. Núcleos del satélite.
  const fresco = nc?.hora_utc && now - Date.parse(nc.hora_utc) < 60 * 60e3;
  for (const c0 of fresco ? nc.celulas ?? [] : []) {
    if (!fuerte(c0)) continue;
    const est = coreAt(c0, nc.hora_utc, now);
    const c = { ...c0, lat: est.lat, lon: est.lon, edadMin: Math.round(est.edadMin) };
    const d = km(me, c);
    const mv = c.mov_deg ?? (c.va_hacia ? ANG[c.va_hacia] : null);
    let eta, pasa, diff = null;
    if (d <= RADIO_KM) { eta = 0; pasa = Math.round(d); }
    else {
      if (mv == null || !c.kmh) continue; // sin movimiento no se puede decir si llega
      diff = angDiff(mv, bearingTo(c, me));
      if (diff >= 75) continue; // se aleja o pasa de largo
      const along = d * Math.cos((diff * Math.PI) / 180), cross = d * Math.sin((diff * Math.PI) / 180);
      // Error de dirección típico ±20°: a más distancia, más incierto por dónde pasa.
      if (cross > RADIO_KM + 0.35 * along) continue;
      eta = Math.round((along / c.kmh) * 60);
      pasa = Math.round(cross);
      if (eta > HORIZONTE_MIN) continue;
    }
    // ¿Qué tan seguro es que llegue?
    let p = 0;
    const porque = [], dudas = [];
    if (eta === 0) { p += 5; porque.push('ya está encima o a menos de 20 km'); }
    else {
      if (pasa <= RADIO_KM) { p += 2; porque.push(`viene derecho hacia vos (pasaría a ~${pasa} km)`); }
      else { p -= 1; dudas.push(`puede pasar de costado (su centro pasaría a ~${pasa} km)`); }
      if (eta <= 45) { p += 2; porque.push(`llega pronto (~${eta} min): poco tiempo para que cambie`); }
      else if (eta <= 75) p += 1;
      else { p -= 1; dudas.push(`falta más de 1 h: puede debilitarse o desviarse`); }
      if (/sat/.test(c.mov_fuente ?? '')) { p += 1; porque.push('el satélite confirma hacia dónde va'); }
      else dudas.push(c.tendencia === 'nueva' ? 'es nueva: todavía no se sabe bien cómo se mueve' : 'la dirección sale solo del pronóstico (el satélite no la confirma)');
    }
    if (c.tendencia === 'creciendo' || c.tendencia === 'estable') p += 1;
    if (c.tendencia === 'debilitándose') { p -= 2; dudas.push('se está debilitando'); }
    if (c.edadMin > 30) dudas.push(`el dato del satélite tiene ${c.edadMin} min`);
    out.push({
      fuente: 'satelite', llega: p >= 5 ? 'alta' : p >= 3 ? 'media' : 'baja', eta, d: Math.round(d), pasa_a: pasa,
      desde: rumbo(bearingTo(me, c)), kmh: c.kmh ?? null, core: c, granizo: granizo(c, amb, false), porque, dudas,
    });
  }
  // Si hay aviso del SMN y además el satélite ve la tormenta, se suman las señales del satélite al aviso.
  const smnA = out.find((x) => x.fuente === 'smn');
  const sat = out.filter((x) => x.fuente === 'satelite').sort((a, b) => a.eta - b.eta)[0];
  const eta = (x) => x.eta ?? 999;
  if (smnA && sat) {
    const g = granizo(sat.core, amb, smnA.granizo.señales.includes('el aviso del SMN nombra granizo'));
    Object.assign(smnA, { granizo: g, core: sat.core, eta: sat.eta, d: sat.d, desde: sat.desde, kmh: sat.kmh, pasa_a: sat.pasa_a });
    smnA.porque.push(...sat.porque);
    smnA.dudas.push(...sat.dudas);
    out.splice(out.indexOf(sat), 1); // es la misma tormenta
  } else if (smnA) {
    // Aviso solo, sin tormenta fuerte en el satélite yendo hacia vos: el polígono es grande, no es seguro en tu punto.
    smnA.llega = 'media';
    smnA.dudas.push('el satélite todavía no ve una tormenta fuerte yendo hacia vos, y el aviso cubre una zona grande');
  }
  const R = { alta: 0, media: 1, baja: 2 }, G = { probable: 0, posible: 1, 'poco probable': 2 };
  return out.sort((a, b) => R[a.llega] - R[b.llega] || G[a.granizo.nivel] - G[b.granizo.nivel] || eta(a) - eta(b));
}

// ¿Vale avisar? Alta o media siempre; baja solo si el granizo es al menos posible, falta poco y es de día.
export function valeAvisar(x, { noche = false } = {}) {
  if (!x) return false;
  if (x.llega !== 'baja') return true;
  return !noche && x.granizo.nivel !== 'poco probable' && x.eta != null && x.eta <= 90;
}

// Revisión de alertas pasadas: ¿llegó de verdad? Acierto si en la ventana prevista hubo una tormenta fuerte
// a menos de 25 km o un aviso a corto plazo del SMN que te cubría.
export function revisar(log, { me, nc, smn, now = Date.now() }) {
  const fresco = nc?.hora_utc && now - Date.parse(nc.hora_utc) < 60 * 60e3;
  const encima = (p) => (fresco ? nc.celulas ?? [] : []).some((c0) => {
    if (!fuerte(c0)) return false;
    const e = coreAt(c0, nc.hora_utc, now);
    return km(p, e) <= 25;
  }) || (smn?.alerts ?? []).some((a) => a.shortTerm && esTormenta(a) && cubre(a, p));
  for (const r of log) {
    if (r.llego != null) continue;
    const ini = r.t, fin = r.t + ((r.eta ?? 120) + 60) * 60e3; // aviso del SMN sin hora: 3 h
    if (now >= ini && now <= fin && encima(r.me ?? me)) r.llego = true;
    else if (now > fin) r.llego = false;
  }
  return log;
}

// "🟠 probable: 3 de 4 llegaron" por nivel, con las alertas ya revisadas.
export function aciertos(log) {
  const out = {};
  for (const r of log) {
    if (r.llego == null) continue;
    out[r.llega] ??= { total: 0, llegaron: 0 };
    out[r.llega].total++;
    if (r.llego) out[r.llega].llegaron++;
  }
  return out;
}

export const NIVEL = {
  alta: { emoji: '🔴', txt: 'MUY PROBABLE que te llegue' },
  media: { emoji: '🟠', txt: 'PROBABLE que te llegue' },
  baja: { emoji: '🟡', txt: 'POSIBLE, pero NO es seguro' },
};

/* ---------------- 🎯 Dónde pararse para ver una tormenta (en vivo) ---------------- */
// Al costado izquierdo de su camino (en el hemisferio sur: lado norte si va al este; el granizo cae del otro lado),
// a LADO_KM de su línea y adelante, en un punto al que llegues con margen antes que ella y sin cruzarte por delante.
import { movePoint, driveHours } from './risk.mjs';
export const LADO_KM = 15;
export const LADO_GRANIZO_KM = 22; // si tiene señales de granizo grande, más lejos (las piedras grandes caen lejos del núcleo)
const MARGEN_MIN = 15;
// Señales de granizo grande en el satélite: topes muy fríos, topes que sobresalen o salto de rayos.
export const granizoGrande = (c) => c.tope_min_C <= -63 || c.topes_sobresalientes > 0 || !!c.salto_rayos;

// ¿El camino de `me` a `p` pasa a menos de 20 km de la tormenta en algún momento? (la tormenta avanza mientras manejás)
function cruzaDelante(me, p, c, mdir, kmh) {
  for (let f = 0; f <= 1.0001; f += 0.05) {
    const q = { lat: me.lat + (p.lat - me.lat) * f, lon: me.lon + (p.lon - me.lon) * f };
    const h = driveHours(km(me, q));
    if (km(q, movePoint(c, mdir, kmh * h)) < 20) return true;
  }
  return false;
}

/** Punto para ver una tormenta `c` (posición ya estimada ahora) desde `me`, o null si no llegás o no se mueve. */
export function puntoIntercepcion(c, me) {
  const mdir = c.mov_deg ?? (c.va_hacia ? ANG[c.va_hacia] : null);
  if (mdir == null || !c.kmh || c.kmh < 10) return null;
  const away = (mdir - 90 + 360) % 360; // hacia dónde escapar: alejándose de su camino, del lado bueno
  const lado = granizoGrande(c) ? LADO_GRANIZO_KM : LADO_KM;
  for (let A = 15; A <= 80; A += 5) {
    const base = movePoint(movePoint(c, mdir, A), away, lado);
    const llegas = Math.round(driveHours(km(me, base)) * 60);
    const pasa = Math.round((A / c.kmh) * 60); // cuándo queda a tu costado
    if (llegas + MARGEN_MIN > pasa) continue;
    if (cruzaDelante(me, base, c, mdir, c.kmh)) continue;
    return { base, mdir, away, lado, granizo_grande: lado > LADO_KM, adelante_km: A, llegas_min: llegas, pasa_min: pasa, quedate: km(me, base) < 8 };
  }
  return null;
}

const fuerteVivo = (c) => fuerte(c) && c.tendencia !== 'debilitándose';

/**
 * La mejor tormenta para ir a ver desde `me` y dónde pararse. Prefiere las aisladas (nada a menos de 40 km),
 * con topes que sobresalen o salto de rayos, y las más frías. Devuelve null si no hay ninguna a la que llegues.
 */
export function mejorIntercepcion({ me, nc, now = Date.now(), maxKm = 150 }) {
  const fresco = nc?.hora_utc && now - Date.parse(nc.hora_utc) < 60 * 60e3;
  if (!fresco) return null;
  const todas = (nc.celulas ?? []).map((c0) => { const e = coreAt(c0, nc.hora_utc, now); return { ...c0, lat: e.lat, lon: e.lon, edadMin: Math.round(e.edadMin) }; });
  const cands = todas.filter((c) => fuerteVivo(c) && km(me, c) <= maxKm).map((c) => ({
    c, aislada: !todas.some((o) => o !== c && km(o, c) < 40), d: Math.round(km(me, c)),
    señal: (c.topes_sobresalientes > 0 ? 2 : 0) + (c.salto_rayos ? 2 : 0) + (c.tendencia === 'creciendo' || c.tendencia === 'nueva' ? 1 : 0),
  })).sort((a, b) => b.aislada - a.aislada || b.señal - a.señal || a.c.tope_min_C - b.c.tope_min_C || a.d - b.d);
  for (const x of cands) {
    const p = puntoIntercepcion(x.c, me);
    if (p) return { ...x, ...p, desde: rumbo(bearingTo(me, x.c)) };
  }
  return null;
}

/* ---------------- 🧊 Se te viene el granizo (modo caza) ---------------- */
/**
 * ¿Alguna tormenta fuerte va a pasar a menos de `umbralKm` de `me` en los próximos `horizonteMin` minutos?
 * Se suma un margen por el error de dirección (las superceldas de acá doblan hacia la izquierda, o sea hacia el lado
 * "bueno"). Devuelve la más urgente con hacia dónde escapar (perpendicular a su camino, sin cruzarlo), o null.
 */
export function peligroGranizo({ me, nc, now = Date.now(), umbralKm = 12, horizonteMin = 35 }) {
  const fresco = nc?.hora_utc && now - Date.parse(nc.hora_utc) < 60 * 60e3;
  if (!fresco) return null;
  let peor = null;
  for (const c0 of nc.celulas ?? []) {
    if (!fuerte(c0)) continue;
    const e = coreAt(c0, nc.hora_utc, now), c = { ...c0, lat: e.lat, lon: e.lon };
    const mdir = c.mov_deg ?? (c.va_hacia ? ANG[c.va_hacia] : null);
    const d = km(me, c);
    let pasa, en;
    if (d <= umbralKm) { pasa = d; en = 0; }
    else {
      if (mdir == null || !c.kmh) continue;
      const diff = angDiff(mdir, bearingTo(c, me));
      if (diff >= 90) continue; // ya pasó o se aleja
      const along = d * Math.cos((diff * Math.PI) / 180), cross = d * Math.sin((diff * Math.PI) / 180);
      en = (along / c.kmh) * 60;
      if (en > horizonteMin || cross > umbralKm + 0.2 * along) continue;
      pasa = cross;
    }
    // ¿De qué lado de su camino estás? A la derecha de su movimiento cae el granizo (hemisferio sur).
    const rel = mdir == null ? 0 : ((bearingTo(c, me) - mdir + 540) % 360) - 180; // >0: a la derecha
    const derecha = rel > 0 && pasa >= 3;
    const escape = mdir == null ? (bearingTo(c, me) + 360) % 360 : (mdir + (derecha ? 90 : -90) + 360) % 360;
    const x = { c, d: Math.round(d), pasa_a: Math.round(pasa), en_min: Math.round(en), escape, rumbo_escape: rumbo(escape), lado_granizo: derecha, grande: granizoGrande(c) };
    if (!peor || x.en_min < peor.en_min || (x.en_min === peor.en_min && x.pasa_a < peor.pasa_a)) peor = x;
  }
  return peor;
}

/**
 * Cómo alejarse de una tormenta `c` (posición ya estimada) estando en `me`: perpendicular a su camino, del lado en que
 * estás (sin cruzarla por delante). Si estás casi sobre su camino, hacia el lado bueno (izquierda: sin granizo).
 * Devuelve { seVa } si ya se aleja, o { escape, rumbo_escape, km, pasa_a, en_min, lado_granizo, fuerte }.
 */
export function comoAlejarse(c, me) {
  const mdir = c.mov_deg ?? (c.va_hacia ? ANG[c.va_hacia] : null);
  const d = km(me, c), haciaMi = bearingTo(c, me);
  const fuerteC = c.fuerza !== 'moderada' || c.topes_sobresalientes > 0 || !!c.salto_rayos;
  const dist = fuerteC ? 12 : 10;
  if (mdir == null || !c.kmh) {
    const escape = (haciaMi + 360) % 360; // sin movimiento: alejarse en línea recta
    return { escape, rumbo_escape: rumbo(escape), km: dist, pasa_a: Math.round(d), en_min: null, lado_granizo: false, fuerte: fuerteC, sinMovimiento: true };
  }
  const diff = angDiff(mdir, haciaMi);
  if (diff >= 100 && d > 8) return { seVa: true, fuerte: fuerteC };
  const along = d * Math.cos((diff * Math.PI) / 180), cross = Math.abs(d * Math.sin((diff * Math.PI) / 180));
  const rel = ((haciaMi - mdir + 540) % 360) - 180; // >0: estás a la derecha de su camino (lado del granizo)
  const derecha = rel > 0 && cross >= 3;
  const escape = (mdir + (derecha ? 90 : -90) + 360) % 360;
  return { escape, rumbo_escape: rumbo(escape), km: dist, pasa_a: Math.round(cross), en_min: along > 0 ? Math.round((along / c.kmh) * 60) : 0, lado_granizo: derecha, fuerte: fuerteC };
}
