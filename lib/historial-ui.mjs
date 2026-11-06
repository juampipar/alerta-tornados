// Sección "Historial": se arma sola con lo que publica la gente en la red, más los avisos del SMN y el satélite.
// Para cada día: qué pronosticó el panel, qué se vio y con qué valor del índice en ese lugar y hora.
import { verifyDay, artDate } from './historial.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fecha = (d) => { const x = new Date(d + 'T12:00:00Z'); return `${DIAS[x.getUTCDay()]} ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };
const CAZA = 60; // mismo umbral que "Día de caza" en Telegram
const FUERTE = ['tornado', 'embudo', 'rotación'];
const fuerte = (p) => p.vio.some((x) => FUERTE.includes(x));

// Satélite infrarrojo de ese día a las 18 h (NASA Worldview guarda el archivo histórico).
const satLink = (d) => `https://worldview.earthdata.nasa.gov/?v=-67,-38,-57,-29&t=${d}-T21:00:00Z&l=GOES-East_ABI_Band13_Clean_Infrared,Coastlines_15m`;

function verdict(v, past) {
  if (v.potencial == null) return ['', ''];
  if (!past) return ['', 'En curso'];
  const hit = v.acp_cerca > 0 || v.sat_cerca > 0 || v.pubs_fuertes_cerca > 0;
  if (v.potencial >= CAZA) return hit ? ['ok', '✅ Hubo tormentas severas en la zona'] : ['no', '❌ No hubo nada fuerte cerca'];
  if (v.potencial < 45 && (v.acp_cerca > 0 || v.pubs_fuertes > 0)) return ['warn', '⚠️ Hubo tormentas severas que el panel no marcó'];
  return ['', ''];
}

function pubLine(p) {
  const ix = p.indice?.v;
  return `<li class="${fuerte(p) ? 'hot' : ''}">
    <b>${esc(p.hora)}</b> · ${esc(p.vio.join(', ') || 'sin detalle')}${p.autor ? ` · ${esc(p.autor)}` : ''}
    · índice ahí: <b>${ix ?? '–'}</b>${p.video ? ` · <a href="${esc(p.video)}" target="_blank" rel="noopener nofollow">video ↗</a>` : ''}
  </li>`;
}

function dayRow(date, d, today) {
  const v = verifyDay(d);
  const pm = d.pron_manana, pa = d.pron_dia_antes;
  const z = pm?.zonas?.[0] ?? pa?.zonas?.[0];
  const pronTxt = z
    ? `<b>${esc(z.zona)}</b> · ${z.potencial} · pico ${esc(z.hora_pico)}`
    : (pm ?? pa) ? `Sin zona de caza (máx. ${(pm ?? pa).max_grilla?.v ?? '–'})` : 'Sin datos';
  const smnTxt = v.acp ? `${v.acp} aviso${v.acp > 1 ? 's' : ''} a corto plazo${v.potencial != null ? ` (${v.acp_cerca} cerca de la zona)` : ''}` : 'Sin avisos a corto plazo';
  const sat = (d.satelite ?? []).find((s) => s.topes_sobresalientes > 0);
  const satTxt = v.sat_ot ? `⚡ Topes que sobresalen${sat ? `: ${esc(sat.hora)} h, ${esc(sat.cerca_de ?? '')}` : ''}`
    : v.tope_min != null ? `Topes hasta ${v.tope_min} °C` : 'Sin tormentas fuertes';
  const pubs = d.publicaciones ?? [];
  const [cls, ver] = verdict(v, date < today);
  return `<li class="hday">
    <div class="hdate"><b>${fecha(date)}</b>${ver ? `<span class="hver ${cls}">${ver}</span>` : ''}</div>
    <div class="hgrid">
      <div><span>Pronóstico</span>${pronTxt}</div>
      <div><span>Lo que vio la gente</span>${pubs.length ? `${pubs.length} video${pubs.length > 1 ? 's' : ''}${v.pubs_fuertes ? ` · <b>${v.pubs_fuertes} con rotación, embudo o tornado</b>` : ''}` : 'Nadie publicó'}</div>
      <div><span>Avisos SMN</span>${smnTxt}</div>
      <div><span>Satélite</span>${satTxt} · <a href="${satLink(date)}" target="_blank" rel="noopener">ver 18 h ↗</a></div>
    </div>
    ${pubs.length ? `<ul class="hpubs">${[...pubs].sort((a, b) => (a.visto < b.visto ? -1 : 1)).map(pubLine).join('')}</ul>` : ''}
  </li>`;
}

// Lo que sirve para entrenar el índice: qué valor tenía donde la gente vio rotación, embudo o tornado.
function training(days) {
  const pubs = days.flatMap(([, d]) => d.publicaciones ?? []);
  const strong = pubs.filter(fuerte), ix = strong.map((p) => p.indice?.v).filter((x) => x != null);
  const band = (lo, hi) => ix.filter((x) => x >= lo && x < hi).length;
  const avg = ix.length ? Math.round(ix.reduce((s, x) => s + x, 0) / ix.length) : null;
  return `<div class="hsum">
    <div><b>${pubs.length}</b><span>videos guardados</span></div>
    <div><b>${strong.length}</b><span>con rotación, embudo o tornado</span></div>
    <div><b>${avg ?? '–'}</b><span>índice promedio donde se vieron</span></div>
    <div><b>${ix.length ? `${band(60, 101)} · ${band(45, 60)} · ${band(0, 45)}` : '–'}</b><span>de esos: índice 60+ · 45–59 · menos de 45</span></div>
  </div>
  <p class="muted">Si muchos avistajes fuertes caen con índice bajo, el índice está subestimando; si los días con índice alto nunca tienen avistajes, está exagerando. Con una temporada de datos se ajustan los umbrales.</p>`;
}

export async function loadHistory(el) {
  const today = artDate(Date.now());
  let hist = null;
  try { const r = await fetch('data/historial.json', { cache: 'no-store' }); if (r.ok) hist = await r.json(); } catch { /* sin historial todavía */ }
  const days = Object.entries(hist?.dias ?? {}).filter(([d]) => d <= today).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const showAll = el.dataset.all === '1';
  el.innerHTML = `<div class="card">
    <h2>📒 Historial: qué se pronosticó y qué pasó</h2>
    <p class="muted">Se arma solo con los videos que publica la gente en la <a href="#red">🎥 Red</a>: como cada video tiene ubicación y hora,
      se une solo a la zona pronosticada y guarda el valor del índice en ese lugar y esa hora. Se suman los avisos a corto plazo del SMN
      y las tormentas fuertes que vio el satélite. “Cerca” = a menos de 150 km del centro de la zona.</p>
    ${days.length ? training(days) : ''}
    <p><a class="go" href="#red" data-publicar>🎥 Publicar lo que estás viendo</a></p>
    ${days.length ? `<ol class="hdays">${days.slice(0, showAll ? days.length : 10).map(([d, x]) => dayRow(d, x, today)).join('')}</ol>
      ${days.length > 10 && !showAll ? `<button class="linkbtn" data-all>Ver los ${days.length} días</button>` : ''}`
      : '<p class="muted">Todavía no hay días guardados: el historial se llena con cada actualización (cada 10 minutos).</p>'}
  </div>`;
  el.querySelector('[data-all]')?.addEventListener('click', () => { el.dataset.all = '1'; loadHistory(el); });
}
