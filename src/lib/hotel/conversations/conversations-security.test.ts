import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  POST as postTwilioWebhook,
  resolveTwilioWebhookTwiml,
} from "../../../app/api/twilio/whatsapp/route";
import { POST as postConversationsReset } from "../../../app/api/conversations/reset/route";

import { createStaticClientDirectory } from "@/lib/hotel/clients";
import {
  buildTwilioMessageResponse,
  handleInboundWhatsApp,
  normalizePhone,
} from "./service";
import { verifyPanelAuthorization } from "./auth";
import { getConversationStore, resetConversationStoreForTests } from "./file-store";

describe("conversations security", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    resetConversationStoreForTests();
    delete process.env.TWILIO_WEBHOOK_AUTH_TOKEN;
    delete process.env.VERCEL_ENV;
    delete process.env.HOTEL_CONVERSATIONS_STORE_DIR;
    delete process.env.HOTEL_PANEL_USERNAME;
    delete process.env.HOTEL_PANEL_PASSWORD;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("rejects panel access in production when credentials are missing", () => {
    const result = verifyPanelAuthorization(null, {
      NODE_ENV: "production",
    });

    expect(result.ok).toBe(false);
    expect(result.agent).toBe("anonymous");
    expect(result.response?.status).toBe(503);
  });

  it("requires matching basic auth credentials when configured", () => {
    const env = {
      NODE_ENV: "production",
      HOTEL_PANEL_USERNAME: "admin",
      HOTEL_PANEL_PASSWORD: "correct-password",
    };
    const invalid = Buffer.from("admin:wrong-password").toString("base64");
    const valid = Buffer.from("admin:correct-password").toString("base64");

    const rejected = verifyPanelAuthorization(`Basic ${invalid}`, env);
    const accepted = verifyPanelAuthorization(`Basic ${valid}`, env);

    expect(rejected.ok).toBe(false);
    expect(rejected.response?.status).toBe(401);
    expect(rejected.response?.headers.get("WWW-Authenticate")).toContain(
      "Basic",
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.agent).toBe("admin");
  });

  it("normalizes WhatsApp phone values without preserving formatting noise", () => {
    expect(normalizePhone("whatsapp:+34 600 123 456")).toEqual({
      phoneE164: "+34600123456",
      phoneNormalized: "34600123456",
    });
  });

  it("escapes TwiML message bodies before returning XML", () => {
    const twiml = buildTwilioMessageResponse("Hola <admin> & gracias");

    expect(twiml).toContain("Hola &lt;admin&gt; &amp; gracias");
    expect(twiml).not.toContain("Hola <admin> & gracias");
  });

  it("builds Twilio delivery XML from a persisted bot reply when twiml is missing", () => {
    const twiml = resolveTwilioWebhookTwiml({
      botReply: {
        body: "Buenos días. ¿En qué podemos ayudarte?",
      },
    });

    expect(twiml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Buenos días. ¿En qué podemos ayudarte?</Message></Response>',
    );
    expect(twiml).not.toMatch(/^\s*\{/);
  });

  it("returns empty valid TwiML when no auto-reply is available", () => {
    expect(resolveTwilioWebhookTwiml()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
    expect(resolveTwilioWebhookTwiml({})).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  it("keeps all panel conversation API routes behind panel auth", () => {
    const routeFiles = [
      "src/app/api/conversations/route.ts",
      "src/app/api/conversations/[id]/route.ts",
      "src/app/api/conversations/[id]/reply/route.ts",
      "src/app/api/conversations/[id]/mode/route.ts",
      "src/app/api/conversations/[id]/mark-read/route.ts",
      "src/app/api/conversations/[id]/messages/route.ts",
      "src/app/api/conversations/events/route.ts",
      "src/app/api/conversations/reset/route.ts",
    ];

    for (const routeFile of routeFiles) {
      const source = readFileSync(path.join(process.cwd(), routeFile), "utf8");
      expect(source, routeFile).toContain("requirePanelAuth");
      expect(source, routeFile).toContain("if (!auth.ok)");
    }
  });

  it("requires explicit confirmation before resetting the conversation store", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "hotel-conversation-reset-"));
    process.env.HOTEL_CONVERSATIONS_STORE_DIR = tempDir;
    process.env.HOTEL_PANEL_USERNAME = "admin";
    process.env.HOTEL_PANEL_PASSWORD = "correct-password";
    resetConversationStoreForTests();

    await handleInboundWhatsApp(
      {
        from: "whatsapp:+34600000041",
        to: "whatsapp:+14155238886",
        body: "Hola, quiero información",
        messageSid: "SM_RESET_ROUTE_001",
      },
      getConversationStore(),
      createStaticClientDirectory([]),
    );

    const authorization = `Basic ${Buffer.from("admin:correct-password").toString("base64")}`;
    const missingConfirmation = await postConversationsReset(
      new Request("https://example.test/api/conversations/reset", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(missingConfirmation.status).toBe(400);

    const dryRun = await postConversationsReset(
      new Request("https://example.test/api/conversations/reset", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    expect(dryRun.status).toBe(200);
    await expect(dryRun.json()).resolves.toMatchObject({
      ok: true,
      reset: { dryRun: true, deleted: false, conversations: 1 },
    });

    const confirmed = await postConversationsReset(
      new Request("https://example.test/api/conversations/reset", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESET_CONVERSATIONS" }),
      }),
    );
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({
      ok: true,
      reset: { dryRun: false, deleted: true, conversations: 1 },
    });

    const snapshot = JSON.parse(
      readFileSync(path.join(tempDir, "hotel-conversations.json"), "utf8"),
    );
    expect(snapshot.conversations).toEqual([]);
    expect(snapshot.suppressDemoSeed).toBe(true);
  });

  it("enforces the manual reply character limit on server-side routes", () => {
    const routeFiles = [
      "src/app/api/conversations/[id]/reply/route.ts",
      "src/app/api/conversations/[id]/messages/route.ts",
    ];

    for (const routeFile of routeFiles) {
      const source = readFileSync(path.join(process.cwd(), routeFile), "utf8");
      expect(source, routeFile).toContain("MANUAL_REPLY_MAX_CHARS");
      expect(source, routeFile).toContain("status: 400");
    }
  });

  it("keeps operational API routes behind panel auth", () => {
    const routeFiles = [
      "src/app/api/ops/email/poll/route.ts",
      "src/app/api/ops/reminders/dispatch/route.ts",
      "src/app/api/ops/reservations/[reservationId]/confirm/route.ts",
      "src/app/api/ops/reservations/[reservationId]/send-reply/route.ts",
      "src/app/api/ops/reservations/[reservationId]/cancel-request/route.ts",
    ];

    for (const routeFile of routeFiles) {
      const source = readFileSync(path.join(process.cwd(), routeFile), "utf8");
      expect(source, routeFile).toContain("requirePanelAuth");
      expect(source, routeFile).toContain("if (!auth.ok)");
    }
  });

  it("protects admin, internal and ops pages with page access checks and proxy matcher", () => {
    for (const routeFile of ["src/app/admin/page.tsx", "src/app/internal/page.tsx", "src/app/ops/page.tsx"]) {
      const source = readFileSync(path.join(process.cwd(), routeFile), "utf8");
      expect(source, routeFile).toContain("verifyPanelPageAccess");
      expect(source, routeFile).toContain("if (!auth.ok)");
    }

    const proxySource = readFileSync(path.join(process.cwd(), "src/proxy.ts"), "utf8");
    expect(proxySource).toContain("/admin/:path*");
    expect(proxySource).toContain("/internal/:path*");
    expect(proxySource).toContain("/api/ops/:path*");
  });

  it("rejects Twilio webhook calls with an invalid configured token", async () => {
    process.env.TWILIO_WEBHOOK_AUTH_TOKEN = "expected-token";

    const response = await postTwilioWebhook(
      new Request("https://example.test/api/twilio/whatsapp", {
        method: "POST",
        headers: {
          "x-hotel-webhook-token": "wrong-token",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("text/xml");
    expect(await response.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  it("rejects production Twilio webhook calls when token is not configured", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";

    try {
      const response = await postTwilioWebhook(
        new Request("https://example.test/api/twilio/whatsapp", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            From: "whatsapp:+34600000001",
            Body: "Hola",
            MessageSid: "SM_NO_TOKEN_PROD",
          }),
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.text()).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("accepts Twilio webhook token by dedicated header and creates a handoff", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "hotel-twilio-webhook-"));
    process.env.HOTEL_CONVERSATIONS_STORE_DIR = tempDir;
    process.env.TWILIO_WEBHOOK_AUTH_TOKEN = "expected-token";

    const response = await postTwilioWebhook(
      new Request("https://example.test/api/twilio/whatsapp", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-webhook-token": "expected-token",
        },
        body: new URLSearchParams({
          From: "whatsapp:+34600000001",
          To: "whatsapp:+14155238886",
          Body: "Hola, quiero hablar con recepción",
          MessageSid: "SM_HEADER_TOKEN_001",
          ProfileName: "Cliente Sandbox",
        }),
      }),
    );

    const text = await response.text();
    const payload = JSON.parse(
      readFileSync(path.join(tempDir, "hotel-conversations.json"), "utf8"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/xml");
    expect(text).toContain("<Response><Message>");
    expect(payload.conversations).toHaveLength(1);
    expect(payload.conversations[0]).toEqual(
      expect.objectContaining({
        phoneNormalized: "34600000001",
        mode: "human",
        humanRequested: true,
      }),
    );
    expect(payload.conversations[0].events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "human_requested" }),
      ]),
    );
  });

  it("accepts Twilio webhook token by query param for console webhooks", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "hotel-twilio-query-token-"));
    process.env.HOTEL_CONVERSATIONS_STORE_DIR = tempDir;
    process.env.TWILIO_WEBHOOK_AUTH_TOKEN = "expected-token";

    const response = await postTwilioWebhook(
      new Request("https://example.test/api/twilio/whatsapp?token=expected-token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: "whatsapp:+34600000003",
          To: "whatsapp:+14155238886",
          Body: "Hola, quiero hablar con una persona",
          MessageSid: "SM_QUERY_TOKEN_001",
        }),
      }),
    );

    const payload = JSON.parse(
      readFileSync(path.join(tempDir, "hotel-conversations.json"), "utf8"),
    );

    expect(response.status).toBe(200);
    expect(payload.conversations[0]).toEqual(
      expect.objectContaining({
        phoneNormalized: "34600000003",
        mode: "human",
      }),
    );
  });

  it("does not add direct Meta WhatsApp API routes or transports", () => {
    const files = [
      "src/app/api",
      "src/lib/hotel",
      "scripts",
    ].flatMap((root) =>
      Array.from(
        readdirSync(path.join(process.cwd(), root), { recursive: true })
          .filter((entry: unknown): entry is string => typeof entry === "string")
          .map((entry: string) => path.join(root, entry)),
      ),
    );

    for (const file of files) {
      const absolute = path.join(process.cwd(), file);
      try {
        const source = readFileSync(absolute, "utf8");
        expect(source, file).not.toMatch(/graph\.facebook\.com/i);
        expect(source, file).not.toMatch(/\/api\/meta\/whatsapp/i);
      } catch {
        // Directories and binary files are irrelevant for this guardrail.
      }
    }
  });

  it("accepts media-only Twilio webhook payloads without crashing", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "hotel-twilio-media-"));
    process.env.HOTEL_CONVERSATIONS_STORE_DIR = tempDir;

    const response = await postTwilioWebhook(
      new Request("https://example.test/api/twilio/whatsapp", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: "whatsapp:+34600000002",
          To: "whatsapp:+14155238886",
          Body: "",
          MessageSid: "SM_MEDIA_001",
          NumMedia: "1",
          MediaUrl0: "https://example.test/media.jpg",
        }),
      }),
    );

    const payload = JSON.parse(
      readFileSync(path.join(tempDir, "hotel-conversations.json"), "utf8"),
    );

    expect(response.status).toBe(200);
    expect(payload.conversations[0].messages[0].body).toContain("adjunto");
  });

  it.todo("gates the admin conversations page with verifyPanelPageAccess");
});
