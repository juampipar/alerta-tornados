"""Lluvia pronosticada por el modelo WRF del SMN (4 km) para el Pasillo, como imágenes tipo radar.

Uso: python scripts/build-wrf.py _site
Genera <out>/data/wrf/<YYYY-MM-DDTHH>.png (hora argentina), max_<YYYY-MM-DD>.png (máximo de 11 a 2 h)
y meta.json. Fuente: datos abiertos del SMN en AWS (s3://smn-ar-wrf), uno por hora de pronóstico.

Env:
  PUBLISHED_WRF  URL de data/wrf/ ya publicado: si es la misma corrida, se reusa sin recalcular.
  REUSE_ONLY=1   solo reusar (corridas de cada 10 minutos); si no hay nada publicado, no hace nada.
"""
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

BUCKET = 'https://smn-ar-wrf.s3.amazonaws.com'
BBOX = dict(s=-37.5, n=-30.0, w=-67.0, e=-57.0)  # mismo recorte que la grilla del panel
STEP = 0.05  # grados de longitud por pixel (~4,7 km)
ROWS = 160
ART = timezone(timedelta(hours=-3))
# Colores tipo radar por mm en la hora: (desde, RGBA)
LEVELS = [
    (0.5, (120, 200, 255, 150)),
    (2, (40, 150, 255, 180)),
    (5, (60, 210, 90, 200)),
    (10, (250, 220, 40, 215)),
    (20, (255, 140, 30, 225)),
    (35, (240, 40, 60, 235)),
    (50, (200, 60, 230, 240)),  # lila: granizo/lluvia muy intensa
]

out = os.path.join(sys.argv[1] if len(sys.argv) > 1 else '_site', 'data', 'wrf')
os.makedirs(out, exist_ok=True)


def get(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def list_keys(prefix):
    keys, token = [], None
    while True:
        q = f'{BUCKET}/?list-type=2&prefix={prefix}' + (f'&continuation-token={urllib.parse.quote(token)}' if token else '')
        x = get(q).decode()
        keys += re.findall(r'<Key>([^<]+)</Key>', x)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', x)
        if not m:
            return keys
        token = m.group(1)


now = datetime.now(timezone.utc)
first = now.astimezone(ART).replace(minute=0, second=0, microsecond=0)  # desde la hora actual
last = (first.replace(hour=0) + timedelta(days=2, hours=2))  # hasta las 2 h de pasado mañana
need = lambda t: first <= t <= last  # noqa: E731


def latest_run():
    """Corrida más nueva que ya tenga al menos 36 horas de pronóstico subidas."""
    for back in range(0, 48, 6):
        t = now - timedelta(hours=back)
        run = t.replace(hour=t.hour - t.hour % 6, minute=0, second=0, microsecond=0)
        prefix = run.strftime('DATA/WRF/DET/%Y/%m/%d/%H/WRFDETAR_01H_')
        keys = sorted(k for k in list_keys(prefix) if k.endswith('.nc'))
        if len(keys) >= 37:
            return run, keys
    return None, []


def reuse(run_id):
    base = os.environ.get('PUBLISHED_WRF')
    if not base:
        return False
    try:
        meta = json.loads(get(base + 'meta.json', 30))
    except Exception:
        return False
    if run_id and meta.get('run') != run_id:
        return False
    files = [f'{h}.png' for h in meta['hours']] + list(meta.get('max', {}).values())
    for f in files:
        with open(os.path.join(out, f), 'wb') as fh:
            fh.write(get(base + f, 30))
    with open(os.path.join(out, 'meta.json'), 'w') as fh:
        json.dump(meta, fh)
    print(f'wrf: reusado de lo publicado (corrida {meta["run"]}, {len(meta["hours"])} horas)')
    return True


if os.environ.get('REUSE_ONLY'):
    if not reuse(None):
        print('wrf: nada publicado para reusar')
    sys.exit(0)

run, keys = latest_run()
if not run:
    print('wrf: no hay corridas recientes del SMN')
    sys.exit(0)
run_id = run.strftime('%Y-%m-%dT%HZ')
if reuse(run_id):
    sys.exit(0)

import netCDF4  # noqa: E402
from PIL import Image  # noqa: E402

# Filas uniformes en Mercator para que la imagen calce con el mapa web.
merc = lambda lat: np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))  # noqa: E731
y_top, y_bot = merc(BBOX['n']), merc(BBOX['s'])
COLS = int(round((BBOX['e'] - BBOX['w']) / STEP))
pal = np.zeros((256, 4), np.uint8)
for k, (_, rgba) in enumerate(LEVELS, start=1):
    pal[k] = rgba


