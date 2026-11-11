# Plan

Este documento explica a quien lea el código qué se construye, qué está
decidido, qué reglas de privacidad y de datos se cumplen y qué se ha
comprobado y qué no.

Última actualización: 2026-11-11.

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

## 2. Decisiones tomadas

Los números D- que aparecen en este documento son identificadores locales de
las decisiones anotadas aquí.

| Tema | Decisión |
|---|---|
| Forma | Web estática en un repo propio y público, publicada en GitHub Pages. |
| Alcance | Una sola página que se desplaza, con secciones numeradas (Resumen, Ritmo, Hábitos, Rutas con el mapa y la lista, Atlas, Taller) bajo una barra fija; la primera versión tenía tres pestañas (Resumen, Mapa, Rutas). Tarjeta para compartir solo con cifras, modo demo sin login. |
| Fuera | Sección de territorio, filtros de «geometría inferida», exportación JSON. (Las fuentes incrustadas estuvieron fuera hasta D-025: ver «Aspecto». El atlas 3D estuvo fuera hasta el apartado 15.) |
| Velocidad máxima | Se enseña en cada ruta (lista, mapa y CSV), nunca en la tarjeta para compartir, porque la tarjeta sale de la web. Desde el 2026-11-10; antes estaba fuera en cualquier parte. |
| Aspecto | Solo tema oscuro (D-026). Fuentes propias servidas por la web, Barlow Condensed y Manrope (D-025). Movimiento sin librería, con unas duraciones fijas (D-027). Detalle en el apartado 11. |
| Privacidad | Ver el apartado 4. Son requisitos. |
| Unidades | «km» a secas, con nota al pie: se usan los campos `*_km` del servicio, que el propio servicio marca como conversión sin confirmar. Nunca se convierte la distancia nativa. |
| Zona horaria | Una sola: la del navegador. El campo `timezone` de cada ruta no se usa. |
| Pila | Vite y TypeScript estricto, sin framework. Leaflet como única dependencia de ejecución. Gráficos en SVG a mano. Vitest y ESLint. |
| Rutas de menos de 300 m | Se excluyen de todo (lista, mapa y cifras) y se dice cuántas son en una nota. Cambiarlo es una línea: `SHORT_ROUTES_COUNT_IN_FIGURES` en `src/config.ts` (y su test en `tests/units.test.ts`). |
| Periodo del Resumen | Las cifras son del año elegido, por defecto el actual, con opción «Todo». Se cambia con `SUMMARY_DEFAULT_PERIOD` en `src/config.ts`. |
| Almacenamiento | El token de acceso vive en una variable y nada más. El verificador de PKCE y el `state` van a `sessionStorage` solo durante la ida y vuelta al login y se borran al volver. El token de renovación se descarta. En `localStorage` solo va lo que el usuario escribe para el mantenimiento. |
| Llamadas | Sin sesión MCP: una petición por herramienta, en serie (como mucho de 2 en 2). |
| Proceso | PR pequeñas contra `main`, CI en verde y revisión independiente antes de fusionar. |

## 3. Diseño de las tres pestañas

Las tres pestañas de la primera versión son hoy secciones de una sola página
(apartado 12): lo que aquí se llama «Resumen» se reparte entre el héroe y las
secciones 01 Resumen, 02 Ritmo, 03 Hábitos y 06 Taller; «Mapa» y «Rutas»
viven juntas en la sección 04 Rutas, y 05 Atlas va aparte (apartado 15). Las
definiciones de este apartado no cambian.

Todo se calcula en el navegador a partir de la lista de rutas ya saneada
(`Route[]` de `src/domain/model.ts`) y del estado del vehículo. No se usan las
herramientas de estadísticas del servicio.

Definiciones comunes: «salida» es una ruta visible (300 m o más). El día, el
mes, el día de la semana y la hora de una ruta son los de su instante de
inicio en la zona horaria del navegador. La semana empieza en lunes.

Concretado en `src/domain/stats.ts`:

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
- Las velocidades media y máxima son las del servicio (`average_speed` y
  `maximum_speed`) y se rotulan «km/h»; el servicio no confirma sus unidades,
  igual que no confirma los km (apartado 9). Una velocidad máxima
  negativa, no numérica o que no llegue se enseña como «—» sin perder la
  ruta; la media, como antes, rompe la respuesta entera si no es un número.

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

Vistas de estas mismas cifras (ninguna definición nueva):

- **Calendario de actividad** (03 Hábitos, sigue al periodo): km por día
  local, el día de inicio de cada ruta en la zona del navegador, con las
  mismas rutas que cuentan en las cifras (`data.figures`). Una cuadrícula
  por año del periodo (con «Todo», del año de la primera ruta al actual,
  vacíos incluidos), semanas en columnas y el lunes arriba; el año en curso
  llega hasta hoy. Cinco niveles: 0 sin salida, y 1 a 4 por cuartiles (rango
  más cercano) de los km de los días con salida de todo el periodo; un día
  con una salida de 0 km es nivel 1, nunca 0. Pie: «N días con al menos una
  salida». Tabla alternativa por mes: días con salida y km.
  `activityCalendar` en `src/domain/stats.ts`.
- **Frases bajo días y horas**: la hora y el día con más salidas, de los
  mismos conteos del gráfico («Tu hora favorita: 8:00–8:59 · 79 salidas.»,
  «El jueves lidera con 78 salidas.»). En un empate se nombran todos; sin
  salidas, «Sin salidas en este periodo.» (`src/ui/insights.ts`).
- **En números** (sustituye al bloque «Trayectos cortos»): salida media
  (km del periodo entre sus salidas, las dos cifras de 01 Resumen) y las dos
  partes de los trayectos cortos, en cifras grandes.
- **Mes frente a mes** enseña la diferencia en km con signo en grande; sigue
  siendo este mes frente al mismo mes del año anterior, en km.

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
- Si tras el recorte no queda traza, se dice «traza oculta por privacidad»;
  si el servicio no envió ninguna línea, «sin recorrido». Son mensajes
  distintos, cada uno con su estado vacío dentro del recuadro del mapa.
- Convive con la lista en la sección «04 Rutas» (apartado 13): al elegir una
  ruta, el mapa vuela a sus líneas recortadas y la traza se dibuja sola de
  principio a fin; con movimiento reducido, salta y aparece entera.

### Rutas

- Lista con toda la información útil de cada ruta (desde el 2026-11-10):
  fecha, hora de salida, hora de llegada, duración, km,
  velocidad media, velocidad máxima y si tiene tramos inferidos («Sí», «No»
  o «—»; es una etiqueta descriptiva del servicio, no una garantía de
  precisión del GPS). Un dato que el servicio no envía se escribe «—». Si la
  llegada cae en otro día local, se añade «(+1 día)». Una nota bajo la lista
  dice que las dos velocidades tienen unidades sin confirmar. El mapa enseña
  lo mismo de la ruta abierta, en cifras grandes bajo el recuadro.
- Búsqueda por texto sobre la fecha (día, mes, año, día de la semana) y orden
  por fecha, por distancia o por velocidad máxima (de mayor a menor; en un
  empate, la más antigua primero; las que no la tienen, al final). Cada
  palabra de la búsqueda tiene que cuadrar:
  un número suelto es el día o el año enteros («2» es el día 2, no el
  principio de 2025); una fecha con barras o guiones se compara como
  números («7/3», «07/03/2026», «2026-03»); lo demás es el principio del
  día de la semana o del mes, sin acentos («sab», «mar»). Las palabras de
  relleno («de», «del», «el», «día») no cuentan, y un separador al final de
  una palabra se ignora, para que la lista no se vacíe mientras se escribe
  una fecha («7/»).
- Al pulsar una ruta se abre en el mapa que está al lado (pantallas anchas) o
  fijo encima de la lista (estrechas); la página no se mueve y la fila elegida
  queda marcada (apartado 13).
- Exportar CSV de lo que se ve, con esas mismas columnas (un dato que falta
  es una celda vacía). Sin identificadores ni coordenadas. Las celdas que
  empiecen por `=`, `+`, `-` o `@` se protegen para que una hoja de cálculo
  no las ejecute.

### Tarjeta para compartir y modo demo

- Tarjeta «Tu 2026 en moto» (el año elegido): solo cifras (km, salidas,
  horas, ruta más larga, mes con más km). Sin mapa, sin coordenadas y sin
  velocidades (la máxima tampoco: la tarjeta sale de la web). Se dibuja
  en un `<canvas>` y se descarga como PNG, con el aspecto de la web
  (apartado 14): 2160 × 2160 px, Barlow Condensed y Manrope, marca «DATOS DE
  EJEMPLO» solo en la demo.
- Modo demo: funciona sin login con `createDemoService(generateRider(...))`
  de `src/demo/`. Recorre el mismo camino de código que los datos reales
  (mismos saneadores, mismos límites), así que sirve para separar un fallo de
  la interfaz de un fallo del servicio. Debe verse claramente que son datos
  de ejemplo.

### Accesibilidad básica

Navegación por secciones con botones (foco al título de la sección al
llegar, `aria-current` en la sección que se lee), contraste
AA (solo hay tema oscuro desde D-026; `tests/contrast.test.ts` lo comprueba
sobre los colores de la hoja de estilos), cada gráfico SVG con título y una
tabla o texto alternativo con las mismas cifras, nada que dependa solo del
color, foco visible y zonas de pulsación de 44 px como mínimo.

## 4. Privacidad

