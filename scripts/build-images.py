"""Imágenes para la IA: satélite GOES (NASA GIBS) ahora y hace 1 hora, más la lluvia del modelo del SMN,
con pueblos, Leones y avisos a corto plazo del SMN dibujados encima.

Uso: python scripts/build-images.py _site
Genera <out>/data/img/*.png y <out>/data/img/meta.json. Si algo falla, sigue con lo que tenga.
"""
import io
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(sys.argv[1] if len(sys.argv) > 1 else '_site', 'data')
IMG = os.path.join(OUT, 'img')
os.makedirs(IMG, exist_ok=True)
BBOX = dict(s=-37.5, n=-30.0, w=-67.0, e=-57.0)  # mismo recorte que el panel
W, H = 1000, 750
ART = timezone(timedelta(hours=-3))
GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
LAYERS = {
    'ir': 'GOES-East_ABI_Band13_Clean_Infrared',  # nubes frías = tormentas altas (sirve de día y de noche)
    'vis': 'GOES-East_ABI_GeoColor',  # color, como una foto (de día)
}

# Pueblos para ubicarse en las imágenes.
TOWNS = [
    ('Leones', -32.66, -62.3), ('Marcos Juárez', -32.7, -62.1), ('Bell Ville', -32.63, -62.69), ('Villa María', -32.41, -63.24),
    ('Río Cuarto', -33.13, -64.35), ('Córdoba', -31.42, -64.18), ('San Francisco', -31.43, -62.08), ('Rafaela', -31.25, -61.49),
    ('Santa Fe', -31.63, -60.7), ('Rosario', -32.95, -60.64), ('Venado Tuerto', -33.75, -61.97), ('Laboulaye', -34.13, -63.39),
    ('Pergamino', -33.89, -60.57), ('Junín', -34.59, -60.95), ('General Pico', -35.66, -63.76), ('Santa Rosa', -36.62, -64.29),
    ('Gualeguaychú', -33.01, -58.52), ('San Luis', -33.3, -66.34), ('Villa Mercedes', -33.68, -65.46), ('Merlo', -32.34, -65.01),
    ('Trenque Lauquen', -35.97, -62.73), ('9 de Julio', -35.45, -60.88),
]


def get(url, timeout=40):
    req = urllib.request.Request(url, headers={'user-agent': 'alerta-tornados (panel personal de tormentas)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def xy_plain(lat, lon):
    return (lon - BBOX['w']) / (BBOX['e'] - BBOX['w']) * W, (BBOX['n'] - lat) / (BBOX['n'] - BBOX['s']) * H


FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
         '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf']


def font(size):
    for f in FONTS:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow viejo
        return ImageFont.load_default()


def txt(s):
    # La letra de reserva no trae tildes: si no hay DejaVu, se sacan.
    if any(os.path.exists(f) for f in FONTS):
        return s
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def annotate(img, xy, title, smn_polys):
    d = ImageDraw.Draw(img)
    # Grilla cada 1° con etiquetas, para ubicar posiciones.
    f = font(13)
    for lon in range(int(BBOX['w']), int(BBOX['e']) + 1):
        x, _ = xy(BBOX['n'], lon)
        d.line([(x, 0), (x, H)], fill=(255, 255, 255, 50), width=1)
        d.text((x + 2, H - 16), txt(f'{lon}°'), fill=(255, 255, 255, 160), font=f)
    for lat in range(-37, -29):
        _, y = xy(lat, BBOX['w'])
        d.line([(0, y), (W, y)], fill=(255, 255, 255, 50), width=1)
        d.text((2, y + 2), txt(f'{lat}°'), fill=(255, 255, 255, 160), font=f)
    # Avisos a corto plazo del SMN (contorno rojo).
    for poly in smn_polys:
        pts = [xy(la, lo) for la, lo in poly]
        if len(pts) > 2:
            d.line(pts + [pts[0]], fill=(255, 40, 60, 255), width=3)
    # Pueblos.
    for name, la, lo in TOWNS:
        if name == 'Leones':
            continue
        x, y = xy(la, lo)
        d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 255, 255, 230), outline=(0, 0, 0, 255))
        d.text((x + 5, y - 8), txt(name), fill=(255, 255, 255, 230), font=font(13), stroke_width=2, stroke_fill=(0, 0, 0, 255))
    # Leones (la base) al final, bien visible y con la etiqueta abajo para no pisar a Marcos Juárez.
    x, y = xy(-32.66, -62.3)
    d.regular_polygon((x, y, 8), 4, rotation=45, fill=(80, 200, 255, 255), outline=(0, 0, 0, 255))
    d.text((x - 30, y + 9), 'LEONES', fill=(80, 200, 255, 255), font=font(14), stroke_width=2, stroke_fill=(0, 0, 0, 255))
    # Título.
    d.rectangle([0, 0, W, 26], fill=(0, 0, 0, 170))
    d.text((8, 4), txt(title), fill=(255, 255, 255, 255), font=font(16))
    return img


def gibs(layer, t):
    q = urllib.parse.urlencode({
        'SERVICE': 'WMS', 'VERSION': '1.3.0', 'REQUEST': 'GetMap', 'LAYERS': layer, 'STYLES': '',
        'CRS': 'EPSG:4326', 'BBOX': f"{BBOX['s']},{BBOX['w']},{BBOX['n']},{BBOX['e']}",
        'WIDTH': W, 'HEIGHT': H, 'FORMAT': 'image/png', 'TRANSPARENT': 'TRUE',
        'TIME': t.strftime('%Y-%m-%dT%H:%M:%SZ'),
    })
    img = Image.open(io.BytesIO(get(f'{GIBS}?{q}'))).convert('RGBA')
    alpha = img.getchannel('A').getextrema()
    rgb = img.convert('L').getextrema()
    if alpha[1] == 0 or rgb[0] == rgb[1]:
        raise ValueError('imagen vacía')
    return img


