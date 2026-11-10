# Plan y relevo entre fases

Este documento es el punto de partida de cualquier hilo que trabaje en el
repo. Dice qué se construye, qué está decidido, qué se ha comprobado y qué no,
y cómo se reparte el trabajo. Actualízalo al cerrar cada fase.

Última actualización: 2026-11-10, cierre de la fase 2.

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
| Rutas de menos de 300 m | Se excluyen de todo (lista, mapa y cifras) y se dice cuántas son en una nota. Es la respuesta del organizador para la fase 2; el propietario puede cambiarla (apartado 9). Cambiarla es una línea: `SHORT_ROUTES_COUNT_IN_FIGURES` en `src/config.ts` (y su test en `tests/units.test.ts`). |
| Periodo del Resumen | Las cifras son del año elegido, por defecto el actual, con opción «Todo». Respuesta del organizador para la fase 2; se cambia con `SUMMARY_DEFAULT_PERIOD` en `src/config.ts`. |
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

Concretado al construirlo en la fase 2 (`src/domain/stats.ts`):

- Siguen al selector de periodo las cuatro cifras, los hábitos, los récords,
  los trayectos cortos y la tarjeta. No lo siguen el estado, la comparación
  del mes, los km por mes (tres últimos años con rutas), las rachas (todo el
  historial) ni el mantenimiento. Cada bloque dice en pantalla qué periodo
  enseña.
- Rachas: hoy no ha terminado, así que una racha de días saliendo que llegó
  hasta ayer sigue viva, y hoy no cuenta como día parado hasta que acabe.
  «Días parada» son días completos sin ninguna salida.
- En un empate (dos rutas, días, meses o rachas con la misma cifra) gana lo
  más antiguo.
- Los números separan siempre los miles («6.125 km»).
- La velocidad media es la del servicio y se rotula «km/h»; el servicio no
  confirma sus unidades, igual que no confirma los km (pregunta abierta 8).

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
  por fecha o por distancia. Cada palabra de la búsqueda tiene que cuadrar:
  un número suelto es el día o el año enteros («2» es el día 2, no el
  principio de 2025); una fecha con barras o guiones se compara como
  números («7/3», «07/03/2026», «2026-03»); lo demás es el principio del
  día de la semana o del mes, sin acentos («sab», «mar»). Las palabras de
  relleno («de», «del», «el», «día») no cuentan, y un separador al final de
  una palabra se ignora, para que la lista no se vacíe mientras se escribe
  una fecha («7/»).
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
| Recortar 400 m al inicio y al final de cada traza antes de dibujarla | `TRIM_METERS` en `src/domain/privacy.ts` y `trimTrace` en `src/domain/trim.ts` (fase 2). Se cumple con una regla más fuerte: **no se dibuja nada a menos de 401 m en línea recta del inicio ni del final** (ver «Cómo quedó el recorte»). El radio no es un parámetro: nadie puede pedir un corte más corto. La pestaña Mapa solo guarda en memoria las líneas ya recortadas. El saneador devuelve un `UntrimmedTrace` sellado, sin campos legibles; sus líneas solo salen con `untrimmedLines` y los dos puntos de inicio y final con `sensitivePlaces`, y ESLint solo deja importar esas dos funciones desde ese archivo (`tests/lint-seals.test.ts`). |
| Ocultar rutas de menos de 300 m | `hideShortRoutes` en `src/domain/privacy.ts`. |
| Token solo en memoria | Ver «Almacenamiento» en el apartado 2. ESLint prohíbe `localStorage` y `sessionStorage` en todo el código, con una sola excepción, abierta en la fase 2: **`src/storage/maintenance.ts` puede usar `localStorage`** (y solo `localStorage`) para guardar los dos números del mantenimiento que escribe el usuario, con una clave para la cuenta y otra para la demo. `tests/units.test.ts` comprueba que la excepción vale para ese archivo y para ningún otro, y que `sessionStorage` sigue prohibido también ahí. La fase 3 necesitará otra excepción, para `sessionStorage`, en el archivo del login. |
| Sin analítica ni terceros, salvo las teselas de OpenStreetMap | Política de seguridad de contenido en `csp.config.json`. `scripts/check-dist.mjs` rompe el build si la página que genera Vite no lleva exactamente esa política, o si detecta código en línea o recursos de otro origen; `tests/csp.test.ts` fija su texto. Es una red contra errores propios hecha con expresiones regulares, no un analizador de HTML: no protege contra quien edite `dist/` a mano, y no tiene tests propios. |
| Los datos viven solo en el navegador y solo durante la sesión | Nada se guarda salvo los dos números de mantenimiento. |

