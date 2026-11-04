# Alerta Pasillo de Tornados

Panel para saber **dónde y cuándo** hay potencial de tormentas severas en el Pasillo de los Tornados (Córdoba, Santa Fe, Buenos Aires, Entre Ríos, La Pampa y San Luis), con base en Leones.

Publicado en https://juampipar.github.io/alerta-tornados/

## Qué tiene
- **Avisos oficiales del SMN** (formato CAP) filtrados al Pasillo, con los *avisos a muy corto plazo* destacados y marcados si incluyen tu zona. También se dibujan en el mapa.
- **Zona de caza del día** con veredicto y métricas: CAPE, cizalladura 0–6 km y 0–1 km, helicidad 0–1 km (SRH), base de nube (LCL), punto de rocío, CIN y Lifted Index.
- **Plan de caza** para novatos: si vale salir, destino, dónde parar (estación de servicio), a qué hora salir, hacia dónde y a qué velocidad van las tormentas, de qué lado ponerse, escape y hora de volver (puesta del sol). Si el pico es de noche, avisa que no hay que perseguir.
- **Dibujo de la tormenta vista desde arriba**, girado según hacia dónde van ese día: dónde cae el granizo, dónde está la rotación, dónde pararse y por dónde escapar.
- **Guía para la primera vez** (tres etapas, errores de novato) y **cómo leer el radar** (colores y formas: celda aislada, línea, gancho).
- **Mapa** con grilla de potencial (0,75°), localidades, radar animado (RainViewer), satélite GOES visible e infrarrojo (NASA GIBS) y avisos SMN.
- **Control de hora** para ver la evolución del día, y **Hoy / Mañana / Pasado**.
- **Ranking "Dónde ir"** con distancia y tiempo desde Leones o desde tu ubicación (GPS), curva del día y botón a Google Maps.
- Pestaña de Windy (CAPE) y link a rayos en vivo (LightningMaps no permite insertarse). Instalable en el celular (“Agregar a pantalla de inicio”).

## Cómo funciona el sistema completo
Todo corre gratis en **GitHub Actions** (workflow `Publicar panel`, cada ~10–20 min) y se publica en **GitHub Pages**.

| Paso | Script | Fuente | Qué produce |
|---|---|---|---|
| 1. Pronóstico | `build-data.mjs` | Open-Meteo (modelos globales), cada 2 h | `forecast.json`: potencial 0–100 por pueblo y grilla, ingredientes, movimiento de tormentas |
| 2. Avisos oficiales | `build-data.mjs` | SMN (CAP), cada corrida | `smn.json`: avisos, incluidos los de muy corto plazo |
| 3. Lluvia del modelo SMN | `build-wrf.py` | WRF 4 km del SMN (AWS), 4 corridas/día | `wrf/*.png`: lluvia pronosticada hora por hora |
| 4. Tormentas en vivo | `nowcast.py` | Satélite GOES-19 banda 13 (NOAA, AWS), cada 10 min | `nowcast.json`: núcleos de tormenta (tope, topes que sobresalen, si crecen, movimiento) + zooms `img/nucleo_*.png` |
| 5. Imágenes para la IA | `build-images.py` | GOES (NASA GIBS) + WRF | `img/*.png`: satélite ahora y hace 1 h, visible, lluvia del modelo, con pueblos y avisos dibujados |
| 6. Decisión y avisos | `alert.mjs` | todo lo anterior + Telegram + OpenStreetMap + Gemini | `brief.json` (resumen para IA) y mensajes de Telegram |

**Cómo decide:**
- **Zonas de caza** (`lib/risk.mjs`): áreas con más potencial; opciones ordenadas por las que llegás a tiempo; 👁 parada en una estación de servicio (OpenStreetMap) al costado del camino de las tormentas; chequeo de si tu ruta cruza su paso.
- **Tormentas ahora**: el satélite llega con 10–30 min de atraso; cada núcleo se **adelanta** con su movimiento (satélite + pronóstico) para estimar dónde está ahora y en +30/+60 min.
- **IA (Gemini)**: recibe `brief.json` + las imágenes (incluidos los zooms de alta resolución) y escribe "🤖 Qué haría yo", con reglas de seguridad fijas.

**Mensajes de Telegram:** 🌪️ Día de caza · 🚨 ¡Ya se están formando! (SMN) · 🎯 Modo caza (con tu ubicación en tiempo real: ⚠️ tormenta cerca / 🛰️ se está formando, + zoom del satélite) · 🤖 Qué haría yo.

