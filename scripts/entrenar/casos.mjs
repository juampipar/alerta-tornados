// Paso 1: arma los casos de entrenamiento (con y sin tornado) desde la base pública del SPC.
// Uso: node scripts/entrenar/casos.mjs <carpeta de la rama datos>   →   <datos>/entrenamiento/casos.json
// Si ya existe, no hace nada (RECREAR=1 para rehacerlo).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseSpc, dedupe, negatives } from '../../lib/entrenar.mjs';

const store = (process.argv[2] || '.datos') + '/entrenamiento';
const out = `${store}/casos.json`;
const existe = await readFile(out, 'utf8').then(() => true, () => false);
if (existe && !process.env.RECREAR) { console.log('casos.json ya existe'); process.exit(0); }

// El SPC publica el archivo con el último año completo en el nombre: probar del más nuevo al más viejo.
let csv = null, fuente = null;
for (const y of [2025, 2024, 2023]) {
  const url = `https://www.spc.noaa.gov/wcm/data/1950-${y}_actual_tornadoes.csv`;
  try { const r = await fetch(url); if (r.ok) { csv = await r.text(); fuente = url; break; } } catch { /* probar el siguiente */ }
}
if (!csv) throw new Error('No pude bajar la base de tornados del SPC');

// El archivo de pronósticos de Open-Meteo empieza en 2022: casos desde ese año.
const todos = parseSpc(csv, { desde: 2022, minEF: 0 });
const pos = dedupe(parseSpc(csv, { desde: 2022, minEF: 1 }));
const neg = negatives(pos, todos, pos.length * 2);
const casos = [...pos.map((p) => ({ ...p, y: 1 })), ...neg.map((p) => ({ ...p, y: 0 }))]
  .map((c, i) => ({ id: i, t: new Date(c.t).toISOString(), lat: +c.lat.toFixed(3), lon: +c.lon.toFixed(3), ef: c.ef, y: c.y }));
await mkdir(store, { recursive: true });
await writeFile(out, JSON.stringify({ fuente, generado: new Date().toISOString(), tornados_total: todos.length, casos }));
console.log(`casos.json: ${pos.length} con tornado (EF1+, un caso por brote) y ${neg.length} sin tornado, de ${fuente}`);
