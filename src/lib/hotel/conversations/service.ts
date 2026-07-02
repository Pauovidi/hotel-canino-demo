import { randomUUID } from "node:crypto";
import { buildConversationSeed } from "./demo-seed";
import {
  CLIENT_DIRECTORY_SOURCE,
  ClientDirectoryService,
  getClientDirectory,
  type ClientDirectory,
  type ClientIdentityResult,
  type ClientUpsertFromConfirmedReservationResult,
} from "@/lib/hotel/clients";
import { getHotelFeatureFlags } from "@/lib/hotel/config";
import { buildGoogleSheetAdapter, buildMockSheetAdapter } from "@/lib/hotel/sheets";
import {
  buildConversationReplyPlan,
  classifyConversationIntent,
  CONVERSATION_RESET_REPLY,
  isAffirmativeConfirmationUtterance,
  isConversationResetCommand,
} from "./nlu";
import { renderConversationReplyPlan, renderCopy, type ConversationRenderKey } from "./authority/copy-renderer";
import {
  confirmPendingReservationProposal,
  type WhatsAppReservationBridgeDeps,
} from "./reservation-bridge";
import {
  buildContractAcceptanceRequest,
  CONTRACT_TERMS_VERSION,
  getClientRequestsConfig,
  isContextualContractAcceptance,
  isExplicitContractAcceptance,
  isExplicitContractRejection,
} from "./client-requests";
import {
  buildTemplatePreviewResult,
  TEMPLATE_PREVIEW_FAILED_REPLY,
} from "./template-preview";
import {
  renderBathLongHairPhotoRequestTemplate,
  renderBathPhotoReceivedTemplate,
  renderPositiveReviewRequestTemplate,
} from "./client-templates";
import {
  extractRelativeDateRange,
  matchConversationKnowledgeBase,
} from "./knowledge-base";
import {
  scheduleBathOfferAfterConfirmation,
} from "./scheduled-messages";
import {
  advanceReservationChangeFlow,
  isReservationChangeFlowActive,
  startReservationChangeFlow,
} from "./reservation-change-flow";
import { isConcreteKnowledgeQuestion } from "@/lib/hotel/knowledge/faq";
import {
  advanceReservationFlow,
  computeMissingReservationFields,
  extractReservationSlotsFromMessage,
  isExplicitNotClientClaim,
  isReservationFlowActive,
  isReservationFlowRejection,
  renderNextReservationQuestion,
  resolveReservationSlotTarget,
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
  ConversationAvailabilityInquiry,
  ConversationReservationFlow,
  Message,
  PendingReservationProposal,
} from "./types";
import type { AuthorityTurnTrace } from "./authority/types";

export interface InboundWhatsAppPayload {
  from: string;
  to?: string;
  body: string;
  messageSid?: string;
  displayName?: string;
  rawPayload?: unknown;
  timing?: InboundWhatsAppTimingHints;
}

export interface InboundWhatsAppTimingHints {
  receivedAtMs?: number;
  routeAuthMs?: number;
  parseMs?: number;
  loadStateMs?: number;
  clientLookupMs?: number;
  nluTotalMs?: number;
  nluProviderMs?: number;
  deterministicParserMs?: number;
  reducerMs?: number;
  policyMs?: number;
  toolsMs?: number;
  rendererMs?: number;
  persistenceMs?: number;
  eventLogMs?: number;
  outboxBuildMs?: number;
  twimlBuildMs?: number;
  clientDirectoryCacheHit?: boolean;
  conversationStoreCacheHit?: boolean;
  postgresReads?: number;
  postgresWrites?: number;
  sheetsReads?: number;
  sheetsWrites?: number;
  openaiCalls?: number;
  eventsWritten?: number;
  usedOpenAI?: boolean;
  usedDeterministicFallback?: boolean;
  tracePersisted?: boolean;
  traceDroppedBestEffort?: boolean;
  timedOutStage?: string;
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
  allowEmptyTwiml?: boolean;
  noReplyReason?: "duplicate_message_sid" | "human_mode_auto_reply_suppressed";
  timing?: AuthorityTimingSnapshot;
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

function conversationStoreProviderForLogs(store: ConversationStore): string {
  const constructorName = store.constructor?.name?.toLowerCase() ?? "";
  if (constructorName.includes("postgres")) return "postgres";
  if (constructorName.includes("google")) return "google_sheets";
  if (constructorName.includes("file")) return "file";
  return constructorName || "unknown";
}

function logConversationStateStoreFailure(input: {
  operation: string;
  access: "load" | "save";
  storeProvider: string;
  error: unknown;
}): void {
  console.warn("conversation_state_store_failed", {
    operation: input.operation,
    access: input.access,
    storeProvider: input.storeProvider,
    ...safeConversationStoreError(input.error),
  });
}

function shouldEmitRuntimeDiagnostics(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.HOTEL_RUNTIME_DIAGNOSTICS_IN_TEST === "true";
}

function safeRuntimeEventPayload(
  eventType: string,
  payload?: unknown,
): Record<string, unknown> {
  const record = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};

  if (eventType === "authority_turn_started") {
    return {
      turnId: record.turnId,
      conversationIdHash: record.conversationIdHash,
      channel: record.channel,
      activeFlowBefore: record.activeFlowBefore,
      pendingFieldsBefore: record.pendingFieldsBefore,
    };
  }

  if (eventType === "policy_decision") {
    return {
      turnId: record.turnId,
      action: record.action ?? record.route,
      reason: record.reason,
      intent: record.intent,
      route: record.route,
      renderKey: record.renderKey,
      pendingFieldsAfter: record.pendingFieldsAfter,
      hasActiveReservationFlow: record.hasActiveReservationFlow,
      hasPendingReservationProposal: record.hasPendingReservationProposal,
    };
  }

  if (eventType === "authority_turn_completed") {
    return {
      turnId: record.turnId,
      conversationIdHash: record.conversationIdHash,
      totalDurationMs: record.totalDurationMs,
      renderSource: record.renderSource,
      renderTemplateId: record.renderTemplateId,
      clientIdentityStatus: record.clientIdentityStatus,
      fallbackReason: record.fallbackReason,
      policyAction: record.policyAction,
      policyReason: record.policyReason,
      kbMatchTopic: record.kbMatchTopic,
      kbConfidence: record.kbConfidence,
      outboxKind: record.outboxKind,
    };
  }

  if (eventType === "authority_turn_timing_completed") {
    return {
      totalDurationMs: record.totalDurationMs,
      loadStateMs: record.loadStateMs,
      nluTotalMs: record.nluTotalMs,
      openaiCalls: record.openaiCalls,
      reducerMs: record.reducerMs,
      policyMs: record.policyMs,
      rendererMs: record.rendererMs,
      persistenceMs: record.persistenceMs,
      eventLogMs: record.eventLogMs,
      outboxBuildMs: record.outboxBuildMs,
      twimlBuildMs: record.twimlBuildMs,
      tracePersisted: record.tracePersisted,
      traceDroppedBestEffort: record.traceDroppedBestEffort,
    };
  }

  if (eventType === "copy_rendered") {
    return {
      source: record.source,
      renderSource: record.renderSource,
      renderTemplateId: record.renderTemplateId,
      operation: record.operation,
      bodyKind: record.bodyKind,
      hasTwimlMessage: record.hasTwimlMessage,
    };
  }

  if (eventType === "outbox_sent") {
    return {
      channel: record.channel,
      source: record.source,
      operation: record.operation,
      mode: record.mode,
      outboxKind: record.outboxKind,
    };
  }

  return {};
}

function logRuntimeConversationEvent(eventType: string, payload?: unknown): void {
  if (!shouldEmitRuntimeDiagnostics()) {
    return;
  }

  const runtimeLogEvents = new Set([
    "authority_turn_started",
    "authority_turn_completed",
    "authority_turn_timing_completed",
    "policy_decision",
    "copy_rendered",
    "outbox_sent",
  ]);
  if (!runtimeLogEvents.has(eventType)) {
    return;
  }

  console.info(eventType, safeRuntimeEventPayload(eventType, payload));
}

type DurationMetricKey =
  | "routeAuthMs"
  | "parseMs"
  | "loadStateMs"
  | "clientLookupMs"
  | "nluTotalMs"
  | "nluProviderMs"
  | "deterministicParserMs"
  | "reducerMs"
  | "policyMs"
  | "toolsMs"
  | "rendererMs"
  | "persistenceMs"
  | "eventLogMs"
  | "outboxBuildMs"
  | "twimlBuildMs";

type CountMetricKey =
  | "postgresReads"
  | "postgresWrites"
  | "sheetsReads"
  | "sheetsWrites"
  | "openaiCalls"
  | "eventsWritten";

type AuthorityTimingSnapshot = Pick<
  AuthorityTurnTrace,
  | "receivedAtMs"
  | "completedAtMs"
  | "totalDurationMs"
  | DurationMetricKey
  | "clientDirectoryCacheHit"
  | "conversationStoreCacheHit"
  | CountMetricKey
  | "usedOpenAI"
  | "usedDeterministicFallback"
  | "tracePersisted"
  | "traceDroppedBestEffort"
  | "timedOutStage"
>;

type AuthorityTurnTimingAccumulator = AuthorityTimingSnapshot;

const DURATION_METRIC_KEYS: DurationMetricKey[] = [
  "routeAuthMs",
  "parseMs",
  "loadStateMs",
  "clientLookupMs",
  "nluTotalMs",
  "nluProviderMs",
  "deterministicParserMs",
  "reducerMs",
  "policyMs",
  "toolsMs",
  "rendererMs",
  "persistenceMs",
  "eventLogMs",
  "outboxBuildMs",
  "twimlBuildMs",
];

const COUNT_METRIC_KEYS: CountMetricKey[] = [
  "postgresReads",
  "postgresWrites",
  "sheetsReads",
  "sheetsWrites",
  "openaiCalls",
  "eventsWritten",
];

function nowMs(): number {
  return Date.now();
}

function durationSince(startMs: number): number {
  return Math.max(0, nowMs() - startMs);
}

function createAuthorityTiming(input?: InboundWhatsAppTimingHints): AuthorityTurnTimingAccumulator {
  const receivedAtMs = input?.receivedAtMs ?? nowMs();
  const timing: AuthorityTurnTimingAccumulator = {
    receivedAtMs,
    completedAtMs: receivedAtMs,
    totalDurationMs: 0,
    routeAuthMs: 0,
    parseMs: 0,
    loadStateMs: 0,
    clientLookupMs: 0,
    nluTotalMs: 0,
    nluProviderMs: 0,
    deterministicParserMs: 0,
    reducerMs: 0,
    policyMs: 0,
    toolsMs: 0,
    rendererMs: 0,
    persistenceMs: 0,
    eventLogMs: 0,
    outboxBuildMs: 0,
    twimlBuildMs: 0,
    clientDirectoryCacheHit: false,
    conversationStoreCacheHit: false,
    postgresReads: 0,
    postgresWrites: 0,
    sheetsReads: 0,
    sheetsWrites: 0,
    openaiCalls: 0,
    eventsWritten: 0,
    usedOpenAI: false,
    usedDeterministicFallback: false,
    tracePersisted: false,
    traceDroppedBestEffort: false,
    timedOutStage: undefined,
  };

  for (const key of DURATION_METRIC_KEYS) {
    timing[key] = Math.max(0, input?.[key] ?? 0);
  }
  for (const key of COUNT_METRIC_KEYS) {
    timing[key] = Math.max(0, input?.[key] ?? 0);
  }
  timing.clientDirectoryCacheHit = Boolean(input?.clientDirectoryCacheHit);
  timing.conversationStoreCacheHit = Boolean(input?.conversationStoreCacheHit);
  timing.usedOpenAI = Boolean(input?.usedOpenAI);
  timing.usedDeterministicFallback = Boolean(input?.usedDeterministicFallback);
  timing.tracePersisted = Boolean(input?.tracePersisted);
  timing.traceDroppedBestEffort = Boolean(input?.traceDroppedBestEffort);
  timing.timedOutStage = input?.timedOutStage;

  return timing;
}

function addDuration(
  timing: AuthorityTurnTimingAccumulator | undefined,
  key: DurationMetricKey,
  startMs: number,
): void {
  if (!timing) return;
  timing[key] += durationSince(startMs);
}

function incrementCount(
  timing: AuthorityTurnTimingAccumulator | undefined,
  key: CountMetricKey,
  amount = 1,
): void {
  if (!timing) return;
  timing[key] += amount;
}

async function measureAuthorityStage<T>(
  timing: AuthorityTurnTimingAccumulator | undefined,
  key: DurationMetricKey,
  stage: string,
  callback: () => Promise<T>,
): Promise<T> {
  const startedAt = nowMs();
  try {
    return await callback();
  } catch (error) {
    if (timing && !timing.timedOutStage) {
      timing.timedOutStage = stage;
    }
    console.warn("authority_turn_timing_stage_failed", {
      stage,
      ...safeConversationStoreError(error),
    });
    throw error;
  } finally {
    addDuration(timing, key, startedAt);
  }
}

function measureSyncAuthorityStage<T>(
  timing: AuthorityTurnTimingAccumulator | undefined,
  key: DurationMetricKey,
  stage: string,
  callback: () => T,
): T {
  const startedAt = nowMs();
  try {
    return callback();
  } catch (error) {
    if (timing && !timing.timedOutStage) {
      timing.timedOutStage = stage;
    }
    console.warn("authority_turn_timing_stage_failed", {
      stage,
      ...safeConversationStoreError(error),
    });
    throw error;
  } finally {
    addDuration(timing, key, startedAt);
  }
}

function finalizeAuthorityTiming(
  timing?: AuthorityTurnTimingAccumulator,
): AuthorityTimingSnapshot {
  const snapshot = timing ?? createAuthorityTiming();
  const completedAtMs = nowMs();
  return {
    ...snapshot,
    completedAtMs,
    totalDurationMs: Math.max(0, completedAtMs - snapshot.receivedAtMs),
  };
}

function pickAuthorityTimingPayload(trace: AuthorityTurnTrace): AuthorityTimingSnapshot {
  return {
    receivedAtMs: trace.receivedAtMs,
    completedAtMs: trace.completedAtMs,
    totalDurationMs: trace.totalDurationMs,
    routeAuthMs: trace.routeAuthMs,
    parseMs: trace.parseMs,
    loadStateMs: trace.loadStateMs,
    clientLookupMs: trace.clientLookupMs,
    nluTotalMs: trace.nluTotalMs,
    nluProviderMs: trace.nluProviderMs,
    deterministicParserMs: trace.deterministicParserMs,
    reducerMs: trace.reducerMs,
    policyMs: trace.policyMs,
    toolsMs: trace.toolsMs,
    rendererMs: trace.rendererMs,
    persistenceMs: trace.persistenceMs,
    eventLogMs: trace.eventLogMs,
    outboxBuildMs: trace.outboxBuildMs,
    twimlBuildMs: trace.twimlBuildMs,
    clientDirectoryCacheHit: trace.clientDirectoryCacheHit,
    conversationStoreCacheHit: trace.conversationStoreCacheHit,
    postgresReads: trace.postgresReads,
    postgresWrites: trace.postgresWrites,
    sheetsReads: trace.sheetsReads,
    sheetsWrites: trace.sheetsWrites,
    openaiCalls: trace.openaiCalls,
    eventsWritten: trace.eventsWritten,
    usedOpenAI: trace.usedOpenAI,
    usedDeterministicFallback: trace.usedDeterministicFallback,
    tracePersisted: trace.tracePersisted,
    traceDroppedBestEffort: trace.traceDroppedBestEffort,
    timedOutStage: trace.timedOutStage,
  };
}

function isPostgresConversationStore(store: ConversationStore): boolean {
  return store.constructor?.name?.toLowerCase().includes("postgres") ?? false;
}

function isGoogleSheetsBackedStore(store: ConversationStore | ClientDirectory): boolean {
  return store.constructor?.name?.toLowerCase().includes("googlesheets") ?? false;
}

function countStoreRead(store: ConversationStore, timing?: AuthorityTurnTimingAccumulator): void {
  if (isPostgresConversationStore(store)) {
    incrementCount(timing, "postgresReads");
  } else if (isGoogleSheetsBackedStore(store)) {
    incrementCount(timing, "sheetsReads");
  }
}

function countStoreWrite(store: ConversationStore, timing?: AuthorityTurnTimingAccumulator): void {
  if (isPostgresConversationStore(store)) {
    incrementCount(timing, "postgresWrites");
  } else if (isGoogleSheetsBackedStore(store)) {
    incrementCount(timing, "sheetsWrites");
  }
}

