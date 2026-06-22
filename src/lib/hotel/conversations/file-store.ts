import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readHotelPersistenceConfig, resolveJsonStorePath } from "@/lib/hotel/persistence/runtime";
import { GoogleSheetsConversationStore } from "./google-sheets-store";
import { PostgresConversationStore } from "./postgres-store";
import type {
  Conversation,
  ConversationEvent,
  ConversationListFilters,
  ConversationRecord,
  ConversationSnapshot,
  Message,
} from "./types";
import {
  createEmptyConversationSnapshot,
  filterConversationRecords,
  type ConversationStore,
} from "./store";

function getStorePath() {
  return resolveJsonStorePath({
    fileName: "hotel-conversations.json",
    pathEnv: "HOTEL_CONVERSATIONS_STORE_PATH",
    dirEnv: "HOTEL_CONVERSATIONS_STORE_DIR",
  });
}

function normalizeMessage(
  conversationId: string,
  value: Record<string, unknown>,
  index: number,
): Message {
  const author = String(value.author ?? value.senderType ?? "user");
  const direction: Message["direction"] =
    author === "customer" || author === "user" ? "inbound" : "outbound";
  const senderType: Message["senderType"] =
    author === "assistant" ? "bot" : author === "operator" ? "human" : (author as Message["senderType"]);

  return {
    id: String(value.id ?? `${conversationId}-msg-${index}`),
    conversationId,
    direction,
    senderType:
      senderType === "bot" ||
      senderType === "human" ||
      senderType === "system" ||
      senderType === "user"
        ? senderType
        : "user",
    transport: "whatsapp",
    body: String(value.body ?? value.text ?? ""),
    rawPayload: value.rawPayload,
    createdAt: String(value.createdAt ?? value.at ?? new Date().toISOString()),
  };
}

