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
const DEFAULT_CACHE_TTL_MS = 4500;

interface SheetsContext {
  client: sheets_v4.Sheets;
  spreadsheetId: string;
}

export interface GoogleSheetsConversationStoreDeps {
  createSheetsClient?: () => Promise<SheetsContext>;
  now?: () => Date;
}

export function getConversationsSheetName(): string {
  return (
    process.env.HOTEL_CONVERSATIONS_SHEET_NAME?.trim() ||
    DEFAULT_CONVERSATIONS_SHEET_NAME
  );
}

export function readGoogleSheetsConversationStoreHealth(env: NodeJS.ProcessEnv = process.env) {
  const hasSpreadsheetId = Boolean(env.HOTEL_GOOGLE_SHEETS_SPREADSHEET_ID?.trim());
  const hasAccessToken = Boolean(env.HOTEL_GOOGLE_SHEETS_ACCESS_TOKEN?.trim());
  const hasServiceAccountJson = Boolean(env.HOTEL_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON?.trim());
  const hasServiceAccountParts = Boolean(
    (
      env.HOTEL_GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL ??
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    )?.trim() &&
      (
        env.HOTEL_GOOGLE_SHEETS_PRIVATE_KEY ??
        env.GOOGLE_PRIVATE_KEY
      )?.trim(),
  );

  return {
    sheetName:
      env.HOTEL_CONVERSATIONS_SHEET_NAME?.trim() ||
      DEFAULT_CONVERSATIONS_SHEET_NAME,
    configured:
      hasSpreadsheetId &&
      (hasAccessToken || hasServiceAccountJson || hasServiceAccountParts),
    hasSpreadsheetId,
    hasCredentialSource: hasAccessToken || hasServiceAccountJson || hasServiceAccountParts,
  };
}

function normalizeSheetTitle(value: string): string {
  return value.trim().toLowerCase();
}

function readCell(row: unknown[], index: number): string {
  return String(row[index] ?? "").trim();
}

function safeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).slice(0, 80)
    : undefined;
}

function safeConversationId(value: string): string {
  return value ? `${value.slice(0, 18)}${value.length > 18 ? "…" : ""}` : "";
}

