# Availability Times Calendar Precheck Audit

Branch: `codex/smp-availability-times-calendar-precheck-no-loop-v0`
Base: `50b933f33748ed2056a33c3810b2ba0036c1e397`

## Scope

P0 hotfix for the existing Somos Muy Perros availability-first flow. This audit is local-only: no deploy, no EasyPanel, no Twilio Console, no DNS, no secrets, no real WhatsApps and no real Google Sheets writes.

## State Trace

With the test clock at `2026-07-02T10:00:00.000Z`, `quería reservar para este fin de semana ¿es posible?` stores:

- `activeFlow=availabilityInquiry`
- `relativeDateRange=este_fin_de_semana`
- `dateRange=este fin de semana`
- `dateStart=2026-07-04`
- `dateEnd=2026-07-05`
- `missingFields=["petName"]`
- `readyForTool=false`

After `PUPI`, the reducer applies the pet slot and the new calendar precheck path runs read-only:

- `petName=PUPI`
- `petCount=1`
- `availabilityStatus=available_preliminary` when the read path reports available
- `missingFields=["times"]`
- `readyForTool=false`
- no proposal, no reservation write, no CLIENTES write

Before `a las 10`, the exact pending fields are `["times"]`.

## Root Causes

`a las 10` was not applied usefully because the old availability reducer reused the reservation slot extractor but only had a coarse `times` missing field. A single loose time could become `checkInTime`, but `checkOutTime` stayed empty, so `computeAvailabilityMissingFields` still returned `["times"]` and rendered the same generic time prompt.

The old `availabilityInquiry` reducer did not have a time-only state. It had pet/date merge and exact precheck when both slots existed, but no intermediate `timeTarget` clarification for a useful single time.

The visible phrase `flujo operativo` came from availability-first render keys in `copy-renderer.ts`. It was internal language and appeared in `availability_first_collect_pet`, `availability_first_clarify_times`, related availability keys, and the generic informal availability copy.

The repeated reply was not detected because there was no availability no-repeat guard comparing a useful slot-bearing user message against the previous render key. The service simply rendered `availability_first_clarify_times` again.

## Checker Read Path

The real checker entry point is still `SheetAdapter.checkAvailability(input)`. It is read-only, but its input model requires:

- `entryDate`
- `entrySlot`
- `exitDate`
- `exitSlot`
- `dogs`

For a preliminary calendar/range precheck, this hotfix adds a wrapper around that read path. If there is `dateStart + dateEnd + petName` but no times, it calls `checkAvailability` with conservative slot defaults (`morning` / `morning`) and marks the result as preliminary. It never creates a reservation proposal and never calls write methods.

For a precise proposal or reservation, the minimum data remains stricter:

- pet name/count
- exact date range
- entry and exit slots/times
- successful availability check
- explicit downstream confirmation/contract/write path

## Fixed Behavior

Time-only availability replies now emit:

- `availability_time_slot_merge_attempted`
- `availability_time_slot_applied` when the target is clear
- `availability_time_slot_needs_clarification` for `a las 10`
- `availability_time_slot_ignored` with a reason when relevant
- `availability_pending_fields_after_merge`
- `availability_no_repeat_guard_triggered` when a useful single time would otherwise repeat generic copy

`a las 10` is stored as `approximateTime=10:00`, sets `missingFields=["timeTarget"]`, and replies:

`¿Las 10 serían para la entrada y también para la salida?`

Explicit shared-time replies such as `a las 10 entrada y salida` apply `checkInTime=10:00` and `checkOutTime=10:00`, then run the exact read-only checker.

Date+pet without times now runs `availability_calendar_precheck_started` / `availability_calendar_precheck_read_only` / `availability_calendar_precheck_result`. Available preliminary copy says that availability appears in principle and asks for entry/exit hours without presenting a confirmed reservation.

Visible availability-first copy no longer says `flujo operativo`; it uses `calendario`, `calendario de reservas` or `revisarlo en el calendario`.
