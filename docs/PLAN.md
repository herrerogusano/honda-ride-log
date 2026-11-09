# Plan y relevo entre fases

Este documento es el punto de partida de cualquier hilo que trabaje en el
repo. Dice qué se construye, qué está decidido, qué se ha comprobado y qué no,
y cómo se reparte el trabajo. Actualízalo al cerrar cada fase.

Última actualización: 2026-11-09, cierre de la fase 1.

## 1. Qué es

Una web estática en la que cada persona invitada entra con su cuenta de MAPIT
(la app que localiza la moto) y ve las estadísticas de sus propias rutas.

- No tiene servidor propio. Es un cliente de un servicio aparte, ya
  desplegado, solo por invitación y con un máximo de 10 usuarios (repo
  `honda-mapit-mcp`, documento `docs/multiuser-production.md`). Ese servicio
  ofrece herramientas de solo lectura por `POST /mcp`.
- El navegador inicia sesión en el login del servicio (Amazon Cognito, flujo
  de código de autorización con PKCE, cliente público sin secreto) y llama a
  las herramientas con el token de acceso.
- Se publica en GitHub Pages: `https://herrerogusano.github.io/honda-ride-log/`.
- Proyecto personal, sin relación con Honda ni con MAPIT.

## 2. Decisiones tomadas (no reabrir sin orden del propietario)

| Tema | Decisión |
|---|---|
| Forma | Web estática, repo propio, privado al crearlo; el propietario lo hace público y activa Pages. |
| Alcance | Tres pestañas (Resumen, Mapa, Rutas), tarjeta para compartir solo con cifras, modo demo sin login. |
| Fuera | Atlas 3D, sección de territorio, velocidad máxima en cualquier parte, filtros de «geometría inferida», exportación JSON, fuentes incrustadas (se usan las del sistema). |
| Privacidad | Ver el apartado 4. Son requisitos. |
| Unidades | «km» a secas, con nota al pie: se usan los campos `*_km` del servicio, que el propio servicio marca como conversión sin confirmar. Nunca se convierte la distancia nativa. |
| Zona horaria | Una sola: la del navegador. El campo `timezone` de cada ruta no se usa. |
| Pila | Vite y TypeScript estricto, sin framework. Leaflet como única dependencia de ejecución. Gráficos en SVG a mano. Vitest y ESLint. |
| Rutas de menos de 300 m | Se excluyen de todo (lista, mapa y cifras) y se dice cuántas son en una nota. Pendiente de confirmar por el propietario (apartado 9). |
| Almacenamiento | El token de acceso vive en una variable y nada más. El verificador de PKCE y el `state` van a `sessionStorage` solo durante la ida y vuelta al login y se borran al volver. El token de renovación se descarta. En `localStorage` solo va lo que el usuario escribe para el mantenimiento. |
| Llamadas | Sin sesión MCP: una petición por herramienta, en serie (como mucho de 2 en 2). |
| Proceso | PR pequeñas contra `main`, CI en verde y revisión de un agente independiente antes de fusionar. |

## 3. Diseño de las tres pestañas

Todo se calcula en el navegador a partir de la lista de rutas ya saneada
(`Route[]` de `src/domain/model.ts`) y del estado del vehículo. No se usan las
herramientas de estadísticas del servicio.

Definiciones comunes: «salida» es una ruta visible (300 m o más). El día, el
mes, el día de la semana y la hora de una ruta son los de su instante de
inicio en la zona horaria del navegador. La semana empieza en lunes.

### Resumen

1. **Estado**: batería (porcentaje), último uso (fin de la última ruta; si no
   hay rutas, última comunicación del vehículo) y odómetro (el del estado; si
   falta, el kilometraje de los datos del vehículo). Sin posición.
2. **Cuatro cifras** del año elegido (por defecto el actual, con selector de
   año y «Todo»): km, salidas, horas en marcha (suma de duraciones conocidas)
   y «este mes frente al mismo mes del año anterior» (km de los dos y la
   diferencia). La cuarta cifra no depende del selector.
3. **Km por mes comparando años**: barras agrupadas, 12 meses, una serie por
   año (los tres últimos con datos). Un mes sin rutas es una barra vacía, no
   un hueco en el eje.
4. **Hábitos**: salidas por día de la semana y salidas por hora de salida
   (0 a 23).
5. **Tres récords**: la ruta más larga, el día con más km y el mes con más km,
   cada uno con su fecha.
