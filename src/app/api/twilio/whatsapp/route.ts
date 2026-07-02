import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  buildTwilioMessageResponse,
  handleGlobalResetCommand,
  handleInboundWhatsApp,
  isStrongClientIdentity,
  knownClientFirstNameFromIdentity,
  normalizePhone,
  personalizeReplyWithClientIdentity,
  redactConversationSensitiveText,
} from "@/lib/hotel/conversations/service";
import {
  ClientDirectoryService,
  getClientDirectory,
  type ClientDirectory,
  type ClientIdentityResult,
} from "@/lib/hotel/clients";
import {
  normalizeWhatsAppUserEvent,
  renderConversationReplyPlan,
  renderCopy,
} from "@/lib/hotel/conversations/authority";
import {
  buildConversationReplyPlan,
  isConversationResetCommand,
  type ConversationIntent,
} from "@/lib/hotel/conversations/nlu";
import {
  buildStatelessTemplatePreviewResult,
  isTemplatePreviewCommand,
  TEMPLATE_PREVIEW_FAILED_REPLY,
} from "@/lib/hotel/conversations/template-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORE_DEGRADED_CRITICAL_REPLY =
  renderCopy({ key: "service.store_degraded_critical" });

const EMPTY_REPLY_FALLBACK_REPLY = STORE_DEGRADED_CRITICAL_REPLY;

const STATELESS_SAFE_INTENTS = new Set<ConversationIntent>([
  "greeting",
  "general_information",
  "faq_hours",
  "faq_prices",
  "faq_visits",
  "faq_vaccines",
  "faq_food",
  "faq_what_to_bring",
  "faq_photos_videos",
  "faq_payment",
  "faq_location",
  "faq_services",
  "faq_cancellation",
  "faq_contact",
  "media_request",
]);

let clientDirectoryForTests: ClientDirectory | undefined;

export function setTwilioClientDirectoryForTests(directory?: ClientDirectory): void {
  clientDirectoryForTests = directory;
}

function resolveTwilioClientDirectory(): ClientDirectory {
  return clientDirectoryForTests ?? getClientDirectory();
}

function validateWebhookToken(request: Request): boolean {
  const expected = process.env.TWILIO_WEBHOOK_AUTH_TOKEN;
  if (!expected) {
    return process.env.NODE_ENV !== "production" || process.env.VERCEL_ENV === "preview";
  }

  const url = new URL(request.url);
  return (
    request.headers.get("x-twilio-webhook-token") === expected ||
    request.headers.get("x-hotel-webhook-token") === expected ||
    url.searchParams.get("token") === expected
  );
}

function getInboundBody(raw: Record<string, string>): string {
  const body = String(raw.Body ?? raw.body ?? "").trim();
  if (body) {
    return body;
  }

  const mediaCount = Number.parseInt(String(raw.NumMedia ?? raw.numMedia ?? "0"), 10);
  if (Number.isFinite(mediaCount) && mediaCount > 0) {
    return `[WhatsApp con ${mediaCount} adjunto${mediaCount === 1 ? "" : "s"}]`;
  }

  return "";
}

function sanitizeTwilioPayload(raw: Record<string, string>): Record<string, string> {
  const allowedKeys = [
    "From",
    "To",
    "Body",
    "MessageSid",
    "SmsMessageSid",
    "ProfileName",
    "NumMedia",
    "WaId",
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => raw[key] !== undefined)
      .map((key) => [
        key,
        redactConversationSensitiveText(raw[key]).slice(0, key === "Body" ? 1000 : 240),
      ]),
  );
}

export function resolveTwilioWebhookTwiml(
  result?: { botReply?: { body?: string } | null; twiml?: string },
): string {
  if (result?.twiml) {
    return result.twiml;
  }

  return buildTwilioMessageResponse(result?.botReply?.body);
}

function twimlHasMessage(twiml?: string): boolean {
  return Boolean(twiml?.includes("<Message>"));
}

function deriveConversationTraceId(from: string): string | undefined {
  try {
    const normalized = normalizePhone(from).phoneNormalized;
    if (!normalized) {
      return undefined;
    }
    const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return `whatsapp:${digest}`;
  } catch {
    return undefined;
  }
}

