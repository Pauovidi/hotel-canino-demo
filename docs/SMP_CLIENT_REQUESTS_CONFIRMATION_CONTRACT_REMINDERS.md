# SMP client requests: contract link, acceptance, confirmations, reminders

This branch adds a guarded WhatsApp reservation confirmation policy for Somos Muy
Perros.

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

The confirmation template is emitted only after the reservation confirmation
bridge reports a successful sheet write. Failed writes continue to return the
existing safe human-review copy and do not say that the reservation is confirmed.

## Reminder and followup jobs

The new prearrival reminder and post-stay followup selectors are disabled by
default and dry-run by default:

- `HOTEL_RESERVATION_REMINDERS_ENABLED=false`
- `HOTEL_RESERVATION_REMINDERS_DRY_RUN=true`
- `HOTEL_POST_STAY_FOLLOWUPS_ENABLED=false`
- `HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN=true`

The scripts `npm run reminders:reservation-prearrival` and
`npm run followups:post-stay` print dry-run JSON and do not send WhatsApp
messages.

## Out of scope

This branch does not deploy, does not change Twilio/Vercel/DNS settings, does
not touch secrets, and does not write to real Google Sheets.
