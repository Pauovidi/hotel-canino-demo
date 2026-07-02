# Production Smoke Scripts Audit

## Causa del fallo

En EasyPanel los comandos:

- `npm run smoke:templates`
- `npm run smoke:identity`
- `npm run smoke:conversation`
- `npm run smoke:conversation:latency`

fallaban con `sh: 1: tsx: not found` porque apuntaban directamente a scripts TypeScript ejecutados con `tsx`. `tsx` está en `devDependencies`, y el runtime production/standalone no debe depender de devDependencies.

## Scripts que dependían de tsx

- `smoke:templates` -> `tsx scripts/conversation-templates-smoke.ts`
- `smoke:identity` -> `tsx scripts/conversation-identity-smoke.ts`
- `smoke:conversation` -> `tsx scripts/conversation-e2e-smoke.ts`
- `smoke:conversation:latency` -> `tsx scripts/conversation-latency-smoke.ts`

Otros scripts operativos ya eran production-safe con Node:

- `db:check:postgres`
- `jobs:dispatch-scheduled-messages`
- `reminders:reservation-prearrival`
- `followups:post-stay`
- `smoke:http`

## Estrategia elegida

Se elige Opción B: compilar/bundlear los smoke scripts TypeScript a `.mjs` production-safe durante build.

Nuevos scripts:

- `scripts/build-production-smokes.mjs`
- `scripts/run-production-smoke.mjs`

`postbuild` ejecuta `npm run smoke:scripts:build` y genera:

- `scripts/production-smokes/conversation-templates-smoke.mjs`
- `scripts/production-smokes/conversation-identity-smoke.mjs`
- `scripts/production-smokes/conversation-e2e-smoke.mjs`
- `scripts/production-smokes/conversation-latency-smoke.mjs`

Los comandos production-facing de `package.json` ahora usan `node scripts/run-production-smoke.mjs ...`, no `tsx`.

## Docker y runtime

El Dockerfile no necesita cambios:

1. `builder` ejecuta `npm run build`.
2. `postbuild` genera los bundles `.mjs`.
3. `runner` ya copia `/app/scripts` desde `builder`.

Por tanto los bundles generados quedan disponibles dentro del contenedor aunque `tsx` no esté instalado en runtime.

Si EasyPanel no usa Dockerfile pero sí ejecuta `npm run build`, el mismo `postbuild` genera los bundles antes del arranque.

## Cobertura conservada

Los smokes no son `echo OK`:

- `smoke:templates` renderiza plantillas reales y comprueba snippets de confirmación, bienvenida, denegación, baño, recordatorio, post-estancia y reseña.
- `smoke:identity` usa store en memoria y un `ClientDirectory` fake para probar usuario conocido, reset, hola, reserva e identidad preservada.
- `smoke:conversation` usa store en memoria y adapter mock; el modo HTTP queda bloqueado salvo `CONVERSATION_SMOKE_ALLOW_HTTP=true`.
- `smoke:conversation:latency` usa store temporizado en memoria y exige métricas, con `openaiCalls=0` en el flujo sintético.

## Riesgos

- Los bundles se generan en build y están ignorados por Git. Si alguien ejecuta un smoke en production sin haber corrido build, el runner fallará con un mensaje de bundle ausente.
- `esbuild` es dependencia de build, no de runtime. Si un entorno instala sin devDependencies antes de build, debe cambiarse el proceso para instalar devDependencies durante build.
- Los scripts TypeScript siguen siendo la fuente de verdad; los `.mjs` generados no se editan a mano.

## Validación esperada

Ejecutar:

- `npm run smoke:scripts:build`
- `npm run smoke:templates`
- `npm run smoke:identity`
- `npm run smoke:conversation`
- `npm run smoke:conversation:latency`
- `npm run smoke:production`

En EasyPanel ya no debe aparecer `sh: 1: tsx: not found`.