6. **Rachas**: la racha más larga de días seguidos con al menos una salida y
   la más larga de días seguidos con la moto parada (entre la primera y la
   última salida), y las dos rachas en curso a día de hoy.
7. **Mantenimiento**: el usuario escribe cada cuántos km toca revisión y el
   odómetro de la última; la web dice «te faltan X km para la revisión» (o
   «te has pasado X km»). Esos dos números se guardan en `localStorage`.
8. **Trayectos cortos**: qué parte de las salidas y qué parte de los km son de
   rutas de menos de 5 km.

Nota al pie fija: unidades sin confirmar, cuántas rutas de menos de 300 m no
se cuentan y cuántas se han descartado por venir sin fecha o sin km.

### Mapa

- Un solo mapa Leaflet con teselas de OpenStreetMap
  (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) y su atribución visible.
- Muestra la ruta elegida. El detalle de una ruta se pide **al pulsarla**
  (`get_route_detail`), nunca al cargar; se guarda en memoria para no pedirlo
  dos veces.
- Solo se dibujan las líneas, ya recortadas (apartado 4). Sin marcadores de
  inicio ni de fin. Los tramos marcados como inferidos por el servicio se
  dibujan con trazo discontinuo y una leyenda que dice que es una etiqueta
  descriptiva, no una garantía de precisión.
- Si tras el recorte no queda traza, se dice «traza oculta por privacidad».

### Rutas

- Lista con fecha, hora de salida, duración, km y velocidad media.
- Búsqueda por texto sobre la fecha (día, mes, año, día de la semana) y orden
  por fecha o por distancia.
- Al pulsar una ruta se abre en la pestaña Mapa.
- Exportar CSV de lo que se ve, con esas mismas columnas. Sin identificadores
  ni coordenadas. Las celdas que empiecen por `=`, `+`, `-` o `@` se protegen
  para que una hoja de cálculo no las ejecute.

### Tarjeta para compartir y modo demo

- Tarjeta «Tu 2026 en moto» (el año elegido): solo cifras (km, salidas,
  horas, ruta más larga, mes con más km). Sin mapa ni coordenadas. Se dibuja
  en un `<canvas>` y se descarga como PNG.
- Modo demo: funciona sin login con `createDemoService(generateRider(...))`
  de `src/demo/`. Recorre el mismo camino de código que los datos reales
  (mismos saneadores, mismos límites), así que sirve para separar un fallo de
  la interfaz de un fallo del servicio. Debe verse claramente que son datos
  de ejemplo.

### Accesibilidad básica

Pestañas navegables con teclado y con los roles ARIA de pestañas, contraste
suficiente en claro y oscuro, cada gráfico SVG con título y una tabla o texto
alternativo con las mismas cifras, nada que dependa solo del color.

## 4. Privacidad

| Regla | Cómo se cumple |
|---|---|
| Nunca matrícula, bastidor, datos del concesionario ni posición actual | `src/domain/sanitize.ts` copia una lista cerrada de campos y descarta el resto al recibir la respuesta. Que ningún otro módulo lea respuestas sin sanear es una convención: ninguna herramienta lo impide. |
| Nunca identificadores de ruta en pantalla ni en exportaciones | El identificador vive detrás de un `RouteRef` opaco y sin campos; solo `serviceRouteId` lo recupera, y ESLint solo deja importar esa función desde `src/service/` (donde irá la petición de detalle). Serializar una ruta no lo incluye. |
| Recortar 400 m al inicio y al final de cada traza antes de dibujarla | `TRIM_METERS` en `src/domain/privacy.ts`. **La función de recorte es trabajo de la fase 2 y va en `src/domain/trim.ts`.** El saneador devuelve un `UntrimmedTrace` sellado, sin campos legibles; sus líneas solo salen con `untrimmedLines`, que ESLint solo deja importar desde ese archivo. |
| Ocultar rutas de menos de 300 m | `hideShortRoutes` en `src/domain/privacy.ts`. |
| Token solo en memoria | Ver «Almacenamiento» en el apartado 2. ESLint prohíbe hoy `localStorage` y `sessionStorage` en todo el código; la fase que los necesite abre una excepción para un único archivo y lo anota aquí. |
| Sin analítica ni terceros, salvo las teselas de OpenStreetMap | Política de seguridad de contenido en `csp.config.json`. `scripts/check-dist.mjs` rompe el build si la página publicada no lleva exactamente esa política, si aparece código en línea o si carga algo de otro origen; `tests/csp.test.ts` fija su texto. |
| Los datos viven solo en el navegador y solo durante la sesión | Nada se guarda salvo los dos números de mantenimiento. |

