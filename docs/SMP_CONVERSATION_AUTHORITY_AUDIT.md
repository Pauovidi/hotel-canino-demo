# SMP Conversation Authority Audit

Fecha: 2026-06-22

## Alcance

Auditoria del runtime conversacional de `hotel-canino-demo` sin deploy y sin convertir
`devestial-conversation-core-openai` en repo productivo. El core queda como referencia
read-only.

## Flujo Actual

1. `/api/twilio/whatsapp` valida el webhook y normaliza payload Twilio.
2. El comando global `reiniciar` se atiende antes del lookup y antes del store normal.
3. La ruta hace lookup de CLIENTES para degradacion segura si el store falla.
4. `handleInboundWhatsApp` persiste inbound, resuelve identidad, modo y NLU determinista.
5. El servicio decide entre reset, modo humano, cliente bloqueado/ambiguo, cambios/cancelaciones,
   reserva, price quote, FAQ/media y fallback.
6. Los flujos operativos escriben outbound y eventos en `ConversationStore`.
7. La confirmacion de reserva pasa por `confirmPendingReservationProposal`, revalida disponibilidad,
   escribe reserva mediante adapter y solo entonces devuelve copy de confirmacion.

## Puntos Donde Se Genera Copy Visible

- `src/app/api/twilio/whatsapp/route.ts`: TwiML, degradacion por store y respuestas stateless.
- `src/lib/hotel/conversations/service.ts`: orquestacion principal, modo humano, fallback,
  price quote, FAQ, reset y confirmacion.
- `src/lib/hotel/conversations/nlu.ts`: FAQ public chat, saludos, reset y copy base de NLU.
- `src/lib/hotel/conversations/reservation-flow.ts`: recogida de datos, disponibilidad y propuesta.
- `src/lib/hotel/conversations/reservation-bridge.ts`: propuesta y confirmacion de reserva.
- `src/lib/hotel/conversations/reservation-change-flow.ts`: modificacion/cancelacion.
- `src/lib/hotel/conversations/conversation-intelligence.ts`: precio, raza y fechas vagas.
- `src/app/api/conversations/**`: panel, replies manuales, reset y media mock.

## Rutas Que Saltan Una Policy Central

No hay una autoridad central unica. La autoridad esta distribuida entre Twilio route,
`service.ts`, NLU determinista, flujos de reserva/cambio y degradacion por store. Esto funciona,
pero hace dificil probar precedencia y copy final como una politica.

## Riesgos Concretos

- Fallback generico: puede ocultar causa operativa si no se preservan safe error tags.
- Confirmacion sin exito real: mitigada en `reservation-bridge`, pero debe seguir como regla central.
- Templates legacy compitiendo: existen templates de email/WhatsApp y copy de conversacion.
- Cliente bloqueado aceptado: mitigado por guardrails de CLIENTES, debe quedar antes de reserva.
- NIF/DNI/PII visible: hay redaccion en payload conversacional, debe mantenerse en logs/eventos.
- `confirmo` mal gestionado: debe depender de propuesta viva y backend OK.
- `reiniciar` por debajo de guards: ya esta como global en Twilio y NLU, debe seguir primero.
- Media/video: debe evitar fingir almacenamiento/envio si no hay herramienta real.
- Modo humano: debe suprimir autorespuesta salvo retorno explicito a bot.

## Plan De Migracion Por Fases

1. Shadow policy: mantener comportamiento actual y clasificar rutas en tests.
2. Copy renderer: mover textos criticos a renderers testeables sin cambiar mensajes.
3. Tool executor: envolver confirmacion, cambios, recordatorios y media en resultados tipados.
4. Policy central: hacer que `service.ts` consulte policy para precedencia, en modo audit primero.
5. Structured NLU: integrar OpenAI solo como interpretacion estructurada OFF por defecto.
6. Cutover gradual: activar por flags con golden tests multiturbo y smoke local/mock.

## Estado De Este Cambio

Se introduce un `policy-engine` shadow usado solo en tests. No cambia runtime visible por defecto.
