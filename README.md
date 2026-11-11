# Honda Ride Log

Web estática para ver las estadísticas de tus propias rutas en moto, a partir
de tu cuenta de MAPIT (la app que localiza la moto).

**Verla:** <https://herrerogusano.github.io/honda-ride-log/> · con datos de
ejemplo, sin cuenta: <https://herrerogusano.github.io/honda-ride-log/#demo>

Proyecto personal, sin relación con Honda ni con MAPIT. Usa una interfaz no
oficial y funciona solo por invitación.

## Qué enseña

Una sola página, oscura, con seis secciones:

- **Resumen**: km, salidas y horas en marcha del año elegido, y el estado de
  la moto (batería, último uso, odómetro).
- **Ritmo**: km por mes comparando años, récords, este mes frente al mismo
  mes del año pasado y rachas.
- **Hábitos**: calendario de actividad, salidas por día de la semana y por
  hora, y trayectos cortos.
- **Rutas**: la lista de rutas y el mapa, juntos. Al elegir una, el mapa
  vuela hasta ella y la traza se dibuja de principio a fin. Cada ruta enseña
  fecha, salida y llegada, duración, km y velocidad media y máxima. Se puede
  exportar a CSV.
- **Atlas**: hasta ocho rutas apiladas por fecha en una vista 3D que se gira
  con el dedo o el ratón. Solo pide datos cuando se lo pides.
- **Taller**: cuánto falta para la próxima revisión y una tarjeta con tus
  cifras para compartir.

## Privacidad

- No hay servidor propio. Tus rutas, tus cifras y los datos de tu moto se
  quedan en tu navegador: no se envían a nadie más que al servicio del que
  se leen.
- Terceros: las teselas del mapa, a OpenStreetMap, y en la copia publicada
  en Cloudflare Pages dos contadores de visitas. Cloudflare Web Analytics
  cuenta la visita sin cookies. Google Analytics solo se carga si aceptas
  en el aviso de cookies, y cuenta la visita y si abres la demo o entras
  con tu cuenta; si rechazas, no se carga. Se puede cambiar de opinión al
  final de la página. Ninguno recibe tus rutas, tus cifras, nada del inicio
  de sesión ni la dirección completa de la página.
- Los datos se leen y se calculan en tu navegador y no se guardan. Lo único
  que se recuerda, en tu navegador, son los dos números de mantenimiento que
  tú escribas y tu respuesta al aviso de cookies.
- Nunca se muestran la matrícula, el bastidor, el concesionario ni la
  posición actual de la moto.
- El mapa y el atlas no dibujan nada a menos de 400 m de donde empieza o
  acaba cada ruta, ni marcas de inicio o de fin. Las rutas de menos de 300 m
  se ocultan.
- La contraseña la pide la página de login del servicio, no esta web. El
  acceso vive solo en la memoria de la pestaña: al recargar hay que volver a
  entrar.

## Estado

- La web está completa y publicada, con el acceso con cuenta activado para
  las personas invitadas. Sin invitación solo se puede ver la demo.
- El acceso con cuenta se ha probado de verdad contra el entorno de pruebas
  del servicio, desde un ordenador. El resto de comprobaciones son tests
  automáticos contra datos de ejemplo y un servidor falso, y un navegador
  Chromium a ocho anchos de pantalla (de 320 a 2560 px).
- Las distancias y las velocidades son las que entrega el servicio, que
  avisa de que sus unidades están sin confirmar.

El plan, las decisiones y lo comprobado y lo no comprobado están en
[`docs/PLAN.md`](docs/PLAN.md).

## Desarrollo

Vite y TypeScript, sin framework. Leaflet es la única dependencia de
ejecución; los gráficos y el atlas están hechos a mano. Requiere Node 22 o
superior.

```sh
npm ci
npm run dev        # servidor de desarrollo: http://localhost:5173/#demo
npm run lint       # ESLint
npm run typecheck  # TypeScript sin emitir
npm test           # tests (Vitest)
npm run build      # typecheck + build para GitHub Pages en dist/ + comprobaciones de publicación
npm run build:cloudflare  # lo mismo para Cloudflare Pages, con dist/_headers
```

Las reglas para quien toque el código (personas o agentes) están en
[`AGENTS.md`](AGENTS.md). Las fuentes Barlow Condensed y Manrope se sirven
desde el propio sitio, con licencia SIL Open Font License.
