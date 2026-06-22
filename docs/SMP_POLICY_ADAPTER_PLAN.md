# SMP Policy Adapter Plan

Fecha: 2026-06-22

## Objetivo

Preparar una autoridad conversacional interna sin crear un chatbot paralelo ni activar OpenAI
como decisor. El primer paso es shadow/backward-compatible.

## Normalized Inbound

Entrada normalizada:

- canal: `whatsapp`, `panel` o `internal`.
- identidad: telefono normalizado, display name, CLIENTES match.
- mensaje: texto redacted para logs, raw payload sanitizado.
- contexto: conversacion, modo, pending flows, propuestas y eventos recientes.

## State Reducer

Estado minimo:

- `mode`: bot/human.
- `clientStatus`: known/unknown/ambiguous/blocked.
- flows activos: reserva, modificacion, cancelacion, price quote.
- propuesta pendiente y expiracion.
- flags futuros: termsAccepted, confirmationTemplateSent, reminders/followups.

## Policy Decisions

La policy decide:

- ruta (`global_reset`, `reservation_confirmation`, `faq`, `fallback`, etc.).
- si puede responder el bot.
- si requiere exito de herramienta/backend antes de renderizar copy.
- motivo machine-readable para evento/test.

## Tool Intents

Herramientas operativas:

- confirmar reserva.
- escribir/actualizar Sheets via adapter.
- crear ReservationRecord.
- modificar/cancelar reserva.
- enviar WhatsApp outbound real o dry-run.
- programar recordatorio/follow-up.

## Copy Renderer

El renderer debe recibir decision + resultado de tool. Nunca debe renderizar confirmacion como
real si el tool fallo o esta en dry-run. FAQ y saludos pueden seguir deterministas.

## Outbound Persistido

Todo outbound visible debe pasar por `ConversationStore.addMessage` o evento equivalente.
En Twilio webhook, TwiML se genera desde el mensaje persistido o desde fallback seguro si el store
no esta disponible.

## Encaje Con PostgresConversationStore

Postgres es la fuente operativa para conversaciones, mensajes, eventos y pending state cuando esta
configurado. La policy no debe escribir directo a Postgres: debe usar el store existente para
mantener idempotencia y safe error tags.

## Encaje Con Google Sheets

Sheets sigue como backoffice/reservas. La policy solo debe permitir copy de confirmacion cuando el
adapter confirme exito real o cuando el modo dry-run sea explicito y visible como tal.

## Encaje Con CLIENTES

CLIENTES alimenta guardrails:

- `blocked`: humano/manual, no reserva automatica.
- `ambiguous`: aclaracion/humano, no inventar identidad.
- mascotas asociadas: si status seguro y una mascota, puede saltar pregunta de mascota.

## Reservas, Modificaciones Y Cancelaciones

Estos flujos deben quedar como tool intents con resultados tipados. Confirmacion, cambio y
cancelacion requieren exito real antes del copy definitivo.

## Structured NLU Posterior

OpenAI structured NLU puede entrar despues como interpretacion adicional OFF por defecto. No debe
ser decisor unico: la policy y guardrails deterministas conservan autoridad.

## Fases

1. Shadow policy en tests.
2. Renderer de copy critico.
3. Tool executor tipado.
4. Eventos auditables por decision.
5. Activacion por flags y golden tests.
