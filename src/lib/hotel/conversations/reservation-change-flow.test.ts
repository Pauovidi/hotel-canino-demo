import { describe, expect, it } from "vitest";
import { buildEntryLogRecord } from "@/lib/hotel/application/entry-log";
import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import type { DemoReservationRecord, SheetsAvailabilityResult } from "@/lib/hotel/integrations/types";
import { createStaticClientDirectory } from "@/lib/hotel/clients";
import type { SheetAdapter, SheetsWriteResult } from "@/lib/hotel/sheets/types";
import { handleInboundWhatsApp } from "./service";
import {
  createEmptyConversationSnapshot,
  filterConversationRecords,
  type ConversationStore,
} from "./store";
import type {
  Conversation,
  ConversationEvent,
  ConversationListFilters,
  ConversationRecord,
  ConversationSnapshot,
  Message,
} from "./types";

class MemoryConversationStore implements ConversationStore {
  private snapshot: ConversationSnapshot = createEmptyConversationSnapshot();

  async load(): Promise<ConversationSnapshot> {
    return structuredClone(this.snapshot);
  }

  async save(snapshot: ConversationSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }

  async list(filters?: ConversationListFilters): Promise<ConversationRecord[]> {
    return filterConversationRecords(this.snapshot.conversations, filters);
  }

  async getById(id: string): Promise<ConversationRecord | undefined> {
    return structuredClone(this.snapshot.conversations.find((record) => record.id === id));
  }

  async getByPhone(phoneNormalized: string): Promise<ConversationRecord | undefined> {
    return structuredClone(
      this.snapshot.conversations.find((record) => record.phoneNormalized === phoneNormalized),
    );
  }

  async upsertConversation(conversation: Conversation): Promise<ConversationRecord> {
    const existing = this.snapshot.conversations.find((record) => record.id === conversation.id);
    const record: ConversationRecord = {
      ...existing,
      ...conversation,
      messages: existing?.messages ?? [],
      events: existing?.events ?? [],
    };
    this.snapshot.conversations = [
      record,
      ...this.snapshot.conversations.filter((item) => item.id !== record.id),
    ];
    return structuredClone(record);
  }

  async addMessage(message: Message): Promise<Message> {
    const record = this.snapshot.conversations.find(
      (conversation) => conversation.id === message.conversationId,
    );
    if (!record) throw new Error("Conversation not found");
    record.messages.push(message);
    record.updatedAt = message.createdAt;
    record.lastMessagePreview = message.body.slice(0, 180);
    if (message.direction === "inbound") {
      record.unreadCount += 1;
      record.lastInboundAt = message.createdAt;
    } else {
      record.lastOutboundAt = message.createdAt;
    }
    return structuredClone(message);
  }

  async addEvent(event: ConversationEvent): Promise<ConversationEvent> {
    const record = this.snapshot.conversations.find(
      (conversation) => conversation.id === event.conversationId,
    );
    if (!record) throw new Error("Conversation not found");
    record.events.push(event);
    record.updatedAt = event.createdAt;
    return structuredClone(event);
  }

  async replaceConversation(record: ConversationRecord): Promise<ConversationRecord> {
    this.snapshot.conversations = [
      structuredClone(record),
      ...this.snapshot.conversations.filter((item) => item.id !== record.id),
    ];
    return structuredClone(record);
  }

  async seed(records: ConversationRecord[]): Promise<ConversationSnapshot> {
    this.snapshot = {
      conversations: structuredClone(records),
      updatedAt: new Date().toISOString(),
    };
    return this.load();
  }
}

function reservation(overrides: Partial<ReservationRecord> = {}): ReservationRecord {
  return {
    reservationId: "res-change-001",
    petKey: "kira-qa",
    workflowState: "confirmed",
    workflowTrail: [],
    status: "confirmada",
    reviewState: "ok",
    source: "demo",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ownerName: "SMP QA",
    ownerEmail: "qa@example.test",
    petName: "Kira QA",
    phone: "+34612345678",
    checkInDate: "2026-12-26",
    checkInTime: "10:00",
    checkInSlot: "morning",
    checkOutDate: "2026-12-28",
    checkOutTime: "11:00",
    checkOutSlot: "morning",
    petCount: 1,
    priceSource: "calculated",
    pricing: {
      currency: "EUR",
      subtotal: 60,
      supplements: 0,
      total: 60,
      lineItems: [],
      assumptions: [],
    },
    clientKind: "habitual",
    sheetRegistration: {
      sheetName: "DICIEMBRE 2026",
      reservationId: "res-change-001",
      rowHint: 7,
      cells: ["B7", "C7"],
      writtenAt: "2026-06-01T10:00:00.000Z",
    },
    reviewFlags: [],
    ...overrides,
  };
}

