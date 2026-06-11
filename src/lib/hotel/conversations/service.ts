import { randomUUID } from "node:crypto";
import { buildConversationSeed } from "./demo-seed";
import {
  ClientDirectoryService,
  getClientDirectory,
  type ClientDirectory,
  type ClientIdentityResult,
  type ClientUpsertFromConfirmedReservationResult,
} from "@/lib/hotel/clients";
import {
  buildConversationReplyPlan,
  classifyConversationIntent,
  CONVERSATION_RESET_REPLY,
  isAffirmativeConfirmationUtterance,
  isConversationResetCommand,
} from "./nlu";
import {
  confirmPendingReservationProposal,
  type WhatsAppReservationBridgeDeps,
} from "./reservation-bridge";
import {
  advanceReservationChangeFlow,
  isReservationChangeFlowActive,
  startReservationChangeFlow,
} from "./reservation-change-flow";
import { isConcreteKnowledgeQuestion } from "@/lib/hotel/knowledge/faq";
import {
  advanceReservationFlow,
  isExplicitNotClientClaim,
  isReservationFlowActive,
  isReservationFlowRejection,
  startReservationFlow,
} from "./reservation-flow";
import {
  analyzeConversationIntelligence,
  buildBreedReservationReply,
  buildNeedPetCountForQuoteReply,
  buildPendingPriceQuoteFlow,
  buildPriceQuoteReply,
  buildVagueDatePrecisionReply,
  calculateNights,
  calculateQuotePrice,
  isPendingPriceQuoteFlowLive,
} from "./conversation-intelligence";
import { getConversationStore } from "./file-store";
import { filterConversationRecords, type ConversationStore } from "./store";
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

function safeConversationStoreError(error: unknown): Record<string, unknown> {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    safeErrorCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code).slice(0, 80)
        : undefined,
  };
}

function safeConversationId(value: string): string {
  return value ? `${value.slice(0, 12)}${value.length > 12 ? "…" : ""}` : "";
}

async function addEventBestEffort(
  store: ConversationStore,
  event: ConversationEvent,
  operation: string,
): Promise<ConversationEvent | undefined> {
  try {
    return await store.addEvent(event);
  } catch (error) {
    console.warn("conversation_store_post_confirmation_event_failed", {
      operation,
      conversationId: safeConversationId(event.conversationId),
      eventType: event.eventType,
      ...safeConversationStoreError(error),
    });
    return undefined;
  }
}

async function replaceConversationBestEffort(
  store: ConversationStore,
  record: ConversationRecord,
  operation: string,
): Promise<ConversationRecord | undefined> {
  try {
    return await store.replaceConversation(record);
  } catch (error) {
    console.warn("conversation_store_post_confirmation_update_failed", {
      operation,
      conversationId: safeConversationId(record.id),
      ...safeConversationStoreError(error),
    });
    return undefined;
  }
}

async function getConversationByIdBestEffort(
  store: ConversationStore,
  conversationId: string,
  fallback: ConversationRecord,
  operation: string,
): Promise<ConversationRecord> {
  try {
    return (await store.getById(conversationId)) ?? fallback;
  } catch (error) {
    console.warn("conversation_store_post_confirmation_read_failed", {
      operation,
      conversationId: safeConversationId(conversationId),
      ...safeConversationStoreError(error),
    });
    return fallback;
  }
}

async function addBotMessageBestEffort(
  store: ConversationStore,
  conversationId: string,
  body: string,
  operation: string,
): Promise<Message | undefined> {
  try {
    return await store.addMessage(
      createMessage({
        conversationId,
        direction: "outbound",
        senderType: "bot",
        body,
      }),
    );
  } catch (error) {
    console.warn("conversation_store_post_confirmation_message_failed", {
      operation,
      conversationId: safeConversationId(conversationId),
      ...safeConversationStoreError(error),
    });
    return undefined;
  }
}

