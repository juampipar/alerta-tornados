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
- **Desde dónde salís**: todo (plan, horarios, distancias, "Dónde ir") se calcula desde tu ubicación (GPS, se sigue mientras manejás), un pueblo de la lista o un punto tocado en el mapa. Se recuerda en el dispositivo; si nunca elegiste y ya diste permiso de ubicación, la usa sola. Leones queda solo como respaldo. Las alertas de Telegram siguen usando Leones (salvo el modo caza, que usa tu ubicación en tiempo real).
- **Ranking "Dónde ir"** con distancia y tiempo desde tu punto de salida, curva del día y botón a Google Maps.
- Pestaña de Windy (CAPE) y link a rayos en vivo (LightningMaps no permite insertarse). Instalable en el celular (“Agregar a pantalla de inicio”).

## Cómo funciona el sistema completo
Todo corre gratis en **GitHub Actions** (workflow `Publicar panel`, cada ~10–20 min) y se publica en **GitHub Pages**.

| Paso | Script | Fuente | Qué produce |
|---|---|---|---|
| 1. Pronóstico | `build-data.mjs` | Open-Meteo (modelos globales), cada 2 h | `forecast.json`: potencial 0–100 por pueblo y grilla, ingredientes, movimiento de tormentas |
| 2. Avisos oficiales | `build-data.mjs` | SMN (CAP), cada corrida | `smn.json`: avisos, incluidos los de muy corto plazo |
| 3. Lluvia del modelo SMN | `build-wrf.py` | WRF 4 km del SMN (AWS), 4 corridas/día | `wrf/*.png`: lluvia pronosticada hora por hora |
| 4. Tormentas en vivo | `nowcast.py` | Satélite GOES-19 banda 13 y rayos GLM (NOAA, AWS), cada 10 min | `nowcast.json`: núcleos de tormenta (tope, topes que sobresalen, si crecen, movimiento, rayos en 10 min y **salto de rayos**) + zooms `img/nucleo_*.png` |
| 5. Imágenes para la IA | `build-images.py` | GOES (NASA GIBS) + WRF | `img/*.png`: satélite ahora y hace 1 h, visible, lluvia del modelo, con pueblos y avisos dibujados |
| 6. Decisión y avisos | `alert.mjs` | todo lo anterior + Telegram + OpenStreetMap + Gemini | `brief.json` (resumen para IA) y mensajes de Telegram |

**Cómo decide:**
- **Zonas de caza** (`lib/risk.mjs`): áreas con más potencial; opciones ordenadas por las que llegás a tiempo; 👁 parada en una estación de servicio (OpenStreetMap) al costado del camino de las tormentas; chequeo de si tu ruta cruza su paso.
- **Tormentas ahora**: el satélite llega con 10–30 min de atraso; cada núcleo se **adelanta** con su movimiento (satélite + pronóstico) para estimar dónde está ahora y en +30/+60 min.
- **IA (Gemini)**: recibe `brief.json` + las imágenes (incluidos los zooms de alta resolución) y escribe "🤖 Qué haría yo", con reglas de seguridad fijas.

**Rayos (GLM):** para cada núcleo se cuentan los rayos a menos de 30 km en los últimos 10 min y en los 10 anteriores (con el núcleo adelantado según su movimiento). **Salto de rayos** = al menos 5 por minuto y el doble que antes: suele anticipar granizo, viento fuerte o rotación en 10–30 min. Se marca ⚡⚡ en el mapa y dispara el aviso 🛰️ de Telegram en días de caza.

**Mensajes de Telegram:** 🌪️ Día de caza · 🚨 ¡Ya se están formando! (SMN) · 🛰️ Tormenta nueva o creciendo (satélite, días de caza) · 🎯 Modo caza (con tu ubicación en tiempo real: ⚠️ tormenta cerca / 🛰️ se está formando, + zoom del satélite) · 🤖 Qué haría yo.

