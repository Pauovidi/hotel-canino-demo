import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import type { ConversationRecord } from "./types";
import {
  createScheduledMessage,
  dispatchDueScheduledMessages,
  MemoryScheduledMessageStore,
  resetScheduledMessageStoreForTests,
  scheduleBathOfferAfterConfirmation,
} from "./scheduled-messages";

const previousEnv = { ...process.env };

afterEach(() => {
  process.env = { ...previousEnv };
  resetScheduledMessageStoreForTests();
});

function conversation(): ConversationRecord {
  return {
    id: "conv_sched",
    phoneE164: "+34600000000",
    phoneNormalized: "34600000000",
    displayName: "Pau",
    sourceType: "whatsapp",
    mode: "bot",
    humanRequested: false,
    unreadCount: 0,
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:00:00.000Z",
    messages: [],
    events: [],
  };
}

function reservation(): ReservationRecord {
  return {
    reservationId: "res_sched",
    petKey: "pipo",
    status: "confirmada",
    reviewState: "ok",
    source: "demo",
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:00:00.000Z",
    ownerName: "Pau",
    petName: "PIPO",
    petNames: ["PIPO"],
    phone: "+34600000000",
    checkInDate: "2026-12-25",
    checkInSlot: "morning",
    checkInTime: "10:00",
    checkOutDate: "2026-12-26",
    checkOutSlot: "morning",
    checkOutTime: "10:00",
    petCount: 1,
    reviewFlags: [],
  };
}

describe("scheduled messages queue", () => {
  it("dedupes scheduled messages by dedupe key", async () => {
    const store = new MemoryScheduledMessageStore();
    const now = new Date("2026-06-24T10:00:00.000Z");
    await store.upsert(
      createScheduledMessage({
        type: "bath_offer_after_confirmation",
        reservationId: "res_1",
        phone: "+34600000000",
        payload: { to: "+34600000000", message: "uno" },
        scheduledAt: now,
        dedupeKey: "res_1:bath",
        dryRun: true,
        now,
      }),
    );
    await store.upsert(
      createScheduledMessage({
        type: "bath_offer_after_confirmation",
        reservationId: "res_1",
        phone: "+34600000000",
        payload: { to: "+34600000000", message: "dos" },
        scheduledAt: new Date("2026-06-24T10:02:00.000Z"),
        dedupeKey: "res_1:bath",
        dryRun: true,
        now,
      }),
    );

    const due = await store.listDue({ now: new Date("2026-06-24T10:03:00.000Z") });

    expect(due).toHaveLength(1);
    expect(due[0].payload).not.toHaveProperty("to");
    expect(due[0].externalUserId).toBe("+34600000000");
    expect(due[0].payload.message).toBe("dos");
  });

  it("marks due work as dry-run without calling the sender when disabled", async () => {
    const store = new MemoryScheduledMessageStore();
    const now = new Date("2026-06-24T10:00:00.000Z");
    await store.upsert(
      createScheduledMessage({
        type: "post_stay_followup",
        reservationId: "res_2",
        phone: "+34600000000",
        payload: { message: "hola" },
        scheduledAt: now,
        dedupeKey: "res_2:post",
        dryRun: true,
        now,
      }),
    );
    const sender = vi.fn();

    const result = await dispatchDueScheduledMessages({
      store,
      now,
      sender,
      env: {
        HOTEL_SCHEDULED_MESSAGES_ENABLED: "false",
        HOTEL_SCHEDULED_MESSAGES_DRY_RUN: "true",
      } as NodeJS.ProcessEnv,
    });

    expect(result).toMatchObject({ due: 1, dryRun: 1, sent: 0, failed: 0 });
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends only when scheduler is enabled and dry-run is false", async () => {
    const store = new MemoryScheduledMessageStore();
    const now = new Date("2026-06-24T10:00:00.000Z");
    await store.upsert(
      createScheduledMessage({
        type: "post_stay_followup",
        reservationId: "res_3",
        phone: "+34600000000",
        payload: { message: "hola" },
        scheduledAt: now,
        dedupeKey: "res_3:post",
        dryRun: false,
        now,
      }),
    );
    const sender = vi.fn().mockResolvedValue({ ok: true, mode: "real", sid: "SM_REAL" });

    const result = await dispatchDueScheduledMessages({
      store,
      now,
      sender,
      env: {
        HOTEL_SCHEDULED_MESSAGES_ENABLED: "true",
        HOTEL_SCHEDULED_MESSAGES_DRY_RUN: "false",
      } as NodeJS.ProcessEnv,
    });

    expect(result).toMatchObject({ due: 1, sent: 1, dryRun: 0, failed: 0 });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("schedules bath offer two minutes after confirmation in dry-run by default", async () => {
    const store = new MemoryScheduledMessageStore();
    const now = new Date("2026-06-24T10:00:00.000Z");

    const result = await scheduleBathOfferAfterConfirmation({
      reservation: reservation(),
      conversation: conversation(),
      now,
      store,
      env: {
        HOTEL_BATH_OFFER_ENABLED: "false",
        HOTEL_BATH_OFFER_DRY_RUN: "true",
        HOTEL_BATH_OFFER_DELAY_MINUTES: "2",
        HOTEL_SCHEDULED_MESSAGES_ENABLED: "false",
        HOTEL_SCHEDULED_MESSAGES_DRY_RUN: "true",
      } as NodeJS.ProcessEnv,
    });

    expect(result.scheduled).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.message?.scheduledAt).toBe("2026-06-24T10:02:00.000Z");
    expect(result.message?.payload.message).toContain("¿Quieres que bañemos a PIPO");
  });
});
