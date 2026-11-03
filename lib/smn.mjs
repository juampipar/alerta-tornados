// Lee los avisos oficiales del SMN en formato CAP (Common Alerting Protocol).
// Corre en GitHub Actions: el sitio del SMN no permite leerlo directo desde el navegador.

export const SMN_FEED = 'https://ssl.smn.gob.ar/CAP/AR.php';

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
const re = (n, g) => new RegExp(`<(?:[\\w-]+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${n}>`, g ? 'gi' : 'i');
const tags = (x, n) => [...x.matchAll(re(n, true))].map((m) => m[1]);
const tag = (x, n) => { const m = x.match(re(n)); return m ? decode(m[1]) : ''; };

function parsePolygon(s) {
  const pts = decode(s).split(/\s+/).map((p) => p.split(',').map(Number)).filter((p) => p.length >= 2 && p.every(Number.isFinite));
  return pts.map(([lat, lon]) => [lat, lon]);
}

export function parseCap(xml) {
  return tags(xml, 'alert').map((a) => {
    const infos = tags(a, 'info');
    const info = infos.find((i) => /es/i.test(tag(i, 'language'))) || infos[0] || '';
    const params = Object.fromEntries(tags(info, 'parameter').map((p) => [tag(p, 'valueName'), tag(p, 'value')]));
    return {
      id: tag(a, 'identifier'),
      sent: tag(a, 'sent'),
      msgType: tag(a, 'msgType'),
      event: tag(info, 'event'),
      severity: tag(info, 'severity'),
      urgency: tag(info, 'urgency'),
      certainty: tag(info, 'certainty'),
      effective: tag(info, 'effective') || tag(a, 'sent'),
      onset: tag(info, 'onset'),
      expires: tag(info, 'expires'),
      headline: tag(info, 'headline'),
      description: tag(info, 'description'),
      instruction: tag(info, 'instruction'),
      web: tag(info, 'web'),
      params,
      areas: tags(info, 'area').map((ar) => ({ desc: tag(ar, 'areaDesc'), polygons: tags(ar, 'polygon').map(parsePolygon).filter((p) => p.length > 2) })),
    };
  });
}

const REGION = /c[oó]rdoba|santa fe|buenos aires|entre r[ií]os|la pampa|san luis/i;
const inBox = ([lat, lon]) => lat <= -28 && lat >= -39.5 && lon >= -67.5 && lon <= -56;

export function inCorridor(al) {
  return al.areas.some((a) => a.polygons.some((p) => p.some(inBox)) || REGION.test(a.desc)) || REGION.test(al.headline + ' ' + al.description);
}

export function isShortTerm(al) {
  return /corto plazo|acp/i.test(`${al.event} ${al.headline}`) || /immediate/i.test(al.urgency);
}

export async function fetchSmn(fetchFn = fetch) {
  const res = await fetchFn(SMN_FEED, { headers: { 'user-agent': 'alerta-tornados (panel personal)' } });
  if (!res.ok) throw new Error('SMN HTTP ' + res.status);
  const feed = await res.text();
  let alerts = parseCap(feed);
  if (!alerts.length) {
    // Feed tipo RSS/Atom con links a cada CAP.
    const links = new Set([
      ...[...feed.matchAll(/<link[^>]*href="([^"]+)"/gi)].map((m) => m[1]),
      ...tags(feed, 'link').map(decode),
      ...tags(feed, 'guid').map(decode),
    ].filter((u) => /^https?:\/\//.test(u) && u !== SMN_FEED));
    for (const u of [...links].slice(0, 80)) {
      try {
        const r = await fetchFn(u.replace(/&amp;/g, '&'));
        if (r.ok) alerts.push(...parseCap(await r.text()));
      } catch { /* sigue con el próximo */ }
    }
  }
  const now = Date.now();
  const seen = new Set();
  return alerts
    .filter((a) => a.msgType !== 'Cancel' && (!a.expires || Date.parse(a.expires) > now))
    .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
    .filter(inCorridor)
    .map((a) => ({ ...a, shortTerm: isShortTerm(a) }));
}
