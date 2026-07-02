import { describe, expect, it } from "vitest";
import { createStaticClientDirectory } from "@/lib/hotel/clients";
import {
  ensureDemoConversationSeed,
  archiveConversation,
  handleInboundWhatsApp,
  markConversationRead,
  RESET_CONVERSATIONS_CONFIRMATION,
  requestManualVideoMock,
  redactConversationSensitiveText,
  resetConversations,
  sendManualReply,
  setConversationMode,
  shouldAutoSeedConversations,
  unarchiveConversation,
} from "./service";
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
      throw new Error("not found");
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
      throw new Error("not found");
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

class ResetFailingConversationStore extends MemoryConversationStore {
  async getByPhone(): Promise<ConversationRecord | undefined> {
    throw Object.assign(new Error("mock reset store lookup failed"), { code: 400 });
  }
}

describe("conversation service", () => {
  it("only auto-seeds fixtures with explicit opt-in or test runtime", async () => {
    expect(shouldAutoSeedConversations({ NODE_ENV: "development" })).toBe(false);
    expect(shouldAutoSeedConversations({ NODE_ENV: "test" })).toBe(true);
    expect(shouldAutoSeedConversations({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(false);
    expect(shouldAutoSeedConversations({ NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false);
    expect(
      shouldAutoSeedConversations({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        HOTEL_CONVERSATIONS_DEMO_SEED: "true",
      }),
    ).toBe(true);
    expect(
      shouldAutoSeedConversations({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        HOTEL_CONVERSATIONS_SEED_DEMO: "true",
      }),
    ).toBe(true);

    const store = new MemoryConversationStore();
    await expect(
      ensureDemoConversationSeed(store, {
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).resolves.toBe(false);
    expect(await store.list()).toHaveLength(0);
    await expect(
      ensureDemoConversationSeed(store, {
        NODE_ENV: "development",
        HOTEL_CONVERSATIONS_SEED_DEMO: "true",
      }),
    ).resolves.toBe(true);
    expect((await store.list()).length).toBeGreaterThanOrEqual(5);

    const productionStore = new MemoryConversationStore();
    await expect(
      ensureDemoConversationSeed(productionStore, {
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      }),
    ).resolves.toBe(false);
    expect(await productionStore.list()).toHaveLength(0);
  });

  it("does not auto-seed a store that was explicitly reset", async () => {
    const store = new MemoryConversationStore();
    await store.save({
      conversations: [],
      updatedAt: new Date().toISOString(),
      resetAt: new Date().toISOString(),
      suppressDemoSeed: true,
    });

    await expect(
      ensureDemoConversationSeed(store, {
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).resolves.toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it("dry-runs and confirms a conversation-only reset without touching other stores", async () => {
    const store = new MemoryConversationStore();
    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600000011",
        body: "Hola, quiero información",
        messageSid: "SM_RESET_DRY_RUN",
      },
      store,
      createStaticClientDirectory([]),
    );

    const dryRun = await resetConversations({ dryRun: true }, store);
    expect(dryRun).toEqual(
      expect.objectContaining({
        dryRun: true,
        deleted: false,
        conversations: 1,
      }),
    );
    expect(await store.list()).toHaveLength(1);

    await expect(resetConversations({}, store)).rejects.toThrow(
      "RESET_CONVERSATIONS",
    );

    const confirmed = await resetConversations(
      { confirm: RESET_CONVERSATIONS_CONFIRMATION },
      store,
    );
    expect(confirmed).toEqual(
      expect.objectContaining({
        dryRun: false,
        deleted: true,
        conversations: 1,
        suppressDemoSeed: true,
      }),
    );
    expect(await store.list()).toHaveLength(0);
    expect((await store.load()).suppressDemoSeed).toBe(true);
  });

  it("creates and reuses a conversation by phone", async () => {
    const store = new MemoryConversationStore();

    const first = await handleInboundWhatsApp(
      { from: "whatsapp:+34 612 345 678", body: "Horario?" },
      store,
    );
    const second = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Precio?" },
      store,
    );

    expect(first.conversation.id).toBe(second.conversation.id);
    expect(second.conversation.messages).toHaveLength(4);
  });

  it("marks strong phone matches as recurring clients without exposing document ids", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Cliente Habitual",
        telefonoMovil: "+34 682 62 11 77",
        telefonoNormalizado: "34682621177",
        email: "cliente@example.com",
        rowNumber: 2,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34682621177", body: "Hola, queria consultar horario" },
      store,
      directory,
    );
    const serialized = JSON.stringify(result.conversation);

    expect(result.conversation.clientStatus).toBe("known");
    expect(result.conversation.clientConfidence).toBe("strong");
    expect(result.conversation.clientMatchType).toBe("phone");
    expect(result.conversation.clientName).toBe("Cliente Habitual");
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_match")).toBe(true);
    expect(serialized.toLowerCase()).not.toContain("nif");
  });

  it("greets a strong phone match with the CLIENTES name", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "hola buenas tardes", displayName: "WhatsApp Pau" },
      store,
      directory,
    );

    expect(result.conversation.clientStatus).toBe("known");
    expect(result.conversation.clientConfidence).toBe("strong");
    expect(result.conversation.clientMatchType).toBe("phone");
    expect(result.conversation.clientName).toBe("Pau QA");
    expect(result.conversation.displayName).toBe("WhatsApp Pau");
    expect(result.botReply?.body).toBe("Buenas tardes, Pau. ¿En qué podemos ayudarte?");
  });

  it("greets a strong phone match by name for a plain buenas greeting", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "buenas" },
      store,
      directory,
    );

    expect(result.conversation.clientStatus).toBe("known");
    expect(result.botReply?.body).toBe("Buenas, Pau. ¿En qué podemos ayudarte?");
  });

  it("starts reservations for strong phone matches without asking whether they are clients", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "quiero reservar" },
      store,
      directory,
    );

    expect(result.conversation.clientStatus).toBe("known");
    expect(result.conversation.reservationFlow?.clientKind).toBe("habitual");
    expect(result.conversation.reservationFlow?.status).toBe("collecting_pet");
    expect(result.botReply?.body).toContain("Genial, Pau. Te localizo en nuestra ficha.");
    expect(result.botReply?.body).toContain("Dime el nombre de tu mascota");
    expect(result.botReply?.body).not.toContain("¿Ya eres cliente");
  });

  it.each([
    "exact",
    "token_subset_unique",
    "probable_high_unique_token",
    "exact_canonical",
    "token_subset_unique_canonical",
    "probable_high_unique_token_canonical",
    "duplicate_clear_canonical",
  ] as const)(
    "uses the only safe known pet for a recognized client with status %s",
    async (mascotasMatchStatus) => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        mascotas: ["Kira"],
        mascotasCount: 1,
        mascotasMatchStatus,
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "quiero reservar" },
      store,
      directory,
    );

    expect(result.conversation.reservationFlow).toMatchObject({
      clientKind: "habitual",
      status: "collecting_dates",
      petName: "Kira",
      petCount: 1,
    });
    expect(result.botReply?.body).toContain("Tengo registrada a Kira");
    expect(result.botReply?.body).toContain("Qué fechas necesitas");
    expect(result.botReply?.body).not.toContain("Dime el nombre de tu mascota");
    },
  );

  it("asks which pet for a recognized client with multiple safe pets", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        mascotas: ["Kira", "Thor"],
        mascotasCount: 2,
        mascotasMatchStatus: "duplicate_clear_canonical",
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "quiero reservar" },
      store,
      directory,
    );

    expect(result.conversation.reservationFlow?.status).toBe("collecting_pet");
    expect(result.botReply?.body).toContain("Tengo registradas a Kira y Thor");
    expect(result.botReply?.body).toContain("para alguna de ellas o para otra mascota");
  });

  it.each(["ambiguous", "ambiguous_canonical", "missing", "manual_review"] as const)(
    "asks pet name when known client pet status is %s",
    async (mascotasMatchStatus) => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        mascotas: ["Kira"],
        mascotasCount: 1,
        mascotasMatchStatus,
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "quiero reservar" },
      store,
      directory,
    );

    expect(result.conversation.reservationFlow?.status).toBe("collecting_pet");
    expect(result.conversation.reservationFlow?.petName).toBeUndefined();
    expect(result.botReply?.body).toContain("Dime el nombre de tu mascota");
    },
  );

  it("respects a different pet named by the user after assuming one known pet", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        mascotas: ["Kira"],
        mascotasCount: 1,
        mascotasMatchStatus: "exact",
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "quiero reservar" },
      store,
      directory,
    );
    const correction = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "sería para Thor" },
      store,
      directory,
    );

    expect(correction.conversation.reservationFlow?.petName).toBe("Thor");
    expect(correction.conversation.reservationFlow?.status).toBe("collecting_dates");
    expect(correction.botReply?.body).toContain("Qué fechas");
  });

  it("asks for email when a strong phone match has no CLIENTES email", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const start = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "quiero reservar" },
      store,
      directory,
    );
    const email = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "pau.qa@example.test" },
      store,
      directory,
    );

    expect(start.conversation.reservationFlow?.status).toBe("asking_existing_email");
    expect(start.botReply?.body).toContain("me confirmas el email");
    expect(start.botReply?.body).not.toContain("¿Ya eres cliente");
    expect(email.conversation.clientEmail).toBe("pau.qa@example.test");
    expect(email.conversation.reservationFlow?.status).toBe("collecting_pet");
    expect(email.botReply?.body).toContain("Dime el nombre de tu mascota");
  });

  it("keeps a strong phone match when the user says they are not a client", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau QA",
        telefonoMovil: "+34 600 009 991",
        telefonoNormalizado: "34600009991",
        email: "pau.qa@example.test",
        rowNumber: 7,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "no soy cliente" },
      store,
      directory,
    );

    expect(result.conversation.clientStatus).toBe("known");
    expect(result.conversation.clientMatchType).toBe("phone");
    expect(result.conversation.tags).toContain("cliente_habitual");
    expect(result.botReply?.body).toContain("He encontrado una ficha con este teléfono");
    expect(result.botReply?.body).not.toContain("nuevo contacto");
  });

  it("still asks unknown phone numbers whether they are clients", async () => {
    const store = new MemoryConversationStore();
    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009992", body: "quiero reservar" },
      store,
      createStaticClientDirectory([]),
    );

    expect(result.conversation.clientStatus).toBe("unknown");
    expect(result.conversation.reservationFlow?.status).toBe("asking_client_kind");
    expect(result.botReply?.body).toBe("Genial. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.");
  });

  it("keeps WhatsApp display-name-only matches out of recurring-client status", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Pau Ovidi",
        telefonoMovil: "+34 600 000 001",
        rowNumber: 12,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34699999999",
        body: "Buenos días",
        displayName: "Pau Ovidi",
      },
      store,
      directory,
    );

    expect(result.conversation.displayName).toBe("Pau Ovidi");
    expect(result.conversation.clientStatus).toBe("ambiguous");
    expect(result.conversation.clientConfidence).toBe("medium");
    expect(result.conversation.clientMatchType).toBe("name");
    expect(result.conversation.clientName).toBeUndefined();
    expect(result.conversation.tags).not.toContain("cliente_habitual");
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_match")).toBe(false);
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_ambiguous")).toBe(true);
  });

  it("downgrades stale known client state when the next inbound has no strong directory match", async () => {
    const store = new MemoryConversationStore();
    const created = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34699999999",
        body: "Hola",
        displayName: "Pau Ovidi",
      },
      store,
      createStaticClientDirectory([]),
    );
    await store.replaceConversation({
      ...created.conversation,
      clientStatus: "known",
      clientConfidence: "strong",
      clientMatchType: "phone",
      clientName: "Cliente stale",
      clientSource: "google_sheets_client_directory",
      clientSheetName: "CLIENTES",
      clientSheetRow: 99,
      tags: ["cliente_habitual"],
    });

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34699999999",
        body: "Buenos días",
        displayName: "Pau Ovidi",
      },
      store,
      createStaticClientDirectory([]),
    );

    expect(result.conversation.clientStatus).toBe("unknown");
    expect(result.conversation.clientConfidence).toBe("none");
    expect(result.conversation.clientMatchType).toBe("none");
    expect(result.conversation.clientName).toBeUndefined();
    expect(result.conversation.clientSource).toBeUndefined();
    expect(result.conversation.clientSheetName).toBeUndefined();
    expect(result.conversation.clientSheetRow).toBeUndefined();
    expect(result.conversation.tags).not.toContain("cliente_habitual");
  });

  it("routes blocked directory clients to human review and skips automatic confirmation copy", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Cliente Bloqueado",
        telefonoMovil: "682621177",
        telefonoNormalizado: "34682621177",
        notas: "NO COGER RESERVA",
        rowNumber: 5,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34682621177", body: "Quiero reservar" },
      store,
      directory,
    );

    expect(result.conversation.clientStatus).toBe("blocked");
    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.humanRequested).toBe(true);
    expect(result.conversation.requiresManualReview).toBe(true);
    expect(result.conversation.clientWarnings).toContain("NO COGER RESERVA");
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_blocked")).toBe(true);
    expect(result.twiml).toContain("Gracias, revisamos tu solicitud");
    expect(result.twiml).not.toContain("formulario");
  });

  it("keeps human mode silent for bot replies", async () => {
    const store = new MemoryConversationStore();
    const created = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Quiero hablar con una persona" },
      store,
    );

    const inbound = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Sigo esperando" },
      store,
    );

    expect(created.conversation.mode).toBe("human");
    expect(inbound.botReply).toBeUndefined();
    expect(inbound.conversation.events.some((event) => event.eventType === "auto_reply_skipped_human_mode")).toBe(true);
  });

  it.each([
    "reiniciar",
    "/reiniciar",
    "reset",
    "Reiniciar",
    "/reset",
    "resetear",
    "empezar de nuevo",
    "limpiar conversación",
  ])("answers %s with the global reset reply", async (body) => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body },
      store,
      createStaticClientDirectory([
        {
          nombre: "Cliente QA",
          telefonoNormalizado: "34612345678",
          sheetName: "CLIENTES",
        },
      ]),
    );

    expect(result.botReply?.body).toBe("Reiniciado.");
    expect(result.twiml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Reiniciado.</Message></Response>',
    );
    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.events.some((event) => event.eventType === "conversation_reset_requested")).toBe(true);
    expect(result.conversation.events.some((event) => event.eventType === "nlu_classified")).toBe(false);
  });

  it("answers reset even when the conversation store fails before loading context", async () => {
    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body: "reiniciar" },
      new ResetFailingConversationStore(),
      createStaticClientDirectory([]),
    );

    expect(result.botReply?.body).toBe("Reiniciado.");
    expect(result.twiml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Reiniciado.</Message></Response>',
    );
    expect(result.conversation.mode).toBe("bot");
  });

  it("resets only the current conversation context even from human mode", async () => {
    const store = new MemoryConversationStore();
    const created = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Quiero hablar con una persona" },
      store,
    );
    await store.replaceConversation({
      ...created.conversation,
      mode: "human",
      humanRequested: true,
      assignedAgent: "ops",
      pendingReservationProposal: {
        proposalId: "proposal_test_reset",
        conversationId: created.conversation.id,
        phoneNormalized: created.conversation.phoneNormalized,
        clientStatus: "unknown",
        petName: "Kira QA",
        checkIn: "2026-12-29",
        checkOut: "2026-12-31",
        checkInSlot: "morning",
        checkOutSlot: "afternoon",
        petCount: 1,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: "proposed",
        source: "whatsapp",
        createdFromMessageId: "msg_test",
      },
    });
    const beforeReset = await store.getById(created.conversation.id);

    const reset = await handleInboundWhatsApp(
      { from: "+34612345678", body: "reiniciar" },
      store,
    );

    expect(reset.conversation.mode).toBe("bot");
    expect(reset.conversation.humanRequested).toBe(false);
    expect(reset.conversation.assignedAgent).toBeUndefined();
    expect(reset.conversation.pendingReservationProposal).toBeUndefined();
    expect(reset.conversation.messages).toHaveLength((beforeReset?.messages.length ?? 0) + 2);
    expect(reset.conversation.messages.some((message) => message.body === "reiniciar")).toBe(true);
    expect(reset.conversation.lastMessagePreview).not.toContain("reiniciar");
    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(reset.twiml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Reiniciado.</Message></Response>',
    );
    expect(reset.conversation.unreadCount).toBe(0);
    expect(reset.conversation.events.some((event) => event.eventType === "conversation_reset_requested")).toBe(true);
    expect(reset.conversation.events.some((event) => event.eventType === "auto_reply_skipped_human_mode")).toBe(false);
  });

  it("resets an active reservation flow before continuing with normal routing", async () => {
    const store = new MemoryConversationStore();

    const start = await handleInboundWhatsApp(
      { from: "+34612345678", body: "quiero reservar" },
      store,
      createStaticClientDirectory([]),
    );
    const reset = await handleInboundWhatsApp(
      { from: "+34612345678", body: "reiniciar" },
      store,
      createStaticClientDirectory([]),
    );

    expect(start.conversation.reservationFlow?.status).toBe("asking_client_kind");
    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(reset.conversation.reservationFlow).toBeUndefined();
    expect(reset.conversation.pendingReservationProposal).toBeUndefined();
    expect(reset.conversation.pendingReservationContext).toBeUndefined();
  });

  it("resets an active modification flow before change-flow routing", async () => {
    const store = new MemoryConversationStore();
    const created = await handleInboundWhatsApp(
      { from: "+34612345678", body: "hola" },
      store,
    );
    const now = new Date().toISOString();
    await store.replaceConversation({
      ...created.conversation,
      pendingReservationModificationFlow: {
        flowId: "mod_flow_reset",
        conversationId: created.conversation.id,
        phoneNormalized: created.conversation.phoneNormalized,
        status: "collecting_change",
        source: "whatsapp",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const reset = await handleInboundWhatsApp(
      { from: "+34612345678", body: "reiniciar" },
      store,
    );

    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(reset.conversation.pendingReservationModificationFlow).toBeUndefined();
    expect(reset.conversation.events.some((event) => event.eventType === "reservation_modification_target_missing")).toBe(false);
  });

  it("resets an active cancellation flow before cancellation routing", async () => {
    const store = new MemoryConversationStore();
    const created = await handleInboundWhatsApp(
      { from: "+34612345678", body: "hola" },
      store,
    );
    const now = new Date().toISOString();
    await store.replaceConversation({
      ...created.conversation,
      pendingReservationCancellationFlow: {
        flowId: "cancel_flow_reset",
        conversationId: created.conversation.id,
        phoneNormalized: created.conversation.phoneNormalized,
        status: "awaiting_confirmation",
        source: "whatsapp",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const reset = await handleInboundWhatsApp(
      { from: "+34612345678", body: "reiniciar" },
      store,
    );

    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(reset.conversation.pendingReservationCancellationFlow).toBeUndefined();
    expect(reset.conversation.events.some((event) => event.eventType === "reservation_cancellation_confirmation_requested")).toBe(false);
  });

  it("answers a fresh greeting naturally after reset", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp({ from: "+34612345678", body: "reiniciar" }, store);
    const greeting = await handleInboundWhatsApp({ from: "+34612345678", body: "hola buenas tardes" }, store);

    expect(greeting.botReply?.body).toBe("Buenas tardes. ¿En qué podemos ayudarte?");
    expect(greeting.botReply?.body).not.toContain("Perdona, no te he entendido bien");
    expect(greeting.botReply?.body).not.toContain("horarios");
    expect(greeting.botReply?.body).not.toContain("visitas");
  });

  it("answers a payment FAQ correctly after reset", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp({ from: "+34612345678", body: "reiniciar" }, store);
    const payment = await handleInboundWhatsApp({ from: "+34612345678", body: "¿y el pago?" }, store);

    expect(payment.botReply?.body).toContain("El pago se hace a la llegada");
    expect(payment.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("starts reservation modification routing after reset without falling back to human", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp({ from: "+34612345678", body: "reiniciar" }, store);
    const modification = await handleInboundWhatsApp(
      { from: "+34612345678", body: "quiero modificar una reserva" },
      store,
      createStaticClientDirectory([]),
      {
        now: () => new Date("2026-06-02T09:00:00.000Z"),
        async listReservationRecords() {
          return [];
        },
      },
    );

    expect(modification.conversation.mode).toBe("bot");
    expect(modification.conversation.humanRequested).toBe(false);
    expect(modification.conversation.pendingReservationModificationFlow).toBeDefined();
    expect(modification.botReply?.body).toContain("No encuentro una reserva futura");
    expect(modification.botReply?.body).not.toContain("Gracias, hemos recibido tu mensaje");
    expect(modification.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("resets before blocked-client directory guardrails run", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Cliente Bloqueado",
        telefonoNormalizado: "34682621177",
        bloqueadoNoReservar: true,
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34682621177", body: "reiniciar" },
      store,
      directory,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.botReply?.body).toBe("Reiniciado.");
    expect(result.twiml).toContain("Reiniciado.");
    expect(result.conversation.events.some((event) => event.eventType === "conversation_reset_requested")).toBe(true);
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_blocked")).toBe(false);
  });

  it("answers general information without human handoff", async () => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Hola, quiero información" },
      store,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.humanRequested).toBe(false);
    expect(result.botReply?.body).toContain("horarios");
    expect(result.botReply?.body).toContain("visitas");
    expect(result.botReply?.body).not.toContain("Ese caso prefiero");
    expect(result.botReply?.body).not.toContain("por aqui");
    expect(result.conversation.events.some((event) => event.eventType === "nlu_classified")).toBe(true);
    expect(result.conversation.events.some((event) => event.eventType === "human_requested")).toBe(false);
  });

  it("answers open hotel information after reset without generic fallback", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp({ from: "+34612345678", body: "reiniciar" }, store);
    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Buenos días, me gustaría saber más sobre el hotel" },
      store,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.humanRequested).toBe(false);
    expect(result.botReply?.body).toContain("Somos Muy Perros");
    expect(result.botReply?.body).toContain("servicios");
    expect(result.botReply?.body).not.toContain("Gracias, revisamos");
    expect(result.botReply?.body).not.toContain("Perdona, no te he entendido");
    expect(result.conversation.events.some((event) => event.eventType === "nlu_fast_path_skipped_quality_gate")).toBe(true);
    expect(result.conversation.events.some((event) => event.eventType === "nlu_knowledge_base_match")).toBe(true);
  });

  it("collects minimum details for informal weekend availability without promising a slot", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp({ from: "+34612345678", body: "reiniciar" }, store);
    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Buenos días, tenéis disponibilidad para este finde?" },
      store,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.humanRequested).toBe(false);
    expect(result.conversation.activeFlow).toBe("availabilityInquiry");
    expect(result.conversation.availabilityInquiry).toMatchObject({
      relativeDateRange: "este_fin_de_semana",
      missingFields: ["petName"],
      readyForTool: false,
    });
    expect(result.botReply?.body).toContain("este fin de semana");
    expect(result.botReply?.body).toContain("nombre de la mascota");
    expect(result.botReply?.body).toContain("No te confirmo plaza");
    expect(result.botReply?.body).not.toContain("Gracias, revisamos");
    expect(result.conversation.events.some((event) => event.eventType === "availability_inquiry_started")).toBe(true);
  });

  it("holds reservation intent for prior questions and resumes after answering a topic", async () => {
    const store = new MemoryConversationStore();

    await handleInboundWhatsApp({ from: "+34612345678", body: "reiniciar" }, store);
    const intro = await handleInboundWhatsApp(
      {
        from: "+34612345678",
        body: "Quiero hacer una reserva pero me gustaría saber antes algunas cosas",
      },
      store,
    );
    const hours = await handleInboundWhatsApp(
      { from: "+34612345678", body: "¿qué horarios tenéis?" },
      store,
    );

    expect(intro.conversation.heldReservationIntent).toBe(true);
    expect(intro.conversation.activeFlow).toBe("info");
    expect(intro.botReply?.body).toContain("después seguimos con la reserva");
    expect(hours.conversation.heldReservationIntent).toBe(true);
    expect(hours.botReply?.body).toContain("El horario de recepción");
    expect(hours.botReply?.body).toContain("Cuando quieras, seguimos con la reserva.");
    expect(hours.botReply?.body).not.toContain("Gracias, revisamos");
    expect(hours.conversation.events.some((event) => event.eventType === "info_answered_then_resume_reservation")).toBe(true);
  });

  it("preserves known client identity across reset and greets with the stored first name", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Laura Cliente",
        telefonoMovil: "+34 612 345 678",
        telefonoNormalizado: "34612345678",
        mascotas: ["Kira"],
        mascotasCount: 1,
        rowNumber: 2,
        sheetName: "CLIENTES",
      },
    ]);

    const first = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "hola" },
      store,
      directory,
    );
    const reset = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "reiniciar" },
      store,
      directory,
    );
    const greeting = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "hola buenas tardes" },
      store,
      directory,
    );

    expect(first.conversation.clientStatus).toBe("known");
    expect(reset.conversation.clientStatus).toBe("known");
    expect(greeting.conversation.clientStatus).toBe("known");
    expect(greeting.botReply?.body).toBe("Buenas tardes, Laura. ¿En qué podemos ayudarte?");
    expect(greeting.conversation.clientPets).toEqual(["Kira"]);
    expect(greeting.conversation.events.some((event) => event.eventType === "client_identity_preserved_after_reset")).toBe(true);
    expect(greeting.conversation.events.some((event) => event.eventType === "client_identity_lookup_cache_hit")).toBe(true);
  });

  it("answers a payment FAQ during an active reservation flow and resumes the missing field", async () => {
    const store = new MemoryConversationStore();

    const start = await handleInboundWhatsApp(
      { from: "+34612345678", body: "quiero reservar" },
      store,
      createStaticClientDirectory([]),
    );
    const payment = await handleInboundWhatsApp(
      { from: "+34612345678", body: "¿y el pago?" },
      store,
      createStaticClientDirectory([]),
    );

    expect(start.conversation.reservationFlow?.status).toBe("asking_client_kind");
    expect(payment.botReply?.body).toContain("El pago se hace a la llegada");
    expect(payment.botReply?.body).toContain("Seguimos con la reserva");
    expect(payment.botReply?.body).toContain("¿Ya eres cliente");
    expect(payment.botReply?.body).not.toContain("Perdona, no te he entendido bien");
    expect(payment.conversation.reservationFlow?.status).toBe("asking_client_kind");
    expect(
      payment.conversation.events.some(
        (event) =>
          event.eventType === "nlu_classified" &&
          (event.payload as { source?: string }).source === "faq_public_chat",
      ),
    ).toBe(true);
  });

  it("answers a payment FAQ after a confirmed reservation flow without trying to resume it", async () => {
    const store = new MemoryConversationStore();
    const created = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Hola" },
      store,
      createStaticClientDirectory([]),
    );
    const now = new Date().toISOString();
    await store.replaceConversation({
      ...created.conversation,
      reservationFlow: {
        flowId: "reservation_flow_test_confirmed",
        status: "confirmed",
        clientKind: "new",
        createdAt: now,
        updatedAt: now,
      },
      reservationId: "res_test_confirmed",
    });

    const payment = await handleInboundWhatsApp(
      { from: "+34612345678", body: "¿y el pago?" },
      store,
      createStaticClientDirectory([]),
    );

    expect(payment.botReply?.body).toContain("El pago se hace a la llegada");
    expect(payment.botReply?.body).not.toContain("Seguimos con la reserva");
    expect(payment.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("redacts DNI/NIF-like identifiers from stored inbound text and raw payload", async () => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      {
        from: "+34612345678",
        body: "Hola, mi DNI es 12345678Z y quiero información",
        rawPayload: {
          Body: "Hola, mi DNI es 12345678Z y quiero información",
          Extra: ["NIF 87654321X"],
        },
      },
      store,
    );
    const serialized = JSON.stringify(result.conversation);

    expect(result.inbound.body).toContain("[identificador oculto]");
    expect(result.inbound.body).not.toContain("12345678Z");
    expect(serialized).not.toContain("12345678Z");
    expect(serialized).not.toContain("87654321X");
  });

  it("redacts Spanish document identifiers without changing normal text", () => {
    expect(redactConversationSensitiveText("DNI 12345678Z")).toBe(
      "[identificador oculto]",
    );
    expect(redactConversationSensitiveText("Hola, quiero información")).toBe(
      "Hola, quiero información",
    );
  });

  it("routes live stay status questions to human review without inventing", async () => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body: "¿Ha comido mi perro?" },
      store,
    );

    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.humanRequested).toBe(true);
    expect(result.botReply?.body).toContain("respuesta real");
    expect(result.botReply?.body).toContain("persona del equipo");
    expect(result.conversation.events.some((event) => event.eventType === "human_requested")).toBe(true);
  });

  it("keeps known directory clients in bot mode by default", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([
      {
        nombre: "Cliente Habitual",
        telefonoMovil: "+34 612 345 678",
        telefonoNormalizado: "34612345678",
        rowNumber: 2,
        sheetName: "CLIENTES",
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "whatsapp:+34612345678", body: "Hola, quiero información" },
      store,
      directory,
    );

    expect(result.conversation.clientStatus).toBe("known");
    expect(result.conversation.mode).toBe("bot");
    expect(result.conversation.events.some((event) => event.eventType === "client_directory_match")).toBe(true);
  });

  it("asks for cancellation details without confirming destructive actions", async () => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Quiero cancelar mi reserva" },
      store,
    );

    expect(result.conversation.mode).toBe("bot");
    expect(result.botReply?.body).toContain("No encuentro una reserva futura");
    expect(result.botReply?.body).not.toContain("cancelada correctamente");
  });

  it("detects reception handoff language and deduplicates Twilio retries by MessageSid", async () => {
    const store = new MemoryConversationStore();

    const first = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34612345678",
        body: "Hola, quiero hablar con recepción por una urgencia",
        messageSid: "SM_DEDUPE_001",
      },
      store,
    );
    const retry = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34612345678",
        body: "Hola, quiero hablar con recepción por una urgencia",
        messageSid: "SM_DEDUPE_001",
      },
      store,
    );

    expect(first.conversation.mode).toBe("human");
    expect(retry.inbound.id).toBe(first.inbound.id);
    expect((await store.list())[0].messages).toHaveLength(2);
  });

  it("manual reply stores outbound human message and uses mock sender", async () => {
    const store = new MemoryConversationStore();
    const inbound = await handleInboundWhatsApp(
      { from: "+34612345678", body: "persona" },
      store,
    );
    const sentMessages: string[] = [];

    const result = await sendManualReply(
      inbound.conversation.id,
      "Te respondemos por aquí.",
      {
        async sendText(input) {
          sentMessages.push(input.body);
          return { ok: true, mode: "mock", sid: "mock_sid" };
        },
      },
      "admin",
      store,
    );

    expect(result.ok).toBe(true);
    expect(sentMessages).toEqual(["Te respondemos por aquí."]);
    expect(result.conversation.unreadCount).toBe(0);
    expect(result.conversation.messages.at(-1)?.senderType).toBe("human");
  });

  it("manual reply failure stores event without outbound human message", async () => {
    const store = new MemoryConversationStore();
    const inbound = await handleInboundWhatsApp(
      { from: "+34612345678", body: "persona" },
      store,
    );

    const result = await sendManualReply(
      inbound.conversation.id,
      "Hola",
      {
        async sendText() {
          return { ok: false, mode: "real", error: "boom" };
        },
      },
      "admin",
      store,
    );

    expect(result.ok).toBe(false);
    expect(result.conversation.events.some((event) => event.eventType === "manual_reply_failed")).toBe(true);
    expect(result.conversation.messages.filter((message) => message.senderType === "human")).toHaveLength(0);
  });

  it("records a manual video mock request without sending outbound media", async () => {
    const store = new MemoryConversationStore();
    const inbound = await handleInboundWhatsApp(
      { from: "+34612345678", body: "persona" },
      store,
    );

    const result = await requestManualVideoMock(inbound.conversation.id, "admin", store);
    const event = result.conversation.events.at(-1);

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("mock");
    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.messages.filter((message) => message.senderType === "human")).toHaveLength(0);
    expect(event?.eventType).toBe("media_attachment_mock_requested");
    expect(event?.payload).toMatchObject({
      mediaKind: "video",
      outbound: "not_sent",
      storage: "pending_object_storage",
    });
  });

  it("changes mode and marks read", async () => {
    const store = new MemoryConversationStore();
    const inbound = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Horario?" },
      store,
    );

    const human = await setConversationMode(inbound.conversation.id, "human", "admin", store);
    const read = await markConversationRead(inbound.conversation.id, store);

    expect(human.mode).toBe("human");
    expect(read.unreadCount).toBe(0);
    expect(read.humanRequested).toBe(false);
  });

  it("archives conversations without deleting history and restores them on demand", async () => {
    const store = new MemoryConversationStore();
    const inbound = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Hola, quiero información" },
      store,
    );

    const archived = await archiveConversation(inbound.conversation.id, "admin", "qa_cleanup", store);

    expect(archived.archivedAt).toBeDefined();
    expect(archived.messages.length).toBeGreaterThan(0);
    expect(archived.events.some((event) => event.eventType === "conversation_archived")).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.list({ mode: "archived" })).toHaveLength(1);
    expect(await store.list({ mode: "archived", query: "información" })).toHaveLength(1);

    const restored = await unarchiveConversation(inbound.conversation.id, "admin", store);

    expect(restored.archivedAt).toBeUndefined();
    expect(restored.events.some((event) => event.eventType === "conversation_unarchived")).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });

  it("reopens an archived conversation automatically when WhatsApp receives a new message", async () => {
    const store = new MemoryConversationStore();
    const inbound = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Hola, quiero información" },
      store,
    );
    await archiveConversation(inbound.conversation.id, "admin", "qa_cleanup", store);

    const reopened = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Hola de nuevo" },
      store,
    );

    expect(reopened.conversation.archivedAt).toBeUndefined();
    expect(reopened.conversation.messages.length).toBeGreaterThan(2);
    expect(
      reopened.conversation.events.some(
        (event) => event.eventType === "conversation_reopened_from_inbound",
      ),
    ).toBe(true);
  });

  it("keeps a price quote flow alive from exact dates to pet count", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([]);
    const deps = { now: () => new Date("2026-06-11T10:00:00.000Z") };

    const start = await handleInboundWhatsApp(
      {
        from: "+34612345678",
        body: "Hola! Querría saber el precio desde 30 junio hasta 8 julio",
      },
      store,
      directory,
      deps,
    );
    const quote = await handleInboundWhatsApp(
      { from: "+34612345678", body: "1 perro" },
      store,
      directory,
      deps,
    );

    expect(start.botReply?.body).toBe(
      "Claro. Para calcularlo del 30 de junio al 8 de julio necesito saber cuántos perros serían.",
    );
    expect(start.conversation.pendingPriceQuoteFlow).toMatchObject({
      status: "collecting_pet_count",
      checkInDate: "2026-06-30",
      checkOutDate: "2026-07-08",
    });
    expect(start.botReply?.body).not.toContain("Perdona, no te he entendido bien");
    expect(quote.botReply?.body).toBe(
      "Para 1 perro, del 30 de junio al 8 de julio serían 8 noches. El precio estimado es 240 €. Si quieres, puedo comprobar disponibilidad para esas fechas.",
    );
    expect(quote.conversation.pendingPriceQuoteFlow).toMatchObject({
      status: "quoted",
      petCount: 1,
      nights: 8,
      estimatedPrice: 240,
    });
    expect(quote.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("calculates a price quote directly when the user says mi perro with exact dates", async () => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      {
        from: "+34612345678",
        body: "quería saber que me cuesta deja a mi perro del 30 de junio al 8 de julio",
      },
      store,
      createStaticClientDirectory([]),
      { now: () => new Date("2026-06-11T10:00:00.000Z") },
    );

    expect(result.botReply?.body).toBe(
      "Para 1 perro, del 30 de junio al 8 de julio serían 8 noches. El precio estimado es 240 €. Si quieres, puedo comprobar disponibilidad para esas fechas.",
    );
    expect(result.conversation.pendingPriceQuoteFlow).toMatchObject({
      status: "quoted",
      petCount: 1,
      nights: 8,
      estimatedPrice: 240,
    });
    expect(result.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("treats a breed plus residencia as a stay request, not a pet name fallback", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([]);
    const deps = { now: () => new Date("2026-06-11T10:00:00.000Z") };

    const info = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Hola quiero información" },
      store,
      directory,
      deps,
    );
    const breed = await handleInboundWhatsApp(
      { from: "+34612345678", body: "Si una residencia para un Rottweiler" },
      store,
      directory,
      deps,
    );

    expect(info.botReply?.body).toContain("Te puedo ayudar con horarios");
    expect(breed.botReply?.body).toBe(
      "Perfecto, entiendo que sería una estancia para un Rottweiler. ¿Qué día sería la entrada y qué día la salida?",
    );
    expect(breed.conversation.pendingReservationContext).toMatchObject({
      petCount: 1,
      petBreeds: ["Rottweiler"],
      requestedFields: ["dates"],
    });
    expect(breed.conversation.petName).toBeUndefined();
    expect(breed.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("keeps the reservation context and asks for precision on vague checkout dates", async () => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([]);
    const deps = { now: () => new Date("2026-06-11T10:00:00.000Z") };

    await handleInboundWhatsApp(
      { from: "+34612345678", body: "Si una residencia para un Rottweiler" },
      store,
      directory,
      deps,
    );
    const vague = await handleInboundWhatsApp(
      {
        from: "+34612345678",
        body: "Si puede ser lo dejaría este sábado hasta principios de septiembre",
      },
      store,
      directory,
      deps,
    );

    expect(vague.botReply?.body).toBe(
      "Perfecto. Entiendo entrada este sábado. Para comprobar disponibilidad necesito que me confirmes el día exacto de salida a principios de septiembre y, si puedes, la hora aproximada de entrada y salida.",
    );
    expect(vague.conversation.pendingReservationContext).toMatchObject({
      checkInDate: "2026-06-13",
      vagueDateMention: "principios de septiembre",
      needsExactDate: true,
    });
    expect(vague.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it.each([
    "para un labrador",
    "para una golden",
    "para dos perros, un border collie y un mestizo",
    "tengo un pastor alemán",
    "tenéis sitio para un Rottweiler",
  ])("routes breed/stay phrase %s without fallback", async (body) => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body },
      store,
      createStaticClientDirectory([]),
      { now: () => new Date("2026-06-11T10:00:00.000Z") },
    );

    expect(result.botReply?.body).toContain("estancia");
    expect(result.botReply?.body).toContain("entrada");
    expect(result.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it.each([
    "hasta principios de septiembre",
    "hasta mediados de agosto",
    "hasta finales de julio",
    "la semana que viene",
    "unos días en agosto",
  ])("asks for precision for vague date phrase %s", async (body) => {
    const store = new MemoryConversationStore();
    const directory = createStaticClientDirectory([]);
    const deps = { now: () => new Date("2026-06-11T10:00:00.000Z") };

    await handleInboundWhatsApp(
      { from: "+34612345678", body: "residencia para un labrador" },
      store,
      directory,
      deps,
    );
    const result = await handleInboundWhatsApp(
      { from: "+34612345678", body },
      store,
      directory,
      deps,
    );

    expect(result.botReply?.body).toMatch(/día concreto|fechas concretas|confirmes/);
    expect(result.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("calculates price for two dogs with exact dates in one stay phrase", async () => {
    const store = new MemoryConversationStore();

    const result = await handleInboundWhatsApp(
      {
        from: "+34612345678",
        body: "cuánto me cuesta para dos perros del 1 al 5 de agosto",
      },
      store,
      createStaticClientDirectory([]),
      { now: () => new Date("2026-06-11T10:00:00.000Z") },
    );

    expect(result.botReply?.body).toBe(
      "Para 2 perros, del 1 de agosto al 5 de agosto serían 4 noches. El precio estimado es 180 €. Si quieres, puedo comprobar disponibilidad para esas fechas.",
    );
    expect(result.botReply?.body).not.toContain("Perdona, no te he entendido bien");
  });

  it("asks for a photo and manual review when bath reply mentions long hair", async () => {
    const store = new MemoryConversationStore();
    await store.seed([
      {
        id: "conv_bath_long",
        phoneE164: "+34612340001",
        phoneNormalized: "34612340001",
        sourceType: "whatsapp",
        mode: "bot",
        humanRequested: false,
        unreadCount: 0,
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:00:00.000Z",
        pendingBathOffer: {
          flowId: "bath_1",
          conversationId: "conv_bath_long",
          reservationId: "res_bath_1",
          status: "scheduled",
          petNames: ["PIPO"],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
        messages: [],
        events: [],
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "+34612340001", body: "sí, pero tiene pelo largo y nudos" },
      store,
    );

    expect(result.botReply?.body).toContain("necesitamos una foto");
    expect(result.conversation.pendingBathOffer?.status).toBe("awaiting_photo");
    expect(result.conversation.requiresManualReview).toBe(true);
    expect(result.conversation.events.some((event) => event.eventType === "bath_photo_requested")).toBe(true);
    expect(result.conversation.events.some((event) => event.eventType === "bath_manual_review")).toBe(true);
  });

  it("marks bath photo replies for reception review", async () => {
    const store = new MemoryConversationStore();
    await store.seed([
      {
        id: "conv_bath_photo",
        phoneE164: "+34612340002",
        phoneNormalized: "34612340002",
        sourceType: "whatsapp",
        mode: "bot",
        humanRequested: false,
        unreadCount: 0,
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:00:00.000Z",
        pendingBathOffer: {
          flowId: "bath_2",
          conversationId: "conv_bath_photo",
          reservationId: "res_bath_2",
          status: "awaiting_photo",
          petNames: ["PIPO"],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
        messages: [],
        events: [],
      },
    ]);

    const result = await handleInboundWhatsApp(
      {
        from: "+34612340002",
        body: "[WhatsApp con 1 adjunto]",
        rawPayload: { NumMedia: "1" },
      },
      store,
    );

    expect(result.botReply?.body).toBe(
      "Gracias. Lo revisa recepción y te confirmamos el precio por aquí.",
    );
    expect(result.conversation.pendingBathOffer?.status).toBe("manual_review");
    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.events.some((event) => event.eventType === "bath_photo_received")).toBe(true);
  });

  it("quotes short-hair bath prices by size and allows decline", async () => {
    const quoteStore = new MemoryConversationStore();
    await quoteStore.seed([
      {
        id: "conv_bath_quote",
        phoneE164: "+34612340003",
        phoneNormalized: "34612340003",
        sourceType: "whatsapp",
        mode: "bot",
        humanRequested: false,
        unreadCount: 0,
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:00:00.000Z",
        pendingBathOffer: {
          flowId: "bath_3",
          conversationId: "conv_bath_quote",
          reservationId: "res_bath_3",
          status: "scheduled",
          petNames: ["PIPO"],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
        messages: [],
        events: [],
      },
    ]);
    const quoted = await handleInboundWhatsApp(
      { from: "+34612340003", body: "pelo corto pequeño" },
      quoteStore,
    );

    expect(quoted.botReply?.body).toContain("15€");
    expect(quoted.conversation.pendingBathOffer?.status).toBe("quoted");
    expect(quoted.conversation.events.some((event) => event.eventType === "bath_price_quoted")).toBe(true);

    const declineStore = new MemoryConversationStore();
    await declineStore.seed([
      {
        id: "conv_bath_decline",
        phoneE164: "+34612340004",
        phoneNormalized: "34612340004",
        sourceType: "whatsapp",
        mode: "bot",
        humanRequested: false,
        unreadCount: 0,
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:00:00.000Z",
        pendingBathOffer: {
          flowId: "bath_4",
          conversationId: "conv_bath_decline",
          reservationId: "res_bath_4",
          status: "offered",
          petNames: ["PIPO"],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
        messages: [],
        events: [],
      },
    ]);
    const declined = await handleInboundWhatsApp(
      { from: "+34612340004", body: "no gracias" },
      declineStore,
    );

    expect(declined.botReply?.body).toBe("De acuerdo, no añadimos baño.");
    expect(declined.conversation.pendingBathOffer?.status).toBe("declined");
  });

  it("requests positive review only after positive post-stay feedback", async () => {
    const store = new MemoryConversationStore();
    await store.seed([
      {
        id: "conv_post_positive",
        phoneE164: "+34612340005",
        phoneNormalized: "34612340005",
        sourceType: "whatsapp",
        mode: "bot",
        humanRequested: false,
        unreadCount: 0,
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:00:00.000Z",
        pendingPostStayFollowup: {
          flowId: "post_1",
          conversationId: "conv_post_positive",
          reservationId: "res_post_1",
          status: "awaiting_feedback",
          petNames: ["PIPO"],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
        messages: [],
        events: [],
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "+34612340005", body: "todo perfecto" },
      store,
    );

    expect(result.botReply?.body).toContain("https://g.page/r/CbNKrJ36PLSeEBE/review");
    expect(result.conversation.pendingPostStayFollowup?.status).toBe("positive_review_requested");
    expect(result.conversation.events.some((event) => event.eventType === "post_stay_positive_review_requested")).toBe(true);
  });

  it("hands negative post-stay feedback to the team without asking for review", async () => {
    const store = new MemoryConversationStore();
    await store.seed([
      {
        id: "conv_post_negative",
        phoneE164: "+34612340006",
        phoneNormalized: "34612340006",
        sourceType: "whatsapp",
        mode: "bot",
        humanRequested: false,
        unreadCount: 0,
        createdAt: "2026-06-24T10:00:00.000Z",
        updatedAt: "2026-06-24T10:00:00.000Z",
        pendingPostStayFollowup: {
          flowId: "post_2",
          conversationId: "conv_post_negative",
          reservationId: "res_post_2",
          status: "awaiting_feedback",
          petNames: ["PIPO"],
          createdAt: "2026-06-24T10:00:00.000Z",
          updatedAt: "2026-06-24T10:00:00.000Z",
        },
        messages: [],
        events: [],
      },
    ]);

    const result = await handleInboundWhatsApp(
      { from: "+34612340006", body: "no, ha venido nervioso" },
      store,
    );

    expect(result.botReply?.body).toContain("Lo revisa el equipo");
    expect(result.botReply?.body).not.toContain("review");
    expect(result.conversation.pendingPostStayFollowup?.status).toBe("manual_review");
    expect(result.conversation.mode).toBe("human");
    expect(result.conversation.events.some((event) => event.eventType === "post_stay_negative_manual_review")).toBe(true);
  });

  it("does not reread the client directory once strong identity is already persisted", async () => {
    const store = new MemoryConversationStore();
    let clientDirectoryReads = 0;
    const directory = {
      async listClients() {
        clientDirectoryReads += 1;
        return {
          records: [
            {
              nombre: "Cliente Cache QA",
              telefonoMovil: "+34 612 340 777",
              telefonoNormalizado: "34612340777",
              rowNumber: 77,
              sheetName: "CLIENTES_QA",
            },
          ],
          warnings: [],
        };
      },
    };

    const first = await handleInboundWhatsApp(
      { from: "whatsapp:+34612340777", body: "hola", messageSid: "SM_CACHE_1" },
      store,
      directory,
    );
    const second = await handleInboundWhatsApp(
      { from: "whatsapp:+34612340777", body: "hola buenas tardes", messageSid: "SM_CACHE_2" },
      store,
      directory,
    );

    expect(first.conversation.clientStatus).toBe("known");
    expect(second.conversation.clientStatus).toBe("known");
    expect(clientDirectoryReads).toBe(1);
  });
});
