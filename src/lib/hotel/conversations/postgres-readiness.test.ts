import { beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => ({
  rows: [] as Array<{ table_name: string; column_name: string }>,
  error: undefined as Error | undefined,
}));

vi.mock("pg", () => ({
  Pool: vi.fn(function Pool() {
    return {
      query: vi.fn((sql: string) => {
        if (pgMock.error) {
          return Promise.reject(pgMock.error);
        }

        if (sql.includes("information_schema.columns")) {
          return Promise.resolve({ rows: pgMock.rows, rowCount: pgMock.rows.length });
        }

        return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

describe("postgres conversation schema readiness", () => {
  beforeEach(() => {
    pgMock.rows = [];
    pgMock.error = undefined;
  });

  it("fails clearly when DATABASE_URL is missing", async () => {
    const { checkPostgresConversationSchema } = await import("./postgres-readiness");

    const health = await checkPostgresConversationSchema({} as NodeJS.ProcessEnv);

    expect(health).toEqual(
      expect.objectContaining({
        databaseUrlConfigured: false,
        databaseReachable: false,
        postgresSchemaReady: false,
      }),
    );
    expect(health.missingTables).toContain("hotel_conversations");
  });

  it("reports schema ready when every required table and column exists", async () => {
    const {
      REQUIRED_POSTGRES_CONVERSATION_SCHEMA,
      checkPostgresConversationSchema,
    } = await import("./postgres-readiness");
    pgMock.rows = Object.entries(REQUIRED_POSTGRES_CONVERSATION_SCHEMA).flatMap(
      ([table_name, columns]) => columns.map((column_name) => ({ table_name, column_name })),
    );

    const health = await checkPostgresConversationSchema({
      DATABASE_URL: "postgres://example",
    } as NodeJS.ProcessEnv);

    expect(health).toEqual(
      expect.objectContaining({
        databaseUrlConfigured: true,
        databaseReachable: true,
        postgresSchemaReady: true,
        missingTables: [],
        missingColumns: {},
      }),
    );
  });

  it("reports missing tables and columns without exposing connection details", async () => {
    const { checkPostgresConversationSchema } = await import("./postgres-readiness");
    pgMock.rows = [
      { table_name: "hotel_conversations", column_name: "id" },
      { table_name: "hotel_conversations", column_name: "payload" },
    ];

    const health = await checkPostgresConversationSchema({
      DATABASE_URL: "postgres://user:password@example.test/db",
    } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(health);

    expect(health.databaseReachable).toBe(true);
    expect(health.postgresSchemaReady).toBe(false);
    expect(health.missingTables).toEqual([
      "hotel_conversation_messages",
      "hotel_conversation_events",
    ]);
    expect(health.missingColumns.hotel_conversations).toContain("phone_normalized");
    expect(serialized).not.toContain("password@example");
  });

  it("reports unreachable databases with a safe error code", async () => {
    const { checkPostgresConversationSchema } = await import("./postgres-readiness");
    pgMock.error = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });

    const health = await checkPostgresConversationSchema({
      DATABASE_URL: "postgres://example",
    } as NodeJS.ProcessEnv);

    expect(health).toEqual(
      expect.objectContaining({
        databaseUrlConfigured: true,
        databaseReachable: false,
        postgresSchemaReady: false,
        safeErrorCode: "ECONNREFUSED",
      }),
    );
  });
});