| Regla | Cómo se cumple |
|---|---|
| Nunca matrícula, bastidor, datos del concesionario ni posición actual; de cada ruta, tampoco su odómetro ni su zona horaria | `src/domain/sanitize.ts` copia una lista cerrada de campos y descarta el resto al recibir la respuesta. De una ruta copia fechas, km, velocidad media, velocidad máxima (desde el 2026-11-10; antes no se copiaba) y la etiqueta de tramos inferidos; `tests/sanitize.test.ts` fija esa lista exacta. Que ningún otro módulo lea respuestas sin sanear es una convención: ninguna herramienta lo impide. |
| Nunca identificadores de ruta en pantalla ni en exportaciones | El identificador vive detrás de un `RouteRef` opaco y sin campos; solo `serviceRouteId` lo recupera, y ESLint solo deja importar esa función desde `src/service/` (donde va la petición de detalle; `tests/lint-seals.test.ts`). Serializar una ruta no lo incluye. |
| Recortar 400 m al inicio y al final de cada traza antes de dibujarla | `TRIM_METERS` en `src/domain/privacy.ts` y `trimTrace` en `src/domain/trim.ts`. Se cumple con una regla más fuerte: **no se dibuja nada a menos de 401 m en línea recta del inicio ni del final** (ver «Cómo quedó el recorte»). El radio no es un parámetro: nadie puede pedir un corte más corto. El mapa y el atlas solo guardan en memoria las líneas ya recortadas (`src/ui/traceStore.ts`). El saneador devuelve un `UntrimmedTrace` sellado, sin campos legibles; sus líneas solo salen con `untrimmedLines` y los dos puntos de inicio y final con `sensitivePlaces`, y ESLint solo deja importar esas dos funciones desde ese archivo (`tests/lint-seals.test.ts`). |
| Ocultar rutas de menos de 300 m | `hideShortRoutes` en `src/domain/privacy.ts`. |
| Token solo en memoria | Ver «Almacenamiento» en el apartado 2. ESLint prohíbe `localStorage` y `sessionStorage` en todo el código, con dos excepciones de un único archivo cada una. **`src/storage/maintenance.ts` puede usar `localStorage`** (y solo `localStorage`) para guardar los dos números del mantenimiento que escribe el usuario, con una clave para la cuenta y otra para la demo. **`src/auth/pendingLogin.ts` puede usar `sessionStorage`** (y solo `sessionStorage`) para el login a medio hacer, y solo lo importa `src/auth/login.ts` (apartado 10). `tests/units.test.ts` y `tests/lint-storage.test.ts` comprueban que cada excepción vale para su archivo y para ningún otro, que cada uno sigue teniendo prohibido el almacenamiento del otro y que las listas de prohibiciones no se separan. |
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

Cómo quedó el recorte:

- Cortar solo por distancia recorrida no basta: una ruta que vuelve a pasar
  por su punto de salida (una ida y vuelta, por ejemplo) dibujaría ese punto
  exacto, y si el servicio enviara las líneas desordenadas se cortarían los
  extremos equivocados.
- La regla es **por lugar**: no se dibuja nada a menos de
  `HIDE_RADIUS_METERS` (401 m: los 400 de la regla más 1 de margen por medir
  sobre un plano) en línea recta de ninguno de estos puntos: el primero y el
  último de las líneas, y los dos puntos sueltos de inicio y final que trae
  el detalle. Esos dos puntos no se tiran en el saneador: se guardan
  sellados y solo el recorte los lee, para esconder lo que pase cerca.
  Siguen sin dibujarse.
- Esa regla contiene a la de distancia recorrida (un punto a menos de 400 m
  por carretera está a menos de 400 m en línea recta), así que el corte por
  distancia se quitó por redundante. Con los dos puntos sueltos, una traza de
  800 m o menos se queda siempre sin nada.
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
  es donde el mapa une dos puntos con una recta. Medir la recta en grados de
  latitud y longitud no sirve: en un tramo de decenas de km se separa de la
  dibujada más que el metro de margen (un tramo de 100 km habría pasado a
  344 m).
- Un lugar junto al borde del mapa del mundo (longitud ±180°) se esconde
  también de un tramo dibujado al otro lado de ese borde.
- Por encima de unos 85° de latitud la proyección no existe: una traza o una
  marca que llegue allí no se dibuja. No hay carreteras allí.
- Dos puntos seguidos a menos de un milímetro en el mapa cuentan como uno
  solo. Un tramo así no se puede medir, y sin esa regla se dibujaría entero,
  con el inicio dentro.
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
recorrido llega con el mapa oculto, el encuadre se aplaza hasta que el mapa
se enseña, porque un mapa sin tamaño no se puede encuadrar. Leaflet sigue
usando `innerHTML` por dentro para sus propios botones; es código de la
dependencia, con textos fijos.

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
- En ese commit, **el servicio solo aceptaba la cabecera `Origin` de su
  propio dominio**. Un navegador siempre la envía con el origen de la web,
  así que, además de CORS, el servicio tuvo que admitir ese origen (cambio
  hecho en su propio repo, apartado 7).

### Estimado, no medido

- Una lista de 500 rutas ocupa en torno a 0,7 MB (unos 620 bytes por ruta,
  enviados dos veces dentro de la respuesta MCP). Cabe en los 2 MiB, pero es
  una cuenta, no una medida.

### Hipótesis del contrato

Leídas en el código del servicio y en el SDK de MCP; `tests/fakeServer.ts`
las exige así. El login real contra el entorno de pruebas del servicio
(apartado 16) funcionó con ellas, lo que las apoya en ese entorno.

- Que el login gestionado funcione desde un navegador con un cliente nuevo.
- Que el punto de canje de tokens de Cognito (`/oauth2/token`) responda a una
  petición de un navegador desde otro origen.
- Qué exige exactamente `/mcp` a un navegador: basta una petición
  `tools/call` sin `initialize` previo, con `Content-Type: application/json`
  y `Accept: application/json, text/event-stream`; la cabecera
  `mcp-protocol-version` es opcional.
- La forma del sobre de respuesta: `result.structuredContent` con el objeto
  de la herramienta y `result.isError` en los errores, con el texto
  `código: mensaje` en `result.content[0].text`.
- Que baste con CORS más el cambio de `Origin`.

### Sin comprobar

- Que cargar el historial entero de una cuenta grande quepa en los plazos (un
  semestre por petición) y que el orden de las rutas de una lista sea
  siempre ascendente.
- Qué error devuelve `get_route_detail` para un identificador desconocido (el
  servicio de demo usa un código genérico inventado).
- El campo `geometry_trimmed_end_m` aparece en una exportación antigua pero
  no en el modelo actual del servicio; el generador lo incluye a veces y el
  saneador lo ignora.

## 6. Carga de datos

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
implementan el servicio de demo y el cliente real (`src/service/mcpClient.ts`).
La carga y la interfaz no deben saber cuál de los dos tienen delante.

Cada paso que pueda fallar necesita un código de error propio, visible en
pantalla y sin token ni datos: configuración ausente, vuelta del login
(`state` que no coincide), canje del código, red o CORS, 401, 403, error de
la herramienta, forma inesperada (`ShapeError` ya trae la ruta del campo).
La lista completa está en el apartado 10, «Errores».

Cómo está hecho (`src/service/loader.ts`):

- Los semestres son naturales **en UTC** y los límites se envían como
  instantes ISO con `Z`. El semestre en curso se pide hasta su final, que
  está en el futuro: por lectura del código del servicio no hay regla que lo
  impida.
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
- Las claves de mantenimiento en `localStorage` son por navegador, no por
  cuenta: dos personas que usen el mismo navegador comparten los números.
- La web pide el historial completo en cada carga (unas 8 peticiones para
  tres años; más si un semestre pasa de 500 rutas). No hay caché entre
  recargas, a propósito.

## 7. Configuración del servicio

Los valores de cada entorno (dirección de `/mcp`, dominio del login e
identificador del cliente web) viven en `environments.config.json`
(apartado 10).

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
`http://localhost:5173/#demo` (el servidor de desarrollo sirve en la raíz;
el build y `npm run preview`, en `/honda-ride-log/`). Los otros escenarios son
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
| `src/config.ts` | Las dos respuestas de producto que se pueden cambiar con una línea (apartado 9). |
| `src/storage/maintenance.ts` | El único archivo que usa `localStorage`. |
| `src/ui/` | La página: `app.ts` (entrada, demo, carga y estados), `summary.ts`, `routesView.ts`, `mapView.ts` y `leafletSurface.ts` (el mapa), `charts.ts`, `card.ts`, `dom.ts`; `nav.ts` (enlaces de sección, seguimiento de la lectura y barra de progreso) y `period.ts` (selector de periodo de la barra). |
| `src/ui/motion.ts`, `src/ui/sectionHeader.ts`, `src/styles.css` | Movimiento (aparecer al entrar en pantalla, cifras que cuentan, la línea de barrido de las esperas), cabecera de sección numerada y la hoja de estilos con los tokens (apartado 11). |
| `src/ui/calendar.ts`, `src/ui/insights.ts`, `src/ui/loadingStage.ts` | Calendario de actividad, frases bajo los gráficos de hábitos y pantalla de carga (apartado 14). |
| `src/ui/traceDraw.ts`, `src/ui/traceStore.ts`, `src/ui/atlas/` | La traza que se dibuja (apartado 13), el almacén de trazas recortadas que comparten el mapa y el atlas, y el atlas (apartado 15). |
| `src/assets/fonts/` | Las fuentes propias (woff2, subconjunto latino) y sus licencias SIL OFL. |
| `public/favicon.svg` | El icono de la pestaña del navegador. |
| `src/demo/` | Generador de datos sintéticos con semilla, servicio de demo en memoria y los escenarios de la demo. |
| `tests/` | Tests. Los de interfaz (`app`, `map`, `charts`) corren en jsdom, que no es un navegador: sin maquetación, sin canvas, sin política de seguridad de contenido. |
| `csp.config.json` | La política de seguridad de contenido y la de referencia. |
| `environments.config.json`, `src/auth/`, `src/service/environment.ts`, `src/service/mcpClient.ts`, `src/boot.ts` | Entornos, login, cliente de `/mcp` y su unión con la página (apartado 10). `src/config.ts` y `src/service/environment.ts` conviven: el primero guarda decisiones de producto, el segundo el servicio de cada build. |
| `vite.config.ts` | Build, ruta base de Pages e inyección de la política. |
| `scripts/check-dist.mjs` | Comprobaciones de publicación sobre `dist/index.html`. |
| `.github/workflows/` | `ci.yml` y `pages.yml` (publica `dist/` en GitHub Pages cuando cambia `main`). |