function normalizeRecord(value: unknown): ConversationRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const conversationId = String(record.id ?? record.conversationId ?? "");

  if (!conversationId) {
    return undefined;
  }

  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const messages = rawMessages
    .map((message, index) =>
      normalizeMessage(conversationId, message as Record<string, unknown>, index),
    )
    .filter((message) => message.body.trim());
  const lastMessage = messages.at(-1);
  const phoneE164 = String(record.phoneE164 ?? "");
  const phoneNormalized = String(
    record.phoneNormalized ?? phoneE164.replace(/[^\d]/g, "") ?? conversationId,
  );
  const channel = String(record.channel ?? record.sourceType ?? "whatsapp");
  const createdAt = String(
    record.createdAt ?? messages[0]?.createdAt ?? new Date().toISOString(),
  );
  const updatedAt = String(
    record.updatedAt ?? record.lastMessageAt ?? lastMessage?.createdAt ?? createdAt,
  );
  const pendingReservationProposal =
    record.pendingReservationProposal &&
    typeof record.pendingReservationProposal === "object"
      ? (record.pendingReservationProposal as ConversationRecord["pendingReservationProposal"])
      : undefined;
  const pendingReservationContext =
    record.pendingReservationContext &&
    typeof record.pendingReservationContext === "object"
      ? (record.pendingReservationContext as ConversationRecord["pendingReservationContext"])
      : undefined;
  const pendingPriceQuoteFlow =
    record.pendingPriceQuoteFlow &&
    typeof record.pendingPriceQuoteFlow === "object"
      ? (record.pendingPriceQuoteFlow as ConversationRecord["pendingPriceQuoteFlow"])
      : undefined;
  const pendingReservationModificationFlow =
    record.pendingReservationModificationFlow &&
    typeof record.pendingReservationModificationFlow === "object"
      ? (record.pendingReservationModificationFlow as ConversationRecord["pendingReservationModificationFlow"])
      : undefined;
  const pendingReservationCancellationFlow =
    record.pendingReservationCancellationFlow &&
    typeof record.pendingReservationCancellationFlow === "object"
      ? (record.pendingReservationCancellationFlow as ConversationRecord["pendingReservationCancellationFlow"])
      : undefined;
  const reservationFlow =
    record.reservationFlow && typeof record.reservationFlow === "object"
      ? (record.reservationFlow as ConversationRecord["reservationFlow"])
      : undefined;

  return {
    id: conversationId,
    phoneE164,
    phoneNormalized: phoneNormalized || conversationId,
    displayName: String(record.displayName ?? record.customerName ?? "Cliente"),
    customerName: String(record.customerName ?? record.displayName ?? "Cliente"),
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
    sourceRecordId:
      typeof record.sourceRecordId === "string"
        ? record.sourceRecordId
        : typeof record.reservationId === "string"
          ? record.reservationId
          : undefined,
    reservationId:
      typeof record.reservationId === "string" ? record.reservationId : undefined,
    clientStatus:
      record.clientStatus === "known" ||
      record.clientStatus === "unknown" ||
      record.clientStatus === "ambiguous" ||
      record.clientStatus === "blocked"
        ? record.clientStatus
        : undefined,
    clientConfidence:
      record.clientConfidence === "strong" ||
      record.clientConfidence === "medium" ||
      record.clientConfidence === "weak" ||
      record.clientConfidence === "none"
        ? record.clientConfidence
        : undefined,
    clientMatchType:
      record.clientMatchType === "phone" ||
      record.clientMatchType === "email" ||
      record.clientMatchType === "name" ||
      record.clientMatchType === "none"
        ? record.clientMatchType
        : undefined,
    clientName: typeof record.clientName === "string" ? record.clientName : undefined,
    clientEmail: typeof record.clientEmail === "string" ? record.clientEmail : undefined,
    clientPets: Array.isArray(record.clientPets)
      ? record.clientPets.filter((pet): pet is string => typeof pet === "string")
      : undefined,
    clientPetsCount:
      typeof record.clientPetsCount === "number" && Number.isFinite(record.clientPetsCount)
        ? record.clientPetsCount
        : undefined,
    clientPetsMatchStatus:
      record.clientPetsMatchStatus === "exact" ||
      record.clientPetsMatchStatus === "exact_or_token" ||
      record.clientPetsMatchStatus === "ambiguous" ||
      record.clientPetsMatchStatus === "missing" ||
      record.clientPetsMatchStatus === "manual_review"
        ? record.clientPetsMatchStatus
        : undefined,
    clientPetsMeta:
      typeof record.clientPetsMeta === "string" ? record.clientPetsMeta : undefined,
    clientWarnings: Array.isArray(record.clientWarnings)
      ? record.clientWarnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    clientSource:
      record.clientSource === "google_sheets_client_directory"
        ? record.clientSource
        : undefined,
    clientSheetName:
      typeof record.clientSheetName === "string" ? record.clientSheetName : undefined,
    clientSheetRow:
      typeof record.clientSheetRow === "number" && Number.isFinite(record.clientSheetRow)
        ? record.clientSheetRow
        : undefined,
    clientDirectoryUpsertKind:
      record.clientDirectoryUpsertKind === "created" ||
      record.clientDirectoryUpsertKind === "created_pending_name" ||
      record.clientDirectoryUpsertKind === "existing" ||
      record.clientDirectoryUpsertKind === "skipped_ambiguous" ||
      record.clientDirectoryUpsertKind === "skipped_blocked" ||
      record.clientDirectoryUpsertKind === "skipped_invalid_phone" ||
      record.clientDirectoryUpsertKind === "failed"
        ? record.clientDirectoryUpsertKind
        : undefined,
    clientDirectoryUpsertStatus:
      record.clientDirectoryUpsertStatus === "created" ||
      record.clientDirectoryUpsertStatus === "existing" ||
      record.clientDirectoryUpsertStatus === "pending" ||
      record.clientDirectoryUpsertStatus === "skipped" ||
      record.clientDirectoryUpsertStatus === "failed"
        ? record.clientDirectoryUpsertStatus
        : undefined,
    clientDirectoryUpsertWarning:
      typeof record.clientDirectoryUpsertWarning === "string"
        ? record.clientDirectoryUpsertWarning
        : undefined,
    pendingReservationProposal,
    pendingReservationContext,
    pendingPriceQuoteFlow,
    pendingReservationModificationFlow,
    pendingReservationCancellationFlow,
    reservationFlow,
    archivedAt: typeof record.archivedAt === "string" ? record.archivedAt : undefined,
    archivedBy: typeof record.archivedBy === "string" ? record.archivedBy : undefined,
    archivedReason:
      typeof record.archivedReason === "string" ? record.archivedReason : undefined,
    requiresManualReview: Boolean(record.requiresManualReview),
    mode: record.mode === "human" ? "human" : "bot",
    humanRequested: Boolean(record.humanRequested),
    assignedAgent:
      typeof record.assignedAgent === "string" ? record.assignedAgent : undefined,
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
    unreadCount:
      typeof record.unreadCount === "number" && Number.isFinite(record.unreadCount)
        ? record.unreadCount
        : 0,
    createdAt,
    updatedAt,
    messages,
    events: Array.isArray(record.events)
      ? (record.events as ConversationEvent[]).map((event) => ({
          ...event,
          type: event.type ?? event.eventType,
          label: event.label ?? event.eventType,
          at: event.at ?? event.createdAt,
        }))
      : [],
  };
}

