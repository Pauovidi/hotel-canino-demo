# Conversation Authority Contract

Este contrato es vinculante para Somos Muy Perros. Todo cambio conversacional debe respetar esta cadena de autoridad:

Inbound normalizado -> NLU/LLM structured interpretation -> StateReducer -> Conversation Policy Engine / Dialogue Manager -> ToolExecutor -> CopyRenderer -> Outbox / canal

## Regla de oro

- NLU/LLM interpreta, pero no decide ni redacta.
- StateReducer fusiona estado, pero no redacta.
- Conversation Policy Engine decide la siguiente accion, pero no redacta texto final.
- ToolExecutor ejecuta herramientas autorizadas, pero no decide conversacion.
- CopyRenderer es el unico que redacta respuesta visible.
- Outbox/canal solo envia lo que produjo CopyRenderer.

## Objetos obligatorios

`NormalizedUserEvent` debe existir antes de tocar flujos de dominio:

- `conversationId`
- `externalUserId`
- `channel`
- `messageText`
- `media`
- `timestamp`
- `currentMode`
- `currentState`
- `clientStatus`
- `lastBotAction`
- `lastBotQuestionKind`
- `pendingFields`
- `source`
- `metadata` segura

`StructuredConversationInterpretation` debe contener:

- `intent`
- `globalIntent`
- `domainIntent`
- `slots`
- `targetSlots`
- `correction`
- `cancellation`
- `faqIntent`
- `handoffIntent`
- `confidence`
- `safety`
- `rawUnsupported`

La interpretacion no puede contener copy visible para usuario ni instrucciones de envio.

## Responsabilidades

### Inbound normalizado

Los webhooks, panel y jobs convierten la entrada a `NormalizedUserEvent`. El webhook de Twilio puede validar token y parsear payload, pero no debe decidir conversacion.

### NLU/LLM structured interpretation

El NLU recibe contexto y produce JSON estructurado. OpenAI puede ayudar a interpretar, pero no puede confirmar reservas, redactar texto final, escribir en Sheets, inventar disponibilidad ni saltar modo humano.

Si OpenAI falla, se usa fallback determinista y se registra `nlu_assistive_failed_fallback_used`.

### StateReducer

El reducer es la unica capa que cambia estado conversacional:

- fusiona slots oportunistas;
- asigna targets por `pendingFields`;
- conserva estado valido;
- invalida propuestas stale si cambian fecha, hora o mascota;
- cancela flujo si el usuario cancela;
- conserva flujo tras FAQ;
- no borra cliente/mascota salvo reset explicito;
- devuelve `appliedSlotNames`, `ignoredSlotNames` y `nextMissingFields`.

No redacta texto visible.

### Conversation Policy Engine / Dialogue Manager

La policy decide acciones estructuradas:

- `ask_missing_slot`
- `answer_faq_then_resume`
- `cancel_flow`
- `handoff_to_human`
- `propose_reservation`
- `request_contract_acceptance`
- `confirm_reservation`
- `render_template`
- `call_tool`
- `schedule_message`
- `fallback_contextual`
- `suppress_reply`

Debe validar cliente bloqueado/ambiguo, `mode=human`, disponibilidad real, precio real, terminos aceptados, exito de herramientas, dry-run/real y dedupe.

### ToolExecutor

Toda accion critica debe pasar por tool autorizado y devolver resultado verificable antes de que la policy permita copy de exito. Incluye disponibilidad, escritura de reserva, cancelacion/modificacion, scheduled messages y envios externos.

### CopyRenderer

CopyRenderer es el unico que redacta respuesta visible. Mientras dure la migracion, una excepcion solo puede salir si esta marcada como `keep_temporarily_with_reason` en `docs/CONVERSATION_BYPASS_AUDIT.md`, con motivo, riesgo, rama de eliminacion y tests.

### Outbox / canal

Outbox recibe `RenderedConversationReply` y produce `OutboxMessage`. El adaptador de canal convierte a TwiML, API Twilio o panel, sin inventar textos.

## Prohibido

- Route handlers generando copy visible directamente, salvo errores de auth/empty safe documentados.
- `reservation-flow` generando copy final fuera de renderer sin allowlist temporal.
- FAQ bridge respondiendo fuera de policy/copy.
- Fallbacks visibles fuera de CopyRenderer.
- Tools ejecutando acciones criticas sin policy.
- Twilio/TwiML montando textos fuera de Outbox/Renderer.
- OpenAI produciendo texto final para el usuario.
- `mode=human` saltado por rutas automaticas.
- Confirmar reservas sin write/tool success real.
- Inventar disponibilidad, precio o estado.

## Eventos seguros

Eventos esperados:

- `normalized_user_event_created`
- `nlu_called`
- `nlu_result_received`
- `nlu_slots_extracted`
- `nlu_slots_applied`
- `nlu_slots_ignored`
- `state_reducer_applied`
- `policy_decision`
- `tool_called`
- `tool_result`
- `copy_rendered`
- `outbox_sent`
- `global_intent_escape`
- `loop_prevented`
- `legacy_bypass_blocked`

`AuthorityTurnTrace` agrupa esos eventos por turno y debe permitir reconstruir `state_before`, slots extraidos/aplicados/ignorados, `pendingFieldsAfter`, accion de policy, `renderKey`, outbox y si hubo bypass legacy.

No se deben registrar telefonos completos, secretos ni texto libre con PII salvo payloads ya sanitizados.

## Migracion progresiva

El contrato se aplica desde esta rama con:

- `src/lib/hotel/conversations/authority/*` como nucleo del pipeline.
- Twilio webhook normalizando a `NormalizedUserEvent` antes de reset/template/flujo.
- Guardrails que documentan y congelan bypasses legacy permitidos.
- Tests que verifican que NLU estructurado no incluye copy visible.

Todo bypass legacy debe migrarse o quedar documentado con motivo, riesgo y plan de retirada.
