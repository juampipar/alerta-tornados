# Alerta Pasillo de Tornados

Panel para saber **dónde y cuándo** hay potencial de tormentas severas en el Pasillo de los Tornados (Córdoba, Santa Fe, Buenos Aires, Entre Ríos, La Pampa), con base en Leones.

Publicado en https://juampipar.github.io/alerta-tornados/

## Qué tiene
- **Avisos oficiales del SMN** (formato CAP) filtrados al Pasillo, con los *avisos a muy corto plazo* destacados y marcados si incluyen tu zona. También se dibujan en el mapa.
- **Mejor zona del día** con veredicto y métricas: CAPE, cizalladura 0–6 km y 0–1,5 km, punto de rocío, CIN y Lifted Index.
- **Mapa** con grilla de potencial (0,75°), localidades, radar animado (RainViewer), satélite GOES visible e infrarrojo (NASA GIBS) y avisos SMN.
- **Control de hora** para ver la evolución del día, y **Hoy / Mañana / Pasado**.
- **Ranking "Dónde ir"** con distancia y tiempo desde Leones o desde tu ubicación (GPS), curva del día y botón a Google Maps.
- Pestaña de Windy (CAPE) y link a rayos en vivo (LightningMaps no permite insertarse). Instalable en el celular (“Agregar a pantalla de inicio”).

## Cómo se actualiza
El workflow `Publicar panel` corre **cada hora** (y en cada push a `main`): `scripts/build-data.mjs` baja el pronóstico de Open-Meteo y los avisos del SMN, genera `data/forecast.json` y `data/smn.json`, y publica en GitHub Pages. Si el archivo de pronóstico falta o es viejo, el panel lo pide directo a Open-Meteo.

GitHub pausa los workflows programados tras 60 días sin actividad en el repo: si deja de actualizarse, reactivalo en Actions.

## Índice de potencial (0–100)
Energía y viento se **multiplican**: `70 · √(energía · viento)`, con energía = CAPE/2500 y viento = 70% cizalladura 0–6 km/20 m/s + 30% cizalladura 0–1,5 km/10 m/s. Sin CAPE no hay puntaje aunque sople fuerte en altura, y con poca cizalladura (tormentas de “pulso”) se castiga. Suman LI, rocío ≥18 °C y precipitación del modelo; restan aire seco y CIN fuerte. Se toma la mejor hora entre las 11 y las 22 h. Indica dónde hay ingredientes; **no predice tornados**.

## Local
```bash
node scripts/build-data.mjs .
python3 -m http.server
```

## Pendiente
- Alertas a Telegram.
- Verificar en producción la lectura del feed CAP del SMN (`https://ssl.smn.gob.ar/CAP/AR.php`): si el formato cambió, el panel muestra "sin datos" y el link a smn.gob.ar.
