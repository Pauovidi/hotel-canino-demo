# Availability Continuation Regression Audit

Branch: `codex/smp-availability-continuation-pet-slot-checker-v0`
Base: `c969302295981cf12c75ce65907831135f10b8f5`

## Symptom

The first availability-first turn worked, but the next message with only the pet name fell through to the generic fallback:

- user: `quería reservar para este fin de semana ¿es posible?`
- bot: asks only for the pet name and stores `activeFlow=availabilityInquiry`
- user: `PAPO`
- old bot: generic `Perdona, no te he entendido bien...`

## State After First Availability Turn

The first turn stores:

- `activeFlow`: `availabilityInquiry`
- `availabilityInquiry.relativeDateRange`: `este_fin_de_semana`
- `availabilityInquiry.dateRange`: `este fin de semana`
- `availabilityInquiry.missingFields`: `["petName"]`
- `policyAction`: availability inquiry / ask missing slot
- `renderKey`: `availability_first_collect_pet`

The first reply is correct and does not promise availability.

## Root Cause

There was no state-aware continuation reducer for `availabilityInquiry`. The handler checked reservation-change and reservation flows, then continued into general NLU/fallback. A standalone pet name such as `PAPO` is valid while `availabilityInquiry.missingFields` contains `petName`, but outside that state it is intentionally low-signal and becomes `unknown`.

Reservation pet parsing existed inside the reservation flow, not inside `availabilityInquiry`. Therefore `PAPO` could be useful in a reservation reducer but not in the availability-first reducer because that reducer did not exist yet.

Classification: `behaviour_regressed`.

## Fix

The webhook now handles `availabilityInquiry` before general NLU/fallback:

- tries contextual slot merge while `activeFlow=availabilityInquiry`;
- accepts standalone pet names like `PAPO`, `Pipo`, `Kira`, `Toby QA`;
- matches safe known pets exactly/fuzzily when CLIENTES identity has trusted pet data;
- asks for clarification if a known-pet answer is ambiguous;
- recomputes pending fields after merge;
- blocks generic fallback while pending availability fields remain.

New events:

- `availability_slot_merge_attempted`
- `availability_pet_slot_applied`
- `availability_pet_slot_ambiguous`
- `availability_pet_slot_ignored`
- `availability_pending_fields_after_merge`

## Checker Read-Only

The existing operational read path is the sheet adapter `checkAvailability(input)`, used by the reservation flow before creating a proposal. Availability-first now reuses that read method directly:

- no reservation proposal is created;
- no reservation is written;
- no CLIENTES write occurs;
- no Google Sheets write method is called by this path;
- if slots are missing, it asks only for entry/exit times.

Minimum checker data:

- `dateStart`
- `dateEnd`
- `checkInSlot`
- `checkOutSlot`
- `petCount` (defaults to 1 after a single pet name)

If the checker returns available, the bot offers to continue with the reservation. If unavailable, it says no availability according to the operational check. If the checker errors, it uses contextual human review, not generic fallback.
