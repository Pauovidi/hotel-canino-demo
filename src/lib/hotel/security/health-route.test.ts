import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

const postgresReadinessMock = vi.hoisted(() => ({
  checkPostgresConversationSchema: vi.fn(),
}));

vi.mock("@/lib/hotel/conversations/postgres-readiness", () => ({
  checkPostgresConversationSchema: postgresReadinessMock.checkPostgresConversationSchema,
}));

describe("health route", () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    postgresReadinessMock.checkPostgresConversationSchema.mockReset();
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it("returns app, Twilio and persistence status without secrets", async () => {
    process.env.NODE_ENV = "production";
    process.env.HOTEL_CONVERSATIONS_MOCK_TWILIO = "false";
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "super-secret-token";
    process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+34600111222";
    process.env.TWILIO_WHATSAPP_PROVIDER_MODE = "real";
    process.env.DATABASE_URL = "postgres://user:password@example.test/db";
    process.env.HOTEL_RUNTIME_TARGET = "easypanel";
    process.env.HOTEL_PERSISTENCE_PROVIDER = "postgres";
    process.env.HOTEL_CONVERSATIONS_STORE_PROVIDER = "google_sheets";
    process.env.HOTEL_SHEETS_WRITE_ENABLED = "false";
    process.env.HOTEL_SHEETS_DRY_RUN = "true";
    process.env.HOTEL_LLM_NLU_ENABLED = "false";
    process.env.HOTEL_LLM_NLU_SHADOW = "true";
    process.env.HOTEL_LLM_NLU_DECISION_MODE = "shadow";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    process.env.HOTEL_CONVERSATIONS_SHEET_NAME = "CONVERSATIONS";
    process.env.HOTEL_CLIENTS_SHEET_NAME = "CLIENTES";
    process.env.HOTEL_CLIENTS_CACHE_TTL_MS = "12345";
    process.env.HOTEL_GOOGLE_SHEETS_SPREADSHEET_ID = "sheet_secret_like_id";
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "service@example.test";
    process.env.GOOGLE_PRIVATE_KEY = "private-secret-key";

    const response = await GET();
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.whatsapp).toEqual(
      expect.objectContaining({
        provider: "twilio",
        mode: "real",
        mock: false,
      }),
    );
    expect(json.persistence.provider).toBe("postgres");
    expect(json.persistence.runtimeTarget).toBe("easypanel");
    expect(json.persistence.ready).toBe(true);
    expect(json.persistence.conversationStoreProvider).toBe("google_sheets");
    expect(json.runtimeSafety.sheets).toEqual({
      writeEnabled: false,
      dryRun: true,
    });
    expect(json.runtimeSafety.llmNlu).toEqual(
      expect.objectContaining({
        enabled: false,
        shadow: true,
        decisionMode: "shadow",
        assistiveSafe: false,
        openaiConfigured: false,
        modelConfigured: false,
      }),
    );
    expect(json.conversationStore).toEqual(
      expect.objectContaining({
        provider: "google_sheets",
        sheetName: "CONVERSATIONS",
        configured: true,
        googleSheetsConfigured: true,
        hasSpreadsheetId: true,
        hasCredentialSource: true,
      }),
    );
    expect(json.clients).toEqual(
      expect.objectContaining({
        provider: "google_sheets_client_directory",
        sheetName: "CLIENTES",
        configured: true,
        googleSheetsConfigured: true,
        hasSpreadsheetId: true,
        hasCredentialSource: true,
        cacheTtlMs: 12345,
      }),
    );
    expect(json.reservationStore).toEqual(
      expect.objectContaining({
        sheetName: "RESERVATION_RECORDS",
        googleSheetsConfigured: true,
        hasSpreadsheetId: true,
        hasCredentialSource: true,
      }),
    );
    expect(json.entryLogStore).toEqual(
      expect.objectContaining({
        sheetName: "REGISTRO_ENTRADA_STATE",
        googleSheetsConfigured: true,
        hasSpreadsheetId: true,
        hasCredentialSource: true,
        derivedFrom: "reservationStore",
      }),
    );
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("password@example");
    expect(serialized).not.toContain("sheet_secret_like_id");
    expect(serialized).not.toContain("private-secret-key");
  });

  it("reports postgres conversation readiness without exposing DATABASE_URL", async () => {
    process.env.NODE_ENV = "production";
    process.env.HOTEL_RUNTIME_TARGET = "easypanel";
    process.env.HOTEL_CONVERSATIONS_STORE = "postgres";
    process.env.HOTEL_SHEETS_WRITE_ENABLED = "false";
    process.env.HOTEL_SHEETS_DRY_RUN = "true";
    process.env.HOTEL_LLM_NLU_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;
    process.env.DATABASE_URL = "postgres://user:password@example.test/db";
    postgresReadinessMock.checkPostgresConversationSchema.mockResolvedValue({
      databaseUrlConfigured: true,
      databaseReachable: true,
      postgresSchemaReady: true,
      missingTables: [],
      missingColumns: {},
    });

    const response = await GET();
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json.persistence).toEqual(
      expect.objectContaining({
        runtimeTarget: "easypanel",
        conversationStoreProvider: "postgres",
        databaseUrlConfigured: true,
        databaseReachable: true,
        postgresSchemaReady: true,
        ready: true,
      }),
    );
    expect(json.conversationStore).toEqual(
      expect.objectContaining({
        provider: "postgres",
        configured: true,
      }),
    );
    expect(json.runtimeSafety.sheets).toEqual({
      writeEnabled: false,
      dryRun: true,
    });
    expect(json.runtimeSafety.llmNlu.enabled).toBe(false);
    expect(json.runtimeSafety.llmNlu.openaiConfigured).toBe(false);
    expect(serialized).not.toContain("password@example");
  });

  it("reports missing OpenAI configuration for enabled LLM NLU without exposing keys", async () => {
    process.env.NODE_ENV = "production";
    process.env.HOTEL_LLM_NLU_ENABLED = "true";
    process.env.HOTEL_LLM_NLU_DECISION_MODE = "assistive_safe";
    process.env.HOTEL_LLM_NLU_SHADOW = "false";
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_MODEL = "gpt-test";

    const response = await GET();
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json.runtimeSafety.llmNlu).toEqual(
      expect.objectContaining({
        enabled: true,
        shadow: false,
        decisionMode: "assistive_safe",
        assistiveSafe: true,
        openaiConfigured: false,
        modelConfigured: true,
      }),
    );
    expect(json.runtimeSafety.llmNlu.warning).toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("gpt-test-secret");
  });

  it("marks postgres persistence not ready when required tables are missing", async () => {
    process.env.NODE_ENV = "production";
    process.env.HOTEL_RUNTIME_TARGET = "easypanel";
    process.env.HOTEL_CONVERSATIONS_STORE = "postgres";
    process.env.DATABASE_URL = "postgres://user:password@example.test/db";
    postgresReadinessMock.checkPostgresConversationSchema.mockResolvedValue({
      databaseUrlConfigured: true,
      databaseReachable: true,
      postgresSchemaReady: false,
      missingTables: ["hotel_conversations"],
      missingColumns: {},
    });

    const response = await GET();
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json.persistence).toEqual(
      expect.objectContaining({
        conversationStoreProvider: "postgres",
        databaseUrlConfigured: true,
        databaseReachable: true,
        postgresSchemaReady: false,
        missingTables: ["hotel_conversations"],
        ready: false,
      }),
    );
    expect(serialized).not.toContain("password@example");
  });
});
