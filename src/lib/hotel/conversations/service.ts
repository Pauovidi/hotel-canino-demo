import { randomUUID } from "node:crypto";
import { buildConversationSeed } from "./demo-seed";
import {
  ClientDirectoryService,
  getClientDirectory,
  type ClientDirectory,
  type ClientIdentityResult,
  type ClientUpsertFromConfirmedReservationResult,
} from "@/lib/hotel/clients";
import { buildConversationReplyPlan, classifyConversationIntent } from "./nlu";
import {
  confirmPendingReservationProposal,
  createPendingReservationProposal,
  type WhatsAppReservationBridgeDeps,
} from "./reservation-bridge";
import { getConversationStore } from "./file-store";
import type { ConversationStore } from "./store";
import type {
  Conversation,
  ConversationDashboard,
  ConversationEvent,
  ConversationListFilters,
  ConversationMode,
  ConversationRecord,
  Message,
} from "./types";

export interface InboundWhatsAppPayload {
  from: string;
  to?: string;
  body: string;
  messageSid?: string;
  displayName?: string;
  rawPayload?: unknown;
}

export interface OutboundSender {
  sendText(input: { to: string; body: string }): Promise<{
    ok: boolean;
    mode: "mock" | "real";
    sid?: string;
    error?: string;
  }>;
}

export interface InboundWhatsAppHook {
  receive(payload: InboundWhatsAppPayload): Promise<InboundResult>;
}

export interface InboundResult {
  conversation: ConversationRecord;
  inbound: Message;
  botReply?: Message;
  twiml?: string;
}

export interface ManualReplyResult {
  conversation: ConversationRecord;
  message?: Message;
  ok: boolean;
  mode: "mock" | "real";
  providerSid?: string;
  error?: string;
}

export interface ManualVideoMockResult {
  conversation: ConversationRecord;
  ok: true;
  mode: "mock";
}

export interface ConversationResetResult {
  dryRun: boolean;
  conversations: number;
  messages: number;
  events: number;
  deleted: boolean;
  suppressDemoSeed: boolean;
}

export interface DemoSeedDecisionEnv {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  HOTEL_CONVERSATIONS_DEMO_SEED?: string;
  HOTEL_CONVERSATIONS_SEED_DEMO?: string;
}

export const MANUAL_REPLY_MAX_CHARS = 1200;
export const RESET_CONVERSATIONS_CONFIRMATION = "RESET_CONVERSATIONS";

const SPANISH_DOCUMENT_ID_PATTERN =
  /\b(?:dni|nif|nie)\s*(?:es|:)?\s*([XYZ]\d{7}[A-Z]|\d{8}[A-Z]|[A-Z]\d{7,8})\b|\b[XYZ]\d{7}[A-Z]\b|\b\d{8}[A-Z]\b/gi;

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function normalizePhone(input: string): { phoneE164: string; phoneNormalized: string } {
  const withoutWhatsapp = input.replace(/^whatsapp:/i, "").trim();
  const digits = withoutWhatsapp.replace(/[^\d+]/g, "");
  const e164 = digits.startsWith("+") ? digits : `+${digits.replace(/[^\d]/g, "")}`;
  const normalized = e164.replace(/[^\d]/g, "");

  return {
    phoneE164: e164,
    phoneNormalized: normalized,
  };
}

export function redactConversationSensitiveText(value: string): string {
  return value.replace(SPANISH_DOCUMENT_ID_PATTERN, "[identificador oculto]");
}

export function sanitizeConversationPayload(value: unknown): unknown {
  if (typeof value === "string") {
    return redactConversationSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeConversationPayload(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeConversationPayload(entry),
      ]),
    );
  }

  return value;
}

export function isHumanRequest(body: string): boolean {
  return classifyConversationIntent(body).intent === "human_handoff";
}

export function shouldAutoSeedConversations(
  env: DemoSeedDecisionEnv = process.env,
): boolean {
  if (
    env.HOTEL_CONVERSATIONS_DEMO_SEED === "true" ||
    env.HOTEL_CONVERSATIONS_SEED_DEMO === "true"
  ) {
    return true;
  }

  return env.NODE_ENV === "test";
}

