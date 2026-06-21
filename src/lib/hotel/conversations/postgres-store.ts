import { Pool, type PoolClient } from "pg";
import type {
  Conversation,
  ConversationEvent,
  ConversationListFilters,
  ConversationRecord,
  ConversationSnapshot,
  Message,
} from "./types";
import {
  filterConversationRecords,
  type ConversationStore,
} from "./store";

let poolSingleton: Pool | undefined;

function getPool(): Pool {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required when the conversation store is postgres");
  }

  poolSingleton ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? "5", 10),
  });

  return poolSingleton;
}

function safePostgresErrorPayload(error: unknown): Record<string, string | undefined> {
  const payload = error && typeof error === "object" ? (error as Record<string, unknown>) : {};

  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    safeErrorCode: typeof payload.code === "string" ? payload.code.slice(0, 80) : undefined,
    table: typeof payload.table === "string" ? payload.table.slice(0, 120) : undefined,
    column: typeof payload.column === "string" ? payload.column.slice(0, 120) : undefined,
    constraint:
      typeof payload.constraint === "string" ? payload.constraint.slice(0, 120) : undefined,
  };
}

function logPostgresStoreFailure(event: string, error: unknown): void {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  const classifiedEvent =
    code === "42P01" || code === "42703" ? "postgres_schema_missing" : event;

  console.error(classifiedEvent, safePostgresErrorPayload(error));
}

async function runPostgresStoreOperation<T>(
  event: string,
  callback: () => Promise<T>,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    logPostgresStoreFailure(event, error);
    throw error;
  }
}

async function withClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

function normalizeRecord(value: unknown): ConversationRecord {
  const record = value as ConversationRecord;
  return {
    ...record,
    messages: Array.isArray(record.messages) ? record.messages : [],
    events: Array.isArray(record.events) ? record.events : [],
  };
}

async function writeRecord(client: PoolClient, record: ConversationRecord): Promise<void> {
  await client.query(
    `INSERT INTO hotel_conversations (
      id, phone_e164, phone_normalized, display_name, customer_name, mode,
      status, unread_count, created_at, updated_at, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      phone_e164 = EXCLUDED.phone_e164,
      phone_normalized = EXCLUDED.phone_normalized,
      display_name = EXCLUDED.display_name,
      customer_name = EXCLUDED.customer_name,
      mode = EXCLUDED.mode,
      status = EXCLUDED.status,
      unread_count = EXCLUDED.unread_count,
      updated_at = EXCLUDED.updated_at,
      payload = EXCLUDED.payload`,
    [
      record.id,
      record.phoneE164,
      record.phoneNormalized,
      record.displayName ?? null,
      record.customerName ?? null,
      record.mode,
      record.status ?? "open",
      record.unreadCount,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record),
    ],
  );

  for (const message of record.messages) {
    await client.query(
      `INSERT INTO hotel_conversation_messages (
        id, conversation_id, direction, sender_type, external_message_sid, created_at, payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [
        message.id,
        message.conversationId,
        message.direction,
        message.senderType,
        message.externalMessageSid ?? null,
        message.createdAt,
        JSON.stringify(message),
      ],
    );
  }

  for (const event of record.events) {
    await client.query(
      `INSERT INTO hotel_conversation_events (
        id, conversation_id, event_type, created_at, payload
      ) VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [
        event.id,
        event.conversationId,
        event.eventType,
        event.createdAt,
        JSON.stringify(event),
      ],
    );
  }
}

export class PostgresConversationStore implements ConversationStore {
  async load(): Promise<ConversationSnapshot> {
    return runPostgresStoreOperation("postgres_store_connect_failed", () => withClient(async (client) => {
      const result = await client.query<{ payload: ConversationRecord }>(
        "SELECT payload FROM hotel_conversations ORDER BY updated_at DESC",
      );

      return {
        conversations: result.rows.map((row) => normalizeRecord(row.payload)),
        updatedAt: new Date().toISOString(),
      };
    }));
  }

  async save(snapshot: ConversationSnapshot): Promise<void> {
    await this.seed(snapshot.conversations);
  }

