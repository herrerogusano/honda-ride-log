# Honda Ride Log

Web estática para ver las estadísticas de tus propias rutas en moto. Cada
persona invitada entra con su cuenta de MAPIT y sus datos se leen desde su
navegador. La web no tiene servidor propio y no guarda tus rutas ni tu
contraseña ni tu token de acceso: solo recuerda, en tu navegador, los dos
números de mantenimiento que tú escribas.

Estado: en construcción. Hoy funciona el modo demo, con datos de ejemplo; el
acceso con cuenta todavía no. Para verlo: `npm ci`, `npm run dev` y abrir
`http://localhost:5173/honda-ride-log/#demo`. El plan, las decisiones y el
reparto de fases están en [`docs/PLAN.md`](docs/PLAN.md).

Proyecto personal, sin relación con Honda ni con MAPIT.

## Desarrollo

Requiere Node 22 o superior.

```sh
npm ci
npm run dev        # servidor de desarrollo
npm run lint       # ESLint
npm run typecheck  # TypeScript sin emitir
npm test           # tests (Vitest)
npm run build      # typecheck + build en dist/ + comprobaciones de publicación
```
