import { Pool } from "pg";

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
} as const;

export interface PostgresConversationSchemaHealth {
  databaseUrlConfigured: boolean;
  databaseReachable: boolean;
  postgresSchemaReady: boolean;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  safeErrorCode?: string;
  safeErrorName?: string;
}

const REQUIRED_TABLES = Object.keys(REQUIRED_POSTGRES_CONVERSATION_SCHEMA);

function safeErrorPayload(error: unknown): Pick<
  PostgresConversationSchemaHealth,
  "safeErrorCode" | "safeErrorName"
> {
  return {
    safeErrorName: error instanceof Error ? error.name : "UnknownError",
    safeErrorCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code).slice(0, 80)
        : undefined,
  };
}

export async function checkPostgresConversationSchema(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostgresConversationSchemaHealth> {
  if (!env.DATABASE_URL?.trim()) {
    return {
      databaseUrlConfigured: false,
      databaseReachable: false,
      postgresSchemaReady: false,
      missingTables: REQUIRED_TABLES,
      missingColumns: {},
    };
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: Number.parseInt(
      env.POSTGRES_HEALTH_TIMEOUT_MS ?? env.DATABASE_HEALTH_TIMEOUT_MS ?? "3000",
      10,
    ),
  });

  try {
    await pool.query("SELECT 1");
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    const columnsByTable = new Map<string, Set<string>>();
    for (const row of columns.rows) {
      const existing = columnsByTable.get(row.table_name) ?? new Set<string>();
      existing.add(row.column_name);
      columnsByTable.set(row.table_name, existing);
    }

    const missingTables = REQUIRED_TABLES.filter((table) => !columnsByTable.has(table));
    const missingColumns: Record<string, string[]> = {};
    for (const [table, requiredColumns] of Object.entries(
      REQUIRED_POSTGRES_CONVERSATION_SCHEMA,
    )) {
      if (missingTables.includes(table)) {
        continue;
      }

      const existingColumns = columnsByTable.get(table) ?? new Set<string>();
      const missing = requiredColumns.filter((column) => !existingColumns.has(column));
      if (missing.length > 0) {
        missingColumns[table] = missing;
      }
    }

    return {
      databaseUrlConfigured: true,
      databaseReachable: true,
      postgresSchemaReady:
        missingTables.length === 0 && Object.keys(missingColumns).length === 0,
      missingTables,
      missingColumns,
    };
  } catch (error) {
    return {
      databaseUrlConfigured: true,
      databaseReachable: false,
      postgresSchemaReady: false,
      missingTables: [],
      missingColumns: {},
      ...safeErrorPayload(error),
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
