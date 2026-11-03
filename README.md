# Alerta Pasillo de Tornados

Panel para saber **dónde** hay potencial de tormentas severas en el Pasillo de los Tornados (Córdoba, Santa Fe, Buenos Aires, Entre Ríos, La Pampa), con base en Leones.

- **Panel web** (`index.html`): mapa con radar (RainViewer), satélite GOES (NASA GIBS), zonas con índice de potencial, pestañas Windy/rayos y ranking de zonas con distancia y botón "Ir".

## Índice de potencial
Score 0–100 por localidad, mejor hora entre 12 y 21 h: CAPE (45%), cizalladura 10 m→500 hPa (40%), Lifted Index (bonus) y CIN (penaliza). Fuente: Open-Meteo. **No predice tornados**: sirve para elegir adónde mirar; confirmá con radar, satélite y avisos del SMN.

## Puesta en marcha
Settings → Pages → Source: GitHub Actions. Al mergear a `main` el panel se publica. Local: `python3 -m http.server`.

## Pendiente / a verificar
Desarrollado sin acceso a internet: validá que carguen radar, satélite y Windy. Los avisos del SMN no están integrados (no hay API pública estable verificada); por ahora hay link directo.
Alertas a Telegram: pendientes para una próxima etapa.