function sanitizeClientIdentityPayload(identity: ClientIdentityResult): Record<string, unknown> {
  return {
    status: identity.status,
    confidence: identity.confidence,
    matchType: identity.matchType,
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
  if (!result) {
    return record;
  }

  const isDirectoryMatch = ["created", "created_pending_name", "existing"].includes(result.kind);
  const upsertStatus =
    result.kind === "existing"
      ? "existing"
      : result.kind === "created" || result.kind === "created_pending_name"
        ? "created"
        : result.kind === "failed"
          ? "failed"
          : "skipped";
  const warnings = Array.from(
    new Set([
      ...(record.clientWarnings ?? []),
      result.kind === "created_pending_name" ? "client_name_pending_review" : undefined,
      result.kind === "failed" ? "client_directory_upsert_failed" : undefined,
      result.kind.startsWith("skipped_") ? result.warning ?? result.kind : undefined,
    ].filter((warning): warning is string => Boolean(warning))),
  );

  return {
    ...record,
    customerName: isDirectoryMatch ? result.clientName ?? record.customerName : record.customerName,
    clientStatus: isDirectoryMatch ? "known" : record.clientStatus,
    clientConfidence: isDirectoryMatch ? "strong" : record.clientConfidence,
    clientMatchType: isDirectoryMatch ? "phone" : record.clientMatchType,
    clientName: isDirectoryMatch ? result.clientName ?? record.clientName : record.clientName,
    clientWarnings: warnings,
    clientSource: isDirectoryMatch ? result.source : record.clientSource,
    clientSheetName: isDirectoryMatch ? result.sheetName ?? record.clientSheetName : record.clientSheetName,
    clientSheetRow: isDirectoryMatch ? result.rowNumber ?? record.clientSheetRow : record.clientSheetRow,
    clientDirectoryUpsertKind: result.kind,
    clientDirectoryUpsertStatus: upsertStatus,
    clientDirectoryUpsertWarning: result.warning,
    tags: Array.from(
      new Set([
        ...(record.tags ?? []),
        result.kind === "existing" ? "cliente_habitual" : undefined,
        result.kind === "created" || result.kind === "created_pending_name"
          ? "cliente_creado_desde_reserva"
          : undefined,
        !isDirectoryMatch ? "revision_manual" : undefined,
      ].filter((tag): tag is string => Boolean(tag))),
    ),
  };
}

function summarizeReservationId(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length <= 8 ? "[reservation-id]" : `[reservation-id:${value.slice(-8)}]`;
}

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

function buildReservationFlowResumePrompt(record: ConversationRecord): string | undefined {
  const status = record.reservationFlow?.status;
  if (!status || !isReservationFlowActive(record)) {
    return undefined;
  }

  switch (status) {
    case "asking_client_kind":
      return "Seguimos con la reserva. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.";
    case "asking_existing_email":
      return "Seguimos con la reserva. Me falta el email para localizar tu ficha de cliente.";
    case "collecting_owner":
      return "Seguimos con la reserva. Me falta tu nombre y apellidos.";
    case "collecting_pet":
      return "Seguimos con la reserva. Me falta el nombre o los nombres de tu mascota/s.";
    case "collecting_dates":
      return "Seguimos con la reserva. Me faltan la fecha de entrada y la fecha de salida.";
    case "collecting_notes":
      return "Seguimos con la reserva. Me falta saber si hay alimentación, medicación u observaciones importantes.";
    case "collecting_visit":
      return "Seguimos con la reserva. ¿Quieres visitar el hotel antes de confirmar?";
    case "pending_availability":
      return "Seguimos con la reserva. Estoy revisando disponibilidad para poder proponértela con seguridad.";
    case "pending_confirmation":
      return "Seguimos con la reserva. Si quieres dejarla anotada, responde “sí, confirma”.";
    case "confirmed":
    case "rejected":
    case "no_availability":
      return undefined;
  }
}

function appendReservationResume(reply: string, record: ConversationRecord): string {
  const resume = buildReservationFlowResumePrompt(record);
  return resume ? `${reply}\n\n${resume}` : reply;
}

async function sendBotOutcome(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  inbound: Message;
  reply: string;
  eventType: string;
  eventPayload?: Record<string, unknown>;
}): Promise<InboundResult> {
  await input.store.replaceConversation(input.conversation);
  await input.store.addEvent(
    createEvent(input.conversation.id, input.eventType, input.eventPayload),
  );
  const botReply = await input.store.addMessage(
    createMessage({
      conversationId: input.conversation.id,
      direction: "outbound",
      senderType: "bot",
      body: input.reply,
    }),
  );

  return {
    conversation: (await input.store.getById(input.conversation.id)) ?? input.conversation,
    inbound: input.inbound,
    botReply,
    twiml: buildTwilioMessageResponse(input.reply),
  };
}