**Probar con un momento pasado:** Actions → Publicar panel → Run workflow → `repetir` = hora UTC (ej. `2026-11-03T21:40`). Simula el modo caza desde Leones con el satélite de ese momento, manda los mensajes y no publica el panel.

**Límites:** no hay radar de velocidad (el SMN no lo publica): el gancho y el giro no se ven; el satélite muestra topes fríos y topes que sobresalen (señales de supercelda), no tornados. Las posiciones estimadas y los movimientos son aproximados.

## Red de tormentas (Supabase)
Sección **🎥 Red** y capa **🎥 Publicaciones** del mapa. Cualquiera ve lo publicado; para publicar se entra con Google.
- **Publicar**: un **link de video** (obligatorio: YouTube se ve adentro; Instagram, TikTok, Facebook y X se abren aparte), ubicación exacta (GPS o punto en el mapa, se muestra en el mapa público), hora en que lo viste (últimos 7 días), qué viste y descripción. No se suben fotos.
- **Actividad en el mapa**: 🎥 que late = última hora; normal = últimas 24 h; apagado = días anteriores. En rojo si se vio rotación, embudo o tornado.
- **Pronóstico**: cada video muestra a qué zona de caza de ese día pertenece y el valor del índice en ese lugar y esa hora.
- **Moderación**: cada uno borra lo suyo; 3 denuncias ocultan una publicación; el admin (tabla `admins`) ve, oculta, muestra y borra todo. Límite de 20 publicaciones por día por persona.
- **Base**: proyecto `yqppzogcaoxhsmgtghqi`. Tablas `publicaciones`, `denuncias`, `admins`. Todo con RLS; el autor, la fecha de creación, el día de tormenta y las denuncias los completa la base (no se pueden falsear desde la web). Esquema en `supabase/esquema.sql`; conexión en `lib/red-config.mjs` (la clave publishable es pública por diseño).

## Historial y entrenamiento del índice
Se arma solo en cada corrida (`scripts/historial.mjs`) y se guarda en `historial.json` (rama **`datos`**; copia en `data/historial.json`), por **día de tormenta** (de 6 h a 6 h):
- **Videos de la red**: cada uno con su hora, lugar, qué se vio y el **índice en ese lugar y hora** (punto de la grilla más cercano, hora redonda más cercana, más los ingredientes del pueblo más cercano). Se calcula la primera vez que se ve la publicación y se conserva: es el dato para entrenar el índice.
- **Pronóstico**: el de la noche anterior y el de la mañana (zona de caza, potencial, hora pico, centro).
- **Avisos del SMN** (los de corto plazo marcados) y **satélite** (topes < −63 °C o topes que sobresalen).

La sección **📒 Historial** muestra cuántos avistajes de rotación, embudo o tornado hubo, el índice promedio donde se vieron y cuántos cayeron con índice 60+, 45–59 o menos de 45; y por día, lo pronosticado contra lo que pasó.

## Aprende de los errores (zona y hora)
`lib/sesgo.mjs`. En cada corrida, el historial compara cada día pasado que tuvo zona de caza con dónde y cuándo aparecieron de verdad las tormentas fuertes a menos de 250 km: avisos a corto plazo del SMN, topes que sobresalen en el satélite y videos de la red (los de rotación, embudo o tornado pesan doble). De cada día saca cuántos km al este/norte y cuántas horas antes/después aparecieron.
- Con **3 días o más** corrige el pronóstico con la **mediana** de esos errores (un día raro no la arrastra), achicada cuando hay pocos días (con 3 días pesa la mitad; con 30, casi todo) y con topes de 80 km y 3 h.
- **Zona**: el centro se corre. **Hora**: el pico se corre. **Ventana de horas**: las horas seguidas alrededor del pico en que la zona está a menos de 10 puntos de su máximo, corrida por lo aprendido y ensanchada según cuánto varía el error de un día a otro.
- El panel dice cuánto corrigió ("Corregido con N días: las tormentas aparecieron X km al este y Y h más tarde") o cuántos días faltan para empezar.
- La corrección está en `historial.json` (`sesgo`). La usan el panel y las alertas de Telegram (que la leen del historial publicado). El resumen `brief.json` guarda además `hora_pico_modelo` y `centro_modelo`: el historial mide el error contra el modelo sin corregir, para que la corrección no se mida contra sí misma.