export async function ensureDemoConversationSeed(
  store: ConversationStore = getConversationStore(),
  env: DemoSeedDecisionEnv = process.env,
): Promise<boolean> {
  const snapshot = await store.load();

  if (
    snapshot.conversations.length > 0 ||
    snapshot.suppressDemoSeed ||
    !shouldAutoSeedConversations(env)
  ) {
    return false;
  }

  await store.seed(buildConversationSeed().conversations);
  return true;
}

function createEvent(conversationId: string, eventType: string, payload?: unknown): ConversationEvent {
  return {
    id: createId("evt"),
    conversationId,
    eventType,
    type: eventType,
    label: eventType.replaceAll("_", " "),
    payload,
    createdAt: nowIso(),
    at: nowIso(),
  };
}

function sanitizeClientIdentityPayload(identity: ClientIdentityResult): Record<string, unknown> {
  return {
    status: identity.status,
    confidence: identity.confidence,
    source: identity.source,
    matchCount: identity.matches?.length ?? (identity.client ? 1 : 0),
    warnings: identity.warnings ?? [],
    rowNumber: identity.client?.rowNumber,
    sheetName: identity.client?.sheetName,
  };
}

function sanitizeClientUpsertPayload(
  result: ClientUpsertFromConfirmedReservationResult,
): Record<string, unknown> {
  return {
    kind: result.kind,
    clientStatus: result.clientStatus,
    source: result.source,
    rowNumber: result.rowNumber,
    sheetName: result.sheetName,
    matchCount: result.matchCount,
    warning: result.warning,
  };
}

function clientUpsertEventType(result: ClientUpsertFromConfirmedReservationResult): string {
  if (result.kind === "created") {
    return "client_directory_created_from_reservation";
  }
  if (result.kind === "created_pending_name") {
    return "client_directory_created_pending_name";
  }
  if (result.kind === "existing") {
    return "client_directory_existing_from_reservation";
  }
  if (result.kind === "skipped_ambiguous") {
    return "client_directory_upsert_skipped_ambiguous";
  }
  if (result.kind === "skipped_blocked") {
    return "client_directory_upsert_skipped_blocked";
  }
  if (result.kind === "skipped_invalid_phone") {
    return "client_directory_upsert_skipped_invalid_phone";
  }
  return "client_directory_upsert_failed";
}

function applyClientReservationUpsert(
  record: ConversationRecord,
  result?: ClientUpsertFromConfirmedReservationResult,
): ConversationRecord {
  if (!result || !["created", "created_pending_name", "existing"].includes(result.kind)) {
    return record;
  }

  const warnings = Array.from(
    new Set([
      ...(record.clientWarnings ?? []),
      result.kind === "created_pending_name" ? "client_name_pending_review" : undefined,
    ].filter((warning): warning is string => Boolean(warning))),
  );

  return {
    ...record,
    customerName: result.clientName ?? record.customerName,
    clientStatus: "known",
    clientConfidence: "strong",
    clientName: result.clientName ?? record.clientName,
    clientWarnings: warnings,
    clientSource: result.source,
    clientSheetName: result.sheetName ?? record.clientSheetName,
    clientSheetRow: result.rowNumber ?? record.clientSheetRow,
    tags: Array.from(new Set([...(record.tags ?? []), "cliente_habitual"])),
  };
}

function summarizeReservationId(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length <= 8 ? "[reservation-id]" : `[reservation-id:${value.slice(-8)}]`;
}

const RESERVATION_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

function pendingContextIsLive(
  record: ConversationRecord,
  now = new Date(),
): boolean {
  return (
    record.pendingReservationContext?.status === "collecting" &&
    new Date(record.pendingReservationContext.expiresAt).getTime() > now.getTime()
  );
}

function shouldTreatAsReservationSlotFill(
  record: ConversationRecord,
  replyPlan: ReturnType<typeof buildConversationReplyPlan>,
  message: string,
): boolean {
  if (replyPlan.intent !== "unknown" && replyPlan.intent !== "general_information") {
    return false;
  }

  if (!pendingContextIsLive(record)) {
    return false;
  }

  const hasUsefulSlots = Boolean(
    replyPlan.slots.petName || replyPlan.slots.checkIn || replyPlan.slots.checkOut,
  );
  return hasUsefulSlots || /\b(?:del|desde)\s+\d{1,2}\s+(?:al|hasta)\s+\d{1,2}\b/i.test(message);
}

