// Envía resumen por Telegram. Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MIN_SCORE (60), ALWAYS=1 (enviar igual), DRY_RUN=1
import { POINTS, fetchForecast, rank, level, driveHours } from '../lib/risk.mjs';

const min = +(process.env.MIN_SCORE || 60);
const locs = await fetchForecast();
const day = (off) => new Date(Date.now() - 3 * 3600e3 + off * 864e5).toISOString().slice(0, 10); // fecha ART
const lines = [];
let trigger = false;
for (const [off, name] of [[0, 'HOY'], [1, 'MAÑANA']]) {
  const top = rank(locs, POINTS, day(off)).slice(0, 5);
  if (top[0] && top[0].score >= min) trigger = true;
  lines.push(`\n${name}:`);
  for (const r of top) {
    lines.push(`${level(r.score).label.toUpperCase()} ${r.score} · ${r.name} (${r.dist} km, ~${driveHours(r.dist).toFixed(1)} h) CAPE ${r.cape} · cizalla ${r.shear} m/s · pico ${r.hour}h`);
  }
}
const text = `⛈️ Pasillo de Tornados — potencial de tormentas severas\n(Modelo de pronóstico, no confirma tornados. Confirmá con radar y SMN.)${lines.join('\n')}`;
console.log(text);
if (!trigger && !process.env.ALWAYS) { console.log('\nSin zonas sobre el umbral; no se envía.'); process.exit(0); }
if (process.env.DRY_RUN) process.exit(0);
const { TELEGRAM_BOT_TOKEN: t, TELEGRAM_CHAT_ID: c } = process.env;
if (!t || !c) { console.error('Faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID'); process.exit(1); }
const r = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: c, text }),
});
if (!r.ok) { console.error('Telegram error', r.status, await r.text()); process.exit(1); }
console.log('Enviado.');
