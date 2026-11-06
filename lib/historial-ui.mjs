// Sección "Historial" del panel: qué pronosticó el panel cada día, qué pasó y tus reportes.
import { verifyDay, artDate } from './historial.mjs';

const REPO = 'juampipar/alerta-tornados';
const VIO = ['Nada', 'Lluvia fuerte', 'Granizo', 'Nube estante', 'Nube pared', 'Rotación', 'Embudo', 'Tornado'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fecha = (d) => { const x = new Date(d + 'T12:00:00Z'); return `${DIAS[x.getUTCDay()]} ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };
const CAZA = 60; // mismo umbral que "Día de caza" en Telegram

// Satélite infrarrojo de ese día a las 18 h (NASA Worldview guarda el archivo histórico).
const satLink = (d) => `https://worldview.earthdata.nasa.gov/?v=-67,-38,-57,-29&t=${d}-T21:00:00Z&l=GOES-East_ABI_Band13_Clean_Infrared,Coastlines_15m`;

function verdict(v, past) {
  if (v.potencial == null) return ['', '—'];
  const hit = v.acp_cerca > 0 || v.sat_cerca > 0;
  if (!past) return ['', 'En curso'];
  if (v.potencial >= CAZA) return hit ? ['ok', '✅ Hubo tormentas severas en la zona'] : ['no', '❌ No hubo nada fuerte cerca'];
  if (v.potencial < 45 && v.acp_cerca > 0) return ['warn', '⚠️ Hubo tormentas severas que el panel no marcó'];
  return ['', '—'];
}

function dayRow(date, d, today) {
  const v = verifyDay(d);
  const pm = d.pron_manana, pa = d.pron_dia_antes;
  const z = pm?.zonas?.[0] ?? pa?.zonas?.[0];
  const pronTxt = z
    ? `<b>${esc(z.zona)}</b> · ${z.potencial} · pico ${esc(z.hora_pico)}`
    : (pm ?? pa) ? `Sin zona de caza (máx. ${(pm ?? pa).max_grilla?.v ?? '–'})` : 'Sin datos';
  const antes = pa && pm && pa.zonas?.[0] && pm.zonas?.[0] && pa.zonas[0].zona !== pm.zonas[0].zona
    ? `<small>La noche anterior: ${esc(pa.zonas[0].zona)} · ${pa.zonas[0].potencial}</small>` : '';
  const smnTxt = v.acp ? `${v.acp} aviso${v.acp > 1 ? 's' : ''} a corto plazo${v.potencial != null ? ` (${v.acp_cerca} cerca de la zona)` : ''}` : 'Sin avisos a corto plazo';
  const sat = (d.satelite ?? []).find((s) => s.topes_sobresalientes > 0);
  const satTxt = v.sat_ot ? `⚡ Topes que sobresalen${v.potencial != null ? ` (${v.sat_cerca} cerca)` : ''}${sat ? `: ${esc(sat.hora)} h, ${esc(sat.cerca_de ?? '')}` : ''}`
    : v.tope_min != null ? `Topes hasta ${v.tope_min} °C` : 'Sin tormentas fuertes';
  const rep = d.reportes?.[0];
  const repTxt = rep
    ? `<a href="${esc(rep.url)}" target="_blank" rel="noopener">${rep.salio ? 'Saliste' : 'No saliste'}${rep.vio.length ? ': ' + esc(rep.vio.join(', ')) : ''}</a>`
    : `<button class="linkbtn" data-anotar="${date}">Anotar qué viste</button>`;
  const [cls, ver] = verdict(v, date < today);
  return `<li class="hday">
    <div class="hdate"><b>${fecha(date)}</b>${ver !== '—' ? `<span class="hver ${cls}">${ver}</span>` : ''}</div>
    <div class="hgrid">
      <div><span>Pronóstico</span>${pronTxt}${antes}</div>
      <div><span>Avisos SMN</span>${smnTxt}</div>
      <div><span>Satélite</span>${satTxt} · <a href="${satLink(date)}" target="_blank" rel="noopener">ver 18 h ↗</a></div>
      <div><span>Tu reporte</span>${repTxt}</div>
    </div>
  </li>`;
}

function summary(days, today) {
  const past = days.filter(([d]) => d < today).map(([, x]) => verifyDay(x));
  const caza = past.filter((v) => v.potencial >= CAZA);
  const hit = caza.filter((v) => v.acp_cerca > 0 || v.sat_cerca > 0).length;
  const reps = days.reduce((s, [, x]) => s + (x.reportes?.length ?? 0), 0);
  return `<div class="hsum">
    <div><b>${days.length}</b><span>días guardados</span></div>
    <div><b>${caza.length}</b><span>días de caza (${CAZA}+)</span></div>
    <div><b>${caza.length ? `${hit} de ${caza.length}` : '–'}</b><span>con tormentas severas en la zona</span></div>
    <div><b>${reps}</b><span>reportes tuyos</span></div>
  </div>`;
}

function form(today) {
  return `<details class="hform" id="hform"><summary>✍️ ¿Qué viste? Anotalo</summary>
    <form>
      <label>Fecha <input type="date" name="fecha" value="${today}" max="${today}" required></label>
      <fieldset><legend>¿Saliste?</legend>
        <label><input type="radio" name="salio" value="sí" checked> Sí</label>
        <label><input type="radio" name="salio" value="no"> No (lo vi desde casa o no vi nada)</label>
      </fieldset>
      <fieldset><legend>¿Qué viste?</legend>${VIO.map((x) => `<label><input type="checkbox" name="vio" value="${x}"> ${x}</label>`).join('')}</fieldset>
      <label>¿Dónde? <input name="donde" maxlength="120" placeholder="Ej.: 20 km al norte de Rafaela, Ruta 34"></label>
      <label>Nota <textarea name="nota" maxlength="500" rows="3" placeholder="A qué hora, hacia dónde iba, si giraba, fotos…"></textarea></label>
      <button class="go" type="submit">Guardar en GitHub →</button>
      <p class="muted">Se abre GitHub con el reporte armado: tocá <b>Create</b> para guardarlo. En unos 10 minutos aparece acá.
        Necesitás estar con tu cuenta de GitHub abierta. El repositorio es público, así que el reporte se puede ver.</p>
    </form></details>`;
}

function issueUrl(f) {
  const vio = f.getAll('vio');
  const body = [
    `Fecha: ${f.get('fecha')}`, `¿Saliste?: ${f.get('salio')}`, `Qué viste: ${vio.join(', ') || 'Nada'}`,
    `Dónde: ${(f.get('donde') || '').replace(/\n/g, ' ')}`, `Nota: ${(f.get('nota') || '').replace(/\n/g, ' ')}`,
    '', '_Reporte armado por el panel. No cambies las palabras antes de los dos puntos: el historial las lee._',
  ].join('\n');
  const title = `Reporte de caza ${f.get('fecha')}${vio.length && !vio.includes('Nada') ? ': ' + vio.join(', ') : ''}`;
  return `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export async function loadHistory(el) {
  const today = artDate(Date.now());
  let hist = null;
  try { const r = await fetch('data/historial.json', { cache: 'no-store' }); if (r.ok) hist = await r.json(); } catch { /* sin historial todavía */ }
  const days = Object.entries(hist?.dias ?? {}).filter(([d]) => d <= today).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const showAll = el.dataset.all === '1';
  el.innerHTML = `<div class="card">
    <h2>📒 Historial: qué se pronosticó y qué pasó</h2>
    <p class="muted">Cada día se guarda la zona que marcó el panel, los avisos a corto plazo del SMN, las tormentas fuertes que vio el satélite y lo que anotes vos.
      Con una temporada de datos se pueden ajustar los umbrales del índice para esta zona. “Cerca” = a menos de 150 km del centro de la zona.</p>
    ${days.length ? summary(days, today) : ''}
    ${form(today)}
    ${days.length ? `<ol class="hdays">${days.slice(0, showAll ? days.length : 10).map(([d, x]) => dayRow(d, x, today)).join('')}</ol>
      ${days.length > 10 && !showAll ? `<button class="linkbtn" data-all>Ver los ${days.length} días</button>` : ''}`
      : '<p class="muted">Todavía no hay días guardados: el historial empieza a llenarse con la próxima actualización (cada 10 minutos).</p>'}
  </div>`;
  const fm = el.querySelector('#hform form');
  fm.onsubmit = (e) => { e.preventDefault(); window.open(issueUrl(new FormData(fm)), '_blank', 'noopener'); };
  el.querySelectorAll('[data-anotar]').forEach((b) => (b.onclick = () => {
    fm.fecha.value = b.dataset.anotar;
    const det = el.querySelector('#hform'); det.open = true; det.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  el.querySelector('[data-all]')?.addEventListener('click', () => { el.dataset.all = '1'; loadHistory(el); });
}