## Varios modelos (GFS, ICON, ECMWF)
`lib/modelos.mjs`. Cada 6 h (`modelos.json`, reusado entre corridas para cuidar la cuota de Open-Meteo) se calcula el mismo índice con **GFS, ICON y ECMWF por separado**, en los pueblos más una grilla de 1,5°. Para cada zona de caza se ve el máximo de cada modelo cerca de la zona y a qué hora: si los tres llegan a 45 o más, la zona es confiable; si solo uno la ve, es dudosa. La ventana de horas se ensancha para incluir los picos de los modelos que coinciden. Lo muestran el panel ("🧮 Modelos: GFS 72 (17:00) · ICON 65 (18:00) · ECMWF 70 (19:00) → 3 de 3"), Telegram y el resumen para la IA. Un modelo sin datos útiles se descarta solo.

## Entrenamiento con tornados reales (EE.UU.)
Workflow **Entrenar índice** (`.github/workflows/entrenar.yml`, todas las noches a las 2:23 h y a mano desde Actions), scripts en `scripts/entrenar/` y lógica en `lib/entrenar.mjs`:
1. **Casos** (`casos.mjs`): tornados EF1+ de la base pública del SPC desde 2022 (un caso por brote: tornados a menos de 50 km y 2 h se juntan) y el doble de casos sin tornado: la mitad el mismo día a 300–600 km de un tornado y la mitad al azar en la temporada, siempre a más de 300 km y 6 h de cualquier tornado.
2. **Ambientes** (`ambientes.mjs`): para cada caso, el **archivo de pronósticos de Open-Meteo** (los mismos modelos y variables que usa el panel en vivo, así no hay diferencia entre entrenar y usar), con los **vientos espejados al hemisferio sur** (la helicidad tornádica queda negativa, como acá). Se calculan los ingredientes con `metrics()` y el índice actual con `scoreOf()`. Avanza de a tandas (2000 casos por noche) y retoma donde quedó.
3. **Modelo** (`entrenar.mjs`): regresión logística (energía, cizalla, cizalla baja, helicidad, base de nube, rocío, tapa y dos combinaciones) entrenada con 2022–2023 y **probada con 2024** contra el índice actual (AUC). Solo si le gana por 0,02 o más se usa.

Todo queda en la rama `datos` (`entrenamiento/`). El panel muestra "🧠 Parecido a ambientes de tornado de EE.UU.: N/100" en la mejor zona cuando el modelo mejora al índice. No es una probabilidad real de tornado en Argentina: dice qué tanto se parece el ambiente a los que dieron tornados allá.

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

## Dónde pararse (paradas rurales y punto para ver la tormenta)
- **Parada del plan** (`ruralStop` / `pickRural` en `lib/risk.mjs`): se calcula el punto ideal al costado del camino de las tormentas (lado norte si van al este) y se engancha a **una ruta asfaltada en el campo**, nunca adentro de un pueblo: a más de 9 km de una ciudad, 6 de un pueblo y 3 de una villa. Prefiere un **cruce de rutas** (dos salidas) y una ruta que salga hacia el lado bueno, para alejarse si la tormenta se acerca. Descarta caminos de tierra. Al pueblo más cercano solo se va antes, a cargar nafta. Datos de OpenStreetMap (Overpass).
- **🎯 Punto para ver una tormenta en vivo** (`mejorIntercepcion` en `lib/tormenta.mjs`): con el satélite elige la mejor tormenta **aislada** a la que llegás (topes que sobresalen, salto de rayos, la más fría) y calcula un punto a 15 km del costado de su camino y adelante, al que llegás con 15 min de margen antes que ella y **sin cruzarte por delante**. También se engancha a una ruta rural. Si la tormenta tiene señales de **granizo grande** (topes ≤ −63 °C, topes que sobresalen o salto de rayos) el punto se aleja a **22 km** (las piedras grandes caen lejos del núcleo). El granizo cae del lado derecho de su camino (sur si va al este): el punto queda siempre del otro lado. Sale en el mapa del panel (🎯, tocalo para ver la ruta), en el modo caza y en el aviso del satélite de Telegram, y la IA recibe ese punto para recomendarlo (no inventa otro).