function buildPendingReservationContext(input: {
  conversation: ConversationRecord;
  inboundMessageId: string;
}): ConversationRecord["pendingReservationContext"] {
  const now = new Date();
  return {
    contextId: createId("reservation_context"),
    conversationId: input.conversation.id,
    phoneNormalized: input.conversation.phoneNormalized,
    status: "collecting",
    source: "whatsapp",
    requestedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESERVATION_CONTEXT_TTL_MS).toISOString(),
    requestedFields: ["petName", "dates"],
    createdFromMessageId: input.inboundMessageId,
  };
}

function applyClientIdentity(
  record: ConversationRecord,
  identity: ClientIdentityResult,
): ConversationRecord {
  const strongIdentity = identity.confidence === "strong";
  const client = identity.client;
  const warnings = Array.from(new Set(identity.warnings ?? []));

  return {
    ...record,
    customerName: strongIdentity && client?.nombre ? client.nombre : record.customerName,
    clientStatus: identity.status,
    clientConfidence: identity.confidence,
    clientName: strongIdentity && client?.nombre ? client.nombre : undefined,
    clientEmail: strongIdentity ? client?.email : undefined,
    clientWarnings: warnings,
    clientSource: identity.source,
    clientSheetName: client?.sheetName,
    clientSheetRow: client?.rowNumber,
    requiresManualReview:
      record.requiresManualReview ||
      identity.status === "blocked" ||
      identity.status === "ambiguous",
    tags: Array.from(
      new Set([
        ...(record.tags ?? []),
        identity.status === "known" ? "cliente_habitual" : undefined,
        identity.status === "blocked" ? "revision_manual" : undefined,
        identity.status === "ambiguous" ? "cliente_ambiguo" : undefined,
      ].filter((tag): tag is string => Boolean(tag))),
    ),
    updatedAt: nowIso(),
  };
}

async function resolveAndPersistClientIdentity(
  store: ConversationStore,
  record: ConversationRecord,
  payload: InboundWhatsAppPayload,
  clientDirectory: ClientDirectory,
): Promise<{ conversation: ConversationRecord; identity: ClientIdentityResult }> {
  const identity = await new ClientDirectoryService(clientDirectory).resolveClientIdentity({
    phone: payload.from,
    name: payload.displayName,
  });
  const next = applyClientIdentity(record, identity);
  const conversation = await store.replaceConversation(next);

  if (identity.status === "known") {
    await store.addEvent(createEvent(record.id, "client_directory_match", sanitizeClientIdentityPayload(identity)));
  } else if (identity.status === "blocked") {
    await store.addEvent(createEvent(record.id, "client_directory_blocked", sanitizeClientIdentityPayload(identity)));
  } else if (identity.status === "ambiguous") {
    await store.addEvent(createEvent(record.id, "client_directory_ambiguous", sanitizeClientIdentityPayload(identity)));
  }

  return {
    conversation: (await store.getById(record.id)) ?? conversation,
    identity,
  };
}

function createMessage(input: Omit<Message, "id" | "createdAt" | "transport">): Message {
  return {
    ...input,
    id: createId("msg"),
    transport: "whatsapp",
    createdAt: nowIso(),
  };
}