function parseRecord(row: unknown[], rowNumber: number): ConversationRecord | undefined {
  const rowId = readCell(row, 0);
  const rowPhoneNormalized = readCell(row, 1);
  const rowUpdatedAt = readCell(row, 2);
  const rowArchivedAt = readCell(row, 3);
  const rawJson = readCell(row, 4);
  if (!rawJson) {
    console.warn("conversation_store_row_skipped", {
      provider: "google_sheets",
      rowNumber,
      reason: "missing_snapshot_json",
      conversationId: safeConversationId(rowId),
    });
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson);
    const normalizedInput =
      parsed && typeof parsed === "object"
        ? {
            ...(parsed as Record<string, unknown>),
            id: (parsed as Record<string, unknown>).id ?? rowId,
            phoneNormalized:
              (parsed as Record<string, unknown>).phoneNormalized ?? rowPhoneNormalized,
            updatedAt: (parsed as Record<string, unknown>).updatedAt ?? rowUpdatedAt,
            archivedAt: (parsed as Record<string, unknown>).archivedAt ?? rowArchivedAt,
          }
        : parsed;
    const record = normalizeGoogleSheetsRecord(normalizedInput);
    if (!record) {
      console.warn("conversation_store_row_skipped", {
        provider: "google_sheets",
        rowNumber,
        reason: "invalid_snapshot_shape",
        conversationId: safeConversationId(rowId),
      });
      return undefined;
    }

    return {
      ...record,
      id: record.id || rowId,
      phoneNormalized: record.phoneNormalized || rowPhoneNormalized || record.id,
      updatedAt: record.updatedAt || rowUpdatedAt,
      archivedAt: record.archivedAt || rowArchivedAt || undefined,
    };
  } catch (error) {
    console.warn("conversation_store_corrupt_row_skipped", {
      provider: "google_sheets",
      rowNumber,
      conversationId: safeConversationId(rowId),
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}

function normalizeMessage(
  conversationId: string,
  value: Record<string, unknown>,
  index: number,
): Message {
  const rawDirection = String(value.direction ?? "");
  const rawSenderType = String(value.senderType ?? value.author ?? "user");
  const senderType: Message["senderType"] =
    rawSenderType === "bot" ||
    rawSenderType === "human" ||
    rawSenderType === "system" ||
    rawSenderType === "user"
      ? rawSenderType
      : "user";

  return {
    id: String(value.id ?? `${conversationId}-msg-${index}`),
    conversationId,
    direction:
      rawDirection === "outbound" || senderType === "bot" || senderType === "human"
        ? "outbound"
        : "inbound",
    senderType,
    transport: "whatsapp",
    externalMessageSid:
      typeof value.externalMessageSid === "string" ? value.externalMessageSid : undefined,
    body: String(value.body ?? value.text ?? ""),
    rawPayload: value.rawPayload,
    createdAt: String(value.createdAt ?? value.at ?? new Date().toISOString()),
  };
}

function normalizeGoogleSheetsRecord(value: unknown): ConversationRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = String(record.id ?? record.conversationId ?? "");
  if (!id) {
    return undefined;
  }

  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const messages = rawMessages
    .map((message, index) => normalizeMessage(id, message as Record<string, unknown>, index))
    .filter((message) => message.body.trim());
  const rawEvents = Array.isArray(record.events) ? record.events : [];
  const events = rawEvents.map((event, index) => {
    const rawEvent = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
    const eventType = String(rawEvent.eventType ?? rawEvent.type ?? "event");
    return {
      id: String(rawEvent.id ?? `${id}-evt-${index}`),
      conversationId: id,
      eventType,
      type: typeof rawEvent.type === "string" ? rawEvent.type : eventType,
      label: typeof rawEvent.label === "string" ? rawEvent.label : eventType,
      payload: rawEvent.payload,
      createdAt: String(rawEvent.createdAt ?? rawEvent.at ?? new Date().toISOString()),
      at: typeof rawEvent.at === "string" ? rawEvent.at : undefined,
    };
  });
  const phoneE164 = String(record.phoneE164 ?? "");
  const phoneNormalized = String(
    record.phoneNormalized ?? phoneE164.replace(/[^\d]/g, "") ?? id,
  );
  const channel = String(record.channel ?? record.sourceType ?? "whatsapp");
  const lastMessage = messages.at(-1);
  const createdAt = String(record.createdAt ?? messages[0]?.createdAt ?? new Date().toISOString());
  const updatedAt = String(
    record.updatedAt ?? record.lastMessageAt ?? lastMessage?.createdAt ?? createdAt,
  );

  return {
    ...record,
    id,
    phoneE164,
    phoneNormalized: phoneNormalized || id,
    displayName: typeof record.displayName === "string" ? record.displayName : undefined,
    customerName: typeof record.customerName === "string" ? record.customerName : undefined,
    petName: typeof record.petName === "string" ? record.petName : undefined,
    channel,
    status: typeof record.status === "string" ? record.status : "open",
    priority: typeof record.priority === "string" ? record.priority : "normal",
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    sourceType:
      channel === "web" ||
      channel === "email" ||
      channel === "manual" ||
      channel === "demo" ||
      channel === "reservation" ||
      channel === "whatsapp"
        ? channel
        : "unknown",
    mode: record.mode === "human" ? "human" : "bot",
    humanRequested: Boolean(record.humanRequested),
    unreadCount:
      typeof record.unreadCount === "number" && Number.isFinite(record.unreadCount)
        ? record.unreadCount
        : messages.filter((message) => message.direction === "inbound").length,
    archivedAt: typeof record.archivedAt === "string" ? record.archivedAt : undefined,
    archivedBy: typeof record.archivedBy === "string" ? record.archivedBy : undefined,
    archivedReason:
      typeof record.archivedReason === "string" ? record.archivedReason : undefined,
    clientStatus:
      record.clientStatus === "known" ||
      record.clientStatus === "unknown" ||
      record.clientStatus === "ambiguous" ||
      record.clientStatus === "blocked"
        ? record.clientStatus
        : "unknown",
    clientWarnings: Array.isArray(record.clientWarnings)
      ? record.clientWarnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    requiresManualReview: Boolean(record.requiresManualReview),
    createdAt,
    updatedAt,
    lastInboundAt:
      typeof record.lastInboundAt === "string"
        ? record.lastInboundAt
        : messages.findLast((message) => message.direction === "inbound")?.createdAt,
    lastOutboundAt:
      typeof record.lastOutboundAt === "string"
        ? record.lastOutboundAt
        : messages.findLast((message) => message.direction === "outbound")?.createdAt,
    lastMessagePreview:
      typeof record.lastMessagePreview === "string"
        ? record.lastMessagePreview
        : lastMessage?.body.slice(0, 180),
    messages,
    events,
  } as ConversationRecord;
}

function isRecord(value: ConversationRecord | undefined): value is ConversationRecord {
  return Boolean(value);
}

function conversationSortTime(record: ConversationRecord): number {
  const updated = Date.parse(record.updatedAt ?? "");
  if (Number.isFinite(updated)) {
    return updated;
  }

  const created = Date.parse(record.createdAt ?? "");
  return Number.isFinite(created) ? created : 0;
}

function dedupeConversationRecords(records: ConversationRecord[]): ConversationRecord[] {
  const byId = new Map<string, ConversationRecord>();

  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }

    const winner =
      conversationSortTime(record) >= conversationSortTime(existing) ? record : existing;
    byId.set(record.id, winner);
    console.warn("conversation_store_duplicate_row_skipped", {
      provider: "google_sheets",
      conversationId: safeConversationId(record.id),
      keptUpdatedAt: winner.updatedAt,
    });
  }

  const byPhone = new Map<string, ConversationRecord>();
  for (const record of byId.values()) {
    const phoneKey = record.phoneNormalized?.trim();
    if (!phoneKey) {
      byPhone.set(record.id, record);
      continue;
    }

    const existing = byPhone.get(phoneKey);
    if (!existing) {
      byPhone.set(phoneKey, record);
      continue;
    }

    const winner =
      conversationSortTime(record) >= conversationSortTime(existing) ? record : existing;
    byPhone.set(phoneKey, winner);
    console.warn("conversation_store_duplicate_phone_row_skipped", {
      provider: "google_sheets",
      conversationId: safeConversationId(record.id),
      keptConversationId: safeConversationId(winner.id),
      keptUpdatedAt: winner.updatedAt,
    });
  }

  return Array.from(byPhone.values());
}