export function ensureNonEmptyTwilioReply(input: {
  twiml: string;
  botReplyBody?: string;
  hasValidInboundText: boolean;
  allowEmptyTwiml?: boolean;
  noReplyReason?: string;
  fallbackReason: string;
  timing?: {
    totalDurationMs?: number;
    loadStateMs?: number;
    nluTotalMs?: number;
    rendererMs?: number;
    persistenceMs?: number;
    eventLogMs?: number;
    outboxBuildMs?: number;
    openaiCalls?: number;
  };
}): {
  twiml: string;
  botReplyBody?: string;
  hasTwimlMessage: boolean;
  prevented: boolean;
  fallbackReason?: string;
} {
  if (twimlHasMessage(input.twiml)) {
    return {
      twiml: input.twiml,
      botReplyBody: input.botReplyBody,
      hasTwimlMessage: true,
      prevented: false,
    };
  }

  if (!input.hasValidInboundText || input.allowEmptyTwiml) {
    return {
      twiml: input.twiml,
      botReplyBody: input.botReplyBody,
      hasTwimlMessage: false,
      prevented: false,
    };
  }

  console.warn("empty_reply_prevented", {
    fallbackReason: input.fallbackReason,
    noReplyReason: input.noReplyReason,
    storeFailureMode: "pipeline_returned_empty_reply",
    serviceTotalMs: input.timing?.totalDurationMs,
    storeLoadMs: input.timing?.loadStateMs,
    nluTotalMs: input.timing?.nluTotalMs,
    rendererMs: input.timing?.rendererMs,
    storeSaveMs: input.timing?.persistenceMs,
    eventLogMs: input.timing?.eventLogMs,
    outboxMs: input.timing?.outboxBuildMs,
    openaiCalls: input.timing?.openaiCalls,
  });

  return {
    twiml: buildTwilioMessageResponse(EMPTY_REPLY_FALLBACK_REPLY),
    botReplyBody: EMPTY_REPLY_FALLBACK_REPLY,
    hasTwimlMessage: true,
    prevented: true,
    fallbackReason: input.fallbackReason,
  };
}

