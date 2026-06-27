# Conversation Bypass Audit

Fecha: 2026-06-27

Base de trabajo: `codex/smp-conversation-authority-complete-migration-v0` desde `a9bc4c017dede0190252b86f4b84fd4386da0996`.

Clasificaciones:

- `renderer_only`: redacta respuesta visible desde `CopyRenderer`.
- `reducer_only`: fusiona estado/slots sin redactar copy.
- `policy_only`: decide accion sin redactar copy.
- `outbox_only`: convierte una salida renderizada en mensaje/canal.
- `keep_temporarily_with_reason`: excepcion legacy acotada, con motivo, riesgo y test.
- `migrate_now`: migrado en esta rama o bloqueado por guardrail.

## Hallazgos Priorizados

| Archivo | Clasificacion | Copy visible | Next action | Tool critica | Accion |
| --- | --- | --- | --- | --- | --- |
| `src/lib/hotel/conversations/authority/copy-renderer.ts` | `renderer_only` | Si, fuente canonica de copy conversacional. | No. | No. | Nuevo punto unico para copy de NLU, reserva, reset, handoff, baño/post-stay y degradados seguros. |
| `src/lib/hotel/conversations/authority/pipeline.ts` | `policy_only` / `reducer_only` / `outbox_only` | Solo via `renderCopy`. | Si: `decideNextConversationAction` y `decideReservationAction`. | No ejecuta tools. | Incluye `reduceReservationState`, policy de reserva y `buildOutboxMessage`. |
| `src/lib/hotel/conversations/reservation-flow.ts` | `reducer_only` + `renderer_only` adapter | No debe contener frases visibles de negocio; los `reply` de compatibilidad salen de `renderReservationFlowCopy`. | Aun conserva stage decisions del flujo. | `checkAvailability` sigue aqui temporalmente. | `migrate_now` hecho para copy. Pendiente separar disponibilidad a ToolExecutor. Tests: bridge golden + authority guardrails. |
| `src/lib/hotel/conversations/nlu.ts` | `policy_only` interpretation adapter | No contiene respuestas visibles hardcodeadas ni campo publico `reply`; devuelve `renderKey` para `CopyRenderer`. | Clasifica intent, handoff y routing FAQ/quote. | No. | `migrate_now` hecho para copy hardcoded y contrato sin `reply`. Tests: NLU + guardrails. |
| `src/lib/hotel/conversations/service.ts` | `keep_temporarily_with_reason` | Salida bot automatica pasa por `addRenderedBotMessage` y eventos `copy_rendered`/`outbox_sent`. | Si: orquestador principal. | Si: confirmacion, schedule, stores. | Mantener temporalmente por compatibilidad. Riesgo: mezcla policy/tool. Eliminacion: siguiente rama ToolExecutor. Tests: service + WhatsApp bridge. |
| `src/app/api/twilio/whatsapp/route.ts` | `outbox_only` + `keep_temporarily_with_reason` | Degraded reply sale de `CopyRenderer`; preview stateless sigue como guard previo documentado. | Auth/parse/reset/preview prerouter. | No escribe reservas. | Mantener reset/preview como hard guards. Riesgo: TwiML adapter aun vive aqui. Tests: conversations-security. |
| `src/lib/hotel/conversations/conversation-intelligence.ts` | `keep_temporarily_with_reason` | Aun genera copy de quote/fechas vagas/raza. | Interpreta precio/raza/fechas. | No. | Pendiente mover builders a CopyRenderer. Riesgo medio. Tests: service + nlu price/breed. |
| `src/lib/hotel/conversations/reservation-bridge.ts` | `keep_temporarily_with_reason` | Aun genera copy de confirmacion/fallo. | Decide confirmacion segura. | Si: Sheets/ReservationRecords/CLIENTES. | Pendiente ToolExecutor + renderer de confirmacion. Riesgo alto si se toca sin tests. Tests: bridge contract/confirmation/no availability. |
| `src/lib/hotel/conversations/template-preview.ts` | `keep_temporarily_with_reason` | Preview autorizado de plantillas. | Detecta comandos preview. | No. | Mantener por estabilidad; debe pasar a `render_template`. Tests: template-preview + route. |
| `src/lib/hotel/conversations/client-templates.ts` | `renderer_only` authorized template layer | Si, plantillas reales autorizadas. | No. | No. | Permitido como capa de plantillas llamada por renderer/preview/jobs. |
| `src/lib/hotel/conversations/scheduled-messages.ts` | `keep_temporarily_with_reason` | Construye payloads programados. | Dedupe/dispatch. | Puede enviar via Twilio segun flags. | Mantener con dry-run/no-op tests; siguiente migracion a Outbox scheduled. |
| `scripts/hotel-scheduled-jobs-lib.mjs` | `keep_temporarily_with_reason` | Construye textos job. | Seleccion jobs. | Puede usar Postgres/Twilio segun env. | Mantener con dry-run/no-op. Riesgo alto solo en real mode. |