Reglas:

- El texto para el usuario va en español; el código, los comentarios y los
  commits, en inglés.
- Sin `innerHTML`, sin código ni estilos en línea, sin dependencias de
  ejecución nuevas sin motivo escrito aquí. La única dependencia de
  ejecución es Leaflet 1.9.4; `jsdom` y `@types/leaflet` son de desarrollo.
- Al escribir archivos con una herramienta automática, un carácter invisible
  puede colarse donde se quería su secuencia de escape (pasó con la marca de
  orden de bytes del CSV): constrúyelo con `String.fromCharCode`.
- Cada test nuevo se ve fallar una vez con un dato roto antes de contar.
  Quien rompa el código a propósito para comprobarlo, que lance la suite
  igual que `npm test` y la vea en verde sin romper nada antes de empezar:
  si no, una rotura puede parecer detectada sin estarlo.
- Un test en verde contra el servicio de demo prueba el contrato tal como lo
  leímos, no que el servicio real se comporte así. Al informar de una
  prueba, di dónde corre y qué no demuestra.
- Ni un dato real en el repo: ni identificadores, ni coordenadas de rutas
  reales, ni matrículas, ni correos, ni tokens. La única excepción son los
  tres valores públicos del servicio de producción en
  `environments.config.json` (apartado 10); los de cualquier otro despliegue
  no se escriben.
- Las acciones de GitHub están fijadas por commit, con la versión en un
  comentario. Dependabot propone las actualizaciones una vez al mes.
- Las reglas de ESLint que vigilan el almacenamiento, el HTML y los sellos
  de privacidad cubren las formas habituales, no todas (por ejemplo, no ven
  `document.cookie`, `indexedDB` ni un nombre de atributo en una variable).
  Son una red, no una prueba: la revisión de cada PR sigue haciendo falta.
- Nada se empuja directo a `main`: PR con la CI en verde y revisión
  independiente.

## 9. Limitaciones conocidas

Respuestas de producto y consecuencias que se aceptan tal como están. Las dos
primeras se cambian con una línea en `src/config.ts`.

1. Las rutas de menos de 300 m no se cuentan como salidas ni en las cifras.
   La app de MAPIT sí las cuenta, así que el número de salidas puede no
   coincidir (`SHORT_ROUTES_COUNT_IN_FIGURES`).
2. Las cuatro cifras del Resumen son del año elegido, con opción «Todo»
   (`SUMMARY_DEFAULT_PERIOD`). Además siguen al periodo los hábitos, los
   récords, los trayectos cortos y la tarjeta; las rachas y los km por mes
   no.
3. Las unidades de distancia y de velocidad no las confirma el servicio. Los
   km son sus campos `*_km`, y las velocidades media y máxima se enseñan tal
   como las da, rotuladas «km/h». La máxima no se puede recalcular: solo la
   da el servicio.
4. Quien pase un año natural entero sin salir pierde en la web el historial
   anterior: la carga se para en el primer año pasado sin rutas.
5. «Exportar CSV» exporta todas las rutas que cumplen la búsqueda, en el
   orden elegido, no solo las filas dibujadas.
6. El recorte es por cercanía (nada a menos de 401 m en línea recta del
   inicio o del final), más estricto que «los primeros y últimos 400 m». Una
   ida y vuelta queda partida en dos trozos y una vuelta corta por el barrio
   no se dibuja (apartado 4).
7. Los años del gráfico de km por mes se distinguen por color y posición; la
   leyenda, la tabla y el texto al pasar el ratón dan lo mismo sin color. El
   contraste entre los tres colores es bajo.
8. El acceso vive solo en la memoria de la pestaña: al recargar hay que
   volver a entrar.
9. Todas las webs de Pages de la cuenta comparten el origen (apartado 10,
   «Riesgo de origen compartido»).
10. El nombre lleva una marca comercial y la web usa una API no oficial. Si
    alguna vez se abre al público general, hay que revisarlo.

## 10. Login y cliente de `/mcp`

El login con PKCE y el cliente real de `/mcp` (un `ToolCaller`), unidos a la
página. Lo comprobado y lo no comprobado está en el apartado 16.

| Ruta | Qué hay |
|---|---|
| `environments.config.json` | Ajustes por modo de Vite: `development` (`npm run dev`), `production` (`npm run build`) y `demo` (sin servicio). |
| `src/service/environment.ts` | Valida una entrada de ese archivo; da «solo demo» o la configuración del servicio. |
| `src/auth/pkce.ts` | Verificador, reto S256 y `state`. |
| `src/auth/pendingLogin.ts` | El único archivo con `sessionStorage`. |
| `src/auth/session.ts` | El token de acceso, en una variable cerrada. |
| `src/auth/login.ts` | Ida al login, vuelta, canje del código y cierre de sesión. |
| `src/service/mcpClient.ts` | El `ToolCaller` real. |
| `src/boot.ts` | La unión con la página: vuelta del login, botones «Entrar» y «Salir», carga de la cuenta. `src/main.ts` solo lo llama. |
| `tests/fakeServer.ts` | Login y `/mcp` falsos detrás de una función `fetch`. |
| `tests/boot.test.ts`, `tests/sign-in-errors.test.ts` | La unión con la página, en jsdom contra el servidor falso, y los textos y acciones de cada error. |

### Configuración por entorno

- Cada entrada tiene `mcpUrl`, `loginDomain`, `webClientId`, `redirectUri`,
  `logoutUri` y `sendResourceIndicator`. `production` lleva los tres valores
  públicos del servicio de producción (dirección de `/mcp`, dominio del login
  e identificador del cliente web; ninguno es secreto). `development` los
  deja vacíos en el repo: los valores locales no se suben. Con las tres
  primeras vacías, el modo es solo demo, igual que un modo que no aparece en
  el archivo (por ejemplo `test` o `demo`).
- `vite.config.ts` valida la entrada del modo que construye. Si está a
  medias o mal escrita (http fuera de `localhost`, `127.0.0.1`, cadena de
  consulta, barra final en `mcpUrl`, un `*` en el dominio, un campo
  desconocido), el build falla con el nombre del campo y sin su valor.
- Direcciones de retorno: `http://localhost:5173/` en `development` y
  `https://herrerogusano.github.io/honda-ride-log/` en `production`. Deben
  coincidir carácter a carácter con las del cliente del login.
- El servidor de desarrollo sirve en la raíz (`/`), en `localhost:5173` con
  el puerto fijo; el build y `npm run preview` siguen en `/honda-ride-log/`.
  Motivo: el login devuelve al navegador a `http://localhost:5173/`
  exactamente.
- `sendResourceIndicator` añade `resource=<mcpUrl>` a la petición de
  autorización. **Sin verificar** que haga falta para que el token salga con
  el público (`aud`) correcto, ni que Cognito lo acepte junto con los
  alcances. Los tokens de acceso de Cognito normalmente no llevan `aud`, y el
  servicio lo exige (apartado 5). Por eso es un ajuste y no una constante.
- `logoutUri` vacío: cerrar sesión solo olvida el token en la web, y el
  login de Cognito sigue abierto, así que el siguiente «Entrar» puede no
  pedir contraseña. Con valor, además se manda al navegador a `/logout` del
  login; esa dirección tiene que estar registrada en el cliente.

### Política de seguridad de contenido

Motivo del cambio: el navegador necesita conectar con `/mcp` y con el punto
de canje del login (`/oauth2/token`). `csp.config.json` no cambia. Si el modo
que se construye tiene servicio configurado, `vite.config.ts` añade a
`connect-src` exactamente el origen de `mcpUrl` y el de `loginDomain`, y nada
más; sin servicio, la política es la de siempre. `scripts/check-dist.mjs
[modo]` hace la misma cuenta y compara (por defecto, `production`).
`tests/csp.test.ts` fija las dos formas. La ida al login es una navegación,
no una conexión: no la gobierna `connect-src`, y `form-action` sigue en
`'none'` porque no se usa ningún formulario.

### Almacenamiento: la excepción de ESLint

`src/auth/pendingLogin.ts` es el único archivo que puede usar
`sessionStorage`, y solo `src/auth/login.ts` puede importarlo (dos reglas en
`eslint.config.js`, comprobadas en `tests/lint-storage.test.ts`; la segunda
evita que otro módulo llegue a `sessionStorage` a través de sus funciones).
`src/auth/login.ts` tampoco lo entrega: `browserDeps()` no lleva el
almacenamiento y el flujo lo pide por su cuenta. Es una red contra errores,
no una barrera: el código que lo intente a propósito (una cadena en una
variable, `globalThis["session" + "Storage"]`) pasa la regla.
Guarda solo el verificador, el `state` y la hora, bajo una única clave. Se
borra al leerlo, salga bien o mal la vuelta, y no vale pasados 10 minutos.
`localStorage` y el HTML siguen prohibidos en ese archivo; un test compara
esa lista con la del resto del código para que no se separen.

Convive con la excepción de `localStorage` (`src/storage/maintenance.ts`).
Las listas de prohibiciones son constantes compartidas en `eslint.config.js`
(una por almacenamiento y una con los sumideros de HTML), y
`tests/lint-storage.test.ts` comprueba que cada excepción levanta solo su
almacenamiento: `localStorage` sigue prohibido en el archivo del login,
`sessionStorage` en el del mantenimiento, y ninguno de los dos puede
importar el login pendiente.

Dos pestañas que entren a la vez se pisan el login pendiente (una sola
clave): la primera en volver recibe `state_mismatch` y tiene que entrar otra
vez.

### El token

- Vive en una variable cerrada de `createSession`; no es una propiedad, así
  que registrar o serializar la sesión no lo muestra. No se guarda en ningún
  sitio.