Lo que se vio en una lectura real, que el recorte tiene en cuenta:

- El GeoJSON de un detalle trae, además de las líneas, **dos puntos sueltos
  con el inicio y el final exactos**. Nunca se dibujan. El saneador los
  aparta de las líneas y los guarda sellados para un solo uso: que el
  recorte esconda lo que pase cerca de ellos.
- Las coordenadas vienen como `[longitud, latitud, 0]`. El saneador entrega
  `[latitud, longitud]`, que es el orden de Leaflet.
- Los puntos de una traza están muy separados (decenas para una ruta de 15
  km, con tramos de más de 400 m). El corte tiene que caer **dentro del
  tramo**, con un punto nuevo; quitar los primeros N puntos no basta ni es
  correcto.
- El servicio puede haber recortado ya el final de algunas trazas; nuestro
  recorte se aplica igualmente.
- El saneador solo conserva geometrías `LineString`, las únicas vistas. Si
  el servicio enviara otro tipo de línea, se ignoraría sin aviso.

Cómo quedó el recorte (fase 2):

- La primera versión cortaba solo por distancia recorrida. La revisión
  independiente enseñó que no bastaba: una ruta que vuelve a pasar por su
  punto de salida (una ida y vuelta, por ejemplo) dibujaba ese punto exacto,
  y si el servicio enviara las líneas desordenadas se cortarían los extremos
  equivocados.
- La regla actual es **por lugar**: no se dibuja nada a menos de
  `HIDE_RADIUS_METERS` (401 m: los 400 de la regla más 1 de margen por medir
  sobre un plano) en línea recta de ninguno de estos puntos: el primero y el
  último de las líneas, y los dos puntos sueltos de inicio y final que trae
  el detalle. Esos dos puntos ya no se tiran en el saneador: se guardan
  sellados y solo el recorte los lee, para esconder lo que pase cerca.
  Siguen sin dibujarse.
- Esa regla contiene a la anterior (un punto a menos de 400 m por carretera
  está a menos de 400 m en línea recta), así que el corte por distancia se
  quitó por redundante. Con los dos puntos sueltos, una traza de 800 m o
  menos se queda siempre sin nada.
- Una ruta puede quedar partida en varios trozos (una ida y vuelta queda en
  dos), y una ruta larga que no sale de los alrededores de su inicio queda
  oculta entera.
- No depende del orden ni del sentido en que lleguen las líneas, siempre que
  el detalle traiga los dos puntos sueltos. Si no los trae, no se puede
  saber qué extremo es el inicio: entonces se esconden los alrededores de
  los dos extremos de **todas** las líneas, al precio de un hueco donde se
  juntan dos. No se ha visto ningún detalle sin esos puntos, pero solo se ha
  visto uno.
- La cuenta se hace sobre la proyección del mapa (Web Mercator), porque ahí
  es donde el mapa une dos puntos con una recta. La primera versión medía la
  recta en grados de latitud y longitud, que en un tramo de decenas de km se
  separa de la dibujada más que el metro de margen (un tramo de 100 km
  habría pasado a 344 m). Lo encontró la segunda comprobación independiente.
- Un lugar junto al borde del mapa del mundo (longitud ±180°) se esconde
  también de un tramo dibujado al otro lado de ese borde.
- Por encima de unos 85° de latitud la proyección no existe: una traza o una
  marca que llegue allí no se dibuja. No hay carreteras allí.
