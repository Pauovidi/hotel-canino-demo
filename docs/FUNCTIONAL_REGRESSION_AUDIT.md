# Functional Regression Audit

Branch: `codex/smp-functional-regression-lock-welcome-availability-v0`
Base: `a23ae2e95dce1634fbe038ce48aa0f4a9aeb5643`

## Scope

Audit of historical and current conversation behavior for Somos Muy Perros before locking welcome and availability-first behavior. This audit is local-only: no EasyPanel, no Vercel, no Twilio Console, no DNS, no secrets, no real WhatsApps, and no real Google Sheets writes.

## Historical Refs Checked

All requested refs were available locally and under `origin/*`:

- `codex/smp-nlu-context-and-real-templates-hotfix-v0` / `77fd594`
- `codex/smp-template-preview-and-context-acceptance-v0` / `419c18c`
- `codex/smp-whatsapp-no-response-after-template-preview-hotfix-v0` / `3a4e96b`
- `codex/smp-triggers-and-slot-merge-production-v0` / `83a222a`
- `codex/smp-authority-turn-trace-state-consistency-v0` / `fed5c987`
- `codex/smp-template-identity-kb-presales-quality-v0` / `37675af`
- `codex/smp-runtime-store-empty-reply-template-verification-v0` / `f80622f`
- `codex/smp-production-smoke-scripts-no-tsx-v0` / `958431b`
- `codex/smp-contract-gate-modify-cancel-smoke-fix-v0` / `a23ae2e`

## Regression Causes

### Welcome

Current base behavior routed `hola` to `conversation.greeting`, whose copy is only `¿En qué podemos ayudarte?`. Strong CLIENTES identity was applied only as name personalization. There was no service-level selection of `welcome_known_client` or `welcome_unknown_client`, and the existing `welcome-persona.ts` was flag-gated and not wired into the normal greeting path.

Historical finding: the real template `Soy Maria Jose, del Hotel Canino SomosMuyPerros` exists, but it is a reservation preconfirmation/welcome-intro template, not a generic chat greeting. Reusing it for plain `hola` would mix reservation confirmation context into a normal inbound greeting. The fix therefore adds a coherent hotel welcome for normal greetings and keeps the Maria Jose template for preconfirmation/preview.

Classification: `behaviour_regressed`.

### Availability-First

Current base behavior recognized direct availability wording like `tenéis disponibilidad para este finde`, but did not prioritize messages combining reservation intent, a vague relative range, and a possibility question, for example `quería reservar para este fin de semana, ¿es posible?`. The broad `reservar` rule then returned `reservation_start`, which started the reservation form.

The fix adds an early NLU rule before broad reservation start detection: relative weekend/range + availability terms, bare relative range, or reservation intent + possibility question routes to `informal_availability_query`. Service then records availability-first state and asks only for missing minimum details without claiming a real slot.

Classification: `behaviour_regressed`.

## Inventory

| Area | Current/Historical Behaviour | Classification | Notes |
|---|---|---|---|
| Reset | Global reset replies `Reiniciado.`, clears active conversational state, preserves identity. | `behaviour_locked_now` | Locked in service and route TwiML tests. |
| Greeting / welcome | Generic greeting was locked; real welcome selection was absent. | `behaviour_regressed` | Fixed with `conversation.welcome_known_client` and `conversation.welcome_unknown_client`. |
| Known client recognition | Strong phone/email matches persist and are reused after reset. | `behaviour_locked_now` | CLIENTES is not mutated by reset. |
| Template preview | Preview commands are prerouter/stateless and show real templates only as previews. | `behaviour_locked_now` | No preview label on normal welcome. |
| Real templates | Confirmation, denial, bath, reminder, post-stay and review templates exist. | `behaviour_locked_now` | Maria Jose copy remains preconfirmation, not generic greeting. |
| Reservation base flow | Collects client/pet/date/time/notes/visit, then proposal and explicit confirmation. | `behaviour_locked_now` | Real write is behind mock/adapter-controlled bridge in tests. |
| Contract gate | `confirmo` requests contract when required; `acepto` completes; modify/cancel bypass gate. | `behaviour_locked_now` | Contract gate skip events remain. |
| FAQ inside reservation | FAQ answer is sent and pending reservation state resumes. | `behaviour_locked_now` | Payment FAQ after reset and inside flow covered. |
| Availability/info | Informal availability must collect minimum details and not fake availability. | `behaviour_regressed` | Weekend possibility phrases now route availability-first. |
| Availability continuation | A standalone pet reply after availability-first must fill `availabilityInquiry.petName`, not fall back to the generic menu. | `behaviour_regressed` | Fixed in `codex/smp-availability-continuation-pet-slot-checker-v0`; checker stays read-only. |
| Human mode | Human mode suppresses bot auto-reply except explicit reset. | `behaviour_locked_now` | Empty TwiML allowed only for no-reply cases. |
| No empty reply | Normal inbound returns non-empty TwiML. | `behaviour_locked_now` | Store failure/parsing fallback returns safe message. |
| Production smokes | Production-facing smokes use `node`, not `tsx`. | `behaviour_locked_now` | `smoke:production` exists. |
| Scheduled/proactives | Jobs default disabled/dry-run locally. | `behaviour_locked_now` | No real send in tests. |
| Latency trace | Authority timing trace and latency smoke exist. | `behaviour_locked_now` | Local synthetic smoke expects no OpenAI calls. |
| Identity trace | Client identity status/source are logged in sanitized form. | `behaviour_locked_now` | No secrets/PII expansion in logs. |
| Legacy routes/helpers | Reset and template preview remain prerouter guards by design. | `behaviour_not_applicable` | No architecture rewrite in this hotfix. |
| Education/etology vertical | Not part of current runtime. | `behaviour_not_applicable` | Explicitly out of scope. |

## Additional Regression Found

The loose `reservationId` slot regex could capture the verb `reservar` as a reservation id. This was not the visible P0, but it polluted slots/traces and was low-risk to fix. The regex now requires a separator or numeric id after `res`/`reserva`.

Classification: `behaviour_regressed`.

## Follow-up Regression Found

The first availability-first reply saved `activeFlow=availabilityInquiry` and `missingFields=["petName"]`, but there was no continuation reducer for that state. A short pet reply such as `PAPO` then went through general NLU and could reach generic fallback. This is now locked: the state-aware reducer runs before fallback, applies safe pet slots, asks only missing times if needed, and calls the existing `checkAvailability` read path only after pet, date range and slots are present.

Classification: `behaviour_regressed`.

## Safe Decisions

- No fake availability: availability-first does not say a slot exists without an operational checker/tool result.
- No preconfirmation copy in greeting: the Maria Jose template remains tied to reservation preconfirmation/preview.
- No real side effects: tests use memory stores, static client directories, mock bridge dependencies and dry-run job paths.
