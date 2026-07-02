# Runtime Store Empty Reply Incident

## Síntomas observados

En logs de EasyPanel se observaron:

- `normalized_user_event_created` con `hasConversationId:false`
- `currentMode: undefined`
- `pendingFields: []`
- `twilio_webhook_store_failed`
- `twilio_degraded_due_to_conversation_store`
- `degraded_without_client_identity`
- `twilio_webhook_reply_built { hasBotReply:false, hasTwimlMessage:false }`
- `twilio_webhook_twiml_sent { status:200, contentType:"text/xml" }`
- timings de rama normal de aproximadamente 3 a 5 segundos

El riesgo era que Twilio recibiera `200 text/xml` con `<Response></Response>` aunque el usuario hubiera enviado texto válido.

## Causa raíz confirmada en código

La ruta normal de Twilio resolvía el resultado del servicio con `resolveTwilioWebhookTwiml(result)`. Si el servicio devolvía un resultado sin `botReply` ni `twiml`, `buildTwilioMessageResponse()` construía TwiML vacío. La ruta lo enviaba igualmente como `200`.

Había dos silencios legítimos que quedaban indistinguibles de un fallo:

- reintento duplicado por `MessageSid`
- conversación en modo humano con auto-respuesta suprimida

El log `hasConversationId:false` se emitía antes de consultar o crear el record persistido. Por tanto, no probaba por sí solo que el store hubiera perdido el id real, pero sí hacía imposible distinguir pre-store de post-store.

## Correcciones

- Se añadió `conversationTraceId` derivado y enmascarado desde `From` antes de tocar el store.
- `normalized_user_event_created` ahora indica `conversationIdSource`.
- El servicio devuelve `allowEmptyTwiml` y `noReplyReason` para silencios explícitos.
- El webhook aplica `ensureNonEmptyTwilioReply` en la rama normal.
- Si llega texto válido y el resultado no trae `<Message>`, se emite `empty_reply_prevented` y se responde con CopyRenderer `service.store_degraded_critical`.
- Los errores de store se loguean como `conversation_state_store_failed` con `safeErrorCode` y proveedor, sin secretos.
- Las operaciones de store se trazan con `conversation_state_load_*` y `conversation_state_save_*`.
- Los eventos de autoridad clave también salen por logs sanitizados: `authority_turn_started`, `policy_decision`, `copy_rendered`, `outbox_sent`, `authority_turn_completed`.
- `/api/health` expone metadata no sensible de build, store, Postgres, templates y latencia.

## Validación local

Ejecutar:

- `npm run lint`
- `npm run test:run`
- `npm run build`
- `npm run smoke:conversation`
- `npm run smoke:conversation:latency`
- `npm run smoke:templates`
- `npm run smoke:identity`

Los smokes nuevos no envían WhatsApp ni escriben Google Sheets reales.

## Validación manual tras despliegue

1. Desplegar `codex/smp-runtime-store-empty-reply-template-verification-v0`.
2. Verificar `/api/health` y `commitShort`.
3. Enviar por WhatsApp:
   - `reiniciar`
   - `hola`
   - `quiero reservar`
   - `plantilla confirmación` si preview está habilitado
4. Revisar que cada respuesta de texto válido tenga `<Message>`.
5. Revisar logs:
   - `conversation_id_derived`
   - `conversation_state_load_completed`
   - `authority_turn_completed`
   - `copy_rendered`
   - `outbox_sent`
6. `empty_reply_prevented` solo debería aparecer ante un fallo real de pipeline/store.

## Rollback recomendado

Si `/api/health` falla, si `persistence.ready` es `false` para Postgres, o si el webhook vuelve a emitir `emptyReplyPrevented` de forma repetida en conversaciones normales, hacer rollback a la rama estable temporal y revisar store/migraciones antes de reintentar. No tocar Twilio Console, DNS, secretos ni Google Sheets reales para este hotfix.
