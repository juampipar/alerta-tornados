// Genera <out>/data/forecast.json y <out>/data/smn.json. Uso: node scripts/build-data.mjs _site
// Con REUSE_FORECAST=<url del forecast.json publicado> reusa el pronóstico si tiene menos de ~2 h.
// Así el pronóstico se recalcula cada 2 horas (cuota gratuita de Open-Meteo) y las demás corridas
// solo renuevan los avisos del SMN.
import { mkdir, writeFile } from 'node:fs/promises';
import { buildDataset } from '../lib/risk.mjs';
import { fetchSmn, SMN_FEED } from '../lib/smn.mjs';
import { buildModels } from '../lib/modelos.mjs';

const dir = (process.argv[2] || '_site') + '/data';
await mkdir(dir, { recursive: true });

async function published(url, maxMin = 115) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return Date.now() - Date.parse(d.generated) < maxMin * 60e3 ? d : null;
  } catch { return null; }
}

// ONLY_SMN=1 (el vigía de cada 10 min): solo renueva los avisos del SMN; el pronóstico lo calcula el panel.
const ONLY_SMN = !!process.env.ONLY_SMN;
const reused = ONLY_SMN ? null : process.env.REUSE_FORECAST ? await published(process.env.REUSE_FORECAST) : null;
let bajado = false; // si el pronóstico principal se bajó en esta corrida, los modelos esperan un minuto (límite de Open-Meteo)
if (ONLY_SMN) {
  console.log('forecast.json y modelos.json: no se tocan (solo SMN)');
} else if (reused) {
  await writeFile(`${dir}/forecast.json`, JSON.stringify(reused));
  console.log(`forecast.json: reusado (generado ${reused.generated})`);
} else try {
  const d = await buildDataset();
  bajado = true;
  await writeFile(`${dir}/forecast.json`, JSON.stringify(d));
  console.log(`forecast.json: ${d.towns.length} localidades, ${d.grid.pts.length} celdas`);
} catch (e) {
  console.error('Pronóstico falló (el panel lo pedirá en vivo):', e.message);
}

// Varios modelos (GFS, ICON, ECMWF): cada 6 h alcanza (salen corridas nuevas 4 veces por día) y cuida la cuota.
const reusedM = ONLY_SMN ? null : process.env.REUSE_MODELS ? await published(process.env.REUSE_MODELS, 330) : null;
if (ONLY_SMN) {
  // nada
} else if (reusedM) {
  await writeFile(`${dir}/modelos.json`, JSON.stringify(reusedM));
  console.log(`modelos.json: reusado (generado ${reusedM.generated})`);
} else try {
  const m = await buildModels(fetch, { esperarAntes: bajado });
  await writeFile(`${dir}/modelos.json`, JSON.stringify(m));
  console.log(`modelos.json: ${m.pts.length} puntos · ${m.modelos.map((n) => `${n} ${m.ok[n] ? 'ok' : 'SIN DATOS'}`).join(' · ')}`);
} catch (e) {
  console.error('Modelos fallaron (se sigue sin comparar):', e.message);
}

let smn;
try {
  const alerts = await fetchSmn();
  smn = { fetched: new Date().toISOString(), ok: true, source: SMN_FEED, alerts };
  console.log(`smn.json: ${alerts.length} avisos en el Pasillo`);
} catch (e) {
  smn = { fetched: new Date().toISOString(), ok: false, source: SMN_FEED, error: e.message, alerts: [] };
  console.error('SMN falló:', e.message);
}
await writeFile(`${dir}/smn.json`, JSON.stringify(smn));