- Se deja de usar 60 segundos antes de caducar y nunca se le da más de un
  día de vida aunque el login diga otra cosa.
- Sin renovación. Cognito devuelve también un token de renovación y uno de
  identidad en este flujo; no se puede evitar que lleguen, pero no se copian
  a ninguna parte. El de renovación no se revoca: el cliente web del
  servicio lo emite con una hora de validez, y la web lo descarta igualmente.
  Revocarlo con `/oauth2/revoke` invalidaría también el token de acceso.
- Un 401, un 403 o un fallo de red tras entrar terminan la sesión: ese token
  no se vuelve a enviar y las peticiones que esperaban en cola no salen.
  Motivo del fallo de red: si el autorizador responde 401 sin cabeceras CORS
  (**sin verificar**), el navegador lo ve como error de red.

### Las peticiones a `/mcp`

- Un `POST` por herramienta con un mensaje JSON-RPC `tools/call`, sin
  `initialize` ni sesión. Cabeceras: `Authorization`, `Content-Type:
  application/json` y `Accept: application/json, text/event-stream`. No se
  envía `MCP-Protocol-Version` (es opcional y un valor que el servicio no
  conozca se rechazaría). `credentials: "omit"`, sin cadena de consulta,
  `redirect: "error"` (no se sigue ninguna redirección), `cache: "no-store"`.
- Solo `get_vehicle_status`, `get_vehicle_details`, `list_routes` y
  `get_route_detail` (`ALLOWED_TOOLS`), comprobado también en ejecución. Los
  argumentos se copian campo a campo; uno de más o de otro tipo se rechaza
  antes de enviar.
- Como mucho 2 peticiones en vuelo y 250 ms entre el inicio de una y la
  siguiente (4 por segundo como mucho). Sin reintentos automáticos.
- La respuesta tiene que ser `application/json` (un flujo de eventos se
  rechaza), con `jsonrpc: "2.0"` y el mismo `id`. El objeto de la
  herramienta se toma de `result.structuredContent`; un `result.isError` se
  convierte en `ToolCallError` con el código del principio del texto si
  tiene forma de código (de dos a seis palabras en minúsculas unidas por
  `_`, sin cifras, para no tomar un identificador por un código), y sin el
  mensaje. Cualquier otro texto da `tool_error`.
- Plazo de 20 segundos por petición (el servicio tiene 14 por dentro).

### Errores

Ningún mensaje lleva el token, el código de autorización, una dirección,
un cuerpo de respuesta ni un mensaje del servicio. `detail` es nulo o un
código corto.

| Clase y `kind` | Cuándo | Qué dice la interfaz | Botón |
|---|---|---|---|
| `AuthError` `config_missing` | Build sin servicio | Solo está disponible la demo (no debería verse: sin servicio no hay botón de entrar) | Ninguno |
| `AuthError` `storage_unavailable` | `sessionStorage` bloqueado | El navegador no deja guardar el inicio de sesión (modo privado estricto) | Ninguno |
| `AuthError` `state_mismatch` | Vuelta sin login pendiente, caducado o con otro `state` | Vuelve a entrar | «Entrar» de la entrada |
| `AuthError` `login_failed` | El login devolvió `error=` (por ejemplo `access_denied`) | El login no ha dado acceso; vuelve a entrar | «Entrar» de la entrada |
| `AuthError` `token_exchange` | El canje respondió con error (`invalid_grant`, `http_502`...) | El login no ha entregado un acceso válido; vuelve a entrar | «Entrar» de la entrada |
| `AuthError` `token_network` | El canje no llegó (red o CORS) | No se ha podido conectar con el login | «Entrar» de la entrada |
| `ServiceError` `reauth_required` | Token caducado, 401 o red tras entrar, o cualquier llamada después de que la sesión terminara (`detail`: `expired`, `unauthorized`, `network`, `forbidden` o `signed_out`) | Tu sesión ha caducado o el servicio ya no la acepta; vuelve a entrar | «Volver a entrar», nunca «Reintentar» |
| `ServiceError` `forbidden` | 403 | Tu cuenta no tiene acceso | «Volver a entrar» (la sesión ya terminó) |
| `ServiceError` `rate_limited` | 429 | Espera un momento | «Reintentar» |
| `ServiceError` `http_status` | Otro estado HTTP (`detail`: el número) | Error del servicio | «Reintentar» |
| `ServiceError` `timeout` | Sin respuesta en 20 s | El servicio tarda demasiado | «Reintentar» |
| `ServiceError` `bad_response` | No es JSON, no es JSON-RPC, otro `id`, sin `structuredContent` | Respuesta inesperada | «Reintentar» |
| `ServiceError` `rpc_error` | Error JSON-RPC (`detail`: su código numérico) | El servicio ha rechazado la petición | «Reintentar» |
| `ServiceError` `not_allowed` | Herramienta fuera de la lista o argumentos raros | Fallo de la web (no debería verse) | Ninguno |
| `ToolCallError` | La herramienta respondió con error | Como en la demo | «Reintentar» |

En el cargador: `FailureKind` (`src/service/loader.ts`) incluye las
seis clases de `AuthError` y las ocho de `ServiceError` con sus mismos
nombres, y hay un paso, `login`, para la ida y la vuelta del login. En
pantalla se ve, por ejemplo, `login/state_mismatch` o
`status/reauth_required (unauthorized)`. El cargador vuelve a filtrar el
`detail` por su forma (un código en minúsculas o un número de hasta seis
cifras) aunque estas dos clases ya lo traigan limpio. `src/ui/errors.ts` da a
cada clase un texto y una acción (`retry`, `sign_in` o `none`); el panel de
error de la página y el del mapa solo ofrecen «Reintentar» con
`retry`. Un «Reintentar» tras un 401 repetiría la llamada con un token que el
cliente ya ha olvidado.

### Cómo se conecta con la interfaz

`src/main.ts` llama a `boot` (`src/boot.ts`) con `currentEnvironment()` y
`browserDeps`, y guarda el objeto `App` que devuelve.

1. **Sin servicio** en el modo construido: `startApp` en modo solo demo. La
   entrada dice que el acceso con cuenta no está disponible y solo ofrece la
   demo; no hay botón «Entrar» ni se ejecuta nada del login.
2. **Con servicio**: antes de arrancar la página, `completeLogin`. Si la
   dirección no es una vuelta del login, no toca nada. Si lo es, quita
   `?code` y `?state` de la barra de direcciones antes de cualquier otra
   cosa (también antes de que la página lea el fragmento) y canjea el código;
   mientras tanto la página dice «Comprobando el acceso…».
3. Con sesión: `createMcpClient(config.mcpUrl, session)` y
   `app.load(caller, { demo: false })`. La página arranca con
   `initialView: "none"`, así que un `#demo` en la dirección de vuelta ni
   siquiera empieza la demo; `load` lo borra de la dirección. Con una cuenta
   en pantalla, escribir `#demo` en la dirección no hace nada; en la entrada
   o en la demo, sí la abre o la cambia.
4. Si la vuelta falla, la entrada aparece con el panel de error encima
   (`login/...`) y su botón «Entrar».
5. **«Entrar»** (en la entrada y, como «Volver a entrar», en los paneles de
   error que piden sesión nueva): `startLogin`. Si no puede empezar (sin
   `sessionStorage`), lo dice en la entrada sin salir de la página. Si
   todavía hay una cuenta en pantalla (su sesión ya terminó), antes se
   vuelve a la entrada, para que el navegador no la restaure con sus datos
   al pulsar «Atrás».
6. **«Salir»** (arriba a la derecha, solo con una cuenta en pantalla, también
   con su error): primero `showLanding()`, que sube el número de carga (la
   carga anterior deja de pedir antes de su siguiente petición:
   `stillWanted`), suelta el mapa, borra la vista y con ella los datos;
   después `logout`, que termina la sesión (las peticiones que esperaban en la
   cola del cliente ya no salen) y borra el login pendiente. Si el build
   conoce `logoutUri`, además lleva al navegador al `/logout` del login.
   La petición que ya está en vuelo no se cancela: su respuesta llega y se
   descarta.
7. Cambiar de cuenta es salir y volver a entrar: la ida al login abandona la
   página y con ella la memoria. Un segundo `load` con otro `ToolCaller` en
   la misma página también deja de pedir con el primero (test).
8. Al soltar la vista se vacía el almacén de trazas recortadas del mapa y
   del atlas, también de las que llegan tarde.

El token no sale de `src/auth/session.ts` más que como cabecera de cada
petición: `boot` guarda el objeto de sesión (para `logout`) y el cliente lo
usa; ni la página ni la dirección lo ven (test).

`load(caller, { demo: true })` llamado a mano, sin pasar por `startDemo`,
enseñaría datos de demo sin el aviso de demo: solo se llama a `load` con
`demo: false`. `App.dispose()` deja además de escuchar la barra de
direcciones; haría falta si alguna vez hubiera dos aplicaciones en la misma
página.

### Riesgo de origen compartido en GitHub Pages

Riesgo conocido y aceptado. Todas las webs de Pages de la cuenta comparten el
origen `https://herrerogusano.github.io`. Cualquier otra web de Pages de la
cuenta, o una dependencia comprometida en ella, corre con el mismo origen.
Podría abrir `/honda-ride-log/` en una ventana o un marco, leer el `?code=` y
el verificador de `sessionStorage` antes del canje, o envolver `fetch` en esa
ventana y capturar el token. La política de seguridad no lo impide: no
gobierna el acceso entre ventanas del mismo origen, y `frame-ancestors` no
funciona en una etiqueta `<meta>`. Las demás webs de Pages de la cuenta
quedan dentro de la confianza; la salida sería publicar con un dominio
propio, con un origen aparte.

## 11. Sistema visual y movimiento

El aspecto no cambia las cifras: ni las definiciones del apartado 3, ni la
privacidad, ni el login, ni el servicio, ni el recorte. Un sistema (colores,
tipos, espacios y movimiento) aplicado a toda la web.

