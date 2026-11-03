// Dibujos SVG para la guía: tormenta vista desde arriba y formas típicas en el radar.
// Modelo clásico de supercélula del hemisferio sur (espejo del de EE.UU.): la que da tornados se desvía
// a la izquierda, la rotación (nube pared) queda atrás a la izquierda y la lluvia/granizo adelante a la derecha.
import { rumbo } from './risk.mjs';

const f = (n) => Math.round(n * 10) / 10;

/**
 * Tormenta vista desde arriba, girada según su movimiento.
 * @param {number} mdir hacia dónde va la tormenta (0 = norte, 90 = este)
 */
export function stormDiagram(mdir = 90) {
  const a = (mdir * Math.PI) / 180;
  // Coordenadas locales (como el SVG): x = derecha de la trayectoria, y negativo = hacia adelante.
  // Se rotan igual que transform="rotate(mdir)" (arriba = norte); los textos se ubican rotados pero quedan derechos.
  const P = (x, y) => [f(x * Math.cos(a) - y * Math.sin(a)), f(x * Math.sin(a) + y * Math.cos(a))];
  const rot = `rotate(${mdir})`;
  // Texto anclado a un punto local (x, y) y corrido dy píxeles en pantalla (siempre hacia abajo/arriba, sin girar).
  const label = (x, y, txt, cls = '', dy = 0) => { const [X, Y] = P(x, y); return `<text x="${X}" y="${f(Y + dy)}" class="${cls}" text-anchor="middle">${txt}</text>`; };
  // Etiqueta de la rotación: hacia afuera de la tormenta, para no pisar el granizo.
  const rotLabel = () => {
    const [cx, cy] = P(-32, 45), [sx, sy] = P(5, -5);
    const d = Math.hypot(cx - sx, cy - sy) || 1, X = f(cx + ((cx - sx) / d) * 62), Y = f(cy + ((cy - sy) / d) * 62);
    return `<text x="${X}" y="${Y}" class="d-rot-t" text-anchor="middle">rotación</text><text x="${X}" y="${f(Y + 16)}" class="d-small" text-anchor="middle">(nube pared)</text>`;
  };
  const to = rumbo(mdir), side = rumbo(mdir - 90), hail = rumbo(mdir + 90);
    return `<svg class="diagram" viewBox="-250 -250 500 500" role="img" aria-label="Tormenta vista desde arriba: va hacia el ${to}; la lluvia y el granizo caen del lado ${hail}; ubicate del lado ${side}, adelante y al costado, a unos 20 km.">
  <defs>
    ${[['arw', '#c9d3e8'], ['arw-ok', '#3ddc97'], ['arw-red', '#ff3b5c'], ['arw-mut', '#8d9bb8']].map(([id, c]) => `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('')}
    <pattern id="nogo" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" class="d-nogo-bg"/><line x1="0" y1="0" x2="0" y2="10" class="d-nogo-line"/></pattern>
  </defs>
  <g transform="${rot}">
    <rect x="-28" y="-235" width="56" height="140" rx="8" fill="url(#nogo)" class="d-nogo"/>
    <ellipse cx="5" cy="-5" rx="72" ry="88" class="d-rain"/>
    <ellipse cx="28" cy="-25" rx="34" ry="42" class="d-hail"/>
    <circle cx="-32" cy="45" r="22" class="d-rot"/>
    <path d="M -32 15 A 30 30 0 1 1 -62 45" class="d-spin" marker-end="url(#arw-red)"/>
    <line x1="0" y1="-95" x2="0" y2="-150" class="d-move" marker-end="url(#arw)"/>
    <line x1="-125" y1="-70" x2="-205" y2="-70" class="d-escape" marker-end="url(#arw-ok)"/>
    <line x1="-38" y1="20" x2="-112" y2="-58" class="d-dist"/>
  </g>
  <circle cx="${P(-125, -70)[0]}" cy="${P(-125, -70)[1]}" r="10" class="d-you"/>
  ${label(-125, -70, 'VOS', 'd-you-t', -18)}
  ${label(-205, -70, 'escape', 'd-small', 22)}
  ${label(-75, -19, '~20 km', 'd-small', -8)}
  ${label(62, -128, `va hacia el ${to}`, 'd-move-t')}
  ${label(0, -200, 'NUNCA acá', 'd-nogo-t')}
  ${label(30, -25, 'granizo', 'd-hail-t')}
  ${label(60, 75, 'lluvia', 'd-small')}
  ${rotLabel()}
  <g class="d-north" transform="translate(215,-215)"><line x1="0" y1="14" x2="0" y2="-12" marker-end="url(#arw-mut)"/><text x="0" y="30" text-anchor="middle">N</text></g>
</svg>`;
}

/** Tres formas en el radar: celda aislada, línea y gancho. */
export function radarShapes() {
  const card = (title, body, txt, cls) => `<figure class="rshape ${cls}"><svg viewBox="0 0 120 100" aria-hidden="true">${body}</svg><figcaption><b>${title}</b>${txt}</figcaption></figure>`;
  const cell = `<ellipse cx="60" cy="50" rx="34" ry="28" class="r1"/><ellipse cx="66" cy="46" rx="20" ry="16" class="r2"/><ellipse cx="68" cy="44" rx="8" ry="7" class="r3"/>`;
  const line = `<path d="M18 88 Q40 50 58 40 T104 8" class="r1 thick"/><path d="M22 84 Q42 52 60 42 T100 12" class="r2 mid"/>`;
  const hook = `<path d="M30 30 Q70 8 96 34 Q106 60 82 74 Q66 82 54 76 Q40 90 26 80 Q20 70 34 66 Q44 66 46 58 Q22 52 30 30 Z" class="r1"/><ellipse cx="74" cy="42" rx="16" ry="14" class="r2"/><ellipse cx="78" cy="40" rx="6" ry="6" class="r3"/><circle cx="34" cy="74" r="9" class="hookring"/>`;
  return card('Celda aislada', cell, ' Una mancha sola que crece rápido. <b>Es la que buscás.</b>', 'good')
    + card('Línea', line, ' Muchas tormentas en fila. Dan viento y granizo, casi nunca buenos tornados.', 'meh')
    + card('Gancho', hook, ' Una “cola” que se enrosca en la parte de atrás. Indica rotación: mirá ahí con atención.', 'good');
}