function instrumentConversationStore(
  store: ConversationStore,
  timing?: AuthorityTurnTimingAccumulator,
): ConversationStore {
  if (!timing) {
    return store;
  }

  const activeTiming = timing;
  const storeProvider = conversationStoreProviderForLogs(store);

  async function runRead<T>(operation: string, callback: () => Promise<T>): Promise<T> {
    const startedAt = nowMs();
    if (shouldEmitRuntimeDiagnostics()) {
      console.info("conversation_state_load_started", { operation, storeProvider });
    }
    try {
      countStoreRead(store, activeTiming);
      const result = await callback();
      if (shouldEmitRuntimeDiagnostics()) {
        console.info("conversation_state_load_completed", {
          operation,
          storeProvider,
          durationMs: durationSince(startedAt),
        });
      }
      return result;
    } catch (error) {
      logConversationStateStoreFailure({
        operation,
        access: "load",
        storeProvider,
        error,
      });
      throw error;
    } finally {
      addDuration(activeTiming, "loadStateMs", startedAt);
    }
  }

  async function runWrite<T>(
    operation: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const startedAt = nowMs();
    if (shouldEmitRuntimeDiagnostics()) {
      console.info("conversation_state_save_started", { operation, storeProvider });
    }
    try {
      countStoreWrite(store, activeTiming);
      const result = await callback();
      if (shouldEmitRuntimeDiagnostics()) {
        console.info("conversation_state_save_completed", {
          operation,
          storeProvider,
          durationMs: durationSince(startedAt),
        });
      }
      return result;
    } catch (error) {
      logConversationStateStoreFailure({
        operation,
        access: "save",
        storeProvider,
        error,
      });
      throw error;
    } finally {
      addDuration(activeTiming, "persistenceMs", startedAt);
    }
  }

  async function runEventWrite<T>(
    operation: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const startedAt = nowMs();
    if (shouldEmitRuntimeDiagnostics()) {
      console.info("conversation_state_save_started", { operation, storeProvider });
    }
    try {
      if (isPostgresConversationStore(store)) {
        incrementCount(activeTiming, "postgresReads");
      }
      countStoreWrite(store, activeTiming);
      const result = await callback();
      if (shouldEmitRuntimeDiagnostics()) {
        console.info("conversation_state_save_completed", {
          operation,
          storeProvider,
          durationMs: durationSince(startedAt),
        });
      }
      return result;
    } catch (error) {
      logConversationStateStoreFailure({
        operation,
        access: "save",
        storeProvider,
        error,
      });
      throw error;
    } finally {
      const duration = durationSince(startedAt);
      activeTiming.eventLogMs += duration;
      activeTiming.persistenceMs += duration;
    }
  }

  return {
    async load() {
      return runRead("load", () => store.load());
    },
    async save(snapshot) {
      return runWrite("save", () => store.save(snapshot));
    },
    async list(filters) {
      return runRead("list", () => store.list(filters));
    },
    async getById(id) {
      return runRead("getById", () => store.getById(id));
    },
    async getByPhone(phoneNormalized) {
      return runRead("getByPhone", () => store.getByPhone(phoneNormalized));
    },
    async upsertConversation(conversation) {
      return runWrite("upsertConversation", () => store.upsertConversation(conversation));
    },
    async addMessage(message) {
      return runWrite("addMessage", () => {
        if (isPostgresConversationStore(store)) {
          incrementCount(activeTiming, "postgresReads");
        }
        return store.addMessage(message);
      });
    },
    async addEvent(event) {
      return runEventWrite("addEvent", async () => {
        const written = await store.addEvent(event);
        incrementCount(activeTiming, "eventsWritten");
        if (event.eventType === "authority_turn_completed") {
          activeTiming.tracePersisted = true;
        }
        logRuntimeConversationEvent(event.eventType, event.payload);
        return written;
      });
    },
    async replaceConversation(record) {
      return runWrite("replaceConversation", () => store.replaceConversation(record));
    },
    async seed(records) {
      return runWrite("seed", () => store.seed(records));
    },
  };
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

async function addRenderedBotMessage(
  store: ConversationStore,
  conversationId: string,
  body: string,
  operation: string,
): Promise<Message> {
  const copyRenderedPayload = {
    source: "copy_renderer",
    renderSource: "copy_renderer",
    renderTemplateId: operation,
    operation,
    bodyKind: body.length <= 80 ? "short_text" : "long_text",
    hasTwimlMessage: true,
  };
  const copyRenderedEvent = await addEventBestEffort(
    store,
    createEvent(conversationId, "copy_rendered", copyRenderedPayload),
    `${operation}_copy_rendered`,
  );
  if (!copyRenderedEvent) {
    logRuntimeConversationEvent("copy_rendered", copyRenderedPayload);
  }
  const botReply = await store.addMessage(
    createMessage({
      conversationId,
      direction: "outbound",
      senderType: "bot",
      body,
    }),
  );
  const outboxSentPayload = {
    channel: "whatsapp",
    source: "copy_renderer",
    operation,
    mode: "twiml_response",
    outboxKind: "twiml_response",
  };
  const outboxSentEvent = await addEventBestEffort(
    store,
    createEvent(conversationId, "outbox_sent", outboxSentPayload),
    `${operation}_outbox_sent`,
  );
  if (!outboxSentEvent) {
    logRuntimeConversationEvent("outbox_sent", outboxSentPayload);
  }
  return botReply;
}

async function addRenderedBotMessageBestEffort(
  store: ConversationStore,
  conversationId: string,
  body: string,
  operation: string,
): Promise<Message | undefined> {
  try {
    return await addRenderedBotMessage(store, conversationId, body, operation);
  } catch (error) {
    console.warn("conversation_store_rendered_message_failed", {
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
  const flow = record.reservationFlow;
  const status = flow?.status;
  if (!status || !isReservationFlowActive(record)) {
    return undefined;
  }

  switch (status) {
    case "asking_client_kind":
      return renderCopy({ key: "reservation.resume_asking_client_kind" });
    case "asking_existing_email":
      return renderCopy({ key: "reservation.resume_asking_existing_email" });
    case "collecting_owner":
      return renderCopy({ key: "reservation.resume_collecting_owner" });
    case "collecting_pet":
      return renderCopy({ key: "reservation.resume_collecting_pet" });
    case "collecting_dates": {
      const nextQuestion = renderNextReservationQuestion(
        computeMissingReservationFields(flow),
        flow,
      );
      return nextQuestion.startsWith("Seguimos con la reserva.")
        ? nextQuestion
        : `Seguimos con la reserva. ${nextQuestion}`;
    }
    case "collecting_notes":
      return renderCopy({ key: "reservation.resume_collecting_notes" });
    case "collecting_visit":
      return renderCopy({ key: "reservation.resume_collecting_visit" });
    case "pending_availability":
      return renderCopy({ key: "reservation.resume_pending_availability" });
    case "pending_confirmation":
      return renderCopy({ key: "reservation.resume_pending_confirmation" });
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

const RESERVATION_FLOW_CANCELLED_REPLY =
  renderCopy({ key: "reservation.cancelled" });

type PendingSafeEvent = {
  eventType: string;
  payload?: Record<string, unknown>;
};

type ContractGateAppliedReason = "confirm_proposal_requires_acceptance";

type ContractGateSkippedReason =
  | "skipped_modify_intent"
  | "skipped_cancel_intent"
  | "skipped_reset"
  | "skipped_handoff"
  | "skipped_not_ready"
  | "skipped_terms_already_accepted"
  | "skipped_no_active_proposal";

const RESERVATION_SLOT_KEYS = [
  "petName",
  "petNames",
  "petCount",
  "checkInDate",
  "checkInTime",
  "checkInSlot",
  "checkOutDate",
  "checkOutTime",
  "checkOutSlot",
  "notes",
  "foodNotes",
  "medicationNotes",
  "wantsVisit",
] as const satisfies ReadonlyArray<keyof ConversationReservationFlow>;

function isReservationFlowCancelEscape(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return /^(ya no quiero reservar|no quiero reservar|dejalo|olvidalo|mejor no|cancelar|cancela|cancelo|abandona|abandonar)$/.test(
    normalized,
  );
}

function isExplicitHumanHandoffRequest(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return (
    /\b(?:quiero|necesito|puedo|podria|me gustaria|prefiero)\s+(?:hablar|contactar|tratar)\s+(?:con\s+)?(?:una\s+)?(?:persona|alguien|humano|agente|operador|recepcion|responsable|equipo)\b/.test(
      normalized,
    ) ||
    /\b(?:hablar|contactar|pasadme|pasame|ponedme|ponme)\s+(?:con\s+)?(?:una\s+)?(?:persona|alguien|humano|agente|operador|recepcion|responsable|equipo)\b/.test(
      normalized,
    ) ||
    /\b(?:persona|humano|agente|operador|recepcion|equipo)\b/.test(normalized) ||
    /\b(?:que\s+me\s+llamen|llamada|llamadme|llamame|urgente|emergencia)\b/.test(normalized)
  );
}

function shouldKeepReservationSlotResolverPriority(
  record: ConversationRecord,
  message: string,
): boolean {
  if (record.reservationFlow?.status !== "collecting_dates") {
    return false;
  }
  const normalized = normalizeOperationalText(message);
  return /\b(?:me da igual|indiferente|cuando mejor|me adapto|manana|tarde|primera hora|entrada|salida|ambas|ambos|las dos|del|desde|hasta|dia)\b/.test(
    normalized,
  ) || /\d/.test(normalized);
}

function buildReservationFlowCancelledRecord(record: ConversationRecord): ConversationRecord {
  return {
    ...record,
    pendingReservationProposal: undefined,
    pendingReservationContext: undefined,
    reservationFlow: undefined,
    updatedAt: nowIso(),
  };
}

function buildReservationFlowRevisionRecord(record: ConversationRecord): ConversationRecord {
  const updatedAt = nowIso();
  return {
    ...record,
    pendingReservationProposal: record.pendingReservationProposal
      ? {
          ...record.pendingReservationProposal,
          status: "cancelled",
          failureReason: "customer_requested_change",
        }
      : undefined,
    reservationFlow: record.reservationFlow
      ? {
          ...record.reservationFlow,
          status: "collecting_dates",
          availabilityStatus: "pending",
          price: undefined,
          priceSource: undefined,
          priceNeedsReview: undefined,
          proposalId: undefined,
          updatedAt,
        }
      : undefined,
    updatedAt,
  };
}

function safeBodyKind(message: string): Record<string, unknown> {
  const trimmed = message.trim();
  return {
    bodyKind: trimmed.length === 0 ? "empty" : trimmed.length <= 80 ? "short_text" : "long_text",
    hasQuestionMark: /[¿?]/.test(message),
    hasDigits: /\d/.test(message),
  };
}

function safePhoneSummary(value?: string): string | undefined {
  const digits = value?.replace(/\D/g, "");
  if (!digits) {
    return undefined;
  }
  return `***${digits.slice(-4)}`;
}

function inferRenderSource(renderKey?: ConversationRenderKey): AuthorityTurnTrace["renderSource"] | undefined {
  if (!renderKey) {
    return undefined;
  }
  if (
    [
      "reservation_confirmation",
      "reservation_preconfirmation",
      "reservation_denial",
      "bath_offer",
      "reservation_reminder",
      "post_stay_new_client_checkin",
      "positive_review_request",
      "contract_link",
      "contract_acceptance",
    ].includes(renderKey)
  ) {
    return "client_template";
  }
  if (renderKey.includes("kb") || renderKey.includes("info") || renderKey.includes("availability")) {
    return "kb";
  }
  if (renderKey.includes("unknown") || renderKey.includes("fallback") || renderKey.includes("manual_review")) {
    return "fallback";
  }
  return "legacy";
}

function changedReservationSlotNames(
  before?: ConversationReservationFlow,
  after?: ConversationReservationFlow,
): string[] {
  if (!before || !after) {
    return [];
  }

  return RESERVATION_SLOT_KEYS.filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function activeFlowName(record?: ConversationRecord): string | undefined {
  if (!record) return undefined;
  if (isReservationFlowActive(record)) return "reservation";
  if (record.pendingReservationModificationFlow || record.pendingReservationCancellationFlow) {
    return "reservation_change";
  }
  if (record.availabilityInquiry || record.activeFlow === "availabilityInquiry") {
    return "availabilityInquiry";
  }
  if (record.activeFlow === "info") {
    return "info";
  }
  if (record.pendingPriceQuoteFlow) return "price_quote";
  return "none";
}

function pendingFieldsForTrace(record?: ConversationRecord): string[] {
  if (record?.reservationFlow && isReservationFlowActive(record)) {
    return computeMissingReservationFields(record.reservationFlow);
  }
  if (record?.availabilityInquiry || record?.activeFlow === "availabilityInquiry") {
    return record.availabilityInquiry?.missingFields ?? [];
  }
  return [];
}

function inferLastBotQuestionKindForTrace(reply?: string): string | undefined {
  if (!reply) return undefined;
  const normalized = reply
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  if (normalized.includes("salida")) return "ask_exit_date_time";
  if (normalized.includes("entrada")) return "ask_entry_date_time";
  if (normalized.includes("mascota")) return "ask_pet";
  if (normalized.includes("email")) return "ask_owner_or_email";
  if (normalized.includes("observacion") || normalized.includes("medicacion")) return "ask_notes";
  if (normalized.includes("visitar")) return "ask_visit";
  return undefined;
}

function ignoredSlotsWithReason(
  slotNames: string[],
  appliedSlotNames: string[],
  reason: string,
): Array<{ slotName: string; reason: string }> {
  return slotNames
    .filter((slotName) => !appliedSlotNames.includes(slotName))
    .map((slotName) => ({ slotName, reason }));
}

function buildAuthorityTurnTrace(input: {
  turnId: string;
  recordBefore: ConversationRecord;
  recordAfter?: ConversationRecord;
  message: string;
  timing?: AuthorityTurnTimingAccumulator;
  nluIntent?: string;
  nluGlobalIntent?: string;
  nluSlotsExtracted?: string[];
  nluTargetSlots?: string[];
  slotsApplied?: string[];
  slotsIgnored?: Array<{ slotName: string; reason: string }>;
  policyAction?: string;
  policyReason?: string;
  renderKey?: ConversationRenderKey;
  renderTemplateId?: string;
  renderSource?: AuthorityTurnTrace["renderSource"];
  clientIdentityStatus?: AuthorityTurnTrace["clientIdentityStatus"];
  clientIdentitySource?: string;
  fallbackReason?: string;
  handoffReason?: string;
  kbMatchTopic?: string;
  kbConfidence?: number;
  kbMissReason?: string;
  usedKnowledgeBase?: boolean;
  fastPathQualityGate?: AuthorityTurnTrace["fastPathQualityGate"];
  openaiRequiredReason?: string;
  policyHandoffReason?: string;
  outboxKind?: AuthorityTurnTrace["outboxKind"];
  legacyBypassUsed?: boolean;
  legacyBypassName?: string;
  loopPrevented?: boolean;
}): AuthorityTurnTrace {
  const lastReply = lastBotReplyBody(input.recordBefore);
  const stateBefore = input.recordBefore.reservationFlow;
  const stateAfter = input.recordAfter?.reservationFlow;
  const timing = finalizeAuthorityTiming(input.timing);
  return {
    turnId: input.turnId,
    conversationIdHash: safeConversationId(input.recordBefore.id),
    channel: "whatsapp",
    ...timing,
    inboundKind: safeBodyKind(input.message),
    activeFlowBefore: activeFlowName(input.recordBefore),
    lastBotQuestionKindBefore: inferLastBotQuestionKindForTrace(lastReply),
    pendingFieldsBefore: pendingFieldsForTrace(input.recordBefore),
    nluCalled: Boolean(input.nluIntent),
    nluProviderUsed: input.nluIntent ? "deterministic" : "skipped",
    nluIntent: input.nluIntent,
    nluGlobalIntent: input.nluGlobalIntent,
    nluSlotsExtracted: input.nluSlotsExtracted ?? [],
    nluTargetSlots: input.nluTargetSlots ?? [],
    slotsApplied: input.slotsApplied ?? [],
    slotsIgnored: input.slotsIgnored ?? [],
    statePatchSummary: {
      statusBefore: stateBefore?.status,
      statusAfter: stateAfter?.status,
      stateChanged: JSON.stringify(stateBefore) !== JSON.stringify(stateAfter),
    },
    pendingFieldsAfter: pendingFieldsForTrace(input.recordAfter),
    activeFlowAfter: activeFlowName(input.recordAfter),
    policyAction: input.policyAction,
    policyReason: input.policyReason,
    renderKey: input.renderKey,
    renderTemplateId: input.renderTemplateId ?? input.renderKey,
    renderSource: input.renderSource ?? inferRenderSource(input.renderKey),
    clientIdentityStatus: input.clientIdentityStatus ?? input.recordAfter?.clientStatus ?? input.recordBefore.clientStatus,
    clientIdentitySource: input.clientIdentitySource ?? input.recordAfter?.clientSource ?? input.recordBefore.clientSource,
    fallbackReason: input.fallbackReason,
    handoffReason: input.handoffReason,
    kbMatchTopic: input.kbMatchTopic,
    kbConfidence: input.kbConfidence,
    kbMissReason: input.kbMissReason,
    usedKnowledgeBase: input.usedKnowledgeBase ?? input.renderKey?.includes("kb") ?? false,
    fastPathQualityGate: input.fastPathQualityGate,
    openaiRequiredReason: input.openaiRequiredReason,
    policyHandoffReason: input.policyHandoffReason,
    outboxKind: input.outboxKind,
    legacyBypassUsed: input.legacyBypassUsed ?? false,
    legacyBypassName: input.legacyBypassName,
    loopPrevented: input.loopPrevented ?? false,
  };
}

function authorityTurnStartedEvent(trace: Pick<
  AuthorityTurnTrace,
  | "turnId"
  | "conversationIdHash"
  | "channel"
  | "inboundKind"
  | "activeFlowBefore"
  | "lastBotQuestionKindBefore"
  | "pendingFieldsBefore"
>): PendingSafeEvent {
  return {
    eventType: "authority_turn_started",
    payload: trace as unknown as Record<string, unknown>,
  };
}

function authorityTurnCompletedEvents(trace: AuthorityTurnTrace): PendingSafeEvent[] {
  trace.tracePersisted = true;
  const events: PendingSafeEvent[] = [
    {
      eventType: "authority_turn_completed",
      payload: trace as unknown as Record<string, unknown>,
    },
    {
      eventType: "authority_turn_timing_completed",
      payload: pickAuthorityTimingPayload(trace) as unknown as Record<string, unknown>,
    },
  ];
  if (trace.legacyBypassUsed) {
    events.push({
      eventType: "legacy_bypass_used",
      payload: {
        turnId: trace.turnId,
        legacyBypassName: trace.legacyBypassName,
        policyAction: trace.policyAction,
      },
    });
  }
  return events;
}

function authorityGlobalIntent(input: {
  message: string;
  intent?: string;
  isCancelEscape?: boolean;
}): string | undefined {
  if (isConversationResetCommand(input.message)) return "reset";
  if (input.isCancelEscape) return "cancel_flow";
  if (input.intent === "human_handoff") return "handoff";
  if (input.intent?.startsWith("faq_")) return "faq";
  return undefined;
}

function authorityRuntimeEvents(trace: AuthorityTurnTrace): PendingSafeEvent[] {
  return [
    authorityTurnStartedEvent(trace),
    {
      eventType: "nlu_called",
      payload: {
        turnId: trace.turnId,
        provider: trace.nluProviderUsed,
        activeFlowBefore: trace.activeFlowBefore,
        ...trace.inboundKind,
      },
    },
    {
      eventType: "nlu_result_received",
      payload: {
        turnId: trace.turnId,
        intent: trace.nluIntent,
        globalIntent: trace.nluGlobalIntent,
        provider: trace.nluProviderUsed,
      },
    },
    {
      eventType: "nlu_slots_extracted",
      payload: {
        turnId: trace.turnId,
        slotNames: trace.nluSlotsExtracted,
        targetSlotNames: trace.nluTargetSlots,
      },
    },
    {
      eventType: "nlu_slots_applied",
      payload: {
        turnId: trace.turnId,
        slotNames: trace.slotsApplied,
      },
    },
    {
      eventType: "nlu_slots_ignored",
      payload: {
        turnId: trace.turnId,
        slots: trace.slotsIgnored,
      },
    },
    {
      eventType: "state_reducer_applied",
      payload: {
        turnId: trace.turnId,
        ...trace.statePatchSummary,
        slotsApplied: trace.slotsApplied,
      },
    },
    {
      eventType: "pending_fields_after_merge",
      payload: {
        turnId: trace.turnId,
        activeFlowAfter: trace.activeFlowAfter,
        pendingFieldsAfter: trace.pendingFieldsAfter,
      },
    },
    {
      eventType: "policy_decision",
      payload: {
        turnId: trace.turnId,
        action: trace.policyAction,
        reason: trace.policyReason,
        renderKey: trace.renderKey,
        pendingFieldsAfter: trace.pendingFieldsAfter,
      },
    },
    ...authorityInvariantFailureEvents(trace),
    ...authorityTurnCompletedEvents(trace),
  ];
}

function authorityInvariantFailureEvents(trace: AuthorityTurnTrace): PendingSafeEvent[] {
  const failures: string[] = [];
  if (
    trace.activeFlowBefore === "reservation" &&
    trace.nluSlotsExtracted.length > 0 &&
    trace.slotsApplied.length === 0 &&
    trace.slotsIgnored.length === 0 &&
    trace.policyAction !== "ask_time_target_clarification"
  ) {
    failures.push("slot_use_unaccounted");
  }
  if (
    trace.policyAction === "answer_faq_then_resume" &&
    trace.activeFlowBefore === "reservation" &&
    trace.activeFlowAfter !== "reservation"
  ) {
    failures.push("faq_did_not_preserve_reservation_flow");
  }
  if (failures.length === 0) {
    return [];
  }
  return [
    {
      eventType: "authority_turn_invariant_failed",
      payload: {
        turnId: trace.turnId,
        failures,
        policyAction: trace.policyAction,
        activeFlowBefore: trace.activeFlowBefore,
        activeFlowAfter: trace.activeFlowAfter,
      },
    },
  ];
}

function lastBotReplyBody(record: ConversationRecord): string | undefined {
  return [...record.messages]
    .reverse()
    .find((message) => message.direction === "outbound" && message.senderType === "bot")?.body;
}

function repeatedBotReplyCount(record: ConversationRecord, reply: string): number {
  let count = 0;
  for (const message of [...record.messages].reverse()) {
    if (message.direction !== "outbound" || message.senderType !== "bot") {
      continue;
    }
    if (message.body !== reply) {
      break;
    }
    count += 1;
  }
  return count;
}

function buildLoopSafeReservationReply(record: ConversationRecord, fallback: string): string {
  const flow = record.reservationFlow;
  if (flow?.status === "collecting_dates") {
    const missing = computeMissingReservationFields(flow);
    if (flow.checkInDate && missing.some((field) => field.startsWith("check_out"))) {
      return renderCopy({ key: "service.loop_missing_exit_and_times" });
    }
    if ((flow.checkInTime || flow.checkOutTime) && missing.some((field) => field.endsWith("_date"))) {
      return renderCopy({ key: "service.loop_have_hours_need_dates" });
    }
  }

  const resume = buildReservationFlowResumePrompt(record);
  return resume ? renderCopy({ key: "service.loop_reformulation", reply: resume }) : fallback;
}

function applyReservationAntiLoop(input: {
  recordBeforeReply: ConversationRecord;
  reply: string;
  appliedSlotNames: string[];
}): { reply: string; event?: PendingSafeEvent } {
  const repeated = lastBotReplyBody(input.recordBeforeReply) === input.reply;
  if (!repeated) {
    return { reply: input.reply };
  }

  return {
    reply: buildLoopSafeReservationReply(input.recordBeforeReply, input.reply),
    event: {
      eventType: "reservation_loop_prevented",
      payload: {
        repeatedCount: repeatedBotReplyCount(input.recordBeforeReply, input.reply) + 1,
        appliedSlotNames: input.appliedSlotNames,
        status: input.recordBeforeReply.reservationFlow?.status,
      },
    },
  };
}

async function addSafeEvents(
  store: ConversationStore,
  conversationId: string,
  events: PendingSafeEvent[],
  timing?: AuthorityTurnTimingAccumulator,
): Promise<void> {
  for (const event of events) {
    try {
      await store.addEvent(createEvent(conversationId, event.eventType, event.payload));
    } catch (error) {
      if (timing) {
        timing.traceDroppedBestEffort = true;
      }
      console.warn("authority_trace_event_dropped_best_effort", {
        eventType: event.eventType,
        conversationId: safeConversationId(conversationId),
        ...safeConversationStoreError(error),
      });
    }
  }
}

function readAssistiveNluConfig(): {
  enabled: boolean;
  assistiveSafe: boolean;
  shadow: boolean;
  openaiConfigured: boolean;
  timeoutMs: number;
  model?: string;
} {
  const configuredTimeout = Number.parseInt(process.env.HOTEL_LLM_NLU_TIMEOUT_MS ?? "", 10);
  return {
    enabled: process.env.HOTEL_LLM_NLU_ENABLED === "true",
    assistiveSafe: process.env.HOTEL_LLM_NLU_DECISION_MODE === "assistive_safe",
    shadow: process.env.HOTEL_LLM_NLU_SHADOW !== "false",
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    timeoutMs: Number.isFinite(configuredTimeout)
      ? Math.max(250, Math.min(configuredTimeout, 5000))
      : 1500,
    model: process.env.OPENAI_MODEL?.trim() || undefined,
  };
}

function extractOutputTextFromOpenAiResponse(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") {
    return response.output_text;
  }
  if (!Array.isArray(response.output)) {
    return undefined;
  }

  const text = response.output
    .flatMap((item) => {
      if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) {
        return [];
      }
      return (item as { content: Array<{ text?: unknown }> }).content
        .map((content) => (typeof content.text === "string" ? content.text : undefined))
        .filter((entry): entry is string => Boolean(entry));
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function safeAssistiveSlotNamesFromText(text?: string): string[] {
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { slots?: Record<string, unknown> };
    if (!parsed.slots || typeof parsed.slots !== "object") {
      return [];
    }
    return Object.entries(parsed.slots)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key]) => key)
      .filter((key) => /^[a-zA-Z_]+$/.test(key));
  } catch {
    return [];
  }
}

async function buildAssistiveNluEvents(input: {
  record: ConversationRecord;
  message: string;
  replyPlan: ReturnType<typeof buildConversationReplyPlan>;
  now: Date;
  timing?: AuthorityTurnTimingAccumulator;
}): Promise<PendingSafeEvent[]> {
  const config = readAssistiveNluConfig();
  const flow = input.record.reservationFlow;
  const pendingFields = flow ? computeMissingReservationFields(flow) : [];
  const deterministicSlots = measureSyncAuthorityStage(
    input.timing,
    "deterministicParserMs",
    "assistive_deterministic_slots",
    () => extractReservationSlotsFromMessage(input.message, {
      flow,
      now: input.now,
    }),
  );
  const deterministicSlotNames = Object.keys(deterministicSlots);
  const basePayload = {
    activeFlow: flow ? "reservation" : undefined,
    status: flow?.status,
    pendingFields,
    deterministicSlotNames,
    intent: input.replyPlan.intent,
    ...safeBodyKind(input.message),
  };

  if (deterministicSlotNames.length > 0) {
    if (input.timing) {
      input.timing.usedDeterministicFallback = true;
    }
    return [
      {
        eventType: "nlu_assistive_ignored_reason",
        payload: {
          ...basePayload,
          reason: "deterministic_high_confidence",
        },
      },
      {
        eventType: "nlu_assistive_slots_extracted",
        payload: {
          source: "deterministic_fast_path",
          slotNames: deterministicSlotNames,
          pendingFields,
        },
      },
    ];
  }

  if (!config.enabled || !config.assistiveSafe || config.shadow || !config.openaiConfigured || !config.model) {
    if (input.timing) {
      input.timing.usedDeterministicFallback = true;
    }
    return [
      {
        eventType: "nlu_assistive_ignored_reason",
        payload: {
          ...basePayload,
          reason: !config.enabled
            ? "disabled"
            : !config.assistiveSafe
              ? "decision_mode_not_assistive_safe"
              : config.shadow
                ? "shadow_mode"
                : !config.openaiConfigured
                  ? "openai_not_configured"
                  : "model_not_configured",
        },
      },
      {
        eventType: "nlu_assistive_slots_extracted",
        payload: {
          source: "deterministic_fallback",
          slotNames: deterministicSlotNames,
          pendingFields,
        },
      },
    ];
  }

  const events: PendingSafeEvent[] = [
    {
      eventType: "nlu_assistive_called",
      payload: basePayload,
    },
  ];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    if (input.timing) {
      input.timing.usedOpenAI = true;
      incrementCount(input.timing, "openaiCalls");
    }
    const response = await measureAuthorityStage(
      input.timing,
      "nluProviderMs",
      "openai_responses",
      () => fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          input: [
            "Eres un clasificador NLU seguro para un hotel canino.",
            "Devuelve solo JSON con globalIntent y slots. No confirmes reservas ni escribas datos.",
            JSON.stringify({
              message: input.message,
              context: {
                activeFlow: "reservation",
                status: flow?.status,
                pendingFields,
                hasPet: Boolean(flow?.petName),
                hasCheckInDate: Boolean(flow?.checkInDate),
                hasCheckInTime: Boolean(flow?.checkInTime),
                hasCheckOutDate: Boolean(flow?.checkOutDate),
                hasCheckOutTime: Boolean(flow?.checkOutTime),
              },
            }),
          ].join("\n"),
          max_output_tokens: 180,
        }),
        signal: controller.signal,
      }),
    );
    const result = (await response.json().catch(() => undefined)) as unknown;
    const outputText = extractOutputTextFromOpenAiResponse(result);
    const assistiveSlotNames = safeAssistiveSlotNamesFromText(outputText);
    if (input.timing && (!response.ok || assistiveSlotNames.length === 0)) {
      input.timing.usedDeterministicFallback = true;
    }
    events.push({
      eventType: "nlu_assistive_result_received",
      payload: {
        ok: response.ok,
        status: response.status,
        hasOutput: Boolean(outputText),
      },
    });
    events.push({
      eventType: "nlu_assistive_slots_extracted",
      payload: {
        source: response.ok && assistiveSlotNames.length > 0 ? "assistive_safe" : "deterministic_fallback",
        slotNames: assistiveSlotNames.length > 0 ? assistiveSlotNames : deterministicSlotNames,
        pendingFields,
      },
    });
  } catch (error) {
    if (input.timing) {
      input.timing.usedDeterministicFallback = true;
      if (error instanceof Error && error.name === "AbortError") {
        input.timing.timedOutStage = "openai_responses";
      }
    }
    events.push({
      eventType: error instanceof Error && error.name === "AbortError"
        ? "nlu_provider_timeout_fallback_used"
        : "nlu_assistive_failed_fallback_used",
      payload: {
        ...basePayload,
        timeoutMs: config.timeoutMs,
        ...safeConversationStoreError(error),
      },
    });
    events.push({
      eventType: "nlu_assistive_slots_extracted",
      payload: {
        source: "deterministic_fallback",
        slotNames: deterministicSlotNames,
        pendingFields,
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  return events;
}

function normalizeOperationalText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rawPayloadHasMedia(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== "object") {
    return false;
  }

  const payload = rawPayload as Record<string, unknown>;
  const count = Number(payload.NumMedia ?? payload.numMedia ?? 0);
  return Number.isFinite(count) && count > 0;
}

function detectBathSize(message: string): "small" | "medium" | "large" | undefined {
  const normalized = normalizeOperationalText(message);
  if (/\b(pequeno|pequena|peque|mini|small)\b/.test(normalized)) {
    return "small";
  }
  if (/\b(mediano|mediana|medium)\b/.test(normalized)) {
    return "medium";
  }
  if (/\b(grande|gran|large)\b/.test(normalized)) {
    return "large";
  }
  return undefined;
}

function bathPriceForSize(size: "small" | "medium" | "large"): number {
  return size === "small" ? 15 : size === "medium" ? 20 : 25;
}

function hasBathAcceptance(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return /^(si|sí|vale|ok|quiero|quiero bano|banarlo|banar|me interesa|adelante)\b/.test(normalized);
}

function hasBathDecline(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return /^(no|no gracias|mejor no|sin bano|no hace falta)\b/.test(normalized);
}

function needsBathManualReview(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return /\b(no es de pelo corto|pelo largo|nudo|nudos|necesita corte|corte especifico|corte de raza|caniche|schnauzer)\b/.test(
    normalized,
  );
}

function lacksBathPhoto(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return /\b(no tengo foto|sin foto|no puedo mandar foto|no puedo enviar foto)\b/.test(normalized);
}

async function handlePendingBathOfferReply(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  inbound: Message;
  safeBody: string;
  rawPayload?: unknown;
}): Promise<InboundResult | undefined> {
  const bath = input.conversation.pendingBathOffer;
  if (!bath || ["quoted", "declined", "manual_review"].includes(bath.status)) {
    return undefined;
  }

  const hasMedia = rawPayloadHasMedia(input.rawPayload);
  const size = detectBathSize(input.safeBody);
  const longHair = needsBathManualReview(input.safeBody);
  const noPhoto = lacksBathPhoto(input.safeBody);
  const normalizedBody = normalizeOperationalText(input.safeBody);
  const scheduledWithoutBathSignal =
    bath.status === "scheduled" &&
    !hasMedia &&
    !size &&
    !longHair &&
    !noPhoto &&
    !/\b(bano|banar|banarlo|bañar|bañarlo)\b/.test(normalizedBody);
  if (scheduledWithoutBathSignal) {
    return undefined;
  }
  let reply: string | undefined;
  let eventType = "bath_offer_updated";
  let eventPayload: Record<string, unknown> = {
    previousStatus: bath.status,
  };
  let nextBath = {
    ...bath,
    status: bath.status === "scheduled" ? "offered" : bath.status,
    updatedAt: nowIso(),
  };
  let nextConversation: ConversationRecord = input.conversation;

  if (hasMedia && bath.status === "awaiting_photo") {
    reply = renderBathPhotoReceivedTemplate();
    nextBath = { ...nextBath, status: "manual_review" };
    nextConversation = {
      ...input.conversation,
      pendingBathOffer: nextBath,
      mode: "human",
      humanRequested: true,
      requiresManualReview: true,
      updatedAt: nowIso(),
    };
    eventType = "bath_photo_received";
    eventPayload = { ...eventPayload, manualReview: true };
  } else if (noPhoto && bath.status === "awaiting_photo") {
    reply = renderBathPhotoReceivedTemplate();
    nextBath = { ...nextBath, status: "manual_review" };
    nextConversation = {
      ...input.conversation,
      pendingBathOffer: nextBath,
      mode: "human",
      humanRequested: true,
      requiresManualReview: true,
      updatedAt: nowIso(),
    };
    eventType = "bath_manual_review";
    eventPayload = { ...eventPayload, reason: "no_photo_available" };
  } else if (longHair) {
    reply = renderBathLongHairPhotoRequestTemplate();
    nextBath = { ...nextBath, status: "awaiting_photo" };
    nextConversation = {
      ...input.conversation,
      pendingBathOffer: nextBath,
      requiresManualReview: true,
      updatedAt: nowIso(),
    };
    eventType = "bath_photo_requested";
    eventPayload = { ...eventPayload, reason: "long_hair_or_knots" };
  } else if (hasBathDecline(input.safeBody)) {
    reply = renderCopy({ key: "service.bath_declined" });
    nextBath = { ...nextBath, status: "declined" };
    nextConversation = {
      ...input.conversation,
      pendingBathOffer: nextBath,
      updatedAt: nowIso(),
    };
    eventType = "bath_declined";
  } else if (size) {
    const quotedPrice = bathPriceForSize(size);
    reply = renderCopy({ key: "service.bath_price_quoted", price: quotedPrice });
    nextBath = { ...nextBath, status: "quoted", size, quotedPrice };
    nextConversation = {
      ...input.conversation,
      pendingBathOffer: nextBath,
      updatedAt: nowIso(),
    };
    eventType = "bath_price_quoted";
    eventPayload = { ...eventPayload, size, quotedPrice };
  } else if (hasBathAcceptance(input.safeBody)) {
    reply = renderCopy({ key: "service.bath_size_requested" });
    nextBath = { ...nextBath, status: "awaiting_size" };
    nextConversation = {
      ...input.conversation,
      pendingBathOffer: nextBath,
      updatedAt: nowIso(),
    };
    eventType = "bath_size_requested";
  } else {
    return undefined;
  }

  await replaceConversationBestEffort(input.store, nextConversation, "bath_offer_update");
  await addEventBestEffort(
    input.store,
    createEvent(input.conversation.id, eventType, eventPayload),
    eventType,
  );
  if (eventType === "bath_photo_requested") {
    await addEventBestEffort(
      input.store,
      createEvent(input.conversation.id, "bath_manual_review", {
        reason: "needs_photo_price_review",
      }),
      "bath_manual_review",
    );
  }
  const botReply = await addRenderedBotMessageBestEffort(
    input.store,
    input.conversation.id,
    reply,
    "bath_offer_reply",
  );

  return {
    conversation: await getConversationByIdBestEffort(
      input.store,
      input.conversation.id,
      nextConversation,
      "bath_offer_return_read",
    ),
    inbound: input.inbound,
    botReply,
    twiml: buildTwilioMessageResponse(reply),
  };
}

function isNegativePostStayReply(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return /\b(no|mal|regular|problema|nervioso|nerviosa|cojo|coja|enfermo|enferma|queja|preocupado|preocupada)\b/.test(
    normalized,
  );
}

function isPositivePostStayReplyText(message: string): boolean {
  const normalized = normalizeOperationalText(message);
  return /^(si|todo bien|genial|muy bien|perfecto|fenomenal|estupendo|contento|contenta|muy contentos|todo perfecto)\b/.test(
    normalized,
  );
}

async function handlePendingPostStayFollowupReply(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  inbound: Message;
  safeBody: string;
}): Promise<InboundResult | undefined> {
  const flow = input.conversation.pendingPostStayFollowup;
  if (!flow || flow.status !== "awaiting_feedback") {
    return undefined;
  }

  let reply: string | undefined;
  let nextConversation: ConversationRecord | undefined;
  let eventType: string | undefined;

  if (isPositivePostStayReplyText(input.safeBody)) {
    reply = renderPositiveReviewRequestTemplate();
    nextConversation = {
      ...input.conversation,
      pendingPostStayFollowup: {
        ...flow,
        status: "positive_review_requested",
        updatedAt: nowIso(),
      },
      updatedAt: nowIso(),
    };
    eventType = "post_stay_positive_review_requested";
  } else if (isNegativePostStayReply(input.safeBody)) {
    reply = renderCopy({ key: "service.post_stay_negative_manual_review" });
    nextConversation = {
      ...input.conversation,
      pendingPostStayFollowup: {
        ...flow,
        status: "manual_review",
        updatedAt: nowIso(),
      },
      mode: "human",
      humanRequested: true,
      requiresManualReview: true,
      updatedAt: nowIso(),
    };
    eventType = "post_stay_negative_manual_review";
  } else {
    return undefined;
  }

  await replaceConversationBestEffort(input.store, nextConversation, "post_stay_followup_update");
  await addEventBestEffort(
    input.store,
    createEvent(input.conversation.id, eventType),
    eventType,
  );
  const botReply = await addRenderedBotMessageBestEffort(
    input.store,
    input.conversation.id,
    reply,
    "post_stay_followup_reply",
  );

  return {
    conversation: await getConversationByIdBestEffort(
      input.store,
      input.conversation.id,
      nextConversation,
      "post_stay_followup_return_read",
    ),
    inbound: input.inbound,
    botReply,
    twiml: buildTwilioMessageResponse(reply),
  };
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
  const botReply = await addRenderedBotMessage(
    input.store,
    input.conversation.id,
    input.reply,
    input.eventType,
  );

  return {
    conversation: (await input.store.getById(input.conversation.id)) ?? input.conversation,
    inbound: input.inbound,
    botReply,
    twiml: buildTwilioMessageResponse(input.reply),
  };
}

