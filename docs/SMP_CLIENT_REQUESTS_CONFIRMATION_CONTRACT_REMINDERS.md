# SMP client requests: contract link, acceptance, confirmations, reminders

This branch adds a guarded WhatsApp reservation confirmation policy, real client
templates, and safe NLU diagnostics for Somos Muy Perros.

## Contract acceptance

- Contract URL: `https://somosmuyperros.com/contrato-de-admision-e-ingreso/`
- No PDF or media contract is sent by the bot.
- When `HOTEL_CONTRACT_ACCEPTANCE_REQUIRED=true`, a pending reservation is not
  confirmed until the customer explicitly answers `acepto` or an accepted
  equivalent.
- Generic confirmations such as `si`, `ok`, `vale` or `confirmo` are not enough
  to record contract acceptance.
- The acceptance metadata is copied into the pending proposal and projected into
  the reservation record after the sheet write succeeds.

## Confirmation template

The real confirmation template is emitted only after the reservation
confirmation bridge reports a successful reservation write and, when required,
after terms acceptance. Failed writes continue to return the existing safe
human-review copy and do not say that the reservation is confirmed.

If `HOTEL_CONFIRMATION_TEMPLATE_ENABLED=true` and no price is available, the
legacy/generic confirmation is blocked and the conversation is handed to the
team instead of inventing a price.

Central renderers live in `src/lib/hotel/conversations/client-templates.ts`:

- `renderReservationConfirmationTemplate`
- `renderReservationWelcomeIntroTemplate`
- `renderReservationDeniedTemplate`
- `renderPrearrivalReminderTemplate`
- `renderPostStayFollowupTemplate`
- `renderPositiveReviewRequestTemplate`
- `renderBathOfferTemplate`

## Reminder and followup jobs

The new prearrival reminder and post-stay followup selectors are disabled by
default and dry-run by default:

- `HOTEL_RESERVATION_REMINDERS_ENABLED=false`
- `HOTEL_RESERVATION_REMINDERS_DRY_RUN=true`
- `HOTEL_RESERVATION_REMINDER_ENABLED=false`
- `HOTEL_RESERVATION_REMINDER_DRY_RUN=true`
- `HOTEL_POST_STAY_FOLLOWUPS_ENABLED=false`
- `HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN=true`
- `HOTEL_POST_STAY_FOLLOWUP_ONLY_NEW_CLIENTS=true`

The scripts `npm run reminders:reservation-prearrival` and
`npm run followups:post-stay` print dry-run JSON and do not send WhatsApp
messages.

## NLU assistive safe

`/api/health` reports whether OpenAI is configured without exposing the key:

- `runtimeSafety.llmNlu.openaiConfigured`
- `runtimeSafety.llmNlu.modelConfigured`
- `runtimeSafety.llmNlu.assistiveSafe`
- `runtimeSafety.llmNlu.warning`

To enable an assistive-safe NLU mode manually in EasyPanel, configure:

- `HOTEL_LLM_NLU_ENABLED=true`
- `HOTEL_LLM_NLU_DECISION_MODE=assistive_safe`
- `HOTEL_LLM_NLU_SHADOW=false`
- `OPENAI_API_KEY=<manual secret>`
- `OPENAI_MODEL=<manual model>`

This branch does not set or print secrets and does not let NLU execute critical
actions. The backend state machine remains the authority for reservations,
contract acceptance, availability, prices, writes, modifications, and
cancellations.

## Out of scope

This branch does not deploy, does not change Twilio/Vercel/DNS settings, does
not touch secrets, and does not write to real Google Sheets.
