# Conversation Latency Runbook

Use this after an authorized deploy to identify whether WhatsApp latency is caused by OpenAI, database/store, CLIENTES/Sheets, persistence, or cold start. Do not disable NLU blindly.

## Logs To Search

- `authority_turn_timing_completed`: timing summary for an authority turn.
- `authority_turn_completed`: full sanitized authority trace with state/policy fields.
- `nlu_called` and `nlu_result_received`: deterministic NLU entry and result.
- `nlu_fast_path_skipped_quality_gate`: open presales query intentionally skipped the deterministic shortcut.
- `nlu_knowledge_base_match`: deterministic Knowledge Base match for safe business information.
- `nlu_provider_timeout_fallback_used`: OpenAI exceeded timeout and deterministic fallback was used.
- `authority_trace_event_dropped_best_effort`: non-critical trace write failed but reply continued.
- `twilio_webhook_store_failed`: conversation store failure path.

## How To Read A Timing Event

- High `totalDurationMs`: start with the largest stage field.
- High `nluProviderMs` plus `usedOpenAI=true`: OpenAI/provider or network is the likely cause.
- High `loadStateMs` with high `postgresReads`: DB read pressure or cold connection.
- High `persistenceMs` or `eventLogMs` with high `eventsWritten`: event trace write amplification.
- High `clientLookupMs` or `sheetsReads`: CLIENTES cache miss or Google Sheets latency.
- `traceDroppedBestEffort=true`: traces were not fully persisted, but the webhook should still reply.
- `timedOutStage=openai_responses`: timeout fallback protected the WhatsApp response.

## Safe Commands

Run from the app root in EasyPanel shell only after deploy is authorized:

```bash
npm run smoke:conversation:latency
npm run db:check:postgres
npm run smoke:conversation
```

For local validation, keep Sheets and Twilio mocked/disabled:

```bash
HOTEL_TWILIO_SEND_ENABLED=false HOTEL_SHEETS_WRITE_ENABLED=false HOTEL_SHEETS_DRY_RUN=true npm run smoke:conversation:latency
```

## Expected Local Targets

- Deterministic simple turns: ideally under 150 ms locally.
- Local/mock store turns: ideally under 300 ms locally.
- OpenAI real calls are not run by tests or smoke unless explicitly enabled with real credentials.
- Production depends on EasyPanel runtime, cold start, network, OpenAI and database latency.

## What Not To Do

- Do not disable NLU or conversational authority as a speed fix.
- Do not remove reset/cancel/FAQ escape hatches.
- Do not route open presales, mixed reservation/info, or informal availability queries to early generic handoff.
- Do not claim live availability unless the operational availability flow/tool has actually checked it.
- Do not remove critical state persistence before replying.
- Do not run real Sheets writes or real WhatsApp sends during diagnostics.
- Do not expose raw traces, secrets or message bodies in public endpoints.

## Deployment Instructions

1. Deploy the hotfix branch only after all local validations pass.
2. Confirm `/api/health` returns `ok: true`.
3. In `/api/health`, inspect only non-sensitive flags under `runtimeSafety.latency` and `runtimeSafety.llmNlu`.
4. Run the manual WhatsApp QA transcript:
   - `hola`
   - `pues quería reservar`
   - `PIPUCHI`
   - `¿para mañana podría ser?`
   - `a las 10`
   - `pues pasado mañana a la misma hora`
   - `diferencia entre hotel y guardería`
   - `ya no quiero reservar`
5. Search timing logs and classify the slowest stage before changing any runtime flag.