Notas para quien implemente el recorte (comprobado con una lectura real):

- El GeoJSON de un detalle trae, además de las líneas, **dos puntos sueltos
  con el inicio y el final exactos**. El saneador ya los descarta; no los
  reintroduzcas.
- Las coordenadas vienen como `[longitud, latitud, 0]`. El saneador entrega
  `[latitud, longitud]`, que es el orden de Leaflet.
- Los puntos de una traza están muy separados (decenas para una ruta de 15
  km, con tramos de más de 400 m). El recorte tiene que cortar por distancia
  recorrida **dentro del tramo**, interpolando un punto nuevo; quitar los
  primeros N puntos no basta ni es correcto.
- Una ruta con varias líneas se recorta sobre el conjunto: 400 m desde el
  principio de la primera y 400 m hasta el final de la última.
- Una ruta cuya traza mide 800 m o menos se queda sin nada que dibujar.
- El servicio puede haber recortado ya el final de algunas trazas; nuestro
  recorte se aplica igualmente.
- El saneador solo conserva geometrías `LineString`, las únicas vistas. Si
  el servicio enviara otro tipo de línea, se ignoraría sin aviso.

La política de referencia es `strict-origin`: las normas de uso de las teselas
de OpenStreetMap exigen que el navegador envíe la cabecera `Referer`, y así
solo se envía el origen del sitio, nunca la ruta de la página.

La política de seguridad de contenido se envía en una etiqueta `<meta>`
porque GitHub Pages no permite cabeceras propias. Consecuencias: no se puede
usar `frame-ancestors` (no hay protección contra incrustar la página en un
marco) y los estilos se aplican con hojas de estilo o con `elemento.style`
desde JavaScript, nunca con atributos `style` en el HTML ni con
`setAttribute("style", ...)`.

## 5. Límites técnicos

### Comprobado

Leído en el código del servicio (rama `develop`, commit `131c9a8`) y, donde se
indica, visto en tres lecturas reales pequeñas hechas el 2026-11-09 (un
estado, una lista de 7 días con 2 rutas, un detalle). Ningún valor real está
en este repo.

- Un periodo (`to_time - from_time`) no puede pasar de 366 días: error
  `period_too_large`. `from_time` es inclusivo y `to_time` exclusivo. Se
  admite una fecha (`AAAA-MM-DD`, medianoche UTC) o una fecha y hora con zona;
  sin zona es `invalid_date_range`.
- `list_routes` devuelve como mucho 500 rutas (las primeras del periodo) y
  marca `truncated: true`; `matched_routes` dice cuántas había.
- Forma real de las respuestas: `src/service/contract.ts`. Visto en real: las
  fechas son UTC con milisegundos y `Z`; `distance` son enteros;
  `distance_km` es `distance / 1000`; `last_communication` son milisegundos
  desde 1970; la batería es un porcentaje entero; `odometer_start`,
  `odometer_end` son nulos y `complete` es siempre falso.
- El servicio limita a 10 peticiones por segundo (ráfaga de 20) y la cuenta
  tiene 10 ejecuciones simultáneas. Cada petición tiene un plazo interno de
  14 segundos y un máximo de 2 MiB de respuesta.
- El servicio monta el transporte HTTP de MCP **sin estado y con respuesta
  JSON**, y se niega a devolver `mcp-session-id`. De las cabeceras de la
  petición solo usa `host`, `authorization`, `origin`, `content-type`,
  `content-length`, `accept` y `mcp-protocol-version`. Rechaza con 400 una
  petición con cadena de consulta, con cookies o con más de 64 cabeceras.
- El token de acceso dura 60 minutos. El servicio exige en el token el
  público (`aud`) igual a la dirección de `/mcp`, el alcance
  `<dirección de /mcp>/use` y un `client_id` de su lista de clientes.
- **El servicio solo acepta la cabecera `Origin` de su propio dominio.** Un
  navegador siempre la envía con el origen de la web, así que hoy cualquier
  llamada desde la web sería rechazada aunque hubiera CORS. Ver apartado 7.

### Estimado, no medido

- Una lista de 500 rutas ocupa en torno a 0,7 MB (unos 620 bytes por ruta,
  enviados dos veces dentro de la respuesta MCP). Cabe en los 2 MiB, pero es
  una cuenta, no una medida.

