# Knowledge Base / Presales Audit

Branch: `codex/smp-template-identity-kb-presales-quality-v0`

## Existing Business Information

- `src/lib/hotel/faq/catalog.ts`: structured FAQ entries for reservation process, WhatsApp confirmation, hours, prices, guardería, vaccines, confidence/safety, medication, food, photos, grooming, payment, cancellation, location, contact, visits and welfare.
- `src/lib/hotel/config/hotel-config.ts`: booking/contact URLs, WhatsApp phone, reception windows, capacity, overflow policy, hotel prices, half-day supplement, guardería price and guardería bonus.
- `src/lib/hotel/domain/slots.ts`: reception slot windows.
- `src/lib/hotel/conversations/client-templates.ts`: real WhatsApp-style client templates for confirmation, denial, bath offer, prearrival reminder, post-stay and review.
- `src/lib/hotel/conversations/client-requests.ts`: contract link and acceptance gate.
- `src/lib/hotel/conversations/reservation-flow.ts` and `reservation-bridge.ts`: operational reservation collection, availability check, price proposal and confirmation.

## Safe To Answer

- General hotel information categories.
- Reception hours.
- Published hotel and guardería prices.
- Bath/peluquería published bath-size snippets.
- Food, medication, vaccines, cartilla and microchip guidance already in FAQ.
- Location/contact information.
- How to reserve.
- Contract acceptance process at a high level.

## Must Not Invent

- Live availability.
- Confirmation that a slot exists.
- Reservation writes without the existing reservation/availability flow.
- New waitlist support beyond current policy.
- Policies not present in repo, such as minimum puppy age.
- Real stay status, live photos, or health updates.

## Availability Runtime Truth

There is an operational availability tool path: `SheetAdapter.checkAvailability` is used by reservation flow/bridge after the required fields are present. Informal availability questions do not call or fake that result. They collect minimum details and clearly avoid promising a slot.

## Implemented KB Layer

`src/lib/hotel/conversations/knowledge-base.ts` adds a structured conversation KB with:

- `id`
- `topic`
- `aliases`
- `semanticHints`
- `answerRenderKey` or `answer`
- `requiresHuman`
- `requiresTool`
- `confidenceRules`
- `relatedTopics`
- `lastReviewed`
- `source`

Minimum topics covered:

- general hotel information
- hotel vs guardería
- reception hours
- stay includes
- food
- medication
- requirements
- contract
- bath service
- prices
- location
- booking
- availability
- puppy age as a documented gap

## New Presales Intents

- `general_info_query`
- `topic_info_query`
- `mixed_reservation_and_info`
- `informal_availability_query`
- `faq_query`
- `clarify_or_followup_question`
- `price_query`
- `schedule_hours_query`
- `services_query`
- `requirements_query`
- `location_query`
- `bath_service_query`

Existing `faq_*`, `reservation_start`, `availability_request`, `reservation_modify`, `reservation_cancel`, `human_handoff`, and `conversation_reset` intents remain intact.

## Quality Gate

The deterministic fast path still handles reset, clear FAQ, reservation/cancel/modify, confirmations in context, slot-filling and high-confidence deterministic cases. Open or mixed presales queries emit `nlu_fast_path_skipped_quality_gate` and use deterministic KB matching when no LLM/tool is used locally.

## Added Presales Policy

- General hotel info answers with categories.
- Mixed reservation plus doubts holds the reservation intent and asks what the user wants to know first.
- Follow-up topic questions answer from FAQ/KB and offer to continue the reservation.
- Informal availability collects missing pet/date details and does not promise availability.
- Handoff remains limited to explicit human requests, blocked/ambiguous clients, live stay status, and known unsafe/special cases.
