import pg from "pg";

export const REQUIRED_POSTGRES_BASE_CONVERSATION_SCHEMA = {
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
};

export const REQUIRED_POSTGRES_SCHEDULED_MESSAGES_SCHEMA = {
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

export const REQUIRED_POSTGRES_CONVERSATION_SCHEMA = {
  ...REQUIRED_POSTGRES_BASE_CONVERSATION_SCHEMA,
  ...REQUIRED_POSTGRES_SCHEDULED_MESSAGES_SCHEMA,
};

export const REQUIRED_TABLES = Object.keys(REQUIRED_POSTGRES_CONVERSATION_SCHEMA);
export const REQUIRED_BASE_TABLES = Object.keys(REQUIRED_POSTGRES_BASE_CONVERSATION_SCHEMA);
export const REQUIRED_SCHEDULED_MESSAGES_TABLES = Object.keys(
  REQUIRED_POSTGRES_SCHEDULED_MESSAGES_SCHEMA,
);

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

function collectColumnsByTable(rows) {
  const columnsByTable = new Map();
  for (const row of rows) {
    const existing = columnsByTable.get(row.table_name) ?? new Set();
    existing.add(row.column_name);
    columnsByTable.set(row.table_name, existing);
  }
  return columnsByTable;
}

function evaluateRequiredSchema(requiredSchema, columnsByTable) {
  const requiredTables = Object.keys(requiredSchema);
  const missingTables = requiredTables.filter((table) => !columnsByTable.has(table));
  const missingColumns = {};
  for (const [table, requiredColumns] of Object.entries(requiredSchema)) {
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
    ready: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missingTables,
    missingColumns,
  };
}

export function evaluatePostgresConversationSchemaRows(rows, scheduledMessagesDedupeReady) {
  const columnsByTable = collectColumnsByTable(rows);
  const conversation = evaluateRequiredSchema(
    REQUIRED_POSTGRES_BASE_CONVERSATION_SCHEMA,
    columnsByTable,
  );
  const scheduled = evaluateRequiredSchema(
    REQUIRED_POSTGRES_SCHEDULED_MESSAGES_SCHEMA,
    columnsByTable,
  );
  const dedupeReady = scheduled.ready && scheduledMessagesDedupeReady === true;
  const allMissingColumns = {
    ...conversation.missingColumns,
    ...scheduled.missingColumns,
  };

  return {
    ok: conversation.ready && scheduled.ready && dedupeReady,
    databaseReachable: true,
    postgresSchemaReady: conversation.ready && scheduled.ready && dedupeReady,
    conversationSchemaReady: conversation.ready,
    scheduledMessagesSchemaReady: scheduled.ready,
    scheduledMessagesDedupeReady: dedupeReady,
    missingTables: [...conversation.missingTables, ...scheduled.missingTables],
    missingColumns: allMissingColumns,
    missingScheduledTables: scheduled.missingTables,
    missingScheduledColumns: scheduled.missingColumns,
  };
}

async function checkScheduledMessagesDedupe(pool) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'hotel_scheduled_messages'
         AND indexdef ILIKE '%UNIQUE%'
         AND indexdef ILIKE '%dedupe_key%'
     ) AS ready`,
  );
  return result.rows[0]?.ready === true;
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
  const scheduledMessagesDedupeReady = await checkScheduledMessagesDedupe(pool);
  return evaluatePostgresConversationSchemaRows(
    columns.rows,
    scheduledMessagesDedupeReady,
  );
}
