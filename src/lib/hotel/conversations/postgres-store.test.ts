import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "./types";

const rows = new Map<string, ConversationRecord>();
const queries: string[] = [];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resetMemoryDb(): void {
  rows.clear();
  queries.length = 0;
}

function query(sql: string, params: unknown[] = []) {
  queries.push(sql);
  const compact = sql.replace(/\s+/g, " ").trim();

  if (
    compact === "BEGIN" ||
    compact === "COMMIT" ||
    compact === "ROLLBACK" ||
    compact.startsWith("DELETE FROM hotel_conversation")
  ) {
    if (compact === "DELETE FROM hotel_conversations") {
      rows.clear();
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (compact.startsWith("SELECT payload FROM hotel_conversations ORDER BY updated_at DESC")) {
    return Promise.resolve({
      rows: Array.from(rows.values())
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((payload) => ({ payload: clone(payload) })),
      rowCount: rows.size,
    });
  }

  if (compact.startsWith("SELECT payload FROM hotel_conversations WHERE id = $1")) {
    const payload = rows.get(String(params[0]));
    return Promise.resolve({
      rows: payload ? [{ payload: clone(payload) }] : [],
      rowCount: payload ? 1 : 0,
    });
  }

  if (compact.startsWith("SELECT payload FROM hotel_conversations WHERE phone_normalized = $1")) {
    const payload = Array.from(rows.values())
      .filter((record) => record.phoneNormalized === params[0])
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return Promise.resolve({
      rows: payload ? [{ payload: clone(payload) }] : [],
      rowCount: payload ? 1 : 0,
    });
  }

  if (compact.startsWith("INSERT INTO hotel_conversations")) {
    rows.set(String(params[0]), JSON.parse(String(params[10])) as ConversationRecord);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  if (
    compact.startsWith("INSERT INTO hotel_conversation_messages") ||
    compact.startsWith("INSERT INTO hotel_conversation_events")
  ) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  throw new Error(`Unexpected SQL in postgres-store test: ${compact}`);
}

vi.mock("pg", () => ({
  Pool: vi.fn(function Pool() {
    return {
      connect: vi.fn().mockResolvedValue({
        query,
        release: vi.fn(),
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

describe("PostgresConversationStore", () => {
  beforeEach(() => {
    resetMemoryDb();
    process.env.DATABASE_URL = "postgres://test:test@example.test/hotel";
  });

  afterEach(async () => {
    const { resetPostgresConversationStoreForTests } = await import("./postgres-store");
    const { resetConversationStoreForTests } = await import("./file-store");
    resetConversationStoreForTests();
    resetPostgresConversationStoreForTests();
    delete process.env.DATABASE_URL;
    delete process.env.HOTEL_CONVERSATIONS_STORE;
  });

  it("fails clearly when postgres is selected without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const { PostgresConversationStore } = await import("./postgres-store");

    await expect(new PostgresConversationStore().load()).rejects.toThrow(
      "DATABASE_URL is required",
    );
  });

  it("is selected by HOTEL_CONVERSATIONS_STORE=postgres", async () => {
    process.env.HOTEL_CONVERSATIONS_STORE = "postgres";
    const { getConversationStore } = await import("./file-store");
    const { PostgresConversationStore } = await import("./postgres-store");

    expect(getConversationStore()).toBeInstanceOf(PostgresConversationStore);
  });

  it("stores conversations, messages, pending state and archive changes in Postgres", async () => {
    const { PostgresConversationStore } = await import("./postgres-store");
    const store = new PostgresConversationStore();

    await store.upsertConversation({
      id: "conv_1",
      phoneE164: "whatsapp:+34600111222",
      phoneNormalized: "34600111222",
      displayName: "Pau",
      customerName: "Pau",
      channel: "whatsapp",
      sourceType: "whatsapp",
      status: "open",
      priority: "normal",
      tags: [],
      mode: "bot",
      humanRequested: false,
      requiresManualReview: false,
      unreadCount: 0,
      createdAt: "2026-06-15T08:00:00.000Z",
      updatedAt: "2026-06-15T08:00:00.000Z",
      pendingPriceQuoteFlow: {
        startedAt: "2026-06-15T08:00:00.000Z",
        checkIn: "2026-06-30",
        checkOut: "2026-07-08",
      },
    });

    const inbound = await store.addMessage({
      id: "msg_1",
      conversationId: "conv_1",
      direction: "inbound",
      senderType: "user",
      transport: "whatsapp",
      body: "1 perro",
      externalMessageSid: "SM_DUPLICATE",
      createdAt: "2026-06-15T08:01:00.000Z",
    });
    const duplicate = await store.addMessage({
      ...inbound,
      id: "msg_2",
      body: "duplicado",
    });
    await store.addMessage({
      id: "msg_3",
      conversationId: "conv_1",
      direction: "outbound",
      senderType: "bot",
      transport: "whatsapp",
      body: "Serian 8 noches: 240 EUR.",
      createdAt: "2026-06-15T08:02:00.000Z",
    });

    const record = await store.getByPhone("34600111222");
    expect(duplicate.id).toBe("msg_1");
    expect(record?.messages).toHaveLength(2);
    expect(record?.pendingPriceQuoteFlow).toEqual(
      expect.objectContaining({
        checkIn: "2026-06-30",
        checkOut: "2026-07-08",
      }),
    );
    expect(record?.lastMessagePreview).toBe("Serian 8 noches: 240 EUR.");
    expect(record?.updatedAt).toBe("2026-06-15T08:02:00.000Z");

    await store.replaceConversation({
      ...record!,
      archivedAt: "2026-06-15T08:03:00.000Z",
      archivedBy: "admin",
      updatedAt: "2026-06-15T08:03:00.000Z",
    });
    expect((await store.list({ mode: "archived" }))[0]?.archivedAt).toBe(
      "2026-06-15T08:03:00.000Z",
    );

    await store.replaceConversation({
      ...(await store.getById("conv_1"))!,
      archivedAt: undefined,
      archivedBy: undefined,
      updatedAt: "2026-06-15T08:04:00.000Z",
    });
    expect(await store.list({ mode: "archived" })).toHaveLength(0);
    expect(queries.some((sql) => sql.includes("hotel_conversation_messages"))).toBe(true);
    expect(queries.some((sql) => sql.includes("google"))).toBe(false);
  });

  it("supports critical WhatsApp reservation and reset flows through Postgres state", async () => {
    const { PostgresConversationStore } = await import("./postgres-store");
    const { handleInboundWhatsApp } = await import("./service");
    const { createStaticClientDirectory } = await import("@/lib/hotel/clients");
    const store = new PostgresConversationStore();
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

    const greeting = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "hola", messageSid: "SM_PG_HELLO" },
      store,
      directory,
    );
    const reservation = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "quiero reservar", messageSid: "SM_PG_BOOK" },
      store,
      directory,
    );
    const reloaded = await store.getById(reservation.conversation.id);

    expect(greeting.botReply?.body).toContain("Pau");
    expect(reservation.botReply?.body).not.toContain(
      "no puedo consultar correctamente la conversación",
    );
    expect(reservation.conversation.reservationFlow).toEqual(
      expect.objectContaining({
        clientKind: "habitual",
        status: "collecting_pet",
      }),
    );
    expect(reloaded?.reservationFlow?.status).toBe("collecting_pet");
    expect(reloaded?.messages.some((message) => message.body === "quiero reservar")).toBe(true);
    expect(reloaded?.messages.some((message) => message.direction === "outbound")).toBe(true);

    const reset = await handleInboundWhatsApp(
      { from: "whatsapp:+34600009991", body: "reiniciar", messageSid: "SM_PG_RESET" },
      store,
      directory,
    );
    const resetRecord = await store.getById(reservation.conversation.id);

    expect(reset.botReply?.body).toBe("Reiniciado.");
    expect(resetRecord?.reservationFlow).toBeUndefined();
    expect(resetRecord?.pendingReservationProposal).toBeUndefined();
    expect(resetRecord?.pendingReservationModificationFlow).toBeUndefined();
    expect(resetRecord?.pendingReservationCancellationFlow).toBeUndefined();
  });
});
