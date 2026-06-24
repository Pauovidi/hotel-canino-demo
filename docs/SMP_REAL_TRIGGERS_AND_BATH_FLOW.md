# SMP real-ready triggers and bath flow

Fecha: 2026-06-24

## Auditoria

| Capacidad | Renderer existe | Job/trigger existe | Estado real-ready |
| --- | --- | --- | --- |
| Recordatorio 5 dias antes | Si, `renderPrearrivalReminderTemplate` | Si, `npm run reminders:reservation-prearrival` encola en `hotel_scheduled_messages` | Off por defecto, dry-run por defecto |
| Denegacion sin disponibilidad | Si, `renderReservationDeniedTemplate` | Si, conectado al resultado `availability=false` | Responde por webhook, waitlist off por defecto |
| Bano post-confirmacion | Si, `renderBathOfferTemplate` | Si, encola `bath_offer_after_confirmation` a `now + HOTEL_BATH_OFFER_DELAY_MINUTES` | Off por defecto, dry-run por defecto |
| Bano pelo largo/nudos/foto/recepcion | Si | Si, state machine en webhook | Deriva a recepcion, sin precio automatico |
| Post-estancia nuevos clientes | Si, `renderPostStayFollowupTemplate` | Si, `npm run followups:post-stay` encola en `hotel_scheduled_messages` | Solo nuevos clientes por defecto |
| Resena positiva | Si, `renderPositiveReviewRequestTemplate` | Si, solo tras respuesta positiva al follow-up | Negativo deriva a equipo |
| Preview plantillas | Si | Pre-router/stateless | No encola, no envia, no escribe Sheets |

## Cola programada

La migracion `db/migrations/005_scheduled_messages.sql` crea `hotel_scheduled_messages` con:

- `type`: `reservation_prearrival_reminder`, `post_stay_followup`, `bath_offer_after_confirmation`, `positive_review_request`, `reservation_denial_followup`.
- `status`: `pending`, `processing`, `sent`, `dry_run`, `failed`, `cancelled`, `skipped`.
- `dedupe_key` unico para idempotencia por reserva y tipo.
- `phone_hash` y `external_user_id`; los logs de jobs no imprimen telefono ni payload completo.

`npm run db:migrate:postgres` aplica la migracion. `npm run db:check:postgres` valida tambien la tabla de scheduled messages. `/api/health` sigue validando el schema critico del webhook/conversaciones para no dejar el arranque bloqueado por una migracion operativa pendiente.

## Flags

Dry-run seguro:

```env
HOTEL_SCHEDULED_MESSAGES_ENABLED=false
HOTEL_SCHEDULED_MESSAGES_DRY_RUN=true
HOTEL_BATH_OFFER_ENABLED=false
HOTEL_BATH_OFFER_DRY_RUN=true
HOTEL_RESERVATION_REMINDER_ENABLED=false
HOTEL_RESERVATION_REMINDER_DRY_RUN=true
HOTEL_POST_STAY_FOLLOWUP_ENABLED=false
HOTEL_POST_STAY_FOLLOWUP_DRY_RUN=true
HOTEL_WAITLIST_ENABLED=false
HOTEL_WAITLIST_DRY_RUN=true
```

Activacion real, solo con autorizacion:

```env
HOTEL_SCHEDULED_MESSAGES_ENABLED=true
HOTEL_SCHEDULED_MESSAGES_DRY_RUN=false
HOTEL_BATH_OFFER_ENABLED=true
HOTEL_BATH_OFFER_DRY_RUN=false
HOTEL_RESERVATION_REMINDER_ENABLED=true
HOTEL_RESERVATION_REMINDER_DRY_RUN=false
HOTEL_POST_STAY_FOLLOWUP_ENABLED=true
HOTEL_POST_STAY_FOLLOWUP_DRY_RUN=false
```

Parametros:

```env
HOTEL_BATH_OFFER_DELAY_MINUTES=2
HOTEL_RESERVATION_REMINDER_DAYS_BEFORE=5
HOTEL_POST_STAY_FOLLOWUP_DAYS_AFTER=1
HOTEL_POST_STAY_FOLLOWUP_ONLY_NEW_CLIENTS=true
```

## Crons EasyPanel recomendados

- `npm run jobs:dispatch-scheduled-messages`: cada 1 o 5 minutos.
- `npm run reminders:reservation-prearrival`: diario u horario.
- `npm run followups:post-stay`: diario.

Los scripts de seleccion solo encolan. El envio lo realiza el dispatcher respetando `*_ENABLED` y `*_DRY_RUN`.

## Eventos esperados

- `bath_offer_scheduled`
- `bath_offer_sent`
- `bath_offer_dry_run`
- `bath_declined`
- `bath_size_requested`
- `bath_price_quoted`
- `bath_photo_requested`
- `bath_photo_received`
- `bath_manual_review`
- `post_stay_positive_review_requested`
- `post_stay_negative_manual_review`
- `reservation_denied_template_sent`

## Rollback

Para desactivar sin deploy:

```env
HOTEL_SCHEDULED_MESSAGES_ENABLED=false
HOTEL_BATH_OFFER_ENABLED=false
HOTEL_RESERVATION_REMINDER_ENABLED=false
HOTEL_POST_STAY_FOLLOWUP_ENABLED=false
HOTEL_WAITLIST_ENABLED=false
```

No se usa `setTimeout` para logica productiva. Toda tarea diferida queda en Postgres con dedupe.
