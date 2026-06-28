# Conversation Latency Audit

Scope: WhatsApp webhook and conversational authority pipeline. This audit is based on the production branch `codex/smp-authority-turn-trace-state-consistency-v0` and the hotfix instrumentation branch. It does not include production measurements.

| Stage | Function/file | Sync | External call | Expected cost | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| Twilio auth | `src/app/api/twilio/whatsapp/route.ts` `validateWebhookToken` | sync | no | low | Invalid token blocks early. | Keep first and record `routeAuthMs`. |
| Request parse | `route.ts` `request.formData()` / `request.json()` | async | no | low-medium | Large media payload metadata can add parse cost. | Record `parseMs`; keep media body fallback compact. |
| Reset prerouter | `route.ts` + `handleGlobalResetCommand` | async | store only | medium | Must beat all fallbacks. | Keep before preview, NLU, FAQ, human mode and fallback. |
| Template preview prerouter | `route.ts` `buildTemplatePreviewWebhookTwiml` | sync | no | low | Preview errors must not block webhook. | Keep stateless and catch failures. |
| Conversation load/create | `service.ts` `getOrCreateConversation` | async | Postgres/file/Sheets store | medium-high | Multiple `getById` calls amplify Postgres latency. | Trace `loadStateMs`, `postgresReads`, `sheetsReads`; reduce redundant reads where safe. |
| Client directory lookup | `service.ts` `resolveAndPersistClientIdentity` | async | Google Sheets when real directory cache misses | medium-high | Route previously looked up CLIENTES before service, duplicating work on happy path. | Route now looks up only for degraded fallback; service skips lookup for strong known identity. |
| Deterministic NLU | `nlu.ts` `buildConversationReplyPlan` | sync | no | low | Repeated FAQ/intelligence parsing adds CPU. | Reuse FAQ match and already computed intelligence slots. |
| Assistive NLU | `service.ts` `buildAssistiveNluEvents` | async | OpenAI when explicitly enabled and configured | variable | Slow OpenAI can delay replies. | Keep timeout/circuit breaker; deterministic high-confidence slots skip OpenAI assistive call. |
| Reducer | `reservation-flow.ts` via `advanceReservationFlow` | async | possible sheet adapter in later proposal/confirmation | medium | Date/slot parsing can repeat. | Record `reducerMs`; future work can pass per-turn parse context. |
| Policy | `policy-engine.ts` and service branches | sync | no | low | Wrong ordering can route to fallback/human. | Keep reset/cancel/FAQ escape hatches before generic fallback. |
| Tools | `reservation-bridge.ts` confirmation/change flows | async | Sheets, reservation records, client upsert | high | Real writes must never run in tests. | Trace `toolsMs` when expanded; current safe tests use mocks/dry-run. |
| Renderer | `authority/copy-renderer.ts` and `renderConversationReplyPlan` | sync | no | low | Copy must stay centralized. | Keep renderer contract; trace `rendererMs` where authority trace exists. |
| Persistence/events | `service.ts` `addSafeEvents`, `addRenderedBotMessage` | async | store | high | Event traces are written sequentially and Postgres `addEvent` rereads/rewrites record. | Trace events are best-effort; future safe optimization is batched append in store layer. |
| Outbox/TwiML | `buildTwilioMessageResponse` | sync | no | low | Late construction hides total response cost. | Record `twimlBuildMs` from route/service timing hints. |
| Scheduled/background work | job entrypoints/scripts | async | possible store/Sheets/Twilio | high if loaded accidentally | Heavy job modules must not be pulled into webhook path. | Keep job scripts out of route imports; run dry-run job validations separately. |

## Evidence Found

- The route resolved client identity for fallback context and then `handleInboundWhatsApp` resolved and persisted client identity again. This duplicated CLIENTES reads/cache scans on successful turns.
- `addSafeEvents` wrote trace events sequentially. On Postgres each `addEvent` rereads the record and rewrites JSON payload, so trace volume can become the dominant cost.
- Assistive OpenAI NLU is already optional, but when enabled it shared the WhatsApp response path. The hotfix keeps a timeout and logs `nlu_provider_timeout_fallback_used`.
- Deterministic NLU recomputed FAQ matches and price quote intelligence in a single plan. The hotfix reuses those values without changing intents or rendered copy.

## Implemented

- `AuthorityTurnTrace` now carries sanitized timings, cache flags, external-call counts, event counts and best-effort trace flags.
- `authority_turn_timing_completed` is logged with timing-only payload.
- Twilio route passes `receivedAtMs`, `routeAuthMs` and `parseMs` into the service.
- CLIENTES lookup is no longer duplicated in the route happy path.
- Strong known client identity skips CLIENTES lookup on later turns.
- Assistive NLU skips OpenAI when deterministic slot extraction is already high-confidence and keeps timeout fallback.
- Trace event writes are best-effort and do not block replies if a non-critical trace write fails.

## Not Implemented In This Hotfix

- Store-level batch event append. This is the largest remaining persistence optimization but needs a wider store contract change.
- Full per-turn parse context threading through `reservation-flow.ts`. This would reduce repeated date/slot parsing but touches more flow internals.
- Production latency claims. Use the runbook to gather real timings after an authorized deploy.
