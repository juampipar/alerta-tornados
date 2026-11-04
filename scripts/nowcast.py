"""Detector de tormentas en vivo con el satélite GOES-19 (NOAA, datos abiertos en AWS).

Lee la temperatura de los topes de las nubes (banda 13, infrarrojo, cada 10 minutos) ahora y ~30 minutos
antes, y busca núcleos de tormenta en el Pasillo: dónde están, qué tan fuertes son (topes fríos y topes
que sobresalen, "overshooting tops"), si son nuevos o crecen, y hacia dónde se mueven.

Uso: python scripts/nowcast.py _site   →   <out>/data/nowcast.json
"""
import json
import math
import os
import re
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone

import netCDF4
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

OUT = os.path.join(sys.argv[1] if len(sys.argv) > 1 else '_site', 'data')
os.makedirs(OUT, exist_ok=True)
BUCKET = 'https://noaa-goes19.s3.amazonaws.com'
BBOX = dict(s=-38.5, n=-29.0, w=-68.0, e=-56.0)  # un poco más grande que el panel, para ver lo que viene
ART = timezone(timedelta(hours=-3))
HOME = ('Leones', -32.66, -62.3)
TOWNS = [
    ('Leones', -32.66, -62.3), ('Marcos Juárez', -32.7, -62.1), ('Bell Ville', -32.63, -62.69), ('Villa María', -32.41, -63.24),
    ('Río Cuarto', -33.13, -64.35), ('Córdoba', -31.42, -64.18), ('San Francisco', -31.43, -62.08), ('Rafaela', -31.25, -61.49),
    ('Santa Fe', -31.63, -60.7), ('Paraná', -31.73, -60.53), ('Rosario', -32.95, -60.64), ('Cañada de Gómez', -32.82, -61.4),
    ('Casilda', -33.04, -61.17), ('Venado Tuerto', -33.75, -61.97), ('Laboulaye', -34.13, -63.39), ('Rufino', -34.26, -62.71),
    ('Pergamino', -33.89, -60.57), ('Junín', -34.59, -60.95), ('Chivilcoy', -34.9, -60.02), ('9 de Julio', -35.45, -60.88),
    ('Bolívar', -36.23, -61.11), ('Trenque Lauquen', -35.97, -62.73), ('General Pico', -35.66, -63.76), ('Santa Rosa', -36.62, -64.29),
    ('Gualeguaychú', -33.01, -58.52), ('San Luis', -33.3, -66.34), ('Villa Mercedes', -33.68, -65.46), ('Merlo', -32.34, -65.01),
    ('Tilisarao', -32.73, -65.29), ('Justo Daract', -33.86, -65.18), ('Armstrong', -32.78, -61.6), ('Las Varillas', -31.87, -62.72),
    ('Jesús María', -30.98, -64.1), ('Villa Dolores', -31.94, -65.19), ('Arias', -33.64, -62.4), ('Corral de Bustos', -33.28, -62.18),
]
RUMBOS = ['norte', 'noreste', 'este', 'sudeste', 'sur', 'sudoeste', 'oeste', 'noroeste']


def km(a, b):
    r = math.pi / 180
    x = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def bearing(a, b):
    d = math.degrees(math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0]))
    return (d + 360) % 360


def rumbo(deg):
    return RUMBOS[round(deg / 45) % 8]


def get(url, timeout=120):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def list_frames(t):
    """Archivos de banda 13 (disco completo) de la hora UTC de `t`, con su hora de inicio."""
    prefix = f"ABI-L2-CMIPF/{t:%Y}/{t.timetuple().tm_yday:03d}/{t:%H}/OR_ABI-L2-CMIPF-M6C13"
    x = get(f'{BUCKET}/?list-type=2&prefix={prefix}', 30).decode()
    out = []
    for k in re.findall(r'<Key>([^<]+)</Key>', x):
        m = re.search(r'_s(\d{4})(\d{3})(\d{2})(\d{2})', k)
        if m:
            ts = datetime(int(m[1]), 1, 1, int(m[3]), int(m[4]), tzinfo=timezone.utc) + timedelta(days=int(m[2]) - 1)
            out.append((ts, k))
    return out


