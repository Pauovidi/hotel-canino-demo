# EasyPanel/Postgres migration plan

This branch prepares `hotel-canino-demo` to run in EasyPanel with Postgres in parallel. It does not deploy, change webhooks, change DNS, or cut over production traffic.

## Current readiness

- `Dockerfile` builds a Next.js standalone image and runs `node server.js` on `PORT`, default `3000`.
- `next.config.ts` uses `output: "standalone"`.
- `/api/health` reports safe booleans and provider names only. It does not print `DATABASE_URL`, Twilio tokens, Google credentials or sheet IDs.
- `db/migrations` contains the conversation tables used by `PostgresConversationStore`.
- `npm run db:migrate:postgres` applies migrations against the configured Postgres database.
- `npm run db:check:postgres` verifies `SELECT 1` plus the required conversation tables and columns.

## EasyPanel variables

Non-secret values:

```env
APP_ENV=production
NODE_ENV=production
HOTEL_RUNTIME_TARGET=easypanel
HOTEL_PERSISTENCE_PROVIDER=file-volume
HOTEL_CONVERSATIONS_STORE=postgres
HOTEL_CLIENTS_SOURCE=google_sheets
HOTEL_RESERVATIONS_SOURCE=google_sheets
HOTEL_ENTRY_LOG_SOURCE=google_sheets
HOTEL_SHEETS_WRITE_ENABLED=false
HOTEL_SHEETS_DRY_RUN=true
HOTEL_LLM_NLU_ENABLED=false
HOTEL_LLM_NLU_SHADOW=true
HOTEL_LLM_NLU_DECISION_MODE=shadow
HOTEL_TIMEZONE=Europe/Madrid
TWILIO_WEBHOOK_AUTH_ENABLED=true
PORT=3000
```

Secret or manually protected values:

- `DATABASE_URL`.
- `OPENAI_API_KEY` when a later NLU branch activates it.
- `TWILIO_WEBHOOK_AUTH_TOKEN`.
- `HOTEL_PANEL_USERNAME` / `HOTEL_PANEL_PASSWORD` or `ADMIN_API_KEY`, depending on the selected admin guard.
- `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`.
- Google Sheet IDs if treated as sensitive in the hosting panel.
- Any value whose name includes `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `AUTH`, `CREDENTIAL` or `PRIVATE`.

Do not paste real values into git.

## Conversation store

Set `HOTEL_CONVERSATIONS_STORE=postgres` for EasyPanel. The older `HOTEL_CONVERSATIONS_STORE_PROVIDER` remains supported and takes precedence for compatibility.

Postgres stores:

- Conversations.
- Messages.
- Events.
- Conversation payload/state, including pending reservation, modification, cancellation and price quote flows.
- `mode` bot/human.
- Archive metadata.
- `updated_at`.
- Twilio MessageSid idempotency through the unique `external_message_sid` index.

Google Sheets remains for `CLIENTES`, confirmed reservations/monthly sheets and entry log. It must not be used as the conversation store in EasyPanel production.

## Safe local sequence

1. Build the image locally or in EasyPanel from this repo branch.
2. Provision Postgres in EasyPanel.
3. Configure variables, keeping Sheets writes disabled.
4. Run `npm run db:migrate:postgres` with EasyPanel's configured database.
5. Run `npm run db:check:postgres`.
6. Restart/redeploy the service in parallel without changing the real Twilio webhook.
7. Check `/api/health`; expect `persistence.conversationStoreProvider=postgres`, `databaseUrlConfigured=true`, `databaseReachable=true`, `postgresSchemaReady=true` and `ready=true`.
8. Use a Twilio sandbox or isolated webhook URL for validation.

## Cutover guardrails

- No Vercel production changes in this branch.
- No DNS changes.
- No Twilio Console changes.
- No Meta Console changes.
- No real Sheets writes or backfills.
- No production webhook switch until the parallel EasyPanel instance passes health, panel, webhook and rollback checks.
