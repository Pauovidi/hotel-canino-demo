# Contract Gate Smoke Failure Audit

## Scope

Audit for the `smoke:production` failures detected after the production smoke scripts stopped depending on `tsx`:

- `proposal-confirmation-bridge`
- `reservation-modification-bridge`
- `reservation-cancellation-bridge`

The smoke uses `MemoryConversationStore` and mocked reservation/sheet adapters, so this audit does not require real WhatsApp sends or real Google Sheets writes.

## Flags Involved

- `HOTEL_CONTRACT_ACCEPTANCE_REQUIRED`: when enabled, a final proposal confirmation must request contract acceptance before writing the reservation.
- `HOTEL_CONTRACT_LINK_ENABLED`: controls whether the contract link copy is exposed by the contract request helper.
- `HOTEL_CONFIRMATION_TEMPLATE_ENABLED`: controls the final confirmation rendering after the write succeeds.
- Write/dry-run flags: the smoke uses mocked write adapters and must assert mock side effects only.

## Failure: proposal-confirmation-bridge

Previous expectation:

- Proposal generated.
- User says `si por favor`.
- Smoke expected direct reservation confirmation, one write, one client upsert, and a chatbot entry log.

Observed with contract required:

- User says `si por favor`.
- Service correctly replies with the contract acceptance request.
- No reservation write happens yet.

Classification:

- Smoke expectation was obsolete when `HOTEL_CONTRACT_ACCEPTANCE_REQUIRED=true`.
- Policy was correct to block final confirmation until acceptance.
- The smoke needed to model the complete bridge: proposal -> confirm -> contract request -> `acepto` -> final confirmation/write.

Fix:

- The smoke now sends `acepto` when the contract request is present.
- The row reports `expected`, `contractGate`, `activeFlow`, `proposalState`, `termsState`, and `renderTemplateId`.
- The contract gate emits `contract_gate_applied` with reason `confirm_proposal_requires_acceptance`.

## Failure: reservation-modification-bridge

Previous expectation:

- After a confirmed reservation exists, `quiero modificar una reserva` starts the modification bridge.
- New dates are proposed and confirmation writes the modified reservation in mock mode.

Observed in the failed run:

- The prior proposal-confirmation bridge had stopped at contract request.
- The conversation still had an active pending proposal.
- A modification intent could continue inside the active proposal flow and eventually surface contract copy instead of modification routing.

Classification:

- Mixed cause: the first failure left the smoke in the wrong state, and the active reservation flow did not have an explicit modify escape for pending proposals.

Fix:

- Pending proposal + `reservation_modify` now skips the contract gate with reason `skipped_modify_intent`.
- The previous proposal is marked `cancelled` with `failureReason=customer_requested_change`.
- The reservation flow returns to editable data collection and asks what should change.
- Real confirmed reservations still use the existing reservation modification bridge.

## Failure: reservation-cancellation-bridge

Previous expectation:

- After a confirmed reservation exists, `quiero cancelar una reserva` starts the cancellation bridge.
- Confirmation cancels the mock reservation and records the cancellation entry log.

Observed in the failed run:

- The smoke was still carrying a contract-blocked proposal.
- Cancellation language could be handled as part of the active pending proposal instead of the cancellation bridge.

Classification:

- Mixed cause: obsolete confirmation smoke plus missing pending-proposal cancellation escape.

Fix:

- Pending proposal + `reservation_cancel` now skips the contract gate with reason `skipped_cancel_intent`.
- The active proposal/flow is cleared with the normal reservation-flow cancellation reply.
- Confirmed reservations still use the existing reservation cancellation bridge.

## Canonical Contract Gate Rule

The contract gate may intercept only:

- Final confirmation of a current, complete reservation proposal.
- Contract acceptance is required.
- The proposal has not already recorded acceptance for the current terms version.

The contract gate must not intercept:

- `reservation_modify`
- `reservation_cancel`
- reset
- human handoff
- FAQ/info turns
- availability turns without a complete proposal
- slot corrections before final confirmation

Implemented events:

- `contract_gate_applied`
- `contract_gate_skipped`

Implemented reasons:

- `confirm_proposal_requires_acceptance`
- `skipped_modify_intent`
- `skipped_cancel_intent`
- `skipped_reset`
- `skipped_handoff`
- `skipped_not_ready`
- `skipped_terms_already_accepted`
- `skipped_no_active_proposal`

## Verification Intent

The corrected smoke should prove:

- Contract-required confirmation completes only after acceptance.
- Modify/cancel do not show contract copy.
- No empty TwiML is introduced.
- No production-only `tsx` runtime dependency is reintroduced.
- Mock writes remain mock-only in local smoke.
