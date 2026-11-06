// Paso 2: baja el ambiente de cada caso del archivo de pronósticos de Open-Meteo (las mismas variables que usa
// el panel), espeja los vientos al hemisferio sur y calcula los ingredientes con metrics() y el índice actual.
// Avanza de a tandas y retoma donde quedó (cuida la cuota gratuita).
// Uso: node scripts/entrenar/ambientes.mjs <carpeta datos> [máximo de casos por corrida]
import { readFile, writeFile } from 'node:fs/promises';
import { HOURLY, metrics, scoreOf } from '../../lib/risk.mjs';
import { mirrorHourly } from '../../lib/entrenar.mjs';

const store = (process.argv[2] || '.datos') + '/entrenamiento';
const MAX = +(process.argv[3] || 2000);
const TANDA = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { casos } = JSON.parse(await readFile(`${store}/casos.json`, 'utf8'));
const amb = JSON.parse(await readFile(`${store}/ambientes.json`, 'utf8').catch(() => '{}'));
const hechos = new Set(Object.keys(amb).map(Number));
const pend = casos.filter((c) => !hechos.has(c.id)).slice(0, MAX);

// Agrupar en ventanas de hasta 14 días y 20 lugares: Open-Meteo cobra igual 1 día que 14, así que un pedido
// trae varios casos (los tornados caen casi todos en días distintos; de a uno serían miles de pedidos).
const orden = [...pend].sort((a, b) => (a.t < b.t ? -1 : 1));
const grupos = [];
for (const c of orden) {
  const g = grupos[grupos.length - 1];
  if (g && g.length < TANDA && Date.parse(c.t) - Date.parse(g[0].t) < 13 * 864e5) g.push(c);
  else grupos.push([c]);
}

const r2 = (x) => (x == null ? null : Math.round(x * 10) / 10);
let ok = 0, sin = 0, corte = null, pedidos = 0;
for (const grupo of grupos) {
  if (corte) break;
  const q = new URLSearchParams({
    latitude: grupo.map((c) => c.lat).join(','), longitude: grupo.map((c) => c.lon).join(','),
    hourly: HOURLY.join(','), wind_speed_unit: 'ms', timezone: 'GMT',
    start_date: grupo[0].t.slice(0, 10), end_date: grupo[grupo.length - 1].t.slice(0, 10),
  });
  let j = null;
  for (let intento = 1; intento <= 3 && !j; intento++) {
    try {
      pedidos++;
      const r = await fetch('https://historical-forecast-api.open-meteo.com/v1/forecast?' + q);
      if (r.ok) j = await r.json();
      else {
        const txt = (await r.text()).slice(0, 160);
        if (/daily|hourly/i.test(txt)) { corte = `límite de Open-Meteo (${txt.slice(0, 80)})`; break; }
        if (r.status !== 429 && r.status < 500) { console.error(`${grupo[0].t.slice(0, 10)}: HTTP ${r.status} ${txt}`); break; }
        await sleep(65e3);
      }
    } catch (e) { await sleep(30e3); if (intento === 3) console.error(`${grupo[0].t.slice(0, 10)}: ${e.message}`); }
  }
  if (!j) continue;
  const locs = Array.isArray(j) ? j : [j];
  grupo.forEach((c, k) => {
    const loc = locs[k];
    const i = loc?.hourly?.time?.indexOf(c.t.slice(0, 13) + ':00');
    if (!loc?.hourly || i == null || i < 0) { sin++; return; }
    const m = metrics(mirrorHourly(loc.hourly), i, loc.elevation ?? 0);
    if (m.shear == null || loc.hourly.cape?.[i] == null) { amb[c.id] = null; sin++; return; } // sin datos: no sirve
    amb[c.id] = { cape: m.cape, cin: m.cin, li: m.li, td: m.td, lcl: m.lcl, shear: r2(m.shear), ll: r2(m.ll), srh: m.srh, indice: scoreOf(m) };
    ok++;
  });
  // Límites gratuitos: 5000 "llamadas" por hora y 10000 por día; cada lugar con ~25 variables cuenta como ~2,5,
  // o sea ~50 por pedido de 20 lugares. Un pedido cada 40 s ≈ 4500 por hora; 2000 casos por noche ≈ 5000 por día.
  await sleep(40e3);
}
await writeFile(`${store}/ambientes.json`, JSON.stringify(amb));
const total = Object.keys(amb).length;
console.log(`ambientes: +${ok} casos (${sin} sin datos) en ${pedidos} pedidos · llevamos ${total} de ${casos.length}${corte ? ` · cortado por ${corte}, sigue mañana` : ''}`);
