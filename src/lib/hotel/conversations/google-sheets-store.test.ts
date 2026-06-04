import { afterEach, describe, expect, it, vi } from "vitest";
import { createStaticClientDirectory } from "@/lib/hotel/clients";
import { GoogleSheetsConversationStore } from "./google-sheets-store";
import {
  archiveConversation,
  handleInboundWhatsApp,
  listConversationDashboard,
  unarchiveConversation,
} from "./service";
import type { Conversation } from "./types";

function createFakeSheetsContext(options: { failNextUpdate?: boolean; failNextUpdateCode?: number } = {}) {
  const sheets = new Map<string, unknown[][]>();
  const calls = {
    spreadsheetsGet: 0,
    valuesGet: 0,
    valuesClear: 0,
    valuesUpdate: 0,
  };
  let failNextUpdate = options.failNextUpdate ?? false;
  function sheetNameFromRange(range: string) {
    return range.match(/^'(.+)'!/)?.[1]?.replace(/''/g, "'") ?? "CONVERSATIONS";
  }
  function rowRangeFromA1(range: string): { start: number; end?: number } | undefined {
    const match = range.match(/![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/);
    if (!match) {
      return undefined;
    }
    return {
      start: Number.parseInt(match[1], 10),
      end: match[2] ? Number.parseInt(match[2], 10) : undefined,
    };
  }
  const client = {
    spreadsheets: {
      get: async () => {
        calls.spreadsheetsGet += 1;
        return {
          data: {
            sheets: Array.from(sheets.keys()).map((title, index) => ({
              properties: { title, sheetId: index },
            })),
          },
        };
      },
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
          calls.valuesGet += 1;
          const sheetName = sheetNameFromRange(request.range);
          return { data: { values: sheets.get(sheetName) ?? [] } };
        },
        clear: async (request: { range: string }) => {
          calls.valuesClear += 1;
          const sheetName = sheetNameFromRange(request.range);
          const rows = sheets.get(sheetName) ?? [];
          const rowRange = rowRangeFromA1(request.range);
          if (!rowRange) {
            sheets.set(sheetName, []);
          } else {
            const startIndex = Math.max(rowRange.start - 1, 0);
            const endIndex = rowRange.end ? Math.max(rowRange.end - 1, startIndex) : rows.length - 1;
            sheets.set(
              sheetName,
              rows.filter((_, index) => index < startIndex || index > endIndex),
            );
          }
          return { data: {} };
        },
        update: async (request: { range: string; requestBody?: { values?: unknown[][] } }) => {
          calls.valuesUpdate += 1;
          if (failNextUpdate) {
            failNextUpdate = false;
            throw Object.assign(new Error("mock values.update failed"), {
              code: options.failNextUpdateCode,
            });
          }
          const sheetName = sheetNameFromRange(request.range);
          const rows = sheets.get(sheetName) ?? [];
          const rowRange = rowRangeFromA1(request.range);
          const startIndex = rowRange ? Math.max(rowRange.start - 1, 0) : 0;
          const values = request.requestBody?.values ?? [];
          const next = [...rows];
          values.forEach((row, index) => {
            next[startIndex + index] = row;
          });
          sheets.set(sheetName, next);
          return { data: {} };
        },
      },
    },
  };

  return {
    sheets,
    calls,
    createSheetsClient: async () => ({
      client: client as never,
      spreadsheetId: "spreadsheet_qa",
    }),
    failNextUpdate() {
      failNextUpdate = true;
    },
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    expect(fake.sheets.get("CONVERSATIONS")?.[0].slice(0, 5)).toEqual([
      "id",
      "phone_normalized",
      "updated_at",
      "archived_at",
      "snapshot_json",
    ]);
  });

  it("does not clear CONVERSATIONS when a Google Sheets update fails", async () => {
    const fake = createFakeSheetsContext();
    const firstStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:00:00.000Z"),
    });

    await firstStore.upsertConversation(conversation());
    const rowsBeforeFailure = structuredClone(fake.sheets.get("CONVERSATIONS"));
    fake.failNextUpdate();

    await expect(
      firstStore.addMessage({
        id: "msg_google_sheets_update_fail",
        conversationId: "conv_google_sheets_qa",
        direction: "inbound",
        senderType: "user",
        transport: "whatsapp",
        body: "si",
        createdAt: "2026-06-02T10:03:00.000Z",
      }),
    ).rejects.toThrow("mock values.update failed");

    expect(fake.sheets.get("CONVERSATIONS")).toEqual(rowsBeforeFailure);

    const reloadedStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:04:00.000Z"),
    });
    const conversations = await reloadedStore.list();

    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe("conv_google_sheets_qa");
    expect(conversations[0].messages).toHaveLength(0);
  });

  it("persists archived state, restores history and reopens on new inbound", async () => {
    const fake = createFakeSheetsContext();
    const firstStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:00:00.000Z"),
    });

    await firstStore.upsertConversation(conversation());
    await firstStore.addMessage({
      id: "msg_google_sheets_archive_inbound",
      conversationId: "conv_google_sheets_qa",
      direction: "inbound",
      senderType: "user",
      transport: "whatsapp",
      body: "Hola, quiero información",
      createdAt: "2026-06-02T10:01:00.000Z",
    });
    await firstStore.addEvent({
      id: "evt_google_sheets_archive_created",
      conversationId: "conv_google_sheets_qa",
      eventType: "conversation_created",
      createdAt: "2026-06-02T10:00:00.000Z",
    });

    const archived = await archiveConversation(
      "conv_google_sheets_qa",
      "admin",
      "qa_cleanup",
      firstStore,
    );

    expect(archived.archivedAt).toBeDefined();
    expect(await firstStore.list()).toHaveLength(0);
    expect(await firstStore.list({ mode: "archived" })).toHaveLength(1);
    expect((await firstStore.load()).conversations.filter((item) => item.archivedAt)).toHaveLength(1);

    const reloadedStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:02:00.000Z"),
    });
    const archivedAfterReload = await reloadedStore.list({ mode: "archived" });

    expect(archivedAfterReload).toHaveLength(1);
    expect(archivedAfterReload[0].messages).toHaveLength(1);
    expect(
      archivedAfterReload[0].events.some((event) => event.eventType === "conversation_archived"),
    ).toBe(true);

    const restored = await unarchiveConversation("conv_google_sheets_qa", "admin", reloadedStore);

    expect(restored.archivedAt).toBeUndefined();
    expect(await reloadedStore.list()).toHaveLength(1);
    expect(await reloadedStore.list({ mode: "archived" })).toHaveLength(0);

    await archiveConversation("conv_google_sheets_qa", "admin", "qa_cleanup", reloadedStore);
    const reopened = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        to: "whatsapp:+14155238886",
        body: "Hola de nuevo",
        messageSid: "SM_GOOGLE_ARCHIVE_REOPEN",
      },
      reloadedStore,
      createStaticClientDirectory([]),
    );

    expect(reopened.conversation.archivedAt).toBeUndefined();
    expect(await reloadedStore.list()).toHaveLength(1);
    expect(await reloadedStore.list({ mode: "archived" })).toHaveLength(0);
    expect(reopened.conversation.messages.length).toBeGreaterThan(1);
    expect(
      reopened.conversation.events.some(
        (event) => event.eventType === "conversation_reopened_from_inbound",
      ),
    ).toBe(true);
  });

  it("normalizes incomplete rows and skips corrupt rows without crashing dashboards", async () => {
    const fake = createFakeSheetsContext();
    fake.sheets.set("CONVERSATIONS", [
      ["id", "phone_normalized", "updated_at", "archived_at", "snapshot_json"],
      [
        "conv_partial",
        "34600000000",
        "",
        "",
        JSON.stringify({
          id: "conv_partial",
          phoneNormalized: "34600000000",
        }),
      ],
      ["conv_corrupt", "34600000001", "", "", "{not-json"],
    ]);
    const store = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:03:00.000Z"),
    });

    const dashboard = await listConversationDashboard(undefined, store);

    expect(dashboard.conversations).toHaveLength(1);
    expect(dashboard.conversations[0]).toMatchObject({
      id: "conv_partial",
      phoneNormalized: "34600000000",
      mode: "bot",
      unreadCount: 0,
      messages: [],
      events: [],
      sourceType: "whatsapp",
      status: "open",
    });
    expect(dashboard.stats).toMatchObject({
      total: 1,
      archived: 0,
    });
    await expect(store.list({ query: "34600000000" })).resolves.toHaveLength(1);
  });

  it("splits large conversation snapshots across cells and restores them", async () => {
    const fake = createFakeSheetsContext();
    const firstStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:00:00.000Z"),
    });

    await firstStore.upsertConversation(conversation());
    await firstStore.addMessage({
      id: "msg_google_sheets_large_snapshot",
      conversationId: "conv_google_sheets_qa",
      direction: "inbound",
      senderType: "user",
      transport: "whatsapp",
      body: "Mensaje largo ".repeat(6000),
      createdAt: "2026-06-02T10:01:00.000Z",
    });

    const rows = fake.sheets.get("CONVERSATIONS") ?? [];
    const header = rows[0];
    const persisted = rows[1];
    const snapshotChunks = persisted.slice(4).map((cell) => String(cell));

    expect(header).toContain("snapshot_json_2");
    expect(snapshotChunks.length).toBeGreaterThan(1);
    expect(snapshotChunks.every((chunk) => chunk.length <= 32_000)).toBe(true);

    const secondStore = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:02:00.000Z"),
    });
    const conversations = await secondStore.list();

    expect(conversations).toHaveLength(1);
    expect(conversations[0].messages[0].body).toContain("Mensaje largo");
    expect(conversations[0].messages[0].body.length).toBeGreaterThan(50_000);
  });

  it("loads legacy rows with chunked snapshot_json columns", async () => {
    const fake = createFakeSheetsContext();
    const snapshot = JSON.stringify({
      ...conversation({
        id: "conv_chunked_legacy",
        phoneNormalized: "34600000007",
      }),
      messages: [
        {
          id: "msg_chunked_legacy",
          conversationId: "conv_chunked_legacy",
          direction: "inbound",
          senderType: "user",
          transport: "whatsapp",
          body: "Hola desde chunk",
          createdAt: "2026-06-02T10:01:00.000Z",
        },
      ],
    });
    fake.sheets.set("CONVERSATIONS", [
      [
        "id",
        "phone_normalized",
        "updated_at",
        "archived_at",
        "snapshot_json",
        "snapshot_json_2",
      ],
      [
        "conv_chunked_legacy",
        "34600000007",
        "2026-06-02T10:00:00.000Z",
        "",
        snapshot.slice(0, 20),
        snapshot.slice(20),
      ],
    ]);
    const store = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:03:00.000Z"),
    });

    const conversations = await store.list();

    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe("conv_chunked_legacy");
    expect(conversations[0].messages[0].body).toBe("Hola desde chunk");
  });

  it("propagates Google Sheets 400 save failures with sanitized diagnostics", async () => {
    const fake = createFakeSheetsContext({ failNextUpdateCode: 400 });
    fake.sheets.set("CONVERSATIONS", [
      ["id", "phone_normalized", "updated_at", "archived_at", "snapshot_json"],
    ]);
    const store = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:00:00.000Z"),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    fake.failNextUpdate();
    await expect(store.upsertConversation(conversation())).rejects.toMatchObject({
      code: 400,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "conversations_store_save_failed",
      expect.objectContaining({
        provider: "google_sheets",
        operation: "values.update",
        safeErrorCode: "400",
      }),
    );
  });

  it("ignores empty and structurally incomplete rows without blocking valid conversations", async () => {
    const fake = createFakeSheetsContext();
    fake.sheets.set("CONVERSATIONS", [
      ["id", "phone_normalized", "updated_at", "archived_at", "snapshot_json"],
      [],
      ["conv_without_snapshot"],
      ["conv_blank_snapshot", "34600000004", "", "", ""],
      [
        "conv_valid_after_dirty_rows",
        "34600000005",
        "2026-06-02T10:04:00.000Z",
        "",
        JSON.stringify(
          conversation({
            id: "conv_valid_after_dirty_rows",
            phoneNormalized: "34600000005",
            updatedAt: "2026-06-02T10:04:00.000Z",
          }),
        ),
      ],
      ["conv_corrupt_after_valid", "34600000006", "", "", "{not-json"],
    ]);
    const store = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:05:00.000Z"),
    });

    const conversations = await store.list();

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: "conv_valid_after_dirty_rows",
      phoneNormalized: "34600000005",
    });
  });

  it("keeps archived stats and archived list aligned after corrupt and duplicate rows", async () => {
    const fake = createFakeSheetsContext();
    fake.sheets.set("CONVERSATIONS", [
      ["id", "phone_normalized", "updated_at", "archived_at", "snapshot_json"],
      [
        "conv_archived_1",
        "34600000001",
        "2026-06-02T10:00:00.000Z",
        "2026-06-02T10:10:00.000Z",
        JSON.stringify({
          ...conversation({
            id: "conv_archived_1",
            phoneNormalized: "34600000001",
            archivedAt: "2026-06-02T10:10:00.000Z",
          }),
        }),
      ],
      [
        "conv_archived_2",
        "34600000002",
        "2026-06-02T10:11:00.000Z",
        "2026-06-02T10:12:00.000Z",
        JSON.stringify({
          ...conversation({
            id: "conv_archived_2",
            phoneNormalized: "34600000002",
            archivedAt: "2026-06-02T10:12:00.000Z",
          }),
        }),
      ],
      [
        "conv_archived_2",
        "34600000002",
        "2026-06-02T09:00:00.000Z",
        "2026-06-02T09:05:00.000Z",
        JSON.stringify({
          ...conversation({
            id: "conv_archived_2",
            phoneNormalized: "34600000002",
            updatedAt: "2026-06-02T09:00:00.000Z",
            archivedAt: "2026-06-02T09:05:00.000Z",
          }),
        }),
      ],
      ["conv_corrupt_archived", "34600000003", "", "2026-06-02T09:05:00.000Z", "{not-json"],
    ]);
    const store = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:20:00.000Z"),
    });

    const archivedDashboard = await listConversationDashboard({ mode: "archived" }, store);

    expect(archivedDashboard.conversations).toHaveLength(2);
    expect(archivedDashboard.stats.archived).toBe(2);
    expect(archivedDashboard.conversations.map((item) => item.id).sort()).toEqual([
      "conv_archived_1",
      "conv_archived_2",
    ]);
    expect(fake.calls.valuesGet).toBe(1);
  });

  it("uses the latest duplicate phone row as canonical for inbound and avoids fallback replies", async () => {
    const fake = createFakeSheetsContext();
    fake.sheets.set("CONVERSATIONS", [
      ["id", "phone_normalized", "updated_at", "archived_at", "snapshot_json"],
      [
        "conv_old_duplicate",
        "34600009991",
        "2026-06-02T09:00:00.000Z",
        "",
        JSON.stringify({
          ...conversation({
            id: "conv_old_duplicate",
            updatedAt: "2026-06-02T09:00:00.000Z",
          }),
        }),
      ],
      ["conv_corrupt_same_phone", "34600009991", "", "", "{not-json"],
      [
        "conv_latest_duplicate",
        "34600009991",
        "2026-06-02T10:00:00.000Z",
        "",
        JSON.stringify({
          ...conversation({
            id: "conv_latest_duplicate",
            updatedAt: "2026-06-02T10:00:00.000Z",
          }),
        }),
      ],
    ]);
    const store = new GoogleSheetsConversationStore("CONVERSATIONS", {
      createSheetsClient: fake.createSheetsClient,
      now: () => new Date("2026-06-02T10:20:00.000Z"),
    });

    const result = await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600009991",
        to: "whatsapp:+14155238886",
        body: "hola!",
        messageSid: "SM_GOOGLE_DUPLICATE_PHONE",
      },
      store,
      createStaticClientDirectory([]),
    );

    expect(result.conversation.id).toBe("conv_latest_duplicate");
    expect(result.twiml).toContain("<Message>");
    expect(result.twiml).toContain("ayudarte");
    expect(result.twiml).not.toContain("hemos recibido tu mensaje");
    expect(await store.list()).toHaveLength(1);
  });
});
