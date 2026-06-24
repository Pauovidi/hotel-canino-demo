import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import type { ReservationRecord } from "@/lib/hotel/domain/contracts";
import { sendTwilioWhatsAppText } from "@/lib/hotel/twilio/client";
import { renderBathOfferTemplate } from "./client-templates";
import { getConversationStore } from "./file-store";
import type { ConversationStore } from "./store";
import type { ConversationRecord } from "./types";

export type ScheduledMessageType =
  | "reservation_prearrival_reminder"
  | "post_stay_followup"
  | "bath_offer_after_confirmation"
  | "positive_review_request"
  | "reservation_denial_followup";

export type ScheduledMessageStatus =
  | "pending"
  | "processing"
  | "sent"
  | "dry_run"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ScheduledMessage {
  id: string;
  type: ScheduledMessageType;
  conversationId?: string;
  reservationId?: string;
  channel: "whatsapp";
  externalUserId?: string;
  phoneHash?: string;
  payload: Record<string, unknown>;
  scheduledAt: string;
  status: ScheduledMessageStatus;
  attempts: number;
  maxAttempts: number;
  lastErrorCode?: string;
  dedupeKey: string;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface ScheduledMessageStore {
  upsert(message: ScheduledMessage): Promise<ScheduledMessage>;
  listDue(input: { now: Date; limit?: number }): Promise<ScheduledMessage[]>;
  mark(input: {
    id: string;
    status: ScheduledMessageStatus;
    now: Date;
    lastErrorCode?: string;
    sentAt?: string;
  }): Promise<ScheduledMessage | undefined>;
  getByDedupeKey?(dedupeKey: string): Promise<ScheduledMessage | undefined>;
}

export interface ScheduledMessagesConfig {
  scheduledMessagesEnabled: boolean;
  scheduledMessagesDryRun: boolean;
  bathOfferEnabled: boolean;
  bathOfferDryRun: boolean;
  bathOfferDelayMinutes: number;
  reservationReminderEnabled: boolean;
  reservationReminderDryRun: boolean;
  reservationReminderDaysBefore: number;
  postStayFollowupEnabled: boolean;
  postStayFollowupDryRun: boolean;
  postStayFollowupDaysAfter: number;
  waitlistEnabled: boolean;
  waitlistDryRun: boolean;
}

export interface ScheduledMessageDispatchResult {
  ok: boolean;
  dryRunOnly: boolean;
  due: number;
  sent: number;
  dryRun: number;
  failed: number;
  skipped: number;
  processedIds: string[];
}

let poolSingleton: Pool | undefined;
const memoryStoreSingleton = new Map<string, ScheduledMessage>();

function readBooleanEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  fallback: boolean,
): boolean {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    }
  }

  return fallback;
}

function readNumberEnv(
  env: NodeJS.ProcessEnv,
  names: string[],
  fallback: number,
): number {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  }

  return fallback;
}

export function readScheduledMessagesConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScheduledMessagesConfig {
  return {
    scheduledMessagesEnabled: readBooleanEnv(env, ["HOTEL_SCHEDULED_MESSAGES_ENABLED"], false),
    scheduledMessagesDryRun: readBooleanEnv(env, ["HOTEL_SCHEDULED_MESSAGES_DRY_RUN"], true),
    bathOfferEnabled: readBooleanEnv(env, ["HOTEL_BATH_OFFER_ENABLED"], false),
    bathOfferDryRun: readBooleanEnv(env, ["HOTEL_BATH_OFFER_DRY_RUN"], true),
    bathOfferDelayMinutes: Math.max(
      0,
      readNumberEnv(env, ["HOTEL_BATH_OFFER_DELAY_MINUTES"], 2),
    ),
    reservationReminderEnabled: readBooleanEnv(
      env,
      ["HOTEL_RESERVATION_REMINDER_ENABLED", "HOTEL_RESERVATION_REMINDERS_ENABLED"],
      false,
    ),
    reservationReminderDryRun: readBooleanEnv(
      env,
      ["HOTEL_RESERVATION_REMINDER_DRY_RUN", "HOTEL_RESERVATION_REMINDERS_DRY_RUN"],
      true,
    ),
    reservationReminderDaysBefore: Math.max(
      1,
      readNumberEnv(
        env,
        ["HOTEL_RESERVATION_REMINDER_DAYS_BEFORE", "HOTEL_RESERVATION_REMINDER_LEAD_DAYS"],
        5,
      ),
    ),
    postStayFollowupEnabled: readBooleanEnv(
      env,
      ["HOTEL_POST_STAY_FOLLOWUP_ENABLED", "HOTEL_POST_STAY_FOLLOWUPS_ENABLED"],
      false,
    ),
    postStayFollowupDryRun: readBooleanEnv(
      env,
      ["HOTEL_POST_STAY_FOLLOWUP_DRY_RUN", "HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN"],
      true,
    ),
    postStayFollowupDaysAfter: Math.max(
      0,
      readNumberEnv(env, ["HOTEL_POST_STAY_FOLLOWUP_DAYS_AFTER"], 1),
    ),
    waitlistEnabled: readBooleanEnv(env, ["HOTEL_WAITLIST_ENABLED"], false),
    waitlistDryRun: readBooleanEnv(env, ["HOTEL_WAITLIST_DRY_RUN"], true),
  };
}

