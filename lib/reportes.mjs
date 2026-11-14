// Reportes de lo que pasó de verdad (tornados, embudos, granizo) que mandás por Telegram con /reporte.
// Cada reporte se cruza con lo que vio el satélite ese día y con los puntos a los que te mandó la app,
// y se guarda en el historial (rama "datos") para que la app aprenda: pesa doble al corregir dónde y cuándo
// aparecen las tormentas fuertes. Lógica pura, sin red ni archivos (la usan alert.mjs, historial.mjs y el panel).
import { km, HOME } from './risk.mjs';
import { artDate, stormDate } from './historial.mjs';

const ART = 3 * 3600e3;
export const FUERTES = ['tornado', 'embudo', 'rotación'];
const TIPOS = [
  ['tornado', /tornado|tromba/],
  ['embudo', /embudo|nube embudo/],
  ['rotación', /rotaci[oó]n|nube pared|pared/],
  ['granizo', /granizo|piedra/],
  ['viento', /revent[oó]n|viento|r[aá]faga/],
];
// Momentos del día sin hora exacta.
const MOMENTOS = [
  [/a la ma[nñ]ana|de ma[nñ]ana/, '10:00'], [/al mediod[ií]a/, '13:00'], [/a la siesta/, '15:00'],
  [/a la tarde|de tarde|por la tarde/, '16:00'], [/al atardecer|al anochecer/, '19:30'], [/a la noche|de noche|por la noche/, '21:30'],
];
const FUENTES = [[/instagram|\big\b/, 'Instagram'], [/twitter|\bx\b/, 'X/Twitter'], [/facebook/, 'Facebook'], [/tiktok/, 'TikTok'], [/whats?app/, 'WhatsApp'], [/youtube/, 'YouTube'], [/noticia|diario|medio/, 'noticias'], [/lo vi yo|yo lo vi|lo vi en persona/, 'visto en persona']];

/** Reportes de antes de que existiera /reporte (13/11/2026: los primeros dos). */
export const SEMILLA = [
  { id: 1, tipo: 'tornado', lugar: 'El Trébol (Santa Fe)', lat: -32.2, lon: -61.7, fecha: '2026-11-13', hora: '19:00', aprox_hora: false, aprox_lugar: false, fuente: 'Instagram', nota: 'Video en Instagram; confirmado por el usuario.', t: Date.parse('2026-11-14T15:00:00Z') },
  { id: 2, tipo: 'tornado', lugar: 'Sur del departamento Juan Martín de Pueyrredón (San Luis)', lat: -34.1, lon: -65.4, fecha: '2026-11-13', hora: '16:00', aprox_hora: true, aprox_lugar: true, fuente: 'usuario', nota: '"A la tarde", en una localidad al sur del departamento.', t: Date.parse('2026-11-14T15:30:00Z') },
];
/** Puntos que mandó la app antes de que se guardaran (el aviso del 13/11 a las 16:13). */
export const SEMILLA_ENVIADOS = [
  { t: Date.parse('2026-11-13T19:13:00Z'), lat: -32.07, lon: -61.8, titulo: 'Punto para ver la tormenta', lugar: 'Cruce RP44-S y RPS338, 14 km al SO de Piamonte' },
];

/** Todos los reportes vigentes: semilla + los del estado, sin los borrados. */
export function todos(state) {
  const borr = new Set(state?.reportesBorrados ?? []);
  const ids = new Set((state?.reportes ?? []).map((r) => r.id));
  return [...SEMILLA.filter((r) => !ids.has(r.id)), ...(state?.reportes ?? [])].filter((r) => !borr.has(r.id)).sort((a, b) => a.id - b.id);
}
export const enviadosDe = (state) => [...SEMILLA_ENVIADOS, ...(state?.enviados ?? [])];

const pad = (n) => String(n).padStart(2, '0');

/**
 * Lee un /reporte escrito como uno habla: "/reporte tornado en El Trébol ayer 19 h, lo vi en Instagram".
 * Devuelve { tipo, lugar, coords?, fecha, hora, aprox_hora, fuente, nota } o { error }.
 */