def pick_frames(now):
    frames = sorted(f for f in list_frames(now - timedelta(hours=1)) + list_frames(now) if f[0] <= now)
    if not frames:
        raise RuntimeError('sin imágenes GOES recientes')
    last = frames[-1]
    target = last[0] - timedelta(minutes=30)
    prev = min((f for f in frames if f[0] <= last[0] - timedelta(minutes=20)), key=lambda f: abs((f[0] - target).total_seconds()), default=None)
    return last, prev


_GEO = {}


def window(ds):
    """Índices del recorte del Pasillo y lat/lon de cada pixel (proyección geoestacionaria GOES-R)."""
    if 'w' in _GEO:
        return _GEO['w']
    p = ds['goes_imager_projection']
    req, rpol = p.semi_major_axis, p.semi_minor_axis
    H = p.perspective_point_height + req
    lon0 = math.radians(p.longitude_of_projection_origin)
    x = np.ma.filled(ds['x'][:], np.nan).astype('f8')
    y = np.ma.filled(ds['y'][:], np.nan).astype('f8')

    def latlon(xx, yy):
        X, Y = np.meshgrid(xx, yy)
        a = np.sin(X) ** 2 + np.cos(X) ** 2 * (np.cos(Y) ** 2 + (req ** 2 / rpol ** 2) * np.sin(Y) ** 2)
        b = -2 * H * np.cos(X) * np.cos(Y)
        c = H ** 2 - req ** 2
        disc = b ** 2 - 4 * a * c
        with np.errstate(invalid='ignore'):
            rs = (-b - np.sqrt(disc)) / (2 * a)
            sx, sy, sz = rs * np.cos(X) * np.cos(Y), -rs * np.sin(X), rs * np.cos(X) * np.sin(Y)
            lat = np.degrees(np.arctan((req ** 2 / rpol ** 2) * sz / np.sqrt((H - sx) ** 2 + sy ** 2)))
            lon = np.degrees(lon0 - np.arctan(sy / (H - sx)))
        return lat, lon

    step = 20
    la, lo = latlon(x[::step], y[::step])
    inside = (la >= BBOX['s']) & (la <= BBOX['n']) & (lo >= BBOX['w']) & (lo <= BBOX['e'])
    iy, ix = np.where(inside)
    y0, y1 = max(0, iy.min() * step - step), min(len(y), iy.max() * step + 2 * step)
    x0, x1 = max(0, ix.min() * step - step), min(len(x), ix.max() * step + 2 * step)
    lat, lon = latlon(x[x0:x1], y[y0:y1])
    _GEO['w'] = (slice(y0, y1), slice(x0, x1), lat, lon)
    return _GEO['w']


