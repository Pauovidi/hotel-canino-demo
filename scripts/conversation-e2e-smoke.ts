import { createStaticClientDirectory } from "@/lib/hotel/clients";
import type { ClientUpsertFromConfirmedReservationInput } from "@/lib/hotel/clients";
import { buildEntryLogRecord } from "@/lib/hotel/application/entry-log";
import {
  buildTwilioMessageResponse,
  handleInboundWhatsApp,
} from "@/lib/hotel/conversations/service";
import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import type { DemoReservationRecord, SheetsAvailabilityResult } from "@/lib/hotel/integrations/types";
import type { SheetAdapter, SheetsWriteResult } from "@/lib/hotel/sheets/types";
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

class MemoryConversationStore implements ConversationStore {
  private snapshot = createEmptyConversationSnapshot();

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
    return structuredClone(
      this.snapshot.conversations.find((conversation) => conversation.id === id),
    );
  }

  async getByPhone(phoneNormalized: string): Promise<ConversationRecord | undefined> {
    return structuredClone(
      this.snapshot.conversations.find(
        (conversation) => conversation.phoneNormalized === phoneNormalized,
      ),
    );
  }

  async upsertConversation(conversation: Conversation): Promise<ConversationRecord> {
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
    this.snapshot = {
      conversations: structuredClone(records),
      updatedAt: new Date().toISOString(),
    };
    return this.load();
  }
}

const QA_PHONE = "whatsapp:+34600009991";
const SANDBOX_TO = "whatsapp:+14155238886";

function isTwiml(value?: string) {
  return value === undefined || /^<\?xml version="1\.0" encoding="UTF-8"\?><Response>/.test(value);
}

function summarizeReply(value?: string) {
  if (!value) {
    return "(sin autorespuesta)";
  }

  return value.replace(/\s+/g, " ").slice(0, 120);
}

function makeAvailability(): SheetsAvailabilityResult {
  return {
    available: true,
    conflicts: [],
    monthKey: "2026-12",
    sheetName: "DICIEMBRE 2026",
    remainingByDate: {
      "2026-12-29": { morning: 8, afternoon: 8 },
      "2026-12-30": { morning: 8, afternoon: 8 },
      "2026-12-31": { morning: 8, afternoon: 8 },
    },
  };
}

function makeBridgeDeps() {
  const counters = {
    checks: 0,
    writes: 0,
    cancellations: 0,
    reservations: [] as ReservationRecord[],
    clientUpserts: [] as ClientUpsertFromConfirmedReservationInput[],
  };
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
        layout: {} as never,
        issues: [],
        rowCount: 39,
        dayHeaders: [29, 30, 31],
        occupiedCells: 0,
      };
    },
    async checkAvailability() {
      counters.checks += 1;
      return makeAvailability();
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
      counters.cancellations += 1;
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
      async upsertClientFromConfirmedReservation(input: ClientUpsertFromConfirmedReservationInput) {
        counters.clientUpserts.push(structuredClone(input));
        return {
          kind: "created_pending_name" as const,
          clientStatus: "known" as const,
          clientName: "Contacto WhatsApp ****9993",
          rowNumber: 9003,
          sheetName: "CLIENTES_QA",
          warning: "client_name_pending_review",
          source: "google_sheets_client_directory" as const,
        };
      },
    },
  };
}