### Decisiones D-025 a D-027

| Decisión | Qué dice | Por qué |
|---|---|---|
| D-025 | Fuentes propias: Barlow Condensed (títulos y cifras) y Manrope (texto), servidas por esta web. | La letra estrecha y gruesa es la mitad del aspecto pedido; las fuentes del sistema no la dan (Arial Narrow no existe en todos los equipos y es mucho más fina). Servirlas desde la propia web no añade terceros. |
| D-026 | Solo tema oscuro. | El concepto es oscuro; mantener dos temas duplicaba el trabajo de contraste sin uso. |
| D-027 | Movimiento sin librería, con estas duraciones y curvas y ninguna otra: `--dur-press` 120 ms, `--dur-ui` 200 ms, `--dur-reveal` 520 ms, `--dur-hero` 800 ms, `--stagger` 60 ms, `--ease-out` y `--ease-in-out`. | Una librería sería una segunda dependencia de ejecución; lo necesario son clases, `IntersectionObserver` y `requestAnimationFrame`. |

### Política de seguridad de contenido: `font-src 'self'`

Motivo del cambio (D-025): las fuentes se cargan desde la propia web.
`font-src` pasa de `'none'` a `'self'`; nada más cambia. `tests/csp.test.ts`
y `tests/environment.test.ts` fijan el texto nuevo, y
`scripts/check-dist.mjs` comprueba además que el build lleve archivos
`.woff2` y que ninguna hoja de estilos de `dist/assets` cargue de otro
origen ni use `@import`.

### Fuentes

En `src/assets/fonts/`, copiadas de los paquetes npm
`@fontsource/barlow-condensed` 5.3.0 y `@fontsource-variable/manrope` 5.3.0
(sacadas con `npm pack` fuera del repo; no son dependencias). Solo el
subconjunto latino en `woff2`, con la licencia SIL Open Font License de cada
familia al lado (`OFL-*.txt`). Las declara `src/styles.css` con
`font-display: swap` y `url()` relativas, así que Vite les pone huella.

| Archivo | Peso |
|---|---|
| Barlow Condensed 500, 600, 700 y 800 | 21,4 + 22,3 + 22,4 + 22,5 KB |
| Manrope variable (200 a 800) | 24,8 KB |
| Total en el repo | 113,5 KB (110,8 KiB) |

El navegador solo descarga las caras que la página usa: Barlow 700 y 800 y
Manrope (unos 70 KB). La 500 y la 600 están declaradas y la página no las
usa. Los títulos grandes usan 800 (`--w-title`): se compararon 700 y 800 con
las fuentes reales y 800 se lee más pesado, que es lo buscado; las cifras,
700 (`--w-figure`).

### Cómo está hecho

- Tokens en `:root` de `src/styles.css`: colores en oklch, tipos
  (`--display`, `--text`, escala con `clamp()`), espacios y movimiento.
- `src/ui/motion.ts`: `reveal(raíz)` añade `.in` a cada `.rv` la primera vez
  que entra en pantalla, con un índice de escalonado en `--d`;
  `countUp(elemento, valor, formato)` cuenta desde 0 al entrar en pantalla.
  El texto final exacto (`format(valor)`) está siempre en el elemento; los
  dígitos que pasan van encima, con `aria-hidden`, y se quitan al acabar.
  Sin `IntersectionObserver` (jsdom) o con movimiento reducido, todo queda
  en su estado final al momento y no se pide ningún fotograma. Nada empieza
  fuera de pantalla ni con la pestaña del navegador oculta; al cambiar de
  vista, la página aborta el movimiento en curso, que queda en su estado
  final.
- `src/ui/sectionHeader.ts`: número en caja roja inclinada, etiqueta y
  título en líneas que suben al aparecer.
- El subrayado de los enlaces de sección y la píldora del periodo son cada
  uno un solo elemento que se desliza con `transform` (apartado 12). Los
  paneles aparecen con un fundido corto. Los botones se encogen al
  pulsarlos; el efecto de pasar por encima solo existe con ratón.
- `@media (prefers-reduced-motion: reduce)` quita toda transición y
  animación y deja el estado final.
- Ancho: el contenido no pasa de 1280 px (1440 px a partir de 1800 px de
  pantalla); las cuatro cifras pasan de 4 columnas a 2 (860 px o menos) y a
  1 (menos de 360 px); el gráfico de 12 meses, en un móvil, conserva un
  tamaño legible y se desplaza dentro de su propia caja; las tablas
  también. `main` recorta cualquier desbordamiento horizontal como red.
- Mapa: las teselas se oscurecen con un filtro CSS sobre su capa
  (`invert` y `hue-rotate`); las líneas y la atribución no.

## 12. Una sola página

La cuenta (o la demo) se ve en una sola página que se desplaza, bajo una
barra fija. No cambia ninguna cifra, ninguna definición del apartado 3, ni
la privacidad, el login, el servicio o el recorte.

### Estructura

| Parte | Qué lleva |
|---|---|
| Barra fija (`header.topbar`) | Marca, aviso «Demo» si es la demo, enlaces de sección, selector de periodo y «Salir» con una cuenta. Una línea fina de progreso de lectura en su borde superior. |
| Franja de demo | Bajo la barra, en el flujo de la página (se va al desplazarse; el aviso «Demo» de la barra se queda): «Modo demo: datos de ejemplo», escenario y «Salir de la demo». En un móvil, la frase larga solo la oyen los lectores de pantalla. |
| Héroe (sin número) | Modelo de la moto si se conoce, «Una moto. / Cada / trazo.», una frase con el historial entero («N salidas entre el … y el …») y la placa inclinada con el estado (batería, último uso, odómetro). La placa tiene cabeza, cuerpo y pie, y el estado puede compartirla. Cuña roja detrás, a la derecha; por debajo de 960 px, diagonal al pie del héroe. |
| 01 Resumen | «Tu año / en cifras» (sigue al periodo), el periodo que enseña y las cuatro cifras. |
| 02 Ritmo | «El pulso / de los meses»: km por mes, récords, «Mes frente a mes» (la cuarta cifra dibujada como dos barras) y rachas. |
| 03 Hábitos | «Cada salida / cuenta»: días y horas (los dos gráficos) y trayectos cortos. |
| 04 Rutas | «El archivo / de salidas»: el mapa y la lista juntos (apartado 13: lado a lado desde 1024 px, el mapa fijo encima de la lista en pantallas más estrechas). |
| 05 Atlas | «Tus rutas, / en capas» (apartado 15). |
| 06 Taller | «A punto»: mantenimiento y tarjeta para compartir. |
| Pie | Las cinco notas de siempre y las frases de privacidad. |

Una cuenta sin rutas tiene 01 Resumen (con el aviso), Rutas y Taller,
numeradas 01, 02 y 03, y no tiene selector de periodo ni atlas. Los bloques
dentro de cada sección son `h3` bajo el `h2` de la sección.

### Enlaces de sección (decisión D-028)

| Decisión | Qué dice | Por qué |
|---|---|---|
| D-028 | Los enlaces de sección son botones que desplazan la página; no escriben nada en la dirección. | El fragmento de la dirección está reservado para `#demo` y `#demo=…` (apartados 6 y 10): escribir `#ritmo` lo pisaría y una recarga perdería la demo. |

- Desplazan con suavidad hasta dejar la cabecera de la sección 16 px bajo la
  barra (con movimiento reducido, de golpe) y llevan el foco al título de la
  sección (`tabindex="-1"`).
- Un solo subrayado se desliza y cambia de ancho entre enlaces con
  `transform`. Lo mueve un seguimiento de la lectura (un
  `IntersectionObserver` sobre una línea al 35 % de la altura de la
  pantalla); el enlace de la sección que se lee lleva `aria-current="true"`.
  En el héroe no hay ninguno; en el pie sigue el último. Mientras un enlace
  desplaza la página, las secciones que cruza no se llevan la marca.
- Al llegar (evento `scrollend`, o seis fotogramas quietos donde no existe),
  la sección vuelve a entrar: la etiqueta se desliza, las líneas del título
  suben y una raya roja barre bajo el título. Solo si la cabecera se ve;
  nunca con movimiento reducido. También la primera vez que una sección
  aparece barre la raya.
- En pantallas de 1100 px o menos, los enlaces van en una segunda fila que se
  desplaza de lado, con los bordes difuminados; el enlace actual se trae a la
  vista. Zonas de pulsación de 44 px. Por debajo de 520 px la marca se queda
  en su símbolo (el nombre sigue para lectores de pantalla).
- La línea de progreso se pinta con `transform: scaleX` en un fotograma por
  ráfaga de desplazamiento, y solo mientras se desplaza.

### Selector de periodo

Uno solo, en la barra: botones de radio (los años con rutas y «Todo») en un
control segmentado, con una píldora roja que se desliza bajo el elegido. Las
flechas del teclado se mueven entre opciones, como en cualquier grupo de
radio. Con muchos años, la fila se desplaza dentro de su caja y mantiene a la
vista el elegido. Siguen al periodo exactamente los mismos bloques del
apartado 3: las cuatro cifras, los récords, días y horas, los trayectos
cortos y la tarjeta; cada bloque dice el periodo que enseña.

Al cambiar de periodo: las cifras vuelven a contar (más corto que la primera
vez) donde se ven; los bloques que siguen al periodo y se ven aparecen con
un fundido corto, uno tras otro (`--stagger`), y sus barras vuelven a crecer;
los que no se ven esperan a verse; el título de 01 vuelve a subir si se ve.
Los demás bloques son los mismos nodos y no se tocan. La página no salta (los
bloques nuevos ocupan lo mismo que los viejos; lo comprobó el navegador).

### Carga y errores

Los paneles de error tienen esquina cortada, barra roja y código en rojo;
sus códigos, textos y botones son los del apartado 10. La pantalla de carga
está en el apartado 14.

### Movimiento

