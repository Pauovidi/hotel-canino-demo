import { NextResponse } from "next/server";
import {
  buildTwilioMessageResponse,
  handleGlobalResetCommand,
  handleInboundWhatsApp,
  redactConversationSensitiveText,
} from "@/lib/hotel/conversations/service";
import { isConversationResetCommand } from "@/lib/hotel/conversations/nlu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORE_FAILURE_REPLY =
  "Gracias, hemos recibido tu mensaje. Si no te contestamos de inmediato, una persona del equipo lo revisará por aquí.";

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

export async function POST(request: Request) {
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

  console.info("twilio_webhook_received", {
    hasFrom: Boolean(from),
    hasTo: Boolean(to),
    hasBody: Boolean(body),
    hasMessageSid: Boolean(messageSid),
  });

  try {
    const result = await handleInboundWhatsApp({
      from,
      to,
      body,
      messageSid,
      displayName: String(raw.ProfileName ?? raw.profileName ?? ""),
      rawPayload: sanitizeTwilioPayload(raw),
    });
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
    return twilioXmlResponse(buildTwilioMessageResponse(STORE_FAILURE_REPLY));
  }
}