def latest(layer, before):
    """La imagen más nueva disponible a partir de `before` (GIBS tarda ~20–40 min en publicar)."""
    t = before.replace(minute=before.minute - before.minute % 10, second=0, microsecond=0)
    for _ in range(9):
        try:
            return t, gibs(layer, t)
        except Exception:
            t -= timedelta(minutes=10)
    return None, None


def smn_polygons():
    try:
        d = json.load(open(os.path.join(OUT, 'smn.json')))
        return [p for a in d.get('alerts', []) if a.get('shortTerm') for ar in a.get('areas', []) for p in ar.get('polygons', [])]
    except Exception:
        return []


_at = os.environ.get('REPLAY_AT') or os.environ.get('NOWCAST_AT')
now = datetime.fromisoformat(_at).replace(tzinfo=timezone.utc) if _at else datetime.now(timezone.utc)  # REPLAY_AT: repetir un momento pasado
polys = smn_polygons()
meta = {'generado': now.isoformat(), 'bbox': BBOX, 'proyeccion': 'lat/lon (equirectangular)', 'imagenes': []}
hl = lambda t: t.astimezone(ART).strftime('%H:%M')  # noqa: E731

# Satélite infrarrojo: ahora y 1 hora antes (para ver qué crece y hacia dónde va).
t_ir, ir = latest(LAYERS['ir'], now - timedelta(minutes=30))
if ir is not None:
    bg = Image.new('RGBA', (W, H), (12, 16, 28, 255))
    annotate(Image.alpha_composite(bg, ir), xy_plain, f'Satélite infrarrojo GOES {hl(t_ir)} h (colores/blanco brillante = topes fríos = tormentas fuertes)', polys).convert('RGB').save(os.path.join(IMG, 'sat_ir_ahora.png'), optimize=True)
    meta['imagenes'].append({'archivo': 'sat_ir_ahora.png', 'que_es': 'satélite infrarrojo', 'hora': hl(t_ir)})
    t_prev, irp = latest(LAYERS['ir'], t_ir - timedelta(minutes=60))
    if irp is not None:
        annotate(Image.alpha_composite(bg, irp), xy_plain, f'Satélite infrarrojo GOES {hl(t_prev)} h (1 hora antes)', polys).convert('RGB').save(os.path.join(IMG, 'sat_ir_antes.png'), optimize=True)
        meta['imagenes'].append({'archivo': 'sat_ir_antes.png', 'que_es': 'satélite infrarrojo, 1 h antes', 'hora': hl(t_prev)})

# Satélite visible (solo de día en Argentina: 8 a 19 h).
if 8 <= now.astimezone(ART).hour <= 19:
    t_vis, vis = latest(LAYERS['vis'], now - timedelta(minutes=30))
    if vis is not None:
        bg = Image.new('RGBA', (W, H), (12, 16, 28, 255))
        annotate(Image.alpha_composite(bg, vis), xy_plain, f'Satélite visible GOES {hl(t_vis)} h (nubes como foto: torres y yunques blancos)', polys).convert('RGB').save(os.path.join(IMG, 'sat_vis_ahora.png'), optimize=True)
        meta['imagenes'].append({'archivo': 'sat_vis_ahora.png', 'que_es': 'satélite visible', 'hora': hl(t_vis)})

# Lluvia pronosticada por el modelo del SMN en las próximas horas (las imágenes de build-wrf.py usan filas en Mercator).
try:
    wm = json.load(open(os.path.join(OUT, 'wrf', 'meta.json')))
    (s, w), (n, e) = wm['bounds']
    merc = lambda la: math.log(math.tan(math.pi / 4 + math.radians(la) / 2))  # noqa: E731

    def xy_merc(lat, lon, Wd, Hd):
        return (lon - w) / (e - w) * Wd, (merc(n) - merc(lat)) / (merc(n) - merc(s)) * Hd

    local = now.astimezone(ART)
    for dh in (1, 3):
        key = (local + timedelta(hours=dh)).strftime('%Y-%m-%dT%H')
        if key not in wm['hours']:
            continue
        rain = Image.open(os.path.join(OUT, 'wrf', key + '.png')).convert('RGBA').resize((W, H))
        bg = Image.new('RGBA', (W, H), (40, 44, 56, 255))
        img = annotate(Image.alpha_composite(bg, rain), lambda la, lo: xy_merc(la, lo, W, H), f'Lluvia pronosticada por el modelo SMN para las {key[11:13]} h (lila/rojo = muy fuerte)', polys)
        name = f'lluvia_modelo_mas{dh}h.png'
        img.convert('RGB').save(os.path.join(IMG, name), optimize=True)
        meta['imagenes'].append({'archivo': name, 'que_es': f'lluvia pronosticada por el modelo SMN (+{dh} h)', 'hora': key[11:13] + ':00'})
except Exception as ex:  # sin modelo: seguimos
    print('img: sin lluvia del modelo:', ex)

json.dump(meta, open(os.path.join(IMG, 'meta.json'), 'w'), ensure_ascii=False)
print('img:', ', '.join(f"{x['archivo']} ({x['hora']})" for x in meta['imagenes']) or 'ninguna')