- Dos puntos seguidos a menos de un milímetro en el mapa cuentan como uno
  solo. Un tramo así no se puede medir, y la tercera comprobación
  independiente enseñó que se dibujaba entero, con el inicio dentro.
- Lo que no evita: quien conozca la zona puede deducir hacia dónde apunta un
  trazo que empieza a 400 m de una casa. Y el recuadro del mapa, que se pide
  a OpenStreetMap, suele contener el inicio y el final recortados.
- Si no queda nada, la web dice «traza oculta por privacidad»; si el servicio
  no envió ninguna línea, dice que no hay recorrido. Son mensajes distintos.
- Los sellos son reglas de ESLint sobre los `import`. Están cerradas las
  vías conocidas para saltárselas (`import()` dinámico e `import.meta.glob`,
  con test), pero siguen siendo una red, no una prueba.

Leaflet y la política de seguridad de contenido (visto en un navegador):
Leaflet cancela una tesela que aún está cargando apuntándola a una imagen
`data:`, que la política no admite, y el navegador escribía un error por cada
una. En lugar de admitir `data:` en `img-src`, `src/ui/leafletSurface.ts`
sustituye tres métodos privados de la capa de teselas de Leaflet 1.9
(`_abortLoading`, `_removeTile`, `_tileReady`) para cancelar quitando la
dirección. Hay que revisarlo al actualizar Leaflet. `tests/map.test.ts` los
prueba llamándolos sobre una capa de mentira: comprueba lo que hacen, no que
el navegador cancele de verdad la petición.

Otros dos detalles del mapa: la atribución de OpenStreetMap es un control
propio hecho con nodos, porque el de Leaflet recibe una cadena HTML; y si el
recorrido llega con la pestaña Mapa oculta (pasa a menudo cuando el servicio
tarda), el encuadre se aplaza hasta que la pestaña se enseña, porque un mapa
sin tamaño no se puede encuadrar. Leaflet sigue usando `innerHTML` por dentro
para sus propios botones; es código de la dependencia, con textos fijos.

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

Cómo quedó en la fase 2 (`src/service/loader.ts`):

- Los semestres son naturales **en UTC** y los límites se envían como
  instantes ISO con `Z`. El semestre en curso se pide hasta su final, que
  está en el futuro: por lectura del código del servicio no hay regla que lo
  impida, pero no se ha probado en real.
- Regla de parada: el año en curso no cuenta (puede no tener aún ninguna
  salida); se para en el primer año natural **pasado** sin rutas. Límite duro
  de 30 años. Consecuencia conocida y fijada por un test: quien haya pasado
  un año natural entero sin salir pierde el historial anterior.
- Una respuesta cortada se descarta entera y el periodo se vuelve a pedir en
  dos mitades. Si partir no acaba nunca, error `too_many_routes`.
- Una ruta que llegue en dos respuestas se cuenta una vez (la comparación de
  identificadores ocurre dentro del cargador y no sale de él).
- `LoadError` lleva el paso (`status`, `details`, `routes`, `detail`), un
  tipo cerrado (`tool_error`, `unexpected_shape`, `too_many_routes`,
  `cancelled`, `unknown`) y un detalle que se puede enseñar: el código del
  servicio si tiene forma de código, la ruta del campo, o el nombre de la
  clase de una excepción desconocida. Nunca un mensaje. En pantalla se ve
  como `routes/tool_error (period_too_large)`. El filtro del detalle mira la
  forma (minúsculas, cifras y guion bajo; o un nombre de clase), no el
  significado: quien lance el error no debe meter datos ahí.
- Fallar el estado detiene la carga. Fallar los datos del vehículo solo deja
  un aviso: la web funciona sin modelo ni kilometraje de respaldo.
- Una carga sustituida por otra (cambio de escenario, salir de la demo) deja
  de pedir al servicio antes de su siguiente petición, no solo de dibujar:
  `loadAllRoutes` recibe una función `stillWanted`. La petición que ya está
  en vuelo no se cancela.
