# Plan y relevo entre fases

Este documento es el punto de partida de cualquier hilo que trabaje en el
repo. Dice qué se construye, qué está decidido, qué se ha comprobado y qué no,
y cómo se reparte el trabajo. Actualízalo al cerrar cada fase.

Última actualización: 2026-11-09, cierre de la fase 1; 2026-11-10, módulos
de la fase 3 (apartado 10).

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
| Token solo en memoria | Ver «Almacenamiento» en el apartado 2. ESLint prohíbe `localStorage` y `sessionStorage` en todo el código salvo excepciones de un único archivo anotadas aquí. Fase 3: `src/auth/pendingLogin.ts` puede usar `sessionStorage` y solo lo importa `src/auth/login.ts` (apartado 10). |
| Sin analítica ni terceros, salvo las teselas de OpenStreetMap | Política de seguridad de contenido en `csp.config.json`. `scripts/check-dist.mjs` rompe el build si la página que genera Vite no lleva exactamente esa política, o si detecta código en línea o recursos de otro origen; `tests/csp.test.ts` fija su texto. Es una red contra errores propios hecha con expresiones regulares, no un analizador de HTML: no protege contra quien edite `dist/` a mano, y no tiene tests propios. |
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
| `environments.config.json`, `src/auth/`, `src/service/environment.ts`, `src/service/mcpClient.ts` | Fase 3: entornos, login y cliente de `/mcp` (apartado 10). |
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
| 2 | La web: tres pestañas, tarjeta, modo demo; función de recorte de trazas; cálculo de estadísticas | Pendiente |
| 3 | Login con PKCE y cliente de `/mcp` (implementa `ToolCaller`), configuración por entorno, pruebas contra un servidor falso; añadir los orígenes del servicio y del login a `connect-src` | Módulos hechos y probados contra un servidor falso (2026-11-10, apartado 10); falta conectarlos con la interfaz |
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
8. Todas las webs de Pages de la cuenta comparten el origen
   `herrerogusano.github.io`, y con él el acceso al token y al login a medio
   hacer (apartado 10). ¿Se acepta, o se publica con un dominio propio?

### Aceptación real (no la sustituye ningún test)

El propietario abre la web con su moto y coteja a mano cinco cifras con la
app de MAPIT: km del mes, salidas del mes, odómetro, batería y la ruta más
larga del año. Antes de eso, la primera prueba real es un solo login y un
solo `get_vehicle_status` desde el navegador contra el entorno de pruebas del
servicio, usando la dirección de retorno de `localhost`.

## 10. Fase 3: login y cliente de `/mcp`

Escrito el 2026-11-10. Los módulos están hechos y probados contra un
servidor falso; **todavía no están conectados con la interfaz** (eso es de
una fase posterior) y nada se ha probado contra el servicio real.

| Ruta | Qué hay |
|---|---|
| `environments.config.json` | Ajustes por modo de Vite: `development` (`npm run dev`), `production` (`npm run build`) y `demo` (sin servicio). |
| `src/service/environment.ts` | Valida una entrada de ese archivo; da «solo demo» o la configuración del servicio. |
| `src/auth/pkce.ts` | Verificador, reto S256 y `state`. |
| `src/auth/pendingLogin.ts` | El único archivo con `sessionStorage`. |
| `src/auth/session.ts` | El token de acceso, en una variable cerrada. |
| `src/auth/login.ts` | Ida al login, vuelta, canje del código y cierre de sesión. |
| `src/service/mcpClient.ts` | El `ToolCaller` real. |
| `tests/fakeServer.ts` | Login y `/mcp` falsos detrás de una función `fetch`. |

### Configuración por entorno

- Cada entrada tiene `mcpUrl`, `loginDomain`, `webClientId`, `redirectUri`,
  `logoutUri` y `sendResourceIndicator`. Hoy las tres primeras están vacías
  en todos los modos: la web solo ofrece la demo. Un modo que no aparece en
  el archivo (por ejemplo `test`) también es solo demo.
- `vite.config.ts` valida la entrada del modo que construye. Si está a
  medias o mal escrita (http fuera de `localhost`, `127.0.0.1`, cadena de
  consulta, barra final en `mcpUrl`, un `*` en el dominio, un campo
  desconocido), el build falla con el nombre del campo y sin su valor.
- Direcciones de retorno: `http://localhost:5173/` en `development` y
  `https://herrerogusano.github.io/honda-ride-log/` en `production`. Deben
  coincidir carácter a carácter con las del cliente del login.
- El servidor de desarrollo sirve ahora en la raíz (`/`), en
  `localhost:5173` con el puerto fijo; el build y `npm run preview` siguen en
  `/honda-ride-log/`. Motivo: el login devuelve al navegador a
  `http://localhost:5173/` exactamente.
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

Cuando se fusione la excepción de `localStorage` de la fase 2
(`src/storage/maintenance.ts`), quien fusione en segundo lugar debe
comprobar que cada archivo sigue teniendo prohibido el almacenamiento del
otro, y puede sustituir las listas repetidas por las constantes compartidas
que introduce esa PR.

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
  a ninguna parte. El de renovación no se revoca: sigue valiendo en Cognito
  lo que diga el cliente (30 días por defecto). Revocarlo con
  `/oauth2/revoke` invalidaría también el token de acceso. Conviene que el
  cliente nuevo (fase 4) tenga la validez de renovación más corta posible.
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
  herramienta se toma de `result.structuredContent` (**sin verificar** en
  real); un `result.isError` se convierte en `ToolCallError` con el código
  del principio del texto si tiene forma de código (de dos a seis palabras en
  minúsculas unidas por `_`, sin cifras, para no tomar un identificador por
  un código), y sin el mensaje. Cualquier otro texto da `tool_error`.
