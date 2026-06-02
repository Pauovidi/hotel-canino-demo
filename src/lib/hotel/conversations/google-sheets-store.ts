import type { sheets_v4 } from "googleapis";
import {
  createSheetsClient,
  quoteSheetRange,
} from "@/lib/hotel/clients/google-sheets-client-directory";
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

const DEFAULT_CONVERSATIONS_SHEET_NAME = "CONVERSATIONS";
const CONVERSATION_HEADERS = [
  "id",
  "phone_normalized",
  "updated_at",
  "archived_at",
  "snapshot_json",
] as const;

interface SheetsContext {
  client: sheets_v4.Sheets;
  spreadsheetId: string;
}

export interface GoogleSheetsConversationStoreDeps {
  createSheetsClient?: () => Promise<SheetsContext>;
  now?: () => Date;
}

function getConversationsSheetName(): string {
  return (
    process.env.HOTEL_CONVERSATIONS_SHEET_NAME?.trim() ||
    DEFAULT_CONVERSATIONS_SHEET_NAME
  );
}

function normalizeSheetTitle(value: string): string {
  return value.trim().toLowerCase();
}

function readCell(row: unknown[], index: number): string {
  return String(row[index] ?? "").trim();
}

function parseRecord(row: unknown[]): ConversationRecord | undefined {
  const rawJson = readCell(row, 4);
  if (!rawJson) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson) as ConversationRecord;
    return parsed && typeof parsed.id === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: ConversationRecord | undefined): value is ConversationRecord {
  return Boolean(value);
}

export class GoogleSheetsConversationStore implements ConversationStore {
  constructor(
    private readonly sheetName = getConversationsSheetName(),
    private readonly deps: GoogleSheetsConversationStoreDeps = {},
  ) {}

  private async context(): Promise<SheetsContext> {
    return (this.deps.createSheetsClient ?? createSheetsClient)();
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private async ensureSheet(): Promise<SheetsContext> {
    const context = await this.context();
    const response = await context.client.spreadsheets.get({
      spreadsheetId: context.spreadsheetId,
      fields: "sheets.properties",
    });
    const hasSheet = response.data.sheets?.some(
      (sheet) =>
        normalizeSheetTitle(sheet.properties?.title ?? "") ===
        normalizeSheetTitle(this.sheetName),
    );

    if (!hasSheet) {
      await context.client.spreadsheets.batchUpdate({
        spreadsheetId: context.spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: this.sheetName,
                },
              },
            },
          ],
        },
      });
      await context.client.spreadsheets.values.update({
        spreadsheetId: context.spreadsheetId,
        range: quoteSheetRange(this.sheetName, "A1:E1"),
        valueInputOption: "RAW",
        requestBody: {
          values: [[...CONVERSATION_HEADERS]],
        },
      });
    }

    return context;
  }

  async load(): Promise<ConversationSnapshot> {
    const context = await this.ensureSheet();
    const response = await context.client.spreadsheets.values.get({
      spreadsheetId: context.spreadsheetId,
      range: quoteSheetRange(this.sheetName, "A:E"),
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = response.data.values ?? [];
    const records = rows.slice(1).map(parseRecord).filter(isRecord);

    return {
      conversations: records,
      updatedAt: this.nowIso(),
    };
  }

  async save(snapshot: ConversationSnapshot): Promise<void> {
    const context = await this.ensureSheet();
    const rows = snapshot.conversations.map((record) => [
      record.id,
      record.phoneNormalized,
      record.updatedAt,
      record.archivedAt ?? "",
      JSON.stringify(record),
    ]);

    await context.client.spreadsheets.values.clear({
      spreadsheetId: context.spreadsheetId,
      range: quoteSheetRange(this.sheetName, "A:E"),
    });
    await context.client.spreadsheets.values.update({
      spreadsheetId: context.spreadsheetId,
      range: quoteSheetRange(this.sheetName, "A1:E"),
      valueInputOption: "RAW",
      requestBody: {
        values: [[...CONVERSATION_HEADERS], ...rows],
      },
    });
  }

  async list(filters?: ConversationListFilters): Promise<ConversationRecord[]> {
    return filterConversationRecords((await this.load()).conversations, filters);
  }

  async getById(id: string): Promise<ConversationRecord | undefined> {
    return (await this.load()).conversations.find((record) => record.id === id);
  }

  async getByPhone(phoneNormalized: string): Promise<ConversationRecord | undefined> {
    return (await this.load()).conversations.find(
      (record) => record.phoneNormalized === phoneNormalized,
    );
  }

  async upsertConversation(conversation: Conversation): Promise<ConversationRecord> {
    const snapshot = await this.load();
    const index = snapshot.conversations.findIndex((record) => record.id === conversation.id);
    const existing = index >= 0 ? snapshot.conversations[index] : undefined;
    const record: ConversationRecord = {
      ...existing,
      ...conversation,
      messages: existing?.messages ?? [],
      events: existing?.events ?? [],
    };

    if (index >= 0) {
      snapshot.conversations[index] = record;
    } else {
      snapshot.conversations.push(record);
    }

    await this.save(snapshot);
    return record;
  }

  async addMessage(message: Message): Promise<Message> {
    const snapshot = await this.load();
    const record = snapshot.conversations.find(
      (conversation) => conversation.id === message.conversationId,
    );

    if (!record) {
      throw new Error(`Conversation ${message.conversationId} not found`);
    }

    record.messages.push(message);
    record.updatedAt = message.createdAt;
    record.lastMessagePreview = message.body.slice(0, 180);
    if (message.direction === "inbound") {
      record.lastInboundAt = message.createdAt;
      record.unreadCount += 1;
    } else {
      record.lastOutboundAt = message.createdAt;
    }

    await this.save(snapshot);
    return message;
  }

  async addEvent(event: ConversationEvent): Promise<ConversationEvent> {
    const snapshot = await this.load();
    const record = snapshot.conversations.find(
      (conversation) => conversation.id === event.conversationId,
    );

    if (!record) {
      throw new Error(`Conversation ${event.conversationId} not found`);
    }

    record.events.push(event);
    record.updatedAt = event.createdAt;
    await this.save(snapshot);
    return event;
  }

  async replaceConversation(record: ConversationRecord): Promise<ConversationRecord> {
    const snapshot = await this.load();
    const index = snapshot.conversations.findIndex(
      (conversation) => conversation.id === record.id,
    );

    if (index >= 0) {
      snapshot.conversations[index] = record;
    } else {
      snapshot.conversations.push(record);
    }

    await this.save(snapshot);
    return record;
  }

  async seed(records: ConversationRecord[]): Promise<ConversationSnapshot> {
    const snapshot = {
      conversations: records,
      updatedAt: this.nowIso(),
    };
    await this.save(snapshot);
    return snapshot;
  }
}