async function getOrCreateConversation(
  store: ConversationStore,
  phone: string,
  displayName?: string,
): Promise<ConversationRecord> {
  const normalized = normalizePhone(phone);
  const existing = await store.getByPhone(normalized.phoneNormalized);

  if (existing) {
    if (existing.archivedAt) {
      const reopened = await store.replaceConversation({
        ...existing,
        archivedAt: undefined,
        archivedBy: undefined,
        archivedReason: undefined,
        updatedAt: nowIso(),
      });
      await store.addEvent(createEvent(existing.id, "conversation_reopened_from_inbound"));
      return (await store.getById(existing.id)) ?? reopened;
    }

    if (displayName && existing.displayName !== displayName) {
      return store.replaceConversation({
        ...existing,
        displayName,
        updatedAt: nowIso(),
      });
    }

    return existing;
  }

  const createdAt = nowIso();
  const conversation: Conversation = {
    id: createId("conv"),
    phoneE164: normalized.phoneE164,
    phoneNormalized: normalized.phoneNormalized,
    displayName,
    sourceType: "whatsapp",
    channel: "whatsapp",
    status: "open",
    priority: "normal",
    tags: [],
    mode: "bot",
    humanRequested: false,
    unreadCount: 0,
    createdAt,
    updatedAt: createdAt,
  };

  const record = await store.upsertConversation(conversation);
  await store.addEvent(createEvent(record.id, "conversation_created", { sourceType: "whatsapp" }));
  return (await store.getById(record.id)) ?? record;
}

export function createMockInboundWhatsAppHook(
  store: ConversationStore = getConversationStore(),
): InboundWhatsAppHook {
  return {
    receive(payload) {
      return handleInboundWhatsApp(payload, store);
    },
  };
}

export function createRealInboundWhatsAppHook(
  store: ConversationStore = getConversationStore(),
): InboundWhatsAppHook {
  return {
    receive(payload) {
      return handleInboundWhatsApp(payload, store);
    },
  };
}

export async function listConversationDashboard(
  filters?: ConversationListFilters,
  store: ConversationStore = getConversationStore(),
): Promise<ConversationDashboard> {
  await ensureDemoConversationSeed(store);
  const conversations = await store.list(filters);
  const all = await store.list();
  const snapshot = await store.load();

  return {
    conversations,
    stats: {
      total: all.length,
      unread: all.filter((conversation) => conversation.unreadCount > 0).length,
      pending: all.filter(
        (conversation) => conversation.humanRequested || conversation.unreadCount > 0,
      ).length,
      human: all.filter((conversation) => conversation.mode === "human").length,
      read: all.filter(
        (conversation) => conversation.unreadCount === 0 && !conversation.humanRequested,
      ).length,
      archived: snapshot.conversations.filter((conversation) => conversation.archivedAt).length,
    },
  };
}

export async function resetConversations(
  options: { dryRun?: boolean; confirm?: string } = {},
  store: ConversationStore = getConversationStore(),
): Promise<ConversationResetResult> {
  const snapshot = await store.load();
  const metrics = {
    conversations: snapshot.conversations.length,
    messages: snapshot.conversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0,
    ),
    events: snapshot.conversations.reduce(
      (total, conversation) => total + conversation.events.length,
      0,
    ),
  };

  if (options.dryRun) {
    return {
      dryRun: true,
      ...metrics,
      deleted: false,
      suppressDemoSeed: Boolean(snapshot.suppressDemoSeed),
    };
  }

  if (options.confirm !== RESET_CONVERSATIONS_CONFIRMATION) {
    throw new Error("RESET_CONVERSATIONS confirmation is required.");
  }

  const resetAt = nowIso();
  await store.save({
    conversations: [],
    updatedAt: resetAt,
    resetAt,
    suppressDemoSeed: true,
  });

  return {
    dryRun: false,
    ...metrics,
    deleted: true,
    suppressDemoSeed: true,
  };
}

export async function getConversation(
  id: string,
  store: ConversationStore = getConversationStore(),
) {
  return store.getById(id);
}