- Un reloj del navegador atrasado deja fuera, sin aviso, las rutas
  posteriores a la fecha que el reloj cree; un reloj que no es un número da
  error.

### Para la fase 3

- La puerta es `App.load(caller, { demo: false })` en `src/ui/app.ts`: tras
  el login se construye un `ToolCaller` y se llama. El resto (carga,
  pestañas, mapa, errores) no cambia. Hoy `src/main.ts` no guarda el objeto
  que devuelve `startApp`: la fase 3 tiene que guardarlo para poder llamar a
  `load`. Esa llamada esconde el aviso de demo y quita `#demo` de la
  dirección.
- Cerrar sesión o cambiar de cuenta a mitad de una carga: llamar a
  `showLanding()` o a otro `load` basta para que la carga anterior deje de
  pedir (con el `ToolCaller` antiguo) antes de su siguiente petición.
  `App.dispose()` deja además de escuchar la barra de direcciones; hace
  falta si alguna vez hubiera dos aplicaciones en la misma página.
- `load(caller, { demo: true })` llamado a mano, sin pasar por `startDemo`,
  enseñaría datos de demo sin el aviso de demo. Nadie lo hace hoy; la fase 3
  solo debe llamar a `load` con `demo: false`.
- El cliente de `/mcp` debe lanzar `ToolCallError` con el código del servicio
  cuando la herramienta responda con error. Para lo que solo él puede ver
  (configuración ausente, `state` que no coincide, canje del código, red o
  CORS, 401, 403) hay que **ampliar `FailureKind`** en el cargador y los
  textos de `src/ui/errors.ts`; hoy una excepción que el cargador no conoce
  sale como `unknown` con el nombre de su clase, sin mensaje. La forma más
  simple: que el cliente lance una clase propia con un `kind`, y que
  `toLoadError` la reconozca.
- Un 401 a mitad de sesión (el token dura 60 minutos) aparece hoy como un
  error con botón «Reintentar», que repetiría la misma llamada con el mismo
  token. La fase 3 decide qué hacer: lo natural es volver al login.
- La pantalla de entrada (`showLanding`) dice que el acceso con cuenta no
  está disponible y solo ofrece la demo: ahí va el botón de entrar. El
  fragmento `#demo` está reservado para la demo; la vuelta del login llega
  en la cadena de consulta (`?code=...&state=...`), que la web debe quitar
  de la barra de direcciones en cuanto la lea. Con una cuenta real en
  pantalla, escribir `#demo` en la dirección no hace nada (no sustituye la
  vista por la demo); en la pantalla de entrada o en la demo, sí la abre o
  la cambia, y quitar el fragmento estando en la demo vuelve a la entrada.
- `sessionStorage` sigue prohibido por ESLint en todo el código. El archivo
  del login necesita su propia excepción, como la de
  `src/storage/maintenance.ts`, con su test en `tests/units.test.ts`.
- `connect-src` hoy es `'self'`: hay que añadir el origen de `/mcp` y el del
  login en `csp.config.json`, en `tests/csp.test.ts` y con el motivo aquí.
  Si los orígenes dependen del entorno, la política también.
- Las claves de mantenimiento en `localStorage` son por navegador, no por
  cuenta: dos personas que usen el mismo navegador comparten los números.
- La web pide el historial completo en cada carga (unas 8 peticiones para
  tres años; más si un semestre pasa de 500 rutas). No hay caché entre
  recargas, a propósito.

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
que se cuele en UTC dé un resultado distinto del esperado.

Para ver el modo demo en local: `npm ci`, `npm run dev` y abrir
`http://localhost:5173/honda-ride-log/#demo`. Los otros escenarios son
`#demo=heavy` (más rutas por semestre de las que el servicio entrega de una
vez), `#demo=empty` (cuenta sin rutas) y `#demo=error` (fallo del servicio);
también se eligen en el desplegable del aviso de demo. Para verlo con la
política de seguridad de contenido, tal como se publicará: `npm run build`,
`npm run preview` y `http://localhost:4173/honda-ride-log/#demo`.