Solo `transform` y `opacity` (un test lo comprueba en cada `@keyframes`), con
las duraciones de D-027 y ninguna otra. Nada se anima fuera de pantalla; al
cambiar de vista (otro escenario, salir de la demo, salir de la cuenta, otra
carga) se sueltan los observadores, los fotogramas pedidos y los escuchadores
de la barra. Con movimiento reducido, todo en su estado final, desplazamiento
de golpe y sin repeticiones. Los `ResizeObserver` se desconectan con la vista
y la página no vigila bloques que un cambio de periodo ha quitado.

### Otros cambios

- Un número y su unidad no se separan al cortar la línea: los textos con
  unidad (`formatKm`, `formatSpeed`, `formatPercent`, `formatDuration`, los
  km enteros, la batería…) llevan un espacio duro (U+00A0), escrito en el
  código como ` ` o `String.fromCharCode(0xa0)`; un test rompe si el
  carácter invisible entra en `src/` o `tests/`. La hora de llegada con
  «(+1 día)» sigue con espacio normal, porque también va al CSV.
- El saneador convierte `-0` en `0` también en la velocidad media, el
  odómetro y el kilometraje, como ya hacía con la velocidad máxima.
- El gráfico de 12 meses tiene un segundo dibujo para móviles (400 de ancho,
  iniciales de los meses, ejes sin unidad) que sustituye al ancho por debajo
  de 640 px; ya no hay que desplazarlo de lado. La tabla de datos es una.

## 13. Lista y mapa juntos, y la traza que se dibuja

Lista y mapa conviven: se elige y se ve en el mismo sitio. No cambia ninguna
cifra, ni el recorte, ni el saneador, ni los sellos de ESLint, ni el login.

### Disposición

| Ancho | Cómo se ve |
|---|---|
| 1024 px o más | Mapa a la izquierda, lista a la derecha, los dos tan altos como la pantalla bajo la barra (`clamp(560px, 100svh − barra − 32px, 980px)`). La lista se desplaza dentro de su propia caja; buscar, ordenar y «Exportar CSV» quedan encima, «Mostrar más rutas» al final. Al llegar a un extremo de la caja, la rueda sigue con la página. |
| Menos de 1024 px | El mapa queda fijo (`position: sticky`) bajo la barra, a unos 31 svh en móviles (38 svh hasta 1023 px), con las cifras de la ruta debajo; la lista va en el flujo de la página, sin caja propia que atrape el desplazamiento. La altura de la barra (una o dos filas) la publica `src/ui/app.ts` en `--bar-h` con un `ResizeObserver` que se suelta con la vista. En móviles el título de la ruta solo lo oyen los lectores de pantalla y la fecha va en la franja de cifras, para que la parte fija no pase de la mitad de la pantalla. |

La leyenda del mapa y la nota de la lista van debajo de los dos
(`.archive-notes`). Cada ruta es una fila de tabla presentada como tarjeta:
fecha y salida → llegada arriba; duración, distancia, media, máxima e
inferidos debajo, cada uno con su etiqueta y su unidad en rojo. La tabla
sigue siendo una tabla para los lectores de pantalla (cabecera oculta a la
vista, no quitada; roles explícitos porque las filas cambian de `display`),
y las etiquetas y unidades son texto generado con `content: attr(...) / ""`,
que esos lectores no repiten. La búsqueda, el orden, el título de la tabla y
el CSV no cambian.

### Elegir una ruta

- Pulsarla (o Intro/Espacio sobre su fecha) la abre en el mapa y **no mueve
  la página**; el foco se queda en la lista. ↑ y ↓ sobre una fila pasan a la
  ruta de arriba o de abajo y la abren.
- La fila elegida lleva una raya roja a la izquierda que crece,
  fondo propio y `aria-current="true"` en su botón; solo una a la vez.
- «Ruta anterior / siguiente» van sobre el mapa, arriba a la derecha (en
  móviles, solo las flechas; el nombre lo oyen los lectores). Siguen el orden
  por fecha y la lista marca la ruta que abren. Si su fila no se
  ve, en pantallas anchas se desplaza **la caja de la lista**, nunca la
  página; en estrechas se desplaza la página lo justo
  para dejar la fila bajo el mapa fijo, que no se mueve. Si la fila no estaba
  dibujada (más allá de «Mostrar más»), se dibujan las filas hasta ella.
- Bajo el mapa, la franja de la ruta: salida → llegada, tramos inferidos y
  cuatro cifras grandes (distancia, duración, velocidad media y máxima, con
  unidades pequeñas en rojo) que cuentan desde 0 al cambiar de ruta
  (`countUp`, `--dur-reveal`). Para los lectores de pantalla, la misma
  información va en una frase (`routeFacts`); la franja lleva `aria-hidden`.
- El detalle se pide solo al elegir la ruta, una vez por ruta, sin
  reintentos automáticos; los errores conservan su código y su acción
  («Reintentar» o «Volver a entrar»).

### Cómo se dibuja la traza (`src/ui/traceDraw.ts`)

1. El mapa vuela a los límites de las **líneas recortadas**
   (`flyToBounds`, duración `--dur-hero`). La primera vez no hay vista que
   animar: salta.
2. Al aterrizar (`moveend`), las líneas crecen fotograma a fotograma con
   `requestAnimationFrame` durante 1,5 a 2 veces `--dur-hero` (2 a partir de
   30 km), con una curva de entrada y salida suave. El avance es proporcional
   a la longitud medida sobre la proyección del mapa (Web Mercator), no al
   número de puntos: el último tramo se corta en un punto interpolado sobre
   esa proyección, donde el mapa dibuja el tramo recto. Así cada dibujo
   parcial es un trozo del final y nunca sale de él.
3. Una cabeza blanca con halo rojo (`circleMarker`, clase `trace-head`)
   va delante del trazo y desaparece al terminar. Los tramos inferidos siguen
   discontinuos y ámbar mientras crecen.
4. Al final, el mapa tiene exactamente las líneas recortadas.

Privacidad: la vista del mapa solo recibe `trimTrace(...).lines`; la cabeza y
los puntos interpolados están sobre esas líneas; el encuadre y el vuelo usan
solo sus límites; no hay marcadores de inicio ni de fin. `trim.ts`,
`sanitize.ts` y los sellos no intervienen en el dibujo.

Cancelación y visibilidad: elegir otra ruta a mitad de vuelo o de dibujo lo
para en el acto (el aterrizaje tardío no dibuja nada); soltar la vista (otro
escenario, salir de la demo o de la cuenta) para el dibujo, el vuelo y el
observador. No se dibuja con el mapa fuera de pantalla ni con la pestaña del
navegador oculta: el mapa se encuadra de golpe y espera, y dibuja (sin vuelo)
cuando se ve. Si se oculta o sale de pantalla a mitad, la traza se completa
de golpe. Con movimiento reducido, o sin `IntersectionObserver`: salto,
traza entera, ningún fotograma y ningún observador.

Estados del recuadro (`data-state` en `.map-stage`): sin elegir (rejilla y
«Elige una ruta»), cargando (una línea roja que barre el recuadro, con el
texto en `role="status"`), dibujada, vacía («Traza oculta por privacidad» con
filo ámbar, o «Sin recorrido») y error.

### Demo

El generador añade, al final de algunos días con salidas (2 %), un trayecto
corto de 320 a 780 m, con su propio flujo de números aleatorios para que el
resto de rutas no cambie. Se ve el caso «traza oculta por privacidad»
ordenando por distancia de menor a mayor.

### Otros cambios

- «01 Resumen»: la línea del periodo queda a 16 px del título y de las cifras.
- `MapSurface` tiene `frame` (encuadrar o volar, con aviso al terminar) y
  `paint` (sustituir las líneas sin mover el mapa, reutilizando las
  polilíneas); los controles de zoom van abajo a la izquierda.

## 14. Secciones pulidas, estados y pantalla de carga

02 Ritmo, 03 Hábitos y 06 Taller al nivel de 01 Resumen y 04 Rutas,
movimiento en cada interacción, todo adaptable a cualquier ancho, y una
pantalla de carga con la estética de la web. No cambia ninguna definición del
apartado 3 (las vistas nuevas están descritas allí), ni la privacidad, el
saneador, el recorte, el login o el servicio.

### Qué hay

| Parte | Qué cambia |
|---|---|
| 02 Ritmo | Récords con la unidad pequeña y roja. «Mes frente a mes»: la diferencia en km con signo, enorme, y las dos barras. Km por mes: cada mes es una columna que responde al ratón, al dedo y al teclado (una parada de tabulador, ← → Inicio Fin; nombre accesible con las cifras) y escribe sus cifras en una línea bajo el gráfico; los años fuera del periodo elegido quedan apagados. |
| 03 Hábitos | Calendario de actividad (apartado 3) con su leyenda, su pie y su tabla por mes; cada celda tiene nombre accesible (fecha, km, salidas) y se recorre con flechas (↑ ↓ un día, ← → una semana; una parada por año). En móviles se desplaza dentro de su caja, con el borde difuminado y «Desliza para ver el año entero →»; nunca la página. Las celdas aparecen columna a columna (el retraso se reparte para que un año entero no pase de `--dur-hero`). Días y horas: columnas como las de Ritmo, el pico en rojo vivo y el resto en `--red-mid` (3,09:1 sobre el fondo; antes `--red-dim`, 2,2:1) y la frase bajo cada uno. «En números» en lugar de «Trayectos cortos». |
| 06 Taller | El mantenimiento dice su respuesta además en una cifra grande («Te faltan / Te has pasado» y los km) con una barra de la parte del intervalo recorrida, que se llena al aparecer y al guardar. La frase de siempre sigue siendo la línea `role="status"`; la cifra lleva `aria-hidden`. Mismos dos números, mismo almacenamiento. |
| Tarjeta | Con el aspecto de la web: fondo casi negro, cuña roja inclinada, etiquetas numeradas en rojo, Barlow Condensed para título y cifras, Manrope para las etiquetas, unidades en rojo; 2160 × 2160 px (dibujada al doble). Espera a `document.fonts.load` de sus cuatro caras; si fallan o tardan más de 3 s, dibuja con las de reserva. Si la vista cambia antes, no dibuja. El botón de descarga se activa al terminar de dibujar. La vista previa escala con el ancho y aparece con un fundido. |
| Estados | Cuenta sin rutas: «Aún sin salidas», un 0 enorme y qué significa. Errores: filo rojo inclinado a la izquierda, código en un recuadro monoespaciado, el botón de siempre. Avisos con una raya roja inclinada. Pie con títulos en Barlow. |
| Carga | «Arranque de cuadro de instrumentos» (`src/ui/loadingStage.ts`). Ver abajo. |