def classify(mm):
    idx = np.zeros(mm.shape, np.uint8)
    for k, (lo, _) in enumerate(LEVELS, start=1):
        idx[mm >= lo] = k
    return idx


def save(idx, name):
    rgba = pal[idx]
    Image.fromarray(rgba, 'RGBA').save(os.path.join(out, name), optimize=True)


cells = None
hours, daymax = [], {}
fh_re = re.compile(r'_(\d{3})\.nc$')
for key in keys:
    fh = int(fh_re.search(key).group(1))
    valid = (run + timedelta(hours=fh)).astimezone(ART)
    if not need(valid):
        continue
    with tempfile.NamedTemporaryFile(suffix='.nc') as tmp:
        tmp.write(get(f'{BUCKET}/{key}', 180))
        tmp.flush()
        ds = netCDF4.Dataset(tmp.name)
        if cells is None:
            lat, lon = ds['lat'][:], ds['lon'][:]
            m = (lat <= BBOX['n'] + 0.1) & (lat >= BBOX['s'] - 0.1) & (lon >= BBOX['w'] - 0.1) & (lon <= BBOX['e'] + 0.1)
            ys, xs = np.where(m)
            sl = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
            la, lo = lat[sl], lon[sl]
            col = np.floor((lo - BBOX['w']) / STEP).astype(int)
            row = np.floor((y_top - merc(la)) / (y_top - y_bot) * ROWS).astype(int)
            ok = (col >= 0) & (col < COLS) & (row >= 0) & (row < ROWS)
            cells = (row[ok], col[ok], ok, sl)
        r, c, ok, sl = cells
        pp = np.asarray(ds['PP'][0][sl], dtype=np.float32)[ok]
        ds.close()
    grid = np.full((ROWS, COLS), -1.0, np.float32)
    np.maximum.at(grid, (r, c), np.nan_to_num(pp))
    # Rellenar pixeles sin dato con el vecino más alto.
    if (grid < 0).any():
        pad = np.pad(grid, 1, constant_values=-1)
        nb = np.max([pad[1 + dy:ROWS + 1 + dy, 1 + dx:COLS + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)
        grid = np.where(grid < 0, nb, grid)
    grid = np.maximum(grid, 0)
    name = valid.strftime('%Y-%m-%dT%H')
    save(classify(grid), name + '.png')
    hours.append(name)
    # Máximo del día con la misma ventana que el panel: 11 h a 2 h del día siguiente.
    day = (valid - timedelta(days=1)).date() if valid.hour <= 2 else valid.date()
    if valid.hour >= 11 or valid.hour <= 2:
        d = day.isoformat()
        daymax[d] = grid if d not in daymax else np.maximum(daymax[d], grid)

maxf = {}
for d, g in daymax.items():
    maxf[d] = f'max_{d}.png'
    save(classify(g), maxf[d])

meta = {
    'run': run_id,
    'generated': now.isoformat(),
    'bounds': [[BBOX['s'], BBOX['w']], [BBOX['n'], BBOX['e']]],
    'hours': hours,
    'max': maxf,
    'levels': [lo for lo, _ in LEVELS],
}
with open(os.path.join(out, 'meta.json'), 'w') as fh:
    json.dump(meta, fh)
print(f'wrf: corrida {run_id}, {len(hours)} horas, {len(maxf)} días')