  async list(filters?: ConversationListFilters): Promise<ConversationRecord[]> {
    const snapshot = await this.load();
    return filterConversationRecords(snapshot.conversations, filters);
  }

  async getById(id: string): Promise<ConversationRecord | undefined> {
    return runPostgresStoreOperation("postgres_store_connect_failed", () => withClient(async (client) => {
      const result = await client.query<{ payload: ConversationRecord }>(
        "SELECT payload FROM hotel_conversations WHERE id = $1",
        [id],
      );
      return result.rows[0] ? normalizeRecord(result.rows[0].payload) : undefined;
    }));
  }

  async getByPhone(phoneNormalized: string): Promise<ConversationRecord | undefined> {
    return runPostgresStoreOperation("postgres_store_connect_failed", () => withClient(async (client) => {
      const result = await client.query<{ payload: ConversationRecord }>(
        "SELECT payload FROM hotel_conversations WHERE phone_normalized = $1 ORDER BY updated_at DESC LIMIT 1",
        [phoneNormalized],
      );
      return result.rows[0] ? normalizeRecord(result.rows[0].payload) : undefined;
    }));
  }

  async upsertConversation(conversation: Conversation): Promise<ConversationRecord> {
    const existing = await this.getById(conversation.id);
    const record: ConversationRecord = {
      ...existing,
      ...conversation,
      messages: existing?.messages ?? [],
      events: existing?.events ?? [],
    };
    await runPostgresStoreOperation("postgres_state_save_failed", () =>
      withClient((client) => writeRecord(client, record)),
    );
    return record;
  }

  async addMessage(message: Message): Promise<Message> {
    const record = await this.getById(message.conversationId);
    if (!record) {
      throw new Error(`Conversation ${message.conversationId} not found`);
    }

    if (message.externalMessageSid) {
      const duplicate = record.messages.find(
        (item) => item.externalMessageSid === message.externalMessageSid,
      );
      if (duplicate) {
        return duplicate;
      }
    }

    const next: ConversationRecord = {
      ...record,
      messages: [...record.messages, message],
      updatedAt: message.createdAt,
      lastMessagePreview: message.body.slice(0, 180),
      lastInboundAt: message.direction === "inbound" ? message.createdAt : record.lastInboundAt,
      lastOutboundAt: message.direction === "outbound" ? message.createdAt : record.lastOutboundAt,
      unreadCount: message.direction === "inbound" ? record.unreadCount + 1 : record.unreadCount,
    };
    await runPostgresStoreOperation("postgres_message_save_failed", () =>
      withClient((client) => writeRecord(client, next)),
    );
    return message;
  }

  async addEvent(event: ConversationEvent): Promise<ConversationEvent> {
    const record = await this.getById(event.conversationId);
    if (!record) {
      throw new Error(`Conversation ${event.conversationId} not found`);
    }

    await runPostgresStoreOperation("postgres_state_save_failed", () => withClient((client) =>
      writeRecord(client, {
        ...record,
        events: [...record.events, event],
        updatedAt: event.createdAt,
      }),
    ));
    return event;
  }

  async replaceConversation(record: ConversationRecord): Promise<ConversationRecord> {
    await runPostgresStoreOperation("postgres_state_save_failed", () =>
      withClient((client) => writeRecord(client, normalizeRecord(record))),
    );
    return record;
  }

  async seed(records: ConversationRecord[]): Promise<ConversationSnapshot> {
    await runPostgresStoreOperation("postgres_state_save_failed", () => withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("DELETE FROM hotel_conversation_events");
        await client.query("DELETE FROM hotel_conversation_messages");
        await client.query("DELETE FROM hotel_conversations");
        for (const record of records) {
          await writeRecord(client, normalizeRecord(record));
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }));

    return {
      conversations: records,
      updatedAt: new Date().toISOString(),
    };
  }
}

export function resetPostgresConversationStoreForTests(): void {
  if (process.env.NODE_ENV === "test") {
    poolSingleton?.end().catch(() => undefined);
    poolSingleton = undefined;
  }
}