| Ruta | Qué hay |
|---|---|
| `src/service/contract.ts` | Formas sin sanear y límites de las cuatro herramientas; `ToolCaller`; `ToolCallError`. |
| `src/service/loader.ts` | La carga por `ToolCaller` (estado, vehículo, historial por semestres, detalle de una ruta) y `LoadError`. |
| `src/domain/model.ts` | Lo que el resto de la web puede tener en memoria. |
| `src/domain/sanitize.ts` | El único módulo que lee respuestas sin sanear. |
| `src/domain/privacy.ts` | Umbrales de privacidad y la regla de rutas cortas. |
| `src/domain/trim.ts` | El recorte de 400 m; el único módulo que abre una traza sin recortar. |
| `src/domain/stats.ts`, `format.ts`, `csv.ts`, `maintenance.ts` | Cifras del Resumen, textos en español y búsqueda por fecha, exportación CSV, cálculo de la revisión. |
| `src/config.ts` | Las dos respuestas de producto que el propietario aún puede cambiar. |
| `src/storage/maintenance.ts` | El único archivo que usa `localStorage`. |
| `src/ui/` | La página: `app.ts` (entrada, demo, carga y estados), `summary.ts`, `routesView.ts`, `mapView.ts` y `leafletSurface.ts` (el mapa), `charts.ts`, `card.ts`, `tabs.ts`, `dom.ts`. |
| `src/demo/` | Generador de datos sintéticos con semilla, servicio de demo en memoria y los escenarios de la demo. |
| `tests/` | Tests. Los de interfaz (`app`, `map`, `charts`) corren en jsdom, que no es un navegador: sin maquetación, sin canvas, sin política de seguridad de contenido. |
| `csp.config.json` | La política de seguridad de contenido y la de referencia. |
| `vite.config.ts` | Build, ruta base de Pages e inyección de la política. |
| `scripts/check-dist.mjs` | Comprobaciones de publicación sobre `dist/index.html`. |
| `.github/workflows/` | `ci.yml` y `pages.yml` (no hace nada mientras el repo sea privado). |

Reglas:

- El texto para el usuario va en español; el código, los comentarios y los
  commits, en inglés.
- Sin `innerHTML`, sin código ni estilos en línea, sin dependencias de
  ejecución nuevas sin motivo escrito aquí. La única dependencia de
  ejecución es Leaflet 1.9.4; `jsdom` y `@types/leaflet` son de desarrollo.
- Al escribir archivos con una herramienta de agente, un carácter invisible
  puede colarse donde se quería su secuencia de escape (pasó con la marca de
  orden de bytes del CSV): constrúyelo con `String.fromCharCode`.
- Cada test nuevo se ve fallar una vez con un dato roto antes de contar. En
  la fase 1 se hizo rompiendo el código de 56 maneras, una cada vez, más 32
  que probó por su cuenta el revisor; las que sobrevivieron se cubrieron
  después con tests nuevos. En la fase 2 fueron unas 480 del autor y 291 de
  los tres revisores (dos revisiones y una segunda comprobación de las
  correcciones). De las que sobrevivieron se cubrieron con tests nuevos las
  que cambian algo que importa; quedan sin test algunas menores, anotadas en
  el informe de cierre (por ejemplo, que `invalidateSize` de Leaflet se
  llame, o el nivel del título «Notas»).
- **Antes de fiarse de un ejecutor de roturas, comprobar que la suite pasa
  sin romper nada cuando se lanza como él la lanza.** En la fase 2 el primer
  ejecutor arrancaba Vitest de un modo que no aplicaba la zona horaria de
  los tests: dos tests fallaban siempre y toda rotura parecía «detectada».
  Lo destapó el revisor, al que le sobrevivieron 91 de 97. El ejecutor
  corregido se niega a empezar si la suite no está en verde.
- Un test en verde contra el servicio de demo prueba el contrato tal como lo
  leímos, no que el servicio real se comporte así. Al informar de una
  prueba, di dónde corre y qué no demuestra.
