// Genera <out>/data/forecast.json y <out>/data/smn.json. Uso: node scripts/build-data.mjs _site
import { mkdir, writeFile } from 'node:fs/promises';
import { buildDataset } from '../lib/risk.mjs';
import { fetchSmn, SMN_FEED } from '../lib/smn.mjs';

const dir = (process.argv[2] || '_site') + '/data';
await mkdir(dir, { recursive: true });

try {
  const d = await buildDataset();
  await writeFile(`${dir}/forecast.json`, JSON.stringify(d));
  console.log(`forecast.json: ${d.towns.length} localidades, ${d.grid.pts.length} celdas`);
} catch (e) {
  console.error('Pronóstico falló (el panel lo pedirá en vivo):', e.message);
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
