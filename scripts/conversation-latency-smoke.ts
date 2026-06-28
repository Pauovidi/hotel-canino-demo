import { performance } from "node:perf_hooks";
import { createStaticClientDirectory } from "@/lib/hotel/clients";
import { handleInboundWhatsApp } from "@/lib/hotel/conversations/service";
import {
  createEmptyConversationSnapshot,
  filterConversationRecords,
  type ConversationStore,
} from "@/lib/hotel/conversations/store";
import type {
  Conversation,
  ConversationEvent,
  ConversationListFilters,
  ConversationRecord,
  ConversationSnapshot,
  Message,
} from "@/lib/hotel/conversations/types";
import type { AuthorityTurnTrace } from "@/lib/hotel/conversations/authority/types";
import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import type { DemoReservationRecord, SheetsAvailabilityResult } from "@/lib/hotel/integrations/types";
import type { SheetAdapter, SheetsWriteResult } from "@/lib/hotel/sheets/types";

class TimedMemoryConversationStore implements ConversationStore {
  private snapshot = createEmptyConversationSnapshot();

  counters = {
    reads: 0,
    writes: 0,
    events: 0,
  };

  resetCounters(): void {
    this.counters = { reads: 0, writes: 0, events: 0 };
  }

  async load(): Promise<ConversationSnapshot> {
    this.counters.reads += 1;
    return structuredClone(this.snapshot);
  }

  async save(snapshot: ConversationSnapshot): Promise<void> {
    this.counters.writes += 1;
    this.snapshot = structuredClone(snapshot);
  }

  async list(filters?: ConversationListFilters): Promise<ConversationRecord[]> {
    this.counters.reads += 1;
    return filterConversationRecords(this.snapshot.conversations, filters);
  }

  async getById(id: string): Promise<ConversationRecord | undefined> {
    this.counters.reads += 1;
    return structuredClone(
      this.snapshot.conversations.find((conversation) => conversation.id === id),
    );
  }

  async getByPhone(phoneNormalized: string): Promise<ConversationRecord | undefined> {
    this.counters.reads += 1;
    return structuredClone(
      this.snapshot.conversations.find(
        (conversation) => conversation.phoneNormalized === phoneNormalized,
      ),
    );
  }

  async upsertConversation(conversation: Conversation): Promise<ConversationRecord> {
    this.counters.writes += 1;
    const index = this.snapshot.conversations.findIndex(
      (record) => record.id === conversation.id,
    );
    const existing = index >= 0 ? this.snapshot.conversations[index] : undefined;
    const record: ConversationRecord = {
      ...existing,
      ...conversation,
      messages: existing?.messages ?? [],
      events: existing?.events ?? [],
    };

    if (index >= 0) {
      this.snapshot.conversations[index] = record;
    } else {
      this.snapshot.conversations.push(record);
    }

    return structuredClone(record);
  }

  async addMessage(message: Message): Promise<Message> {
    this.counters.writes += 1;
    const record = this.snapshot.conversations.find(
      (conversation) => conversation.id === message.conversationId,
    );
    if (!record) {
      throw new Error("Conversation not found");
    }

    record.messages.push(message);
    record.lastMessagePreview = message.body;
    record.updatedAt = message.createdAt;
    if (message.direction === "inbound") {
      record.unreadCount += 1;
      record.lastInboundAt = message.createdAt;
    } else {
      record.lastOutboundAt = message.createdAt;
    }

    return structuredClone(message);
  }

  async addEvent(event: ConversationEvent): Promise<ConversationEvent> {
    this.counters.writes += 1;
    this.counters.events += 1;
    const record = this.snapshot.conversations.find(
      (conversation) => conversation.id === event.conversationId,
    );
    if (!record) {
      throw new Error("Conversation not found");
    }

    record.events.push(event);
    record.updatedAt = event.createdAt;
    return structuredClone(event);
  }

  async replaceConversation(record: ConversationRecord): Promise<ConversationRecord> {
    this.counters.writes += 1;
    const index = this.snapshot.conversations.findIndex(
      (conversation) => conversation.id === record.id,
    );
    if (index >= 0) {
      this.snapshot.conversations[index] = structuredClone(record);
    } else {
      this.snapshot.conversations.push(structuredClone(record));
    }

    return structuredClone(record);
  }

  async seed(records: ConversationRecord[]): Promise<ConversationSnapshot> {
    this.counters.writes += 1;
    this.snapshot = {
      conversations: structuredClone(records),
      updatedAt: new Date().toISOString(),
    };
    return this.load();
  }
}

function makeAvailability(): SheetsAvailabilityResult {
  return {
    available: true,
    conflicts: [],
    monthKey: "2026-06",
    sheetName: "JUNIO 2026",
    remainingByDate: {
      "2026-06-29": { morning: 8, afternoon: 8 },
      "2026-06-30": { morning: 8, afternoon: 8 },
    },
  };
}