function buildQuoteOutcome(
  record: ConversationRecord,
  message: string,
  now: Date,
): { conversation: ConversationRecord; reply: string; eventPayload: Record<string, unknown> } | undefined {
  const analysis = analyzeConversationIntelligence(message, now);
  const pending = record.pendingPriceQuoteFlow;

  if (
    isPendingPriceQuoteFlowLive(record, now) &&
    analysis.petCount &&
    pending?.checkInDate &&
    pending.checkOutDate
  ) {
    const nights = calculateNights(pending.checkInDate, pending.checkOutDate);
    const estimatedPrice = calculateQuotePrice(analysis.petCount, nights);
    const conversation: ConversationRecord = {
      ...record,
      pendingPriceQuoteFlow: {
        ...pending,
        status: "quoted",
        petCount: analysis.petCount,
        petBreeds: analysis.petBreeds.length ? analysis.petBreeds : pending.petBreeds,
        nights,
        estimatedPrice,
        updatedAt: now.toISOString(),
      },
      updatedAt: nowIso(),
    };
    return {
      conversation,
      reply: buildPriceQuoteReply({
        petCount: analysis.petCount,
        checkInDate: pending.checkInDate,
        checkOutDate: pending.checkOutDate,
      }),
      eventPayload: {
        intent: "price_quote",
        source: "pending_price_quote_flow",
        petCount: analysis.petCount,
        nights,
        estimatedPrice,
      },
    };
  }

  if (analysis.intent !== "price_quote") {
    return undefined;
  }

  if (analysis.needsExactDate) {
    const conversation: ConversationRecord = {
      ...record,
      pendingPriceQuoteFlow: buildPendingPriceQuoteFlow({
        conversation: record,
        analysis,
        now,
        status: "needs_exact_date",
      }),
      updatedAt: nowIso(),
    };
    return {
      conversation,
      reply: buildVagueDatePrecisionReply(analysis),
      eventPayload: {
        intent: "price_quote",
        source: "deterministic_conversation_intelligence",
        needsExactDate: true,
        vagueDateMention: analysis.vagueDateMention?.text,
      },
    };
  }

  if (analysis.checkInDate && analysis.checkOutDate && analysis.petCount) {
    const nights = calculateNights(analysis.checkInDate, analysis.checkOutDate);
    const estimatedPrice = calculateQuotePrice(analysis.petCount, nights);
    const conversation: ConversationRecord = {
      ...record,
      pendingPriceQuoteFlow: buildPendingPriceQuoteFlow({
        conversation: record,
        analysis,
        now,
        status: "quoted",
        nights,
        estimatedPrice,
      }),
      updatedAt: nowIso(),
    };
    return {
      conversation,
      reply: buildPriceQuoteReply({
        petCount: analysis.petCount,
        checkInDate: analysis.checkInDate,
        checkOutDate: analysis.checkOutDate,
      }),
      eventPayload: {
        intent: "price_quote",
        source: "deterministic_conversation_intelligence",
        petCount: analysis.petCount,
        nights,
        estimatedPrice,
      },
    };
  }

  if (analysis.checkInDate && analysis.checkOutDate) {
    const conversation: ConversationRecord = {
      ...record,
      pendingPriceQuoteFlow: buildPendingPriceQuoteFlow({
        conversation: record,
        analysis,
        now,
        status: "collecting_pet_count",
      }),
      updatedAt: nowIso(),
    };
    return {
      conversation,
      reply: buildNeedPetCountForQuoteReply(analysis),
      eventPayload: {
        intent: "price_quote",
        source: "deterministic_conversation_intelligence",
        awaiting: "pet_count",
      },
    };
  }

  return undefined;
}

function pendingReservationContextIsLive(record: ConversationRecord, now: Date): boolean {
  return Boolean(
    record.pendingReservationContext?.status === "collecting" &&
      new Date(record.pendingReservationContext.expiresAt).getTime() > now.getTime(),
  );
}

function buildReservationIntelligenceOutcome(
  record: ConversationRecord,
  message: string,
  inbound: Message,
  now: Date,
): { conversation: ConversationRecord; reply: string; eventPayload: Record<string, unknown> } | undefined {
  const analysis = analyzeConversationIntelligence(message, now);
  const hasLiveContext = pendingReservationContextIsLive(record, now);

  if (hasLiveContext && analysis.needsExactDate) {
    const context = record.pendingReservationContext!;
    return {
      conversation: {
        ...record,
        pendingReservationContext: {
          ...context,
          checkInDate: analysis.checkInDate ?? context.checkInDate,
          checkInLabel: analysis.checkInLabel ?? context.checkInLabel,
          vagueDateMention: analysis.vagueDateMention?.text,
          needsExactDate: true,
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
        },
        updatedAt: nowIso(),
      },
      reply: buildVagueDatePrecisionReply(analysis),
      eventPayload: {
        intent: "reservation_or_availability",
        source: "pending_reservation_context",
        needsExactDate: true,
        vagueDateMention: analysis.vagueDateMention?.text,
      },
    };
  }

  if (
    analysis.intent !== "reservation_or_availability" ||
    (!analysis.petBreeds.length && !analysis.needsExactDate)
  ) {
    return undefined;
  }

  return {
    conversation: {
      ...record,
      pendingReservationContext: {
        contextId: record.pendingReservationContext?.contextId ?? createId("pending_reservation_context"),
        conversationId: record.id,
        phoneNormalized: record.phoneNormalized,
        status: "collecting",
        source: "whatsapp",
        requestedAt: record.pendingReservationContext?.requestedAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
        requestedFields: ["dates"],
        createdFromMessageId: record.pendingReservationContext?.createdFromMessageId ?? inbound.id,
        petCount: analysis.petCount,
        petBreeds: analysis.petBreeds,
        checkInDate: analysis.checkInDate,
        checkInLabel: analysis.checkInLabel,
        vagueDateMention: analysis.vagueDateMention?.text,
        needsExactDate: analysis.needsExactDate,
      },
      updatedAt: nowIso(),
    },
    reply: buildBreedReservationReply(analysis),
    eventPayload: {
      intent: "reservation_or_availability",
      source: "deterministic_conversation_intelligence",
      petCount: analysis.petCount,
      petBreeds: analysis.petBreeds,
      needsExactDate: analysis.needsExactDate,
      matchedSignals: analysis.matchedSignals,
    },
  };
}

