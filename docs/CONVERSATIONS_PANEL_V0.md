# Panel de conversaciones V0/V0.3

## V0.3 Twilio WhatsApp real

La decision tecnica queda fijada: WhatsApp se integra mediante Twilio Programmable Messaging y WhatsApp Senders. No se implementa Meta Cloud API directa ni rutas `/api/meta/whatsapp`.

- El panel muestra `Proveedor: Twilio WhatsApp`.
- Estados visibles: `Mock`, `Sandbox` o `Real`.
- `TWILIO_MESSAGING_SERVICE_SID` es opcional y tiene precedencia sobre `TWILIO_WHATSAPP_FROM` para outbound.
- `TWILIO_WHATSAPP_FROM` soporta formato `whatsapp:+34...` o `+34...`.
- Si faltan credenciales o `HOTEL_CONVERSATIONS_MOCK_TWILIO=true`, el panel sigue en mock.
- Para numero real, registra el numero como WhatsApp Sender en Twilio y configura el webhook inbound contra `/api/twilio/whatsapp`.

## V0.2 UI + Twilio Sandbox

La pasada V0.2 pule el inbox y deja preparado el Sandbox de Twilio:

- Header operativo compacto con marca, estado `Modo demo`/`Twilio real` y accesos a chat web y admin de reservas.
- Sidebar mas densa: metricas, busqueda, filtros `Todas`, `Pendientes`, `Humano`, `Bot`, `Leidas` y seleccion clara.
- Detalle tipo chat con cabecera de contexto, timeline, eventos de sistema y composer sticky.
- Seed demo enriquecido con eventos `reservation_context_detected`, `human_requested`, `auto_reply_skipped_human_mode`, `manual_reply_sent` y `marked_read`.
- Webhook Twilio acepta `x-twilio-webhook-token`, `x-hotel-webhook-token` o `?token=` cuando `TWILIO_WEBHOOK_AUTH_TOKEN` esta configurado.
- Inbound media-only queda registrado como adjunto en lugar de descartarse si `Body` viene vacio.
- Retries de Twilio con el mismo `MessageSid` no duplican mensajes.
- Outbound Twilio real devuelve fallo controlado si hay error de red.

## V0.1 visible demo

La pasada V0.1 hace que el panel sea revisable sin preparar datos manuales:

- Acceso visible desde el header publico con `Panel conversaciones` y `Conversaciones`.
- Acceso visible desde `/admin` con `Abrir panel de conversaciones`.
- Inbox de dos columnas: sidebar con marca, metricas, filtros, busqueda y lista; detalle tipo chat con timeline, eventos y composer.
- Auto-seed demo en local/test/Vercel preview cuando la store esta vacia.
- Cinco conversaciones sinteticas del hotel canino: disponibilidad, handoff humano, comida, vacunas y cancelacion.
- Aviso visible de Twilio mock: `Modo demo: los mensajes no se envian por WhatsApp real.`
- Produccion sigue bloqueada sin `HOTEL_PANEL_USERNAME` y `HOTEL_PANEL_PASSWORD`.

## Arquitectura

El panel es aditivo y no toca la store demo de reservas. Las conversaciones viven en un subdominio separado:

- `src/lib/hotel/conversations/types.ts`: `Conversation`, `Message`, `ConversationEvent`.
- `src/lib/hotel/conversations/store.ts`: interfaz `ConversationStore`.
- `src/lib/hotel/conversations/file-store.ts`: store JSON con fallback durable `/data` en produccion.
- `src/lib/hotel/conversations/postgres-store.ts`: store Postgres para produccion con `DATABASE_URL`.
- `src/lib/hotel/conversations/service.ts`: inbound, handoff, modo bot/human, reply manual y mark-read.
- `src/lib/hotel/conversations/auth.ts`: Basic Auth del panel y APIs admin.
- `src/lib/hotel/twilio/client.ts`: outbound WhatsApp por Twilio REST o mock.

La persistencia de conversaciones ya soporta Postgres mediante `HOTEL_PERSISTENCE_PROVIDER=postgres`. El fallback por fichero debe apuntar a `/data` y solo sirve para produccion single-instance transitoria.

## Rutas UI

- `GET /admin/conversations`: inbox operativo con listado, filtros, detalle, timeline, cambio bot/human, mark-read y composer manual.
- Accesos visibles: header publico, navegacion demo y card en `/admin`.

## Rutas API

Todas las rutas admin requieren Basic Auth:

- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:id`
- `POST /api/conversations/:id/reply`
- `POST /api/conversations/:id/mode`
- `POST /api/conversations/:id/mark-read`
- `POST /api/conversations/:id/messages` alias para reply manual.
- `GET /api/conversations/events` para eventos agregados del panel.

Webhook inbound Twilio:

- `POST /api/twilio/whatsapp`

## Variables de entorno

Panel:

- `HOTEL_PANEL_USERNAME`
- `HOTEL_PANEL_PASSWORD`
- `HOTEL_PANEL_ALLOW_LOCAL_AUTH_BYPASS=true` solo para local si hace falta.

Sin credenciales, solo local/test o `HOTEL_PANEL_ALLOW_LOCAL_AUTH_BYPASS=true` permiten bypass. En produccion sin credenciales, el panel y las APIs admin quedan bloqueados.

Conversaciones:

- `HOTEL_PERSISTENCE_PROVIDER=postgres|file-volume|file-local`
- `DATABASE_URL` requerido si `HOTEL_PERSISTENCE_PROVIDER=postgres`
- `HOTEL_CONVERSATIONS_STORE_PATH` opcional para fallback fichero.
- `HOTEL_FILE_STORE_DIR=/data` recomendado para fallback fichero.
- `HOTEL_CONVERSATIONS_DEMO_SEED=true` o `HOTEL_CONVERSATIONS_SEED_DEMO=true` fuerza seed demo si la store esta vacia.

Auto-seed:

- Local/test: si la store esta vacia, se crean conversaciones demo sinteticas.
- Vercel preview: no hay auto-seed por defecto. Si la store esta vacia, el inbox muestra estado vacio limpio.
- Produccion: no hay auto-seed salvo opt-in explicito con `HOTEL_CONVERSATIONS_DEMO_SEED=true` o `HOTEL_CONVERSATIONS_SEED_DEMO=true`.

Twilio:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `TWILIO_MESSAGING_SERVICE_SID` opcional. Si se define, outbound usa `MessagingServiceSid` en vez de `From`.
- `TWILIO_STATUS_CALLBACK_URL` opcional para callbacks de estados Twilio.
- `TWILIO_WHATSAPP_PROVIDER_MODE=mock|sandbox|real` opcional para forzar el estado mostrado en panel.
- `TWILIO_VALIDATE_SIGNATURES` reservado para endurecer validacion.
- `TWILIO_WEBHOOK_AUTH_TOKEN` opcional. Si se define, el webhook exige `?token=`, header `x-twilio-webhook-token` o header `x-hotel-webhook-token`.
- `HOTEL_CONVERSATIONS_MOCK_TWILIO=true|false`

Si faltan credenciales Twilio o `HOTEL_CONVERSATIONS_MOCK_TWILIO=true`, el reply manual usa mock y no llama a Twilio. En produccion real, `TWILIO_WEBHOOK_AUTH_TOKEN` debe estar configurado o el webhook inbound responde 401.

Vercel preview:

- La preview puede estar protegida por Vercel Deployment Protection.
- Twilio no puede llamar una preview que responde 401.
- En local no hay `VERCEL_AUTOMATION_BYPASS_SECRET` exportado.
- El proyecto Vercel tiene Protection Bypass for Automation configurado; no se imprime ni se documenta el valor.
- Para Twilio Sandbox en preview protegida, usa plantilla:

  `https://hotel-canino-demo-devestial-devestial.vercel.app/api/twilio/whatsapp?x-vercel-protection-bypass=<VERCEL_AUTOMATION_BYPASS_SECRET>&token=<TWILIO_WEBHOOK_AUTH_TOKEN>`

- Si no se puede recuperar el bypass, usa una URL publica no protegida, desactiva temporalmente la proteccion de preview o configura el Sandbox contra produccion solo cuando el panel este protegido y validado.

## Configurar Twilio real

1. Define `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y `TWILIO_WHATSAPP_FROM` o `TWILIO_MESSAGING_SERVICE_SID`.
2. Pon `HOTEL_CONVERSATIONS_MOCK_TWILIO=false`.
3. Define `TWILIO_WEBHOOK_AUTH_TOKEN` para proteger inbound.
4. En Twilio Console entra en `Messaging` -> `Senders` -> `WhatsApp Senders`.
5. Confirma que el numero real aparece como WhatsApp Sender activo.
6. Configura `When a message comes in` con metodo `POST`:

   `https://<dominio-publico>/api/twilio/whatsapp?token=<TWILIO_WEBHOOK_AUTH_TOKEN>`

7. Si usas preview protegida con bypass de Vercel:

   `https://<preview>/api/twilio/whatsapp?x-vercel-protection-bypass=<masked>&token=<masked>`

