// Actualiza el historial (qué se pronosticó y qué pasó). Uso: node scripts/historial.mjs <_site> <carpeta de la rama datos>
// Lee <_site>/data/{forecast,brief,smn,nowcast}.json y los reportes (issues "Reporte de caza" del dueño del repo),
// escribe <datos>/historial.json y una copia en <_site>/data/historial.json para el panel.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { updateHistory, parseReport } from '../lib/historial.mjs';

const site = process.argv[2] || '_site', store = process.argv[3] || '.datos';
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

async function reports() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null; // sin acceso: se dejan los reportes que ya había
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'alerta-tornados' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const issues = await r.json();
    // Solo los del dueño del repo: cualquiera puede abrir un issue en un repo público.
    return issues
      .filter((i) => !i.pull_request && /^reporte de caza/i.test(i.title) && i.author_association === 'OWNER')
      .map(parseReport).filter(Boolean);
  } catch (e) {
    console.error('Reportes: no se pudieron leer:', e.message);
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
  reports: await reports(),
});
const out = JSON.stringify(hist);
await mkdir(store, { recursive: true });
await writeFile(`${store}/historial.json`, out);
await mkdir(d, { recursive: true });
await writeFile(`${d}/historial.json`, out);
console.log(`historial.json: ${Object.keys(hist.dias).length} días${exists ? '' : ' (nuevo)'}, ${(out.length / 1024).toFixed(0)} KB`);