function getPool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for Postgres scheduled messages");
  }

  poolSingleton ??= new Pool({
    connectionString: env.DATABASE_URL,
    max: Number.parseInt(env.DATABASE_POOL_MAX ?? "5", 10),
  });

  return poolSingleton;
}

function safeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).slice(0, 80)
    : error instanceof Error
      ? error.name.slice(0, 80)
      : undefined;
}

function hashPhone(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

function sanitizeScheduledPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const clone = { ...payload };
  delete clone.to;
  delete clone.phone;
  delete clone.phoneE164;
  return clone;
}

function rowToMessage(row: Record<string, unknown>): ScheduledMessage {
  return {
    id: String(row.id),
    type: row.type as ScheduledMessageType,
    conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
    reservationId: row.reservation_id ? String(row.reservation_id) : undefined,
    channel: "whatsapp",
    externalUserId: row.external_user_id ? String(row.external_user_id) : undefined,
    phoneHash: row.phone_hash ? String(row.phone_hash) : undefined,
    payload:
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {},
    scheduledAt: new Date(String(row.scheduled_at)).toISOString(),
    status: row.status as ScheduledMessageStatus,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined,
    dedupeKey: String(row.dedupe_key),
    dryRun: Boolean(row.dry_run),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : undefined,
  };
}

async function withClient<T>(
  callback: (client: PoolClient) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const client = await getPool(env).connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export class PostgresScheduledMessageStore implements ScheduledMessageStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async upsert(message: ScheduledMessage): Promise<ScheduledMessage> {
    return withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO hotel_scheduled_messages (
          id, type, conversation_id, reservation_id, channel, external_user_id,
          phone_hash, payload, scheduled_at, status, attempts, max_attempts,
          last_error_code, dedupe_key, dry_run, created_at, updated_at, sent_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (dedupe_key) DO UPDATE SET
          payload = EXCLUDED.payload,
          scheduled_at = CASE
            WHEN hotel_scheduled_messages.status IN ('pending','dry_run','failed','skipped')
              THEN EXCLUDED.scheduled_at
            ELSE hotel_scheduled_messages.scheduled_at
          END,
          dry_run = EXCLUDED.dry_run,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
        [
          message.id,
          message.type,
          message.conversationId ?? null,
          message.reservationId ?? null,
          message.channel,
          message.externalUserId ?? null,
          message.phoneHash ?? null,
          JSON.stringify(sanitizeScheduledPayload(message.payload)),
          message.scheduledAt,
          message.status,
          message.attempts,
          message.maxAttempts,
          message.lastErrorCode ?? null,
          message.dedupeKey,
          message.dryRun,
          message.createdAt,
          message.updatedAt,
          message.sentAt ?? null,
        ],
      );
      return rowToMessage(result.rows[0]);
    }, this.env);
  }

  async listDue(input: { now: Date; limit?: number }): Promise<ScheduledMessage[]> {
    return withClient(async (client) => {
      const result = await client.query(
        `SELECT *
         FROM hotel_scheduled_messages
         WHERE status = 'pending'
           AND scheduled_at <= $1
         ORDER BY scheduled_at ASC
         LIMIT $2`,
        [input.now.toISOString(), input.limit ?? 50],
      );
      return result.rows.map((row) => rowToMessage(row));
    }, this.env);
  }

  async mark(input: {
    id: string;
    status: ScheduledMessageStatus;
    now: Date;
    lastErrorCode?: string;
    sentAt?: string;
  }): Promise<ScheduledMessage | undefined> {
    return withClient(async (client) => {
      const result = await client.query(
        `UPDATE hotel_scheduled_messages
         SET status = $2,
             updated_at = $3,
             attempts = attempts + 1,
             last_error_code = $4,
             sent_at = $5
         WHERE id = $1
         RETURNING *`,
        [
          input.id,
          input.status,
          input.now.toISOString(),
          input.lastErrorCode ?? null,
          input.sentAt ?? null,
        ],
      );
      return result.rows[0] ? rowToMessage(result.rows[0]) : undefined;
    }, this.env);
  }

  async getByDedupeKey(dedupeKey: string): Promise<ScheduledMessage | undefined> {
    return withClient(async (client) => {
      const result = await client.query(
        "SELECT * FROM hotel_scheduled_messages WHERE dedupe_key = $1",
        [dedupeKey],
      );
      return result.rows[0] ? rowToMessage(result.rows[0]) : undefined;
    }, this.env);
  }
}

