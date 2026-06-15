# Somos Muy Perros source of truth

## Decision

`hotel-canino-demo` is the production repository for Somos Muy Perros. The current production baseline for this migration branch is `hotel-canino-demo@88754418eaf900f12c139a31ba09b8393752be44`.

`devestial-conversation-core-openai` is a reusable technical core and a read-only reference for this client. It is not the production destination for Somos Muy Perros, and this branch does not modify it.

## What lives in `hotel-canino-demo`

- Twilio WhatsApp webhook and current routing.
- Admin conversations panel, archive/restore behavior and polling.
- Conversation store abstraction and production conversation state.
- Google Sheets adapters for `CLIENTES`, confirmed reservations, monthly sheets and entry log.
- The current deterministic conversation intelligence, including price dates, breed handling, vague dates and `pendingPriceQuoteFlow`.

## What the core can inspire

- Structured OpenAI NLU design.
- Postgres-backed conversation models.
- Twilio idempotency patterns.
- Admin API boundaries.
- EasyPanel deployment documentation.
- Google Sheets as customer backoffice, not as the conversational brain.

The core should not be copied wholesale, deployed as the client product, or turned into a second source of truth.

## Storage boundary

Google Sheets remains the Somos Muy Perros backoffice for customer-visible operational records:

- `CLIENTES`.
- Confirmed reservations and monthly reservation sheets.
- Entry log / registro de entrada.

Google Sheets must not store:

- Conversation history.
- Message logs.
- Pending flows or large JSON snapshots.
- Archive/restore state for the conversations panel.

For EasyPanel production, `hotel-canino-demo` should use Postgres for conversations, messages, events, active conversation state, pending flows, panel archive state and Twilio MessageSid idempotency.