### Sin comprobar

Nada de esto se ha probado desde un navegador. Se prueba cuando el
propietario despliegue el cambio del servicio.

- Que el login gestionado funcione desde un navegador con un cliente nuevo.
- Que el punto de canje de tokens de Cognito (`/oauth2/token`) responda a una
  petición de un navegador desde otro origen.
- Qué exige exactamente `/mcp` a un navegador. Hipótesis, por lectura del SDK
  de MCP: basta una petición `tools/call` sin `initialize` previo, con
  `Content-Type: application/json` y `Accept: application/json,
  text/event-stream`; la cabecera `mcp-protocol-version` es opcional.
- La forma del sobre de respuesta. Hipótesis: `result.structuredContent` con
  el objeto de la herramienta y `result.isError` en los errores, con el
  texto `código: mensaje` en `result.content[0].text`.
- Que baste con CORS más el cambio de `Origin` del apartado 7.
- Que cargar el historial entero quepa en los plazos (un semestre por
  petición) y que el orden de las rutas de una lista sea siempre ascendente.
- Qué error devuelve `get_route_detail` para un identificador desconocido (el
  servicio de demo usa un código genérico inventado).
- El campo `geometry_trimmed_end_m` aparece en una exportación antigua pero
  no en el modelo actual del servicio; el generador lo incluye a veces y el
  saneador lo ignora.

## 6. Carga de datos (para las fases 2 y 3)

1. `get_vehicle_status` y mostrar el estado enseguida. Es también la primera
   prueba de punta a punta: si falla, no se sigue.
2. `get_vehicle_details`.
3. `list_routes` por semestres naturales, del actual hacia atrás, en serie.
   Si una respuesta viene con `truncated`, se parte ese periodo por la mitad
   y se repite (ver el test «lets a caller recover every route by halving a
   truncated period»).
4. Se para al encontrar un año natural entero sin rutas.
5. Cada ruta abierta, un `get_route_detail`.

La interfaz que une todo es `ToolCaller` (`src/service/contract.ts`). La
implementan el servicio de demo y, en la fase 3, el cliente real. La carga y
la interfaz no deben saber cuál de los dos tienen delante.

Cada paso que pueda fallar necesita un código de error propio, visible en
pantalla y sin token ni datos: configuración ausente, vuelta del login
(`state` que no coincide), canje del código, red o CORS, 401, 403, error de
la herramienta, forma inesperada (`ShapeError` ya trae la ruta del campo).

## 7. Qué necesita del servicio (fase 4, en el repo del servicio)

1. Un tercer cliente de login, público y con PKCE, con dos direcciones de
   retorno por parámetro: la de Pages y una de `http://localhost` para
   desarrollo.
2. Añadir ese cliente a la lista de clientes admitidos.
3. CORS en la API para el origen de la web y el de desarrollo: método `POST`
   y cabeceras `authorization`, `content-type` y `mcp-protocol-version`.
4. **Que el servicio acepte el `Origin` de la web.** Hoy la lista de orígenes
   admitidos solo contiene el dominio de la propia API (`allowed_origins` en
   `src/mapit/multiuser_runtime.py`), y la lista de variables de entorno que
   acepta el arranque es cerrada (`src/mapit/multiuser_entrypoint.py`). Sin
   este cambio, el CORS solo no sirve. Es más que tocar la plantilla.

La web necesita, por entorno: la dirección de `/mcp`, el dominio del login y
el identificador del cliente. Ninguno es secreto, pero los de un despliegue
real no se escriben en el repo hasta que el propietario lo decida.

## 8. Convenciones del repo

```sh
npm ci
npm run dev        # servidor de desarrollo (sin política de seguridad de contenido)
npm run lint
npm run typecheck
npm test           # Vitest, tests en tests/*.test.ts
npm run build      # typecheck + vite build + comprobaciones sobre dist/
npm run preview    # sirve dist/ tal como se publicará
```

Node 22 o superior. La CI ejecuta lint, typecheck, test y build. Los tests
corren a propósito con la zona horaria de Los Ángeles, para que un cálculo
que se cuele en hora local dé un resultado distinto del esperado.

