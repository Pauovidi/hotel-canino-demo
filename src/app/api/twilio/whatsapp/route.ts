import { NextResponse } from "next/server";
import {
  buildTwilioMessageResponse,
  handleGlobalResetCommand,
  handleInboundWhatsApp,
  isStrongClientIdentity,
  knownClientFirstNameFromIdentity,
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
  "Ahora mismo no puedo consultar correctamente la conversación. Te contestamos por aquí en cuanto lo revisemos.";

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
    const reply = personalizeReplyWithClientIdentity(plan.reply, clientIdentity);

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
    ...sanitizeClientIdentityLog(clientIdentity),
    ...errorPayload,
  });
  console.warn("twilio_webhook_store_failed_critical_flow", {
    intent: plan.intent,
    source: plan.source,
    handoff: plan.handoff,
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
  if (!validateWebhookToken(request)) {
    return twilioXmlResponse(undefined, 401);
  }

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

  if (!from || !body) {
    return twilioXmlResponse();
  }

  if (isConversationResetCommand(body)) {
    const result = await handleGlobalResetCommand({
      from,
      to,
      body,
      messageSid,
      displayName: String(raw.ProfileName ?? raw.profileName ?? ""),
      rawPayload: sanitizeTwilioPayload(raw),
    });
    const twiml = resolveTwilioWebhookTwiml(result);

    console.info("twilio_webhook_reset_command_replied", {
      hasBotReply: Boolean(result.botReply?.body),
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
  const clientIdentity = await resolveClientIdentitySafe({
    from,
    displayName,
    clientDirectory,
  });

  try {
    const result = await handleInboundWhatsApp({
      from,
      to,
      body,
      messageSid,
      displayName,
      rawPayload: sanitizeTwilioPayload(raw),
    }, undefined, clientDirectory);
    const twiml = resolveTwilioWebhookTwiml(result);

    console.info("twilio_webhook_reply_built", {
      hasBotReply: Boolean(result.botReply?.body),
      hasTwimlMessage: twiml.includes("<Message>"),
    });
    console.info("twilio_webhook_twiml_sent", {
      status: 200,
      contentType: "text/xml",
    });

    return twilioXmlResponse(twiml);
  } catch (error) {
    console.error("twilio_webhook_store_failed", safeErrorPayload(error));
    console.warn("twilio_degraded_due_to_conversation_store", {
      hasClientIdentity: isStrongClientIdentity(clientIdentity.identity),
      ...safeErrorPayload(error),
    });
    return twilioXmlResponse(buildStoreFailureTwiml(body, error, clientIdentity.identity));
  }
}
