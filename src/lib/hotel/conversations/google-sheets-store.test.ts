import { describe, expect, it } from "vitest";
import { GoogleSheetsConversationStore } from "./google-sheets-store";
import type { Conversation } from "./types";

function createFakeSheetsContext() {
  const sheets = new Map<string, unknown[][]>();
  const client = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: Array.from(sheets.keys()).map((title, index) => ({
            properties: { title, sheetId: index },
          })),
        },
      }),
      batchUpdate: async (request: { requestBody?: { requests?: Array<{ addSheet?: { properties?: { title?: string } } }> } }) => {
        for (const entry of request.requestBody?.requests ?? []) {
          const title = entry.addSheet?.properties?.title;
          if (title && !sheets.has(title)) {
            sheets.set(title, []);
          }
        }
        return { data: {} };
      },
      values: {
        get: async (request: { range: string }) => {
          const sheetName = request.range.match(/^'(.+)'!/)?.[1]?.replace(/''/g, "'") ?? "CONVERSATIONS";
          return { data: { values: sheets.get(sheetName) ?? [] } };
        },
        clear: async (request: { range: string }) => {
          const sheetName = request.range.match(/^'(.+)'!/)?.[1]?.replace(/''/g, "'") ?? "CONVERSATIONS";
          sheets.set(sheetName, []);
          return { data: {} };
        },
        update: async (request: { range: string; requestBody?: { values?: unknown[][] } }) => {
          const sheetName = request.range.match(/^'(.+)'!/)?.[1]?.replace(/''/g, "'") ?? "CONVERSATIONS";
          sheets.set(sheetName, request.requestBody?.values ?? []);
          return { data: {} };
        },
      },
    },
  };

  return {
    sheets,
    createSheetsClient: async () => ({
      client: client as never,
      spreadsheetId: "spreadsheet_qa",
    }),
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_google_sheets_qa",
    phoneE164: "+34600009991",
    phoneNormalized: "34600009991",
    sourceType: "whatsapp",
    channel: "whatsapp",
    mode: "bot",
    humanRequested: false,
    unreadCount: 0,
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("GoogleSheetsConversationStore", () => {
  it("persists conversations across store instances", async () => {
    const fake = createFakeSheetsContext();
    const firstStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:00:00.000Z"),
    });

    await firstStore.upsertConversation(conversation());
    await firstStore.addMessage({
      id: "msg_google_sheets_qa",
      conversationId: "conv_google_sheets_qa",
      direction: "inbound",
      senderType: "user",
      transport: "whatsapp",
      body: "Hola",
      createdAt: "2026-06-02T10:01:00.000Z",
    });

    const secondStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:02:00.000Z"),
    });
    const conversations = await secondStore.list();

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: "conv_google_sheets_qa",
      phoneNormalized: "34600009991",
      unreadCount: 1,
    });
    expect(conversations[0].messages).toHaveLength(1);
    expect(fake.sheets.get("CONVERSATIONS")?.[0]).toEqual([
      "id",
      "phone_normalized",
      "updated_at",
      "archived_at",
      "snapshot_json",
    ]);
  });
});