async function handleTemplatePreviewCommand(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  inbound: Message;
  safeBody: string;
}): Promise<InboundResult | undefined> {
  let templatePreview: ReturnType<typeof buildTemplatePreviewResult>;

  try {
    templatePreview = buildTemplatePreviewResult(input.safeBody, input.conversation);
  } catch (error) {
    console.warn("template_preview_failed", safeConversationStoreError(error));
    await addEventBestEffort(
      input.store,
      createEvent(input.conversation.id, "template_preview_failed", safeConversationStoreError(error)),
      "template_preview_failed",
    );
    const botReply = await addRenderedBotMessageBestEffort(
      input.store,
      input.conversation.id,
      TEMPLATE_PREVIEW_FAILED_REPLY,
      "template_preview_failed_reply",
    );

    return {
      conversation: await getConversationByIdBestEffort(
        input.store,
        input.conversation.id,
        input.conversation,
        "template_preview_failed_return_read",
      ),
      inbound: input.inbound,
      botReply,
      twiml: buildTwilioMessageResponse(TEMPLATE_PREVIEW_FAILED_REPLY),
    };
  }

  if (!templatePreview) {
    return undefined;
  }

  await addEventBestEffort(
    input.store,
    createEvent(
      input.conversation.id,
      templatePreview.kind === "disabled"
        ? "template_preview_disabled"
        : "template_preview_rendered",
      templatePreview.eventPayload,
    ),
    templatePreview.kind === "disabled"
      ? "template_preview_disabled"
      : "template_preview_rendered",
  );
  const botReply = await addRenderedBotMessageBestEffort(
    input.store,
    input.conversation.id,
    templatePreview.reply,
    "template_preview_reply",
  );

  return {
    conversation: await getConversationByIdBestEffort(
      input.store,
      input.conversation.id,
      input.conversation,
      "template_preview_return_read",
    ),
    inbound: input.inbound,
    botReply,
    twiml: buildTwilioMessageResponse(templatePreview.reply),
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
  contractGateSkip?: {
    reason: ContractGateSkippedReason;
    proposal?: PendingReservationProposal;
  };
}): Promise<InboundResult> {
  await input.store.replaceConversation(input.outcome.conversation);
  if (input.contractGateSkip) {
    await emitContractGateSkipped({
      store: input.store,
      conversation: input.outcome.conversation,
      reason: input.contractGateSkip.reason,
      proposal: input.contractGateSkip.proposal,
    });
  }
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
  const botReply = await addRenderedBotMessage(
    input.store,
    input.outcome.conversation.id,
    input.outcome.reply,
    input.outcome.eventType,
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
  const isFaqIntent = replyPlan.intent.startsWith("faq_") || replyPlan.intent === "general_information";
  const normalized = normalizeOperationalText(message);
  const explicitFaqInsideFlow =
    /\b(?:diferencia\s+entre\s+hotel\s+y\s+guarderia|hotel\s+y\s+guarderia|precio|tarifa|horarios?|pago|visitas?|vacunas?|que\s+tengo\s+que\s+traer|alimentacion|comida)\b/.test(
      normalized,
    );
  if (
    !isFaqIntent ||
    (replyPlan.source !== "faq_public_chat" && !explicitFaqInsideFlow) ||
    (!isConcreteKnowledgeQuestion(message) && !explicitFaqInsideFlow)
  ) {
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

function isInformationReplyPlan(replyPlan: ReturnType<typeof buildConversationReplyPlan>): boolean {
  return (
    replyPlan.intent === "general_information" ||
    replyPlan.intent === "general_info_query" ||
    replyPlan.intent === "topic_info_query" ||
    replyPlan.intent === "faq_query" ||
    replyPlan.intent.startsWith("faq_")
  );
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
    clientPets: strongIdentity ? client?.mascotas : undefined,
    clientPetsCount: strongIdentity ? client?.mascotasCount : undefined,
    clientPetsMatchStatus: strongIdentity ? client?.mascotasMatchStatus : undefined,
    clientPetsMeta: strongIdentity ? client?.mascotasMeta : undefined,
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
  timing?: AuthorityTurnTimingAccumulator,
): Promise<{ conversation: ConversationRecord; identity: ClientIdentityResult }> {
  if (isStrongDirectoryConversation(record) && hasPersistedClientDirectoryMatch(record)) {
    if (timing) {
      timing.clientDirectoryCacheHit = true;
    }
    const preservedAfterReset = record.events.some(
      (event) => event.eventType === "conversation_reset_requested",
    );
    await store.addEvent(
      createEvent(record.id, "client_identity_lookup_cache_hit", {
        status: "known",
        matchType: record.clientMatchType,
        source: record.clientSource ?? CLIENT_DIRECTORY_SOURCE,
        preservedAfterReset,
      }),
    );
    if (preservedAfterReset) {
      await store.addEvent(
        createEvent(record.id, "client_identity_preserved_after_reset", {
          status: "known",
          source: record.clientSource ?? CLIENT_DIRECTORY_SOURCE,
        }),
      );
    }
    return {
      conversation: record,
      identity: {
        status: "known",
        confidence: record.clientConfidence ?? "strong",
        matchType: record.clientMatchType ?? "phone",
        client: {
          nombre: record.clientName ?? record.customerName ?? "Cliente conocido",
          telefonoMovil: record.phoneE164,
          telefonoNormalizado: record.phoneNormalized,
          email: record.clientEmail,
          mascotas: record.clientPets,
          mascotasCount: record.clientPetsCount,
          mascotasMatchStatus: record.clientPetsMatchStatus,
          mascotasMeta: record.clientPetsMeta,
          rowNumber: record.clientSheetRow,
          sheetName: record.clientSheetName,
        },
        warnings: record.clientWarnings,
        source: CLIENT_DIRECTORY_SOURCE,
      },
    };
  }

  await store.addEvent(
    createEvent(record.id, "client_identity_lookup_started", {
      source: CLIENT_DIRECTORY_SOURCE,
      phoneNormalized: safePhoneSummary(record.phoneNormalized),
    }),
  );
  const identity = await measureAuthorityStage(timing, "clientLookupMs", "client_directory_lookup", async () => {
    if (isGoogleSheetsBackedStore(clientDirectory)) {
      incrementCount(timing, "sheetsReads");
    }
    return new ClientDirectoryService(clientDirectory).resolveClientIdentity({
      phone: payload.from,
      name: payload.displayName,
    });
  });
  const next = applyClientIdentity(record, identity);
  const conversation = await store.replaceConversation(next);
  await store.addEvent(
    createEvent(record.id, "client_identity_lookup_result", sanitizeClientIdentityPayload(identity)),
  );
  if (identity.status === "unknown") {
    await store.addEvent(
      createEvent(record.id, "client_identity_lookup_cache_miss", {
        status: identity.status,
        source: identity.source,
      }),
    );
  }

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
    pendingBathOffer: undefined,
    pendingPostStayFollowup: undefined,
    reservationFlow: undefined,
    activeFlow: "none",
    pendingInfoTopic: undefined,
    heldReservationIntent: undefined,
    availabilityInquiry: undefined,
    lastAnsweredTopic: undefined,
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
        clearedPendingBathOffer: Boolean(latest.pendingBathOffer),
        clearedPendingPostStayFollowup: Boolean(latest.pendingPostStayFollowup),
        clearedReservationFlow: Boolean(latest.reservationFlow),
        clearedHumanMode: latest.mode === "human" || latest.humanRequested,
      }),
    );
    if (latest.pendingReservationProposal) {
      await emitContractGateSkipped({
        store,
        conversation: latest,
        reason: "skipped_reset",
        proposal: latest.pendingReservationProposal,
      });
    }
    const botReply = await addRenderedBotMessage(
      store,
      conversation.id,
      CONVERSATION_RESET_REPLY,
      "conversation_reset_requested",
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

function hasPersistedClientDirectoryMatch(record: ConversationRecord): boolean {
  return record.events.some((event) => event.eventType === "client_directory_match");
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

function lastConversationEventIndex(record: ConversationRecord, eventType: string): number {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    if (record.events[index]?.eventType === eventType) {
      return index;
    }
  }
  return -1;
}

function hasWelcomeSinceLastReset(record: ConversationRecord): boolean {
  return (
    lastConversationEventIndex(record, "welcome_template_selected") >
    lastConversationEventIndex(record, "conversation_reset_requested")
  );
}

function welcomeRenderKey(record: ConversationRecord): ConversationRenderKey {
  return isStrongDirectoryConversation(record)
    ? "conversation.welcome_known_client"
    : "conversation.welcome_unknown_client";
}

function renderGreetingWithWelcomeLock(input: {
  message: string;
  replyPlan: { renderKey: ConversationRenderKey };
  record: ConversationRecord;
}): {
  reply: string;
  renderKey: ConversationRenderKey;
  eventType: "welcome_template_selected" | "welcome_template_skipped";
  reason?: string;
} {
  if (hasWelcomeSinceLastReset(input.record)) {
    return {
      reply: personalizeGreetingReply(
        renderConversationReplyPlan(input.replyPlan, input.message),
        input.record,
      ),
      renderKey: input.replyPlan.renderKey,
      eventType: "welcome_template_skipped",
      reason: "already_sent_since_last_reset",
    };
  }

  const renderKey = welcomeRenderKey(input.record);
  return {
    reply: renderCopy({
      key: renderKey,
      message: input.message,
      firstName: knownClientFirstName(input.record),
    }),
    renderKey,
    eventType: "welcome_template_selected",
  };
}

function availabilityFirstRenderKey(
  missingFields: ConversationAvailabilityInquiry["missingFields"],
): ConversationRenderKey {
  if (missingFields.length === 0) {
    return "availability_first_pet_recorded_checking";
  }
  if (missingFields.length === 1 && missingFields[0] === "petName") {
    return "availability_first_collect_pet";
  }
  if (missingFields.length === 1 && missingFields[0] === "dateRange") {
    return "availability_first_clarify_range";
  }
  if (missingFields.length === 1 && missingFields[0] === "times") {
    return "availability_first_clarify_times";
  }
  return "availability_first_needs_details";
}

type AvailabilitySlot = NonNullable<ConversationAvailabilityInquiry["checkInSlot"]>;

const SAFE_CLIENT_PET_STATUSES = new Set([
  "exact",
  "exact_or_token",
  "token_subset_unique",
  "probable_high_unique_token",
  "exact_canonical",
  "token_subset_unique_canonical",
  "probable_high_unique_token_canonical",
  "duplicate_clear_canonical",
]);

function getDefaultAvailabilityBuildSheetAdapter() {
  return getHotelFeatureFlags().useGoogleSheetsReal
    ? buildGoogleSheetAdapter
    : () => buildMockSheetAdapter("hotel-whatsapp-availability-first.json");
}

function safeAvailabilityKnownPets(record: ConversationRecord): string[] {
  const pets = Array.isArray(record.clientPets)
    ? record.clientPets.map((pet) => pet.trim()).filter(Boolean)
    : [];
  if (!record.clientPetsMatchStatus || !SAFE_CLIENT_PET_STATUSES.has(record.clientPetsMatchStatus)) {
    return [];
  }
  if (record.clientPetsCount !== undefined && record.clientPetsCount !== pets.length) {
    return [];
  }
  return pets;
}

function normalizePetSlotText(value: string): string {
  return normalizeOperationalText(value).replace(/\b(?:mi|se|llama|mascota|perro|perra|para)\b/g, "").replace(/\s+/g, " ").trim();
}

function standalonePetNameCandidate(message: string): string | undefined {
  const candidate = message
    .trim()
    .replace(/^[¿?¡!.,;:\s]+|[¿?¡!.,;:\s]+$/g, "")
    .replace(/\s+/g, " ");
  const normalized = normalizeOperationalText(candidate);
  if (!candidate || candidate.length > 40) {
    return undefined;
  }
  if (!/^[\p{L}\d][\p{L}\d' -]{1,39}$/u.test(candidate)) {
    return undefined;
  }
  if (candidate.split(/\s+/).length > 3) {
    return undefined;
  }
  if (
    /^(?:si|sí|no|hola|gracias|vale|ok|okay|pago|precio|precios|reserva|reservar|disponibilidad|humano|persona)$/iu.test(
      normalized,
    )
  ) {
    return undefined;
  }
  return candidate;
}

function resolveAvailabilityPetSlot(record: ConversationRecord, message: string):
  | { kind: "applied"; petName: string; petCount: number; matchedFrom: "known_pet" | "provisional" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "ignored"; reason: string } {
  const candidate = standalonePetNameCandidate(message);
  if (!candidate) {
    return { kind: "ignored", reason: "not_standalone_pet_name" };
  }

  const normalizedCandidate = normalizePetSlotText(candidate);
  const knownPets = safeAvailabilityKnownPets(record);
  if (knownPets.length > 0) {
    const exactMatches = knownPets.filter((pet) => normalizePetSlotText(pet) === normalizedCandidate);
    if (exactMatches.length === 1) {
      return { kind: "applied", petName: exactMatches[0], petCount: 1, matchedFrom: "known_pet" };
    }
    if (exactMatches.length > 1) {
      return { kind: "ambiguous", candidates: exactMatches };
    }

    if (normalizedCandidate.length >= 2) {
      const fuzzyMatches = knownPets.filter((pet) => {
        const normalizedPet = normalizePetSlotText(pet);
        return normalizedPet.startsWith(normalizedCandidate) || normalizedPet.includes(normalizedCandidate);
      });
      if (fuzzyMatches.length === 1) {
        return { kind: "applied", petName: fuzzyMatches[0], petCount: 1, matchedFrom: "known_pet" };
      }
      if (fuzzyMatches.length > 1) {
        return { kind: "ambiguous", candidates: fuzzyMatches };
      }
    }
  }

  return { kind: "applied", petName: candidate, petCount: 1, matchedFrom: "provisional" };
}

function formatDateKey(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function nextUtcWeekday(now: Date, weekday: number): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysUntil = (weekday - today.getUTCDay() + 7) % 7;
  return addUtcDays(today, daysUntil);
}

function resolveAvailabilityDateWindow(
  relativeDateRange: string | undefined,
  now: Date,
): Pick<ConversationAvailabilityInquiry, "dateStart" | "dateEnd"> {
  if (relativeDateRange === "viernes_a_domingo") {
    const friday = nextUtcWeekday(now, 5);
    return { dateStart: formatDateKey(friday), dateEnd: formatDateKey(addUtcDays(friday, 2)) };
  }
  if (relativeDateRange === "este_fin_de_semana" || relativeDateRange === "sabado_domingo") {
    const saturday = nextUtcWeekday(now, 6);
    return { dateStart: formatDateKey(saturday), dateEnd: formatDateKey(addUtcDays(saturday, 1)) };
  }
  return {};
}

function availabilitySlotFromTime(time: string | undefined): AvailabilitySlot | undefined {
  if (!time) {
    return undefined;
  }
  const normalized = normalizeOperationalText(time);
  if (normalized.includes("manana")) {
    return "morning";
  }
  if (normalized.includes("tarde")) {
    return "afternoon";
  }
  const hour = Number.parseInt(time.slice(0, 2), 10);
  return Number.isFinite(hour) && hour < 14 ? "morning" : "afternoon";
}

function computeAvailabilityMissingFields(
  inquiry: ConversationAvailabilityInquiry,
): ConversationAvailabilityInquiry["missingFields"] {
  const missingFields: ConversationAvailabilityInquiry["missingFields"] = [];
  if (!inquiry.petName) {
    missingFields.push("petName");
  }
  if (!inquiry.dateStart || !inquiry.dateEnd) {
    missingFields.push("dateRange");
  }
  if (
    inquiry.petName &&
    inquiry.dateStart &&
    inquiry.dateEnd &&
    (!inquiry.checkInSlot || !inquiry.checkOutSlot)
  ) {
    missingFields.push("times");
  }
  return missingFields;
}

function normalizeAvailabilityInquiry(
  inquiry: ConversationAvailabilityInquiry,
  now: Date,
): ConversationAvailabilityInquiry {
  const dateWindow =
    inquiry.dateStart && inquiry.dateEnd
      ? {}
      : resolveAvailabilityDateWindow(inquiry.relativeDateRange, now);
  const normalized: ConversationAvailabilityInquiry = {
    ...inquiry,
    ...dateWindow,
    petCount: inquiry.petCount ?? (inquiry.petName ? 1 : undefined),
  };
  const missingFields = computeAvailabilityMissingFields(normalized);
  return {
    ...normalized,
    missingFields,
    readyForTool: missingFields.length === 0,
    readyForHumanReview: missingFields.length === 0,
  };
}

async function replaceConversationPreservingTimeline(
  store: ConversationStore,
  record: ConversationRecord,
): Promise<ConversationRecord> {
  const latest = await store.getById(record.id);
  return store.replaceConversation({
    ...record,
    messages: latest?.messages ?? record.messages,
    events: latest?.events ?? record.events,
  });
}

async function renderAvailabilityInquiryOutcome(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  inbound: Message;
  safeBody: string;
  renderKey: ConversationRenderKey;
  eventType: string;
  eventPayload?: Record<string, unknown>;
}): Promise<InboundResult> {
  const replyBody = personalizeGreetingReply(
    renderCopy({
      key: input.renderKey,
      message: input.safeBody,
      petName: input.conversation.availabilityInquiry?.petName,
      pets: safeAvailabilityKnownPets(input.conversation),
      relativeDateRange: input.conversation.availabilityInquiry?.dateRange,
    }),
    input.conversation,
  );
  const savedConversation = await replaceConversationPreservingTimeline(
    input.store,
    input.conversation,
  );
  await input.store.addEvent(
    createEvent(savedConversation.id, input.eventType, {
      ...(input.eventPayload ?? {}),
      renderTemplateId: input.renderKey,
    }),
  );
  await input.store.addEvent(
    createEvent(savedConversation.id, "policy_decision", {
      route: "availability_inquiry",
      action: input.conversation.availabilityInquiry?.missingFields.length
        ? "ask_missing_slot"
        : "availability_precheck",
      renderKey: input.renderKey,
    }),
  );
  const botReply = await addRenderedBotMessage(
    input.store,
    savedConversation.id,
    replyBody,
    input.renderKey,
  );
  return {
    conversation: (await input.store.getById(savedConversation.id)) ?? savedConversation,
    inbound: input.inbound,
    botReply,
    twiml: buildTwilioMessageResponse(replyBody),
  };
}

async function runAvailabilityPrecheckReadOnly(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  inbound: Message;
  safeBody: string;
  deps?: WhatsAppReservationBridgeDeps;
  timing: AuthorityTurnTimingAccumulator;
}): Promise<InboundResult> {
  const inquiry = input.conversation.availabilityInquiry;
  if (!inquiry?.dateStart || !inquiry.dateEnd || !inquiry.checkInSlot || !inquiry.checkOutSlot) {
    const missingConversation: ConversationRecord = {
      ...input.conversation,
      availabilityInquiry: normalizeAvailabilityInquiry(inquiry ?? { missingFields: [] }, input.deps?.now?.() ?? new Date()),
      updatedAt: nowIso(),
    };
    return renderAvailabilityInquiryOutcome({
      store: input.store,
      conversation: missingConversation,
      inbound: input.inbound,
      safeBody: input.safeBody,
      renderKey: availabilityFirstRenderKey(
        missingConversation.availabilityInquiry?.missingFields ?? ["times"],
      ),
      eventType: "availability_precheck_missing_fields",
      eventPayload: {
        missingFields: missingConversation.availabilityInquiry?.missingFields ?? [],
        noAvailabilityPromised: true,
      },
    });
  }

  await replaceConversationPreservingTimeline(input.store, {
    ...input.conversation,
    availabilityInquiry: {
      ...inquiry,
      availabilityStatus: "pending",
    },
    updatedAt: nowIso(),
  });
  await input.store.addEvent(
    createEvent(input.conversation.id, "availability_precheck_started", {
      mode: "read_only",
      petName: inquiry.petName,
      dateStart: inquiry.dateStart,
      dateEnd: inquiry.dateEnd,
      checkInSlot: inquiry.checkInSlot,
      checkOutSlot: inquiry.checkOutSlot,
      dogs: inquiry.petCount ?? 1,
    }),
  );

  try {
    const availability = await measureAuthorityStage(
      input.timing,
      "toolsMs",
      "availability_precheck_read_only",
      async () => {
        const adapter = await (input.deps?.buildSheetAdapter ?? getDefaultAvailabilityBuildSheetAdapter())();
        return adapter.checkAvailability({
          entryDate: inquiry.dateStart!,
          entrySlot: inquiry.checkInSlot!,
          exitDate: inquiry.dateEnd!,
          exitSlot: inquiry.checkOutSlot!,
          dogs: inquiry.petCount ?? 1,
        });
      },
    );
    const availableConversation: ConversationRecord = {
      ...input.conversation,
      activeFlow: "availabilityInquiry",
      availabilityInquiry: {
        ...inquiry,
        availabilityStatus: availability.available ? "available" : "unavailable",
        availabilitySnapshot: {
          monthKey: availability.monthKey,
          available: availability.available,
          conflictCount: availability.conflicts.length,
        },
        missingFields: [],
        readyForTool: true,
        readyForHumanReview: false,
      },
      updatedAt: nowIso(),
    };
    const renderKey: ConversationRenderKey = availability.available
      ? "availability_first_available_offer_reservation"
      : "availability_first_unavailable";
    await replaceConversationPreservingTimeline(input.store, availableConversation);
    await input.store.addEvent(
      createEvent(input.conversation.id, "availability_precheck_result", {
        mode: "read_only",
        available: availability.available,
        conflictCount: availability.conflicts.length,
        renderTemplateId: renderKey,
      }),
    );
    if (!availability.available) {
      await input.store.addEvent(
        createEvent(input.conversation.id, "availability_precheck_unavailable", {
          conflictCount: availability.conflicts.length,
        }),
      );
    } else {
      await input.store.addEvent(
        createEvent(input.conversation.id, "availability_first_offered_reservation", {
          petName: inquiry.petName,
        }),
      );
    }
    return renderAvailabilityInquiryOutcome({
      store: input.store,
      conversation: availableConversation,
      inbound: input.inbound,
      safeBody: input.safeBody,
      renderKey,
      eventType: "availability_first_reply_sent",
      eventPayload: {
        mode: "read_only",
        noReservationCreated: true,
      },
    });
  } catch (error) {
    const errorConversation: ConversationRecord = {
      ...input.conversation,
      mode: "bot",
      availabilityInquiry: {
        ...inquiry,
        availabilityStatus: "error",
        readyForTool: false,
        readyForHumanReview: true,
      },
      updatedAt: nowIso(),
    };
    await replaceConversationPreservingTimeline(input.store, errorConversation);
    await input.store.addEvent(
      createEvent(input.conversation.id, "availability_precheck_error", {
        mode: "read_only",
        ...safeConversationStoreError(error),
      }),
    );
    return renderAvailabilityInquiryOutcome({
      store: input.store,
      conversation: errorConversation,
      inbound: input.inbound,
      safeBody: input.safeBody,
      renderKey: "availability_first_precheck_error_handoff_contextual",
      eventType: "availability_first_reply_sent",
      eventPayload: {
        mode: "read_only",
      },
    });
  }
}

async function handleAvailabilityInquiryContinuation(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  inbound: Message;
  safeBody: string;
  deps?: WhatsAppReservationBridgeDeps;
  timing: AuthorityTurnTimingAccumulator;
}): Promise<InboundResult | undefined> {
  if (!input.conversation.availabilityInquiry && input.conversation.activeFlow !== "availabilityInquiry") {
    return undefined;
  }

  const now = input.deps?.now?.() ?? new Date();
  const before = normalizeAvailabilityInquiry(
    input.conversation.availabilityInquiry ?? { missingFields: [] },
    now,
  );
  let nextInquiry: ConversationAvailabilityInquiry = before;
  let petSlotResult: ReturnType<typeof resolveAvailabilityPetSlot> | undefined;
  const extractedSlots = extractReservationSlotsFromMessage(input.safeBody, { now });
  const relativeRange = extractRelativeDateRange(input.safeBody);

  await input.store.addEvent(
    createEvent(input.conversation.id, "availability_slot_merge_attempted", {
      missingFieldsBefore: before.missingFields,
      ...safeBodyKind(input.safeBody),
    }),
  );
  await input.store.addEvent(
    createEvent(input.conversation.id, "nlu_classified", {
      intent: "availability_slot_reply",
      confidence: 1,
      source: "state_aware_availability_reducer",
      activeFlow: "availabilityInquiry",
    }),
  );

  if (!nextInquiry.petName && before.missingFields.includes("petName")) {
    petSlotResult = resolveAvailabilityPetSlot(input.conversation, input.safeBody);
    if (petSlotResult.kind === "applied") {
      nextInquiry = {
        ...nextInquiry,
        petName: petSlotResult.petName,
        petCount: petSlotResult.petCount,
      };
      await input.store.addEvent(
        createEvent(input.conversation.id, "availability_pet_slot_applied", {
          petName: petSlotResult.petName,
          matchedFrom: petSlotResult.matchedFrom,
        }),
      );
    } else if (petSlotResult.kind === "ambiguous") {
      const ambiguousConversation: ConversationRecord = {
        ...input.conversation,
        activeFlow: "availabilityInquiry",
        availabilityInquiry: before,
        updatedAt: now.toISOString(),
      };
      await input.store.addEvent(
        createEvent(input.conversation.id, "availability_pet_slot_ambiguous", {
          candidates: petSlotResult.candidates,
        }),
      );
      return renderAvailabilityInquiryOutcome({
        store: input.store,
        conversation: ambiguousConversation,
        inbound: input.inbound,
        safeBody: input.safeBody,
        renderKey: "availability_first_clarify_pet_ambiguous",
        eventType: "availability_pending_fields_after_merge",
        eventPayload: {
          missingFields: before.missingFields,
          petAmbiguous: true,
        },
      });
    } else {
      await input.store.addEvent(
        createEvent(input.conversation.id, "availability_pet_slot_ignored", {
          reason: petSlotResult.reason,
        }),
      );
    }
  }

  if (relativeRange && (!nextInquiry.dateStart || !nextInquiry.dateEnd)) {
    nextInquiry = {
      ...nextInquiry,
      relativeDateRange: relativeRange.id,
      dateRange: relativeRange.label,
    };
  }
  nextInquiry = {
    ...nextInquiry,
    dateStart: extractedSlots.checkInDate ?? nextInquiry.dateStart,
    dateEnd: extractedSlots.checkOutDate ?? nextInquiry.dateEnd,
    checkInTime: extractedSlots.checkInTime ?? nextInquiry.checkInTime,
    checkOutTime: extractedSlots.checkOutTime ?? nextInquiry.checkOutTime,
  };
  nextInquiry = {
    ...nextInquiry,
    checkInSlot: availabilitySlotFromTime(nextInquiry.checkInTime) ?? nextInquiry.checkInSlot,
    checkOutSlot: availabilitySlotFromTime(nextInquiry.checkOutTime) ?? nextInquiry.checkOutSlot,
  };
  nextInquiry = normalizeAvailabilityInquiry(nextInquiry, now);

  const nextConversation: ConversationRecord = {
    ...input.conversation,
    activeFlow: "availabilityInquiry",
    availabilityInquiry: nextInquiry,
    updatedAt: now.toISOString(),
  };
  await input.store.addEvent(
    createEvent(input.conversation.id, "availability_pending_fields_after_merge", {
      missingFields: nextInquiry.missingFields,
      petName: nextInquiry.petName,
      dateStart: nextInquiry.dateStart,
      dateEnd: nextInquiry.dateEnd,
      checkInSlot: nextInquiry.checkInSlot,
      checkOutSlot: nextInquiry.checkOutSlot,
    }),
  );

  if (nextInquiry.missingFields.length > 0) {
    return renderAvailabilityInquiryOutcome({
      store: input.store,
      conversation: nextConversation,
      inbound: input.inbound,
      safeBody: input.safeBody,
      renderKey: availabilityFirstRenderKey(nextInquiry.missingFields),
      eventType: "availability_precheck_missing_fields",
      eventPayload: {
        missingFields: nextInquiry.missingFields,
        noAvailabilityPromised: true,
      },
    });
  }

  return runAvailabilityPrecheckReadOnly({
    store: input.store,
    conversation: nextConversation,
    inbound: input.inbound,
    safeBody: input.safeBody,
    deps: input.deps,
    timing: input.timing,
  });
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

function contractGatePayload(
  reason: ContractGateAppliedReason | ContractGateSkippedReason,
  proposal?: PendingReservationProposal,
): Record<string, unknown> {
  return {
    reason,
    proposalId: proposal?.proposalId,
    proposalStatus: proposal?.status,
    termsAccepted: proposal?.termsAccepted === true,
    contractAcceptanceRequested: Boolean(proposal?.contractAcceptanceRequestedAt),
  };
}

async function emitContractGateApplied(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  reason: ContractGateAppliedReason;
  proposal?: PendingReservationProposal;
}): Promise<void> {
  await addEventBestEffort(
    input.store,
    createEvent(
      input.conversation.id,
      "contract_gate_applied",
      contractGatePayload(input.reason, input.proposal),
    ),
    "contract_gate_applied",
  );
}

