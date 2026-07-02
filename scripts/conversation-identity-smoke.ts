import type { ClientDirectory, ClientDirectoryReadResult } from "@/lib/hotel/clients";
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

let directoryReads = 0;
const directory: ClientDirectory = {
  async listClients(): Promise<ClientDirectoryReadResult> {
    directoryReads += 1;
    return {
      warnings: [],
      records: [
        {
          nombre: "Pau QA",
          telefonoMovil: "+34 600 000 123",
          telefonoNormalizado: "34600000123",
          mascotas: ["Kira"],
          mascotasCount: 1,
          mascotasMatchStatus: "exact",
          sheetName: "CLIENTES",
          rowNumber: 10,
        },
      ],
    };
  },
};

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const store = new MemoryConversationStore();
const from = "whatsapp:+34600000123";

async function main(): Promise<void> {
  const first = await handleInboundWhatsApp({ from, body: "hola" }, store, directory);
  assert(first.conversation.clientStatus === "known", "known user was not resolved");
  assert(first.botReply?.body.includes("Pau"), "known greeting did not use client identity");
  assert(directoryReads === 1, "initial identity lookup should read directory once");

  const reset = await handleInboundWhatsApp({ from, body: "reiniciar" }, store, directory);
  assert(reset.botReply?.body === "Reiniciado.", "reset did not reply correctly");
  assert(reset.conversation.clientStatus === "known", "reset destroyed persisted identity");
  assert(reset.conversation.reservationFlow === undefined, "reset left reservation flow active");

  const hello = await handleInboundWhatsApp({ from, body: "hola buenas tardes" }, store, directory);
  assert(hello.conversation.clientStatus === "known", "identity was not preserved after reset");
  assert(hello.botReply?.body.includes("Pau"), "post-reset hello did not reuse identity");

  const reservation = await handleInboundWhatsApp({ from, body: "quiero reservar" }, store, directory);
  assert(reservation.conversation.clientStatus === "known", "reservation intent lost identity");
  assert(reservation.conversation.reservationFlow !== undefined, "reservation intent did not start flow");
  assert(directoryReads === 1, "post-reset turns should reuse persisted identity cache");
  assert(
    reservation.conversation.events.some(
      (event) => event.eventType === "client_identity_preserved_after_reset",
    ),
    "identity preservation event missing",
  );

  console.log("smoke:identity ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