function twilioXmlResponse(twiml?: string, status = 200): NextResponse {
  return new NextResponse(twiml ?? buildTwilioMessageResponse(), {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function safeErrorPayload(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    safeErrorCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code).slice(0, 80)
        : undefined,
  };
}

function nowMs(): number {
  return Date.now();
}

function durationSince(startMs: number): number {
  return Math.max(0, nowMs() - startMs);
}

function logTwilioWebhookTiming(input: {
  branch: string;
  receivedAtMs: number;
  routeAuthMs: number;
  parseMs: number;
  clientLookupMs?: number;
  twimlBuildMs?: number;
  serviceTotalMs?: number;
  storeLoadMs?: number;
  nluTotalMs?: number;
  openaiCalls?: number;
  reducerMs?: number;
  policyMs?: number;
  rendererMs?: number;
  storeSaveMs?: number;
  eventLogMs?: number;
  outboxMs?: number;
  hasTwimlMessage?: boolean;
}): void {
  console.info("twilio_webhook_timing_completed", {
    branch: input.branch,
    totalDurationMs: durationSince(input.receivedAtMs),
    routeAuthMs: input.routeAuthMs,
    parseMs: input.parseMs,
    clientLookupMs: input.clientLookupMs ?? 0,
    twimlBuildMs: input.twimlBuildMs ?? 0,
    serviceTotalMs: input.serviceTotalMs ?? 0,
    storeLoadMs: input.storeLoadMs ?? 0,
    nluTotalMs: input.nluTotalMs ?? 0,
    openaiCalls: input.openaiCalls ?? 0,
    reducerMs: input.reducerMs ?? 0,
    policyMs: input.policyMs ?? 0,
    rendererMs: input.rendererMs ?? 0,
    storeSaveMs: input.storeSaveMs ?? 0,
    eventLogMs: input.eventLogMs ?? 0,
    outboxMs: input.outboxMs ?? 0,
    hasTwimlMessage: Boolean(input.hasTwimlMessage),
  });
}

function buildTemplatePreviewWebhookTwiml(
  body: string,
): { kind: string; twiml: string } | undefined {
  if (!isTemplatePreviewCommand(body)) {
    return undefined;
  }

  try {
    const result = buildStatelessTemplatePreviewResult(body);
    if (!result) {
      return undefined;
    }

    return {
      kind: result.kind,
      twiml: buildTwilioMessageResponse(result.reply),
    };
  } catch (error) {
    console.warn("template_preview_failed", safeErrorPayload(error));
    return {
      kind: "failed",
      twiml: buildTwilioMessageResponse(TEMPLATE_PREVIEW_FAILED_REPLY),
    };
  }
}

function sanitizeClientIdentityLog(identity?: ClientIdentityResult): Record<string, unknown> {
  return {
    clientStatus: identity?.status ?? "lookup_failed",
    clientConfidence: identity?.confidence,
    clientMatchType: identity?.matchType,
    clientSource: identity?.source,
    matchCount: identity?.matches?.length ?? (identity?.client ? 1 : 0),
    sheetName: identity?.client?.sheetName,
    rowNumber: identity?.client?.rowNumber,
  };
}

async function resolveClientIdentitySafe(input: {
  from: string;
  displayName?: string;
  clientDirectory: ClientDirectory;
}): Promise<{ identity?: ClientIdentityResult; failed: boolean }> {
  try {
    const identity = await new ClientDirectoryService(input.clientDirectory).resolveClientIdentity({
      phone: input.from,
      name: input.displayName,
    });

    return { identity, failed: false };
  } catch (error) {
    console.warn("client_directory_lookup_failed", safeErrorPayload(error));
    return { failed: true };
  }
}

function buildCriticalStoreFailureReply(identity?: ClientIdentityResult): string {
  const name = knownClientFirstNameFromIdentity(identity);
  return name
    ? `${name}, ${STORE_DEGRADED_CRITICAL_REPLY.charAt(0).toLowerCase()}${STORE_DEGRADED_CRITICAL_REPLY.slice(1)}`
    : STORE_DEGRADED_CRITICAL_REPLY;
}

function buildStoreFailureTwiml(
  body: string,
  error: unknown,
  clientIdentity?: ClientIdentityResult,
): string {
  const plan = buildConversationReplyPlan(body);
  const errorPayload = safeErrorPayload(error);
  const hasStrongClientIdentity = isStrongClientIdentity(clientIdentity);
  const degradedLogName = hasStrongClientIdentity
    ? "degraded_with_client_identity"
    : "degraded_without_client_identity";

  if (!plan.handoff && STATELESS_SAFE_INTENTS.has(plan.intent)) {
    const reply = personalizeReplyWithClientIdentity(renderConversationReplyPlan(plan, body), clientIdentity);

    console.info(degradedLogName, {
      intent: plan.intent,
      source: plan.source,
      hasTwimlMessage: true,
      ...sanitizeClientIdentityLog(clientIdentity),
      ...errorPayload,
    });
    console.info("twilio_webhook_degraded_stateless_reply", {
      intent: plan.intent,
      source: plan.source,
      hasTwimlMessage: true,
      ...errorPayload,
    });
    return buildTwilioMessageResponse(reply);
  }

  console.info(degradedLogName, {
    intent: plan.intent,
    source: plan.source,
    handoff: plan.handoff,
    hasTwimlMessage: true,
    storeFailureMode: "conversation_store_unavailable",
    ...sanitizeClientIdentityLog(clientIdentity),
    ...errorPayload,
  });
  console.warn("twilio_webhook_store_failed_critical_flow", {
    intent: plan.intent,
    source: plan.source,
    handoff: plan.handoff,
    storeFailureMode: "conversation_store_unavailable",
    ...errorPayload,
  });
  return buildTwilioMessageResponse(buildCriticalStoreFailureReply(clientIdentity));
}

export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (error) {
    console.error("twilio_webhook_unexpected_error", safeErrorPayload(error));
    return twilioXmlResponse(buildTwilioMessageResponse(STORE_DEGRADED_CRITICAL_REPLY));
  }
}

