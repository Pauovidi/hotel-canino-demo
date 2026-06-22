import { afterEach, describe, expect, it } from "vitest";

import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import {
  selectPostStayFollowupCandidates,
  selectPrearrivalReminderCandidates,
} from "./reservation-reminders";

const previousEnv = { ...process.env };

afterEach(() => {
  process.env = { ...previousEnv };
});

function reservation(overrides: Partial<ReservationRecord> = {}): ReservationRecord {
  return {
    reservationId: "res_test",
    petKey: "kira",
    status: "confirmada",
    reviewState: "ok",
    source: "demo",
    createdAt: "2026-06-22T10:00:00.000Z",
    updatedAt: "2026-06-22T10:00:00.000Z",
    petName: "Kira",
    phone: "+34600000000",
    checkInDate: "2026-06-23",
    checkInSlot: "morning",
    checkOutDate: "2026-06-25",
    checkOutSlot: "afternoon",
    petCount: 1,
    reviewFlags: [],
    ...overrides,
  };
}

describe("reservation reminder and followup selectors", () => {
  it("keeps prearrival reminders disabled by default", () => {
    expect(
      selectPrearrivalReminderCandidates(
        [reservation()],
        new Date("2026-06-22T10:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("selects prearrival reminders only in dry-run mode when enabled", () => {
    process.env.HOTEL_RESERVATION_REMINDERS_ENABLED = "true";
    process.env.HOTEL_RESERVATION_REMINDERS_DRY_RUN = "true";

    const candidates = selectPrearrivalReminderCandidates(
      [reservation()],
      new Date("2026-06-22T10:00:00.000Z"),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "prearrival_reminder",
      dryRun: true,
      petName: "Kira",
    });
  });

  it("selects post-stay followups only in dry-run mode when enabled", () => {
    process.env.HOTEL_POST_STAY_FOLLOWUPS_ENABLED = "true";
    process.env.HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN = "true";

    const candidates = selectPostStayFollowupCandidates(
      [reservation({ checkInDate: "2026-06-20", checkOutDate: "2026-06-21" })],
      new Date("2026-06-22T10:00:00.000Z"),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "post_stay_followup",
      dryRun: true,
      petName: "Kira",
    });
  });
});
