# Functional Baseline Lock

This file is the functional contract for production-adjacent conversation changes. New work must keep these behaviours green unless a future prompt explicitly replaces the contract.

| Feature | Expected behaviour | Source / evidence | Current status | Test name | Risk if broken |
|---|---|---|---|---|---|
| Reset | `reiniciar` and aliases reply exactly `Reiniciado.` before NLU/fallback and clear active conversational state only. | Reset hotfix, service route guards. | Locked | `answers %s with the global reset reply`, route reset TwiML tests | Users get generic fallback or remain stuck in stale flows. |
| Reset identity | Reset preserves persisted known-client identity and pets; it does not touch CLIENTES or reservations. | `TEMPLATE_IDENTITY_REGRESSION_AUDIT.md` | Locked | `locks reset, known identity preservation and post-reset welcome` | Known clients are treated as new or CLIENTES is accidentally mutated. |
| Welcome known client | First clean greeting after reset/start uses hotel welcome with known first name, not generic greeting. | Current hotfix decision; Maria Jose template is preconfirmation only. | Locked | `greets a strong phone match with the CLIENTES name`, `functional baseline lock` | Bot feels degraded and loses recognized-client context. |
| Welcome unknown client | First clean greeting uses hotel welcome without name. | Current hotfix decision. | Locked | `answers a fresh greeting naturally after reset`, `locks normal inbound TwiML as non-empty` | New users get a thin generic reply. |
| Welcome no preview | Normal greetings never include `Vista previa` or reservation preconfirmation copy. | Template preview audit. | Locked | `renders welcome keys without preview or preconfirmation copy` | Preview/debug text leaks into WhatsApp. |
| Welcome anti-spam | Consecutive greetings after the selected welcome use the short greeting. Reset enables welcome again. | Current hotfix decision. | Locked | `does not repeat the full welcome on consecutive greetings` | Repeated greetings spam long welcome text. |
| Known client reservation | `quiero reservar` from strong known phone skips `¿Ya eres cliente?` and uses known pet when safe. | Client directory + reservation-flow tests. | Locked | `starts reservations for strong phone matches...`, `locks known-client reservation start...` | Habitual clients are forced through unnecessary form steps. |
| Template preview | `plantilla confirmación` returns preview only and real confirmation snippet. | Template preview hotfix. | Locked | `returns template preview TwiML before directory...`, `locks template preview as preview-only...` | Preview blocks webhook or sends real operational copy as normal reply. |
| Real templates | Confirmation, bath, denial, reminder, post-stay and review link render real SMP snippets. | `client-templates.ts` and smoke templates. | Locked | `maps real client template render keys`, `smoke:templates` | Production copy regresses to generic text. |
| Reservation flow | New reservation collects required fields, checks availability through bridge, proposes, gates confirmation, writes only after confirmation/contract as configured. | Reservation bridge tests and smoke conversation. | Locked | `creates a reviewed proposal...`, `smoke:conversation` | Accidental writes, missing proposal, or unsafe confirmation. |
| Contract gate | `confirmo` requests contract when required; `acepto` finalizes; modify/cancel/reset/FAQ do not get intercepted. | Contract gate smoke audit. | Locked | contract gate tests, `smoke:conversation` | Users cannot modify/cancel or confirm legally. |
| FAQ inside reservation | FAQ answers, preserves active flow, and resumes missing field. | KB/preventa branch. | Locked | `answers a payment FAQ during an active reservation flow...` | FAQ derails reservation or falls to human fallback. |
| Availability-first vague weekend | `quería reservar para este fin de semana, ¿es posible?` routes to availability-first, not reservation form. | Current hotfix. | Locked | `prioritizes availability...`, `routes reservation phrased...` | Users are forced into form before minimum availability triage. |
| Availability continuation pet slot | After availability-first asks for pet name, `PAPO` is applied as `availabilityInquiry.petName` and the bot asks only the next missing checker detail. | Availability continuation hotfix. | Locked | `continues availability-first by applying a standalone pet slot...`, `locks availability-first continuation...` | User gets generic fallback while answering the bot's own question. |
| Availability-first with pet | `hay hueco este finde para PIPO?` records range + pet and asks only missing entry/exit times before any checker result. | Availability continuation hotfix. | Locked | `asks only for times when the read-only checker still lacks slots` | Bot invents availability or asks duplicate form fields. |
| Availability checker read-only | Once pet, date range and slots are known, availability-first calls `checkAvailability` read-only and does not create proposals or writes. | Reservation checker read path. | Locked | `runs the availability checker read-only...`, `reports unavailable checker result...` | False availability, accidental proposal/write, or fallback instead of result. |
| Date range aliases | `este finde`, `sábado y domingo`, `viernes a domingo` are recognized as relative ranges. | Knowledge-base range extractor. | Locked | `classifies informal availability for %s` | Weekend language falls through to generic or form. |
| No fake availability | Bot never says there is availability without checker/tool evidence. | Authority contract + KB audit. | Locked | availability-first tests assert no `Tenemos disponibilidad` | False availability promise reaches customer. |
| Human mode | Human mode suppresses auto-reply; explicit reset still works. | Service tests. | Locked | `locks FAQ inside reservation and human-mode silence except explicit reset` | Bot talks over staff or reset cannot escape. |
| No empty TwiML normal inbound | Normal inbound returns a `<Message>`; empty TwiML allowed only for duplicate/no-reply branches. | Runtime empty-reply hotfix. | Locked | `locks normal inbound TwiML as non-empty`, route security tests | WhatsApp appears silent. |
| Production smokes no tsx | Production smoke scripts run through `node scripts/run-production-smoke.mjs`, not `tsx`. | Smoke no-tsx hotfix. | Locked | `production-smoke-scripts.test.ts`, `smoke:production` | EasyPanel shell fails with `tsx: not found`. |
| Scheduled jobs | Jobs are disabled/dry-run by default locally and do not send real WhatsApps in tests. | Scheduled message tests. | Locked | `scheduled-messages.test.ts`, dry-run job commands | Real outbound send or DB write in validation. |
| Latency trace | Authority timing events exist and local latency smoke uses synthetic no-OpenAI path. | Latency runbook. | Locked | `smoke:conversation:latency` | Latency regression becomes invisible. |
| Identity trace | Client identity status/source are recorded with sanitized events/logs. | Template identity branch. | Locked | service identity tests and identity smoke | Debugging loses identity truth or leaks sensitive data. |

## Validation Commands

Required local validation for this lock:

- `npm run lint`
- `npm run test:run`
- `npm run build`
- `npm run smoke:templates`
- `npm run smoke:identity`
- `npm run smoke:conversation`
- `npm run smoke:conversation:latency`
- `npm run smoke:production`
- `NODE_ENV=production npm run smoke:production`
- `npm run smoke:functional-baseline`
- dry-run/disabled scheduled jobs

Do not run `smoke:http` against a service that may touch real persistence. Do not run `db:check:postgres` locally unless a safe non-secret test database is explicitly configured.