async function sendReservationChangeOutcome(input: {
  store: ConversationStore;
  outcome: Awaited<ReturnType<typeof startReservationChangeFlow>>;
  inbound: Message;
}): Promise<InboundResult> {
  await input.store.replaceConversation(input.outcome.conversation);
  await input.store.addEvent(
    createEvent(
      input.outcome.conversation.id,
      input.outcome.eventType,
      input.outcome.eventPayload,
    ),
  );
  if (input.outcome.handoff) {
    await input.store.addEvent(
      createEvent(input.outcome.conversation.id, "human_requested", {
        matchedFrom: "reservation_change_flow",
        reason: input.outcome.eventType,
      }),
    );
  }
  const botReply = await input.store.addMessage(
    createMessage({
      conversationId: input.outcome.conversation.id,
      direction: "outbound",
      senderType: "bot",
      body: input.outcome.reply,
    }),
  );

  return {
    conversation:
      (await input.store.getById(input.outcome.conversation.id)) ?? input.outcome.conversation,
    inbound: input.inbound,
    botReply,
    twiml: buildTwilioMessageResponse(input.outcome.reply),
  };
}

function shouldInterruptReservationFlowWithFaq(
  record: ConversationRecord,
  message: string,
  replyPlan: ReturnType<typeof buildConversationReplyPlan>,
): boolean {
  if (replyPlan.source !== "faq_public_chat" || !isConcreteKnowledgeQuestion(message)) {
    return false;
  }

  const isUncoveredFallback =
    replyPlan.intent === "human_handoff" &&
    replyPlan.matchedSignals.includes("concrete_question_uncovered");
  if (isUncoveredFallback && !/[¿?]/.test(message)) {
    return false;
  }

  return isReservationFlowActive(record);
}