function isConversationRecord(
  record: ConversationRecord | undefined,
): record is ConversationRecord {
  return Boolean(record);
}

function normalizeSnapshot(value: unknown): ConversationSnapshot {
  const envelope = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const conversations = Array.isArray(envelope.conversations)
    ? envelope.conversations.map(normalizeRecord).filter(isConversationRecord)
    : [];

  return {
    conversations,
    updatedAt:
      typeof envelope.updatedAt === "string"
        ? envelope.updatedAt
        : typeof envelope.generatedAt === "string"
          ? envelope.generatedAt
          : new Date().toISOString(),
    suppressDemoSeed: envelope.suppressDemoSeed === true,
    resetAt: typeof envelope.resetAt === "string" ? envelope.resetAt : undefined,
  };
}

export class FileConversationStore implements ConversationStore {
  constructor(private readonly filePath = getStorePath()) {}

  async load(): Promise<ConversationSnapshot> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeSnapshot(JSON.parse(raw) as ConversationSnapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyConversationSnapshot();
      }

      throw error;
    }
  }

  async save(snapshot: ConversationSnapshot): Promise<void> {
    const normalized = normalizeSnapshot({
      ...snapshot,
      updatedAt: new Date().toISOString(),
    });
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf8");
    await rm(this.filePath, { force: true });
    await rename(tempPath, this.filePath);
  }

  async list(filters?: ConversationListFilters): Promise<ConversationRecord[]> {
    const snapshot = await this.load();
    return filterConversationRecords(snapshot.conversations, filters);
  }

  async getById(id: string): Promise<ConversationRecord | undefined> {
    const snapshot = await this.load();
    return snapshot.conversations.find((record) => record.id === id);
  }

  async getByPhone(phoneNormalized: string): Promise<ConversationRecord | undefined> {
    const snapshot = await this.load();
    return snapshot.conversations.find(
      (record) => record.phoneNormalized === phoneNormalized,
    );
  }

  async upsertConversation(conversation: Conversation): Promise<ConversationRecord> {
    const snapshot = await this.load();
    const index = snapshot.conversations.findIndex(
      (record) => record.id === conversation.id,
    );
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
      updatedAt: new Date().toISOString(),
    };
    await this.save(snapshot);
    return snapshot;
  }
}

let storeSingleton: ConversationStore | undefined;

export function getConversationStore(): ConversationStore {
  if (!storeSingleton) {
    const persistence = readHotelPersistenceConfig();
    if (persistence.conversationStoreProvider === "postgres") {
      storeSingleton = new PostgresConversationStore();
    } else if (persistence.conversationStoreProvider === "google_sheets") {
      storeSingleton = new GoogleSheetsConversationStore();
    } else {
      storeSingleton = new FileConversationStore();
    }
  }

  return storeSingleton;
}

export function resetConversationStoreForTests(): void {
  if (process.env.NODE_ENV === "test") {
    storeSingleton = undefined;
  }
}