### La línea de barrido, firma de las esperas

La línea roja que barre el mapa mientras carga una ruta es la misma en todas
las esperas:
`scanLine()` de `src/ui/motion.ts` crea el elemento (`.scan-line`, con los
mismos `@keyframes scan` y la misma duración) y cada sitio solo pone la caja
(`.map-scan`, `.scan-box`). Se usa en el mapa, en la tarjeta mientras espera
sus fuentes y se dibuja, y en la pantalla de carga. No en lo que es
instantáneo (el calendario se calcula en el acto).

### Pantalla de carga

- Primera pantalla oscura bajo la barra, el contenido abajo a la izquierda
  como el héroe: la caja roja inclinada de los números de sección con el
  paso o el año que se lee («Estado», «Vehículo», «2026», «2025»…; al
  cambiar, el viejo sale hacia arriba y el nuevo sube, `--dur-ui`), «Leyendo
  el historial», un contador enorme con las rutas cargadas de verdad (cuenta
  desde la cifra anterior con `countUp`, `--dur-reveal`; antes de las rutas
  enseña 0 apagado) y «RUTAS» en rojo, el estado de la moto en cuanto se
  sabe, la línea de estado de siempre (`role="status"`, mismos textos) y la
  regla de marcas de la tira de cifras.
- El total no se sabe (la carga para en el primer año vacío): ni porcentaje
  ni barra. Un tramo de marcas rojas avanza un paso por cada petición
  terminada (16 pasos por vuelta) y deja las pasadas algo más claras.
- La línea de barrido recorre la pantalla mientras espera; se para fuera de
  pantalla o con la pestaña oculta.
- Al llegar los datos, la pantalla se pone sobre el héroe de la página
  nueva, su texto se desvanece y una cuña roja barre de izquierda a derecha
  (`--dur-hero`, `--ease-in-out`, solo `transform`) hasta quedar donde vive
  la cuña del héroe, mientras el título sube; luego se quita. La página está
  debajo desde el primer momento: no salta y el desplazamiento sigue arriba.
  Si la carga falla, en su sitio queda el panel de error, sin barrido.
- Carga rápida: si los datos llegan antes de 650 ms desde que se ve, se
  espera lo que falte, nunca más de 300 ms. Con movimiento reducido (o sin
  `IntersectionObserver`) no hay espera, barrido, giro ni cuenta: la cifra y
  el año cambian sin más.
- Se suelta todo (observador, cuentas, temporizadores) al salir de la cuenta
  o de la demo a mitad de carga, al cambiar de escenario y al terminar; un
  aviso de progreso tardío de una carga abandonada ya no mueve nada.

### Otros cambios

- La etiqueta de sección entra desde −12 px (con −24 px, a 390 px salía 8 px
  de la pantalla mientras entraba).
- Redes de seguridad del aparecer: `beforeprint` muestra todo; si el
  observador no contesta en 2 s con la pestaña visible (un contexto que no
  pinta), se muestra todo sin transición; `@media print` y
  `@media (scripting: none)` dejan `.rv` visible.
- «Ver los datos en tabla» se abre animado (`::details-content` con
  `interpolate-size`, en Chrome; en otros navegadores se abre sin animar) y
  su + gira a ×. Botones, opciones del periodo, filas y celdas responden al
  pulsarlos; el ratón (solo con puntero fino) mueve filas, récords, cifras y
  la tarjeta; los campos cambian de borde y fondo al enfocarlos.
- Tokens `--red-mid` y `--heat-1` a `--heat-4` (colores, no movimiento; los
  tokens de movimiento son los de D-027).

## 15. El atlas

Sección «05 Atlas» («Tus rutas, en capas»), entre «04 Rutas» y «06 Taller»;
la numeración sigue siendo consecutiva y no hay atlas si la cuenta no tiene
salidas. Código en `src/ui/atlas/` (`geometry.ts`, `render.ts`,
`atlasView.ts`) y `src/ui/traceStore.ts`. No cambia el saneador, el recorte,
los sellos de ESLint, el login, las cifras ni la política de seguridad de
contenido.

### Técnica: Canvas 2D con proyección propia

Sin WebGL y sin librería. Motivos: ocho polilíneas de unos cientos de puntos
no necesitan GPU; ninguna dependencia nueva y ningún cambio en la política
(sombreadores o workers de WebGL añadirían riesgo a cambio de nada); funciona
donde WebGL está bloqueado; el código es nuestro y va en el único paquete
(`import()` está prohibido, así que el peso cuenta: el JS pasa de 251,33 kB
a 275,53 kB, de 79,87 a 89,10 kB comprimido); y la alternativa sin canvas es
trivial. Si el navegador no da contexto 2D, la sección dice «Este navegador
no puede dibujar el atlas», enseña la lista de las rutas que apilaría y no
lee nada.

- Plano: las líneas recortadas pasan a km sobre un plano local
  equirectangular centrado en el conjunto y luego a la placa (de −1 a 1, con
  un 8 % de margen). Cuadrícula con escala real: de la escala 1, 2, 5, 10,
  20, 50… km, el paso más cercano a ocho celdas (de 6 a 10 siempre que la
  escala lo permite); su valor va en una barra fuera del borde sur de la
  placa y en el nombre accesible del lienzo.
- Cámara: giro sobre la vertical, inclinación y división de perspectiva
  escritas a mano. Una recta en el espacio se proyecta en una recta, así que
  un punto sobre un tramo proyectado está sobre la traza.
- Encuadre: la placa y una pila de ocho llenan el escenario en el ángulo de
  reposo (`fitFraming`); se calcula para ese ángulo, así que girar no acerca
  ni aleja. Al llegar trazas, la placa y el encuadre se ajustan con suavidad.
- Capas por fecha (la más antigua abajo), cada una con su hoja: relleno
  tenue, contorno fino y marcas de corte en las esquinas (más visibles en la
  de arriba y en la elegida). Palos en las cuatro esquinas con una muesca por
  capa en su color, y la fecha corta de cada capa («18 abr») junto al palo
  más cercano, saltando las que se tocarían. Señal de profundidad: las capas
  lejanas algo más apagadas y finas. Huellas tenues de todas en el suelo; la
  de la elegida, en rojo vivo. Rampa de rojo apagado (antigua) a rojo vivo
  (reciente); halo rojo (un trazo ancho y tenue debajo) en la capa más
  reciente y en la elegida, que se quita si pintar resulta lento en ese
  equipo (media de más de 6 ms). Tramos inferidos discontinuos y ámbar. El
  norte va sobre la pila, fuera del borde norte; las fechas, junto a los
  palos, nunca sobre la placa.
- Con una capa elegida, las demás quedan en gris rojizo al 30 % y la elegida
  sube un poco sobre su sitio (`--dur-ui`), con la hoja marcada.
- Al construir, cada capa sube del suelo a su sitio en `--dur-hero` mientras
  su traza se dibuja.
- Las proyecciones de cada traza se guardan por cámara y altura y se reusan
  mientras la cámara no se mueve.
- **Sin marcas de inicio ni de fin.** El concepto de origen pintaba un punto
  de salida: aquí no. Solo hay un punto (la cabeza) mientras una traza se
  dibuja, y va sobre las líneas recortadas (`partialTrace` de
  `src/ui/traceDraw.ts`, la misma del mapa).
- El texto del lienzo usa Manrope y se repinta cuando `document.fonts.ready`.
  DPR limitado a 2.

### Datos (reglas duras)

- Al cargar la página no se pide nada. El botón «Reconstruir en 3D» lee como
  mucho **8** detalles (`ATLAS_MAX`), **uno detrás de otro**, sin reintentos.
  El conjunto se elige con «Las 8 más largas» (por defecto) o «Las 8
  últimas», dentro del periodo de la barra. Antes de pulsar se dice cuántas
  lecturas hará («Hará hasta 8 lecturas al servicio»; menos si ya están en
  memoria) y la cifra sigue a lo que lea el mapa.
- El mapa de «04 Rutas» y el atlas comparten las trazas recortadas en un
  único almacén por vista (`createTraceStore`): una ruta abierta en el mapa
  no se vuelve a leer, una ruta leída por el atlas se abre en el mapa sin
  esperar, y una petición en vuelo se comparte. Se vacía al soltar la vista
  (salir, cambiar de escenario, otra carga). Solo guarda líneas recortadas.
- Una serie para **antes de su siguiente petición** con «Cancelar», al
  cambiar de periodo o de conjunto y al soltar la vista. La petición en vuelo
  no se cancela; su respuesta no se dibuja.
- Una traza que el recorte deja sin nada, o sin recorrido, se salta y se
  cuenta («1 traza oculta por privacidad»); no es un error.
- Una lectura fallida para la serie y conserva lo que llegó, con el
  tratamiento de error de siempre (código y acción): «Reintentar» sigue
  desde donde paró (lo leído no se vuelve a leer); si la sesión acabó,
  «Volver a entrar».

### Movimiento