function availability(available = true): SheetsAvailabilityResult {
  return {
    available,
    conflicts: available ? [] : ["2026-12-30"],
    monthKey: "2026-12",
    sheetName: "DICIEMBRE 2026",
    remainingByDate: {
      "2026-12-29": { morning: available ? 8 : 0, afternoon: available ? 8 : 0 },
      "2026-12-30": { morning: available ? 8 : 0, afternoon: available ? 8 : 0 },
      "2026-12-31": { morning: available ? 8 : 0, afternoon: available ? 8 : 0 },
    },
  };
}

function makeDeps(initialRecords: ReservationRecord[], options: { availability?: boolean[] } = {}) {
  const records = structuredClone(initialRecords);
  const counters = {
    checks: 0,
    writes: 0,
    cancellations: 0,
    writtenReservations: [] as DemoReservationRecord[],
  };
  const availabilitySequence = options.availability ?? [true, true];
  const adapter: SheetAdapter = {
    async readMonth() {
      return {
        monthKey: "2026-12",
        sheetName: "DICIEMBRE 2026",
        capacityBySlot: { morning: 10, afternoon: 10 },
        occupiedByDate: {},
        reservations: [],
        colorPlan: [],
      };
    },
    async validateMonthStructure() {
      return {
        ok: true,
        monthKey: "2026-12",
        sheetName: "DICIEMBRE 2026",
        layout: {
          rangeStart: "A1",
          rangeEnd: "AF39",
          titleRow: 1,
          dayHeaderRow: 3,
          firstReservationRow: 4,
          lastReservationRow: 39,
          firstDayColumn: 2,
          lastDayColumn: 32,
          specialLabelColumn: 1,
        },
        issues: [],
        rowCount: 39,
        dayHeaders: [29, 30, 31],
        occupiedCells: 0,
      };
    },
    async checkAvailability() {
      const result = availability(
        availabilitySequence[Math.min(counters.checks, availabilitySequence.length - 1)],
      );
      counters.checks += 1;
      return result;
    },
    async buildWritePlan(res: DemoReservationRecord) {
      return {
        sheetName: "DICIEMBRE 2026",
        reservationId: res.id,
        petName: res.petName,
        rowHint: 9,
        colorPlan: [],
        cellUpdates: [{ cell: "D9", value: res.petName }],
        metadataUpdates: [],
      };
    },
    async writeReservation(res: DemoReservationRecord): Promise<SheetsWriteResult> {
      counters.writes += 1;
      counters.writtenReservations.push(structuredClone(res));
      return {
        ok: true,
        reservationId: res.id,
        sheetName: "DICIEMBRE 2026",
        petName: res.petName,
        rowHint: 9,
        colorPlan: [],
        cellUpdates: [{ cell: "D9", value: res.petName }],
        metadataUpdates: [],
        mode: "mock",
      };
    },
    async cancelReservation(reservationId: string) {
      counters.cancellations += 1;
      return {
        ok: true,
        reservationId,
        sheetName: "DICIEMBRE 2026",
        clearedCells: ["B7", "C7"],
        metadataUpdates: [],
        mode: "mock",
        cancelledAt: "2026-06-02T10:00:00.000Z",
      };
    },
  };

  return {
    counters,
    records,
    deps: {
      now: () => new Date("2026-06-02T09:00:00.000Z"),
      async buildSheetAdapter() {
        return adapter;
      },
      async listReservationRecords() {
        return structuredClone(records);
      },
      async upsertReservationRecord(next: ReservationRecord) {
        const index = records.findIndex((item) => item.reservationId === next.reservationId);
        if (index >= 0) records[index] = structuredClone(next);
        else records.push(structuredClone(next));
      },
    },
  };
}

const knownDirectory = createStaticClientDirectory([
  {
    nombre: "SMP QA",
    telefonoMovil: "+34 612 345 678",
    telefonoNormalizado: "34612345678",
    email: "qa@example.test",
    rowNumber: 2,
    sheetName: "CLIENTES_QA",
  },
]);