async function emitContractGateSkipped(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  reason: ContractGateSkippedReason;
  proposal?: PendingReservationProposal;
}): Promise<void> {
  await addEventBestEffort(
    input.store,
    createEvent(
      input.conversation.id,
      "contract_gate_skipped",
      contractGatePayload(input.reason, input.proposal),
    ),
    "contract_gate_skipped",
  );
}

async function resolveContractAcceptanceGate(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  message: string;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<
  | { handled: false; conversation: ConversationRecord }
  | { handled: true; conversation: ConversationRecord; reply: string }
> {
  const config = getClientRequestsConfig();
  const proposal = input.conversation.pendingReservationProposal;
  if (!proposal) {
    await emitContractGateSkipped({
      store: input.store,
      conversation: input.conversation,
      reason: "skipped_no_active_proposal",
    });
    return { handled: false, conversation: input.conversation };
  }

  if (!config.requireContractAcceptance || proposal.status !== "proposed") {
    await emitContractGateSkipped({
      store: input.store,
      conversation: input.conversation,
      reason: "skipped_not_ready",
      proposal,
    });
    return { handled: false, conversation: input.conversation };
  }

  if (proposal.termsAccepted) {
    await emitContractGateSkipped({
      store: input.store,
      conversation: input.conversation,
      reason: "skipped_terms_already_accepted",
      proposal,
    });
    return { handled: false, conversation: input.conversation };
  }

  const nowValue = input.deps?.now?.() ?? new Date();
  const nowValueIso = nowValue.toISOString();
  const buildProposalPatch = (
    patch: Partial<PendingReservationProposal>,
  ): PendingReservationProposal => ({
    ...proposal,
    termsUrl: config.contractUrl,
    termsVersion: CONTRACT_TERMS_VERSION,
    termsSource: "whatsapp_link",
    ...patch,
  });

  if (
    proposal.contractAcceptanceRequestedAt &&
    (isExplicitContractAcceptance(input.message) || isContextualContractAcceptance(input.message))
  ) {
    const acceptedProposal = buildProposalPatch({
      termsAccepted: true,
      termsAcceptedAt: nowValueIso,
    });
    const acceptedRecord: ConversationRecord = {
      ...input.conversation,
      pendingReservationProposal: acceptedProposal,
      updatedAt: nowValueIso,
    };
    await replaceConversationBestEffort(
      input.store,
      acceptedRecord,
      "contract_acceptance_update_conversation",
    );
    await addEventBestEffort(
      input.store,
      createEvent(input.conversation.id, "contract_accepted", {
        proposalId: proposal.proposalId,
        termsVersion: CONTRACT_TERMS_VERSION,
        termsSource: "whatsapp_link",
      }),
      "contract_accepted",
    );

    return {
      handled: false,
      conversation: await getConversationByIdBestEffort(
        input.store,
        input.conversation.id,
        acceptedRecord,
        "contract_acceptance_return_read",
      ),
    };
  }

  if (isExplicitContractRejection(input.message)) {
    const rejectedProposal = buildProposalPatch({
      termsAccepted: false,
      failureReason: "contract_not_accepted",
    });
    const rejectedRecord: ConversationRecord = {
      ...input.conversation,
      pendingReservationProposal: rejectedProposal,
      mode: "human",
      humanRequested: true,
      requiresManualReview: true,
      updatedAt: nowValueIso,
    };
    await replaceConversationBestEffort(
      input.store,
      rejectedRecord,
      "contract_rejection_update_conversation",
    );
    await addEventBestEffort(
      input.store,
      createEvent(input.conversation.id, "contract_acceptance_rejected", {
        proposalId: proposal.proposalId,
      }),
      "contract_acceptance_rejected",
    );

    return {
      handled: true,
      conversation: await getConversationByIdBestEffort(
        input.store,
        input.conversation.id,
        rejectedRecord,
        "contract_rejection_return_read",
      ),
      reply:
        "De acuerdo, no confirmamos la reserva sin aceptar las condiciones. Lo revisa una persona del equipo y te contestamos por aqui.",
    };
  }

  const requestedProposal = buildProposalPatch({
    termsAccepted: false,
    contractAcceptanceRequestedAt: proposal.contractAcceptanceRequestedAt ?? nowValueIso,
  });
  const requestedRecord: ConversationRecord = {
    ...input.conversation,
    pendingReservationProposal: requestedProposal,
    updatedAt: nowValueIso,
  };
  await replaceConversationBestEffort(
    input.store,
    requestedRecord,
    "contract_request_update_conversation",
  );
  await addEventBestEffort(
    input.store,
    createEvent(input.conversation.id, "contract_acceptance_requested", {
      proposalId: proposal.proposalId,
      termsVersion: CONTRACT_TERMS_VERSION,
      termsUrlConfigured: Boolean(config.contractUrl),
    }),
    "contract_acceptance_requested",
  );
  await addEventBestEffort(
    input.store,
    createEvent(input.conversation.id, "contract_link_sent", {
      proposalId: proposal.proposalId,
      termsVersion: CONTRACT_TERMS_VERSION,
      termsUrlConfigured: Boolean(config.contractUrl),
    }),
    "contract_link_sent",
  );
  await emitContractGateApplied({
    store: input.store,
    conversation: input.conversation,
    reason: "confirm_proposal_requires_acceptance",
    proposal: requestedProposal,
  });

  return {
    handled: true,
    conversation: await getConversationByIdBestEffort(
      input.store,
      input.conversation.id,
      requestedRecord,
      "contract_request_return_read",
    ),
    reply: buildContractAcceptanceRequest(config),
  };
}

async function confirmConversationReservation(input: {
  store: ConversationStore;
  conversation: ConversationRecord;
  message: string;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<{ conversation: ConversationRecord; reply: string }> {
  const latest = (await input.store.getById(input.conversation.id)) ?? input.conversation;
  const contractGate = await resolveContractAcceptanceGate({
    store: input.store,
    conversation: latest,
    message: input.message,
    deps: input.deps,
  });
  if (contractGate.handled) {
    return {
      conversation: contractGate.conversation,
      reply: contractGate.reply,
    };
  }

  const conversationForConfirmation = contractGate.conversation;
  const confirmation = await confirmPendingReservationProposal({
    conversation: conversationForConfirmation,
    deps: input.deps,
  });
  await addEventBestEffort(
    input.store,
    createEvent(conversationForConfirmation.id, "reservation_confirmation_checked", {
      kind: confirmation.kind,
      ...confirmation.eventPayload,
    }),
    "reservation_confirmation_checked",
  );
  if (confirmation.eventPayload?.legacyConfirmationBlocked) {
    await addEventBestEffort(
      input.store,
      createEvent(conversationForConfirmation.id, "legacy_confirmation_blocked", {
        proposalId: confirmation.proposal?.proposalId,
        reason: confirmation.eventPayload.reason,
      }),
      "legacy_confirmation_blocked",
    );
  }

  const latestAfterEvent =
    (await input.store.getById(conversationForConfirmation.id)) ?? conversationForConfirmation;
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
  let nextRecord = applyClientReservationUpsert(
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
      createEvent(conversationForConfirmation.id, "reservation_confirmed_from_whatsapp", {
        reservationIdSummary: summarizeReservationId(confirmation.reservation.reservationId),
        proposalId: confirmation.proposal?.proposalId,
      }),
      "reservation_confirmed_from_whatsapp",
    );
    if (getClientRequestsConfig().confirmationTemplateEnabled) {
      await addEventBestEffort(
        input.store,
        createEvent(conversationForConfirmation.id, "confirmation_template_sent", {
          reservationIdSummary: summarizeReservationId(confirmation.reservation.reservationId),
          mode: "whatsapp_reply",
        }),
        "confirmation_template_sent",
      );
    }
    if (confirmation.proposal?.termsAccepted) {
      await addEventBestEffort(
        input.store,
        createEvent(conversationForConfirmation.id, "reservation_confirmed_after_terms", {
          reservationIdSummary: summarizeReservationId(confirmation.reservation.reservationId),
          proposalId: confirmation.proposal.proposalId,
          termsVersion: confirmation.proposal.termsVersion,
        }),
        "reservation_confirmed_after_terms",
      );
    }
    try {
      const scheduleNow = input.deps?.now?.() ?? new Date();
      const scheduled = await scheduleBathOfferAfterConfirmation({
        reservation: confirmation.reservation,
        conversation: nextRecord,
        now: scheduleNow,
        store: input.deps?.scheduledMessageStore,
      });
      if (scheduled.scheduled && scheduled.message) {
        const latestForBath =
          (await input.store.getById(conversationForConfirmation.id)) ?? nextRecord;
        nextRecord = {
          ...latestForBath,
          pendingBathOffer: {
            flowId: createId("bath_offer"),
            conversationId: conversationForConfirmation.id,
            reservationId: confirmation.reservation.reservationId,
            status: "scheduled",
            petNames: confirmation.reservation.petNames?.length
              ? confirmation.reservation.petNames
              : [confirmation.reservation.petName ?? "tu mascota"],
            createdAt: scheduleNow.toISOString(),
            updatedAt: scheduleNow.toISOString(),
          },
          updatedAt: scheduleNow.toISOString(),
        };
        await replaceConversationBestEffort(
          input.store,
          nextRecord,
          "bath_offer_schedule_update_conversation",
        );
        await addEventBestEffort(
          input.store,
          createEvent(conversationForConfirmation.id, "bath_offer_scheduled", {
            reservationIdSummary: summarizeReservationId(confirmation.reservation.reservationId),
            scheduledAt: scheduled.message.scheduledAt,
            dryRun: scheduled.dryRun,
          }),
          "bath_offer_scheduled",
        );
        if (scheduled.dryRun) {
          await addEventBestEffort(
            input.store,
            createEvent(conversationForConfirmation.id, "bath_offer_dry_run", {
              reservationIdSummary: summarizeReservationId(
                confirmation.reservation.reservationId,
              ),
              scheduledAt: scheduled.message.scheduledAt,
            }),
            "bath_offer_dry_run",
          );
        }
      }
    } catch (error) {
      console.warn("bath_offer_schedule_failed", safeConversationStoreError(error));
      await addEventBestEffort(
        input.store,
        createEvent(conversationForConfirmation.id, "bath_offer_schedule_failed", {
          reservationIdSummary: summarizeReservationId(confirmation.reservation.reservationId),
          ...safeConversationStoreError(error),
        }),
        "bath_offer_schedule_failed",
      );
    }
  }

  if (confirmation.clientDirectoryUpsert) {
    await addEventBestEffort(
      input.store,
      createEvent(
        conversationForConfirmation.id,
        clientUpsertEventType(confirmation.clientDirectoryUpsert),
        sanitizeClientUpsertPayload(confirmation.clientDirectoryUpsert),
      ),
      "client_directory_upsert_result",
    );
  }

  if (confirmation.handoff) {
    await addEventBestEffort(
      input.store,
      createEvent(conversationForConfirmation.id, "human_requested", {
        matchedFrom: "reservation_bridge",
        reason: confirmation.kind,
      }),
      "reservation_confirmation_handoff",
    );
  }

  return {
    conversation: await getConversationByIdBestEffort(
      input.store,
      conversationForConfirmation.id,
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
  const timing = createAuthorityTiming(payload.timing);
  const instrumentedStore = instrumentConversationStore(store, timing);
  const result = await handleInboundWhatsAppWithTiming(
    payload,
    instrumentedStore,
    clientDirectory,
    reservationBridgeDeps,
    timing,
  );
  return {
    ...result,
    timing: finalizeAuthorityTiming(timing),
  };
}

async function handleInboundWhatsAppWithTiming(
  payload: InboundWhatsAppPayload,
  store: ConversationStore,
  clientDirectory: ClientDirectory,
  reservationBridgeDeps: WhatsAppReservationBridgeDeps | undefined,
  timing: AuthorityTurnTimingAccumulator,
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
        allowEmptyTwiml: true,
        noReplyReason: "duplicate_message_sid",
      };
    }
  }

  const fresh = (await store.getById(conversation.id)) ?? conversation;
  const clientIdentity = await resolveAndPersistClientIdentity(
    store,
    fresh,
    payload,
    clientDirectory,
    timing,
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
    const replyBody = renderCopy({ key: "service.manual_review" });
    const humanRecord: ConversationRecord = {
      ...freshAfterInbound,
      mode: "human",
      humanRequested: true,
      priority: "urgent",
      requiresManualReview: true,
      updatedAt: nowIso(),
    };
    await store.replaceConversation(humanRecord);
    const botReply = await addRenderedBotMessage(
      store,
      freshAfterInbound.id,
      replyBody,
      "client_blocked_manual_review",
    );

    return {
      conversation: (await store.getById(freshAfterInbound.id)) ?? humanRecord,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(replyBody),
    };
  }

  const templatePreviewOutcome = await handleTemplatePreviewCommand({
    store,
    conversation: freshAfterInbound,
    inbound,
    safeBody,
  });
  if (templatePreviewOutcome) {
    return templatePreviewOutcome;
  }

  const bathOfferOutcome = await handlePendingBathOfferReply({
    store,
    conversation: freshAfterInbound,
    inbound,
    safeBody,
    rawPayload: payload.rawPayload,
  });
  if (bathOfferOutcome) {
    return bathOfferOutcome;
  }

  const postStayOutcome = await handlePendingPostStayFollowupReply({
    store,
    conversation: freshAfterInbound,
    inbound,
    safeBody,
  });
  if (postStayOutcome) {
    return postStayOutcome;
  }

  if (freshWithClient.mode === "human") {
    await store.addEvent(createEvent(freshWithClient.id, "auto_reply_skipped_human_mode"));
    return {
      conversation: (await store.getById(freshWithClient.id)) ?? freshWithClient,
      inbound,
      allowEmptyTwiml: true,
      noReplyReason: "human_mode_auto_reply_suppressed",
    };
  }

  const latestBeforeFlow = (await store.getById(freshWithClient.id)) ?? freshWithClient;
  const availabilityContinuation = await handleAvailabilityInquiryContinuation({
    store,
    conversation: latestBeforeFlow,
    inbound,
    safeBody,
    deps: reservationBridgeDeps,
    timing,
  });
  if (availabilityContinuation) {
    return availabilityContinuation;
  }

  if (isReservationChangeFlowActive(latestBeforeFlow)) {
    const changePlan = measureSyncAuthorityStage(
      timing,
      "nluTotalMs",
      "reservation_change_deterministic_nlu",
      () => buildConversationReplyPlan(safeBody),
    );
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
    const flowInterruptionPlan = measureSyncAuthorityStage(
      timing,
      "nluTotalMs",
      "reservation_flow_deterministic_nlu",
      () => buildConversationReplyPlan(safeBody),
    );
    const assistiveEvents = await measureAuthorityStage(
      timing,
      "nluTotalMs",
      "reservation_flow_assistive_nlu",
      () => buildAssistiveNluEvents({
        record: latestBeforeFlow,
        message: safeBody,
        replyPlan: flowInterruptionPlan,
        now: reservationBridgeDeps?.now?.() ?? new Date(),
        timing,
      }),
    );

    if (isReservationFlowCancelEscape(safeBody)) {
      const cancelled = buildReservationFlowCancelledRecord(latestBeforeFlow);
      const turnTrace = buildAuthorityTurnTrace({
        turnId: createId("turn"),
        recordBefore: latestBeforeFlow,
        recordAfter: cancelled,
        message: safeBody,
        timing,
        nluIntent: flowInterruptionPlan.intent,
        nluGlobalIntent: authorityGlobalIntent({
          message: safeBody,
          intent: flowInterruptionPlan.intent,
          isCancelEscape: true,
        }),
        nluSlotsExtracted: [],
        nluTargetSlots: [],
        policyAction: "cancel_flow",
        policyReason: "reservation_flow_cancel_escape",
        renderKey: "reservation.cancelled",
        outboxKind: "twiml_response",
      });
      await store.replaceConversation(cancelled);
      await addSafeEvents(store, latestBeforeFlow.id, [
        ...authorityRuntimeEvents(turnTrace),
        ...assistiveEvents,
        {
          eventType: "nlu_assistive_global_intent_detected",
          payload: {
            intent: "reservation_flow_cancel",
            source: "deterministic_escape_hatch",
            status: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "reservation_global_intent_escape",
          payload: {
            intent: "reservation_flow_cancel",
            action: "cancel_flow",
            status: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "reservation_flow_cancelled_by_user",
          payload: {
            clearedPendingProposal: Boolean(latestBeforeFlow.pendingReservationProposal),
            clearedReservationFlow: Boolean(latestBeforeFlow.reservationFlow),
          },
        },
      ], timing);
      const botReply = await addRenderedBotMessage(
        store,
        latestBeforeFlow.id,
        RESERVATION_FLOW_CANCELLED_REPLY,
        "reservation_flow_cancelled_by_user",
      );

      return {
        conversation: (await store.getById(latestBeforeFlow.id)) ?? cancelled,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(RESERVATION_FLOW_CANCELLED_REPLY),
      };
    }

    if (
      latestBeforeFlow.pendingReservationProposal?.status === "proposed" &&
      (flowInterruptionPlan.intent === "reservation_modify" ||
        flowInterruptionPlan.intent === "reservation_cancel")
    ) {
      if (flowInterruptionPlan.intent === "reservation_cancel") {
        const cancelled = buildReservationFlowCancelledRecord(latestBeforeFlow);
        await store.replaceConversation(cancelled);
        await emitContractGateSkipped({
          store,
          conversation: cancelled,
          reason: "skipped_cancel_intent",
          proposal: latestBeforeFlow.pendingReservationProposal,
        });
        await addSafeEvents(store, latestBeforeFlow.id, [
          ...assistiveEvents,
          {
            eventType: "nlu_classified",
            payload: {
              intent: flowInterruptionPlan.intent,
              confidence: flowInterruptionPlan.confidence,
              matchedSignals: flowInterruptionPlan.matchedSignals,
              slots: flowInterruptionPlan.slots,
              source: flowInterruptionPlan.source,
              interruptedReservationFlow: latestBeforeFlow.reservationFlow?.status,
            },
          },
          {
            eventType: "reservation_global_intent_escape",
            payload: {
              intent: flowInterruptionPlan.intent,
              action: "cancel_pending_proposal",
              status: latestBeforeFlow.reservationFlow?.status,
            },
          },
          {
            eventType: "reservation_flow_cancelled_by_user",
            payload: {
              clearedPendingProposal: true,
              clearedReservationFlow: Boolean(latestBeforeFlow.reservationFlow),
              reason: "reservation_cancel_intent",
            },
          },
        ], timing);
        const botReply = await addRenderedBotMessage(
          store,
          latestBeforeFlow.id,
          RESERVATION_FLOW_CANCELLED_REPLY,
          "reservation_flow_cancelled_by_user",
        );

        return {
          conversation: (await store.getById(latestBeforeFlow.id)) ?? cancelled,
          inbound,
          botReply,
          twiml: buildTwilioMessageResponse(RESERVATION_FLOW_CANCELLED_REPLY),
        };
      }

      const revised = buildReservationFlowRevisionRecord(latestBeforeFlow);
      const replyBody =
        "Claro, dejamos sin efecto la propuesta anterior. ¿Qué quieres modificar: fechas, horarios, mascota o notas?";
      await store.replaceConversation(revised);
      await emitContractGateSkipped({
        store,
        conversation: revised,
        reason: "skipped_modify_intent",
        proposal: latestBeforeFlow.pendingReservationProposal,
      });
      await addSafeEvents(store, latestBeforeFlow.id, [
        ...assistiveEvents,
        {
          eventType: "nlu_classified",
          payload: {
            intent: flowInterruptionPlan.intent,
            confidence: flowInterruptionPlan.confidence,
            matchedSignals: flowInterruptionPlan.matchedSignals,
            slots: flowInterruptionPlan.slots,
            source: flowInterruptionPlan.source,
            interruptedReservationFlow: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "reservation_global_intent_escape",
          payload: {
            intent: flowInterruptionPlan.intent,
            action: "revise_pending_proposal",
            status: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "reservation_proposal_revision_requested",
          payload: {
            previousProposalId: latestBeforeFlow.pendingReservationProposal.proposalId,
            preservedReservationFlow: Boolean(revised.reservationFlow),
          },
        },
      ], timing);
      const botReply = await addRenderedBotMessage(
        store,
        latestBeforeFlow.id,
        replyBody,
        "reservation_proposal_revision_requested",
      );

      return {
        conversation: (await store.getById(latestBeforeFlow.id)) ?? revised,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(replyBody),
      };
    }

    if (
      flowInterruptionPlan.intent === "human_handoff" &&
      flowInterruptionPlan.handoff &&
      isExplicitHumanHandoffRequest(safeBody) &&
      !shouldKeepReservationSlotResolverPriority(latestBeforeFlow, safeBody)
    ) {
      const replyBody = renderConversationReplyPlan(flowInterruptionPlan, safeBody);
      const latestForHandoff = (await store.getById(latestBeforeFlow.id)) ?? latestBeforeFlow;
      const humanRecord: ConversationRecord = {
        ...latestForHandoff,
        mode: "human",
        humanRequested: true,
        requiresManualReview: true,
        updatedAt: nowIso(),
      };
      await store.replaceConversation(humanRecord);
      if (latestBeforeFlow.pendingReservationProposal) {
        await emitContractGateSkipped({
          store,
          conversation: humanRecord,
          reason: "skipped_handoff",
          proposal: latestBeforeFlow.pendingReservationProposal,
        });
      }
      await addSafeEvents(store, latestBeforeFlow.id, [
        ...assistiveEvents,
        {
          eventType: "nlu_classified",
          payload: {
            intent: flowInterruptionPlan.intent,
            confidence: flowInterruptionPlan.confidence,
            matchedSignals: flowInterruptionPlan.matchedSignals,
            slots: flowInterruptionPlan.slots,
            source: flowInterruptionPlan.source,
            handoff: true,
            interruptedReservationFlow: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "nlu_assistive_global_intent_detected",
          payload: {
            intent: flowInterruptionPlan.intent,
            source: flowInterruptionPlan.source,
            status: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "reservation_global_intent_escape",
          payload: {
            intent: flowInterruptionPlan.intent,
            action: "human_handoff",
            status: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "human_requested",
          payload: {
            matchedFrom: "reservation_flow_global_escape",
            intent: flowInterruptionPlan.intent,
          },
        },
      ], timing);
      const botReply = await addRenderedBotMessage(
        store,
        latestBeforeFlow.id,
        replyBody,
        "reservation_flow_handoff_reply",
      );

      return {
        conversation: (await store.getById(latestBeforeFlow.id)) ?? humanRecord,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(replyBody),
      };
    }

    if (shouldInterruptReservationFlowWithFaq(latestBeforeFlow, safeBody, flowInterruptionPlan)) {
      const latestForFaq = (await store.getById(latestBeforeFlow.id)) ?? latestBeforeFlow;
      const renderedInterruptionReply = renderConversationReplyPlan(flowInterruptionPlan, safeBody);
      const replyBody = flowInterruptionPlan.handoff
        ? renderedInterruptionReply
        : appendReservationResume(renderedInterruptionReply, latestForFaq);
      const nextConversation: ConversationRecord = flowInterruptionPlan.handoff
        ? {
            ...latestForFaq,
            mode: "human",
            humanRequested: true,
            requiresManualReview: true,
            updatedAt: nowIso(),
          }
        : latestForFaq;
      const attemptedSlots = measureSyncAuthorityStage(
        timing,
        "deterministicParserMs",
        "faq_resume_slot_parse",
        () => extractReservationSlotsFromMessage(safeBody, {
          flow: latestBeforeFlow.reservationFlow,
          now: reservationBridgeDeps?.now?.() ?? new Date(),
        }),
      );
      const turnTrace = buildAuthorityTurnTrace({
        turnId: createId("turn"),
        recordBefore: latestBeforeFlow,
        recordAfter: nextConversation,
        message: safeBody,
        timing,
        nluIntent: flowInterruptionPlan.intent,
        nluGlobalIntent: authorityGlobalIntent({
          message: safeBody,
          intent: flowInterruptionPlan.intent,
        }),
        nluSlotsExtracted: Object.keys(attemptedSlots),
        nluTargetSlots: [],
        slotsIgnored: ignoredSlotsWithReason(
          Object.keys(attemptedSlots),
          [],
          "faq_interruption_preserves_reservation_state",
        ),
        policyAction: "answer_faq_then_resume",
        policyReason: "faq_inside_reservation",
        renderKey: "conversation.faq_reply",
        outboxKind: "twiml_response",
      });
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
      await addSafeEvents(store, latestBeforeFlow.id, [
        ...authorityRuntimeEvents(turnTrace),
        ...assistiveEvents,
        {
          eventType: "nlu_assistive_global_intent_detected",
          payload: {
            intent: flowInterruptionPlan.intent,
            source: flowInterruptionPlan.source,
            status: latestBeforeFlow.reservationFlow?.status,
          },
        },
        {
          eventType: "reservation_global_intent_escape",
          payload: {
            intent: flowInterruptionPlan.intent,
            action: "faq_resume",
            status: latestBeforeFlow.reservationFlow?.status,
          },
        },
      ], timing);

      if (flowInterruptionPlan.handoff) {
        await store.replaceConversation(nextConversation);
        if (latestBeforeFlow.pendingReservationProposal) {
          await emitContractGateSkipped({
            store,
            conversation: nextConversation,
            reason: "skipped_handoff",
            proposal: latestBeforeFlow.pendingReservationProposal,
          });
        }
        await store.addEvent(
          createEvent(latestForFaq.id, "human_requested", {
            matchedFrom: "faq_public_chat",
            intent: flowInterruptionPlan.intent,
          }),
        );
      } else if (latestBeforeFlow.pendingReservationProposal) {
        await emitContractGateSkipped({
          store,
          conversation: latestForFaq,
          reason: "skipped_not_ready",
          proposal: latestBeforeFlow.pendingReservationProposal,
        });
      }

      const botReply = await addRenderedBotMessage(
        store,
        latestForFaq.id,
        replyBody,
        "reservation_flow_faq_resume_reply",
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
      latestBeforeFlow.pendingReservationProposal?.contractAcceptanceRequestedAt &&
      (isExplicitContractAcceptance(safeBody) ||
        isContextualContractAcceptance(safeBody) ||
        isExplicitContractRejection(safeBody))
    ) {
      const confirmed = await confirmConversationReservation({
        store,
        conversation: latestBeforeFlow,
        message: safeBody,
        deps: reservationBridgeDeps,
      });
      const botReply = await addRenderedBotMessageBestEffort(
        store,
        latestBeforeFlow.id,
        confirmed.reply,
        "reservation_flow_contract_acceptance_reply",
      );

      return {
        conversation: await getConversationByIdBestEffort(
          store,
          latestBeforeFlow.id,
          confirmed.conversation,
          "reservation_flow_contract_acceptance_return_read",
        ),
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(confirmed.reply),
      };
    }

    if (
      latestBeforeFlow.reservationFlow?.status === "pending_confirmation" &&
      latestBeforeFlow.pendingReservationProposal?.status === "proposed" &&
      isExplicitContractAcceptance(safeBody)
    ) {
      const confirmed = await confirmConversationReservation({
        store,
        conversation: latestBeforeFlow,
        message: safeBody,
        deps: reservationBridgeDeps,
      });
      const botReply = await addRenderedBotMessageBestEffort(
        store,
        latestBeforeFlow.id,
        confirmed.reply,
        "reservation_flow_contract_request_reply",
      );

      return {
        conversation: await getConversationByIdBestEffort(
          store,
          latestBeforeFlow.id,
          confirmed.conversation,
          "reservation_flow_contract_request_return_read",
        ),
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(confirmed.reply),
      };
    }

    if (
      latestBeforeFlow.reservationFlow?.status === "pending_confirmation" &&
      isAffirmativeConfirmationUtterance(safeBody)
    ) {
      const confirmed = await confirmConversationReservation({
        store,
        conversation: latestBeforeFlow,
        message: safeBody,
        deps: reservationBridgeDeps,
      });
      const botReply = await addRenderedBotMessageBestEffort(
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
              status: "collecting_dates",
              checkInDate: undefined,
              checkInTime: undefined,
              checkInSlot: undefined,
              checkOutDate: undefined,
              checkOutTime: undefined,
              checkOutSlot: undefined,
              availabilityStatus: "pending",
              price: undefined,
              priceSource: undefined,
              priceNeedsReview: undefined,
              proposalId: undefined,
              updatedAt: nowIso(),
            }
          : undefined,
        updatedAt: nowIso(),
      };
      await store.replaceConversation(rejected);
      await store.addEvent(
        createEvent(latestBeforeFlow.id, "reservation_flow_rejected", {
          reason: "customer_rejected",
          preservedFlow: true,
        }),
      );
      const replyBody = renderCopy({ key: "reservation.rejected_new_dates" });
      const botReply = await addRenderedBotMessage(
        store,
        latestBeforeFlow.id,
        replyBody,
        "reservation_flow_rejected",
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

    const slotTargetResolution = latestBeforeFlow.reservationFlow
      ? measureSyncAuthorityStage(
          timing,
          "deterministicParserMs",
          "reservation_slot_target_resolution",
          () => resolveReservationSlotTarget(safeBody, latestBeforeFlow.reservationFlow!, {
            now: reservationBridgeDeps?.now?.() ?? new Date(),
          }),
        )
      : undefined;
    const attemptedSlots =
      slotTargetResolution?.extractedSlots ??
      measureSyncAuthorityStage(
        timing,
        "deterministicParserMs",
        "reservation_slot_parse",
        () => extractReservationSlotsFromMessage(safeBody, {
          flow: latestBeforeFlow.reservationFlow,
          now: reservationBridgeDeps?.now?.() ?? new Date(),
        }),
      );
    const attemptedSlotNames = Object.keys(attemptedSlots);
    const targetedSlotNames = slotTargetResolution?.targetedSlotNames ?? [];
    const flow = await measureAuthorityStage(
      timing,
      "reducerMs",
      "advance_reservation_flow",
      () => advanceReservationFlow({
        conversation: latestBeforeFlow,
        inboundMessageId: inbound.id,
        message: safeBody,
        clientDirectory,
        deps: reservationBridgeDeps,
      }),
    );

    if (flow) {
      const appliedSlotNames = changedReservationSlotNames(
        latestBeforeFlow.reservationFlow,
        flow.conversation.reservationFlow,
      );
      const missingFields = flow.conversation.reservationFlow
        ? computeMissingReservationFields(flow.conversation.reservationFlow)
        : [];
      const antiLoop = applyReservationAntiLoop({
        recordBeforeReply: flow.conversation,
        reply: flow.reply,
        appliedSlotNames,
      });
      const ignoredReason = slotTargetResolution
        ? appliedSlotNames.length > 0
          ? "state_changed"
          : targetedSlotNames.length > 0
            ? "no_state_change"
            : slotTargetResolution.reason
        : "no_target_resolution";
      const turnTrace = buildAuthorityTurnTrace({
        turnId: createId("turn"),
        recordBefore: latestBeforeFlow,
        recordAfter: flow.conversation,
        message: safeBody,
        timing,
        nluIntent: flowInterruptionPlan.intent,
        nluGlobalIntent: authorityGlobalIntent({
          message: safeBody,
          intent: flowInterruptionPlan.intent,
        }),
        nluSlotsExtracted: attemptedSlotNames,
        nluTargetSlots: targetedSlotNames,
        slotsApplied: appliedSlotNames,
        slotsIgnored: ignoredSlotsWithReason(attemptedSlotNames, appliedSlotNames, ignoredReason),
        policyAction: missingFields.length > 0 ? "ask_missing_slot" : "propose_reservation",
        policyReason: flow.eventType,
        renderKey: missingFields.length > 0 ? "reservation.ask_entry_exit_date_time" : "reservation.proposal",
        outboxKind: "twiml_response",
        loopPrevented: Boolean(antiLoop.event),
      });
      await store.replaceConversation(flow.conversation);
      await addSafeEvents(store, flow.conversation.id, [
        ...authorityRuntimeEvents(turnTrace),
        ...assistiveEvents,
        {
          eventType: "reservation_slot_merge_attempted",
          payload: {
            statusBefore: latestBeforeFlow.reservationFlow?.status,
            attemptedSlotNames,
            ...safeBodyKind(safeBody),
          },
        },
        ...(slotTargetResolution
          ? [
              {
                eventType: "reservation_slot_target_resolved",
                payload: {
                  statusBefore: latestBeforeFlow.reservationFlow?.status,
                  target: slotTargetResolution.target,
                  reason: slotTargetResolution.reason,
                  pendingFields: slotTargetResolution.pendingFields,
                  attemptedSlotNames,
                  targetedSlotNames,
                  ignoredSlotNames: slotTargetResolution.ignoredSlotNames,
                  ...safeBodyKind(safeBody),
                },
              },
            ]
          : []),
        {
          eventType:
            appliedSlotNames.length > 0
              ? "reservation_slot_merge_applied"
              : "reservation_slot_merge_noop",
          payload: {
            statusBefore: latestBeforeFlow.reservationFlow?.status,
            statusAfter: flow.conversation.reservationFlow?.status,
            attemptedSlotNames,
            appliedSlotNames,
          },
        },
        ...(slotTargetResolution
          ? [
              {
                eventType:
                  appliedSlotNames.length > 0
                    ? "reservation_slot_target_applied"
                    : "reservation_slot_target_ignored",
                payload: {
                  target: slotTargetResolution.target,
                  reason:
                    appliedSlotNames.length > 0
                      ? "state_changed"
                      : targetedSlotNames.length > 0
                        ? "no_state_change"
                        : slotTargetResolution.reason,
                  targetedSlotNames,
                  appliedSlotNames,
                  ignoredSlotNames: slotTargetResolution.ignoredSlotNames,
                },
              },
              {
                eventType:
                  appliedSlotNames.length > 0
                    ? "nlu_assistive_slots_applied"
                    : "nlu_assistive_slots_ignored",
                payload: {
                  source: "deterministic_fallback_or_assistive_safe",
                  slotNames: appliedSlotNames.length > 0 ? appliedSlotNames : attemptedSlotNames,
                  reason:
                    appliedSlotNames.length > 0
                      ? "state_changed"
                      : targetedSlotNames.length > 0
                        ? "no_state_change"
                        : slotTargetResolution.reason,
                },
              },
            ]
          : []),
        {
          eventType: "reservation_pending_fields_after_merge",
          payload: {
            status: flow.conversation.reservationFlow?.status,
            missingFields,
          },
        },
        {
          eventType: "reservation_next_missing_fields",
          payload: {
            status: flow.conversation.reservationFlow?.status,
            missingFields,
          },
        },
        ...(antiLoop.event ? [antiLoop.event] : []),
      ], timing);
      await store.addEvent(
        createEvent(flow.conversation.id, flow.eventType, flow.eventPayload),
      );
      const botReply = await addRenderedBotMessage(
        store,
        flow.conversation.id,
        antiLoop.reply,
        flow.eventType,
      );

      return {
        conversation: (await store.getById(flow.conversation.id)) ?? flow.conversation,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(antiLoop.reply),
      };
    }
  }

  const latestBeforePlan = (await store.getById(freshWithClient.id)) ?? freshWithClient;
  if (
    latestBeforePlan.pendingReservationProposal?.contractAcceptanceRequestedAt &&
    (isExplicitContractAcceptance(safeBody) ||
      isContextualContractAcceptance(safeBody) ||
      isExplicitContractRejection(safeBody))
  ) {
    const confirmation = await confirmConversationReservation({
      store,
      conversation: latestBeforePlan,
      message: safeBody,
      deps: reservationBridgeDeps,
    });

    const botReply = await addRenderedBotMessageBestEffort(
      store,
      freshWithClient.id,
      confirmation.reply,
      "contract_acceptance_reply",
    );

    return {
      conversation: await getConversationByIdBestEffort(
        store,
        freshWithClient.id,
        confirmation.conversation,
        "contract_acceptance_reply_return_read",
      ),
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(confirmation.reply),
    };
  }

  if (
    latestBeforePlan.pendingReservationProposal?.status === "proposed" &&
    isExplicitContractAcceptance(safeBody)
  ) {
    const confirmation = await confirmConversationReservation({
      store,
      conversation: latestBeforePlan,
      message: safeBody,
      deps: reservationBridgeDeps,
    });

    const botReply = await addRenderedBotMessageBestEffort(
      store,
      freshWithClient.id,
      confirmation.reply,
      "contract_request_reply",
    );

    return {
      conversation: await getConversationByIdBestEffort(
        store,
        freshWithClient.id,
        confirmation.conversation,
        "contract_request_reply_return_read",
      ),
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(confirmation.reply),
    };
  }

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

  const initialReplyPlan = measureSyncAuthorityStage(
    timing,
    "nluTotalMs",
    "deterministic_nlu",
    () => buildConversationReplyPlan(safeBody),
  );
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
  const kbMatchForPlan = matchConversationKnowledgeBase(safeBody);
  const isOpenQualityQuery = [
    "general_info_query",
    "topic_info_query",
    "mixed_reservation_and_info",
    "informal_availability_query",
  ].includes(replyPlan.intent);
  await addSafeEvents(store, freshWithClient.id, [
    {
      eventType: "nlu_called",
      payload: {
        source: "conversation_service",
        ...safeBodyKind(safeBody),
      },
    },
    {
      eventType: "nlu_result_received",
      payload: {
        intent: replyPlan.intent,
        confidence: replyPlan.confidence,
        matchedSignals: replyPlan.matchedSignals,
        source: replyPlan.source,
        handoff: replyPlan.handoff,
      },
    },
    {
      eventType: "policy_decision",
      payload: {
        intent: replyPlan.intent,
        route:
          replyPlan.intent === "informal_availability_query"
            ? "availability_inquiry"
            : replyPlan.intent === "mixed_reservation_and_info"
              ? "mixed_reservation_info"
              : replyPlan.intent === "general_info_query" || replyPlan.intent === "topic_info_query"
                ? "knowledge_base"
                : replyPlan.intent === "availability_request" || replyPlan.intent === "reservation_start"
                  ? "reservation_flow"
                  : replyPlan.intent === "reservation_modify" || replyPlan.intent === "reservation_cancel"
                    ? "reservation_change_flow"
                    : replyPlan.handoff
                      ? "manual_review"
                      : "direct_reply",
        hasActiveReservationFlow: Boolean(latestBeforePlan.reservationFlow),
        hasPendingReservationProposal: Boolean(latestBeforePlan.pendingReservationProposal),
      },
    },
    {
      eventType: "nlu_classified",
      payload: {
        intent: replyPlan.intent,
        confidence: replyPlan.confidence,
        matchedSignals: replyPlan.matchedSignals,
        slots: replyPlan.slots,
        source: replyPlan.source,
        handoff: replyPlan.handoff,
      },
    },
    ...(isOpenQualityQuery
      ? [
          {
            eventType: "nlu_fast_path_skipped_quality_gate",
            payload: {
              intent: replyPlan.intent,
              reason: "open_or_mixed_presales_query",
            },
          },
          {
            eventType: "nlu_llm_required_for_open_query",
            payload: {
              intent: replyPlan.intent,
              usedOpenAI: false,
              fallback: "deterministic_knowledge_base",
            },
          },
        ]
      : [
          {
            eventType: "nlu_fast_path_used",
            payload: {
              intent: replyPlan.intent,
              reason: "deterministic_high_confidence_or_stateful_flow",
            },
          },
        ]),
    ...(kbMatchForPlan
      ? [
          {
            eventType: "nlu_knowledge_base_match",
            payload: {
              topic: kbMatchForPlan.entry.id,
              confidence: kbMatchForPlan.confidence,
              matchedSignals: kbMatchForPlan.matchedSignals,
            },
          },
        ]
      : isOpenQualityQuery
        ? [
            {
              eventType: "nlu_knowledge_base_miss",
              payload: {
                intent: replyPlan.intent,
                reason: "no_topic_match",
              },
            },
          ]
        : []),
  ], timing);

  if (latestBeforePlan.heldReservationIntent && isInformationReplyPlan(replyPlan)) {
    const latestForInfo = (await store.getById(freshWithClient.id)) ?? latestBeforePlan;
    const topicAnswer = renderConversationReplyPlan(replyPlan, safeBody);
    const replyBody = renderCopy({
      key: "conversation.info_answer_then_resume_reservation",
      message: safeBody,
      topicAnswer,
    });
    const nextConversation: ConversationRecord = {
      ...latestForInfo,
      activeFlow: "info",
      lastAnsweredTopic: replyPlan.slots.topic ?? kbMatchForPlan?.entry.id ?? replyPlan.intent,
      updatedAt: nowIso(),
    };

    return sendBotOutcome({
      store,
      conversation: nextConversation,
      inbound,
      reply: replyBody,
      eventType: "info_answered_then_resume_reservation",
      eventPayload: {
        intent: replyPlan.intent,
        topic: nextConversation.lastAnsweredTopic,
        heldReservationIntent: true,
      },
    });
  }

  if (replyPlan.intent === "mixed_reservation_and_info") {
    const latestForInfo = (await store.getById(freshWithClient.id)) ?? latestBeforePlan;
    const replyBody = personalizeGreetingReply(
      renderConversationReplyPlan(replyPlan, safeBody),
      latestForInfo,
    );
    const nextConversation: ConversationRecord = {
      ...latestForInfo,
      activeFlow: "info",
      pendingInfoTopic: replyPlan.slots.topic ?? "unknown",
      heldReservationIntent: true,
      availabilityInquiry: undefined,
      updatedAt: nowIso(),
    };

    return sendBotOutcome({
      store,
      conversation: nextConversation,
      inbound,
      reply: replyBody,
      eventType: "reservation_intent_held_while_answering_info",
      eventPayload: {
        wantsToReserve: true,
        wantsInfoBeforeReserve: true,
        renderSource: "kb",
      },
    });
  }

  if (replyPlan.intent === "informal_availability_query") {
    const latestForAvailability = (await store.getById(freshWithClient.id)) ?? latestBeforePlan;
    const relativeRange = extractRelativeDateRange(safeBody);
    const availabilitySlots = extractReservationSlotsFromMessage(safeBody, {
      now: reservationBridgeDeps?.now?.() ?? new Date(),
    });
    const availabilityInquiry = normalizeAvailabilityInquiry(
      {
        relativeDateRange: relativeRange?.id,
        dateRange: relativeRange?.label,
        dateStart: replyPlan.slots.checkInDate ?? availabilitySlots.checkInDate,
        dateEnd: replyPlan.slots.checkOutDate ?? availabilitySlots.checkOutDate,
        checkInTime: availabilitySlots.checkInTime,
        checkOutTime: availabilitySlots.checkOutTime,
        checkInSlot: availabilitySlotFromTime(availabilitySlots.checkInTime),
        checkOutSlot: availabilitySlotFromTime(availabilitySlots.checkOutTime),
        petName: replyPlan.slots.petName,
        petCount: replyPlan.slots.petName ? 1 : undefined,
        availabilityStatus: "pending",
        missingFields: [],
      },
      reservationBridgeDeps?.now?.() ?? new Date(),
    );
    const missingFields = availabilityInquiry.missingFields;
    const renderKey = availabilityFirstRenderKey(missingFields);
    const replyBody = personalizeGreetingReply(
      renderCopy({
        key: renderKey,
        message: safeBody,
        petName: availabilityInquiry.petName,
        relativeDateRange: relativeRange?.label,
      }),
      latestForAvailability,
    );
    const nextConversation: ConversationRecord = {
      ...latestForAvailability,
      activeFlow: "availabilityInquiry",
      availabilityInquiry,
      updatedAt: nowIso(),
    };

    await store.replaceConversation(nextConversation);
    await store.addEvent(
      createEvent(nextConversation.id, "availability_first_triggered", {
        relativeDateRange: relativeRange?.id,
        wantsToReserve: Boolean(replyPlan.slots.wantsToReserve),
        renderKey,
      }),
    );
    if (missingFields.length > 0) {
      await store.addEvent(
        createEvent(nextConversation.id, "availability_precheck_missing_fields", {
          missingFields,
          noAvailabilityPromised: true,
        }),
      );
    }
    await store.addEvent(
      createEvent(nextConversation.id, "availability_inquiry_started", {
        relativeDateRange: relativeRange?.id,
        missingFields,
        noAvailabilityPromised: true,
        renderKey,
      }),
    );
    if (missingFields.length === 0) {
      return runAvailabilityPrecheckReadOnly({
        store,
        conversation: nextConversation,
        inbound,
        safeBody,
        deps: reservationBridgeDeps,
        timing,
      });
    }
    const botReply = await addRenderedBotMessage(
      store,
      nextConversation.id,
      replyBody,
      renderKey,
    );

    return {
      conversation: (await store.getById(nextConversation.id)) ?? nextConversation,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(replyBody),
    };
  }

  if (isStrongDirectoryConversation(latestBeforePlan) && isExplicitNotClientClaim(safeBody)) {
    const replyBody = renderCopy({ key: "service.client_override_reservation" });
    await store.addEvent(
      createEvent(freshWithClient.id, "client_directory_phone_match_overrode_declaration", {
        matchType: latestBeforePlan.clientMatchType,
        confidence: latestBeforePlan.clientConfidence,
      }),
    );
    const botReply = await addRenderedBotMessage(
      store,
      freshWithClient.id,
      replyBody,
      "client_directory_phone_match_overrode_declaration",
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
      const replyBody = renderCopy({ key: "service.manual_review" });
      const botReply = await addRenderedBotMessage(
        store,
        freshWithClient.id,
        replyBody,
        "ambiguous_client_manual_review",
      );
      return {
        conversation: (await store.getById(freshWithClient.id)) ?? reviewRecord,
        inbound,
        botReply,
        twiml: buildTwilioMessageResponse(replyBody),
      };
    }

    const latestForStart = (await store.getById(freshWithClient.id)) ?? latestBeforePlan;
    const flow = measureSyncAuthorityStage(
      timing,
      "reducerMs",
      "start_reservation_flow",
      () => startReservationFlow({
        conversation: latestForStart,
        inboundMessageId: inbound.id,
        now: reservationBridgeDeps?.now?.(),
      }),
    );
    const turnTrace = buildAuthorityTurnTrace({
      turnId: createId("turn"),
      recordBefore: latestBeforePlan,
      recordAfter: flow.conversation,
      message: safeBody,
      timing,
      nluIntent: replyPlan.intent,
      nluGlobalIntent: authorityGlobalIntent({
        message: safeBody,
        intent: replyPlan.intent,
      }),
      nluSlotsExtracted: Object.keys(replyPlan.slots),
      nluTargetSlots: [],
      slotsApplied: changedReservationSlotNames(
        latestBeforePlan.reservationFlow,
        flow.conversation.reservationFlow,
      ),
      policyAction: "start_reservation_flow",
      policyReason: replyPlan.intent,
      renderKey: flow.conversation.reservationFlow?.status === "asking_client_kind"
        ? "reservation.ask_client_kind"
        : "reservation.known_client_pet_prompt",
      outboxKind: "twiml_response",
    });
    await store.replaceConversation(flow.conversation);
    await addSafeEvents(store, flow.conversation.id, authorityRuntimeEvents(turnTrace), timing);
    await store.addEvent(
      createEvent(flow.conversation.id, flow.eventType, flow.eventPayload),
    );
    const botReply = await addRenderedBotMessage(
      store,
      flow.conversation.id,
      flow.reply,
      flow.eventType,
    );

    return {
      conversation: (await store.getById(flow.conversation.id)) ?? flow.conversation,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(flow.reply),
    };
  }

  if (replyPlan.intent === "reservation_modify" || replyPlan.intent === "reservation_cancel") {
    const latestForChange = (await store.getById(freshWithClient.id)) ?? latestBeforePlan;
    const pendingProposalForGateSkip =
      latestForChange.pendingReservationProposal?.status === "proposed"
        ? latestForChange.pendingReservationProposal
        : undefined;
    const outcome = await startReservationChangeFlow({
      conversation: latestForChange,
      message: safeBody,
      replyPlan,
      kind: replyPlan.intent === "reservation_cancel" ? "cancellation" : "modification",
      deps: reservationBridgeDeps,
    });
    return sendReservationChangeOutcome({
      store,
      outcome,
      inbound,
      contractGateSkip: pendingProposalForGateSkip
        ? {
            reason:
              replyPlan.intent === "reservation_cancel"
                ? "skipped_cancel_intent"
                : "skipped_modify_intent",
            proposal: pendingProposalForGateSkip,
          }
        : undefined,
    });
  }

  if (replyPlan.intent === "reservation_confirm") {
    const confirmation = await confirmConversationReservation({
      store,
      conversation: (await store.getById(freshWithClient.id)) ?? freshWithClient,
      message: safeBody,
      deps: reservationBridgeDeps,
    });

    const botReply = await addRenderedBotMessageBestEffort(
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
    const replyBody = renderConversationReplyPlan(replyPlan, safeBody);
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
    const botReply = await addRenderedBotMessage(
      store,
      freshWithClient.id,
      replyBody,
      "nlu_handoff_reply",
    );

    return {
      conversation: (await store.getById(fresh.id)) ?? humanRecord,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(replyBody),
    };
  }

  const latestForReply = (await store.getById(freshWithClient.id)) ?? freshWithClient;
  if (replyPlan.intent === "greeting") {
    const rendered = renderGreetingWithWelcomeLock({
      message: safeBody,
      replyPlan,
      record: latestForReply,
    });
    await store.addEvent(
      createEvent(freshWithClient.id, rendered.eventType, {
        renderTemplateId: rendered.renderKey,
        reason: rendered.reason,
        clientStatus: latestForReply.clientStatus ?? "unknown",
      }),
    );
    const botReply = await addRenderedBotMessage(
      store,
      freshWithClient.id,
      rendered.reply,
      rendered.renderKey,
    );
    await store.addEvent(
      createEvent(freshWithClient.id, "bot_reply_sent", {
        source: replyPlan.source,
        intent: replyPlan.intent,
        renderTemplateId: rendered.renderKey,
      }),
    );

    return {
      conversation: (await store.getById(freshWithClient.id)) ?? latestForReply,
      inbound,
      botReply,
      twiml: buildTwilioMessageResponse(rendered.reply),
    };
  }

  const reply = personalizeGreetingReply(
    renderConversationReplyPlan(replyPlan, safeBody),
    latestForReply,
  );
  const botReply = await addRenderedBotMessage(
    store,
    freshWithClient.id,
    reply,
    "bot_reply_sent",
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