async function runDirectSmoke() {
  const store = new MemoryConversationStore();
  const { counters, deps } = makeBridgeDeps();
  const knownDirectory = createStaticClientDirectory([
    {
      nombre: "SMP QA Conversacional",
      telefonoMovil: "+34 600 009 991",
      telefonoNormalizado: "34600009991",
      rowNumber: 9001,
      sheetName: "CLIENTES_QA",
    },
    {
      nombre: "SMP QA Bloqueado",
      telefonoMovil: "+34 600 009 992",
      telefonoNormalizado: "34600009992",
      notas: "NO COGER RESERVA",
      rowNumber: 9002,
      sheetName: "CLIENTES_QA",
    },
  ]);
  const cases = [
    {
      label: "info",
      from: QA_PHONE,
      body: "Hola, quiero información",
      expectMode: "bot",
      expectReply: "horarios",
    },
    {
      label: "availability-context-start",
      from: "whatsapp:+34600009993",
      body: "quiero consultar disponibilidad ¿es posible?",
      expectMode: "bot",
      expectReply: "Ya eres cliente",
    },
    {
      label: "confirm-without-proposal",
      from: "whatsapp:+34600009994",
      body: "si",
      expectMode: "bot",
      expectReply: "Para avanzar necesito saber",
    },
    {
      label: "stay-status",
      from: "whatsapp:+34600009995",
      body: "¿Ha comido mi perro?",
      expectMode: "human",
      expectReply: "respuesta real",
    },
    {
      label: "blocked-client",
      from: "whatsapp:+34600009992",
      body: "Quiero reservar",
      expectMode: "human",
      expectReply: "revisamos tu solicitud",
    },
  ] as const;

  const rows = [];
  for (const testCase of cases) {
    const result = await handleInboundWhatsApp(
      {
        from: testCase.from,
        to: SANDBOX_TO,
        body: testCase.body,
        messageSid: `SM_QA_${testCase.label}`,
        rawPayload: {
          From: testCase.from,
          To: SANDBOX_TO,
          Body: testCase.body,
          MessageSid: `SM_QA_${testCase.label}`,
        },
      },
      store,
      knownDirectory,
      deps,
    );
    const nluEvent = result.conversation.events.findLast(
      (event) => event.eventType === "nlu_classified",
    );
    const intent =
      typeof nluEvent?.payload === "object" && nluEvent.payload && "intent" in nluEvent.payload
        ? String(nluEvent.payload.intent)
        : "(policy)";
    const ok =
      result.conversation.mode === testCase.expectMode &&
      isTwiml(result.twiml) &&
      (result.botReply?.body ?? "").includes(testCase.expectReply);

    rows.push({
      label: testCase.label,
      status: ok ? "OK" : "FAIL",
      intent,
      mode: result.conversation.mode,
      twiml: isTwiml(result.twiml) ? "valid" : "invalid",
      events: result.conversation.events.map((event) => event.eventType).join(","),
      entryLogAffected: "no",
      reply: summarizeReply(result.botReply?.body),
    });
  }

  await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "No soy cliente",
      messageSid: "SM_QA_bridge_new_client",
    },
    store,
    knownDirectory,
    deps,
  );
  await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "Toby Responsable toby.responsable@example.test",
      messageSid: "SM_QA_bridge_owner",
    },
    store,
    knownDirectory,
    deps,
  );
  await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "Toby QA, 1 perro",
      messageSid: "SM_QA_bridge_pet",
    },
    store,
    knownDirectory,
    deps,
  );
  await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "Del 29 al 31 de diciembre de 2026",
      messageSid: "SM_QA_bridge_dates",
    },
    store,
    knownDirectory,
    deps,
  );
  await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "Entrada a las 12:00 y salida a las 12:00",
      messageSid: "SM_QA_bridge_times",
    },
    store,
    knownDirectory,
    deps,
  );
  await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "Sin notas",
      messageSid: "SM_QA_bridge_notes",
    },
    store,
    knownDirectory,
    deps,
  );
  const contextualProposal = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "No",
      messageSid: "SM_QA_bridge_visit",
    },
    store,
    knownDirectory,
    deps,
  );
  rows.push({
    label: "contextual-slot-fill-proposal",
    status:
      contextualProposal.conversation.pendingReservationProposal?.status === "proposed" &&
      contextualProposal.conversation.pendingReservationProposal.petName === "Toby QA" &&
      counters.writes === 0
        ? "OK"
        : "FAIL",
    intent: "availability_request",
    mode: contextualProposal.conversation.mode,
    twiml: isTwiml(contextualProposal.twiml) ? "valid" : "invalid",
    events: contextualProposal.conversation.events.map((event) => event.eventType).join(","),
    entryLogAffected: "no",
    clientUpsertAffected: "no",
    reply: summarizeReply(contextualProposal.botReply?.body),
  });

  const confirmed = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "si por favor",
      messageSid: "SM_QA_bridge_confirm",
      rawPayload: {
        From: "whatsapp:+34600009993",
        To: SANDBOX_TO,
        Body: "si por favor",
        MessageSid: "SM_QA_bridge_confirm",
      },
    },
    store,
    knownDirectory,
    deps,
  );
  const reservation = counters.reservations[0];
  const entryLog = reservation ? buildEntryLogRecord(reservation) : undefined;
  rows.push({
    label: "proposal-confirmation-bridge",
    status:
      confirmed.conversation.pendingReservationProposal?.status === "confirmed" &&
      Boolean(confirmed.conversation.reservationId) &&
      counters.writes === 1 &&
      counters.clientUpserts.length === 1 &&
      entryLog?.source === "chatbot"
        ? "OK"
        : "FAIL",
    intent: "reservation_confirm",
    mode: confirmed.conversation.mode,
    twiml: isTwiml(confirmed.twiml) ? "valid" : "invalid",
    events: confirmed.conversation.events.map((event) => event.eventType).join(","),
    entryLogAffected: entryLog ? "yes" : "no",
    clientUpsertAffected: counters.clientUpserts.length > 0 ? "yes" : "no",
    reply: summarizeReply(confirmed.botReply?.body),
  });

  await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "quiero modificar una reserva",
      messageSid: "SM_QA_modify_start",
    },
    store,
    knownDirectory,
    deps,
  );
  const modificationProposal = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "del 28 al 30 de diciembre de 2026",
      messageSid: "SM_QA_modify_dates",
    },
    store,
    knownDirectory,
    deps,
  );
  const modificationConfirmed = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "sí",
      messageSid: "SM_QA_modify_confirm",
    },
    store,
    knownDirectory,
    deps,
  );
  const modifiedReservation = counters.reservations[0];
  rows.push({
    label: "reservation-modification-bridge",
    status:
      modificationProposal.conversation.pendingReservationModificationFlow?.status ===
        "awaiting_confirmation" &&
      modificationConfirmed.conversation.pendingReservationModificationFlow?.status ===
        "confirmed" &&
      counters.writes === 2 &&
      counters.cancellations === 1 &&
      modifiedReservation?.checkInDate === "2026-12-28" &&
      buildEntryLogRecord(modifiedReservation).action === "modificada"
        ? "OK"
        : "FAIL",
    intent: "reservation_modify",
    mode: modificationConfirmed.conversation.mode,
    twiml: isTwiml(modificationConfirmed.twiml) ? "valid" : "invalid",
    events: modificationConfirmed.conversation.events.map((event) => event.eventType).join(","),
    entryLogAffected: "yes",
    reply: summarizeReply(modificationConfirmed.botReply?.body),
  });

  const cancellationStart = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "quiero cancelar una reserva",
      messageSid: "SM_QA_cancel_start",
    },
    store,
    knownDirectory,
    deps,
  );
  const cancellationConfirmed = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009993",
      to: SANDBOX_TO,
      body: "sí por favor",
      messageSid: "SM_QA_cancel_confirm",
    },
    store,
    knownDirectory,
    deps,
  );
  const cancelledReservation = counters.reservations[0];
  rows.push({
    label: "reservation-cancellation-bridge",
    status:
      cancellationStart.conversation.pendingReservationCancellationFlow?.status ===
        "awaiting_confirmation" &&
      cancellationConfirmed.conversation.pendingReservationCancellationFlow?.status ===
        "confirmed" &&
      counters.cancellations === 2 &&
      cancelledReservation?.status === "cancelada" &&
      buildEntryLogRecord(cancelledReservation).action === "cancelada"
        ? "OK"
        : "FAIL",
    intent: "reservation_cancel",
    mode: cancellationConfirmed.conversation.mode,
    twiml: isTwiml(cancellationConfirmed.twiml) ? "valid" : "invalid",
    events: cancellationConfirmed.conversation.events.map((event) => event.eventType).join(","),
    entryLogAffected: "yes",
    reply: summarizeReply(cancellationConfirmed.botReply?.body),
  });

  const humanFirst = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009996",
      to: SANDBOX_TO,
      body: "Quiero hablar con una persona",
      messageSid: "SM_QA_human_1",
    },
    store,
  );
  const humanSecond = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34600009996",
      to: SANDBOX_TO,
      body: "Sigo esperando",
      messageSid: "SM_QA_human_2",
    },
    store,
  );
  rows.push({
    label: "human-follow-up",
    status:
      humanFirst.conversation.mode === "human" &&
      !humanSecond.botReply &&
      isTwiml(humanSecond.twiml)
        ? "OK"
        : "FAIL",
    intent: "human_handoff",
    mode: humanSecond.conversation.mode,
    twiml: isTwiml(humanSecond.twiml) ? "valid" : "invalid",
    events: humanSecond.conversation.events.map((event) => event.eventType).join(","),
    entryLogAffected: "no",
    reply: summarizeReply(humanSecond.botReply?.body),
  });

  console.table(rows);

  const failed = rows.filter((row) => row.status !== "OK");
  if (failed.length > 0) {
    throw new Error(`Conversation smoke failed: ${failed.map((row) => row.label).join(", ")}`);
  }

  return rows;
}