function readCacheTtlMs(): number {
  const parsed = Number.parseInt(
    process.env.HOTEL_CONVERSATIONS_SHEETS_CACHE_TTL_MS ?? "",
    10,
  );
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.min(parsed, 30_000);
  }

  return DEFAULT_CACHE_TTL_MS;
}

export class GoogleSheetsConversationStore implements ConversationStore {
  private sheetReady = false;
  private cachedSnapshot: ConversationSnapshot | undefined;
  private cachedSnapshotExpiresAt = 0;

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

  private nowMs(): number {
    return this.deps.now?.().getTime() ?? Date.now();
  }

  private setCachedSnapshot(snapshot: ConversationSnapshot) {
    this.cachedSnapshot = snapshot;
    this.cachedSnapshotExpiresAt = this.nowMs() + readCacheTtlMs();
  }

  private async ensureSheet(): Promise<SheetsContext> {
    const context = await this.context();
    if (this.sheetReady) {
      return context;
    }

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

    this.sheetReady = true;
    return context;
  }

  async load(): Promise<ConversationSnapshot> {
    if (this.cachedSnapshot && this.cachedSnapshotExpiresAt > this.nowMs()) {
      return this.cachedSnapshot;
    }

    const context = await this.ensureSheet();
    try {
      const response = await context.client.spreadsheets.values.get({
        spreadsheetId: context.spreadsheetId,
        range: quoteSheetRange(this.sheetName, "A:E"),
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const rows = response.data.values ?? [];
      const records = dedupeConversationRecords(
        rows
          .slice(1)
          .map((row, index) => parseRecord(row, index + 2))
          .filter(isRecord),
      );
      const snapshot = {
        conversations: records,
        updatedAt: this.nowIso(),
      };

      this.setCachedSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (this.cachedSnapshot) {
        console.warn("conversation_store_load_failed_using_stale_cache", {
          provider: "google_sheets",
          errorName: error instanceof Error ? error.name : "UnknownError",
          safeErrorCode: safeErrorCode(error),
        });
        return this.cachedSnapshot;
      }

      throw error;
    }
  }

  async save(snapshot: ConversationSnapshot): Promise<void> {
    const context = await this.ensureSheet();
    const normalizedSnapshot = {
      ...snapshot,
      conversations: dedupeConversationRecords(snapshot.conversations),
      updatedAt: this.nowIso(),
    };
    const values = [
      [...CONVERSATION_HEADERS],
      ...normalizedSnapshot.conversations.map((record) => [
      record.id,
      record.phoneNormalized,
      record.updatedAt,
      record.archivedAt ?? "",
      JSON.stringify(record),
      ]),
    ];

    let previousRowCount = 0;
    try {
      const existing = await context.client.spreadsheets.values.get({
        spreadsheetId: context.spreadsheetId,
        range: quoteSheetRange(this.sheetName, "A:E"),
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      previousRowCount = existing.data.values?.length ?? 0;
    } catch (error) {
      console.warn("conversation_store_existing_rows_count_failed", {
        provider: "google_sheets",
        errorName: error instanceof Error ? error.name : "UnknownError",
        safeErrorCode: safeErrorCode(error),
      });
    }

    await context.client.spreadsheets.values.update({
      spreadsheetId: context.spreadsheetId,
      range: quoteSheetRange(this.sheetName, "A1:E"),
      valueInputOption: "RAW",
      requestBody: {
        values,
      },
    });

    if (previousRowCount > values.length) {
      try {
        await context.client.spreadsheets.values.clear({
          spreadsheetId: context.spreadsheetId,
          range: quoteSheetRange(
            this.sheetName,
            `A${values.length + 1}:E${previousRowCount}`,
          ),
        });
      } catch (error) {
        console.warn("conversation_store_stale_rows_clear_failed", {
          provider: "google_sheets",
          keptRows: values.length,
          previousRowCount,
          errorName: error instanceof Error ? error.name : "UnknownError",
          safeErrorCode: safeErrorCode(error),
        });
      }
    }

    this.setCachedSnapshot(normalizedSnapshot);
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