export function parseReporte(text, nowMs) {
  let s = String(text ?? '').replace(/^\s*\/?reporte(@\w+)?\b/i, '').trim();
  const nota = s;
  if (!s) return { error: 'vacío' };
  const low = s.toLowerCase();
  const tipo = (TIPOS.find(([, re]) => re.test(low)) ?? ['tornado'])[0];
  const fuente = (FUENTES.find(([re]) => re.test(low)) ?? [null, null])[1];

  // Fecha: "ayer", "anteayer", "hoy", "13/11", "13/11/2026". Sin fecha: el día de tormenta actual (de 6 a 6 h).
  let fecha = stormDate(nowMs);
  const dm = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dm) {
    const y0 = +artDate(nowMs).slice(0, 4);
    let y = dm[3] ? +dm[3] : y0;
    if (y < 100) y += 2000;
    fecha = `${y}-${pad(dm[2])}-${pad(dm[1])}`;
    if (!dm[3] && fecha > artDate(nowMs)) fecha = `${y - 1}-${pad(dm[2])}-${pad(dm[1])}`;
    s = s.replace(dm[0], ' ');
  } else if (/\banteayer\b/i.test(s)) fecha = artDate(Date.parse(stormDate(nowMs) + 'T12:00:00Z') - 2 * 864e5 + ART);
  else if (/\bayer\b/i.test(s)) fecha = artDate(Date.parse(stormDate(nowMs) + 'T12:00:00Z') - 864e5 + ART);

  // Coordenadas pegadas ("-32.20, -61.70"): mandan sobre el nombre.
  let coords = null;
  const cm = s.match(/(-\d{1,2}\.\d+)\s*[,; ]\s*(-\d{1,2}\.\d+)/);
  if (cm) { coords = { lat: +cm[1], lon: +cm[2] }; s = s.replace(cm[0], ' '); }

  // Hora: "19 h", "19:30", "a las 7 de la tarde", "7 pm". Si no, el momento del día ("a la tarde") o nada.
  let hora = null, aprox = false;
  const hm = s.match(/\b(?:a las\s+)?(\d{1,2})(?:[:.](\d{2}))?(?:\s*(h|hs|horas|pm|am)\b)?(?:\s+de la (tarde|noche|ma[nñ]ana))?/i);
  const vale = hm && (hm[2] || hm[3] || hm[4] || /a las/i.test(hm[0])) && +hm[1] <= 24;
  if (vale) {
    let h = +hm[1];
    if (/pm|tarde|noche/i.test(hm[3] ?? '') || /tarde|noche/i.test(hm[4] ?? '')) { if (h < 12) h += 12; }
    hora = `${pad(h % 24)}:${hm[2] ?? '00'}`;
    s = s.replace(hm[0], ' ');
  } else {
    const mo = MOMENTOS.find(([re]) => re.test(low));
    if (mo) { hora = mo[1]; aprox = true; }
  }

  // Lugar: lo que queda, sin las palabras de relleno. "en X" manda si está.
  s = s.replace(/\b(anteayer|ayer|hoy)\b/gi, ' ');
  for (const [re] of MOMENTOS) s = s.replace(new RegExp(re.source, 'gi'), ' ');
  for (const [re] of FUENTES) s = s.replace(new RegExp(re.source, 'gi'), ' ');
  for (const [, re] of TIPOS) s = s.replace(new RegExp(re.source, 'gi'), ' ');
  // Relleno solo en las puntas (así "Santa Clara de Buena Vista" queda entero).
  const ANTES = /^(hubo|hay|se|vio|vi|visto|un|una|en|que|lo|y|cerca|de|del|a|al|video|reportado|confirmado)$/i;
  const DESPUES = /^(de|del|a|al|la|las|el|los|en|y|por|que|lo|d[ií]a|video|visto|vi)$/i;
  const limpiar = (x) => { const w = x.split(/\s+/).filter(Boolean); while (w.length && ANTES.test(w[0])) w.shift(); while (w.length && DESPUES.test(w.at(-1))) w.pop(); return w.join(' '); };
  const en = s.match(/\ben\s+(.+)/i);
  const partes = (en ? en[1] : s).split(/[,;.!?\n]/).map(limpiar).filter(Boolean);
  let lugar = partes[0] ?? '';
  lugar = lugar.replace(/\s+/g, ' ').trim();
  if (!lugar && !coords) return { error: 'sin lugar' };
  return { tipo, lugar: lugar || null, coords, fecha, hora, aprox_hora: aprox, fuente, nota: nota.slice(0, 200) };
}

