# OpenAI structured NLU integration plan

OpenAI is not activated as final decision maker in this branch. The correct path is to integrate structured NLU inside `hotel-canino-demo`, using `devestial-conversation-core-openai` only as a read-only reference.

## Target model

OpenAI interprets:

- Intent.
- Slots.
- Dates and vague date expressions.
- Context needed to continue pending flows.
- Confidence and ambiguity signals.

The deterministic backend executes:

- Pricing.
- Availability checks.
- Reservation creation.
- Reservation modification.
- Reservation cancellation.
- Google Sheets writes.
- Admin handoff and audit events.

## Safety rules

- No reservation is created, modified or cancelled without explicit user confirmation.
- No real Google Sheets write is allowed unless the production write guard explicitly permits it.
- OpenAI output is treated as proposed structure, not authority.
- Existing golden tests must pass before moving from shadow mode to assistive mode, and again before any decision mode.

## Branch sequencing

`codex/smp-hybrid-llm-nlu-shadow-v0` should be rebased or replayed on top of the EasyPanel/Postgres product repo migration after this branch is merged. That keeps the product source of truth in `hotel-canino-demo` and avoids routing production Somos Muy Perros through the reusable core repo.

## Suggested rollout

1. Shadow mode: log structured NLU beside deterministic decisions, with no behavior change.
2. Assistive mode: allow NLU to fill slots when deterministic parsing is weak, still behind tests and guards.
3. Decision mode for selected low-risk intents only.
4. Broaden intent coverage after golden WhatsApp, panel, pricing, reservation, modification and cancellation tests pass.