## Vigía: avisos cada 10 minutos de verdad
GitHub corre los cron "cada 10 min" cuando puede: con mucha carga, cada 1 a 6 horas, y así una tormenta puede pasar sin que nadie la vea. Por eso los avisos de Telegram los manda **el vigía** (`.github/workflows/vigia.yml`): una tarea que queda prendida ~5 h 30 min revisando cada 10 minutos (avisos del SMN, satélite y rayos, modo caza) y al terminar **se vuelve a lanzar sola**. Tiene además un cron de respaldo cada 3 h por si la cadena se corta. Cada 30 min lanza el panel (`pages.yml` con `auto=true`), así los datos del sitio están frescos.
- El pronóstico pesado lo calcula el panel cada 2 h (cuota de Open-Meteo); el vigía usa el publicado y solo renueva el SMN (`ONLY_SMN=1`).
- El panel ya no manda mensajes (`DRY_RUN`), salvo cuando se lo corre a mano con **prueba** o **repetir**.
- Para ver si está andando: Actions → "Vigía (avisos cada 10 min)": tiene que haber una corrida en curso. Cada vuelta deja en el log qué decidió.

- **🧊 Se te viene el granizo** (modo caza, `peligroGranizo` en `lib/tormenta.mjs`): si una tormenta fuerte va a pasar a menos de 12 km tuyo en los próximos 35 min (con margen por si se desvía hacia vos), te avisa en el momento, antes que cualquier otro mensaje: a cuántos km pasa, en cuántos minutos, si tiene señales de granizo grande y **hacia dónde moverte ya** (~12 km perpendicular a su camino, sin cruzarla por delante, hasta un punto sobre ruta asfaltada). Una vez por tormenta cada 15 min.

- **🔄 Cambió el pronóstico** (vigía): si la zona que te mandó el aviso del día baja (menos de 50, o 10 puntos) o aparece otra 10 puntos mejor, te avisa y te da **la mejor opción de ahora desde donde estás** (tu ubicación del modo caza, o Leones): zona, parada rural, km, hora y ruta. Si no queda ninguna, te dice que vuelvas. Como mucho uno cada 40 min.

- **🗺️ Mapas y pines en Telegram** (`scripts/mapa.py`): los avisos de tormenta (modo caza, granizo, satélite, tormenta hacia Leones) traen un mapa con rutas y pueblos de fondo (OpenStreetMap), cada tormenta con su camino (+30 y +60 min) y la zona donde suele caer el granizo (en las fuertes), vos en azul y en verde adónde ir o hacia dónde escapar. Además un **pin** de Telegram del punto (parada, punto para ver la tormenta o escape): se toca y se abre en el mapa del celular para navegar.

## Alertas por Telegram
Cada 10 minutos el vigía revisa los datos y manda estos mensajes:

