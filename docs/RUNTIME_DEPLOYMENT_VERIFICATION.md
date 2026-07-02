# Runtime Deployment Verification

Objetivo: confirmar sin secretos que EasyPanel sirve la rama y commit esperados antes de probar WhatsApp real.

## Build esperado

- Rama candidata anterior: `codex/smp-template-identity-kb-presales-quality-v0`
- Commit candidato anterior: `37675af7b5b36ccd826b8f757f912077aa578f58`
- Rama hotfix a desplegar: `codex/smp-runtime-store-empty-reply-template-verification-v0`

## Health seguro

Consultar `GET /api/health` y verificar:

- `app` = `hotel-canino-demo`
- `version` coincide con `package.json`
- `commitShort` no es `null` y coincide con el commit desplegado
- `branch` coincide con la rama desplegada, si EasyPanel expone la rama
- `build.buildMetadataConfigured` = `true`
- `persistence.conversationStoreProvider` es el proveedor esperado
- `persistence.databaseReachable` y `persistence.postgresSchemaReady` son `true` cuando el store de conversaciones es `postgres`
- `conversationStore.configured` = `true`
- `templates.rendererReady` = `true`
- `templates.templatesMapped.*` = `true`
- `runtimeSafety.latency.latencyInstrumentationEnabled` = `true`

El endpoint no debe exponer `DATABASE_URL`, tokens, private keys, spreadsheet ids ni credenciales.

## Si commit o branch salen null

El código acepta metadatos no sensibles desde estas variables, sin imprimir secretos:

- commit: `HOTEL_BUILD_COMMIT`, `GIT_COMMIT`, `EASYPANEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `COMMIT_SHA`, `SOURCE_COMMIT`
- branch: `HOTEL_BUILD_BRANCH`, `GIT_BRANCH`, `EASYPANEL_GIT_BRANCH`, `VERCEL_GIT_COMMIT_REF`, `BRANCH_NAME`, `SOURCE_BRANCH`

Si EasyPanel no inyecta ninguna, configurar para el próximo despliegue `HOTEL_BUILD_COMMIT` y `HOTEL_BUILD_BRANCH` con valores públicos de git.

## Validación tras despliegue manual

1. Desplegar la rama hotfix.
2. Consultar `/api/health`.
3. Confirmar `commitShort` y `branch`.
4. Probar WhatsApp real con:
   - `reiniciar`
   - `hola`
   - `plantilla confirmación` si preview está habilitado
   - `quiero reservar`
   - `info general`
   - `disponibilidad este finde`
5. Revisar logs de EasyPanel:
   - `conversation_id_derived`
   - `conversation_state_load_started`
   - `conversation_state_load_completed`
   - `conversation_state_save_started`
   - `conversation_state_save_completed`
   - `authority_turn_started`
   - `policy_decision`
   - `copy_rendered`
   - `outbox_sent`
   - `authority_turn_completed`
6. `empty_reply_prevented` no debe aparecer en conversaciones normales. Si aparece, el webhook ya no queda vacío, pero hay que revisar `fallbackReason` y `storeFailureMode`.

## Rollback

Si `/api/health` no responde o el commit no corresponde, volver a la última rama estable conocida antes de probar WhatsApp real. No tocar Twilio Console, DNS, Vercel, secretos ni Google Sheets para esta validación.
