"""Mapa para los avisos de Telegram: rutas y pueblos (OpenStreetMap) con las tormentas del satélite encima,
hacia dónde van (+30 y +60 min), de qué lado cae el granizo, dónde estás vos y adónde ir (o escapar).

Uso: python scripts/mapa.py pedido.json   (lo llama scripts/alert.mjs)
pedido.json: {
  "out": "ruta/salida.png", "titulo": "...", "pie": "...",
  "yo": {"lat":..,"lon":..,"label":"VOS"},
  "tormentas": [{"lat":..,"lon":..,"fuerza":"fuerte","mov_deg":90,"kmh":40,"label":"fuerte −55 °C"}],
  "destino": {"lat":..,"lon":..,"label":"IR ACÁ"},      (opcional)
  "escape": {"lat":..,"lon":..,"label":"ESCAPÁ"}       (opcional: flecha desde "yo")
}
Si no se pueden bajar los mosaicos del mapa, dibuja sobre fondo liso (el resto sale igual).
"""
import io
import json
import math
import os
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
CACHE = os.environ.get('TILE_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.tiles'))
FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf']
W, H = 900, 900
COL = {'muy fuerte': (192, 64, 232), 'fuerte': (255, 59, 92), 'moderada': (255, 190, 40)}


def fnt(size):
    for f in FONTS:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def move(p, deg, d):
    r = math.radians(deg)
    return {'lat': p['lat'] + d * math.cos(r) / 111.2, 'lon': p['lon'] + d * math.sin(r) / (111.2 * math.cos(math.radians(p['lat'])))}