function applyClientIdentity(
  record: ConversationRecord,
  identity: ClientIdentityResult,
): ConversationRecord {
  const strongIdentity =
    identity.status === "known" &&
    identity.confidence === "strong" &&
    (identity.matchType === "phone" || identity.matchType === "email");
  const client = identity.client;
  const warnings = Array.from(new Set(identity.warnings ?? []));
  const preservedTags = (record.tags ?? []).filter(
    (tag) => !["cliente_habitual", "revision_manual", "cliente_ambiguo"].includes(tag),
  );

  return {
    ...record,
    customerName: strongIdentity && client?.nombre ? client.nombre : record.customerName,
    clientStatus: identity.status,
    clientConfidence: identity.confidence,
    clientMatchType: identity.matchType,
    clientName: strongIdentity && client?.nombre ? client.nombre : undefined,
    clientEmail: strongIdentity ? client?.email : undefined,
    clientWarnings: warnings,
    clientSource: strongIdentity || identity.status === "blocked" || identity.status === "ambiguous"
      ? identity.source
      : undefined,
    clientSheetName: strongIdentity || identity.status === "blocked" ? client?.sheetName : undefined,
    clientSheetRow: strongIdentity || identity.status === "blocked" ? client?.rowNumber : undefined,
    requiresManualReview:
      record.requiresManualReview ||
      identity.status === "blocked" ||
      identity.status === "ambiguous",
    tags: Array.from(
      new Set([
        ...preservedTags,
        strongIdentity ? "cliente_habitual" : undefined,
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

function buildResetRecord(record: ConversationRecord): ConversationRecord {
  return {
    ...record,
    mode: "bot",
    humanRequested: false,
    assignedAgent: undefined,
    pendingReservationProposal: undefined,
    pendingReservationContext: undefined,
    pendingPriceQuoteFlow: undefined,
    pendingReservationModificationFlow: undefined,
    pendingReservationCancellationFlow: undefined,
    reservationFlow: undefined,
    unreadCount: 0,
    requiresManualReview:
      record.clientStatus === "blocked" || record.clientStatus === "ambiguous",
    updatedAt: nowIso(),
  };
}

function buildUnpersistedResetResult(payload: InboundWhatsAppPayload): InboundResult {
  const normalized = normalizePhone(payload.from);
  const at = nowIso();
  const conversation: ConversationRecord = {
    id: createId("conversation_reset_unpersisted"),
    phoneE164: normalized.phoneE164,
    phoneNormalized: normalized.phoneNormalized,
    displayName: payload.displayName,
    channel: "whatsapp",
    sourceType: "whatsapp",
    mode: "bot",
    humanRequested: false,
    unreadCount: 0,
    createdAt: at,
    updatedAt: at,
    messages: [],
    events: [],
  };
  const inbound = createMessage({
    conversationId: conversation.id,
    direction: "inbound",
    senderType: "user",
    externalMessageSid: payload.messageSid,
    body: redactConversationSensitiveText(payload.body),
    rawPayload: sanitizeConversationPayload(payload.rawPayload),
  });
  const botReply = createMessage({
    conversationId: conversation.id,
    direction: "outbound",
    senderType: "bot",
    body: CONVERSATION_RESET_REPLY,
  });

  return {
    conversation,
    inbound,
    botReply,
    twiml: buildTwilioMessageResponse(CONVERSATION_RESET_REPLY),
  };
}

export async function handleGlobalResetCommand(
  payload: InboundWhatsAppPayload,
  store: ConversationStore = getConversationStore(),
): Promise<InboundResult> {
  try {
    const conversation = await getOrCreateConversation(store, payload.from, payload.displayName);
    const safeBody = redactConversationSensitiveText(payload.body);
    const inbound = await store.addMessage(createMessage({
      conversationId: conversation.id,
      direction: "inbound",
      senderType: "user",
      externalMessageSid: payload.messageSid,
      body: safeBody,
      rawPayload: sanitizeConversationPayload(payload.rawPayload),
    }));
    const latest = (await store.getById(conversation.id)) ?? conversation;
    const resetRecord = buildResetRecord(latest);
    await store.replaceConversation(resetRecord);
    await store.addEvent(
      createEvent(conversation.id, "conversation_reset_requested", {
        matchedFrom: "global_command",
        hiddenCommand: true,
        clearedPendingProposal: Boolean(latest.pendingReservationProposal),
        clearedPendingContext: Boolean(latest.pendingReservationContext),
        clearedPendingPriceQuoteFlow: Boolean(latest.pendingPriceQuoteFlow),
        clearedPendingModificationFlow: Boolean(latest.pendingReservationModificationFlow),
        clearedPendingCancellationFlow: Boolean(latest.pendingReservationCancellationFlow),
        clearedReservationFlow: Boolean(latest.reservationFlow),
        clearedHumanMode: latest.mode === "human" || latest.humanRequested,
      }),
    );
    const botReply = await store.addMessage(
      createMessage({
        conversationId: conversation.id,
        direction: "outbound",
        senderType: "bot",
        body: CONVERSATION_RESET_REPLY,
      }),
    );

    return {
      conversation: (await store.getById(conversation.id)) ?? resetRecord,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(CONVERSATION_RESET_REPLY),
    };
  } catch (error) {
    console.error("conversation_reset_command_store_failed", safeConversationStoreError(error));
    return buildUnpersistedResetResult(payload);
  }
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
  const snapshot = await store.load();
  const conversations = filterConversationRecords(snapshot.conversations, filters);
  const active = filterConversationRecords(snapshot.conversations);
  const archived = filterConversationRecords(snapshot.conversations, { mode: "archived" });

  return {
    conversations,
    stats: {
      total: active.length,
      unread: active.filter((conversation) => conversation.unreadCount > 0).length,
      pending: active.filter(
        (conversation) => conversation.humanRequested || conversation.unreadCount > 0,
      ).length,
      human: active.filter((conversation) => conversation.mode === "human").length,
      read: active.filter(
        (conversation) => conversation.unreadCount === 0 && !conversation.humanRequested,
      ).length,
      archived: archived.length,
    },
  };
}

function isStrongDirectoryConversation(record: ConversationRecord): boolean {
  return (
    record.clientStatus === "known" &&
    record.clientConfidence === "strong" &&
    (record.clientMatchType === "phone" || record.clientMatchType === "email")
  );
}

function knownClientFirstName(record: ConversationRecord): string | undefined {
  return (record.clientName ?? record.customerName)?.trim().split(/\s+/)[0];
}

function personalizeReplyWithClientName(reply: string, name?: string): string {
  if (!name) {
    return reply;
  }

  if (reply.startsWith("Buenas.")) {
    return reply.replace("Buenas.", `Buenas, ${name}.`);
  }
  if (reply.startsWith("Buenos días.")) {
    return reply.replace("Buenos días.", `Buenos días, ${name}.`);
  }
  if (reply.startsWith("Buenas tardes.")) {
    return reply.replace("Buenas tardes.", `Buenas tardes, ${name}.`);
  }
  if (reply.startsWith("Buenas noches.")) {
    return reply.replace("Buenas noches.", `Buenas noches, ${name}.`);
  }
  if (reply.startsWith("¡Hola!")) {
    return reply.replace("¡Hola!", `¡Hola, ${name}!`);
  }

  return reply;
}

export function isStrongClientIdentity(identity?: ClientIdentityResult | null): boolean {
  return Boolean(
    identity &&
      identity.status === "known" &&
      identity.confidence === "strong" &&
      (identity.matchType === "phone" || identity.matchType === "email"),
  );
}

export function knownClientFirstNameFromIdentity(
  identity?: ClientIdentityResult | null,
): string | undefined {
  if (!isStrongClientIdentity(identity)) {
    return undefined;
  }

  return identity?.client?.nombre?.trim().split(/\s+/)[0];
}

export function personalizeReplyWithClientIdentity(
  reply: string,
  identity?: ClientIdentityResult | null,
): string {
  return personalizeReplyWithClientName(reply, knownClientFirstNameFromIdentity(identity));
}

function personalizeGreetingReply(reply: string, record: ConversationRecord): string {
  if (!isStrongDirectoryConversation(record)) {
    return reply;
  }

  return personalizeReplyWithClientName(reply, knownClientFirstName(record));
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

async function confirmConversationReservation(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<{ conversation: ConversationRecord; reply: string }> {
  const latest = (await input.store.getById(input.conversation.id)) ?? input.conversation;
  const confirmation = await confirmPendingReservationProposal({
    conversation: latest,
    deps: input.deps,
  });
  await addEventBestEffort(
    input.store,
    createEvent(latest.id, "reservation_confirmation_checked", {
      kind: confirmation.kind,
      ...confirmation.eventPayload,
    }),
    "reservation_confirmation_checked",
  );

  const latestAfterEvent = (await input.store.getById(latest.id)) ?? latest;
  const updatedRecord: ConversationRecord = {
    ...latestAfterEvent,
    pendingReservationProposal:
      confirmation.proposal ?? latestAfterEvent.pendingReservationProposal,
    pendingReservationContext:
      confirmation.kind === "confirmed"
        ? undefined
        : latestAfterEvent.pendingReservationContext,
    reservationFlow:
      latestAfterEvent.reservationFlow && confirmation.kind === "confirmed"
        ? {
            ...latestAfterEvent.reservationFlow,
            status: "confirmed",
            reservationId: confirmation.reservation?.reservationId,
            updatedAt: nowIso(),
          }
        : latestAfterEvent.reservationFlow,
    reservationId:
      confirmation.reservation?.reservationId ?? latestAfterEvent.reservationId,
    sourceRecordId:
      confirmation.reservation?.reservationId ?? latestAfterEvent.sourceRecordId,
    petName:
      confirmation.reservation?.petName ?? latestAfterEvent.petName,
    mode: confirmation.handoff ? "human" : latestAfterEvent.mode,
    humanRequested: confirmation.handoff ? true : latestAfterEvent.humanRequested,
    requiresManualReview:
      latestAfterEvent.requiresManualReview || Boolean(confirmation.handoff),
    updatedAt: nowIso(),
  };
  const nextRecord = applyClientReservationUpsert(
    updatedRecord,
    confirmation.clientDirectoryUpsert,
  );
  await replaceConversationBestEffort(
    input.store,
    nextRecord,
    "reservation_confirmation_update_conversation",
  );

  if (confirmation.kind === "confirmed" && confirmation.reservation) {
    await addEventBestEffort(
      input.store,
      createEvent(latest.id, "reservation_confirmed_from_whatsapp", {
        reservationIdSummary: summarizeReservationId(confirmation.reservation.reservationId),
        proposalId: confirmation.proposal?.proposalId,
      }),
      "reservation_confirmed_from_whatsapp",
    );
  }

  if (confirmation.clientDirectoryUpsert) {
    await addEventBestEffort(
      input.store,
      createEvent(
        latest.id,
        clientUpsertEventType(confirmation.clientDirectoryUpsert),
        sanitizeClientUpsertPayload(confirmation.clientDirectoryUpsert),
      ),
      "client_directory_upsert_result",
    );
  }

  if (confirmation.handoff) {
    await addEventBestEffort(
      input.store,
      createEvent(latest.id, "human_requested", {
        matchedFrom: "reservation_bridge",
        reason: confirmation.kind,
      }),
      "reservation_confirmation_handoff",
    );
  }

  return {
    conversation: await getConversationByIdBestEffort(
      input.store,
      latest.id,
      nextRecord,
      "reservation_confirmation_final_read",
    ),
    reply: confirmation.reply,
  };
}

export async function handleInboundWhatsApp(
  payload: InboundWhatsAppPayload,
  store: ConversationStore = getConversationStore(),
  clientDirectory: ClientDirectory = getClientDirectory(),
  reservationBridgeDeps?: WhatsAppReservationBridgeDeps,
): Promise<InboundResult> {
  const safeBody = redactConversationSensitiveText(payload.body);

  if (isConversationResetCommand(safeBody)) {
    return handleGlobalResetCommand(payload, store);
  }

  const conversation = await getOrCreateConversation(store, payload.from, payload.displayName);
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

  const latestBeforeFlow = (await store.getById(freshWithClient.id)) ?? freshWithClient;
  if (isReservationChangeFlowActive(latestBeforeFlow)) {
    const changePlan = buildConversationReplyPlan(safeBody);
    const outcome = await advanceReservationChangeFlow({
      conversation: latestBeforeFlow,
      message: safeBody,
      replyPlan: changePlan,
      deps: reservationBridgeDeps,
    });

    if (outcome) {
      await store.addEvent(
        createEvent(latestBeforeFlow.id, "nlu_classified", {
          intent: changePlan.intent,
          confidence: changePlan.confidence,
          matchedSignals: changePlan.matchedSignals,
          slots: changePlan.slots,
          source: changePlan.source,
          activeReservationChangeFlow: true,
        }),
      );
      return sendReservationChangeOutcome({
        store,
        outcome,
        inbound,
      });
    }
  }

  if (isReservationFlowActive(latestBeforeFlow)) {
    const flowInterruptionPlan = buildConversationReplyPlan(safeBody);
    if (shouldInterruptReservationFlowWithFaq(latestBeforeFlow, safeBody, flowInterruptionPlan)) {
      await store.addEvent(
        createEvent(latestBeforeFlow.id, "nlu_classified", {
          intent: flowInterruptionPlan.intent,
          confidence: flowInterruptionPlan.confidence,
          matchedSignals: flowInterruptionPlan.matchedSignals,
          slots: flowInterruptionPlan.slots,
          source: flowInterruptionPlan.source,
          handoff: flowInterruptionPlan.handoff,
          interruptedReservationFlow: latestBeforeFlow.reservationFlow?.status,
        }),
      );

      const latestForFaq = (await store.getById(latestBeforeFlow.id)) ?? latestBeforeFlow;
      const replyBody = flowInterruptionPlan.handoff
        ? flowInterruptionPlan.reply
        : appendReservationResume(flowInterruptionPlan.reply, latestForFaq);
      const nextConversation: ConversationRecord = flowInterruptionPlan.handoff
        ? {
            ...latestForFaq,
            mode: "human",
            humanRequested: true,
            requiresManualReview: true,
            updatedAt: nowIso(),
          }
        : latestForFaq;

      if (flowInterruptionPlan.handoff) {
        await store.replaceConversation(nextConversation);
        await store.addEvent(
          createEvent(latestForFaq.id, "human_requested", {
            matchedFrom: "faq_public_chat",
            intent: flowInterruptionPlan.intent,
          }),
        );
      }

      const botReply = await store.addMessage(
        createMessage({
          conversationId: latestForFaq.id,
          direction: "outbound",
          senderType: "bot",
          body: replyBody,
        }),
      );
      await store.addEvent(
        createEvent(latestForFaq.id, "bot_reply_sent", {
          source: flowInterruptionPlan.source,
          intent: flowInterruptionPlan.intent,
          resumedReservationFlow: !flowInterruptionPlan.handoff,
        }),
      );

      return {
        conversation: (await store.getById(latestForFaq.id)) ?? nextConversation,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(replyBody),
      };
    }

    if (
      latestBeforeFlow.reservationFlow?.status === "pending_confirmation" &&
      isAffirmativeConfirmationUtterance(safeBody)
    ) {
      const confirmed = await confirmConversationReservation({
        store,
        conversation: latestBeforeFlow,
        deps: reservationBridgeDeps,
      });
      const botReply = await addBotMessageBestEffort(
        store,
        latestBeforeFlow.id,
        confirmed.reply,
        "reservation_flow_confirmation_reply",
      );

      return {
        conversation: await getConversationByIdBestEffort(
          store,
          latestBeforeFlow.id,
          confirmed.conversation,
          "reservation_flow_confirmation_return_read",
        ),
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(confirmed.reply),
      };
    }

    if (
      latestBeforeFlow.reservationFlow?.status === "pending_confirmation" &&
      isReservationFlowRejection(safeBody)
    ) {
      const rejected: ConversationRecord = {
        ...latestBeforeFlow,
        pendingReservationProposal: latestBeforeFlow.pendingReservationProposal
          ? {
              ...latestBeforeFlow.pendingReservationProposal,
              status: "cancelled",
              failureReason: "customer_rejected",
            }
          : undefined,
        reservationFlow: latestBeforeFlow.reservationFlow
          ? {
              ...latestBeforeFlow.reservationFlow,
              status: "rejected",
              updatedAt: nowIso(),
            }
          : undefined,
        updatedAt: nowIso(),
      };
      await store.replaceConversation(rejected);
      await store.addEvent(
        createEvent(latestBeforeFlow.id, "reservation_flow_rejected", {
          reason: "customer_rejected",
        }),
      );
      const replyBody =
        "De acuerdo, no confirmamos la reserva. Si quieres mirar otras fechas, dime cuáles.";
      const botReply = await store.addMessage(
        createMessage({
          conversationId: latestBeforeFlow.id,
          direction: "outbound",
          senderType: "bot",
          body: replyBody,
        }),
      );
      return {
        conversation: (await store.getById(latestBeforeFlow.id)) ?? rejected,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(replyBody),
      };
    }

    const reservationIntelligence = buildReservationIntelligenceOutcome(
      latestBeforeFlow,
      safeBody,
      inbound,
      reservationBridgeDeps?.now?.() ?? new Date(),
    );
    if (reservationIntelligence) {
      return sendBotOutcome({
        store,
        conversation: reservationIntelligence.conversation,
        inbound,
        reply: reservationIntelligence.reply,
        eventType: "reservation_context_detected",
        eventPayload: reservationIntelligence.eventPayload,
      });
    }

    const flow = await advanceReservationFlow({
      conversation: latestBeforeFlow,
      inboundMessageId: inbound.id,
      message: safeBody,
      clientDirectory,
      deps: reservationBridgeDeps,
    });

    if (flow) {
      await store.replaceConversation(flow.conversation);
      await store.addEvent(
        createEvent(flow.conversation.id, flow.eventType, flow.eventPayload),
      );
      const botReply = await store.addMessage(
        createMessage({
          conversationId: flow.conversation.id,
          direction: "outbound",
          senderType: "bot",
          body: flow.reply,
        }),
      );

      return {
        conversation: (await store.getById(flow.conversation.id)) ?? flow.conversation,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(flow.reply),
      };
    }
  }

  const latestBeforePlan = (await store.getById(freshWithClient.id)) ?? freshWithClient;
  const intelligenceNow = reservationBridgeDeps?.now?.() ?? new Date();
  const quoteOutcome = buildQuoteOutcome(latestBeforePlan, safeBody, intelligenceNow);
  if (quoteOutcome) {
    return sendBotOutcome({
      store,
      conversation: quoteOutcome.conversation,
      inbound,
      reply: quoteOutcome.reply,
      eventType: "price_quote_flow_updated",
      eventPayload: quoteOutcome.eventPayload,
    });
  }

  const reservationIntelligence = buildReservationIntelligenceOutcome(
    latestBeforePlan,
    safeBody,
    inbound,
    intelligenceNow,
  );
  if (reservationIntelligence) {
    return sendBotOutcome({
      store,
      conversation: reservationIntelligence.conversation,
      inbound,
      reply: reservationIntelligence.reply,
      eventType: "reservation_context_detected",
      eventPayload: reservationIntelligence.eventPayload,
    });
  }

  const initialReplyPlan = buildConversationReplyPlan(safeBody);
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

  if (isStrongDirectoryConversation(latestBeforePlan) && isExplicitNotClientClaim(safeBody)) {
    const replyBody =
      "He encontrado una ficha con este teléfono, así que seguimos con tu reserva. Si quieres reservar, dime el nombre de tu mascota o mascotas y las fechas.";
    await store.addEvent(
      createEvent(freshWithClient.id, "client_directory_phone_match_overrode_declaration", {
        matchType: latestBeforePlan.clientMatchType,
        confidence: latestBeforePlan.clientConfidence,
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
      conversation: (await store.getById(freshWithClient.id)) ?? latestBeforePlan,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(replyBody),
    };
  }

  if (
    replyPlan.intent === "availability_request" ||
    replyPlan.intent === "reservation_start"
  ) {
    if (latestBeforePlan.clientStatus === "ambiguous") {
      const reviewRecord: ConversationRecord = {
        ...((await store.getById(freshWithClient.id)) ?? latestBeforePlan),
        mode: "human",
        humanRequested: true,
        requiresManualReview: true,
        updatedAt: nowIso(),
      };
      await store.replaceConversation(reviewRecord);
      await store.addEvent(
        createEvent(freshWithClient.id, "human_requested", {
          matchedFrom: "client_directory",
          reason: "ambiguous_client",
        }),
      );
      const replyBody = "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.";
      const botReply = await store.addMessage(
        createMessage({
          conversationId: freshWithClient.id,
          direction: "outbound",
          senderType: "bot",
          body: replyBody,
        }),
      );
      return {
        conversation: (await store.getById(freshWithClient.id)) ?? reviewRecord,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(replyBody),
      };
    }

    const flow = startReservationFlow({
      conversation: (await store.getById(freshWithClient.id)) ?? latestBeforePlan,
      inboundMessageId: inbound.id,
      now: reservationBridgeDeps?.now?.(),
    });
    await store.replaceConversation(flow.conversation);
    await store.addEvent(
      createEvent(flow.conversation.id, flow.eventType, flow.eventPayload),
    );
    const botReply = await store.addMessage(
      createMessage({
        conversationId: flow.conversation.id,
        direction: "outbound",
        senderType: "bot",
        body: flow.reply,
      }),
    );

    return {
      conversation: (await store.getById(flow.conversation.id)) ?? flow.conversation,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(flow.reply),
    };
  }

  if (replyPlan.intent === "reservation_modify" || replyPlan.intent === "reservation_cancel") {
    const outcome = await startReservationChangeFlow({
      conversation: (await store.getById(freshWithClient.id)) ?? latestBeforePlan,
      message: safeBody,
      replyPlan,
      kind: replyPlan.intent === "reservation_cancel" ? "cancellation" : "modification",
      deps: reservationBridgeDeps,
    });
    return sendReservationChangeOutcome({
      store,
      outcome,
      inbound,
    });
  }

  if (replyPlan.intent === "reservation_confirm") {
    const confirmation = await confirmConversationReservation({
      store,
      conversation: (await store.getById(freshWithClient.id)) ?? freshWithClient,
      deps: reservationBridgeDeps,
    });

    const botReply = await addBotMessageBestEffort(
      store,
      freshWithClient.id,
      confirmation.reply,
      "nlu_reservation_confirmation_reply",
    );

    return {
      conversation: await getConversationByIdBestEffort(
        store,
        freshWithClient.id,
        confirmation.conversation,
        "nlu_reservation_confirmation_return_read",
      ),
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

  const reply = personalizeGreetingReply(
    replyPlan.reply,
    (await store.getById(freshWithClient.id)) ?? freshWithClient,
  );
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
