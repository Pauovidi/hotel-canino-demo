import packageJson from "../../../../package.json";
import { NextResponse } from "next/server";
import { readHotelPersistenceConfig } from "@/lib/hotel/persistence/runtime";
import { readTwilioWhatsAppConfig } from "@/lib/hotel/twilio/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readPersistenceHealth() {
  const config = readHotelPersistenceConfig();

  return {
    provider: config.provider,
    conversationStoreProvider: config.conversationStoreProvider,
    databaseUrlConfigured: config.databaseUrlConfigured,
    durableFileBaseDir: config.durableFileBaseDir,
  };
}

export async function GET() {
  const twilio = readTwilioWhatsAppConfig();
  const persistence = readPersistenceHealth();

  return NextResponse.json({
    ok: true,
    app: "hotel-canino-demo",
    version: packageJson.version,
    commit:
      process.env.GIT_COMMIT ??
      process.env.EASYPANEL_GIT_COMMIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      null,
    uptime: Math.round(process.uptime()),
    whatsapp: {
      provider: "twilio",
      mode: twilio.providerMode,
      mock: twilio.mock,
      statusCallbackConfigured: Boolean(twilio.statusCallbackUrl),
    },
    persistence: {
      provider: persistence.provider,
      conversationStoreProvider: persistence.conversationStoreProvider,
      databaseUrlConfigured: persistence.databaseUrlConfigured,
      durableFileBaseDir: persistence.durableFileBaseDir,
    },
  });
}