8. `TWILIO_WHATSAPP_FROM` debe ser el remitente de WhatsApp de Twilio, por ejemplo `whatsapp:+34...` o `+34...`; no se hardcodea en codigo.

Al cambiar el webhook del Sandbox que antes apuntaba a otro proyecto, ese otro proyecto deja de recibir inbound desde ese Sandbox. Es reversible pegando de nuevo la URL anterior del campo `When a message comes in`.

`TWILIO_VALIDATE_SIGNATURES=true` queda reservado para validacion criptografica oficial de Twilio antes de produccion real con numero definitivo.

## Comportamiento bot/human

- Inbound en `mode=bot`: guarda inbound, incrementa no leidos y responde con la FAQ determinista del hotel.
- Frases de handoff como `persona`, `agente`, `humano`, `hablar con alguien`, `que me llamen`, `atencion` o `responsable`: cambia a `mode=human`, marca `humanRequested` y responde con copy seguro.
- Inbound en `mode=human`: guarda inbound, incrementa no leidos y registra `auto_reply_skipped_human_mode` sin respuesta automatica.
- Reply manual: envia por Twilio real o mock, guarda outbound humano, asigna agente y limpia no leidos.
- Fallo Twilio: no lanza 500 desde el servicio; registra `manual_reply_failed` y el panel muestra error.

## Seed demo

```bash
npm run hotel:conversations:seed
```

El seed incluye cinco conversaciones sinteticas del hotel canino: disponibilidad, handoff humano, comida, vacunas y cancelacion.

## Smoke Twilio Sandbox local

```bash
curl -X POST http://127.0.0.1:3000/api/twilio/whatsapp \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "From=whatsapp:+34600000001" \
  --data-urlencode "To=whatsapp:+14155238886" \
  --data-urlencode "Body=Hola, quiero hablar con una persona" \
  --data-urlencode "MessageSid=SM_SMOKE_001"
```

Debe devolver TwiML, crear o reutilizar conversacion, guardar inbound, activar `mode=human` si detecta handoff y hacerlo visible en `/admin/conversations`.

## Tests

```bash
npm run lint
npm run test:run
npm run build
npm run smoke
```

Para smoke HTTP local:

```bash
npm run dev
npm run smoke:http
```

Cobertura especifica preparada por `subagente_tests_security`:

- `src/lib/hotel/conversations/conversations-seed.test.ts`: contrato del seed, redaccion de email/telefono/token y escritura aislada.
- `src/lib/hotel/conversations/conversations-security.test.ts`: Basic Auth del panel, guardas `requirePanelAuth` en rutas admin, escape TwiML y rechazo del webhook Twilio con token invalido.
- `src/lib/hotel/security/secret-hygiene.test.ts`: `.gitignore` para secretos locales y comprobacion de que el seed no referencia `.env.local`, `.tokens/`, `.vercel/` ni service-account JSON.

Queda como `it.todo` convertir en test activo que `/admin/conversations` invoque `verifyPanelPageAccess` cuando el panel server-side pueda responder con challenge/redirect sin romper el render.

## EasyPanel / produccion

- Docker usa Next standalone y arranca con `node server.js`.
- Healthcheck: `GET /api/health`.
- `/admin`, `/admin/conversations`, `/internal`, `/ops` y `/api/ops/*` quedan protegidos por Basic Auth en produccion.
- Twilio inbound requiere `TWILIO_WEBHOOK_AUTH_TOKEN` en produccion.
- El payload Twilio persistido se reduce a campos whitelisted.
- Postgres es la via recomendada; `/data` es solo fallback single-instance.

## Limitaciones

- La migracion Postgres completa de reservas/email/reminders esta preparada en SQL, pero el codigo heredado todavia usa JSON durable `/data` como fase transitoria.
- No hay validacion criptografica de firma Twilio todavia; `TWILIO_WEBHOOK_AUTH_TOKEN` es una proteccion alternativa simple.
- El bot inbound usa FAQ/handoff seguro; no crea ni cancela reservas desde WhatsApp.
- El fallback `/data` no es multi-instancia ni transaccional.
# Actualización Client Directory V0

El panel de conversaciones ya muestra contexto seguro del directorio `CLIENTES`:

- `Cliente habitual` para match fuerte por teléfono/email.
- `Nuevo contacto` cuando no hay match o la pestaña no existe.
- `Revisión manual` para bloqueados o matches ambiguos.
- Alertas operativas como `NO COGER RESERVA`.

No se muestra NIF/DNI por defecto. La proyección al panel se limita a nombre, teléfono, email, estado, avisos y fila de `CLIENTES` si existe.
