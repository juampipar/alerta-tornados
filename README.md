# Alerta Pasillo de Tornados

Panel para saber **dónde y cuándo** hay potencial de tormentas severas en el Pasillo de los Tornados (Córdoba, Santa Fe, Buenos Aires, Entre Ríos, La Pampa), con base en Leones.

Publicado en https://juampipar.github.io/alerta-tornados/

## Qué tiene
- **Avisos oficiales del SMN** (formato CAP) filtrados al Pasillo, con los *avisos a muy corto plazo* destacados y marcados si incluyen tu zona. También se dibujan en el mapa.
- **Mejor zona del día** con veredicto y métricas: CAPE, cizalladura 0–6 km y 0–1 km, helicidad 0–1 km (SRH), base de nube (LCL), punto de rocío, CIN y Lifted Index.
- **Mapa** con grilla de potencial (0,75°), localidades, radar animado (RainViewer), satélite GOES visible e infrarrojo (NASA GIBS) y avisos SMN.
- **Control de hora** para ver la evolución del día, y **Hoy / Mañana / Pasado**.
- **Ranking "Dónde ir"** con distancia y tiempo desde Leones o desde tu ubicación (GPS), curva del día y botón a Google Maps.
- Pestaña de Windy (CAPE) y link a rayos en vivo (LightningMaps no permite insertarse). Instalable en el celular (“Agregar a pantalla de inicio”).

## Cómo se actualiza
El workflow `Publicar panel` corre **cada hora** (y en cada push a `main`): `scripts/build-data.mjs` baja el pronóstico de Open-Meteo y los avisos del SMN, genera `data/forecast.json` y `data/smn.json`, y publica en GitHub Pages. Si el archivo de pronóstico falta o es viejo, el panel lo pide directo a Open-Meteo.

GitHub pausa los workflows programados tras 60 días sin actividad en el repo: si deja de actualizarse, reactivalo en Actions.

## Índice de potencial (0–100)
Energía y viento se **multiplican**: `70 · √(energía · viento)`, con energía = CAPE/2500 y viento = 55% cizalladura 0–6 km/20 m/s + 25% helicidad 0–1 km/100 m²/s² + 20% cizalladura 0–1 km/10 m/s.

- **Perfil de viento real**: se interpola el viento entre 10 m y los niveles de 925, 850, 700, 500 y 400 hPa usando su altura geopotencial. Los niveles que quedan bajo tierra se descartan, y las zonas de más de 1200 m (sierras) no se puntúan.
- **Helicidad (SRH) 0–1 km** con el movimiento de Bunkers de la supercélula que se desvía a la **izquierda**, la ciclónica en el hemisferio sur. Por eso la helicidad favorable es **negativa**.
- **Techo por cizalladura**: con 0–6 km < 15 m/s el puntaje no pasa de 55 (Moderado), y con < 10 m/s no pasa de 35 (Bajo). Mucho CAPE sin viento da granizo y ráfagas, no supercélulas.
- **Base de nube (LCL ≈ 125 m × (T − Td))**: ideal < 1000 m; se castiga en forma gradual hasta × 0,55 por encima de 2000 m.
- Suman: LI, rocío ≥18 °C, precipitación del modelo y días de mucha cizalla con poco CAPE y base baja (otoño/invierno). Restan: aire muy seco y CIN fuerte. Si el modelo no da CIN o LI, se muestra "sin dato" y no se asume nada.
- Se toma la mejor hora entre las **11 h y las 2 h del día siguiente**: en el Pasillo muchas tormentas severas son nocturnas, por el chorro de bajo nivel.

Indica dónde hay ingredientes; **no predice tornados**.

## Local
```bash
node scripts/build-data.mjs .
python3 -m http.server
```

## Pendiente
- Alertas a Telegram.
- Verificar en producción la lectura del feed CAP del SMN (`https://ssl.smn.gob.ar/CAP/AR.php`): si el formato cambió, el panel muestra "sin datos" y el link a smn.gob.ar.