export async function handleInboundWhatsApp(
  payload: InboundWhatsAppPayload,
  store: ConversationStore = getConversationStore(),
  clientDirectory: ClientDirectory = getClientDirectory(),
  reservationBridgeDeps?: WhatsAppReservationBridgeDeps,
): Promise<InboundResult> {
  const conversation = await getOrCreateConversation(store, payload.from, payload.displayName);
  const safeBody = redactConversationSensitiveText(payload.body);
  if (payload.messageSid) {
    const existing = conversation.messages.find(
      (message) => message.externalMessageSid === payload.messageSid,
    );

    if (existing) {
      return {
        conversation,
        inbound: existing,
        twiml: buildTwilioMessageResponse(),
      };
    }
  }

  const fresh = (await store.getById(conversation.id)) ?? conversation;
  const clientIdentity = await resolveAndPersistClientIdentity(
    store,
    fresh,
    payload,
    clientDirectory,
  );
  const freshWithClient = clientIdentity.conversation;
  const commandPlan = buildConversationReplyPlan(safeBody);

  if (commandPlan.intent === "conversation_reset") {
    const virtualInbound = createMessage({
      conversationId: freshWithClient.id,
      direction: "inbound",
      senderType: "user",
      externalMessageSid: payload.messageSid,
      body: safeBody,
      rawPayload: sanitizeConversationPayload(payload.rawPayload),
    });
    const latest = (await store.getById(freshWithClient.id)) ?? freshWithClient;

    if (clientIdentity.identity.status === "blocked") {
      const replyBody =
        "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.";
      const humanRecord: ConversationRecord = {
        ...latest,
        mode: "human",
        humanRequested: true,
        priority: "urgent",
        requiresManualReview: true,
        unreadCount: 0,
        updatedAt: nowIso(),
      };
      await store.replaceConversation(humanRecord);
      return {
        conversation: (await store.getById(freshWithClient.id)) ?? humanRecord,
        inbound: virtualInbound,
        twiml: buildTwilioMessageResponse(replyBody),
      };
    }

    const resetRecord: ConversationRecord = {
      ...latest,
      mode: "bot",
      humanRequested: false,
      assignedAgent: undefined,
      pendingReservationProposal: undefined,
      pendingReservationContext: undefined,
      unreadCount: 0,
      requiresManualReview:
        latest.clientStatus === "blocked" || latest.clientStatus === "ambiguous",
      updatedAt: nowIso(),
    };
    await store.replaceConversation(resetRecord);
    await store.addEvent(
      createEvent(freshWithClient.id, "conversation_reset_requested", {
        matchedFrom: "nlu",
        hiddenCommand: true,
        clearedPendingProposal: Boolean(latest.pendingReservationProposal),
        clearedPendingContext: Boolean(latest.pendingReservationContext),
      }),
    );

    return {
      conversation: (await store.getById(freshWithClient.id)) ?? resetRecord,
      inbound: virtualInbound,
      twiml: buildTwilioMessageResponse(commandPlan.reply),
    };
  }

  const inbound = await store.addMessage(
    createMessage({
      conversationId: freshWithClient.id,
      direction: "inbound",
      senderType: "user",
      externalMessageSid: payload.messageSid,
      body: safeBody,
      rawPayload: sanitizeConversationPayload(payload.rawPayload),
    }),
  );

  const freshAfterInbound = (await store.getById(freshWithClient.id)) ?? freshWithClient;

  if (clientIdentity.identity.status === "blocked") {
    const replyBody =
      "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.";
    const humanRecord: ConversationRecord = {
      ...freshAfterInbound,
      mode: "human",
      humanRequested: true,
      priority: "urgent",
      requiresManualReview: true,
      updatedAt: nowIso(),
    };
    await store.replaceConversation(humanRecord);
    const botReply = await store.addMessage(
      createMessage({
        conversationId: freshAfterInbound.id,
        direction: "outbound",
        senderType: "bot",
        body: replyBody,
      }),
    );

    return {
      conversation: (await store.getById(freshAfterInbound.id)) ?? humanRecord,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(replyBody),
    };
  }

  if (freshWithClient.mode === "human") {
    await store.addEvent(createEvent(freshWithClient.id, "auto_reply_skipped_human_mode"));
    return {
      conversation: (await store.getById(freshWithClient.id)) ?? freshWithClient,
      inbound,
    };
  }

  const initialReplyPlan = buildConversationReplyPlan(safeBody);
  const latestBeforePlan = (await store.getById(freshWithClient.id)) ?? freshWithClient;
  const replyPlan = shouldTreatAsReservationSlotFill(
    latestBeforePlan,
    initialReplyPlan,
    safeBody,
  )
    ? {
        ...initialReplyPlan,
        intent: "availability_request" as const,
        confidence: "medium" as const,
        matchedSignals: [
          ...initialReplyPlan.matchedSignals,
          "contextual_reservation_slot_fill",
        ],
      }
    : initialReplyPlan;
  await store.addEvent(
    createEvent(freshWithClient.id, "nlu_classified", {
      intent: replyPlan.intent,
      confidence: replyPlan.confidence,
      matchedSignals: replyPlan.matchedSignals,
      slots: replyPlan.slots,
      source: replyPlan.source,
      handoff: replyPlan.handoff,
    }),
  );

  if (
    replyPlan.intent === "availability_request" ||
    replyPlan.intent === "reservation_start"
  ) {
    const proposalOutcome = await createPendingReservationProposal({
      conversation: freshWithClient,
      inboundMessageId: inbound.id,
      message: safeBody,
      nlu: replyPlan,
      deps: reservationBridgeDeps,
    });
    await store.addEvent(
      createEvent(freshWithClient.id, "reservation_proposal_checked", {
        kind: proposalOutcome.kind,
        ...proposalOutcome.eventPayload,
      }),
    );

    const proposalRecord: ConversationRecord = {
      ...((await store.getById(freshWithClient.id)) ?? freshWithClient),
      pendingReservationProposal:
        proposalOutcome.proposal ??
        ((await store.getById(freshWithClient.id)) ?? freshWithClient).pendingReservationProposal,
      pendingReservationContext:
        proposalOutcome.kind === "missing_data"
          ? buildPendingReservationContext({
              conversation: freshWithClient,
              inboundMessageId: inbound.id,
            })
          : proposalOutcome.proposal
            ? undefined
            : ((await store.getById(freshWithClient.id)) ?? freshWithClient)
                .pendingReservationContext,
      petName:
        proposalOutcome.proposal?.petName ??
        ((await store.getById(freshWithClient.id)) ?? freshWithClient).petName,
      mode: proposalOutcome.handoff ? "human" : freshWithClient.mode,
      humanRequested: proposalOutcome.handoff ? true : freshWithClient.humanRequested,
      requiresManualReview:
        ((await store.getById(freshWithClient.id)) ?? freshWithClient).requiresManualReview ||
        Boolean(proposalOutcome.handoff),
      updatedAt: nowIso(),
    };
    await store.replaceConversation(proposalRecord);

    if (proposalOutcome.proposal) {
      await store.addEvent(
        createEvent(freshWithClient.id, "reservation_proposal_created", {
          proposalId: proposalOutcome.proposal.proposalId,
          petName: proposalOutcome.proposal.petName,
          checkIn: proposalOutcome.proposal.checkIn,
          checkOut: proposalOutcome.proposal.checkOut,
          expiresAt: proposalOutcome.proposal.expiresAt,
        }),
      );
    } else if (proposalOutcome.kind === "missing_data") {
      await store.addEvent(
        createEvent(freshWithClient.id, "reservation_context_detected", {
          reason: proposalOutcome.eventPayload?.reason,
          requestedFields: ["petName", "dates"],
        }),
      );
    }

    if (proposalOutcome.handoff) {
      await store.addEvent(
        createEvent(freshWithClient.id, "human_requested", {
          matchedFrom: "reservation_bridge",
          reason: proposalOutcome.kind,
        }),
      );
    }

    const botReply = await store.addMessage(
      createMessage({
        conversationId: freshWithClient.id,
        direction: "outbound",
        senderType: "bot",
        body: proposalOutcome.reply,
      }),
    );

    return {
      conversation: (await store.getById(freshWithClient.id)) ?? proposalRecord,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(proposalOutcome.reply),
    };
  }

  if (replyPlan.intent === "reservation_confirm") {
    const latest = (await store.getById(freshWithClient.id)) ?? freshWithClient;
    const confirmation = await confirmPendingReservationProposal({
      conversation: latest,
      deps: reservationBridgeDeps,
    });
    await store.addEvent(
      createEvent(freshWithClient.id, "reservation_confirmation_checked", {
        kind: confirmation.kind,
        ...confirmation.eventPayload,
      }),
    );

    const updatedRecord: ConversationRecord = {
      ...((await store.getById(freshWithClient.id)) ?? latest),
      pendingReservationProposal:
        confirmation.proposal ??
        ((await store.getById(freshWithClient.id)) ?? latest).pendingReservationProposal,
      pendingReservationContext:
        confirmation.kind === "confirmed"
          ? undefined
          : ((await store.getById(freshWithClient.id)) ?? latest).pendingReservationContext,
      reservationId:
        confirmation.reservation?.reservationId ??
        ((await store.getById(freshWithClient.id)) ?? latest).reservationId,
      sourceRecordId:
        confirmation.reservation?.reservationId ??
        ((await store.getById(freshWithClient.id)) ?? latest).sourceRecordId,
      petName:
        confirmation.reservation?.petName ??
        ((await store.getById(freshWithClient.id)) ?? latest).petName,
      mode: confirmation.handoff ? "human" : latest.mode,
      humanRequested: confirmation.handoff ? true : latest.humanRequested,
      requiresManualReview:
        ((await store.getById(freshWithClient.id)) ?? latest).requiresManualReview ||
        Boolean(confirmation.handoff),
      updatedAt: nowIso(),
    };
    await store.replaceConversation(
      applyClientReservationUpsert(updatedRecord, confirmation.clientDirectoryUpsert),
    );

    if (confirmation.kind === "confirmed" && confirmation.reservation) {
      await store.addEvent(
        createEvent(freshWithClient.id, "reservation_confirmed_from_whatsapp", {
          reservationIdSummary: summarizeReservationId(confirmation.reservation.reservationId),
          proposalId: confirmation.proposal?.proposalId,
        }),
      );
    }

    if (confirmation.clientDirectoryUpsert) {
      await store.addEvent(
        createEvent(
          freshWithClient.id,
          clientUpsertEventType(confirmation.clientDirectoryUpsert),
          sanitizeClientUpsertPayload(confirmation.clientDirectoryUpsert),
        ),
      );
    }

    if (confirmation.handoff) {
      await store.addEvent(
        createEvent(freshWithClient.id, "human_requested", {
          matchedFrom: "reservation_bridge",
          reason: confirmation.kind,
        }),
      );
    }

    const botReply = await store.addMessage(
      createMessage({
        conversationId: freshWithClient.id,
        direction: "outbound",
        senderType: "bot",
        body: confirmation.reply,
      }),
    );

    return {
      conversation: (await store.getById(freshWithClient.id)) ?? updatedRecord,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(confirmation.reply),
    };
  }

  if (replyPlan.handoff) {
    const replyBody = replyPlan.reply;
    const latestForHandoff = (await store.getById(freshWithClient.id)) ?? freshAfterInbound;
    const humanRecord: ConversationRecord = {
      ...latestForHandoff,
      mode: "human",
      humanRequested: true,
      updatedAt: nowIso(),
    };
    await store.replaceConversation(humanRecord);
    await store.addEvent(
      createEvent(freshWithClient.id, "human_requested", {
        matchedFrom: "nlu",
        intent: replyPlan.intent,
      }),
    );
    const botReply = await store.addMessage(
      createMessage({
        conversationId: freshWithClient.id,
        direction: "outbound",
        senderType: "bot",
        body: replyBody,
      }),
    );

    return {
      conversation: (await store.getById(fresh.id)) ?? humanRecord,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(replyBody),
    };
  }

  const reply = replyPlan.reply;
  const botReply = await store.addMessage(
    createMessage({
      conversationId: freshWithClient.id,
      direction: "outbound",
      senderType: "bot",
      body: reply,
    }),
  );
  await store.addEvent(
    createEvent(freshWithClient.id, "bot_reply_sent", {
      source: replyPlan.source,
      intent: replyPlan.intent,
    }),
  );

  return {
    conversation: (await store.getById(freshWithClient.id)) ?? freshWithClient,
    inbound,
    botReply,
    twiml: buildTwilioMessageResponse(reply),
  };
}

