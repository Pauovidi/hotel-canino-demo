import { listEntryLogRecords } from "@/lib/hotel/application/entry-log";
import { requestReservationCancellation } from "@/lib/hotel/application/operations";
import {
  clearClientDirectoryRow,
  createStaticClientDirectory,
  upsertClientFromConfirmedReservation,
  type ClientUpsertFromConfirmedReservationResult,
} from "@/lib/hotel/clients";
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
    record.lastMessagePreview = message.body.slice(0, 180);
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

function summarizeReservationId(value: string): string {
  return value.length <= 8 ? "[reservation-id]" : `[reservation-id:${value.slice(-8)}]`;
}

function assertSyntheticInput(input: { from: string; petName: string }) {
  if (input.from !== "whatsapp:+34600009991" || !/^Kira QA \d+$/.test(input.petName)) {
    throw new Error("Smoke real abortado: los datos no parecen sinteticos QA.");
  }
}

async function main() {
  if (process.env.HOTEL_QA_ALLOW_REAL_SHEETS_WRITE !== "true") {
    console.log("[skip] HOTEL_QA_ALLOW_REAL_SHEETS_WRITE=true is required.");
    return;
  }

  const store = new MemoryConversationStore();
  const suffix = String(Date.now()).slice(-6);
  const from = "whatsapp:+34600009991";
  const petName = `Kira QA ${suffix}`;
  assertSyntheticInput({ from, petName });
  if (
    process.env.HOTEL_QA_CLEANUP_REAL_SHEETS !== "true" &&
    process.env.HOTEL_QA_KEEP_REAL_SHEETS_WRITE !== "true"
  ) {
    throw new Error(
      "Smoke real abortado: define HOTEL_QA_CLEANUP_REAL_SHEETS=true o HOTEL_QA_KEEP_REAL_SHEETS_WRITE=true.",
    );
  }
  if (
    process.env.HOTEL_QA_ALLOW_REAL_CLIENTS_WRITE === "true" &&
    process.env.HOTEL_QA_CLEANUP_REAL_CLIENTS !== "true" &&
    process.env.HOTEL_QA_KEEP_REAL_CLIENTS_WRITE !== "true"
  ) {
    throw new Error(
      "Smoke real abortado: define HOTEL_QA_CLEANUP_REAL_CLIENTS=true o HOTEL_QA_KEEP_REAL_CLIENTS_WRITE=true.",
    );
  }
  const requestText = `Quiero reservar para ${petName} del 29 al 31 de diciembre de 2026`;
  let clientUpsertResult: ClientUpsertFromConfirmedReservationResult | undefined;
  const reservationBridgeDeps = {
    async upsertClientFromConfirmedReservation(
      input: Parameters<typeof upsertClientFromConfirmedReservation>[0],
    ) {
      if (process.env.HOTEL_QA_ALLOW_REAL_CLIENTS_WRITE !== "true") {
        return {
          kind: "skipped_invalid_phone" as const,
          clientStatus: "unknown" as const,
          warning: "real_clients_write_not_enabled_for_smoke",
          source: "google_sheets_client_directory" as const,
        };
      }

      clientUpsertResult = await upsertClientFromConfirmedReservation({
        ...input,
        clientName: `SMP QA Conversacional ${suffix}`,
        email: `qa-conversacional-${suffix}@example.test`,
      });
      return clientUpsertResult;
    },
  };

  const proposal = await handleInboundWhatsApp(
    {
      from,
      to: "whatsapp:+14155238886",
      body: requestText,
      messageSid: `SM_QA_REAL_PROPOSAL_${suffix}`,
    },
    store,
    createStaticClientDirectory([]),
    reservationBridgeDeps,
  );

  if (proposal.conversation.pendingReservationProposal?.status !== "proposed") {
    throw new Error("No se creó propuesta pendiente con Sheets real.");
  }

  const confirmed = await handleInboundWhatsApp(
    {
      from,
      to: "whatsapp:+14155238886",
      body: "Sí, confirma",
      messageSid: `SM_QA_REAL_CONFIRM_${suffix}`,
    },
    store,
    createStaticClientDirectory([]),
    reservationBridgeDeps,
  );
  const reservationId = confirmed.conversation.reservationId;

  if (!reservationId) {
    throw new Error("No se generó reservationId tras confirmar.");
  }

  const entry = (await listEntryLogRecords()).find(
    (record) => record.reservationId === reservationId,
  );

  if (!entry) {
    throw new Error("La reserva confirmada no aparece en Registro de entrada.");
  }

  console.table([
    {
      status: "OK",
      reservationId: summarizeReservationId(reservationId),
      entryLog: "yes",
      clientUpsert:
        process.env.HOTEL_QA_ALLOW_REAL_CLIENTS_WRITE === "true"
          ? clientUpsertResult?.kind ?? "missing"
          : "skipped",
      source: entry.source,
      action: entry.action,
      gestetStatus: entry.gestetStatus,
    },
  ]);

  if (process.env.HOTEL_QA_CLEANUP_REAL_SHEETS === "true") {
    await requestReservationCancellation(reservationId);
    console.log("[ok] cleanup requested for synthetic reservation");
  }

  if (
    process.env.HOTEL_QA_CLEANUP_REAL_CLIENTS === "true" &&
    clientUpsertResult?.rowNumber &&
    clientUpsertResult.sheetName
  ) {
    await clearClientDirectoryRow(clientUpsertResult.rowNumber, clientUpsertResult.sheetName);
    console.log("[ok] cleanup requested for synthetic CLIENTES row");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "real Sheets conversation smoke failed");
  process.exitCode = 1;
});