def cells_of(key):
    """Núcleos de tormenta: los puntos más fríos (corrientes ascendentes), separados al menos ~40 km.
    Así una mancha enorme de yunques unidos no se cuenta como una sola tormenta."""
    with tempfile.NamedTemporaryFile(suffix='.nc') as tmp:
        tmp.write(get(f'{BUCKET}/{key}'))
        tmp.flush()
        ds = netCDF4.Dataset(tmp.name)
        sy, sx, lat, lon = window(ds)
        bt = np.ma.filled(ds['CMI'][sy, sx].astype('f4'), np.nan)
        ds.close()
    ok = np.isfinite(bt) & (lat >= BBOX['s']) & (lat <= BBOX['n']) & (lon >= BBOX['w']) & (lon <= BBOX['e'])
    btf = np.where(np.isfinite(bt), bt, 300).astype('f4')
    dy = np.abs(np.gradient(lat, axis=0)) * 111.2
    dx = np.abs(np.gradient(lon, axis=1)) * 111.2 * np.cos(np.radians(lat))
    area = np.nan_to_num(dx * dy, nan=0)
    px = float(np.sqrt(np.nanmedian(area)))  # km por pixel (~2,5–3 en el Pasillo)
    # Topes que sobresalen: pixel muy frío y bastante más frío que su entorno (~10 km).
    local_mean = ndimage.uniform_filter(btf, size=9)
    ot = ok & (btf < 215) & (btf <= ndimage.minimum_filter(btf, size=3)) & (local_mean - btf >= 6)
    # Mínimos locales de la temperatura suavizada = núcleos.
    sm = ndimage.gaussian_filter(btf, 2)
    win = max(5, int(round(30 / px)) | 1)
    mins = ok & (sm < 230) & (sm == ndimage.minimum_filter(sm, size=win))
    iy, ix = np.where(mins)
    order = np.argsort(sm[iy, ix])
    cores = []
    r = int(round(30 / px))
    for k in order:
        y, x = iy[k], ix[k]
        p = (float(lat[y, x]), float(lon[y, x]))
        if any(km(p, (c['lat'], c['lon'])) < 40 for c in cores):
            continue
        ys, xs = slice(max(0, y - r), y + r + 1), slice(max(0, x - r), x + r + 1)
        la, lo = lat[ys, xs], lon[ys, xs]
        dist = np.hypot((la - p[0]) * 111.2, (lo - p[1]) * 111.2 * math.cos(math.radians(p[0])))
        near = (dist <= 30) & ok[ys, xs]
        b = btf[ys, xs]
        cold = near & (b < 235)
        if area[ys, xs][cold].sum() < 150:  # nube chica: no cuenta
            continue
        cores.append({
            'lat': p[0], 'lon': p[1], 'tope_min_K': float(b[near].min()),
            'area_km2': round(float(area[ys, xs][cold].sum())),
            'km2_bajo_-52C': round(float(area[ys, xs][near & (b < 221)].sum())),
            'km2_bajo_-63C': round(float(area[ys, xs][near & (b < 210)].sum())),
            'topes_sobresalientes': int(ot[ys, xs][near & (dist <= 25)].sum()),
            'iy': int(y), 'ix': int(x),
        })
        if len(cores) >= 40:
            break
    return cores, (btf, lat, lon, px)


def move(p, deg, d):
    r = math.radians(deg)
    return (p[0] + d * math.cos(r) / 111.2, p[1] + d * math.sin(r) / (111.2 * math.cos(math.radians(p[0]))))


def steering_fn(t):
    """Movimiento de las tormentas según el pronóstico (Bunkers) en el pueblo más cercano, a la hora `t`."""
    try:
        f = json.load(open(os.path.join(OUT, 'forecast.json')))
        key = t.astimezone(ART).strftime('%Y-%m-%dT%H:00')
        i = f['times'].index(key) if key in f['times'] else None
        towns = [x for x in f['towns'] if x.get('mdir') and i is not None and x['mdir'][i] is not None and x['mspd'][i]]
    except Exception:
        towns = []

    def fn(p):
        if not towns:
            return None
        t0 = min(towns, key=lambda x: km(p, (x['lat'], x['lon'])))
        return float(t0['mdir'][i]), float(t0['mspd'][i])
    return fn


def blend(own, steer):
    """Dirección y velocidad finales: la del satélite si coincide con el pronóstico; si no, la del pronóstico."""
    if own and steer:
        diff = abs((own[0] - steer[0] + 540) % 360 - 180)
        if diff <= 60 and 0.4 * steer[1] <= own[1] <= 2 * steer[1] + 20:
            ang = math.degrees(math.atan2(0.6 * math.sin(math.radians(own[0])) + 0.4 * math.sin(math.radians(steer[0])),
                                          0.6 * math.cos(math.radians(own[0])) + 0.4 * math.cos(math.radians(steer[0]))))
            return (ang + 360) % 360, 0.6 * own[1] + 0.4 * steer[1], 'satélite + pronóstico'
        return steer[0], steer[1], 'pronóstico'
    if steer:
        return steer[0], steer[1], 'pronóstico'
    if own:
        return own[0], own[1], 'satélite'
    return None, None, None


FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'


def fnt(size):
    try:
        return ImageFont.truetype(FONT, size)
    except Exception:
        return ImageFont.load_default()


def enhanced_ir(c):
    """Colores tipo 'infrarrojo realzado' (como usan los meteorólogos): resalta los topes más fríos."""
    rgb = np.zeros(c.shape + (3,), np.uint8)
    g = np.clip((30 - c) / 60 * 200 + 30, 30, 230).astype(np.uint8)  # cálido: gris
    rgb[..., 0] = rgb[..., 1] = rgb[..., 2] = g
    for lo, hi, col in [(-40, -30, (0, 190, 220)), (-52, -40, (30, 90, 230)), (-58, -52, (40, 200, 70)),
                        (-63, -58, (250, 230, 40)), (-70, -63, (255, 120, 20)), (-75, -70, (230, 20, 40)),
                        (-80, -75, (220, 40, 220)), (-200, -80, (255, 255, 255))]:
        rgb[(c < hi) & (c >= lo)] = col
    return rgb


def make_zooms(cells, grid, t1, max_n=4):
    """Recorte de ~300 km alrededor de las tormentas más fuertes, ampliado, para que la IA (y vos) vean la forma."""
    btf, lat, lon, px = grid
    img_dir = os.path.join(OUT, 'img')
    os.makedirs(img_dir, exist_ok=True)
    for f in os.listdir(img_dir):
        if f.startswith('nucleo_'):
            os.remove(os.path.join(img_dir, f))
    strong = [c for c in cells if c['fuerza'] != 'moderada' or c['topes_sobresalientes']]
    # Las más frías, más la fuerte más cercana a Leones.
    pick = strong[:max_n - 1]
    near = min((c for c in strong if c not in pick), key=lambda c: c['km_de_leones'], default=None)
    if near:
        pick.append(near)
    out = []
    r = int(round(150 / px))
    for k, c in enumerate(pick, start=1):
        iy, ix = c['_iy'], c['_ix']
        y0, x0 = max(0, iy - r), max(0, ix - r)
        sub = btf[y0:iy + r + 1, x0:ix + r + 1] - 273.15
        z = 4
        im = Image.fromarray(enhanced_ir(sub)).resize((sub.shape[1] * z, sub.shape[0] * z), Image.NEAREST)
        d = ImageDraw.Draw(im)
        cx, cy = (ix - x0) * z + z // 2, (iy - y0) * z + z // 2
        d.line([(cx - 14, cy), (cx - 5, cy)], fill=(0, 0, 0), width=3)
        d.line([(cx + 5, cy), (cx + 14, cy)], fill=(0, 0, 0), width=3)
        d.line([(cx, cy - 14), (cx, cy - 5)], fill=(0, 0, 0), width=3)
        d.line([(cx, cy + 5), (cx, cy + 14)], fill=(0, 0, 0), width=3)
        # Pueblos dentro del recorte.
        la, lo = lat[y0:iy + r + 1, x0:ix + r + 1], lon[y0:iy + r + 1, x0:ix + r + 1]
        for name, tla, tlo in TOWNS:
            dd = (la - tla) ** 2 + ((lo - tlo) * math.cos(math.radians(tla))) ** 2
            j = np.unravel_index(np.nanargmin(dd), dd.shape)
            if dd[j] < (px / 111.2) ** 2 * 2:
                X, Y = j[1] * z, j[0] * z
                col = (80, 200, 255) if name == 'Leones' else (255, 255, 255)
                d.ellipse([X - 4, Y - 4, X + 4, Y + 4], fill=col, outline=(0, 0, 0))
                d.text((X + 6, Y - 9), name, fill=col, font=fnt(15), stroke_width=2, stroke_fill=(0, 0, 0))
        # Escala de 25 km y título.
        bar = 25 / px * z
        d.rectangle([10, im.height - 26, 10 + bar, im.height - 20], fill=(255, 255, 255), outline=(0, 0, 0))
        d.text((14 + bar, im.height - 32), '25 km', fill=(255, 255, 255), font=fnt(13), stroke_width=2, stroke_fill=(0, 0, 0))
        title = f"Tormenta {k}: {c['cerca_de']} · tope {c['tope_min_C']} °C · {c['tendencia']}" + (f" · {c['topes_sobresalientes']} topes que sobresalen" if c['topes_sobresalientes'] else '')
        d.rectangle([0, 0, im.width, 24], fill=(0, 0, 0))
        d.text((6, 4), title, fill=(255, 255, 255), font=fnt(14))
        d.text((6, 26), f"GOES-19 IR realzado {t1.astimezone(ART):%H:%M} h · blanco/magenta = < −75 °C, rojo < −70, naranja < −63", fill=(255, 255, 255), font=fnt(12), stroke_width=2, stroke_fill=(0, 0, 0))
        name = f'nucleo_{k}.png'
        im.save(os.path.join(img_dir, name), optimize=True)
        c['imagen'] = f'img/{name}'
        out.append({'archivo': name, 'que_es': f"zoom satélite alta resolución, tormenta {k} ({c['cerca_de']})", 'hora': t1.astimezone(ART).strftime('%H:%M')})
    return out