export async function sendManualReply(
  id: string,
  body: string,
  sender: OutboundSender,
  agent = "admin",
  store: ConversationStore = getConversationStore(),
): Promise<ManualReplyResult> {
  const record = await store.getById(id);

  if (!record) {
    throw new Error("Conversation not found");
  }

  const sent = await sender.sendText({ to: record.phoneE164, body });

  if (!sent.ok) {
    await store.addEvent(
      createEvent(id, "manual_reply_failed", {
        mode: sent.mode,
        error: sent.error ?? "unknown_error",
      }),
    );
    return {
      conversation: (await store.getById(id)) ?? record,
      ok: false,
      mode: sent.mode,
      error: sent.error ?? "No se pudo enviar WhatsApp.",
    };
  }

  const message = await store.addMessage(
    createMessage({
      conversationId: id,
      direction: "outbound",
      senderType: "human",
      externalMessageSid: sent.sid,
      body,
    }),
  );

  const updated = await store.replaceConversation({
    ...((await store.getById(id)) ?? record),
    mode: "human",
    assignedAgent: agent,
    unreadCount: 0,
    humanRequested: false,
    lastOutboundAt: message.createdAt,
    updatedAt: message.createdAt,
  });
  await store.addEvent(
    createEvent(id, "manual_reply_sent", {
      agent,
      mode: sent.mode,
      providerSid: sent.sid,
    }),
  );

  return {
    conversation: (await store.getById(id)) ?? updated,
    message,
    ok: true,
    mode: sent.mode,
    providerSid: sent.sid,
  };
}

