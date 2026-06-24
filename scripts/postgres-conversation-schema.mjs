import pg from "pg";

export const REQUIRED_POSTGRES_CONVERSATION_SCHEMA = {
  hotel_conversations: [
    "id",
    "phone_e164",
    "phone_normalized",
    "display_name",
    "customer_name",
    "mode",
    "status",
    "unread_count",
    "created_at",
    "updated_at",
    "payload",
  ],
  hotel_conversation_messages: [
    "id",
    "conversation_id",
    "direction",
    "sender_type",
    "external_message_sid",
    "created_at",
    "payload",
  ],
  hotel_conversation_events: [
    "id",
    "conversation_id",
    "event_type",
    "created_at",
    "payload",
  ],
  hotel_scheduled_messages: [
    "id",
    "type",
    "conversation_id",
    "reservation_id",
    "channel",
    "external_user_id",
    "phone_hash",
    "payload",
    "scheduled_at",
    "status",
    "attempts",
    "max_attempts",
    "last_error_code",
    "dedupe_key",
    "dry_run",
    "created_at",
    "updated_at",
    "sent_at",
  ],
};

export const REQUIRED_TABLES = Object.keys(REQUIRED_POSTGRES_CONVERSATION_SCHEMA);

export function createPoolFromEnv() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required.");
  }

  const { Pool } = pg;
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? "5", 10),
  });
}

export async function checkPostgresConversationSchema(pool) {
  await pool.query("SELECT 1");
  const columns = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES],
  );
  const columnsByTable = new Map();
  for (const row of columns.rows) {
    const existing = columnsByTable.get(row.table_name) ?? new Set();
    existing.add(row.column_name);
    columnsByTable.set(row.table_name, existing);
  }

  const missingTables = REQUIRED_TABLES.filter((table) => !columnsByTable.has(table));
  const missingColumns = {};
  for (const [table, requiredColumns] of Object.entries(
    REQUIRED_POSTGRES_CONVERSATION_SCHEMA,
  )) {
    if (missingTables.includes(table)) {
      continue;
    }

    const existingColumns = columnsByTable.get(table) ?? new Set();
    const missing = requiredColumns.filter((column) => !existingColumns.has(column));
    if (missing.length > 0) {
      missingColumns[table] = missing;
    }
  }

  return {
    ok: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    databaseReachable: true,
    postgresSchemaReady: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missingTables,
    missingColumns,
  };
}
