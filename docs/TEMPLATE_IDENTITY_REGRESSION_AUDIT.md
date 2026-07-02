# Template / Identity Regression Audit

Branch: `codex/smp-template-identity-kb-presales-quality-v0`  
Base: `eb79b68797cb0ace56183705da515a866306cd4b`

## Scope

This audit covers the WhatsApp conversation path only. It does not deploy, send WhatsApps, write Google Sheets, edit secrets, touch DNS, or modify Twilio/EasyPanel/Vercel settings.

## Findings

- Real client templates were present, not deleted. The source is `src/lib/hotel/conversations/client-templates.ts`.
- Template preview, client request contract flow, reservation reminders, scheduled bath offer, and post-stay followups already consumed those functions.
- The authority `CopyRenderer` did not expose explicit render keys for the real client templates, so template connectivity was harder to assert at the authority boundary.
- Generic fallback/handoff copy lives in `src/lib/hotel/conversations/authority/copy-renderer.ts` and FAQ uncovered-question fallback lives in `src/lib/hotel/knowledge/faq.ts`.
- Reset is correctly intercepted before NLU, FAQ, pending flows, human mode, and fallback in `handleInboundWhatsApp`.
- Per-conversation reset clears active flow state only. It preserves client identity fields already persisted in the conversation and does not touch `CLIENTES`, reservations, entry log, monthly sheets, secrets, DNS, or Twilio.
- If reset is the first message from a known phone, identity is resolved on the next non-reset inbound through the configured `ClientDirectory`.

## Patch Points

- Added authority render keys for:
  - `reservation_confirmation`
  - `reservation_preconfirmation`
  - `reservation_denial`
  - `bath_offer`
  - `reservation_reminder`
  - `post_stay_new_client_checkin`
  - `positive_review_request`
  - `contract_link`
  - `contract_acceptance`
- Preserved the existing decision not to reintroduce `ATENCIÓN LEER HASTA EL FINAL`.
- Adjusted bath copy to include the exact client snippets requested in the prompt.
- Added sanitized identity events:
  - `client_identity_lookup_started`
  - `client_identity_lookup_result`
  - `client_identity_lookup_cache_hit`
  - `client_identity_lookup_cache_miss`
  - `client_identity_preserved_after_reset`
- Added trace fields for render source, template id, client identity status/source, fallback/handoff reason, KB match, and fast-path quality gate.

## Regression Guard

Tests assert that:

- Real template snippets are reachable through `CopyRenderer`.
- Reset still responds `Reiniciado.` before stateful guards.
- Reset clears active reservation, modification, cancellation, human, bath, post-stay and price quote state.
- Known identity survives per-conversation reset and can personalize the next greeting.
- Generic handoff/fallback does not capture clear info, availability, FAQ, or reservation-change intents.