def main():
    # NOWCAST_AT=2026-11-03T21:40 permite revisar un momento pasado (pruebas).
    at = os.environ.get('NOWCAST_AT')
    now = datetime.fromisoformat(at).replace(tzinfo=timezone.utc) if at else datetime.now(timezone.utc)
    (t1, k1), prev = pick_frames(now)
    c1, grid = cells_of(k1)
    c0 = cells_of(prev[1])[0] if prev else []
    dt_h = (t1 - prev[0]).total_seconds() / 3600 if prev else None
    steer = steering_fn(t1)
    t_valid = t1 + timedelta(minutes=5)  # la imagen se escanea en ~10 min: tomamos la mitad
    cells = []
    for c in c1:
        p = (c['lat'], c['lon'])
        # Emparejar con el núcleo más cercano de la imagen anterior (≤ 60 km en ~30 min).
        m = min(c0, key=lambda o: km(p, (o['lat'], o['lon'])), default=None)
        d = km(p, (m['lat'], m['lon'])) if m else 1e9
        if m and d > 60:
            m = None
        tmin = c['tope_min_K'] - 273.15
        fuerza = 'muy fuerte' if tmin < -63 else 'fuerte' if tmin < -52 else 'moderada'
        town = min(TOWNS, key=lambda t: km(p, (t[1], t[2])))
        dt = km(p, (town[1], town[2]))
        if dt > 150:  # fuera del Pasillo (Uruguay, Brasil, mar, norte lejano)
            continue
        if m:
            ratio = c['area_km2'] / max(m['area_km2'], 1)
            dT = c['tope_min_K'] - m['tope_min_K']
            tend = 'creciendo' if dT < -4 or (ratio > 1.4 and dT <= 0) else 'debilitándose' if dT > 4 or (ratio < 0.7 and dT >= 0) else 'estable'
            mov = bearing((m['lat'], m['lon']), p)
            spd = d / dt_h if dt_h else None
            # Si el tamaño cambió mucho (se juntó o se partió) o la velocidad es irreal, el movimiento no es confiable.
            if not (0.6 <= ratio <= 1.7) or (spd and spd > 90):
                mov, spd = None, None
        else:
            tend, mov, spd = 'nueva', None, None
        mdeg, kmh, fuente = blend((mov, spd) if mov is not None and spd and spd >= 10 else None, steer(p))
        cells.append({
            'lat': round(c['lat'], 2), 'lon': round(c['lon'], 2),
            'cerca_de': town[0] if dt < 25 else f"{round(dt)} km al {rumbo(bearing((town[1], town[2]), p))} de {town[0]}",
            'km_de_leones': round(km((HOME[1], HOME[2]), p)), 'rumbo_desde_leones': rumbo(bearing((HOME[1], HOME[2]), p)),
            'area_km2': c['area_km2'], 'tope_min_C': round(tmin), 'fuerza': fuerza,
            'km2_bajo_-52C': c['km2_bajo_-52C'], 'km2_bajo_-63C': c['km2_bajo_-63C'],
            'topes_sobresalientes': c['topes_sobresalientes'], 'tendencia': tend,
            'va_hacia': rumbo(mdeg) if mdeg is not None else None,
            'kmh': round(kmh) if kmh else None,
            'mov_deg': round(mdeg) if mdeg is not None else None, 'mov_fuente': fuente,
            'cambio_tope_C': round(c['tope_min_K'] - m['tope_min_K'], 1) if m else None,  # negativo = se enfría = se intensifica
            '_iy': c['iy'], '_ix': c['ix'],
        })
    cells.sort(key=lambda c: (c['tope_min_C'], -c['area_km2']))
    zooms = make_zooms(cells, grid, t1)
    res = {
        'satelite': 'GOES-19 banda 13 (infrarrojo 10,3 µm)', 'hora': t1.astimezone(ART).strftime('%H:%M'),
        'hora_anterior': prev[0].astimezone(ART).strftime('%H:%M') if prev else None,
        'hora_utc': t_valid.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'como_leer': 'Núcleos = puntos más fríos de cada tormenta (corriente ascendente), con datos en 30 km alrededor; '
                     'area_km2 = nube < −38 °C en ese radio. Más frío = más fuerte (< −52 °C fuerte, < −63 °C muy fuerte). '
                     '"topes_sobresalientes" > 0 = la corriente ascendente perfora el yunque: señal típica de supercelda. '
                     '"nueva" = no estaba en la imagen anterior; "creciendo" = se agrandó o se enfrió. "cambio_tope_C" negativo = se intensifica. '
                     'El movimiento (va_hacia/kmh/mov_deg) combina el del satélite con el del pronóstico; '
                     'con él se estima la posición actual (lat/lon son de la hora del satélite).',
        'celulas': [{k: v for k, v in c.items() if not k.startswith('_')} for c in cells[:25]],
    }
    json.dump(res, open(os.path.join(OUT, 'nowcast.json'), 'w'), ensure_ascii=False)
    # Sumar los zooms a la lista de imágenes para la IA.
    try:
        mp = os.path.join(OUT, 'img', 'meta.json')
        meta = json.load(open(mp)) if os.path.exists(mp) else {'imagenes': []}
        meta['imagenes'] = [x for x in meta['imagenes'] if not x['archivo'].startswith('nucleo_')] + zooms
        json.dump(meta, open(mp, 'w'), ensure_ascii=False)
    except Exception as e:
        print('nowcast: no pude anotar los zooms:', e)
    print(f"nowcast: {len(cells)} núcleos ({res['hora_anterior']} → {res['hora']})")
    for c in cells[:6]:
        print(f"  {c['fuerza']:10} {c['tope_min_C']:4}°C {c['area_km2']:6} km² OT={c['topes_sobresalientes']} {c['tendencia']:13} {c['va_hacia'] or '-':9} {c['kmh'] or '-':>4} km/h · {c['cerca_de']} · {c['km_de_leones']} km de Leones")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # sin satélite: el resto sigue
        print('nowcast: falló:', e)
