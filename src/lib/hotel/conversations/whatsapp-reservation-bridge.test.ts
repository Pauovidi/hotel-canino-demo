import { afterEach, describe, expect, it } from "vitest";

import { buildEntryLogRecord } from "@/lib/hotel/application/entry-log";
import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import type { DemoReservationRecord, SheetsAvailabilityResult } from "@/lib/hotel/integrations/types";
import {
  createStaticClientDirectory,
  type ClientUpsertFromConfirmedReservationInput,
  type ClientUpsertFromConfirmedReservationResult,
} from "@/lib/hotel/clients";
import type { SheetAdapter, SheetsWriteResult } from "@/lib/hotel/sheets/types";
import { handleInboundWhatsApp, listConversationDashboard } from "./service";
import { buildConversationReplyPlan } from "./nlu";
import { renderConversationReplyPlan } from "./authority/copy-renderer";
import { TEMPLATE_PREVIEW_FAILED_REPLY } from "./template-preview";
import { MemoryScheduledMessageStore } from "./scheduled-messages";
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

const previousEnv = { ...process.env };

afterEach(() => {
  process.env = { ...previousEnv };
});

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
    if (!record) {
      throw new Error("Conversation not found");
    }
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
    if (!record) {
      throw new Error("Conversation not found");
    }
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

class PostConfirmationStoreFailureConversationStore extends MemoryConversationStore {
  async replaceConversation(record: ConversationRecord): Promise<ConversationRecord> {
    if (
      record.pendingReservationProposal?.status === "confirmed" ||
      record.reservationFlow?.status === "confirmed"
    ) {
      throw new Error("mock post confirmation replace failed");
    }

    return super.replaceConversation(record);
  }

  async addMessage(message: Message): Promise<Message> {
    if (message.direction === "outbound" && message.body.includes("Reserva confirmada")) {
      throw new Error("mock post confirmation bot message failed");
    }

    return super.addMessage(message);
  }
}

