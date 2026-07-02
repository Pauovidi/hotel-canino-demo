import { createStaticClientDirectory } from "@/lib/hotel/clients";
import { describe, expect, it } from "vitest";
import { buildStatelessTemplatePreviewResult } from "./template-preview";
import { handleInboundWhatsApp, setConversationMode } from "./service";
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

function knownDirectory() {
  return createStaticClientDirectory([
    {
      nombre: "Laura Cliente",
      telefonoMovil: "+34 612 345 678",
      telefonoNormalizado: "34612345678",
      email: "laura@example.test",
      mascotas: ["Kira"],
      mascotasCount: 1,
      mascotasMatchStatus: "exact",
      rowNumber: 2,
      sheetName: "CLIENTES",
    },
  ]);
}

describe("functional baseline lock", () => {
  it("locks reset, known identity preservation and post-reset welcome", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "hola" },
      store,
      knownDirectory(),
    );
    const reset = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "reiniciar" },
      store,
      knownDirectory(),
    );
    const greeting = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "hola buenas tardes" },
      store,
      knownDirectory(),
    );

    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(reset.conversation.clientStatus).toBe("known");
    expect(greeting.conversation.clientStatus).toBe("known");
    expect(greeting.botReply?.body).toContain("Laura, bienvenido/a a Somos Muy Perros");
    expect(greeting.botReply?.body).not.toContain("Vista previa");
    expect(greeting.conversation.events.some((event) => event.eventType === "welcome_template_selected")).toBe(true);
  });

  it("locks availability-first for vague weekend reservation requests without fake availability", async () => {
    const store = new MemoryConversationStore();

    for (const [body, petName] of [
      ["quería reservar para este fin de semana, ¿es posible?", undefined],
      ["hay hueco este finde para PIPO?", "PIPO"],
    ] as const) {
      const result = await handleInboundWhatsApp(
        { from: `+34612345${petName ? "679" : "680"}`, body },
        store,
      );

      expect(result.conversation.reservationFlow).toBeUndefined();
      expect(result.conversation.activeFlow).toBe("availabilityInquiry");
      expect(result.conversation.availabilityInquiry?.relativeDateRange).toBe("este_fin_de_semana");
      expect(result.conversation.availabilityInquiry?.readyForTool).toBe(false);
      expect(result.conversation.availabilityInquiry?.petName).toBe(petName);
      expect(result.botReply?.body).not.toContain("Tenemos disponibilidad");
      expect(result.botReply?.body).not.toContain("¿Ya eres cliente");
      expect(result.conversation.events.some((event) => event.eventType === "availability_first_triggered")).toBe(true);
    }
  });

  it("locks availability-first continuation when the user replies with the pet name", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp(
      { from: "+34612345002", body: "quería reservar para este fin de semana, ¿es posible?" },
      store,
      createStaticClientDirectory([]),
    );
    const result = await handleInboundWhatsApp(
      { from: "+34612345002", body: "PAPO" },
      store,
      createStaticClientDirectory([]),
    );

    expect(result.conversation.activeFlow).toBe("availabilityInquiry");
    expect(result.conversation.availabilityInquiry).toMatchObject({
      petName: "PAPO",
      missingFields: ["times"],
      readyForTool: false,
    });
    expect(result.botReply?.body).toContain("hora aproximada de entrada y salida");
    expect(result.botReply?.body).not.toContain("Perdona, no te he entendido bien");
    expect(result.conversation.events.some((event) => event.eventType === "availability_pet_slot_applied")).toBe(true);
  });

  it("locks template preview as preview-only and keeps real snippets", () => {
    const preview = buildStatelessTemplatePreviewResult("plantilla confirmación");

    expect(preview?.reply).toContain("Vista previa de plantilla: confirmación");
    expect(preview?.reply).toContain("¡Tu reserva ha sido confirmada!");
    expect(preview?.reply).toContain("El pago se realiza a la llegada");
  });

  it("locks known-client reservation start without unnecessary client-kind questions", async () => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "quiero reservar" },
      store,
      knownDirectory(),
    );

    expect(result.conversation.clientStatus).toBe("known");
    expect(result.conversation.reservationFlow).toMatchObject({
      clientKind: "habitual",
      status: "collecting_dates",
      petName: "Kira",
    });
    expect(result.botReply?.body).toContain("Tengo registrada a Kira");
    expect(result.botReply?.body).not.toContain("¿Ya eres cliente");
  });

  it("locks FAQ inside reservation and human-mode silence except explicit reset", async () => {
    const store = new MemoryConversationStore();

    const reservation = await handleInboundWhatsApp(
      { from: "+34612345000", body: "quiero reservar" },
      store,
      createStaticClientDirectory([]),
    );
    const payment = await handleInboundWhatsApp(
      { from: "+34612345000", body: "¿y el pago?" },
      store,
      createStaticClientDirectory([]),
    );
    await setConversationMode(payment.conversation.id, "human", "qa", store);
    const silent = await handleInboundWhatsApp(
      { from: "+34612345000", body: "sigo esperando" },
      store,
      createStaticClientDirectory([]),
    );
    const reset = await handleInboundWhatsApp(
      { from: "+34612345000", body: "reiniciar" },
      store,
      createStaticClientDirectory([]),
    );

    expect(reservation.conversation.reservationFlow?.status).toBe("asking_client_kind");
    expect(payment.botReply?.body).toContain("El pago se hace a la llegada");
    expect(payment.botReply?.body).toContain("Seguimos con la reserva");
    expect(silent.botReply).toBeUndefined();
    expect(silent.noReplyReason).toBe("human_mode_auto_reply_suppressed");
    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(reset.conversation.mode).toBe("bot");
  });

  it("locks normal inbound TwiML as non-empty", async () => {
    const result = await handleInboundWhatsApp(
      { from: "+34612345001", body: "hola" },
      new MemoryConversationStore(),
      createStaticClientDirectory([]),
    );

    expect(result.twiml).toContain("<Message>");
    expect(result.twiml).toContain("bienvenido/a a Somos Muy Perros");
    expect(result.allowEmptyTwiml).not.toBe(true);
  });
});
