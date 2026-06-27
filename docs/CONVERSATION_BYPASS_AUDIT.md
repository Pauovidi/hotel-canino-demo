# Conversation Bypass Audit

Fecha: 2026-06-27

Base auditada: `codex/smp-reservation-pending-field-slot-assignment-v0` / `9cb1f292cb8805562baefebe7c90b67b4e5fcae7`

Clasificaciones:

- `allowed_renderer`: redacta copy desde el renderer contractual.
- `allowed_outbox`: envia o convierte salida ya renderizada.
- `reducer_only`: actualiza estado sin redactar.
- `policy_only`: decide accion sin redactar.
- `bypass_to_fix`: bypass no aceptable.
- `legacy_allowed_temporarily_with_guard`: bypass existente permitido durante migracion, con test/allowlist.

## Hallazgos principales

| Archivo | Clasificacion | Hallazgo | Riesgo | Accion |
| --- | --- | --- | --- | --- |
| `src/lib/hotel/conversations/authority/pipeline.ts` | allowed_renderer / allowed_outbox / policy_only | Nuevo nucleo de autoridad: evento normalizado, interpretacion estructurada, policy action, renderer contractual y outbox. | Bajo. | Mantener como punto de entrada para nuevas rutas. |
| `src/app/api/twilio/whatsapp/route.ts` | legacy_allowed_temporarily_with_guard | Valida token, parsea payload, normaliza `NormalizedUserEvent`, pero aun construye TwiML y tiene respuestas degradadas/template preview. | Medio: route todavia puede montar copy en errores/previews. | Migrar degraded/template preview a CopyRenderer/Outbox. Guardrail cubre allowlist. |
| `src/lib/hotel/conversations/service.ts` | legacy_allowed_temporarily_with_guard | Orquestador principal. Genera multiples `botReply.body`, TwiML y eventos. Tambien contiene reset global, handoff, FAQ escape y confirmacion. | Alto: mezcla policy, reducer, renderer y outbox. | Encapsular por fases: state reducer puro, policy decision y CopyRenderer. |
| `src/lib/hotel/conversations/reservation-flow.ts` | legacy_allowed_temporarily_with_guard | Contiene reducer de reserva y tambien copy visible (`reply`, prompts, propuesta). | Alto: state reducer y renderer estan mezclados. | Extraer prompts/propuestas a CopyRenderer; dejar reducer sin texto. |
| `src/lib/hotel/conversations/nlu.ts` | legacy_allowed_temporarily_with_guard | Clasifica intent y tambien contiene replies visibles para FAQ/fallback/handoff/reset. | Medio: NLU redacta copy legacy. | Mantener solo interpretacion estructurada; migrar copy a renderer. |
| `src/lib/hotel/conversations/conversation-intelligence.ts` | legacy_allowed_temporarily_with_guard | Ayuda a precio/raza/fechas vagas y devuelve replies visibles. | Medio. | Convertir a interpretation/reducer hints; renderer decide copy. |
| `src/lib/hotel/conversations/client-templates.ts` | legacy_allowed_temporarily_with_guard | Templates reales de cliente y contrato. | Medio: templates son copy autorizado pero aun no cuelgan del renderer unico. | Mover detras de CopyRenderer con `render_template`. |
| `src/lib/hotel/conversations/template-preview.ts` | legacy_allowed_temporarily_with_guard | Preview de plantillas genera reply visible y route puede contestarlo antes de pipeline completo. | Medio: prerouter bypass. | Mantener por estabilidad; mover a policy `render_template`. |
| `src/lib/hotel/conversations/reservation-bridge.ts` | reducer_only / legacy_allowed_temporarily_with_guard | Confirma propuestas y produce replies de confirmacion/handoff. | Alto: confirmacion debe depender de tool/write success. | Mantener guardado por tests; extraer copy de confirmacion. |
| `src/lib/hotel/conversations/policy/policy-engine.ts` | policy_only | Shadow policy engine existente, ahora usado por autoridad pipeline. | Bajo. | Ampliar hasta ser unica decision. |
| `src/lib/hotel/conversations/client-requests.ts` | legacy_allowed_temporarily_with_guard | Copy y configuracion para recordatorios/followups. | Medio. | Pasar por renderer/outbox en jobs. |
| `src/lib/hotel/conversations/scheduled-messages.ts` | legacy_allowed_temporarily_with_guard | Construye payloads de mensajes programados. | Medio. | ToolExecutor/Outbox para envios reales. |
| `scripts/hotel-scheduled-jobs-lib.mjs` | legacy_allowed_temporarily_with_guard | Construye textos de prearrival/post-stay y puede enviar via Twilio mock/real segun env. | Alto en real mode. | Migrar a ToolExecutor + CopyRenderer + Outbox; mantener dry-run tests. |
| `src/lib/hotel/twilio/client.ts` | allowed_outbox | Cliente Twilio central de bajo nivel. | Bajo si solo recibe outbox autorizado. | No llamar desde conversation modules salvo outbox. |
| `src/app/api/conversations/[id]/reply/route.ts` | allowed_outbox / legacy_allowed_temporarily_with_guard | Reply manual del panel. | Medio: humano redacta, sistema envia. | Mantener como panel/manual; registrar como outbox manual. |
| FAQ helpers (`src/lib/hotel/knowledge/*`) | legacy_allowed_temporarily_with_guard | Resolucion FAQ puede traer copy/respuestas. | Medio. | Mantener contenido como knowledge source; CopyRenderer renderiza. |

## Bypasses bloqueados o congelados

- No se permite `client.messages.create` ni `messages.create` dentro de `src/lib/hotel/conversations/*`.
- Nuevos copies visibles fuera de `authority/pipeline.ts`, templates documentados o allowlist deben actualizar este audit y tests.
- Twilio webhook crea `NormalizedUserEvent` antes de reset/template/flujo.
- NLU estructurado del nuevo pipeline no expone campo `reply`.

## Allowlist temporal

Estas entradas son temporales y deben retirarse por fases:

- `src/app/api/twilio/whatsapp/route.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/service.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/reservation-flow.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/nlu.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/conversation-intelligence.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/client-templates.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/template-preview.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/reservation-bridge.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/client-requests.ts | legacy_allowed_temporarily_with_guard`
- `src/lib/hotel/conversations/scheduled-messages.ts | legacy_allowed_temporarily_with_guard`
- `scripts/hotel-scheduled-jobs-lib.mjs | legacy_allowed_temporarily_with_guard`

## Plan de retirada

1. Mover replies de `reservation-flow.ts` a `renderConversationReply`.
2. Convertir `nlu.ts` a interpretacion pura sin replies.
3. Cambiar `service.ts` para que devuelva `ConversationAction` + `RenderedConversationReply`.
4. Envolver template preview y degraded replies de Twilio en policy/renderer.
5. Migrar scheduled jobs a ToolExecutor + Outbox.
6. Cambiar guardrail de allowlist a bloqueo estricto por archivo.