async function runHttpSmoke(baseUrl: string) {
  const token = process.env.TWILIO_WEBHOOK_AUTH_TOKEN;
  const body = new URLSearchParams({
    From: QA_PHONE,
    To: SANDBOX_TO,
    Body: "Hola, quiero información",
    MessageSid: `SM_QA_HTTP_${Date.now()}`,
  });
  const url = new URL("/api/twilio/whatsapp", baseUrl);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };

  if (token) {
    headers["x-twilio-webhook-token"] = token;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  const ok = response.status === 200 && text.includes("<Response><Message>");

  console.table([
    {
      label: "http-inbound",
      status: ok ? "OK" : "FAIL",
      httpStatus: response.status,
      twiml: text.startsWith(buildTwilioMessageResponse().slice(0, 30)) ? "valid" : "invalid",
      reply: summarizeReply(text.replace(/<[^>]+>/g, " ")),
    },
  ]);

  if (!ok) {
    throw new Error("HTTP conversation smoke failed");
  }
}

async function main() {
  const baseUrl = process.env.CONVERSATION_SMOKE_BASE_URL;

  if (baseUrl && process.env.CONVERSATION_SMOKE_ALLOW_HTTP === "true") {
    await runHttpSmoke(baseUrl);
    return;
  }

  if (baseUrl) {
    console.log("[skip] CONVERSATION_SMOKE_BASE_URL ignored without CONVERSATION_SMOKE_ALLOW_HTTP=true");
  }

  await runDirectSmoke();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "conversation smoke failed");
  process.exitCode = 1;
});
