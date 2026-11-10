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

- No hay servidor propio, ni analítica, ni terceros: la página solo pide las
  teselas del mapa a OpenStreetMap.
- Los datos se leen y se calculan en tu navegador y no se guardan. Lo único
  que se recuerda, en tu navegador, son los dos números de mantenimiento que
  tú escribas.
- Nunca se muestran la matrícula, el bastidor, el concesionario ni la
  posición actual de la moto.
- El mapa y el atlas no dibujan nada a menos de 400 m de donde empieza o
  acaba cada ruta, ni marcas de inicio o de fin. Las rutas de menos de 300 m
  se ocultan.
- La contraseña la pide la página de login del servicio, no esta web. El
  acceso vive solo en la memoria de la pestaña: al recargar hay que volver a
  entrar.

## Estado

- La web está completa y publicada. La versión publicada ofrece hoy **solo
  la demo**: el acceso con cuenta se activará cuando el servicio de
  producción admita esta web.
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
npm run build      # typecheck + build en dist/ + comprobaciones de publicación
```

Las reglas para quien toque el código (personas o agentes) están en
[`AGENTS.md`](AGENTS.md). Las fuentes Barlow Condensed y Manrope se sirven
desde el propio sitio, con licencia SIL Open Font License.