**Probar con un momento pasado:** Actions → Publicar panel → Run workflow → `repetir` = hora UTC (ej. `2026-11-03T21:40`). Simula el modo caza desde Leones con el satélite de ese momento, manda los mensajes y no publica el panel.

**Límites:** no hay radar de velocidad (el SMN no lo publica): el gancho y el giro no se ven; el satélite muestra topes fríos y topes que sobresalen (señales de supercelda), no tornados. Las posiciones estimadas y los movimientos son aproximados.

## Cómo se actualiza
El workflow `Publicar panel` corre **cada 10 minutos** (y en cada push a `main`). El pronóstico se recalcula cada 2 horas (cuota gratuita de Open-Meteo); en las otras corridas solo se renuevan los avisos del SMN (los de muy corto plazo duran 1–2 h): `scripts/build-data.mjs` baja el pronóstico de Open-Meteo y los avisos del SMN, genera `data/forecast.json` y `data/smn.json`, y publica en GitHub Pages. Si el archivo de pronóstico falta o es viejo, el panel lo pide directo a Open-Meteo.

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

## Zonas de caza y lluvia del modelo SMN
- **Zona de caza** (círculo en el mapa, recuadro principal y Telegram): el área con más potencial según la grilla. Su número es el del punto más fuerte del círculo. "Ir hacia" es el pueblo de más puntaje dentro de la zona, solo como destino para el GPS. Si el centro está a más de 25 km del pueblo más cercano se nombra "al <rumbo> de <pueblo>".
- **Lluvia SMN**: lluvia pronosticada por el modelo WRF del SMN (4 km), hora por hora, desde los datos abiertos en AWS (`scripts/build-wrf.py`).

La guía de uso está en el panel, botón **❓ Cómo usar**.

## Alertas por Telegram
Cada hora, el mismo workflow revisa los datos. Manda dos tipos de mensaje:

- 🌪️ **Día de caza**: hoy o mañana alguna zona llega a **60** o más. Trae la mejor zona, la hora pico, a qué hora salir desde Leones, hacia dónde van las tormentas, los ingredientes explicados (energía, cizalladura, giro cerca del suelo, base de nube), otras zonas y la ruta en Google Maps. Uno por día, y otro si sube 10 puntos. Entre las 23 y las 7 h no se manda.
- 🚨 **¡Ya se están formando!**: solo en un día de caza, cuando el SMN emite un aviso a corto plazo cerca de Leones (200 km) o de las zonas marcadas (80 km). Es la confirmación de que lo que marcaba el pronóstico está pasando. Los avisos del SMN de días comunes **no** se mandan (son muchos y casi nunca son de tornado).

**Configuración (una sola vez):**
1. En Telegram, hablale a **@BotFather** → `/newbot` → elegí nombre. Te da un **token**.
2. Escribile cualquier cosa a tu bot nuevo (si no, no te puede escribir).
3. Abrí `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador y copiá el número de `"chat":{"id": ...}`. Ese es tu **chat id**.
4. En GitHub: Settings → Secrets and variables → Actions → **New repository secret**: `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.
5. Probá: Actions → "Publicar panel" → Run workflow → tildá **prueba**. Te llega un resumen aunque no haya alerta.

**🤖 Recomendación con IA (opcional, gratis):** cuando llega un "Día de caza" o un 🚨, Gemini lee `data/brief.json` (un resumen de todo el panel pensado para IA) y manda un mensaje corto "Qué haría yo", con reglas de seguridad fijas. Para activarla: en https://aistudio.google.com tocá **Get API key → Create API key**, copiala y cargala como secreto `GEMINI_API_KEY` (Settings → Secrets and variables → Actions). La capa gratuita alcanza; el modelo se puede cambiar con la variable `GEMINI_MODEL` (por defecto `gemini-flash-latest`). Sin la clave todo funciona igual, sin ese mensaje.

Opcional, en la pestaña **Variables** de esa misma pantalla: `MIN_SCORE` (umbral, 60 por defecto) y `RADIUS_KM` (radio para avisos SMN, 200 por defecto). Para un grupo, agregá el bot al grupo y usá el id del grupo (empieza con `-`).

Local: `DRY_RUN=1 node scripts/alert.mjs .` muestra lo que mandaría sin enviarlo.

## Local
```bash
node scripts/build-data.mjs .
python3 -m http.server
```

## Pendiente
- Verificar en producción la lectura del feed CAP del SMN (`https://ssl.smn.gob.ar/CAP/AR.php`): si el formato cambió, el panel muestra "sin datos" y el link a smn.gob.ar.