// "HH:MM" del día de tormenta → horas desde las 0 h (la madrugada cuenta como 24+).
const horas = (hhmm) => { const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/); if (!m) return null; const h = +m[1] + +m[2] / 60; return h < 6 ? h + 24 : h; };

/**
 * Cruza un reporte con el día del historial (satélite y pronóstico) y con los puntos que mandó la app.
 * - sat: la tormenta fuerte guardada más cercana (≤ 80 km) entre 3 h antes y 1 h después (los topes fríos
 *   aparecen antes que el tornado, y el yunque se corre decenas de km).
 * - app: el punto más cercano que te mandó la app ese día de tormenta, antes de la hora del reporte.
 * - zona: la zona de caza pronosticada ese día y a cuántos km quedó.
 */
export function verificar(r, { dia, enviados = [] } = {}) {
  const h = horas(r.hora);
  const lo = h == null ? 11 : h - 3, hi = h == null ? 26 : h + 1;
  let sat = null;
  for (const s of dia?.satelite ?? []) {
    const hs = horas(s.hora);
    if (hs == null || hs < lo || hs > hi) continue;
    const d = km(r, s);
    if (d > 80) continue;
    const mejor = !sat || (s.topes_sobresalientes > 0) - (sat.topes_sobresalientes > 0) > 0 || ((s.topes_sobresalientes > 0) === (sat.topes_sobresalientes > 0) && d < sat.km);
    if (mejor) sat = { km: Math.round(d), hora: s.hora, tope_C: s.tope_C, topes_sobresalientes: s.topes_sobresalientes, cerca_de: s.cerca_de };
  }
  const tRep = h == null ? Infinity : Date.parse(r.fecha + 'T00:00:00Z') + h * 3600e3 + ART;
  let app = null;
  for (const e of enviados) {
    if (stormDate(e.t) !== r.fecha || e.t > tRep) continue;
    const d = km(r, e);
    if (!app || d < app.km) app = { km: Math.round(d), hora: new Date(e.t - ART).toISOString().slice(11, 16), titulo: e.titulo, lugar: e.lugar ?? null };
  }
  const pron = dia?.pron_manana ?? dia?.pron_dia_antes;
  const z = pron?.zonas?.[0];
  const zona = z?.centro ? { nombre: z.zona, potencial: z.potencial, km: Math.round(km(r, z.centro)), hora_pico: z.hora_pico ?? null }
    : pron?.max_grilla ? { nombre: null, potencial: pron.max_grilla.v, km: Math.round(km(r, pron.max_grilla)), hora_pico: null } : null;
  return { sat, app, zona, desde_casa_km: Math.round(km(HOME, r)), sin_datos: !dia };
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fechaTxt = (d) => { const x = new Date(d + 'T12:00:00Z'); return `${DIAS[x.getUTCDay()]} ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Resumen corto del cruce (una línea por fuente), para Telegram. */
export function lineasVerif(r, v) {
  const out = [];
  if (v.sin_datos) out.push('🛰️ No tengo guardado el satélite de ese día (el historial empezó después o ese día no se guardó).');
  else if (v.sat) {
    const ot = v.sat.topes_sobresalientes;
    out.push(`🛰️ Satélite: tormenta ${ot ? `con <b>${ot} topes que sobresalen</b>` : `muy fría (${v.sat.tope_C} °C)`} a ${v.sat.km} km, a las ${v.sat.hora} h${ot ? ` (${v.sat.tope_C} °C)` : ''}. ${ot ? '✅ Encaja: es la señal que más mira la app.' : 'Encaja a medias: fuerte, pero sin topes que sobresalgan.'}`);
  } else out.push('🛰️ Satélite: no guardé tormentas muy fuertes a menos de 80 km a esa hora. Puede ser una tormenta más chica, o la hora o el lugar no son exactos.');
  if (v.app) {
    const ok = v.app.km <= 30 ? '✅ te mandó a la zona correcta' : v.app.km <= 80 ? '🟡 te mandó cerca' : '❌ te mandó a otro lado';
    out.push(`🎯 La app: ${ok}: "${esc(v.app.lugar ?? v.app.titulo)}" a <b>${v.app.km} km</b> (aviso de las ${v.app.hora} h).`);
  } else if (v.desde_casa_km > 250) out.push(`🎯 La app no te mandó ahí: queda a ${v.desde_casa_km} km de Leones, muy lejos para llegar antes de que se forme. Está bien que no avise.`);
  else out.push(`🎯 La app no te mandó a ningún punto ese día (queda a ${v.desde_casa_km} km de Leones). Esto es lo que más sirve para aprender: ¿por qué no avisó?`);
  if (v.zona) out.push(`📈 Pronóstico: ${v.zona.nombre ? `la zona de caza era <b>${esc(v.zona.nombre)}</b> (${v.zona.potencial})` : `sin zona de caza (máx. ${v.zona.potencial})`}, a ${v.zona.km} km del reporte. ${v.zona.km <= 150 ? '✅ Acertó la región.' : '❌ Apuntó a otra región.'}`);
  return out;
}

export function textoReporte(r) {
  const lugar = `${esc(r.lugar ?? `${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}`)}${r.aprox_lugar ? ' (aprox.)' : ''}`;
  const hora = r.hora ? ` · ${r.aprox_hora ? '~' : ''}${r.hora} h` : '';
  return `${r.tipo} en <b>${lugar}</b> · ${fechaTxt(r.fecha)}${hora}${r.fuente ? ` · ${esc(r.fuente)}` : ''}`;
}

export const AYUDA_REPORTE = [
  '📋 <b>Cómo mandar un reporte</b>',
  'Escribí /reporte y qué pasó, dónde y cuándo, como lo dirías:',
  '• <code>/reporte tornado en El Trébol ayer 19 h, lo vi en Instagram</code>',
  '• <code>/reporte granizo en Leones hoy a la tarde</code>',
  '• <code>/reporte embudo -32.20, -61.70 13/11 18:30</code>',
  'Lo cruzo con el satélite y con lo que te avisó la app, y queda guardado para que aprenda.',
  '/reportes: ver todos · /borrar 3: borrar el reporte 3',
].join('\n');

/** Para el historial: el reporte como se guarda en el día. */
export const paraHistorial = (r) => ({ id: r.id, tipo: r.tipo, lugar: r.lugar, lat: r.lat, lon: r.lon, hora: r.hora, aprox_hora: !!r.aprox_hora, aprox_lugar: !!r.aprox_lugar, fuente: r.fuente ?? null });

const RUMBOS = { norte: 0, noreste: 45, este: 90, sudeste: 135, sureste: 135, sur: 180, sudoeste: 225, suroeste: 225, oeste: 270, noroeste: 315 };
/** "el sur del departamento X" → { base: 'departamento X', deg: 180 } (para buscar X y correrse hacia ese lado). */
export function direccionDe(lugar) {
  const m = String(lugar ?? '').match(/^(?:al |el |en el )?(norte|noreste|este|sudeste|sureste|sur|sudoeste|suroeste|oeste|noroeste)\s+(?:de la |del |de )(.+)$/i);
  return m ? { base: m[2].trim(), deg: RUMBOS[m[1].toLowerCase()] } : { base: lugar, deg: null };
}
