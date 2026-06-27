import { describe, expect, it } from "vitest";

import { buildEntryLogRecord } from "@/lib/hotel/application/entry-log";
import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import { createStaticClientDirectory } from "@/lib/hotel/clients";
import {
  buildConversationReplyPlan,
  classifyConversationIntent,
} from "./nlu";
import { renderConversationReplyPlan } from "./authority/copy-renderer";
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

const qaPhone = "whatsapp:+34600009991";

function makeReservation(overrides: Partial<ReservationRecord> = {}): ReservationRecord {
  return {
    reservationId: "res_smp_qa_conv_001",
    petKey: "kira-qa",
    status: "confirmada",
    reviewState: "ok",
    source: "demo",
    createdAt: "2026-05-27T10:00:00.000Z",
    updatedAt: "2026-05-27T10:00:00.000Z",
    ownerName: "SMP QA Conversacional",
    ownerEmail: "qa-conversacional@example.test",
    petName: "Kira QA",
    phone: "+34600009991",
    checkInDate: "2026-12-29",
    checkInSlot: "morning",
    checkOutDate: "2026-12-31",
    checkOutSlot: "afternoon",
    petCount: 1,
    reviewFlags: [],
    ...overrides,
  };
}

describe("conversation end-to-end policy QA", () => {
  it.each([
    ["Hola", "greeting", false],
    ["hola buenos días", "greeting", false],
    ["En primer lugar, buenos días", "greeting", false],
    ["Hola, quiero información", "general_information", false],
    ["Buenas, quería hacer una consulta", "general_information", false],
    ["Hola, quiero hacer una reserva", "reservation_start", false],
    ["Buenos días, quiero consultar disponibilidad", "availability_request", false],
    ["Me gustaría saber cómo funciona", "general_information", false],
    ["¿Qué tengo que llevar?", "faq_what_to_bring", false],
    ["¿Puedo visitar el hotel?", "faq_visits", false],
    ["¿Qué vacunas necesita?", "faq_vaccines", false],
    ["¿Mandáis fotos o vídeos?", "faq_photos_videos", false],
    ["¿Puedo llevar su comida?", "faq_food", false],
    ["Quiero reservar para Kira QA del 29 al 31 de diciembre de 2026", "availability_request", false],
    ["Sí, confirma", "reservation_confirm", true],
    ["Quiero cancelar mi reserva", "reservation_cancel", false],
    ["Quiero cambiar la fecha", "reservation_modify", false],
    ["¿y el pago?", "faq_payment", false],
    ["¿cómo se paga?", "faq_payment", false],
    ["¿dónde estáis?", "faq_location", false],
    ["reiniciar", "conversation_reset", false],
    ["Quiero hablar con una persona", "human_handoff", true],
    ["¿Ha comido?", "stay_status_question", true],
    ["¿Ha llorado mucho?", "stay_status_question", true],
    ["¿Está jugando?", "stay_status_question", true],
    ["mensaje sin contexto operativo", "unknown", false],
  ] as const)("classifies %s as %s with handoff=%s", (message, intent, handoff) => {
    const plan = buildConversationReplyPlan(message);
    const reply = renderConversationReplyPlan(plan, message);

    expect(plan.intent).toBe(intent);
    expect(plan.handoff).toBe(handoff);
    expect(reply).not.toContain("por aqui");
    if (intent === "general_information") {
      expect(reply).toContain("horarios");
      expect(reply).not.toContain("Ese caso prefiero");
      expect(reply.toLowerCase()).not.toContain("caso");
    }
    if (intent === "greeting") {
      expect(reply).toContain("¿En qué podemos ayudarte?");
      expect(reply).not.toContain("horarios");
      expect(reply.toLowerCase()).not.toContain("caso");
    }
  });

  it("keeps reset as a hidden context reset with a compact reply", () => {
    const plan = buildConversationReplyPlan("reinicia conversación");

    expect(plan.intent).toBe("conversation_reset");
    expect(renderConversationReplyPlan(plan, "reinicia conversación")).toBe("Reiniciado.");
  });

  it("creates a reviewed proposal without attaching a confirmed reservationId from reservation copy", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp(
      {
        from: qaPhone,
        to: "whatsapp:+14155238886",
        body: "Quiero reservar para Kira QA del 29 al 31 de diciembre de 2026",
        messageSid: "SM_QA_RESERVATION_START",
      },
      store,
      createStaticClientDirectory([]),
    );
    await handleInboundWhatsApp(
      {
        from: qaPhone,
        body: "No soy cliente",
        messageSid: "SM_QA_RESERVATION_NEW",
      },
      store,
      createStaticClientDirectory([]),
    );
    await handleInboundWhatsApp(
      {
        from: qaPhone,
        body: "Ana QA ana.qa@example.test",
        messageSid: "SM_QA_RESERVATION_OWNER",
      },
      store,
      createStaticClientDirectory([]),
    );
    await handleInboundWhatsApp(
      {
        from: qaPhone,
        body: "Kira QA, 1 perro",
        messageSid: "SM_QA_RESERVATION_PET",
      },
      store,
      createStaticClientDirectory([]),
    );
    await handleInboundWhatsApp(
      {
        from: qaPhone,
        body: "Del 29 al 31 de diciembre de 2026",
        messageSid: "SM_QA_RESERVATION_DATES",
      },
      store,
      createStaticClientDirectory([]),
    );
    await handleInboundWhatsApp(
      {
        from: qaPhone,
        body: "Entrada a las 12:00 y salida a las 12:00",
        messageSid: "SM_QA_RESERVATION_TIMES",
      },
      store,
      createStaticClientDirectory([]),
    );
    await handleInboundWhatsApp(
      {
        from: qaPhone,
        body: "Sin notas",
        messageSid: "SM_QA_RESERVATION_NOTES",
      },
      store,
      createStaticClientDirectory([]),
    );
    const result = await handleInboundWhatsApp(
      {
        from: qaPhone,
        body: "No",
        messageSid: "SM_QA_RESERVATION_VISIT",
      },
      store,
      createStaticClientDirectory([]),
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.reservationId).toBeUndefined();
    expect(result.conversation.pendingReservationProposal).toMatchObject({
      status: "proposed",
      petName: "Kira QA",
      checkIn: "2026-12-29",
      checkOut: "2026-12-31",
    });
    expect(result.botReply?.body).toContain("Tenemos disponibilidad");
    expect(result.botReply?.body).toContain("60 €");
    expect(
      result.conversation.events.some(
        (event) =>
          event.eventType === "nlu_classified" &&
          (event.payload as { intent?: string }).intent === "availability_request",
      ),
    ).toBe(true);
  });

  it("keeps later inbound silent once the conversation is in human mode", async () => {
    const store = new MemoryConversationStore();

    const first = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "Quiero hablar con una persona",
        messageSid: "SM_QA_HUMAN_001",
      },
      store,
      createStaticClientDirectory([]),
    );
    const second = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009992",
        body: "Sigo esperando",
        messageSid: "SM_QA_HUMAN_002",
      },
      store,
      createStaticClientDirectory([]),
    );

    expect(first.conversation.mode).toBe("human");
    expect(second.botReply).toBeUndefined();
    expect(second.twiml).toBeUndefined();
    expect(
      second.conversation.events.some((event) => event.eventType === "auto_reply_skipped_human_mode"),
    ).toBe(true);
  });

  it("routes blocked and ambiguous client directory fixtures to safe review states", async () => {
    const blockedStore = new MemoryConversationStore();
    const blocked = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009993",
        body: "Quiero reservar para Kira QA",
        messageSid: "SM_QA_BLOCKED",
      },
      blockedStore,
      createStaticClientDirectory([
        {
          nombre: "Cliente QA Bloqueado",
          telefonoNormalizado: "34600009993",
          bloqueadoNoReservar: true,
          rowNumber: 10,
          sheetName: "CLIENTES",
        },
      ]),
    );

    const ambiguousStore = new MemoryConversationStore();
    const ambiguous = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009994",
        body: "Hola, quiero información",
        messageSid: "SM_QA_AMBIGUOUS",
      },
      ambiguousStore,
      createStaticClientDirectory([
        { nombre: "Cliente QA A", telefonoNormalizado: "34600009994" },
        { nombre: "Cliente QA B", telefonoNormalizado: "34600009994" },
      ]),
    );

    expect(blocked.conversation.mode).toBe("human");
    expect(blocked.conversation.clientStatus).toBe("blocked");
    expect(blocked.conversation.requiresManualReview).toBe(true);
    expect(ambiguous.conversation.clientStatus).toBe("ambiguous");
    expect(ambiguous.conversation.requiresManualReview).toBe(true);
  });

  it("projects chatbot reservation records into entry log without exposing NIF/DNI", () => {
    const confirmed = buildEntryLogRecord(makeReservation());
    const cancelled = buildEntryLogRecord(makeReservation({ status: "cancelada" }));

    expect(confirmed).toMatchObject({
      source: "chatbot",
      action: "confirmada",
      clientName: "SMP QA Conversacional",
      clientStatus: "nuevo contacto",
      phoneNormalized: "+34600009991",
      petName: "Kira QA",
      checkInDate: "2026-12-29",
      checkOutDate: "2026-12-31",
      reservationId: "res_smp_qa_conv_001",
      gestetStatus: "pendiente Gestet",
    });
    expect(cancelled.action).toBe("cancelada");
    expect(JSON.stringify([confirmed, cancelled]).toLowerCase()).not.toContain("nif");
    expect(JSON.stringify([confirmed, cancelled]).toLowerCase()).not.toContain("dni");
  });

  it("extracts QA reservation slots without treating confirmation as safe to execute", () => {
    const start = classifyConversationIntent(
      "Quiero reservar para Kira QA del 29 al 31 de diciembre de 2026",
    );
    const confirm = buildConversationReplyPlan("Sí, confirma");

    expect(start.intent).toBe("availability_request");
    expect(start.slots.petName).toBe("Kira");
    expect(start.slots.checkIn).toBe("29");
    expect(start.slots.checkOut).toBe("31 de diciembre de 2026");
    expect(confirm.intent).toBe("reservation_confirm");
    expect(confirm.handoff).toBe(true);
    expect(renderConversationReplyPlan(confirm, "Sí, confirma")).toContain("propuesta válida revisada");
  });
});