async function handlePost(request: Request) {
  const receivedAtMs = nowMs();
  const authStartedAt = nowMs();
  if (!validateWebhookToken(request)) {
    return twilioXmlResponse(undefined, 401);
  }
  const routeAuthMs = durationSince(authStartedAt);

  const parseStartedAt = nowMs();
  const contentType = request.headers.get("content-type") ?? "";
  const form = contentType.includes("application/json") ? undefined : await request.formData();
  const json = form ? undefined : ((await request.json()) as Record<string, unknown>);
  const raw = Object.fromEntries(
    (form
      ? Array.from(form.entries())
      : Object.entries(json ?? {})).map(([key, value]) => [
      key,
      typeof value === "string" ? value : String(value ?? ""),
    ]),
  );
  const from = String(raw.From ?? raw.from ?? "");
  const to = String(raw.To ?? raw.to ?? "");
  const body = getInboundBody(raw);
  const messageSid = String(raw.MessageSid ?? raw.messageSid ?? "");
  const parseMs = durationSince(parseStartedAt);

  if (!from || !body) {
    return twilioXmlResponse();
  }

  const sanitizedRawPayload = sanitizeTwilioPayload(raw);
  const conversationTraceId = deriveConversationTraceId(from);
  console.info("raw_inbound_created", {
    channel: "whatsapp",
    source: "webhook",
    hasFrom: Boolean(from),
    hasTo: Boolean(to),
    hasBody: Boolean(body),
    hasMessageSid: Boolean(messageSid),
    bodyLength: body.length,
  });
  console.info("conversation_id_derived", {
    channel: "whatsapp",
    source: "from_phone_hash",
    hasConversationTraceId: Boolean(conversationTraceId),
    conversationTraceId,
  });
  const normalizedEvent = normalizeWhatsAppUserEvent({
    from,
    to,
    body,
    messageSid,
    displayName: String(raw.ProfileName ?? raw.profileName ?? ""),
    rawPayload: sanitizedRawPayload,
    conversationId: conversationTraceId,
    source: "webhook",
  });
  console.info("normalized_user_event_created", {
    channel: normalizedEvent.channel,
    source: normalizedEvent.source,
    hasConversationId: Boolean(normalizedEvent.conversationId),
    hasMessageText: Boolean(normalizedEvent.messageText),
    hasMessageSid: Boolean(messageSid),
    currentMode: normalizedEvent.currentMode,
    pendingFields: normalizedEvent.pendingFields,
    conversationIdSource: normalizedEvent.metadata.conversationIdSource,
  });

  if (isConversationResetCommand(body)) {
    const result = await handleGlobalResetCommand({
      from,
      to,
      body,
      messageSid,
      displayName: String(raw.ProfileName ?? raw.profileName ?? ""),
      rawPayload: sanitizedRawPayload,
      timing: {
        receivedAtMs,
        routeAuthMs,
        parseMs,
      },
    });
    const twimlStartedAt = nowMs();
    const twiml = resolveTwilioWebhookTwiml(result);
    const twimlBuildMs = durationSince(twimlStartedAt);

    console.info("twilio_webhook_reset_command_replied", {
      hasBotReply: Boolean(result.botReply?.body),
      hasTwimlMessage: twiml.includes("<Message>"),
    });
    logTwilioWebhookTiming({
      branch: "reset",
      receivedAtMs,
      routeAuthMs,
      parseMs,
      twimlBuildMs,
      hasTwimlMessage: twiml.includes("<Message>"),
    });

    return twilioXmlResponse(twiml);
  }

  const templatePreviewTwiml = buildTemplatePreviewWebhookTwiml(body);
  if (templatePreviewTwiml) {
    console.info("twilio_webhook_template_preview_prerouter_replied", {
      kind: templatePreviewTwiml.kind,
      hasTwimlMessage: templatePreviewTwiml.twiml.includes("<Message>"),
    });
    logTwilioWebhookTiming({
      branch: "template_preview",
      receivedAtMs,
      routeAuthMs,
      parseMs,
      hasTwimlMessage: templatePreviewTwiml.twiml.includes("<Message>"),
    });

    return twilioXmlResponse(templatePreviewTwiml.twiml);
  }

  console.info("twilio_webhook_received", {
    hasFrom: Boolean(from),
    hasTo: Boolean(to),
    hasBody: Boolean(body),
    hasMessageSid: Boolean(messageSid),
  });

  const displayName = String(raw.ProfileName ?? raw.profileName ?? "");
  const clientDirectory = resolveTwilioClientDirectory();

  try {
    const serviceStartedAt = nowMs();
    const result = await handleInboundWhatsApp({
      from,
      to,
      body,
      messageSid,
      displayName,
      rawPayload: sanitizedRawPayload,
      timing: {
        receivedAtMs,
        routeAuthMs,
        parseMs,
      },
    }, undefined, clientDirectory);
    const serviceTotalMs = durationSince(serviceStartedAt);
    const twimlStartedAt = nowMs();
    const resolvedTwiml = resolveTwilioWebhookTwiml(result);
    const ensuredReply = ensureNonEmptyTwilioReply({
      twiml: resolvedTwiml,
      botReplyBody: result.botReply?.body,
      hasValidInboundText: Boolean(body),
      allowEmptyTwiml: result.allowEmptyTwiml,
      noReplyReason: result.noReplyReason,
      fallbackReason: "normal_pipeline_empty_reply",
      timing: result.timing,
    });
    const twiml = ensuredReply.twiml;
    const twimlBuildMs = durationSince(twimlStartedAt);

    console.info("twilio_webhook_reply_built", {
      hasBotReply: Boolean(result.botReply?.body ?? ensuredReply.botReplyBody),
      hasTwimlMessage: ensuredReply.hasTwimlMessage,
      emptyReplyPrevented: ensuredReply.prevented,
      noReplyReason: result.noReplyReason,
      fallbackReason: ensuredReply.fallbackReason,
    });
    console.info("twilio_webhook_twiml_sent", {
      status: 200,
      contentType: "text/xml",
      hasTwimlMessage: ensuredReply.hasTwimlMessage,
      noReplyReason: result.noReplyReason,
    });
    logTwilioWebhookTiming({
      branch: "normal",
      receivedAtMs,
      routeAuthMs,
      parseMs,
      twimlBuildMs,
      serviceTotalMs: result.timing?.totalDurationMs ?? serviceTotalMs,
      storeLoadMs: result.timing?.loadStateMs,
      nluTotalMs: result.timing?.nluTotalMs,
      openaiCalls: result.timing?.openaiCalls,
      reducerMs: result.timing?.reducerMs,
      policyMs: result.timing?.policyMs,
      rendererMs: result.timing?.rendererMs,
      storeSaveMs: result.timing?.persistenceMs,
      eventLogMs: result.timing?.eventLogMs,
      outboxMs: result.timing?.outboxBuildMs,
      hasTwimlMessage: ensuredReply.hasTwimlMessage,
    });

    return twilioXmlResponse(twiml);
  } catch (error) {
    const clientLookupStartedAt = nowMs();
    const clientIdentity = await resolveClientIdentitySafe({
      from,
      displayName,
      clientDirectory,
    });
    const clientLookupMs = durationSince(clientLookupStartedAt);
    console.error("twilio_webhook_store_failed", safeErrorPayload(error));
    console.warn("twilio_degraded_due_to_conversation_store", {
      hasClientIdentity: isStrongClientIdentity(clientIdentity.identity),
      clientLookupMs,
      storeFailureMode: "conversation_store_unavailable",
      ...safeErrorPayload(error),
    });
    const twimlStartedAt = nowMs();
    const resolvedTwiml = buildStoreFailureTwiml(body, error, clientIdentity.identity);
    const ensuredReply = ensureNonEmptyTwilioReply({
      twiml: resolvedTwiml,
      hasValidInboundText: Boolean(body),
      fallbackReason: "store_failure_empty_reply",
    });
    const twiml = ensuredReply.twiml;
    const twimlBuildMs = durationSince(twimlStartedAt);
    logTwilioWebhookTiming({
      branch: "degraded_store_failure",
      receivedAtMs,
      routeAuthMs,
      parseMs,
      clientLookupMs,
      twimlBuildMs,
      hasTwimlMessage: ensuredReply.hasTwimlMessage,
    });
    return twilioXmlResponse(twiml);
  }
}
