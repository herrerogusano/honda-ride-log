# Honda Ride Log

Web estática para ver las estadísticas de tus propias rutas en moto. Cada
persona invitada entra con su cuenta de MAPIT y sus datos se leen desde su
navegador; la web no tiene servidor propio ni guarda nada.

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
npm run build      # typecheck + build de producción en dist/
```
