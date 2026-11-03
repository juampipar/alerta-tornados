# Alerta Pasillo de Tornados

Panel para saber **dónde** hay potencial de tormentas severas en el Pasillo de los Tornados (Córdoba, Santa Fe, Buenos Aires, Entre Ríos, La Pampa), con base en Leones.

- **Panel web** (`index.html`): mapa con radar (RainViewer), satélite GOES (NASA GIBS), zonas con índice de potencial, pestañas Windy/rayos y ranking de zonas con distancia y botón "Ir".
- **Alertas a Telegram** (`scripts/alert.mjs` + GitHub Actions): 3 veces al día revisa las 25 localidades y te escribe si alguna supera el umbral.

## Índice de potencial
Score 0–100 por localidad, mejor hora entre 12 y 21 h: CAPE (45%), cizalladura 10 m→500 hPa (40%), Lifted Index (bonus) y CIN (penaliza). Fuente: Open-Meteo. **No predice tornados**: sirve para elegir adónde mirar; confirmá con radar, satélite y avisos del SMN.

## Puesta en marcha
1. Settings → Pages → Source: GitHub Actions. Mergeá a `main` y el panel se publica.
2. Telegram: creá un bot con @BotFather, escribile y obtené tu chat id (ej. con @userinfobot).
3. Settings → Secrets → Actions: `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.
4. Probá: Actions → "Alerta Telegram" → Run workflow (envía siempre).

Local: `node scripts/alert.mjs` con `DRY_RUN=1`; `python3 -m http.server` para el panel.

## Pendiente / a verificar
Desarrollado sin acceso a internet: validá que carguen radar, satélite y Windy. Los avisos del SMN no están integrados (no hay API pública estable verificada); por ahora hay link directo.