export async function requestManualVideoMock(
  id: string,
  agent = "admin",
  store: ConversationStore = getConversationStore(),
): Promise<ManualVideoMockResult> {
  const record = await store.getById(id);

  if (!record) {
    throw new Error("Conversation not found");
  }

  await store.addEvent(
    createEvent(id, "media_attachment_mock_requested", {
      agent,
      mediaKind: "video",
      storage: "pending_object_storage",
      outbound: "not_sent",
    }),
  );

  const updated = await store.replaceConversation({
    ...((await store.getById(id)) ?? record),
    mode: "human",
    assignedAgent: agent,
    updatedAt: nowIso(),
  });

  return {
    conversation: (await store.getById(id)) ?? updated,
    ok: true,
    mode: "mock",
  };
}

export async function setConversationMode(
  id: string,
  mode: ConversationMode,
  agent = "admin",
  store: ConversationStore = getConversationStore(),
) {
  const record = await store.getById(id);

  if (!record) {
    throw new Error("Conversation not found");
  }

  const updated = await store.replaceConversation({
    ...record,
    mode,
    humanRequested: mode === "human" ? record.humanRequested : false,
    assignedAgent: mode === "human" ? agent : undefined,
    updatedAt: nowIso(),
  });
  await store.addEvent(createEvent(id, "mode_changed", { mode, agent }));
  return (await store.getById(id)) ?? updated;
}