function makeBridgeDeps() {
  const counters = {
    checks: 0,
    writes: 0,
    cancellations: 0,
    reservations: [] as ReservationRecord[],
  };
  const adapter: SheetAdapter = {
    async readMonth() {
      return {
        monthKey: "2026-06",
        sheetName: "JUNIO 2026",
        capacityBySlot: { morning: 10, afternoon: 10 },
        occupiedByDate: {},
        reservations: [],
        colorPlan: [],
      };
    },
    async validateMonthStructure() {
      return {
        ok: true,
        monthKey: "2026-06",
        sheetName: "JUNIO 2026",
        layout: {} as never,
        issues: [],
        rowCount: 39,
        dayHeaders: [29, 30],
        occupiedCells: 0,
      };
    },
    async checkAvailability() {
      counters.checks += 1;
      return makeAvailability();
    },
    async buildWritePlan(reservation: DemoReservationRecord) {
      return {
        sheetName: "JUNIO 2026",
        reservationId: reservation.id,
        petName: reservation.petName,
        rowHint: 7,
        colorPlan: [],
        cellUpdates: [{ cell: "B7", value: reservation.petName }],
        metadataUpdates: [],
      };
    },
    async writeReservation(reservation: DemoReservationRecord): Promise<SheetsWriteResult> {
      counters.writes += 1;
      return {
        ok: true,
        reservationId: reservation.id,
        sheetName: "JUNIO 2026",
        petName: reservation.petName,
        rowHint: 7,
        colorPlan: [],
        cellUpdates: [{ cell: "B7", value: reservation.petName }],
        metadataUpdates: [],
        mode: "mock",
      };
    },
    async cancelReservation(reservationId: string) {
      counters.cancellations += 1;
      return {
        ok: true,
        reservationId,
        sheetName: "JUNIO 2026",
        clearedCells: ["B7"],
        metadataUpdates: [],
        mode: "mock",
        cancelledAt: new Date().toISOString(),
      };
    },
  };

  return {
    counters,
    deps: {
      now: () => new Date("2026-06-28T10:00:00.000Z"),
      async buildSheetAdapter() {
        return adapter;
      },
      async upsertReservationRecord(reservation: ReservationRecord) {
        const next = structuredClone(reservation);
        const existingIndex = counters.reservations.findIndex(
          (item) => item.reservationId === next.reservationId,
        );
        if (existingIndex >= 0) {
          counters.reservations[existingIndex] = next;
        } else {
          counters.reservations.push(next);
        }
      },
      async listReservationRecords() {
        return structuredClone(counters.reservations);
      },
      async upsertClientFromConfirmedReservation() {
        return {
          kind: "created_pending_name" as const,
          clientStatus: "known" as const,
          clientName: "Contacto WhatsApp ****9991",
          rowNumber: 9001,
          sheetName: "CLIENTES_QA",
          warning: "client_name_pending_review",
          source: "google_sheets_client_directory" as const,
        };
      },
    },
  };
}

function latestAuthorityTrace(record: ConversationRecord): AuthorityTurnTrace | undefined {
  const event = record.events
    .filter((entry) => entry.eventType === "authority_turn_completed")
    .at(-1);
  return event?.payload as AuthorityTurnTrace | undefined;
}

function summarizeRow(input: {
  turn: string;
  measuredTotalMs: number;
  trace?: AuthorityTurnTrace;
  store: TimedMemoryConversationStore;
}) {
  const trace = input.trace;
  const totalDurationMs = trace?.totalDurationMs ?? Math.round(input.measuredTotalMs);
  return {
    turn: input.turn,
    totalDurationMs,
    nluTotalMs: trace?.nluTotalMs ?? 0,
    storeMs: trace
      ? trace.loadStateMs + trace.persistenceMs + trace.eventLogMs
      : 0,
    renderMs: trace?.rendererMs ?? 0,
    eventsWritten: Math.max(trace?.eventsWritten ?? 0, input.store.counters.events),
    openaiCalls: trace?.openaiCalls ?? 0,
    usedFallback: trace?.usedDeterministicFallback ?? true,
    storeReads: input.store.counters.reads,
    storeWrites: input.store.counters.writes,
  };
}

async function main() {
  const store = new TimedMemoryConversationStore();
  const { deps } = makeBridgeDeps();
  const directory = createStaticClientDirectory([
    {
      nombre: "SMP Latency QA",
      telefonoMovil: "+34 600 009 991",
      telefonoNormalizado: "34600009991",
      rowNumber: 9001,
      sheetName: "CLIENTES_QA",
    },
  ]);
  const from = "whatsapp:+34600009991";
  const to = "whatsapp:+14155238886";
  const turns = [
    "hola",
    "quiero reservar",
    "PIPO",
    "mañana",
    "a las 10",
    "pasado mañana a la misma hora",
    "diferencia entre hotel y guardería",
    "ya no quiero reservar",
  ];
  const rows = [];

  for (const [index, body] of turns.entries()) {
    store.resetCounters();
    const startedAt = performance.now();
    const result = await handleInboundWhatsApp(
      {
        from,
        to,
        body,
        messageSid: `SM_LATENCY_${index}`,
      },
      store,
      directory,
      deps,
    );
    const measuredTotalMs = performance.now() - startedAt;
    rows.push(summarizeRow({
      turn: body,
      measuredTotalMs,
      trace: latestAuthorityTrace(result.conversation),
      store,
    }));
  }

  console.table(rows);
  console.log(JSON.stringify(rows, null, 2));

  const failed = rows.filter((row) => row.totalDurationMs < 0);
  if (failed.length > 0) {
    throw new Error(`Latency smoke failed: negative timings for ${failed.map((row) => row.turn).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