- 🌪️ **Día de caza**: hoy o mañana alguna zona llega a **60** o más (de **50 a 59** llega igual, como 🟠 **día posible**: potencial moderado). Trae la mejor zona, la hora pico, a qué hora salir desde Leones, hacia dónde van las tormentas, los ingredientes explicados (energía, cizalladura, giro cerca del suelo, base de nube), otras zonas y la ruta en Google Maps. Uno por día, y otro si sube 10 puntos. Entre las 23 y las 7 h no se manda.
- 🚨 **¡Ya se están formando!**: solo en un día de caza, cuando el SMN emite un aviso a corto plazo cerca de Leones (200 km) o de las zonas marcadas (80 km). Es la confirmación de que lo que marcaba el pronóstico está pasando. Los avisos del SMN de días comunes **no** se mandan (son muchos y casi nunca son de tornado).
- ⛈️ **Tormenta fuerte hacia Leones** (todos los días, no solo de caza; cada 10 min): una tormenta fuerte viene hacia Leones en las próximas 2 h, o un aviso a corto plazo del SMN cubre Leones. Lógica en `lib/tormenta.mjs`, la misma que la tarjeta ⛈️ del panel (que usa tu ubicación).
  - **Qué tan seguro es que llegue**: 🔴 muy probable / 🟠 probable / 🟡 posible, pero no es seguro. Suma si viene derecho (con ±20° de error de dirección), si falta poco, si el satélite confirma el movimiento y si crece; resta si pasa de costado, si falta más de 1 h o si se debilita. Un aviso del SMN solo (sin tormenta en el satélite) es 🟠, porque cubre una zona grande.
  - **Granizo**: probable / posible / poco probable, con las señales: topes que sobresalen, salto de rayos (GLM), topes muy fríos, si crece, la energía y la cizalla pronosticadas y si el aviso del SMN nombra granizo. El satélite no ve el granizo: son señales, y el mensaje lo dice.
  - Para no dar falsas alarmas: 🔴 y 🟠 se mandan siempre; 🟡 solo de día, si el granizo es al menos posible y llega en menos de 90 min. No repite (de nuevo solo si sube el nivel o pasaron 45 min) y avisa una vez cuando "ya no viene". Con el modo caza prendido no se manda (ese ya avisa con tu ubicación).
  - **Cuenta cuántas acertó**: cada alerta se revisa sola (¿pasó una tormenta fuerte a menos de 25 km o hubo aviso del SMN en la ventana prevista?) y el mensaje muestra "📊 Estas alertas llegaron: 🔴 3 de 4 · 🟠 2 de 5…".

**Configuración (una sola vez):**
1. En Telegram, hablale a **@BotFather** → `/newbot` → elegí nombre. Te da un **token**.
2. Escribile cualquier cosa a tu bot nuevo (si no, no te puede escribir).
3. Abrí `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador y copiá el número de `"chat":{"id": ...}`. Ese es tu **chat id**.
4. En GitHub: Settings → Secrets and variables → Actions → **New repository secret**: `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.
5. Probá: Actions → "Publicar panel" → Run workflow → tildá **prueba**. Te llega un resumen aunque no haya alerta.

**🤖 Recomendación con IA (opcional, gratis):** cuando llega un "Día de caza" o un 🚨, Gemini lee `data/brief.json` (un resumen de todo el panel pensado para IA) y manda un mensaje corto "Qué haría yo", con reglas de seguridad fijas. Para activarla: en https://aistudio.google.com tocá **Get API key → Create API key**, copiala y cargala como secreto `GEMINI_API_KEY` (Settings → Secrets and variables → Actions). La capa gratuita alcanza; el modelo se puede cambiar con la variable `GEMINI_MODEL` (por defecto `gemini-flash-latest`). Sin la clave todo funciona igual, sin ese mensaje.

Opcional, en la pestaña **Variables** de esa misma pantalla: `MIN_SCORE` (umbral, 50 por defecto: de 50 a 59 llega como 🟠 día posible, desde 60 como 🌪️ día de caza) y `RADIUS_KM` (radio para avisos SMN, 200 por defecto). Para un grupo, agregá el bot al grupo y usá el id del grupo (empieza con `-`).

Local: `DRY_RUN=1 node scripts/alert.mjs .` muestra lo que mandaría sin enviarlo.

## Local
```bash
node scripts/build-data.mjs .
python3 -m http.server
```

## Pendiente
- Verificar en producción la lectura del feed CAP del SMN (`https://ssl.smn.gob.ar/CAP/AR.php`): si el formato cambió, el panel muestra "sin datos" y el link a smn.gob.ar.