describe("reservation modification and cancellation conversation flow", () => {
  it("starts a modification flow instead of handing off to the FAQ fallback", async () => {
    const store = new MemoryConversationStore();
    const deps = makeDeps([reservation()]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "quiero modificar una reserva" },
      store,
      knownDirectory,
      deps.deps,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.pendingReservationModificationFlow).toMatchObject({
      status: "collecting_change",
      targetReservationId: "res-change-001",
    });
    expect(result.botReply?.body).toContain("He encontrado tu reserva");
    expect(result.botReply?.body).toContain("¿Qué quieres modificar?");
  });

  it("proposes and confirms a date modification with revalidation, sheet update and entry log projection", async () => {
    const store = new MemoryConversationStore();
    const deps = makeDeps([reservation()]);

    await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "quiero modificar una reserva" },
      store,
      knownDirectory,
      deps.deps,
    );
    const proposed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34612345678",
        body: "quiero cambiarla del 29 al 31 de diciembre de 2026",
      },
      store,
      knownDirectory,
      deps.deps,
    );
    expect(proposed.conversation.pendingReservationModificationFlow).toMatchObject({
      status: "awaiting_confirmation",
      requestedCheckInDate: "2026-12-29",
      requestedCheckOutDate: "2026-12-31",
    });
    expect(proposed.botReply?.body).toContain("¿Confirmas el cambio?");

    const confirmed = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "sí" },
      store,
      knownDirectory,
      deps.deps,
    );

    expect(confirmed.botReply?.body).toContain("Cambio confirmado");
    expect(deps.counters.checks).toBe(2);
    expect(deps.counters.cancellations).toBe(1);
    expect(deps.counters.writes).toBe(1);
    expect(deps.records[0]).toMatchObject({
      reservationId: "res-change-001",
      status: "confirmada",
      checkInDate: "2026-12-29",
      checkOutDate: "2026-12-31",
    });
    expect(buildEntryLogRecord(deps.records[0]).action).toBe("modificada");
    expect(JSON.stringify(confirmed.conversation).toLowerCase()).not.toContain("nif");
    expect(JSON.stringify(confirmed.conversation).toLowerCase()).not.toContain("dni");
  });

  it("does not apply a pending modification when the customer rejects it", async () => {
    const store = new MemoryConversationStore();
    const deps = makeDeps([reservation()]);

    await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "quiero modificar una reserva" },
      store,
      knownDirectory,
      deps.deps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "del 29 al 31 de diciembre de 2026" },
      store,
      knownDirectory,
      deps.deps,
    );
    const rejected = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "no" },
      store,
      knownDirectory,
      deps.deps,
    );

    expect(rejected.botReply?.body).toContain("no hacemos ningún cambio");
    expect(deps.counters.writes).toBe(0);
    expect(deps.counters.cancellations).toBe(0);
    expect(deps.records[0].checkInDate).toBe("2026-12-26");
  });

  it("asks which reservation to change when a client has multiple future reservations", async () => {
    const store = new MemoryConversationStore();
    const deps = makeDeps([
      reservation({ reservationId: "res-change-001", petName: "Kira QA" }),
      reservation({
        reservationId: "res-change-002",
        petName: "Toby QA",
        checkInDate: "2027-01-03",
        checkOutDate: "2027-01-05",
      }),
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "quiero cambiar una reserva" },
      store,
      knownDirectory,
      deps.deps,
    );

    expect(result.botReply?.body).toContain("Tienes varias reservas futuras");
    expect(result.conversation.pendingReservationModificationFlow?.status).toBe(
      "identifying_reservation",
    );
  });

  it("starts and confirms a cancellation without deleting the reservation record", async () => {
    const store = new MemoryConversationStore();
    const deps = makeDeps([reservation()]);

    const start = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "quiero cancelar una reserva" },
      store,
      knownDirectory,
      deps.deps,
    );
    expect(start.botReply?.body).toContain("¿Confirmas que quieres cancelarla?");
    expect(start.conversation.pendingReservationCancellationFlow).toMatchObject({
      status: "awaiting_confirmation",
      targetReservationId: "res-change-001",
    });

    const confirmed = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "sí por favor" },
      store,
      knownDirectory,
      deps.deps,
    );

    expect(confirmed.botReply?.body).toContain("Reserva cancelada");
    expect(deps.counters.cancellations).toBe(1);
    expect(deps.records[0]).toMatchObject({
      reservationId: "res-change-001",
      status: "cancelada",
      workflowState: "cancelled",
    });
    expect(buildEntryLogRecord(deps.records[0]).action).toBe("cancelada");
  });

  it("does not confirm anything when a bare yes arrives without a pending proposal", async () => {
    const store = new MemoryConversationStore();
    const deps = makeDeps([reservation()]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "sí" },
      store,
      knownDirectory,
      deps.deps,
    );

    expect(result.botReply?.body).toContain("hacer una reserva");
    expect(deps.counters.writes).toBe(0);
    expect(deps.counters.cancellations).toBe(0);
  });

  it("keeps modification state through a FAQ interruption and then confirms the change", async () => {
    const store = new MemoryConversationStore();
    const deps = makeDeps([reservation()]);

    await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "quiero modificar una reserva" },
      store,
      knownDirectory,
      deps.deps,
    );
    const faq = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "¿y el pago?" },
      store,
      knownDirectory,
      deps.deps,
    );
    expect(faq.botReply?.body).toContain("Seguimos con la modificación");

    await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "del 29 al 31 de diciembre de 2026" },
      store,
      knownDirectory,
      deps.deps,
    );
    const confirmed = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "confirmo" },
      store,
      knownDirectory,
      deps.deps,
    );

    expect(confirmed.botReply?.body).toContain("Cambio confirmado");
    expect(deps.counters.writes).toBe(1);
  });
});