Fotogramas solo mientras algo se mueve (una capa que sube, una traza que se
dibuja, la entrada, la inercia, el paralaje que se asienta, «Trazar»); nunca
fuera de pantalla ni con la pestaña oculta. Al llegar cada traza su capa
sube a su sitio y se dibuja; la línea de barrido de la casa recorre la placa
y una cifra cuenta «3 / 8». Al acabar, la pila gira desde un giro desplazado
hasta el de reposo mientras las capas se separan. Arrastrar gira (con
inercia; con ratón, el movimiento vertical inclina); con el dedo, el
arrastre horizontal gira y el vertical desplaza la página (`touch-action:
pan-y`). Paralaje leve con puntero fino. Doble clic o «Restablecer» vuelven
al reposo. Elegir una capa (desplegable, clic o toque sobre su traza, ↑/↓
en el lienzo, Escape para soltarla) la eleva, apaga las demás, enseña sus
cifras (fecha, km, duración, media y máxima) y activa «Ver en el mapa», que
abre esa ruta en «04 Rutas» y lleva allí la página. «Trazar» repite el
dibujo de la elegida o de todas; «Progreso» lo recorre a mano; «Separación»
abre o junta la pila. Con movimiento reducido: sin entrada, inercia,
paralaje ni «Trazar»; dibujo completo; los controles siguen funcionando.

Accesibilidad: el lienzo es `role="img"` con un nombre que resume lo que
hay; todo se puede hacer con controles reales; ← → giran, ↑ ↓ cambian de
capa; una región `role="status"` dice el principio, el final, la
cancelación y la capa elegida (no cada fotograma); «Ver las trazas en
tabla» lista las capas con sus cifras.

## 16. Qué está comprobado y qué no

Cada afirmación dice dónde corrió. Un test en verde contra un doble prueba el
contrato tal como lo leímos, no que el servicio real ni un navegador se
comporten así.

### Tests en memoria (Vitest)

Corren en local (Windows) y en la CI (Ubuntu, Node 22), con la zona horaria
de Los Ángeles. Los de datos corren contra el servicio de demo; los del login
y `/mcp`, contra `tests/fakeServer.ts`, un login y un `/mcp` falsos que exigen
el contrato tal como lo leímos (PKCE S256 con el vector del RFC 7636, códigos
de un solo uso, `redirect_uri` exacta, solo las tres cabeceras, sin cookies,
sin cadena de consulta, JSON-RPC con el servicio de demo detrás). Los de
interfaz corren en jsdom con observadores y fotogramas manejados a mano, una
superficie de mapa y contextos de canvas que graban.

- Datos y privacidad: la lista exacta de campos del saneador
  (`tests/sanitize.test.ts`), el recorte por lugar (`tests/trim.test.ts`,
  `tests/trim-places.test.ts`), los sellos de ESLint y las vías para
  saltárselos (`tests/lint-seals.test.ts`), las dos excepciones de
  almacenamiento (`tests/units.test.ts`, `tests/lint-storage.test.ts`), la
  política de seguridad (`tests/csp.test.ts`, `tests/environment.test.ts`),
  la carga por semestres y sus errores (`tests/loader.test.ts`,
  `tests/loader-edges.test.ts`) y las cifras (`tests/stats.test.ts`,
  `tests/stats-edges.test.ts`).
- Login y `/mcp` (`tests/login.test.ts`, `tests/mcpClient.test.ts`,
  `tests/pkce.test.ts`) y su unión con la página (`tests/boot.test.ts`,
  `tests/sign-in-errors.test.ts`): entrada sin servicio, ida y vuelta del
  login, `#demo` a la vuelta y escrito después, vuelta con otro `state`,
  canje sin red, 401, 403 y red caída tras entrar, token que caduca a mitad
  de la carga, fallo del recorrido de una ruta con la sesión terminada, salir
  con la cuenta cargada y a mitad de carga, otra cuenta a mitad de carga y
  salir con `logoutUri`; el token no llega a la página ni a la dirección.
- Página y movimiento (`tests/nav.test.ts`, `tests/motion.test.ts`,
  `tests/motion-page.test.ts`, `tests/app.test.ts`, `tests/summary.test.ts`,
  `tests/page-edges.test.ts`, `tests/charts.test.ts`,
  `tests/styles.test.ts`): enlaces, desplazamiento, foco, `aria-current`,
  seguimiento, cambio de periodo, movimiento reducido y liberación al cambiar
  de vista.
- Mapa y traza (`tests/map.test.ts`, `tests/routes-map.test.ts`): la traza
  crece sin retroceder hasta exactamente las líneas recortadas y ningún punto
  ni la cabeza salen de ellas; cancelación; nada fuera de pantalla; un
  detalle por ruta; ninguna regla de la hoja esconde o corta una celda
  (lectura del texto de la hoja, no del dibujo).
- Calendario, tarjeta, pantalla de carga y secciones (`tests/calendar.test.ts`,
  `tests/card.test.ts`, `tests/loading-stage.test.ts`,
  `tests/sections-polish.test.ts`): la tarjeta no lleva velocidades,
  coordenadas ni fechas.
- Atlas (`tests/atlas.test.ts`): nada pedido antes del botón; como mucho 8
  lecturas y nunca dos a la vez; todo punto de trazo, huella y cabeza está
  sobre los tramos proyectados de las líneas recortadas; cancelación y
  limpieza; sin canvas.
- Contraste (`tests/contrast.test.ts`): lee los colores de la hoja de
  estilos, los pasa de oklch a sRGB y comprueba 4,5:1 para texto y 3:1 para
  bordes de controles, foco y series del gráfico.

Qué no prueban: lo que se ve, Leaflet, ni el servicio real. Node y jsdom no
aplican CORS ni la política de seguridad, y jsdom no navega (la ida al login
se anota en una lista). `scripts/check-dist.mjs` no tiene tests. El contraste
se calcula recortando cada canal al gamut sRGB; el navegador reduce el croma,
así que la luminancia real puede diferir un poco, y los colores con
transparencia y los del mapa no se comprueban.

### Navegador, sobre la demo

Chromium sin interfaz, con el build de producción servido por `vite preview`
y la política aplicada (2026-11-10), emulando por el protocolo de depuración
320, 360, 390, 768, 1024, 1280, 1920 y 2560 px, en la entrada, la demo,
`heavy`, `empty`, `error`, la carga, el mapa, las secciones y el atlas:

- Sin desplazamiento lateral de la página, ningún título, cifra ni celda de
  ruta cortados, ninguna cifra separada de su unidad, Barlow y Manrope
  cargadas, ningún control de menos de 44 px, ningún error de consola ni
  infracción de la política, y solo peticiones al propio origen y a
  `tile.openstreetmap.org`. Ojo al medir: con emulación de móvil el navegador
  ensancha la ventana para que quepa lo que sobresale, así que hay que
  comparar `scrollWidth` con el ancho emulado, no con `innerWidth`.
- En vivo, a 1280 y 390 px, con clics de ratón: los enlaces de sección
  (desplazamiento, foco, subrayado, raya), el cambio de periodo sin que la
  página salte, elegir rutas (vuelo, traza con su cabeza, cambio a mitad de
  dibujo, «anterior» varias veces desplazando la caja de la lista y no la
  página), la ruta oculta por privacidad, la tarjeta descargada (PNG de
  2160 × 2160) y el CSV.
- Atlas: 8 lecturas de detalle por construcción y 0 al pulsar «Ver en el
  mapa» (contadas con un punto de ruptura). Coste de los fotogramas al girar
  con el ratón (1280) y con el dedo (390), medido con la traza de DevTools:
  mediana 0,5 ms; con la CPU 4 veces más lenta, mediana 2,6 a 3,6 ms y p95
  5,5 a 12 ms. En reposo, ningún fotograma. Con el dedo, un deslizar vertical
  desplaza la página sin girar la placa.
- Con movimiento reducido: sin animaciones en marcha, nada oculto, la traza
  entera y un solo encuadre.
- Con la demo normal, la pantalla de carga se ve desde unos 0,1 s y pasa a
  la página a unos 1,6 s.
- Un build con valores sintéticos (`example.test`) dio `connect-src 'self'
  https://api.example.test https://login.example.test` y pasó
  `check-dist.mjs`.

### Real

- Tres lecturas reales pequeñas del servicio el 2026-11-09, solo para ver la
  forma de los datos (apartado 5).
- El acceso con cuenta se ha probado de verdad contra el entorno de pruebas
  del servicio, desde un ordenador.
- La web publicada lleva los valores de producción y su política permite
  solo esos dos orígenes. Un login real en la web publicada, contra
  producción, está **sin probar**.

### Sin comprobar

- Safari, Firefox y un móvil físico: el tacto real (la lista bajo el mapa
  fijo, el calendario desplazado con el dedo, el toque en las columnas), el
  rendimiento en un teléfono de gama media (el ×4 de Chrome es una
  aproximación), la espera de fotogramas quietos donde no hay `scrollend`, y
  la animación de «Ver los datos en tabla» fuera de Chrome.
- Un lector de pantalla real: las cifras que cuentan, los enlaces de sección
  y el grupo de radio, la tabla presentada como tarjetas con el texto
  generado `/ ""`, las celdas del calendario y las columnas (`role="img"`),
  la cifra del mantenimiento oculta, y el lienzo del atlas con sus anuncios.
- El contraste de los colores con transparencia (barra translúcida) y los
  del mapa.
- Que `flyToBounds` y `map.stop()` se comporten igual con teselas lentas o
  sin red.
- El rendimiento con trazas de muchos puntos (las de la demo tienen como
  mucho 181; no se diezman).
- En pantallas anchas muy bajas (menos de unos 660 px de alto) la sección 04
  es más alta que la pantalla.
- Que la cuña del traspaso de la pantalla de carga coincida al píxel con la
  del héroe en todos los anchos: se miró a 1280 y 390.
- Unos puntos blancos sueltos en algunas letras grandes de Barlow en las
  capturas sin interfaz (también en la tarjeta); parecen del rasterizado de
  Chrome sin interfaz, sin confirmar en un navegador con pantalla.
- Qué ve el navegador ante un 401 o un 403 del autorizador sin cabeceras
  CORS, y los demás puntos de «Sin comprobar» del apartado 5.