- Plazo de 20 segundos por petición (el servicio tiene 14 por dentro).

### Errores

Ningún mensaje lleva el token, el código de autorización, una dirección,
un cuerpo de respuesta ni un mensaje del servicio. `detail` es nulo o un
código corto.

| Clase y `kind` | Cuándo | Qué debería decir la interfaz |
|---|---|---|
| `AuthError` `config_missing` | Build sin servicio | Solo demo |
| `AuthError` `storage_unavailable` | `sessionStorage` bloqueado | El navegador no permite entrar (modo privado estricto) |
| `AuthError` `state_mismatch` | Vuelta sin login pendiente, caducado o con otro `state` | Vuelve a entrar |
| `AuthError` `login_failed` | El login devolvió `error=` (por ejemplo `access_denied`) | No se ha podido entrar |
| `AuthError` `token_exchange` | El canje respondió con error (`invalid_grant`, `http_502`...) | No se ha podido entrar |
| `AuthError` `token_network` | El canje no llegó (red o CORS) | No se ha podido conectar con el login |
| `ServiceError` `reauth_required` | Token caducado, 401 o red tras entrar, o cualquier llamada después de que la sesión terminara (`detail`: `expired`, `unauthorized`, `network`, `forbidden` o `signed_out`) | Vuelve a entrar, sin botón de reintentar |
| `ServiceError` `forbidden` | 403 | Tu cuenta no tiene acceso |
| `ServiceError` `rate_limited` | 429 | Espera un momento |
| `ServiceError` `http_status` | Otro estado HTTP (`detail`: el número) | Error del servicio |
| `ServiceError` `timeout` | Sin respuesta en 20 s | El servicio tarda demasiado |
| `ServiceError` `bad_response` | No es JSON, no es JSON-RPC, otro `id`, sin `structuredContent` | Respuesta inesperada |
| `ServiceError` `rpc_error` | Error JSON-RPC (`detail`: su código numérico) | Error del servicio |
| `ServiceError` `not_allowed` | Herramienta fuera de la lista o argumentos raros | Fallo de la web (no debería verse) |
| `ToolCallError` | La herramienta respondió con error | Como en la demo |

El cargador de la fase 2 (`src/service/loader.ts`) todavía no conoce
`AuthError` ni `ServiceError`: hoy los mostraría como `unknown` con el nombre
de la clase. Hay que ampliar su `FailureKind` y los textos de
`src/ui/errors.ts` al conectar.

### Cómo se conecta con la interfaz

```ts
import { browserDeps, completeLogin, logout, startLogin } from "./auth/login";
import { currentEnvironment } from "./service/environment";
import { createMcpClient } from "./service/mcpClient";

const environment = currentEnvironment();
if (environment.kind === "service") {
  const deps = browserDeps();
  // Al cargar la página, antes de pintar nada: quita ?code y ?state.
  const back = await completeLogin(environment.config, deps);
  if (back.status === "signed_in") {
    const caller = createMcpClient(environment.config.mcpUrl, back.session);
    // app.load(caller, { demo: false });
  }
  // Botón «Entrar»: startLogin(environment.config, deps)
  // Botón «Salir»: logout(environment.config, session, deps)
}
```

### Riesgo de origen compartido en GitHub Pages (decisión del propietario)

Todas las webs de Pages de la cuenta comparten el origen
`https://herrerogusano.github.io`. Cualquier otra web de Pages del
propietario, o una dependencia comprometida en ella, corre con el mismo
origen. Podría abrir `/honda-ride-log/` en una ventana o un marco, leer el
`?code=` y el verificador de `sessionStorage` antes del canje, o envolver
`fetch` en esa ventana y capturar el token. La política de seguridad no lo
impide: no gobierna el acceso entre ventanas del mismo origen, y
`frame-ancestors` no funciona en una etiqueta `<meta>`. Opciones: aceptar que
las demás webs de Pages de la cuenta quedan dentro de la confianza (hoy no
se sabe si hay alguna), o publicar con un dominio propio para tener un
origen aparte. Pendiente del propietario (pregunta 8 del apartado 9).

### Qué demuestran los tests y qué no

Corren en Node con `tests/fakeServer.ts`: un login y un `/mcp` falsos que
exigen el contrato tal como lo leímos (PKCE S256 con el vector del RFC 7636,
códigos de un solo uso, `redirect_uri` exacta, solo las tres cabeceras, sin
cookies, sin cadena de consulta, JSON-RPC con el servicio de demo detrás).
Los tests se vieron fallar rompiendo el código a propósito, una rotura cada
vez: 66 del implementador y 9 más sobre los arreglos de la revisión, y 44 del
revisor independiente (más 9 suyas en la segunda pasada, de las que 2 siguen
vivas sin consecuencia: `check-dist.mjs` no tiene tests y el límite de seis
palabras del código de error no se mide). Al principio sobrevivieron 2 de las primeras y 21 de
las del revisor (por ejemplo, aceptar `http:` en el dominio del login o
quitar el plazo del canje); se cubrieron con tests nuevos y ahora fallan
todas. Es una muestra de roturas pensadas por dos agentes, no una prueba de
que no quede ninguna.

No demuestran: que Cognito acepte este cliente, el parámetro `resource` o la
dirección de retorno; que `/oauth2/token` y `/mcp` respondan con CORS a un
navegador; qué ve el navegador ante un 401 o un 403 del autorizador; que
`/mcp` acepte esta petición sin `initialize` y devuelva `structuredContent`;
que `credentials`, `redirect` y la política de seguridad se comporten así en
un navegador (Node no aplica CORS ni CSP). La primera prueba real sigue
siendo la del apartado 9: un login y un `get_vehicle_status` desde
`localhost` contra el entorno de pruebas.