export class MemoryScheduledMessageStore implements ScheduledMessageStore {
  constructor(private readonly records = new Map<string, ScheduledMessage>()) {}

  async upsert(message: ScheduledMessage): Promise<ScheduledMessage> {
    const existing = Array.from(this.records.values()).find(
      (record) => record.dedupeKey === message.dedupeKey,
    );
    const next = existing
      ? {
          ...existing,
          payload: sanitizeScheduledPayload(message.payload),
          scheduledAt: ["pending", "dry_run", "failed", "skipped"].includes(existing.status)
            ? message.scheduledAt
            : existing.scheduledAt,
          dryRun: message.dryRun,
          updatedAt: message.updatedAt,
        }
      : { ...message, payload: sanitizeScheduledPayload(message.payload) };
    this.records.set(next.id, structuredClone(next));
    return structuredClone(next);
  }

  async listDue(input: { now: Date; limit?: number }): Promise<ScheduledMessage[]> {
    return Array.from(this.records.values())
      .filter(
        (record) =>
          record.status === "pending" &&
          new Date(record.scheduledAt).getTime() <= input.now.getTime(),
      )
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
      .slice(0, input.limit ?? 50)
      .map((record) => structuredClone(record));
  }

  async mark(input: {
    id: string;
    status: ScheduledMessageStatus;
    now: Date;
    lastErrorCode?: string;
    sentAt?: string;
  }): Promise<ScheduledMessage | undefined> {
    const existing = this.records.get(input.id);
    if (!existing) {
      return undefined;
    }

    const next: ScheduledMessage = {
      ...existing,
      status: input.status,
      attempts: existing.attempts + 1,
      lastErrorCode: input.lastErrorCode,
      sentAt: input.sentAt,
      updatedAt: input.now.toISOString(),
    };
    this.records.set(input.id, structuredClone(next));
    return structuredClone(next);
  }

  async getByDedupeKey(dedupeKey: string): Promise<ScheduledMessage | undefined> {
    const record = Array.from(this.records.values()).find(
      (entry) => entry.dedupeKey === dedupeKey,
    );
    return record ? structuredClone(record) : undefined;
  }
}

export function resetScheduledMessageStoreForTests(): void {
  if (process.env.NODE_ENV === "test") {
    memoryStoreSingleton.clear();
    poolSingleton?.end().catch(() => undefined);
    poolSingleton = undefined;
  }
}

export function getScheduledMessageStore(
  env: NodeJS.ProcessEnv = process.env,
): ScheduledMessageStore {
  const provider =
    env.HOTEL_SCHEDULED_MESSAGES_STORE?.trim().toLowerCase() ||
    env.HOTEL_CONVERSATIONS_STORE_PROVIDER?.trim().toLowerCase() ||
    env.HOTEL_CONVERSATIONS_STORE?.trim().toLowerCase() ||
    env.HOTEL_PERSISTENCE_PROVIDER?.trim().toLowerCase();
  if (provider === "postgres" && env.DATABASE_URL?.trim()) {
    return new PostgresScheduledMessageStore(env);
  }

  return new MemoryScheduledMessageStore(memoryStoreSingleton);
}