export async function markConversationRead(
  id: string,
  store: ConversationStore = getConversationStore(),
) {
  const record = await store.getById(id);

  if (!record) {
    throw new Error("Conversation not found");
  }

  const updated = await store.replaceConversation({
    ...record,
    unreadCount: 0,
    humanRequested: false,
    updatedAt: nowIso(),
  });
  await store.addEvent(createEvent(id, "marked_read"));
  return (await store.getById(id)) ?? updated;
}

export async function archiveConversation(
  id: string,
  agent = "admin",
  reason?: string,
  store: ConversationStore = getConversationStore(),
) {
  const record = await store.getById(id);

  if (!record) {
    throw new Error("Conversation not found");
  }

  const archivedAt = nowIso();
  const updated = await store.replaceConversation({
    ...record,
    archivedAt,
    archivedBy: agent,
    archivedReason: reason?.slice(0, 180),
    updatedAt: archivedAt,
  });
  await store.addEvent(
    createEvent(id, "conversation_archived", {
      agent,
      reason: reason?.slice(0, 180),
    }),
  );
  return (await store.getById(id)) ?? updated;
}

export async function unarchiveConversation(
  id: string,
  agent = "admin",
  store: ConversationStore = getConversationStore(),
) {
  const record = await store.getById(id);

  if (!record) {
    throw new Error("Conversation not found");
  }

  const updated = await store.replaceConversation({
    ...record,
    archivedAt: undefined,
    archivedBy: undefined,
    archivedReason: undefined,
    updatedAt: nowIso(),
  });
  await store.addEvent(createEvent(id, "conversation_unarchived", { agent }));
  return (await store.getById(id)) ?? updated;
}

export function buildTwilioMessageResponse(message?: string): string {
  if (!message) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }

  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}