- Ni un dato real en el repo: ni identificadores, ni coordenadas de rutas
  reales, ni matrículas, ni correos, ni tokens, ni identificadores de un
  despliegue real.
- Las acciones de GitHub están fijadas por commit, con la versión en un
  comentario. Dependabot propone las actualizaciones una vez al mes.
- Las reglas de ESLint que vigilan el almacenamiento, el HTML y los sellos
  de privacidad cubren las formas habituales, no todas (por ejemplo, no ven
  `document.cookie`, `indexedDB` ni un nombre de atributo en una variable).
  Son una red, no una prueba: la revisión de cada PR sigue haciendo falta.
- `main` no tiene protección de rama (GitHub no la ofrece en un repo privado
  del plan gratuito): que no se empuje directo y que la CI esté en verde
  depende hoy de quien fusiona.

## 9. Fases y estado

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Repo, CI, workflow de Pages, esquema de datos, saneadores, generador de datos sintéticos, este documento | Hecha (2026-11-09) |
| 2 | La web: tres pestañas, tarjeta, modo demo; función de recorte de trazas; cálculo de estadísticas | Hecha (2026-11-10), sobre datos sintéticos |
| 3 | Login con PKCE y cliente de `/mcp` (implementa `ToolCaller`), configuración por entorno, pruebas contra un servidor falso; añadir los orígenes del servicio y del login a `connect-src` | Pendiente |
| 4 | PR en el repo del servicio (apartado 7), sin fusionar | En otro hilo |
| 5 | Revisión independiente final y resumen para el propietario | Pendiente |

Qué no ha hecho la fase 2 de los bloques posteriores: nada de login ni de
cliente de `/mcp`, ningún archivo de configuración por entorno, nada en el
repo del servicio. La web solo funciona en modo demo.

### Qué se ha comprobado de la fase 2 y dónde

- **Tests** (Vitest, en local con Windows y Node 24 y en la CI con Ubuntu y
  Node 22): corren en memoria contra el servicio de demo. Prueban la
  aritmética y el contrato tal como se leyó; no prueban nada del servicio
  real, y los de interfaz corren en jsdom, que no es un navegador.
- **Navegador de verdad** (Chromium, la página construida y servida en local
  con `vite preview`, con la política de seguridad de contenido puesta):
  las tres pestañas, el mapa con sus teselas de OpenStreetMap y su
  atribución, los tramos inferidos en punteado, la tarjeta dibujada y
  descargada como PNG, el CSV descargado, el mantenimiento guardado en
  `localStorage`, el ancho de un móvil (390 px, sin desbordes) y el tema
  oscuro. Ninguna infracción de la política después de corregir la de las
  teselas canceladas (apartado 4). Tras las correcciones de la revisión se
  volvió a mirar: un recorrido que llega con la pestaña Mapa oculta queda
  encuadrado al volver, el foco se queda en el selector al cambiar de
  escenario, cambiar `#demo=...` en la dirección cambia el escenario y los
  botones de zoom miden 44 px.
- **Sin comprobar**: todo lo que dependa del servicio real o de un login;
  otros navegadores (Firefox, Safari) y un móvil físico; un lector de
  pantalla; el contraste medido con una herramienta (se eligió a ojo y por
  cálculo de un par de colores); el mensaje «traza oculta por privacidad» en
  el navegador (la demo no tiene rutas de entre 300 y 800 m; lo cubren los
  tests); la página servida desde GitHub Pages.

### Antes de planificar: repaso de la fase 2

La política del propietario pide repasar al cerrar cada punto de su lista
«Antes de planificar». Los que aplican a una fase sin servicio real:

| Punto | Qué se hizo |
|---|---|
| Lo primero que se mide es lo que recibe el usuario | Se abrió la web en un navegador y se miraron las tres pestañas. Las cinco cifras cotejadas a mano contra la app siguen pendientes: necesitan la fase 3 y al propietario. |
| Comprobar cada suposición sobre el proveedor | No aplica en esta fase (prohibido llamar al servicio). Las suposiciones nuevas están escritas como tales: `to_time` en el futuro, orden de las rutas, unidades de la velocidad. |
| Datos realistas antes de los fixtures | El generador de la fase 1 ya reproduce lo visto en real (puntos muy separados, tramos inferidos, rutas de metros). Falta en la demo una ruta de entre 300 y 800 m. |
| La puerta se prueba antes de confiar en ella | Cada test nuevo se vio fallar rompiendo el código una línea cada vez. **Aquí hubo un fallo de proceso**: el primer ejecutor de roturas daba todo por detectado sin estarlo (apartado 8). Se corrigió, se repitieron todas las pasadas y se añadieron los tests que faltaban. |
| Un caso de punta a punta antes de treinta | El modo demo recorre el mismo código que recorrerán los datos reales, de la llamada a la pantalla. |
| Decidir dónde se prueba | Tests en memoria y navegador en local; lo real, en la fase 3 contra el entorno de pruebas del servicio. |
| Qué es suficiente | El alcance de la fase, verde en CI, revisión independiente y navegador sin errores de la política. |

No aplican: presupuesto de exploración, evaluaciones con modelo, registro de
fallos de ejecuciones reales y despliegue (no hay nada desplegado).

### Preguntas abiertas para el propietario

1. Las rutas de menos de 300 m no se cuentan como salidas. La app de MAPIT sí
   las cuenta, así que el número de salidas puede no coincidir. ¿Se queda así
   o se cuentan aunque no se listen? (El organizador contestó «se queda así»
   para la fase 2; cambiarlo es una línea en `src/config.ts`.)
2. Las cuatro cifras del Resumen se refieren al año elegido, con opción
   «Todo». ¿Es lo que se quiere? (Misma situación: contestada por el
   organizador, una línea en `src/config.ts`.)
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
8. La velocidad media de cada ruta se enseña tal como la da el servicio y
   rotulada «km/h». El servicio no confirma esa unidad. ¿Se deja, se quita
   el rótulo o se calcula a partir de los km y la duración?
9. Además de las cuatro cifras, siguen al selector de periodo los hábitos,
   los récords, los trayectos cortos y la tarjeta; las rachas y los km por
   mes no. ¿Es lo que se quiere?
10. Quien pase un año natural entero sin salir pierde en la web el historial
    anterior (regla de parada de la carga). ¿Se acepta, o se sigue mirando
    hacia atrás algún año más?
11. El mapa enseña la ruta elegida en Rutas y dos botones para pasar a la
    anterior y a la siguiente. No hay selector propio en la pestaña Mapa.
12. Hay cuatro PR de Dependabot abiertas (actualizaciones de las acciones de
    GitHub). Ningún agente las ha tocado.
13. El recorte del mapa es ahora por cercanía (nada a menos de 401 m en línea
    recta del inicio o del final), más estricto que «los primeros y últimos
    400 m». Una ida y vuelta queda partida en dos trozos y una vuelta corta
    por el barrio no se dibuja. ¿Es lo que se quiere?
14. «Exportar CSV» exporta todas las rutas que cumplen la búsqueda, en el
    orden elegido, no solo las 100 filas dibujadas.
15. En un móvil la tabla de Rutas es más ancha que la pantalla y hay que
    desplazarla de lado para ver la velocidad.
16. Los años del gráfico de km por mes se distinguen por color y posición;
    la leyenda, la tabla y el texto al pasar el ratón dan lo mismo sin color.
    El contraste entre los tres colores es bajo. ¿Basta, o se añade trama?

### Aceptación real (no la sustituye ningún test)

El propietario abre la web con su moto y coteja a mano cinco cifras con la
app de MAPIT: km del mes, salidas del mes, odómetro, batería y la ruta más
larga del año. Antes de eso, la primera prueba real es un solo login y un
solo `get_vehicle_status` desde el navegador contra el entorno de pruebas del
servicio, usando la dirección de retorno de `localhost`.