## Allowlist Final Temporal

- `src/lib/hotel/conversations/service.ts | keep_temporarily_with_reason | monolith_orchestrator_until_tool_executor | tests: service.test.ts, whatsapp-reservation-bridge.test.ts | remove_by: next_authority_tool_executor_branch`
- `src/app/api/twilio/whatsapp/route.ts | keep_temporarily_with_reason | auth_reset_template_preview_twiML_adapter | tests: conversations-security.test.ts, template-preview.test.ts | remove_by: channel_outbox_adapter_branch`
- `src/lib/hotel/conversations/conversation-intelligence.ts | keep_temporarily_with_reason | price_breed_vague_date_copy_builders | tests: nlu.test.ts, service.test.ts | remove_by: quote_renderer_branch`
- `src/lib/hotel/conversations/reservation-bridge.ts | keep_temporarily_with_reason | confirmation_tool_success_contract | tests: whatsapp-reservation-bridge.test.ts | remove_by: reservation_tool_executor_branch`
- `src/lib/hotel/conversations/template-preview.ts | keep_temporarily_with_reason | stateless_preview_guard | tests: template-preview.test.ts, conversations-security.test.ts | remove_by: render_template_policy_branch`
- `src/lib/hotel/conversations/scheduled-messages.ts | keep_temporarily_with_reason | scheduled_outbox_not_migrated | tests: scheduled-messages.test.ts, dry-run jobs | remove_by: scheduled_outbox_branch`
- `scripts/hotel-scheduled-jobs-lib.mjs | keep_temporarily_with_reason | mjs_job_runtime_parallel_path | tests: dry-run jobs | remove_by: scheduled_outbox_branch`

## Retirado De Allowlist Legacy

- `src/lib/hotel/conversations/reservation-flow.ts`: copy visible hardcoded migrado a `CopyRenderer`; sigue como reducer/stage adapter con `reply` de compatibilidad.
- `src/lib/hotel/conversations/nlu.ts`: respuestas visibles hardcoded migradas a `CopyRenderer`; el plan NLU ya no expone `reply`, `replyText`, `message`, `botReply` ni `visibleText`.
- `src/lib/hotel/conversations/client-templates.ts`: capa de plantillas autorizada, no bypass arbitrario.

## Guardrails Activos

- No se permite `client.messages.create` ni `messages.create` dentro de `src/lib/hotel/conversations/*`.
- `reservation-flow.ts` no puede introducir frases visibles de negocio fuera de `renderReservationFlowCopy`.
- `nlu.ts` no puede reintroducir respuestas visibles hardcoded como fallback/handoff/reserva/reset.
- `nlu.ts` no puede reintroducir campo `reply:` en `ConversationReplyPlan`.
- La salida bot automatica de `service.ts` debe usar `addRenderedBotMessage` o `addRenderedBotMessageBestEffort`.
- Twilio route debe usar `CopyRenderer` para degraded copy y solo adaptar a TwiML.
- Nuevas excepciones deben añadir motivo, riesgo, fecha/branch de eliminacion y test.
