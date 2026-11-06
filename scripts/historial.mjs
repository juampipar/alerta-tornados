// Actualiza el historial (qué se pronosticó y qué pasó). Uso: node scripts/historial.mjs <_site> <carpeta de la rama datos>
// Lee <_site>/data/{forecast,brief,smn,nowcast}.json y las publicaciones de la red (Supabase),
// escribe <datos>/historial.json y una copia en <_site>/data/historial.json para el panel.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { updateHistory, artDate } from '../lib/historial.mjs';
import { computeBias } from '../lib/sesgo.mjs';
import { SUPA_URL, SUPA_KEY } from '../lib/red-config.mjs';

const site = process.argv[2] || '_site', store = process.argv[3] || '.datos';
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

// Publicaciones de la red de los últimos 8 días (las visibles; la clave publishable solo ve esas).
async function publicaciones() {
  const now = Date.now(), desde = artDate(now - 8 * 864e5);
  try {
    const q = new URLSearchParams({ select: 'id,visto_en,dia_tormenta,lat,lon,que_vio,video_url,autor_nombre', dia_tormenta: `gte.${desde}`, order: 'visto_en.asc', limit: '1000' });
    const r = await fetch(`${SUPA_URL}/rest/v1/publicaciones?${q}`, { headers: { apikey: SUPA_KEY } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { desde, items: await r.json() };
  } catch (e) {
    console.error('Publicaciones: no se pudieron leer:', e.message);
    return null;
  }
}

let hist = await readJson(`${store}/historial.json`);
const exists = !!hist;
const d = `${site}/data`;
hist = updateHistory(hist, {
  nowMs: Date.now(),
  forecast: await readJson(`${d}/forecast.json`),
  brief: await readJson(`${d}/brief.json`),
  smn: await readJson(`${d}/smn.json`),
  nowcast: await readJson(`${d}/nowcast.json`),
  publicaciones: await publicaciones(),
});
hist.sesgo = computeBias(hist, artDate(Date.now()));
console.log(`corrección aprendida: ${hist.sesgo.aplicado ? `${hist.sesgo.este_km} km al este, ${hist.sesgo.norte_km} km al norte, ${hist.sesgo.horas} h` : 'todavía no'} (${hist.sesgo.dias_usados} días)`);
const out = JSON.stringify(hist);
await mkdir(store, { recursive: true });
await writeFile(`${store}/historial.json`, out);
await mkdir(d, { recursive: true });
await writeFile(`${d}/historial.json`, out);
console.log(`historial.json: ${Object.keys(hist.dias).length} días${exists ? '' : ' (nuevo)'}, ${(out.length / 1024).toFixed(0)} KB`);
