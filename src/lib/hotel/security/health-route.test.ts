import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("health route", () => {
  const previousEnv = { ...process.env };

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
    process.env.HOTEL_PERSISTENCE_PROVIDER = "postgres";
    process.env.HOTEL_CONVERSATIONS_STORE_PROVIDER = "google_sheets";
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
    expect(json.persistence.conversationStoreProvider).toBe("google_sheets");
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
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("password@example");
    expect(serialized).not.toContain("sheet_secret_like_id");
    expect(serialized).not.toContain("private-secret-key");
  });
});