| Ruta | Qué hay |
|---|---|
| `src/service/contract.ts` | Formas sin sanear y límites de las cuatro herramientas; `ToolCaller`; `ToolCallError`. |
| `src/domain/model.ts` | Lo que el resto de la web puede tener en memoria. |
| `src/domain/sanitize.ts` | El único módulo que lee respuestas sin sanear. |
| `src/domain/privacy.ts` | Umbrales de privacidad y la regla de rutas cortas. |
| `src/demo/` | Generador de datos sintéticos con semilla y servicio de demo en memoria. |
| `tests/` | Tests. |
| `csp.config.json` | La política de seguridad de contenido y la de referencia. |
| `vite.config.ts` | Build, ruta base de Pages e inyección de la política. |
| `scripts/check-dist.mjs` | Comprobaciones de publicación sobre `dist/index.html`. |
| `.github/workflows/` | `ci.yml` y `pages.yml` (no hace nada mientras el repo sea privado). |

Reglas:

- El texto para el usuario va en español; el código, los comentarios y los
  commits, en inglés.
- Sin `innerHTML`, sin código ni estilos en línea, sin dependencias de
  ejecución nuevas sin motivo escrito aquí.
- Cada test nuevo se ve fallar una vez con un dato roto antes de contar. En
  la fase 1 se hizo rompiendo el código de 56 maneras, una cada vez, más 32
  que probó por su cuenta el revisor; las que sobrevivieron se cubrieron
  después con tests nuevos.
- Un test en verde contra el servicio de demo prueba el contrato tal como lo
  leímos, no que el servicio real se comporte así. Al informar de una
  prueba, di dónde corre y qué no demuestra.
- Ni un dato real en el repo: ni identificadores, ni coordenadas de rutas
  reales, ni matrículas, ni correos, ni tokens, ni identificadores de un
  despliegue real.
- Las acciones de GitHub están fijadas por commit, con la versión en un
  comentario. Al actualizarlas, cambia las dos cosas.
- `main` no tiene protección de rama (GitHub no la ofrece en un repo privado
  del plan gratuito): que no se empuje directo y que la CI esté en verde
  depende hoy de quien fusiona.

## 9. Fases y estado

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Repo, CI, workflow de Pages, esquema de datos, saneadores, generador de datos sintéticos, este documento | Hecha (2026-11-09) |
| 2 | La web: tres pestañas, tarjeta, modo demo; función de recorte de trazas; cálculo de estadísticas | Pendiente |
| 3 | Login con PKCE y cliente de `/mcp` (implementa `ToolCaller`), configuración por entorno, pruebas contra un servidor falso; añadir los orígenes del servicio y del login a `connect-src` | Pendiente |
| 4 | PR en el repo del servicio (apartado 7), sin fusionar | En otro hilo |
| 5 | Revisión independiente final y resumen para el propietario | Pendiente |

Qué no ha hecho la fase 1 de los bloques posteriores: nada de interfaz, nada
de login ni de cliente de `/mcp`, nada en el repo del servicio. Leaflet no
está instalado todavía.

### Preguntas abiertas para el propietario

1. Las rutas de menos de 300 m no se cuentan como salidas. La app de MAPIT sí
   las cuenta, así que el número de salidas puede no coincidir. ¿Se queda así
   o se cuentan aunque no se listen?
2. Las cuatro cifras del Resumen se refieren al año elegido, con opción
   «Todo». ¿Es lo que se quiere?
3. El repo no tiene licencia. Al hacerlo público, sin licencia nadie puede
   reutilizar el código. ¿Se añade una?
4. El nombre lleva una marca comercial y la web usa una API no oficial. Si
   alguna vez se abre al público general, hay que revisarlo.
5. Los apartados 5 y 7 describen detalles internos del servicio (límites,
   cabeceras, reglas del token). No son secretos y el repo del servicio ya
   los documenta, pero conviene decidir si se recortan antes de hacer
   público este repo.
6. Los commits llevan el nombre real del autor (el correo es el `noreply`
   de GitHub). Será visible al hacer público el repo.
7. Al hacer público el repo, cada fusión en `main` lanzará el despliegue de
   Pages, que fallará hasta que se active Pages con origen «GitHub
   Actions». Conviene activar las dos cosas seguidas, y la protección de
   `main` en ese momento.

### Aceptación real (no la sustituye ningún test)

El propietario abre la web con su moto y coteja a mano cinco cifras con la
app de MAPIT: km del mes, salidas del mes, odómetro, batería y la ruta más
larga del año. Antes de eso, la primera prueba real es un solo login y un
solo `get_vehicle_status` desde el navegador contra el entorno de pruebas del
servicio, usando la dirección de retorno de `localhost`.