function makeAvailability(available = true): SheetsAvailabilityResult {
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

function makeBridgeDeps(options: {
  availabilitySequence?: boolean[];
  writeFails?: boolean;
  recordUpsertFails?: boolean;
  clientUpsertResult?: ClientUpsertFromConfirmedReservationResult;
  clientUpsertFails?: boolean;
} = {}) {
  const counters = {
    checks: 0,
    writes: 0,
    reservations: [] as ReservationRecord[],
    clientUpserts: [] as ClientUpsertFromConfirmedReservationInput[],
  };
  const sequence = options.availabilitySequence ?? [true, true];
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
      const available = sequence[Math.min(counters.checks, sequence.length - 1)];
      counters.checks += 1;
      return makeAvailability(available);
    },
    async buildWritePlan(reservation: DemoReservationRecord) {
      return {
        sheetName: "DICIEMBRE 2026",
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
      if (options.writeFails) {
        throw new Error("mock sheet write failed");
      }
      return {
        ok: true,
        reservationId: reservation.id,
        sheetName: "DICIEMBRE 2026",
        petName: reservation.petName,
        rowHint: 7,
        colorPlan: [],
        cellUpdates: [{ cell: "B7", value: reservation.petName }],
        metadataUpdates: [],
        mode: "mock",
      };
    },
    async cancelReservation(reservationId: string) {
      return {
        ok: true,
        reservationId,
        sheetName: "DICIEMBRE 2026",
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
      async buildSheetAdapter() {
        return adapter;
      },
      async upsertReservationRecord(reservation: ReservationRecord) {
        if (options.recordUpsertFails) {
          throw new Error("mock reservation record upsert failed");
        }
        const nextReservation = structuredClone(reservation);
        const existingIndex = counters.reservations.findIndex(
          (item) => item.reservationId === nextReservation.reservationId,
        );
        if (existingIndex >= 0) {
          counters.reservations[existingIndex] = nextReservation;
        } else {
          counters.reservations.push(nextReservation);
        }
      },
      async upsertClientFromConfirmedReservation(input: ClientUpsertFromConfirmedReservationInput) {
        counters.clientUpserts.push(structuredClone(input));
        if (options.clientUpsertFails) {
          throw new Error("mock client upsert failed");
        }
        return (
          options.clientUpsertResult ?? {
            kind: "created_pending_name",
            clientStatus: "known",
            clientName: "Contacto WhatsApp ****9991",
            rowNumber: 100,
            sheetName: "CLIENTES_QA",
            warning: "client_name_pending_review",
            source: "google_sheets_client_directory",
          }
        );
      },
    },
  };
}

async function createNewClientPricedProposal(input: {
  store: ConversationStore;
  deps: ReturnType<typeof makeBridgeDeps>["deps"];
  from?: string;
  petName?: string;
  dogs?: number;
  dateText?: string;
  directory?: ReturnType<typeof createStaticClientDirectory>;
  prefix?: string;
}) {
  const from = input.from ?? "whatsapp:+34600009991";
  const directory = input.directory ?? createStaticClientDirectory([]);
  const prefix = input.prefix ?? "SM_FLOW";
  await handleInboundWhatsApp(
    { from, body: "Quiero reservar para mi mascota", messageSid: `${prefix}_START` },
    input.store,
    directory,
    input.deps,
  );
  await handleInboundWhatsApp(
    { from, body: "No soy cliente", messageSid: `${prefix}_NEW` },
    input.store,
    directory,
    input.deps,
  );
  await handleInboundWhatsApp(
    { from, body: "Ana QA ana.qa@example.test", messageSid: `${prefix}_OWNER` },
    input.store,
    directory,
    input.deps,
  );
  await handleInboundWhatsApp(
    {
      from,
      body: `${input.petName ?? "Kira QA"}, ${input.dogs ?? 1} perro${(input.dogs ?? 1) > 1 ? "s" : ""}`,
      messageSid: `${prefix}_PET`,
    },
    input.store,
    directory,
    input.deps,
  );
  await handleInboundWhatsApp(
    {
      from,
      body: input.dateText ?? "Del 29 al 31 de diciembre de 2026",
      messageSid: `${prefix}_DATES`,
    },
    input.store,
    directory,
    input.deps,
  );
  await handleInboundWhatsApp(
    {
      from,
      body: "Entrada a las 12:00 y salida a las 12:00",
      messageSid: `${prefix}_TIMES`,
    },
    input.store,
    directory,
    input.deps,
  );
  await handleInboundWhatsApp(
    { from, body: "Sin notas", messageSid: `${prefix}_NOTES` },
    input.store,
    directory,
    input.deps,
  );
  return handleInboundWhatsApp(
    { from, body: "No", messageSid: `${prefix}_VISIT` },
    input.store,
    directory,
    input.deps,
  );
}

async function collectNewClientOwner(input: {
  store: ConversationStore;
  deps: ReturnType<typeof makeBridgeDeps>["deps"];
  from?: string;
  directory?: ReturnType<typeof createStaticClientDirectory>;
  prefix: string;
}) {
  const from = input.from ?? "whatsapp:+34600009991";
  const directory = input.directory ?? createStaticClientDirectory([]);
  await handleInboundWhatsApp(
    { from, body: "Quiero reservar para mi mascota", messageSid: `${input.prefix}_START` },
    input.store,
    directory,
    input.deps,
  );
  await handleInboundWhatsApp(
    { from, body: "No soy cliente", messageSid: `${input.prefix}_NEW` },
    input.store,
    directory,
    input.deps,
  );
  return handleInboundWhatsApp(
    { from, body: "Ana QA ana.qa@example.test", messageSid: `${input.prefix}_OWNER` },
    input.store,
    directory,
    input.deps,
  );
}

async function collectNewClientPet(input: {
  store: ConversationStore;
  deps: ReturnType<typeof makeBridgeDeps>["deps"];
  from?: string;
  petName?: string;
  dogs?: number;
  directory?: ReturnType<typeof createStaticClientDirectory>;
  prefix: string;
}) {
  const from = input.from ?? "whatsapp:+34600009991";
  const directory = input.directory ?? createStaticClientDirectory([]);
  await collectNewClientOwner({
    store: input.store,
    deps: input.deps,
    from,
    directory,
    prefix: input.prefix,
  });
  const dogs = input.dogs ?? 1;
  return handleInboundWhatsApp(
    {
      from,
      body: `${input.petName ?? "Kira QA"}, ${dogs} perro${dogs > 1 ? "s" : ""}`,
      messageSid: `${input.prefix}_PET`,
    },
    input.store,
    directory,
    input.deps,
  );
}

type TestAuthorityTrace = Record<string, unknown> & { pendingFieldsAfter: string[] };

function expectNonNegativeTraceTimings(trace: TestAuthorityTrace): void {
  for (const key of [
    "totalDurationMs",
    "routeAuthMs",
    "parseMs",
    "loadStateMs",
    "clientLookupMs",
    "nluTotalMs",
    "nluProviderMs",
    "deterministicParserMs",
    "reducerMs",
    "policyMs",
    "toolsMs",
    "rendererMs",
    "persistenceMs",
    "eventLogMs",
    "outboxBuildMs",
    "twimlBuildMs",
    "postgresReads",
    "postgresWrites",
    "sheetsReads",
    "sheetsWrites",
    "openaiCalls",
    "eventsWritten",
  ]) {
    expect(typeof trace[key]).toBe("number");
    expect(trace[key] as number).toBeGreaterThanOrEqual(0);
  }
  for (const key of [
    "clientDirectoryCacheHit",
    "conversationStoreCacheHit",
    "usedOpenAI",
    "usedDeterministicFallback",
    "tracePersisted",
    "traceDroppedBestEffort",
  ]) {
    expect(typeof trace[key]).toBe("boolean");
  }
}

function latestAuthorityTrace(record: ConversationRecord): TestAuthorityTrace {
  const event = record.events
    .filter((entry) => entry.eventType === "authority_turn_completed")
    .at(-1);
  expect(event).toBeDefined();
  return event?.payload as TestAuthorityTrace;
}

function hasContractGateEvent(
  record: ConversationRecord,
  eventType: "contract_gate_applied" | "contract_gate_skipped",
  reason: string,
): boolean {
  return record.events.some(
    (event) =>
      event.eventType === eventType &&
      event.payload &&
      typeof event.payload === "object" &&
      "reason" in event.payload &&
      event.payload.reason === reason,
  );
}

async function collectNewClientDatesWithoutTimes(input: {
  store: ConversationStore;
  deps: ReturnType<typeof makeBridgeDeps>["deps"];
  from?: string;
  directory?: ReturnType<typeof createStaticClientDirectory>;
  prefix: string;
  petName?: string;
  dateText?: string;
}) {
  const from = input.from ?? "whatsapp:+34600009991";
  const directory = input.directory ?? createStaticClientDirectory([]);
  await collectNewClientPet({
    store: input.store,
    deps: input.deps,
    from,
    directory,
    prefix: input.prefix,
    petName: input.petName ?? "YUYU",
    dogs: 1,
  });
  return handleInboundWhatsApp(
    {
      from,
      body: input.dateText ?? "Del 29 al 30 de diciembre",
      messageSid: `${input.prefix}_DATES_ONLY`,
    },
    input.store,
    directory,
    input.deps,
  );
}

describe("WhatsApp reservation bridge", () => {
  it("asks client branch before proposing availability", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Quiero reservar para Kira QA del 29 al 31 de diciembre de 2026",
        messageSid: "SM_BRIDGE_PROPOSAL",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.reservationId).toBeUndefined();
    expect(result.conversation.pendingReservationProposal).toBeUndefined();
    expect(result.conversation.reservationFlow).toMatchObject({
      status: "asking_client_kind",
      clientKind: "unknown",
    });
    expect(result.botReply?.body).toContain("¿Ya eres cliente de Somos Muy Perros?");
    expect(counters.checks).toBe(0);
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
    expect(counters.clientUpserts).toHaveLength(0);
  });

  it("builds a priced proposal after collecting client data, stay times, notes and visit", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-05-29T10:00:00.000Z"),
    };

    const proposed = await createNewClientPricedProposal({
      store,
      deps: timedDeps,
      petName: "Toby",
      prefix: "SM_BRIDGE_SLOT_FILL",
    });

    expect(proposed.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      petName: "Toby",
      checkIn: "2026-12-29",
      checkOut: "2026-12-31",
      checkInTime: "12:00",
      checkOutTime: "12:00",
      price: 60,
      priceSource: "calculated",
    });
    expect(proposed.botReply?.body).toContain("Tenemos disponibilidad");
    expect(proposed.botReply?.body).toContain("60 €");
    expect(counters.checks).toBe(1);
    expect(counters.writes).toBe(0);
  });

  it("asks habitual clients for email before collecting reservation details", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Quiero reservar",
        messageSid: "SM_BRIDGE_HABITUAL_START",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí soy cliente",
        messageSid: "SM_BRIDGE_HABITUAL_YES",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "asking_existing_email",
      clientKind: "habitual",
    });
    expect(result.botReply?.body).toContain("email");
    expect(counters.checks).toBe(0);
    expect(counters.writes).toBe(0);
  });

  it("matches habitual clients by exact email from CLIENTES", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const directory = createStaticClientDirectory([
      {
        nombre: "Cliente QA Email",
        email: "cliente.email@example.test",
        rowNumber: 22,
        sheetName: "CLIENTES_QA",
      },
    ]);

    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Quiero reservar",
        messageSid: "SM_BRIDGE_EMAIL_MATCH_START",
      },
      store,
      directory,
      deps,
    );
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí soy cliente",
        messageSid: "SM_BRIDGE_EMAIL_MATCH_YES",
      },
      store,
      directory,
      deps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "cliente.email@example.test",
        messageSid: "SM_BRIDGE_EMAIL_MATCH_VALUE",
      },
      store,
      directory,
      deps,
    );

    expect(result.conversation).toMatchObject({
      clientStatus: "known",
      clientConfidence: "strong",
      clientMatchType: "email",
      clientName: "Cliente QA Email",
      clientEmail: "cliente.email@example.test",
    });
    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_pet",
      clientKind: "habitual",
      email: "cliente.email@example.test",
      ownerName: "Cliente QA Email",
    });
    expect(result.conversation.events.some((event) => event.eventType === "reservation_flow_existing_client_email_match")).toBe(true);
    expect(counters.checks).toBe(0);
  });

  it("falls back to new contact collection when habitual email is not found", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Quiero reservar",
        messageSid: "SM_BRIDGE_EMAIL_MISS_START",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí soy cliente",
        messageSid: "SM_BRIDGE_EMAIL_MISS_YES",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "noexiste@example.test",
        messageSid: "SM_BRIDGE_EMAIL_MISS_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.clientStatus).toBe("unknown");
    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_owner",
      clientKind: "new",
      email: "noexiste@example.test",
    });
    expect(result.botReply?.body).toContain("nuevo contacto");
    expect(counters.checks).toBe(0);
  });

  it("starts new-client collection without checking availability", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Quiero reservar",
        messageSid: "SM_BRIDGE_NEW_START",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "No soy cliente",
        messageSid: "SM_BRIDGE_NEW_NO",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_owner",
      clientKind: "new",
    });
    expect(result.botReply?.body).toContain("nombre y apellidos");
    expect(counters.checks).toBe(0);
    expect(counters.writes).toBe(0);
  });

  it("uses softer reservation copy and asks for pet names instead of dog count first", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const directory = createStaticClientDirectory([]);
    const from = "whatsapp:+34600009991";

    const start = await handleInboundWhatsApp(
      { from, body: "Quiero reservar para mi mascota", messageSid: "SM_BRIDGE_COPY_START" },
      store,
      directory,
      deps,
    );
    const newClient = await handleInboundWhatsApp(
      { from, body: "no", messageSid: "SM_BRIDGE_COPY_NEW" },
      store,
      directory,
      deps,
    );
    const petPrompt = await handleInboundWhatsApp(
      { from, body: "Ana QA ana.qa@example.test", messageSid: "SM_BRIDGE_COPY_OWNER" },
      store,
      directory,
      deps,
    );

    expect(start.botReply?.body).toBe("Genial. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.");
    expect(newClient.botReply?.body).toContain("De acuerdo, te tomo los datos");
    expect(petPrompt.botReply?.body).toContain("nombre o los nombres de tu mascota/s");
    expect(petPrompt.botReply?.body).not.toContain("Dime el nombre de tu mascota y cuántos perros son.");
    expect([start, newClient, petPrompt].filter((item) => item.botReply?.body.startsWith("Perfecto"))).toHaveLength(0);
  });

  it.each([
    ["YUYU", "YUYU", ["YUYU"], 1],
    ["YUYU y KIRA", "YUYU y KIRA", ["YUYU", "KIRA"], 2],
    ["YUYU, KIRA y TOBY", "YUYU, KIRA y TOBY", ["YUYU", "KIRA", "TOBY"], 3],
    ["Mis mascotas se llaman YUYU y KIRA", "YUYU y KIRA", ["YUYU", "KIRA"], 2],
    ["Tengo dos perros, YUYU y KIRA", "YUYU y KIRA", ["YUYU", "KIRA"], 2],
    ["YUYU, 1", "YUYU", ["YUYU"], 1],
    ["El nombre de mi mascota es YUYU", "YUYU", ["YUYU"], 1],
    ["Mi mascota se llama Toby", "Toby", ["Toby"], 1],
  ] as const)("infers dog count from pet names: %s", async (message, petName, petNames, petCount) => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();

    await collectNewClientOwner({
      store,
      deps,
      prefix: `SM_BRIDGE_PET_NAMES_${message}`,
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: message,
        messageSid: `SM_BRIDGE_PET_NAMES_RESULT_${message}`,
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName,
      petNames,
      petCount,
    });
  });

  it("asks for pet names when the user only provides a dog count", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();

    await collectNewClientOwner({
      store,
      deps,
      prefix: "SM_BRIDGE_PET_COUNT_ONLY",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "2",
        messageSid: "SM_BRIDGE_PET_COUNT_ONLY_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_pet",
      petCount: 2,
    });
    expect(result.botReply?.body).toContain("¿Cómo se llaman las dos mascotas?");
    expect(result.botReply?.body).not.toContain("¿Quieres hacer una reserva");
  });

  it("detects inconsistent pet names and dog count", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();

    await collectNewClientOwner({
      store,
      deps,
      prefix: "SM_BRIDGE_PET_COUNT_INCONSISTENT",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "YUYU y KIRA, son 3",
        messageSid: "SM_BRIDGE_PET_COUNT_INCONSISTENT_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_pet",
      petName: "YUYU y KIRA",
      petNames: ["YUYU", "KIRA"],
      petCountInconsistency: { nameCount: 2, statedCount: 3 },
    });
    expect(result.botReply?.body).toContain("Tengo 2 nombres pero indicas 3 perros");
  });

  it("does not price automatically for more than four pet names", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await collectNewClientOwner({
      store,
      deps,
      prefix: "SM_BRIDGE_TOO_MANY_PETS",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "YUYU, KIRA, TOBY, LUNA y NALA",
        messageSid: "SM_BRIDGE_TOO_MANY_PETS_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.humanRequested).toBe(true);
    expect(result.conversation.pendingReservationProposal).toBeUndefined();
    expect(result.botReply?.body).toContain("más de 4 perros");
    expect(counters.checks).toBe(0);
  });

  it("asks for stay hours when dates arrive without times", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Quiero reservar", messageSid: "SM_BRIDGE_HOURS_START" },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "No soy cliente", messageSid: "SM_BRIDGE_HOURS_NEW" },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Ana QA ana.qa@example.test", messageSid: "SM_BRIDGE_HOURS_OWNER" },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Toby, 1 perro", messageSid: "SM_BRIDGE_HOURS_PET" },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Del 29 al 31 de diciembre de 2026", messageSid: "SM_BRIDGE_HOURS_DATES" },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-12-29",
      checkOutDate: "2026-12-31",
    });
    expect(result.botReply?.body).toContain("Ya tengo las fechas");
    expect(counters.checks).toBe(0);
  });

  it("extracts explicit dates and times from a rich pet answer", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Quiero reservar", messageSid: "SM_BRIDGE_RICH_START" },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "No soy cliente", messageSid: "SM_BRIDGE_RICH_NEW" },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Ana QA ana.qa@example.test", messageSid: "SM_BRIDGE_RICH_OWNER" },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Bimba, 2 perros, del 29 al 31 de diciembre de 2026, entrada a las 10:30 y salida a las 17:00",
        messageSid: "SM_BRIDGE_RICH_DETAILS",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      petName: "Bimba",
      petCount: 2,
      checkInDate: "2026-12-29",
      checkInTime: "10:30",
      checkInSlot: "morning",
      checkOutDate: "2026-12-31",
      checkOutTime: "17:00",
      checkOutSlot: "afternoon",
    });
    expect(counters.checks).toBe(0);
  });

  it.each([
    [
      "Entrada el 30 de diciembre a las 12:00 y salida el 31 de diciembre a las 18:00",
      "12:00",
      "18:00",
      "morning",
      "afternoon",
    ],
    [
      "Entraría el 30 de diciembre a las 12:00 y saldría el 31 de diciembre a las 18:00",
      "12:00",
      "18:00",
      "morning",
      "afternoon",
    ],
    [
      "Dejo a mi perro el 30 de diciembre a las 12 y lo recojo el 31 de diciembre a las 18",
      "12:00",
      "18:00",
      "morning",
      "afternoon",
    ],
    [
      "Entrada 30/12 12:00, salida 31/12 18:00",
      "12:00",
      "18:00",
      "morning",
      "afternoon",
    ],
    [
      "Entramos el 30/12 a las 10:30 y salimos el 31/12 a las 12:00",
      "10:30",
      "12:00",
      "morning",
      "morning",
    ],
    [
      "Del 30 al 31 de diciembre, entrada a las 12:00 y salida a las 18:00",
      "12:00",
      "18:00",
      "morning",
      "afternoon",
    ],
    [
      "Del 30 al 31 de diciembre, entrada a las 12 y salida a las 18",
      "12:00",
      "18:00",
      "morning",
      "afternoon",
    ],
  ] as const)(
    "extracts natural stay dates and times without changing petName: %s",
    async (message, checkInTime, checkOutTime, checkInSlot, checkOutSlot) => {
      const store = new MemoryConversationStore();
      const { counters, deps } = makeBridgeDeps();
      const timedDeps = {
        ...deps,
        now: () => new Date("2026-06-01T10:00:00.000Z"),
      };

      await collectNewClientPet({
        store,
        deps: timedDeps,
        petName: "Kira QA",
        prefix: `SM_BRIDGE_NATURAL_${checkInTime}_${checkOutTime}_${message.slice(0, 8)}`,
      });
      const result = await handleInboundWhatsApp(
        {
          from: "whatsapp:+34600009991",
          body: message,
          messageSid: `SM_BRIDGE_NATURAL_RESULT_${message.length}_${checkInTime}`,
        },
        store,
        createStaticClientDirectory([]),
        timedDeps,
      );

      expect(result.conversation.reservationFlow).toMatchObject({
        status: "collecting_notes",
        petName: "Kira QA",
        checkInDate: "2026-12-30",
        checkInTime,
        checkInSlot,
        checkOutDate: "2026-12-31",
        checkOutTime,
        checkOutSlot,
      });
      expect(counters.checks).toBe(0);
      expect(result.conversation.pendingReservationProposal).toBeUndefined();
    },
  );

  it("does not interpret date-only messages as pet names", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientOwner({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_NO_FALSE_PET",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Entrada el 30 de diciembre a las 12:00 y salida el 31 de diciembre a las 18:00",
        messageSid: "SM_BRIDGE_NO_FALSE_PET_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_pet",
      checkInDate: "2026-12-30",
      checkInTime: "12:00",
      checkOutDate: "2026-12-31",
      checkOutTime: "18:00",
    });
    expect(result.conversation.reservationFlow?.petName).toBeUndefined();
    expect(result.conversation.petName).toBeUndefined();
    expect(result.botReply?.body).toContain("nombre o los nombres");
    expect(counters.checks).toBe(0);
  });

  it("detects date ranges without hours and waits for times", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_DATE_ONLY_WAIT",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Del 30 al 31 de diciembre",
        messageSid: "SM_BRIDGE_DATE_ONLY_WAIT_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "Kira QA",
      checkInDate: "2026-12-30",
      checkOutDate: "2026-12-31",
    });
    expect(result.conversation.reservationFlow?.checkInTime).toBeUndefined();
    expect(result.conversation.reservationFlow?.checkOutTime).toBeUndefined();
    expect(result.botReply?.body).toContain("hora");
    expect(counters.checks).toBe(0);
  });

  it("extracts the real WhatsApp ordered date and time reply without repeating the same question", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };
    const directory = createStaticClientDirectory([]);
    const from = "whatsapp:+34600009991";

    await handleInboundWhatsApp(
      { from, body: "hola", messageSid: "SM_BRIDGE_REAL_CONTEXT_HOLA" },
      store,
      directory,
      timedDeps,
    );
    await handleInboundWhatsApp(
      { from, body: "pues quería reservar", messageSid: "SM_BRIDGE_REAL_CONTEXT_START" },
      store,
      directory,
      timedDeps,
    );
    await handleInboundWhatsApp(
      { from, body: "no", messageSid: "SM_BRIDGE_REAL_CONTEXT_NEW" },
      store,
      directory,
      timedDeps,
    );
    await handleInboundWhatsApp(
      { from, body: "Pau Marco Martí. pauovidi@hotmail.com", messageSid: "SM_BRIDGE_REAL_CONTEXT_OWNER" },
      store,
      directory,
      timedDeps,
    );
    await handleInboundWhatsApp(
      { from, body: "YUYU", messageSid: "SM_BRIDGE_REAL_CONTEXT_PET" },
      store,
      directory,
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from,
        body: "pues el 29 de diciembre a las 10 y el 31 de diciembre a las 16",
        messageSid: "SM_BRIDGE_REAL_CONTEXT_DATES",
      },
      store,
      directory,
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      ownerName: "Pau Marco Martí",
      email: "pauovidi@hotmail.com",
      petName: "YUYU",
      petNames: ["YUYU"],
      checkInDate: "2026-12-29",
      checkInTime: "10:00",
      checkInSlot: "morning",
      checkOutDate: "2026-12-31",
      checkOutTime: "16:00",
      checkOutSlot: "afternoon",
    });
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
    expect(result.botReply?.body).toContain("alimentación");
    expect(counters.checks).toBe(0);
  });

  it.each([
    "el 29 de diciembre a las 10 y el 31 de diciembre a las 16",
    "29 de diciembre a las 10 y 31 de diciembre a las 16",
    "29/12 a las 10 y 31/12 a las 16",
    "29-12 10:00 y 31-12 16:00",
    "del 29 al 31 de diciembre, entrada a las 10 y salida a las 16",
    "del 29 al 31 de diciembre a las 10 y a las 16",
    "lo dejo el 29 de diciembre a las 10 y lo recojo el 31 de diciembre a las 16",
    "entraría el 29 de diciembre a las 10 y saldría el 31 de diciembre a las 16",
    "el 29 de diciembre a las 10 y el 31 a las 16",
  ])("extracts ordered contextual date/time pairs while awaiting dates: %s", async (message) => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: `SM_BRIDGE_ORDERED_DATES_${message}`,
      petName: "YUYU",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: message,
        messageSid: `SM_BRIDGE_ORDERED_DATES_RESULT_${message}`,
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      petName: "YUYU",
      checkInDate: "2026-12-29",
      checkInTime: "10:00",
      checkInSlot: "morning",
      checkOutDate: "2026-12-31",
      checkOutTime: "16:00",
      checkOutSlot: "afternoon",
    });
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
    expect(counters.checks).toBe(0);
  });

  it("asks for the month instead of falling back when ordered days and hours omit the month", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await collectNewClientPet({
      store,
      deps,
      prefix: "SM_BRIDGE_MISSING_MONTH_CONTEXT",
      petName: "YUYU",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "el 29 a las 10 y el 31 a las 16",
        messageSid: "SM_BRIDGE_MISSING_MONTH_CONTEXT_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "YUYU",
    });
    expect(result.conversation.reservationFlow?.checkInDate).toBeUndefined();
    expect(result.botReply?.body).toContain("necesito el mes");
    expect(result.botReply?.body).not.toContain("no te he entendido");
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
    expect(counters.checks).toBe(0);
  });

  it.each([
    "me da igual",
    "la hora me da igual",
    "lo que vosotros me digáis",
    "cuando mejor os venga",
    "me adapto",
  ])("keeps reservation context and asks for a time preference on indifferent hour replies: %s", async (message) => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: `SM_BRIDGE_TIME_PREF_${message}`,
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: message,
        messageSid: `SM_BRIDGE_TIME_PREF_RESULT_${message}`,
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      email: "ana.qa@example.test",
      petName: "YUYU",
      petCount: 1,
      checkInDate: "2026-12-29",
      checkOutDate: "2026-12-30",
      timePreferencePrompted: true,
    });
    expect(result.conversation.reservationFlow?.checkInTime).toBeUndefined();
    expect(result.conversation.reservationFlow?.checkOutTime).toBeUndefined();
    expect(result.botReply?.body).toContain("¿Prefieres mañana o tarde?");
    expect(result.botReply?.body).not.toContain("no te he entendido");
    expect(counters.checks).toBe(0);
  });

  it.each([
    ["mañana", "08:00", "08:00"],
    ["tarde", "16:30", "16:30"],
    ["me da igual", "08:00", "16:30"],
  ] as const)("resolves hours after an indifferent prompt with %s", async (preference, checkInTime, checkOutTime) => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: `SM_BRIDGE_TIME_PREF_RESOLVE_${preference}`,
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "me da igual",
        messageSid: `SM_BRIDGE_TIME_PREF_RESOLVE_${preference}_PROMPT`,
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: preference,
        messageSid: `SM_BRIDGE_TIME_PREF_RESOLVE_${preference}_ANSWER`,
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      email: "ana.qa@example.test",
      petName: "YUYU",
      checkInDate: "2026-12-29",
      checkInTime,
      checkOutDate: "2026-12-30",
      checkOutTime,
    });
    expect(result.botReply?.body).toContain("alimentación");
    expect(counters.checks).toBe(0);
  });

  it.each([
    ["10 y 18", "10:00", "18:00"],
    ["10 de la mañana y 6 de la tarde", "10:00", "18:00"],
    ["entrada a las 10 y salida a las 18", "10:00", "18:00"],
    ["Entrada y salida a las 11", "11:00", "11:00"],
    ["las dos a las 11", "11:00", "11:00"],
    ["ambas a las 11", "11:00", "11:00"],
    ["por la mañana y por la tarde", "08:00", "16:30"],
  ] as const)("extracts contextual time pairs while awaiting hours: %s", async (message, checkInTime, checkOutTime) => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: `SM_BRIDGE_CONTEXT_TIMES_${message}`,
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: message,
        messageSid: `SM_BRIDGE_CONTEXT_TIMES_RESULT_${message}`,
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      petName: "YUYU",
      checkInTime,
      checkOutTime,
    });
    expect(result.botReply?.body).not.toContain("no te he entendido");
    expect(counters.checks).toBe(0);
  });

  it("asks whether a single loose time should apply to entry and exit", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_SINGLE_TIME_CONTEXT",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "A las 11",
        messageSid: "SM_BRIDGE_SINGLE_TIME_CONTEXT_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "YUYU",
      checkInDate: "2026-12-29",
      checkOutDate: "2026-12-30",
      timePreferencePrompted: true,
      pendingSharedTimeConfirmation: "11:00",
    });
    expect(result.conversation.reservationFlow?.checkInTime).toBeUndefined();
    expect(result.conversation.reservationFlow?.checkOutTime).toBeUndefined();
    expect(result.botReply?.body).toContain("tanto para la entrada como para la salida");
    expect(counters.checks).toBe(0);

    const accepted = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "está bien",
        messageSid: "SM_BRIDGE_SINGLE_TIME_CONTEXT_ACCEPTED",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(accepted.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInTime: "11:00",
      checkOutTime: "11:00",
      pendingSharedTimeConfirmation: undefined,
    });
  });

  it("does not treat esta bien as an observation note", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_OBSERVATION_ESTA_BIEN",
    });
    const times = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "A las 10 h entrada y salida",
        messageSid: "SM_BRIDGE_OBSERVATION_ESTA_BIEN_TIMES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    expect(times.conversation.reservationFlow?.status).toBe("collecting_notes");

    const notes = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "está bien",
        messageSid: "SM_BRIDGE_OBSERVATION_ESTA_BIEN_NOTES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(notes.conversation.reservationFlow).toMatchObject({
      status: "collecting_visit",
      notes: "Sin notas adicionales",
    });
    expect(counters.checks).toBe(0);
  });

  it.each([
    ["Entrada a las 11", "checkInTime", "11:00", "A qué hora sería"],
    ["Salida a las 11", "checkOutTime", "11:00", "Tengo la hora de salida"],
  ] as const)("sets only the contextual %s value", async (message, field, expectedTime, expectedReply) => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: `SM_BRIDGE_SINGLE_LABELED_TIME_${field}`,
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: message,
        messageSid: `SM_BRIDGE_SINGLE_LABELED_TIME_${field}_RESULT`,
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "YUYU",
      [field]: expectedTime,
    });
    expect(result.botReply?.body).toContain(expectedReply);
    expect(counters.checks).toBe(0);
  });

  it("keeps context and asks a contextual clarification for PM times outside the reception day", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_CONTEXT_PM_OUT_OF_RANGE",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "10 PM y 10 PM",
        messageSid: "SM_BRIDGE_CONTEXT_PM_OUT_OF_RANGE_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      email: "ana.qa@example.test",
      petName: "YUYU",
      checkInDate: "2026-12-29",
      checkOutDate: "2026-12-30",
      timePreferencePrompted: true,
      pendingSharedTimeConfirmation: "22:00",
    });
    expect(result.conversation.reservationFlow?.checkInTime).toBeUndefined();
    expect(result.botReply?.body).toContain("He entendido 22:00");
    expect(result.botReply?.body).toContain("Confirmas que usemos las 22:00");
    expect(result.botReply?.body).not.toContain("no te he entendido");
    expect(counters.checks).toBe(0);

    const accepted = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "de acuerdo",
        messageSid: "SM_BRIDGE_CONTEXT_PM_OUT_OF_RANGE_ACCEPTED",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(accepted.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInTime: "22:00",
      checkOutTime: "22:00",
    });
  });

  it("completes times when dates are already present in context", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_TIME_ONLY_CONTEXT",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Del 30 al 31 de diciembre",
        messageSid: "SM_BRIDGE_TIME_ONLY_CONTEXT_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Entrada a las 12 y salida a las 18",
        messageSid: "SM_BRIDGE_TIME_ONLY_CONTEXT_TIMES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      petName: "Kira QA",
      checkInDate: "2026-12-30",
      checkInTime: "12:00",
      checkOutDate: "2026-12-31",
      checkOutTime: "18:00",
    });
    expect(counters.checks).toBe(0);
  });

  it("parses numeric date ranges without asking for the same dates again", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_NUMERIC_DATE_RANGE",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "25-12-2026 a 26-12-2026",
        messageSid: "SM_BRIDGE_NUMERIC_DATE_RANGE_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-12-25",
      checkOutDate: "2026-12-26",
    });
    expect(result.botReply?.body).toContain("Me falta la hora de entrada");
    expect(result.botReply?.body).not.toContain("fecha y hora de entrada");
    expect(counters.checks).toBe(0);
  });

  it("parses natural date ranges for this year plus shared entry and exit time", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_NATURAL_DATE_SHARED_TIME",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Del 25 al 26 de Diciembre de este año. A las 10 h. entrada y salida",
        messageSid: "SM_BRIDGE_NATURAL_DATE_SHARED_TIME_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInDate: "2026-12-25",
      checkOutDate: "2026-12-26",
      checkInTime: "10:00",
      checkOutTime: "10:00",
    });
    expect(result.botReply?.body).toContain("alimentación");
    expect(counters.checks).toBe(0);
  });

  it("asks for morning or afternoon when the customer only says primera hora", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_FIRST_HOUR_AMBIGUOUS",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "primera hora",
        messageSid: "SM_BRIDGE_FIRST_HOUR_AMBIGUOUS_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      timePreferencePrompted: true,
    });
    expect(result.botReply?.body).toContain("mañana o primera hora de la tarde");
    expect(counters.checks).toBe(0);
  });

  it("uses 16:30 for primera hora de la tarde", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_FIRST_AFTERNOON",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "primera hora de la tarde",
        messageSid: "SM_BRIDGE_FIRST_AFTERNOON_RESULT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInTime: "16:30",
      checkOutTime: "16:30",
    });
    expect(counters.checks).toBe(0);
  });

  it.each([
    [
      "El nombre de mi mascota es YUYU, entrada el 30 de diciembre a las 12 y salida el 31 de diciembre a las 18",
      "YUYU",
      "12:00",
      "18:00",
    ],
    [
      "Mi mascota se llama Toby. Entrada 30/12 12:00 salida 31/12 18:00",
      "Toby",
      "12:00",
      "18:00",
    ],
  ] as const)("extracts explicit pet names together with dates and times: %s", async (message, petName, checkInTime, checkOutTime) => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientOwner({
      store,
      deps: timedDeps,
      prefix: `SM_BRIDGE_PET_WITH_DATES_${petName}`,
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: message,
        messageSid: `SM_BRIDGE_PET_WITH_DATES_RESULT_${petName}`,
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      petName,
      checkInDate: "2026-12-30",
      checkInTime,
      checkOutDate: "2026-12-31",
      checkOutTime,
    });
    expect(result.conversation.reservationFlow?.petName).not.toBe("es YUYU");
    expect(counters.checks).toBe(0);
  });

  it("advances to availability only once dates and times are complete", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientOwner({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_COMPLETE_NATURAL",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Kira QA, 1 perro, entrada el 30 de diciembre a las 12 y salida el 31 de diciembre a las 18",
        messageSid: "SM_BRIDGE_COMPLETE_NATURAL_DETAILS",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sin notas",
        messageSid: "SM_BRIDGE_COMPLETE_NATURAL_NOTES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const proposed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "No",
        messageSid: "SM_BRIDGE_COMPLETE_NATURAL_VISIT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(proposed.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      petName: "Kira QA",
      checkIn: "2026-12-30",
      checkInTime: "12:00",
      checkOut: "2026-12-31",
      checkOutTime: "18:00",
      price: 30,
    });
    expect(counters.checks).toBe(1);
  });

  it("does not calculate price while dates or times are incomplete", async () => {
    const missingHoursStore = new MemoryConversationStore();
    const missingDatesStore = new MemoryConversationStore();
    const { counters: missingHoursCounters, deps: missingHoursDeps } = makeBridgeDeps();
    const { counters: missingDatesCounters, deps: missingDatesDeps } = makeBridgeDeps();
    const timedMissingHoursDeps = {
      ...missingHoursDeps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };
    const timedMissingDatesDeps = {
      ...missingDatesDeps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store: missingHoursStore,
      deps: timedMissingHoursDeps,
      prefix: "SM_BRIDGE_INCOMPLETE_HOURS",
    });
    const missingHours = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Del 30 al 31 de diciembre",
        messageSid: "SM_BRIDGE_INCOMPLETE_HOURS_DATES",
      },
      missingHoursStore,
      createStaticClientDirectory([]),
      timedMissingHoursDeps,
    );

    await collectNewClientPet({
      store: missingDatesStore,
      deps: timedMissingDatesDeps,
      prefix: "SM_BRIDGE_INCOMPLETE_DATES",
    });
    const missingDates = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Entrada a las 12 y salida a las 18",
        messageSid: "SM_BRIDGE_INCOMPLETE_DATES_TIMES",
      },
      missingDatesStore,
      createStaticClientDirectory([]),
      timedMissingDatesDeps,
    );

    expect(missingHours.conversation.pendingReservationProposal).toBeUndefined();
    expect(missingDates.conversation.pendingReservationProposal).toBeUndefined();
    expect(missingHoursCounters.checks).toBe(0);
    expect(missingDatesCounters.checks).toBe(0);
  });

  it("records visit preferences before proposing the reservation", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const directory = createStaticClientDirectory([]);
    const from = "whatsapp:+34600009991";

    await handleInboundWhatsApp({ from, body: "Quiero reservar", messageSid: "SM_BRIDGE_VISIT_START" }, store, directory, deps);
    await handleInboundWhatsApp({ from, body: "No soy cliente", messageSid: "SM_BRIDGE_VISIT_NEW" }, store, directory, deps);
    await handleInboundWhatsApp({ from, body: "Ana QA ana.qa@example.test", messageSid: "SM_BRIDGE_VISIT_OWNER" }, store, directory, deps);
    await handleInboundWhatsApp({ from, body: "Toby, 1 perro", messageSid: "SM_BRIDGE_VISIT_PET" }, store, directory, deps);
    await handleInboundWhatsApp({ from, body: "Del 29 al 31 de diciembre de 2026", messageSid: "SM_BRIDGE_VISIT_DATES" }, store, directory, deps);
    await handleInboundWhatsApp({ from, body: "Entrada a las 12:00 y salida a las 12:00", messageSid: "SM_BRIDGE_VISIT_TIMES" }, store, directory, deps);
    await handleInboundWhatsApp({ from, body: "Sin notas", messageSid: "SM_BRIDGE_VISIT_NOTES" }, store, directory, deps);
    const result = await handleInboundWhatsApp(
      { from, body: "Sí, quiero visitar el hotel", messageSid: "SM_BRIDGE_VISIT_YES" },
      store,
      directory,
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "pending_confirmation",
      wantsVisit: true,
    });
    expect(result.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      wantsVisit: true,
    });
    expect(result.botReply?.body).toContain("Las visitas se coordinan");
    expect(counters.checks).toBe(1);
  });

  it.each([
    [1, 60],
    [2, 90],
    [3, 100],
    [4, 110],
  ])("prices a two-night stay for %i dog(s) at %i euros", async (dogs, expectedPrice) => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();

    const result = await createNewClientPricedProposal({
      store,
      deps,
      dogs,
      petName: `Tarifa ${dogs}`,
      prefix: `SM_BRIDGE_PRICE_${dogs}`,
    });

    expect(result.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      petCount: dogs,
      price: expectedPrice,
      priceSource: "calculated",
    });
    expect(result.botReply?.body).toContain(`${expectedPrice} €`);
  });

  it.each([
    ["YUYU", 1, 60],
    ["YUYU y KIRA", 2, 90],
    ["YUYU, KIRA y TOBY", 3, 100],
    ["YUYU, KIRA, TOBY y LUNA", 4, 110],
  ] as const)("prices inferred pet names for a two-night stay: %s", async (names, petCount, expectedPrice) => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const directory = createStaticClientDirectory([]);
    const from = "whatsapp:+34600009991";

    await collectNewClientOwner({
      store,
      deps,
      from,
      directory,
      prefix: `SM_BRIDGE_INFERRED_PRICE_${petCount}`,
    });
    await handleInboundWhatsApp(
      { from, body: names, messageSid: `SM_BRIDGE_INFERRED_PRICE_${petCount}_PETS` },
      store,
      directory,
      deps,
    );
    await handleInboundWhatsApp(
      { from, body: "Del 29 al 31 de diciembre de 2026", messageSid: `SM_BRIDGE_INFERRED_PRICE_${petCount}_DATES` },
      store,
      directory,
      deps,
    );
    await handleInboundWhatsApp(
      { from, body: "Entrada a las 12:00 y salida a las 12:00", messageSid: `SM_BRIDGE_INFERRED_PRICE_${petCount}_TIMES` },
      store,
      directory,
      deps,
    );
    await handleInboundWhatsApp(
      { from, body: "Sin notas", messageSid: `SM_BRIDGE_INFERRED_PRICE_${petCount}_NOTES` },
      store,
      directory,
      deps,
    );
    const result = await handleInboundWhatsApp(
      { from, body: "No", messageSid: `SM_BRIDGE_INFERRED_PRICE_${petCount}_VISIT` },
      store,
      directory,
      deps,
    );

    expect(result.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      petCount,
      price: expectedPrice,
      priceSource: "calculated",
    });
    expect(result.botReply?.body).toContain(`${expectedPrice} €`);
  });

  it("extracts explicit pet names and infers missing future years", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-01-10T10:00:00.000Z"),
    };

    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Quiero reservar", messageSid: "SM_BRIDGE_YUYU_START" },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "No", messageSid: "SM_BRIDGE_YUYU_NEW" },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "Ana QA ana.qa@example.test", messageSid: "SM_BRIDGE_YUYU_OWNER" },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const proposed = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "El nombre de mi mascota es YUYU, 1 perro, y quiero del 30 al 31 de Diciembre", messageSid: "SM_BRIDGE_YUYU_1" },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(proposed.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "YUYU",
      checkInDate: "2026-12-30",
      checkOutDate: "2026-12-31",
    });
  });

  it("moves date ranges without year to next year when the date already passed", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-12-31T10:00:00.000Z"),
    };

    const proposed = await createNewClientPricedProposal({
      store,
      deps: timedDeps,
      petName: "Toby",
      dateText: "Del 29 al 31 de diciembre",
      prefix: "SM_BRIDGE_NEXT_YEAR",
    });

    expect(proposed.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      checkIn: "2027-12-29",
      checkOut: "2027-12-31",
    });
  });

  it("writes a confirmed proposal, projects it into entry log and upserts CLIENTES", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal(
      {
        store,
        deps,
        prefix: "SM_BRIDGE_CONFIRM_1",
      },
    );
    const confirmed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_CONFIRM_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.checks).toBe(2);
    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(1);
    expect(counters.clientUpserts).toHaveLength(1);
    expect(counters.clientUpserts[0]).toMatchObject({
      phoneE164: "+34600009991",
      phoneNormalized: "34600009991",
      petName: "Kira QA",
      checkIn: "2026-12-29",
      checkOut: "2026-12-31",
      source: "whatsapp_reservation",
    });
    expect(confirmed.conversation.pendingReservationProposal?.status).toBe("confirmed");
    expect(confirmed.conversation.reservationId).toBe(counters.reservations[0].reservationId);
    expect(confirmed.conversation.clientStatus).toBe("known");
    expect(confirmed.conversation.clientDirectoryUpsertKind).toBe("created_pending_name");
    expect(confirmed.conversation.clientDirectoryUpsertStatus).toBe("created");
    expect(confirmed.conversation.tags).toContain("cliente_creado_desde_reserva");
    expect(confirmed.conversation.tags).not.toContain("cliente_habitual");
    expect(confirmed.botReply?.body).toContain("Reserva confirmada");
    expect(confirmed.conversation.events.some((event) => event.eventType === "reservation_confirmed_from_whatsapp")).toBe(true);
    expect(confirmed.conversation.events.some((event) => event.eventType === "client_directory_created_pending_name")).toBe(true);

    const reservation = counters.reservations[0];
    expect(reservation).toMatchObject({
      status: "confirmada",
      source: "demo",
      petName: "Kira QA",
      checkInDate: "2026-12-29",
      checkOutDate: "2026-12-31",
      clientDirectoryUpsertKind: "created_pending_name",
      clientDirectoryUpsertStatus: "created",
      clientDirectoryWarning: "client_name_pending_review",
    });
    expect(reservation.sheetRegistration?.cells).toEqual(["B7"]);

    const entry = buildEntryLogRecord(reservation);
    expect(entry).toMatchObject({
      source: "chatbot",
      action: "confirmada",
      petName: "Kira QA",
      reservationId: reservation.reservationId,
      gestetStatus: "procesado Gestet",
      clientStatus: "nuevo cliente añadido",
    });
  });

  it("enqueues a dry-run bath offer two minutes after reservation confirmation", async () => {
    process.env.HOTEL_BATH_OFFER_ENABLED = "false";
    process.env.HOTEL_BATH_OFFER_DRY_RUN = "true";
    process.env.HOTEL_BATH_OFFER_DELAY_MINUTES = "2";
    process.env.HOTEL_SCHEDULED_MESSAGES_ENABLED = "false";
    process.env.HOTEL_SCHEDULED_MESSAGES_DRY_RUN = "true";
    const store = new MemoryConversationStore();
    const scheduledMessageStore = new MemoryScheduledMessageStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      scheduledMessageStore,
      now: () => new Date("2026-06-24T10:00:00.000Z"),
    };

    await createNewClientPricedProposal({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_BATH_SCHEDULE",
    });
    const confirmed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_BATH_SCHEDULE_CONFIRM",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const due = await scheduledMessageStore.listDue({
      now: new Date("2026-06-24T10:03:00.000Z"),
    });

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      type: "bath_offer_after_confirmation",
      dryRun: true,
      scheduledAt: "2026-06-24T10:02:00.000Z",
      status: "pending",
    });
    expect(due[0].payload.message).toContain("¿Quieres que bañemos");
    expect(confirmed.conversation.pendingBathOffer).toMatchObject({
      status: "scheduled",
      petNames: ["Kira QA"],
    });
    expect(confirmed.conversation.events.some((event) => event.eventType === "bath_offer_scheduled")).toBe(true);
    expect(confirmed.conversation.events.some((event) => event.eventType === "bath_offer_dry_run")).toBe(true);
  });

  it("requests contract acceptance before confirming when the contract gate is enabled", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_REQUEST_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_CONTRACT_REQUEST_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.checks).toBe(1);
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
    expect(result.botReply?.body).toContain(
      "https://somosmuyperros.com/contrato-de-admision-e-ingreso/",
    );
    expect(result.botReply?.body).toContain("¿Confirmas que lo has leído y aceptas las condiciones?");
    expect(result.conversation.pendingReservationProposal).toMatchObject({
      termsAccepted: false,
      termsVersion: "admision-ingreso-2026-06-22",
      termsSource: "whatsapp_link",
    });
    expect(
      result.conversation.events.some(
        (event) => event.eventType === "contract_acceptance_requested",
      ),
    ).toBe(true);
    expect(
      hasContractGateEvent(
        result.conversation,
        "contract_gate_applied",
        "confirm_proposal_requires_acceptance",
      ),
    ).toBe(true);
  });

  it("skips the contract gate when a pending proposal is modified", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_MODIFY_SKIP_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "quiero modificar una reserva",
        messageSid: "SM_BRIDGE_CONTRACT_MODIFY_SKIP_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(0);
    expect(result.botReply?.body).not.toContain("aceptes el contrato");
    expect(result.botReply?.body).toContain("¿Qué quieres modificar");
    expect(result.conversation.pendingReservationProposal).toMatchObject({
      status: "cancelled",
      failureReason: "customer_requested_change",
    });
    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
    });
    expect(
      hasContractGateEvent(
        result.conversation,
        "contract_gate_skipped",
        "skipped_modify_intent",
      ),
    ).toBe(true);
  });

  it("skips the contract gate when a pending proposal is cancelled", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_CANCEL_SKIP_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "quiero cancelar una reserva",
        messageSid: "SM_BRIDGE_CONTRACT_CANCEL_SKIP_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(0);
    expect(result.botReply?.body).not.toContain("aceptes el contrato");
    expect(result.conversation.pendingReservationProposal).toBeUndefined();
    expect(result.conversation.reservationFlow).toBeUndefined();
    expect(
      hasContractGateEvent(
        result.conversation,
        "contract_gate_skipped",
        "skipped_cancel_intent",
      ),
    ).toBe(true);
  });

  it("uses esta bien as reservation proposal acceptance and then requests contract", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_ESTA_BIEN_PROPOSAL_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "está bien",
        messageSid: "SM_BRIDGE_CONTRACT_ESTA_BIEN_PROPOSAL_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(0);
    expect(result.botReply?.body).toContain("contrato de admisión");
    expect(result.botReply?.body).toContain("¿Confirmas que lo has leído y aceptas las condiciones?");
    expect(result.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      termsAccepted: false,
    });
  });

  it("uses esta bien as terms acceptance only after the explicit contract question", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    process.env.HOTEL_CONFIRMATION_TEMPLATE_ENABLED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_ESTA_BIEN_TERMS_1",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "está bien",
        messageSid: "SM_BRIDGE_CONTRACT_ESTA_BIEN_TERMS_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const confirmed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "está bien",
        messageSid: "SM_BRIDGE_CONTRACT_ESTA_BIEN_TERMS_3",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(1);
    expect(confirmed.conversation.pendingReservationProposal).toMatchObject({
      status: "confirmed",
      termsAccepted: true,
    });
    expect(confirmed.botReply?.body).toContain("¡Tu reserva ha sido confirmada!");
    expect(confirmed.botReply?.body).not.toContain("ATENCIÓN LEER HASTA EL FINAL");
  });

  it("treats acepto before the contract as proposal confirmation, not terms acceptance", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_ACCEPT_BEFORE_LINK_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "acepto",
        messageSid: "SM_BRIDGE_CONTRACT_ACCEPT_BEFORE_LINK_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(0);
    expect(result.botReply?.body).toContain(
      "https://somosmuyperros.com/contrato-de-admision-e-ingreso/",
    );
    expect(result.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      termsAccepted: false,
    });
    expect(
      result.conversation.events.some((event) => event.eventType === "contract_link_sent"),
    ).toBe(true);
  });

  it("confirms only after explicit contract acceptance and stores acceptance metadata", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    process.env.HOTEL_CONFIRMATION_TEMPLATE_ENABLED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_ACCEPT_1",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_CONTRACT_ACCEPT_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const confirmed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "acepto",
        messageSid: "SM_BRIDGE_CONTRACT_ACCEPT_3",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.checks).toBe(2);
    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(1);
    expect(confirmed.conversation.pendingReservationProposal).toMatchObject({
      status: "confirmed",
      termsAccepted: true,
      termsVersion: "admision-ingreso-2026-06-22",
      termsSource: "whatsapp_link",
      termsUrl: "https://somosmuyperros.com/contrato-de-admision-e-ingreso/",
    });
    expect(counters.reservations[0]).toMatchObject({
      termsAccepted: true,
      termsVersion: "admision-ingreso-2026-06-22",
      termsSource: "whatsapp_link",
      termsUrl: "https://somosmuyperros.com/contrato-de-admision-e-ingreso/",
      confirmationTemplateMode: "whatsapp_reply",
    });
    expect(confirmed.botReply?.body).not.toContain("ATENCIÓN LEER HASTA EL FINAL");
    expect(confirmed.botReply?.body.startsWith("*Hola* Ana QA")).toBe(true);
    expect(confirmed.botReply?.body).toContain("Mascotas: Kira QA");
    expect(confirmed.botReply?.body).toContain("El coste de la estancia es de *60€*");
    expect(confirmed.botReply?.body).not.toContain("Reserva confirmada. Cliente:");
    expect(
      confirmed.conversation.events.some((event) => event.eventType === "contract_accepted"),
    ).toBe(true);
    expect(
      confirmed.conversation.events.some(
        (event) => event.eventType === "confirmation_template_sent",
      ),
    ).toBe(true);
    expect(
      confirmed.conversation.events.some(
        (event) => event.eventType === "reservation_confirmed_after_terms",
      ),
    ).toBe(true);
  });

  it("does not treat a generic confirmation as contract acceptance", async () => {
    process.env.HOTEL_CONTRACT_ACCEPTANCE_REQUIRED = "true";
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CONTRACT_GENERIC_1",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_CONTRACT_GENERIC_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "confirmo",
        messageSid: "SM_BRIDGE_CONTRACT_GENERIC_3",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
    expect(result.botReply?.body).toContain("¿Confirmas que lo has leído y aceptas las condiciones?");
    expect(result.conversation.pendingReservationProposal?.status).toBe("proposed");
    expect(result.conversation.pendingReservationProposal?.termsAccepted).toBe(false);
  });

  it("uses the safe denied reservation template when availability is unavailable", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps({ availabilitySequence: [false] });

    const result = await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_DENIED_TEMPLATE",
    });

    expect(counters.writes).toBe(0);
    expect(result.botReply?.body).toContain("no tenemos disponibilidad");
    expect(result.botReply?.body).toContain("podemos dejarlo anotado para que el equipo lo revise");
    expect(result.botReply?.body).not.toContain("la hemos anotado en nuestra lista de espera");
    expect(
      result.conversation.events.some(
        (event) => event.eventType === "reservation_denied_template_sent",
      ),
    ).toBe(true);
  });

  it("renders template preview through WhatsApp without creating reservations or writes", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "muéstrame la plantilla de confirmación",
        messageSid: "SM_BRIDGE_TEMPLATE_PREVIEW_CONFIRMATION",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.botReply?.body).toContain("Vista previa de plantilla: confirmación");
    expect(result.botReply?.body).toContain("*Hola* Pau");
    expect(result.botReply?.body).not.toContain("ATENCIÓN LEER HASTA EL FINAL");
    expect(result.conversation.pendingReservationProposal).toBeUndefined();
    expect(
      result.conversation.events.some((event) => event.eventType === "template_preview_rendered"),
    ).toBe(true);
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
  expect(counters.clientUpserts).toHaveLength(0);
  });

  it("returns a safe reply when template preview rendering fails", async () => {
    const store = new MemoryConversationStore();
    const from = "whatsapp:+34600009992";
    const created = await handleInboundWhatsApp(
      {
        from,
        body: "hola",
        messageSid: "SM_BRIDGE_TEMPLATE_PREVIEW_FAILURE_SETUP",
      },
      store,
      createStaticClientDirectory([]),
    );
    await store.replaceConversation({
      ...created.conversation,
      pendingReservationProposal: {
        proposalId: "proposal_preview_missing_price",
        conversationId: created.conversation.id,
        phoneNormalized: created.conversation.phoneNormalized,
        clientStatus: "unknown",
        clientName: "Pau QA",
        petName: "Pipo QA",
        petNames: ["Pipo QA"],
        checkIn: "2026-12-25",
        checkOut: "2026-12-26",
        checkInSlot: "morning",
        checkOutSlot: "morning",
        petCount: 1,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: "proposed",
        source: "whatsapp",
        createdFromMessageId: "msg_preview_missing_price",
      },
    });

    const result = await handleInboundWhatsApp(
      {
        from,
        body: "plantilla confirmación",
        messageSid: "SM_BRIDGE_TEMPLATE_PREVIEW_FAILURE",
      },
      store,
      createStaticClientDirectory([]),
    );

    expect(result.botReply?.body).toBe(TEMPLATE_PREVIEW_FAILED_REPLY);
    expect(result.twiml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${TEMPLATE_PREVIEW_FAILED_REPLY}</Message></Response>`,
    );
    expect(
      result.conversation.events.some((event) => event.eventType === "template_preview_failed"),
    ).toBe(true);
  });

  it("renders all template previews through WhatsApp", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "muéstrame todas las plantillas",
        messageSid: "SM_BRIDGE_TEMPLATE_PREVIEW_ALL",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.botReply?.body).toContain("Vista previa de plantilla: todas");
    expect(result.botReply?.body).toContain("--- confirmación ---");
    expect(result.botReply?.body).toContain("--- recordatorio ---");
    expect(result.botReply?.body).toContain("--- baño ---");
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
  });

  it.each([
    "si",
    "sí",
    "ok",
    "vale",
    "perfecto",
    "adelante",
    "anótala",
    "confirmo",
    "confirmo la reserva",
    "si por favor",
    "ok gracias",
    "vale gracias",
    "de acuerdo",
  ])("confirms a pending proposal with short affirmative utterance: %s", async (utterance) => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: `SM_BRIDGE_SHORT_${utterance}_1`,
    });
    const confirmed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: utterance,
        messageSid: `SM_BRIDGE_SHORT_${utterance}_2`,
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.checks).toBe(2);
    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(1);
    expect(counters.clientUpserts).toHaveLength(1);
    expect(confirmed.conversation.pendingReservationProposal?.status).toBe("confirmed");
    expect(confirmed.botReply?.body).toContain("Reserva confirmada");
  });

  it("does not confirm without a pending proposal", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "si",
        messageSid: "SM_BRIDGE_NO_PROPOSAL",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.botReply?.body).toContain(
      "Para avanzar necesito saber si quieres hacer una reserva, consultar disponibilidad o resolver alguna duda.",
    );
    expect(counters.checks).toBe(0);
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
  });

  it("does not confirm ok without a pending proposal", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "ok",
        messageSid: "SM_BRIDGE_OK_NO_PROPOSAL",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.botReply?.body).toContain(
      "Para avanzar necesito saber si quieres hacer una reserva, consultar disponibilidad o resolver alguna duda.",
    );
    expect(counters.checks).toBe(0);
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
  });

  it("revalidates availability before writing and hands off if the slot disappeared", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps({ availabilitySequence: [true, false] });

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_LOST_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_LOST_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.pendingReservationProposal?.status).toBe("failed");
    expect(result.botReply?.body).toContain("ya no puedo dejarla anotada");
    expect(counters.checks).toBe(2);
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
  });

  it("does not confirm expired proposals", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    let now = new Date("2026-05-27T10:00:00.000Z");
    const timedDeps = {
      ...deps,
      now: () => now,
    };

    await createNewClientPricedProposal({
      store,
      deps: timedDeps,
      prefix: "SM_BRIDGE_EXPIRED_1",
    });
    now = new Date("2026-05-27T13:01:00.000Z");
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "si",
        messageSid: "SM_BRIDGE_EXPIRED_2",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.pendingReservationProposal?.status).toBe("expired");
    expect(result.botReply?.body).toContain("ya no está vigente");
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
  });

  it("does not autorespond or confirm short affirmatives while in human mode", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    const proposed = await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_HUMAN_MODE_1",
    });
    await store.replaceConversation({
      ...proposed.conversation,
      mode: "human",
      humanRequested: true,
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "si",
        messageSid: "SM_BRIDGE_HUMAN_MODE_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.botReply).toBeUndefined();
    expect(result.conversation.mode).toBe("human");
    expect(counters.writes).toBe(0);
    expect(counters.reservations).toHaveLength(0);
  });

  it("does not say confirmed when the sheet write fails", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps({ writeFails: true });

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_WRITE_FAIL_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_WRITE_FAIL_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.pendingReservationProposal?.status).toBe("failed");
    expect(result.botReply?.body).toContain("no la marco como confirmada");
    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(0);
    expect(counters.clientUpserts).toHaveLength(0);
    const serialized = JSON.stringify(result.conversation);
    expect(serialized).not.toContain("mock sheet write failed");
  });

  it("keeps confirmed copy if ReservationRecord persistence fails after Sheets write", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps({ recordUpsertFails: true });

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_RECORD_FAIL_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "confirmo",
        messageSid: "SM_BRIDGE_RECORD_FAIL_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(0);
    expect(counters.clientUpserts).toHaveLength(1);
    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.pendingReservationProposal?.status).toBe("confirmed");
    expect(result.conversation.clientDirectoryUpsertKind).toBe("created_pending_name");
    expect(result.conversation.reservationId).toBeDefined();
    expect(result.botReply?.body).toContain("Reserva confirmada");
    expect(result.botReply?.body).not.toContain("no la marco como confirmada");
    const confirmationEvent = result.conversation.events.findLast(
      (event) => event.eventType === "reservation_confirmation_checked",
    );
    expect(confirmationEvent?.payload).toMatchObject({
      kind: "confirmed",
      postWriteWarning: {
        reason: "reservation_record_upsert_failed",
      },
    });
    expect(JSON.stringify(result.conversation.events)).not.toContain("mock reservation record upsert failed");
  });

  it("returns the confirmed TwiML even if conversation persistence fails after the sheet write", async () => {
    const store = new PostConfirmationStoreFailureConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_STORE_FAIL_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "si",
        messageSid: "SM_BRIDGE_STORE_FAIL_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(1);
    expect(counters.clientUpserts).toHaveLength(1);
    expect(result.botReply).toBeUndefined();
    expect(result.twiml).toContain("Reserva confirmada");
    expect(result.twiml).not.toContain("Gracias, hemos recibido tu mensaje");
  });

  it("keeps the reservation confirmed if CLIENTES upsert fails after sheet write", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps({ clientUpsertFails: true });

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_CLIENT_UPSERT_FAIL_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "si",
        messageSid: "SM_BRIDGE_CLIENT_UPSERT_FAIL_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(1);
    expect(counters.clientUpserts).toHaveLength(1);
    expect(counters.reservations[0]).toMatchObject({
      clientDirectoryUpsertKind: "failed",
      clientDirectoryUpsertStatus: "failed",
    });
    expect(result.conversation.pendingReservationProposal?.status).toBe("confirmed");
    expect(result.botReply?.body).toContain("Reserva confirmada");
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_upsert_failed")).toBe(true);
    expect(JSON.stringify(result.conversation.events)).not.toContain("mock client upsert failed");
  });

  it("does not persist raw reservation ids or sheet internals in conversation events", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_PRIVACY_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_PRIVACY_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const reservationId = counters.reservations[0].reservationId;
    const eventPayloads = JSON.stringify(result.conversation.events.map((event) => event.payload));

    expect(eventPayloads).not.toContain(reservationId);
    expect(eventPayloads).not.toContain("DICIEMBRE 2026");
    expect(eventPayloads).not.toContain('"rowHint"');
    expect(eventPayloads).toContain("[reservation-id:");
  });

  it("does not bridge blocked or ambiguous clients", async () => {
    const blockedStore = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    const blocked = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Quiero reservar para Kira QA del 29 al 31 de diciembre de 2026",
        messageSid: "SM_BRIDGE_BLOCKED",
      },
      blockedStore,
      createStaticClientDirectory([
        {
          nombre: "Cliente QA Bloqueado",
          telefonoNormalizado: "34600009991",
          bloqueadoNoReservar: true,
        },
      ]),
      deps,
    );

    const ambiguousStore = new MemoryConversationStore();
    const ambiguous = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "Quiero reservar para Kira QA del 29 al 31 de diciembre de 2026",
        messageSid: "SM_BRIDGE_AMBIGUOUS",
      },
      ambiguousStore,
      createStaticClientDirectory([
        { nombre: "Cliente QA A", telefonoNormalizado: "34600009992" },
        { nombre: "Cliente QA B", telefonoNormalizado: "34600009992" },
      ]),
      deps,
    );

    expect(blocked.conversation.mode).toBe("human");
    expect(blocked.conversation.pendingReservationProposal).toBeUndefined();
    expect(ambiguous.conversation.mode).toBe("human");
    expect(ambiguous.conversation.pendingReservationProposal).toBeUndefined();

    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "si",
        messageSid: "SM_BRIDGE_BLOCKED_CONFIRM",
      },
      blockedStore,
      createStaticClientDirectory([
        {
          nombre: "Cliente QA Bloqueado",
          telefonoNormalizado: "34600009991",
          bloqueadoNoReservar: true,
        },
      ]),
      deps,
    );
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "si",
        messageSid: "SM_BRIDGE_AMBIGUOUS_CONFIRM",
      },
      ambiguousStore,
      createStaticClientDirectory([
        { nombre: "Cliente QA A", telefonoNormalizado: "34600009992" },
        { nombre: "Cliente QA B", telefonoNormalizado: "34600009992" },
      ]),
      deps,
    );
    expect(counters.checks).toBe(0);
    expect(counters.writes).toBe(0);
  });

  it("does not duplicate writes on repeated confirmation once a proposal is confirmed", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();

    await createNewClientPricedProposal({
      store,
      deps,
      prefix: "SM_BRIDGE_IDEMPOTENT_1",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_IDEMPOTENT_2",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );
    const repeated = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "Sí, confirma",
        messageSid: "SM_BRIDGE_IDEMPOTENT_3",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(repeated.conversation.pendingReservationProposal?.status).toBe("confirmed");
    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(1);
    expect(counters.clientUpserts).toHaveLength(1);
  });

  it("confirms the real recognized-client PLAF flow with 'si' and keeps the conversation visible", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps({
      clientUpsertResult: {
        kind: "existing",
        clientStatus: "known",
        clientName: "Pau QA",
        rowNumber: 12,
        sheetName: "CLIENTES_QA",
        matchCount: 1,
        warning: "client_email_completed_from_reservation",
        source: "google_sheets_client_directory",
      },
    });
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoNormalizado: "34600009991",
        rowNumber: 12,
        sheetName: "CLIENTES_QA",
      },
    ]);
    const from = "whatsapp:+34600009991";

    const reset = await handleInboundWhatsApp(
      { from, body: "reiniciar", messageSid: "SM_PLAF_RESET" },
      store,
      directory,
      deps,
    );
    const greeting = await handleInboundWhatsApp(
      { from, body: "hola", messageSid: "SM_PLAF_HOLA" },
      store,
      directory,
      deps,
    );
    const start = await handleInboundWhatsApp(
      { from, body: "quiero hacer una reserva nueva", messageSid: "SM_PLAF_START" },
      store,
      directory,
      deps,
    );
    const email = await handleInboundWhatsApp(
      { from, body: "pau.qa@example.test", messageSid: "SM_PLAF_EMAIL" },
      store,
      directory,
      deps,
    );
    const pet = await handleInboundWhatsApp(
      { from, body: "PLAF", messageSid: "SM_PLAF_PET" },
      store,
      directory,
      deps,
    );
    const dates = await handleInboundWhatsApp(
      {
        from,
        body: "pues el 26 de diciembre a las 10 y el 28 a las 11",
        messageSid: "SM_PLAF_DATES",
      },
      store,
      directory,
      deps,
    );
    const notes = await handleInboundWhatsApp(
      { from, body: "no", messageSid: "SM_PLAF_NOTES" },
      store,
      directory,
      deps,
    );
    const proposal = await handleInboundWhatsApp(
      { from, body: "no", messageSid: "SM_PLAF_VISIT" },
      store,
      directory,
      deps,
    );
    const confirmed = await handleInboundWhatsApp(
      { from, body: "si", messageSid: "SM_PLAF_CONFIRM" },
      store,
      directory,
      deps,
    );

    expect(reset.twiml).toContain("Reiniciado");
    expect(greeting.botReply?.body).toContain("¡Hola, Pau!");
    expect(start.botReply?.body).toContain("me confirmas el email");
    expect(start.botReply?.body).not.toContain("¿Ya eres cliente");
    expect(email.botReply?.body).toContain("Dime el nombre de tu mascota");
    expect(pet.botReply?.body).toContain("fecha y hora de entrada");
    expect(dates.botReply?.body).toContain("alimentación");
    expect(notes.botReply?.body).toContain("Quieres visitar");
    expect(proposal.botReply?.body).toContain("Tenemos disponibilidad para PLAF");
    expect(proposal.conversation.pendingReservationProposal?.status).toBe("proposed");

    expect(confirmed.botReply?.body).toContain("Reserva confirmada para PLAF");
    expect(confirmed.botReply?.body).toContain("26 de diciembre");
    expect(confirmed.botReply?.body).toContain("10:00");
    expect(confirmed.botReply?.body).toContain("El precio es 60 €");
    expect(confirmed.botReply?.body).not.toContain("Gracias, hemos recibido tu mensaje");
    expect(confirmed.conversation.pendingReservationProposal?.status).toBe("confirmed");
    expect(confirmed.conversation.reservationFlow?.status).toBe("confirmed");
    expect(confirmed.conversation.reservationId).toBeDefined();
    expect(counters.checks).toBeGreaterThanOrEqual(2);
    expect(counters.writes).toBe(1);
    expect(counters.clientUpserts).toHaveLength(1);
    expect(counters.clientUpserts[0]).toMatchObject({
      email: "pau.qa@example.test",
      petName: "PLAF",
    });
    expect(counters.reservations).toHaveLength(1);
    expect(counters.reservations[0]).toMatchObject({
      petName: "PLAF",
      clientKind: "habitual",
      clientDirectoryUpsertKind: "existing",
      clientDirectoryUpsertStatus: "existing",
    });

    const entry = buildEntryLogRecord(counters.reservations[0]);
    expect(entry.petName).toBe("PLAF");
    expect(entry.clientStatus).toBe("cliente existente actualizado");
    expect(entry.action).toBe("confirmada");

    const dashboard = await listConversationDashboard({}, store);
    expect(dashboard.conversations.map((item) => item.id)).toContain(confirmed.conversation.id);

    const reloadedStore = new MemoryConversationStore();
    await reloadedStore.seed((await store.load()).conversations);
    const reloadedDashboard = await listConversationDashboard({}, reloadedStore);
    expect(reloadedDashboard.conversations.map((item) => item.id)).toContain(confirmed.conversation.id);
    expect((await reloadedStore.getById(confirmed.conversation.id))?.pendingReservationProposal?.status).toBe(
      "confirmed",
    );

    const repeated = await handleInboundWhatsApp(
      { from, body: "si", messageSid: "SM_PLAF_CONFIRM_AGAIN" },
      reloadedStore,
      directory,
      deps,
    );
    expect(repeated.botReply?.body).toBe(
      "De acuerdo, te esperamos pronto. Si necesitas cambiar cualquier detalle, escríbenos por aquí.",
    );
    expect(counters.writes).toBe(1);
    expect(counters.reservations).toHaveLength(1);
    expect(counters.clientUpserts).toHaveLength(1);
  });

  it("traces the real reset to partial time and FAQ reservation transcript without stale state", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-28T10:00:00.000Z"),
    };
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        email: "pau.qa@example.test",
        telefonoNormalizado: "34600009991",
        rowNumber: 12,
        sheetName: "CLIENTES_QA",
      },
    ]);
    const from = "whatsapp:+34600009991";

    const reset = await handleInboundWhatsApp(
      { from, body: "reiniciar", messageSid: "SM_AUTH_TRACE_RESET" },
      store,
      directory,
      timedDeps,
    );
    const greeting = await handleInboundWhatsApp(
      { from, body: "hola", messageSid: "SM_AUTH_TRACE_HOLA" },
      store,
      directory,
      timedDeps,
    );
    const start = await handleInboundWhatsApp(
      { from, body: "quiero reservar", messageSid: "SM_AUTH_TRACE_START" },
      store,
      directory,
      timedDeps,
    );
    const pet = await handleInboundWhatsApp(
      { from, body: "PIPO", messageSid: "SM_AUTH_TRACE_PET" },
      store,
      directory,
      timedDeps,
    );
    const entryDate = await handleInboundWhatsApp(
      { from, body: "mañana", messageSid: "SM_AUTH_TRACE_ENTRY_DATE" },
      store,
      directory,
      timedDeps,
    );
    const entryTime = await handleInboundWhatsApp(
      { from, body: "a las 10", messageSid: "SM_AUTH_TRACE_ENTRY_TIME" },
      store,
      directory,
      timedDeps,
    );
    const faq = await handleInboundWhatsApp(
      { from, body: "diferencia entre hotel y guardería", messageSid: "SM_AUTH_TRACE_FAQ" },
      store,
      directory,
      timedDeps,
    );
    const cancelled = await handleInboundWhatsApp(
      { from, body: "ya no quiero reservar", messageSid: "SM_AUTH_TRACE_CANCEL" },
      store,
      directory,
      timedDeps,
    );

    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(greeting.botReply?.body).toContain("¡Hola, Pau!");
    expect(start.botReply?.body).toContain("Genial, Pau");
    expect(start.botReply?.body).toContain("Dime el nombre de tu mascota");
    expect(pet.botReply?.body).toContain("fecha y hora de entrada");

    expect(entryDate.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "PIPO",
      checkInDate: "2026-06-29",
    });
    expect(entryDate.botReply?.body).toContain("Me falta la salida y las horas");

    expect(entryTime.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-06-29",
      checkInTime: "10:00",
    });
    expect(entryTime.botReply?.body).toContain("salida");
    expect(entryTime.botReply?.body).not.toContain("las horas");
    expect(entryTime.botReply?.body).not.toBe("Entiendo parte de la reserva. Me falta la salida y las horas. ¿Me las indicas?");

    const entryTimeTrace = latestAuthorityTrace(entryTime.conversation);
    expect(entryTimeTrace).toMatchObject({
      activeFlowBefore: "reservation",
      activeFlowAfter: "reservation",
      nluSlotsExtracted: expect.arrayContaining(["checkInTime"]),
      nluTargetSlots: expect.arrayContaining(["checkInTime"]),
      slotsApplied: expect.arrayContaining(["checkInTime"]),
      pendingFieldsAfter: expect.arrayContaining(["check_out_date", "check_out_time"]),
      policyAction: "ask_missing_slot",
      legacyBypassUsed: false,
    });
    expectNonNegativeTraceTimings(entryTimeTrace);
    expect(entryTimeTrace.openaiCalls).toBeLessThanOrEqual(1);
    expect(entryTimeTrace.pendingFieldsAfter).not.toContain("check_in_date");
    expect(entryTimeTrace.pendingFieldsAfter).not.toContain("check_in_time");

    expect(faq.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-06-29",
      checkInTime: "10:00",
    });
    expect(faq.botReply?.body.toLowerCase()).toContain("guardería");
    expect(faq.botReply?.body).toContain("Seguimos con la reserva");
    expect(faq.botReply?.body).toContain("salida");
    expect(faq.botReply?.body).not.toContain("fecha de entrada");
    const faqTrace = latestAuthorityTrace(faq.conversation);
    expect(faqTrace).toMatchObject({
      policyAction: "answer_faq_then_resume",
      renderKey: "conversation.faq_reply",
      pendingFieldsAfter: expect.arrayContaining(["check_out_date", "check_out_time"]),
      legacyBypassUsed: false,
    });
    expectNonNegativeTraceTimings(faqTrace);
    expect(faqTrace.pendingFieldsAfter).not.toContain("check_in_date");

    expect(cancelled.botReply?.body).toBe(
      "De acuerdo, dejamos la reserva sin continuar. Si necesitas otra cosa, estoy por aquí.",
    );
    expect(cancelled.conversation.reservationFlow).toBeUndefined();
    const cancelTrace = latestAuthorityTrace(cancelled.conversation);
    expect(cancelTrace).toMatchObject({
      policyAction: "cancel_flow",
      activeFlowAfter: "none",
      pendingFieldsAfter: [],
      legacyBypassUsed: false,
    });
    expectNonNegativeTraceTimings(cancelTrace);

    const events = cancelled.conversation.events.map((event) => event.eventType);
    expect(events).toEqual(
      expect.arrayContaining([
        "authority_turn_started",
        "nlu_called",
        "nlu_result_received",
        "nlu_slots_extracted",
        "nlu_slots_applied",
        "state_reducer_applied",
        "pending_fields_after_merge",
        "policy_decision",
        "copy_rendered",
        "outbox_sent",
        "authority_turn_completed",
      ]),
    );
    expect(events).not.toContain("authority_turn_invariant_failed");
    expect(JSON.stringify(cancelled.conversation.events)).not.toContain("whatsapp:+34600009991");
    expect(JSON.stringify(cancelled.conversation.events)).not.toContain("PIPO");
  });

  it("marks existing clients without duplicating CLIENTES rows", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps({
      clientUpsertResult: {
        kind: "existing",
        clientStatus: "known",
        clientName: "Cliente QA Existente",
        rowNumber: 12,
        sheetName: "CLIENTES_QA",
        matchCount: 1,
        source: "google_sheets_client_directory",
      },
    });
    const directory = createStaticClientDirectory([
      {
        nombre: "Cliente QA Existente",
        telefonoNormalizado: "34600009991",
        rowNumber: 12,
        sheetName: "CLIENTES_QA",
      },
    ]);

    await createNewClientPricedProposal({
      store,
      deps,
      directory,
      prefix: "SM_BRIDGE_EXISTING_CLIENT_1",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "si",
        messageSid: "SM_BRIDGE_EXISTING_CLIENT_2",
      },
      store,
      directory,
      deps,
    );

    expect(counters.clientUpserts).toHaveLength(1);
    expect(result.conversation.clientName).toBe("Cliente QA Existente");
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_existing_from_reservation")).toBe(true);
  });

  it("treats mañana as an entry date during an active reservation flow", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_TOMORROW",
      petName: "PIPO",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "mañana",
        messageSid: "SM_SLOT_TOMORROW_DATE",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "PIPO",
      checkInDate: "2026-06-02",
    });
    expect(result.botReply?.body).toContain("salida");
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
  });

  it("merges mañana a las 10 as entry date and entry time", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_TOMORROW_TIME",
      petName: "PIPO",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "mañana a las 10",
        messageSid: "SM_SLOT_TOMORROW_TIME_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-06-02",
      checkInTime: "10:00",
    });
    expect(result.botReply?.body).toContain("salida");
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
  });

  it("resolves el día 27 as a near-future partial date without repeating the generic prompt", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_PARTIAL_DAY",
      petName: "PIPO",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "el día 27",
        messageSid: "SM_SLOT_PARTIAL_DAY_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-06-27",
    });
    expect(result.botReply?.body).toContain("salida");
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
  });

  it("answers hotel versus daycare FAQ during reservation and preserves the flow", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();

    await collectNewClientPet({
      store,
      deps,
      prefix: "SM_SLOT_FAQ_ESCAPE",
      petName: "PIPO",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "diferencia entre hotel y guardería",
        messageSid: "SM_SLOT_FAQ_ESCAPE_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "PIPO",
    });
    expect(result.botReply?.body.toLowerCase()).toContain("guardería");
    expect(result.botReply?.body.toLowerCase()).toContain("hotel");
    expect(result.botReply?.body).toContain("Seguimos con la reserva");
    expect(result.botReply?.body).not.toContain("Perdona, no te he entendido bien");
    expect(result.conversation.events.some((event) => event.eventType === "reservation_global_intent_escape")).toBe(true);
  });

  it("cancels an active reservation flow with the global escape hatch", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();

    await collectNewClientPet({
      store,
      deps,
      prefix: "SM_SLOT_CANCEL_ESCAPE",
      petName: "PIPO",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "ya no quiero reservar",
        messageSid: "SM_SLOT_CANCEL_ESCAPE_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      deps,
    );

    expect(result.botReply?.body).toBe(
      "De acuerdo, dejamos la reserva sin continuar. Si necesitas otra cosa, estoy por aquí.",
    );
    expect(result.conversation.reservationFlow).toBeUndefined();
    expect(result.conversation.pendingReservationProposal).toBeUndefined();
    expect(result.conversation.events.some((event) => event.eventType === "reservation_flow_cancelled_by_user")).toBe(true);
  });

  it("records sanitized state-aware merge diagnostics without raw PII", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_DIAGNOSTICS",
      petName: "PIPO",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "mañana a las 10",
        messageSid: "SM_SLOT_DIAGNOSTICS_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const diagnosticEvents = result.conversation.events.filter((event) =>
      [
        "nlu_assistive_slots_extracted",
        "reservation_slot_merge_attempted",
        "reservation_slot_merge_applied",
        "reservation_next_missing_fields",
      ].includes(event.eventType),
    );

    expect(diagnosticEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "nlu_assistive_slots_extracted",
        "reservation_slot_merge_attempted",
        "reservation_slot_merge_applied",
        "reservation_next_missing_fields",
      ]),
    );
    expect(JSON.stringify(diagnosticEvents)).not.toContain("PIPO");
    expect(JSON.stringify(diagnosticEvents)).not.toContain("mañana");
  });

  it("targets pending checkout with pasado mañana a las 10 también", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_EXIT_PAST_TOMORROW",
      petName: "PIPO",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "para mañana puede ser?",
        messageSid: "SM_SLOT_EXIT_PAST_TOMORROW_ENTRY",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "a las 10 ambas",
        messageSid: "SM_SLOT_EXIT_PAST_TOMORROW_TIMES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "pasado mañana a las 10 también",
        messageSid: "SM_SLOT_EXIT_PAST_TOMORROW_EXIT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInDate: "2026-06-02",
      checkInTime: "10:00",
      checkOutDate: "2026-06-03",
      checkOutTime: "10:00",
    });
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
    expect(result.conversation.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "reservation_slot_target_resolved",
          payload: expect.objectContaining({
            target: "exit",
            reason: "pending_fields_exit",
          }),
        }),
        expect.objectContaining({
          eventType: "reservation_pending_fields_after_merge",
          payload: expect.objectContaining({
            missingFields: ["notes"],
          }),
        }),
      ]),
    );
  });

  it("targets pending checkout with lunes a las 10", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-26T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_EXIT_MONDAY",
      petName: "PIPO",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "mañana a las 10",
        messageSid: "SM_SLOT_EXIT_MONDAY_ENTRY",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "lunes a las 10",
        messageSid: "SM_SLOT_EXIT_MONDAY_EXIT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInDate: "2026-06-27",
      checkInTime: "10:00",
      checkOutDate: "2026-06-29",
      checkOutTime: "10:00",
    });
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
  });

  it("resolves partial checkout day against the entry month when checkout is pending", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_EXIT_PARTIAL_DAY",
      petName: "PIPO",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "entrada el 25 de diciembre a las 10",
        messageSid: "SM_SLOT_EXIT_PARTIAL_DAY_ENTRY",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "el día 27",
        messageSid: "SM_SLOT_EXIT_PARTIAL_DAY_EXIT",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-12-25",
      checkInTime: "10:00",
      checkOutDate: "2026-12-27",
    });
    expect(result.botReply?.body).toContain("A qué hora sería");
    expect(result.botReply?.body).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
  });

  it("applies a bare time to checkout time when only checkout time is pending", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_EXIT_BARE_TIME",
      petName: "PIPO",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "entrada el 25 de diciembre a las 10",
        messageSid: "SM_SLOT_EXIT_BARE_TIME_ENTRY",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "el día 27",
        messageSid: "SM_SLOT_EXIT_BARE_TIME_DAY",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "a las 10",
        messageSid: "SM_SLOT_EXIT_BARE_TIME_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInDate: "2026-12-25",
      checkInTime: "10:00",
      checkOutDate: "2026-12-27",
      checkOutTime: "10:00",
    });
    expect(result.botReply?.body).toContain("alimentación");
    expect(result.botReply?.body).not.toContain("las horas");
    const trace = latestAuthorityTrace(result.conversation);
    expect(trace).toMatchObject({
      nluSlotsExtracted: expect.arrayContaining(["checkInTime"]),
      nluTargetSlots: expect.arrayContaining(["checkOutTime"]),
      slotsApplied: expect.arrayContaining(["checkOutTime"]),
      pendingFieldsAfter: ["notes"],
      legacyBypassUsed: false,
    });
  });

  it("answers FAQ while checkout is pending and preserves entry slots", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_EXIT_FAQ",
      petName: "PIPO",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "mañana a las 10",
        messageSid: "SM_SLOT_EXIT_FAQ_ENTRY",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "diferencia entre hotel y guardería",
        messageSid: "SM_SLOT_EXIT_FAQ_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-06-02",
      checkInTime: "10:00",
    });
    expect(result.conversation.reservationFlow?.checkOutDate).toBeUndefined();
    expect(result.botReply?.body.toLowerCase()).toContain("guardería");
    expect(result.botReply?.body).toContain("Seguimos con la reserva");
  });

  it("cancels the reservation while checkout is pending", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_EXIT_CANCEL",
      petName: "PIPO",
    });
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "mañana a las 10",
        messageSid: "SM_SLOT_EXIT_CANCEL_ENTRY",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "ya no quiero reservar",
        messageSid: "SM_SLOT_EXIT_CANCEL_VALUE",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.botReply?.body).toBe(
      "De acuerdo, dejamos la reserva sin continuar. Si necesitas otra cosa, estoy por aquí.",
    );
    expect(result.conversation.reservationFlow).toBeUndefined();
  });

  it("honors explicit entry and exit targets", async () => {
    const directory = createStaticClientDirectory([]);
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-26T10:00:00.000Z"),
    };

    const entryStore = new MemoryConversationStore();
    await collectNewClientPet({
      store: entryStore,
      deps: timedDeps,
      prefix: "SM_SLOT_EXPLICIT_ENTRY",
      petName: "PIPO",
      directory,
    });
    const entry = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "entrada mañana a las 10",
        messageSid: "SM_SLOT_EXPLICIT_ENTRY_VALUE",
      },
      entryStore,
      directory,
      timedDeps,
    );
    expect(entry.conversation.reservationFlow).toMatchObject({
      checkInDate: "2026-06-27",
      checkInTime: "10:00",
    });
    expect(entry.conversation.reservationFlow?.checkOutDate).toBeUndefined();

    const exit = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "salida el lunes a las 10",
        messageSid: "SM_SLOT_EXPLICIT_EXIT_VALUE",
      },
      entryStore,
      directory,
      timedDeps,
    );
    expect(exit.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInDate: "2026-06-27",
      checkInTime: "10:00",
      checkOutDate: "2026-06-29",
      checkOutTime: "10:00",
    });
  });

  it("keeps shared hours when the user gives times before dates", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_TIME_FIRST",
      petName: "PIPO",
    });
    const timeOnly = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "a las 10 ambas",
        messageSid: "SM_SLOT_TIME_FIRST_TIME",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(timeOnly.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "PIPO",
      checkInTime: "10:00",
      checkOutTime: "10:00",
    });
    expect(timeOnly.botReply?.body).toContain("fecha de entrada");
    expect(timeOnly.botReply?.body).not.toContain("fecha y hora de entrada");

    const dates = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "25-12-2026 a 26-12-2026",
        messageSid: "SM_SLOT_TIME_FIRST_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(dates.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInDate: "2026-12-25",
      checkOutDate: "2026-12-26",
      checkInTime: "10:00",
      checkOutTime: "10:00",
    });
  });

  it("asks only for times when the user gives dates first", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientPet({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_DATE_FIRST",
      petName: "PIPO",
    });
    const dates = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "25-12-2026 a 26-12-2026",
        messageSid: "SM_SLOT_DATE_FIRST_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(dates.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      checkInDate: "2026-12-25",
      checkOutDate: "2026-12-26",
    });
    expect(dates.botReply?.body).toContain("Me falta la hora de entrada");
    expect(dates.botReply?.body).not.toContain("fecha y hora de entrada");

    const times = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "a las 10 entrada y salida",
        messageSid: "SM_SLOT_DATE_FIRST_TIMES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(times.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInTime: "10:00",
      checkOutTime: "10:00",
    });
  });

  it("merges pet, dates and shared times from one rich message", async () => {
    const store = new MemoryConversationStore();
    const { deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientOwner({
      store,
      deps: timedDeps,
      prefix: "SM_SLOT_ALL_TOGETHER",
    });
    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "sería para PIPO del 25 al 26 de diciembre, a las 10 entrada y salida",
        messageSid: "SM_SLOT_ALL_TOGETHER_DETAILS",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      petName: "PIPO",
      checkInDate: "2026-12-25",
      checkOutDate: "2026-12-26",
      checkInTime: "10:00",
      checkOutTime: "10:00",
    });
    expect(result.botReply?.body).not.toContain("nombre o los nombres");
    expect(result.botReply?.body).not.toContain("fecha y hora");
  });

  it("keeps client and pet when a proposal is rejected and new dates arrive", async () => {
    const store = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const timedDeps = {
      ...deps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await createNewClientPricedProposal({
      store,
      deps: timedDeps,
      from: "whatsapp:+34600009991",
      petName: "PIPO",
      dateText: "Del 25 al 26 de diciembre de 2026",
      prefix: "SM_SLOT_REJECT_CHANGE",
    });
    const rejected = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "no",
        messageSid: "SM_SLOT_REJECT_CHANGE_NO",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(rejected.conversation.pendingReservationProposal).toMatchObject({
      status: "cancelled",
      failureReason: "customer_rejected",
    });
    expect(rejected.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "PIPO",
    });

    const newDates = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "26-12-2026 a 27-12-2026",
        messageSid: "SM_SLOT_REJECT_CHANGE_NEW_DATES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(newDates.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      petName: "PIPO",
      checkInDate: "2026-12-26",
      checkOutDate: "2026-12-27",
    });
    expect(newDates.botReply?.body).toContain("Me falta la hora");

    const newProposal = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "a las 10 entrada y salida",
        messageSid: "SM_SLOT_REJECT_CHANGE_NEW_TIMES",
      },
      store,
      createStaticClientDirectory([]),
      timedDeps,
    );

    expect(newProposal.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      petName: "PIPO",
      checkIn: "2026-12-26",
      checkOut: "2026-12-27",
      checkInTime: "10:00",
      checkOutTime: "10:00",
    });
    expect(counters.checks).toBeGreaterThanOrEqual(2);
  });

  it("handles first-hour ambiguity and out-of-range PM times deterministically", async () => {
    const firstHourStore = new MemoryConversationStore();
    const { deps: firstHourDeps } = makeBridgeDeps();
    const timedFirstHourDeps = {
      ...firstHourDeps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };

    await collectNewClientDatesWithoutTimes({
      store: firstHourStore,
      deps: timedFirstHourDeps,
      prefix: "SM_SLOT_FIRST_HOUR",
      petName: "PIPO",
      dateText: "Del 25 al 26 de diciembre de 2026",
    });
    const ambiguous = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "primera hora",
        messageSid: "SM_SLOT_FIRST_HOUR_AMBIGUOUS",
      },
      firstHourStore,
      createStaticClientDirectory([]),
      timedFirstHourDeps,
    );
    expect(ambiguous.botReply?.body).toContain("mañana o primera hora de la tarde");

    const afternoon = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "primera hora de la tarde",
        messageSid: "SM_SLOT_FIRST_HOUR_AFTERNOON",
      },
      firstHourStore,
      createStaticClientDirectory([]),
      timedFirstHourDeps,
    );
    expect(afternoon.conversation.reservationFlow).toMatchObject({
      status: "collecting_notes",
      checkInTime: "16:30",
      checkOutTime: "16:30",
    });

    const pmStore = new MemoryConversationStore();
    const { deps: pmDeps } = makeBridgeDeps();
    const timedPmDeps = {
      ...pmDeps,
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    };
    await collectNewClientDatesWithoutTimes({
      store: pmStore,
      deps: timedPmDeps,
      prefix: "SM_SLOT_PM",
      petName: "PIPO",
      dateText: "Del 25 al 26 de diciembre de 2026",
    });
    const pm = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "las 10 PM entrada y salida",
        messageSid: "SM_SLOT_PM_TIME",
      },
      pmStore,
      createStaticClientDirectory([]),
      timedPmDeps,
    );
    expect(pm.conversation.reservationFlow).toMatchObject({
      status: "collecting_dates",
      pendingSharedTimeConfirmation: "22:00",
    });
    expect(pm.botReply?.body).toContain("22:00");
  });

  it("keeps the WhatsApp golden routing phrases stable", async () => {
    const reset = buildConversationReplyPlan("reiniciar");
    expect(reset).toMatchObject({ intent: "conversation_reset" });
    expect(renderConversationReplyPlan(reset, "reiniciar")).toBe("Reiniciado.");

    const hola = buildConversationReplyPlan("hola");
    expect(hola).toMatchObject({ intent: "greeting" });
    expect(renderConversationReplyPlan(hola, "hola")).toBe("¡Hola! ¿En qué podemos ayudarte?");

    const greeting = buildConversationReplyPlan("hola buenas tardes");
    const greetingReply = renderConversationReplyPlan(greeting, "hola buenas tardes");
    expect(greeting).toMatchObject({ intent: "greeting" });
    expect(greetingReply).toBe("Buenas tardes. ¿En qué podemos ayudarte?");
    expect(greetingReply).not.toContain("horario de recepción");
    expect(buildConversationReplyPlan("quiero reservar")).toMatchObject({
      intent: "reservation_start",
    });
    expect(buildConversationReplyPlan("¿y el pago?")).toMatchObject({
      intent: "faq_payment",
    });
    expect(buildConversationReplyPlan("¿cuánto cuesta?")).toMatchObject({
      intent: "faq_prices",
    });
    expect(buildConversationReplyPlan("¿puedo visitar?")).toMatchObject({
      intent: "faq_visits",
    });

    const noProposalStore = new MemoryConversationStore();
    const { counters: noProposalCounters, deps: noProposalDeps } = makeBridgeDeps();
    const noProposal = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        body: "sí por favor",
        messageSid: "SM_GOLDEN_NO_PROPOSAL",
      },
      noProposalStore,
      createStaticClientDirectory([]),
      noProposalDeps,
    );
    expect(noProposalCounters.writes).toBe(0);
    expect(noProposal.botReply?.body).toContain("Para avanzar necesito");

    const flowStore = new MemoryConversationStore();
    const { counters, deps } = makeBridgeDeps();
    const start = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "quiero reservar",
        messageSid: "SM_GOLDEN_FLOW_START",
      },
      flowStore,
      createStaticClientDirectory([]),
      deps,
    );
    expect(start.botReply?.body).toContain("¿Ya eres cliente");
    const newClient = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "no soy cliente",
        messageSid: "SM_GOLDEN_FLOW_NEW",
      },
      flowStore,
      createStaticClientDirectory([]),
      deps,
    );
    expect(newClient.conversation.reservationFlow?.clientKind).toBe("new");
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "Ana QA ana.qa@example.test",
        messageSid: "SM_GOLDEN_FLOW_OWNER",
      },
      flowStore,
      createStaticClientDirectory([]),
      deps,
    );
    const pets = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "YUYU y KIRA",
        messageSid: "SM_GOLDEN_FLOW_PETS",
      },
      flowStore,
      createStaticClientDirectory([]),
      deps,
    );
    expect(pets.botReply?.body).not.toContain("Perdona, no te he entendido bien");
    const looseDates = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "entrada el 29 a las 10 y salida el 31 a las 16",
        messageSid: "SM_GOLDEN_FLOW_LOOSE_DATES",
      },
      flowStore,
      createStaticClientDirectory([]),
      deps,
    );
    expect(looseDates.botReply?.body).not.toContain("Perdona, no te he entendido bien");
    const indifferent = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "me da igual",
        messageSid: "SM_GOLDEN_FLOW_INDIFFERENT",
      },
      flowStore,
      createStaticClientDirectory([]),
      deps,
    );
    expect(indifferent.botReply?.body).not.toContain("Perdona, no te he entendido bien");

    await createNewClientPricedProposal({
      store: flowStore,
      deps,
      from: "whatsapp:+34600009993",
      petName: "Kira QA",
      prefix: "SM_GOLDEN_PROPOSAL",
    });
    const confirmed = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009993",
        body: "sí por favor",
        messageSid: "SM_GOLDEN_CONFIRM",
      },
      flowStore,
      createStaticClientDirectory([]),
      deps,
    );
    expect(counters.writes).toBe(1);
    expect(confirmed.botReply?.body).toContain("Reserva confirmada");
  });
});