function petNamesFromReservation(reservation: ReservationRecord): string[] {
  return reservation.petNames?.length
    ? reservation.petNames
    : [reservation.petName ?? "tu mascota"];
}

function phoneFromReservationOrConversation(
  reservation: ReservationRecord,
  conversation: ConversationRecord,
): string | undefined {
  return reservation.phone ?? conversation.phoneE164;
}

function buildBathOfferPayload(input: {
  reservation: ReservationRecord;
  conversation: ConversationRecord;
  message: string;
}): Record<string, unknown> {
  const to = phoneFromReservationOrConversation(input.reservation, input.conversation);
  return {
    to,
    message: input.message,
    petNames: petNamesFromReservation(input.reservation),
    clientName:
      input.reservation.ownerName ??
      input.conversation.clientName ??
      input.conversation.customerName,
  };
}

export function createScheduledMessage(input: {
  type: ScheduledMessageType;
  conversationId?: string;
  reservationId?: string;
  phone?: string;
  payload: Record<string, unknown>;
  scheduledAt: Date;
  dedupeKey: string;
  dryRun: boolean;
  now?: Date;
}): ScheduledMessage {
  const now = input.now ?? new Date();
  return {
    id: `sched_${randomUUID()}`,
    type: input.type,
    conversationId: input.conversationId,
    reservationId: input.reservationId,
    channel: "whatsapp",
    externalUserId: input.phone,
    phoneHash: hashPhone(input.phone),
    payload: input.payload,
    scheduledAt: input.scheduledAt.toISOString(),
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    dedupeKey: input.dedupeKey,
    dryRun: input.dryRun,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

async function markBathOfferDeliveredBestEffort(input: {
  message: ScheduledMessage;
  status: "sent" | "dry_run";
  now: Date;
  conversationStore?: ConversationStore;
}): Promise<void> {
  if (input.message.type !== "bath_offer_after_confirmation" || !input.message.conversationId) {
    return;
  }

  const store = input.conversationStore ?? getConversationStore();
  try {
    const conversation = await store.getById(input.message.conversationId);
    if (!conversation?.pendingBathOffer) {
      return;
    }

    const updatedAt = input.now.toISOString();
    await store.replaceConversation({
      ...conversation,
      pendingBathOffer: {
        ...conversation.pendingBathOffer,
        status: "offered",
        updatedAt,
      },
      updatedAt,
    });
    await store.addEvent({
      id: `evt_${randomUUID()}`,
      conversationId: conversation.id,
      eventType: input.status === "sent" ? "bath_offer_sent" : "bath_offer_dry_run",
      type: input.status === "sent" ? "bath_offer_sent" : "bath_offer_dry_run",
      label: input.status === "sent" ? "bath offer sent" : "bath offer dry run",
      payload: {
        scheduledMessageId: input.message.id,
        reservationIdSummary: input.message.reservationId
          ? `[reservation-id:${input.message.reservationId.slice(-8)}]`
          : undefined,
      },
      createdAt: updatedAt,
      at: updatedAt,
    });
  } catch (error) {
    console.warn("bath_offer_delivery_conversation_update_failed", {
      conversationId: input.message.conversationId.slice(0, 12),
      errorName: error instanceof Error ? error.name : "UnknownError",
      safeErrorCode: safeErrorCode(error),
    });
  }
}

export async function scheduleBathOfferAfterConfirmation(input: {
  reservation: ReservationRecord;
  conversation: ConversationRecord;
  now?: Date;
  store?: ScheduledMessageStore;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  scheduled: boolean;
  dryRun: boolean;
  reason?: string;
  message?: ScheduledMessage;
}> {
  const env = input.env ?? process.env;
  const config = readScheduledMessagesConfig(env);
  if (!config.bathOfferEnabled && !config.bathOfferDryRun) {
    return {
      scheduled: false,
      dryRun: false,
      reason: "disabled",
    };
  }

  const now = input.now ?? new Date();
  const scheduledAt = new Date(now.getTime() + config.bathOfferDelayMinutes * 60 * 1000);
  const dryRun =
    config.scheduledMessagesDryRun ||
    config.bathOfferDryRun ||
    !config.scheduledMessagesEnabled ||
    !config.bathOfferEnabled;
  const store = input.store ?? getScheduledMessageStore(env);
  const body = renderBathOfferTemplate({
    petNames: petNamesFromReservation(input.reservation),
  });
  const phone = phoneFromReservationOrConversation(input.reservation, input.conversation);
  const scheduled = createScheduledMessage({
    type: "bath_offer_after_confirmation",
    conversationId: input.conversation.id,
    reservationId: input.reservation.reservationId,
    phone,
    payload: buildBathOfferPayload({
      reservation: input.reservation,
      conversation: input.conversation,
      message: body,
    }),
    scheduledAt,
    dedupeKey: `${input.reservation.reservationId}:bath_offer_after_confirmation`,
    dryRun,
    now,
  });
  const message = await store.upsert(scheduled);
  return {
    scheduled: true,
    dryRun: message.dryRun,
    message,
  };
}

export async function dispatchDueScheduledMessages(input: {
  store?: ScheduledMessageStore;
  conversationStore?: ConversationStore;
  now?: Date;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  sender?: (message: ScheduledMessage) => Promise<{ ok: boolean; mode: "mock" | "real"; sid?: string; error?: string }>;
} = {}): Promise<ScheduledMessageDispatchResult> {
  const env = input.env ?? process.env;
  const config = readScheduledMessagesConfig(env);
  const now = input.now ?? new Date();
  const store = input.store ?? getScheduledMessageStore(env);
  const due = await store.listDue({ now, limit: input.limit ?? 50 });
  const result: ScheduledMessageDispatchResult = {
    ok: true,
    dryRunOnly: config.scheduledMessagesDryRun || !config.scheduledMessagesEnabled,
    due: due.length,
    sent: 0,
    dryRun: 0,
    failed: 0,
    skipped: 0,
    processedIds: [],
  };

  for (const message of due) {
    result.processedIds.push(message.id);
    const recipient =
      message.externalUserId ??
      (typeof message.payload.to === "string" ? message.payload.to : undefined);
    const body =
      typeof message.payload.message === "string" ? message.payload.message : undefined;
    const dryRun = result.dryRunOnly || message.dryRun;

    if (!recipient || !body) {
      await store.mark({
        id: message.id,
        status: "skipped",
        now,
        lastErrorCode: "missing_recipient_or_body",
      });
      result.skipped += 1;
      continue;
    }

    if (dryRun) {
      await store.mark({
        id: message.id,
        status: "dry_run",
        now,
        lastErrorCode: "dry_run",
      });
      await markBathOfferDeliveredBestEffort({
        message,
        status: "dry_run",
        now,
        conversationStore: input.conversationStore,
      });
      result.dryRun += 1;
      continue;
    }

    try {
      const sent = input.sender
        ? await input.sender(message)
        : await sendTwilioWhatsAppText({ to: recipient, body });
      if (sent.ok && sent.mode === "real") {
        await store.mark({
          id: message.id,
          status: "sent",
          now,
          sentAt: now.toISOString(),
        });
        await markBathOfferDeliveredBestEffort({
          message,
          status: "sent",
          now,
          conversationStore: input.conversationStore,
        });
        result.sent += 1;
      } else if (sent.ok && sent.mode === "mock") {
        await store.mark({
          id: message.id,
          status: "dry_run",
          now,
          lastErrorCode: "mock_sender",
        });
        await markBathOfferDeliveredBestEffort({
          message,
          status: "dry_run",
          now,
          conversationStore: input.conversationStore,
        });
        result.dryRun += 1;
      } else {
        await store.mark({
          id: message.id,
          status: "failed",
          now,
          lastErrorCode: sent.error?.slice(0, 80) ?? "send_failed",
        });
        result.failed += 1;
      }
    } catch (error) {
      await store.mark({
        id: message.id,
        status: "failed",
        now,
        lastErrorCode: safeErrorCode(error) ?? "send_failed",
      });
      result.failed += 1;
    }
  }

  result.ok = result.failed === 0;
  return result;
}
