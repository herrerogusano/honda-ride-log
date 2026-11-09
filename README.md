# Honda Ride Log

Web estática para ver las estadísticas de tus propias rutas en moto. Cada
persona invitada entra con su cuenta de MAPIT y sus datos se leen desde su
navegador. La web no tiene servidor propio y no guarda tus rutas ni tu
sesión: solo recuerda, en tu navegador, el intervalo de mantenimiento que tú
escribas.

Estado: en construcción. El plan, las decisiones y el reparto de fases están en
[`docs/PLAN.md`](docs/PLAN.md).

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