def world(lat, lon, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def tile(z, x, y):
    p = os.path.join(CACHE, str(z), str(x), f'{y}.png')
    if os.path.exists(p):
        return Image.open(p).convert('RGB')
    req = urllib.request.Request(TILE.format(z=z, x=x, y=y), headers={'User-Agent': 'alerta-tornados (panel personal de tormentas, GitHub juampipar/alerta-tornados)'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(data)
    return Image.open(io.BytesIO(data)).convert('RGB')


def main():
    q = json.load(open(sys.argv[1]))
    pts = []
    if q.get('yo'):
        pts.append(q['yo'])
    for c in q.get('tormentas', []):
        pts.append(c)
        if c.get('mov_deg') is not None and c.get('kmh'):
            pts.append(move(c, c['mov_deg'], c['kmh']))  # +60 min
    for k in ('destino', 'escape'):
        if q.get(k):
            pts.append(q[k])
    lat0 = sum(p['lat'] for p in pts) / len(pts)
    lon0 = sum(p['lon'] for p in pts) / len(pts)
    # Zoom: el mayor que deja todo adentro con margen (y al menos ~60 km de ancho).
    z = 11
    while z > 6:
        xs, ys = zip(*(world(p['lat'], p['lon'], z) for p in pts))
        span = max(max(xs) - min(xs), max(ys) - min(ys))
        kmpx = 40075 * math.cos(math.radians(lat0)) / (256 * 2 ** z)
        if span + 2 * 90 <= min(W, H) and 60 / kmpx <= W:
            break
        z -= 1
    cx, cy = world(lat0, lon0, z)
    ox, oy = cx - W / 2, cy - H / 2

    def px(p):
        x, y = world(p['lat'], p['lon'], z)
        return x - ox, y - oy

    img = Image.new('RGB', (W, H), (232, 230, 224))
    try:
        for tx in range(int(ox // 256), int((ox + W) // 256) + 1):
            for ty in range(int(oy // 256), int((oy + H) // 256) + 1):
                img.paste(tile(z, tx, ty), (int(tx * 256 - ox), int(ty * 256 - oy)))
        fuente = '© OpenStreetMap'
    except Exception as e:  # sin mapa de fondo: sigue igual
        print('mapa: sin mosaicos:', e)
        fuente = ''
    img = Image.blend(img, Image.new('RGB', (W, H), (255, 255, 255)), 0.15)  # un poco más claro para que resalte lo nuestro
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    kmpx = 40075 * math.cos(math.radians(lat0)) / (256 * 2 ** z)
    f14, f16, f20 = fnt(14), fnt(16), fnt(20)

    def label(xy, txt, col, f=f16, dx=12, dy=-10):
        x, y = xy[0] + dx, xy[1] + dy
        bb = d.textbbox((x, y), txt, font=f)
        d.rounded_rectangle((bb[0] - 4, bb[1] - 3, bb[2] + 4, bb[3] + 3), 5, fill=(255, 255, 255, 225), outline=col + (255,), width=2)
        d.text((x, y), txt, font=f, fill=(20, 20, 30, 255))

    def dashed(a, b, col, w=4, on=12, off=8):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 1:
            return
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        t = 0
        while t < L:
            e = min(L, t + on)
            d.line((a[0] + ux * t, a[1] + uy * t, a[0] + ux * e, a[1] + uy * e), fill=col, width=w)
            t += on + off

    def arrow(a, b, col, w=6):
        d.line((a, b), fill=col, width=w)
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        for s in (2.6, -2.6):
            d.line((b, (b[0] + 18 * math.cos(ang + s), b[1] + 18 * math.sin(ang + s))), fill=col, width=w)

    for c in q.get('tormentas', []):
        col = COL.get(c.get('fuerza'), COL['moderada'])
        p0 = px(c)
        r = max(10, 9 / kmpx)  # ~9 km: núcleo de lluvia y granizo
        if c.get('mov_deg') is not None and c.get('kmh'):
            p30, p60 = px(move(c, c['mov_deg'], c['kmh'] / 2)), px(move(c, c['mov_deg'], c['kmh']))
            dashed(p0, p60, col + (255,))
            for pp, t in ((p30, '+30 min'), (p60, '+60 min')):
                d.ellipse((pp[0] - 6, pp[1] - 6, pp[0] + 6, pp[1] + 6), fill=col + (255,), outline=(255, 255, 255, 255), width=2)
                label(pp, t, col, f14, 10, 4)
            # Granizo (solo tormentas fuertes): a la derecha de su camino (hemisferio sur), un poco adelante.
        if c.get('mov_deg') is not None and c.get('kmh') and c.get('fuerza') != 'moderada':
            g = px(move(move(c, c['mov_deg'], c['kmh'] / 3), c['mov_deg'] + 90, 12))
            d.ellipse((g[0] - r * 0.8, g[1] - r * 0.8, g[0] + r * 0.8, g[1] + r * 0.8), fill=(150, 60, 220, 70), outline=(150, 60, 220, 200), width=2)
            label(g, 'granizo', (150, 60, 220), f14, -30, -8)
        d.ellipse((p0[0] - r, p0[1] - r, p0[0] + r, p0[1] + r), fill=col + (120,), outline=col + (255,), width=4)
        label(p0, c.get('label') or 'tormenta', col, f16, -r, -r - 30)

    if q.get('escape') and q.get('yo'):
        arrow(px(q['yo']), px(q['escape']), (20, 170, 90, 255))
        label(px(q['escape']), q['escape'].get('label') or 'ESCAPÁ', (20, 170, 90), f16, 14, -12)
    if q.get('destino'):
        p = px(q['destino'])
        if q.get('yo'):
            dashed(px(q['yo']), p, (20, 170, 90, 255), 4, 10, 6)
        s = 14
        d.polygon([(p[0] + s * math.cos(math.radians(a)) * (1 if k % 2 == 0 else 0.45), p[1] + s * math.sin(math.radians(a)) * (1 if k % 2 == 0 else 0.45))
                   for k, a in enumerate(range(-90, 270, 36))], fill=(20, 170, 90, 255), outline=(255, 255, 255, 255))
        label(p, q['destino'].get('label') or 'IR ACÁ', (20, 170, 90), f16, 16, -12)
    if q.get('yo'):
        p = px(q['yo'])
        d.ellipse((p[0] - 11, p[1] - 11, p[0] + 11, p[1] + 11), fill=(40, 120, 255, 255), outline=(255, 255, 255, 255), width=4)
        label(p, q['yo'].get('label') or 'VOS', (40, 120, 255), f16, 16, -12)

    # Escala y textos.
    km10 = 10 / kmpx
    d.rectangle((20, H - 40, 20 + km10, H - 34), fill=(30, 30, 30, 255))
    d.text((20, H - 62), '10 km', font=f14, fill=(30, 30, 30, 255))
    d.rectangle((0, 0, W, 44), fill=(14, 21, 38, 230))
    d.text((14, 11), q.get('titulo', ''), font=f20, fill=(255, 255, 255, 255))
    pie = ' · '.join(x for x in (q.get('pie'), fuente) if x)
    if pie:
        bb = d.textbbox((0, 0), pie, font=f14)
        d.rectangle((W - bb[2] - 16, H - 26, W, H), fill=(255, 255, 255, 210))
        d.text((W - bb[2] - 8, H - 22), pie, font=f14, fill=(40, 40, 40, 255))
    Image.alpha_composite(img.convert('RGBA'), ov).convert('RGB').save(q['out'], optimize=True)
    print('mapa:', q['out'])


if __name__ == '__main__':
    main()
