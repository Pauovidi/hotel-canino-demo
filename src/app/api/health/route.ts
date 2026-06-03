import packageJson from "../../../../package.json";
import { NextResponse } from "next/server";
import { readHotelPersistenceConfig } from "@/lib/hotel/persistence/runtime";
import { readTwilioWhatsAppConfig } from "@/lib/hotel/twilio/client";
import { readGoogleSheetsConversationStoreHealth } from "@/lib/hotel/conversations/google-sheets-store";
import {
  readGoogleSheetsClientDirectoryHealth,
  readGoogleSheetsClientDirectoryLiveHealth,
} from "@/lib/hotel/clients/google-sheets-client-directory";
import { readReservationStoreHealth } from "@/lib/hotel/application/demo-store";
import { readEntryLogStoreHealth } from "@/lib/hotel/application/entry-log-state";

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

function shouldCheckClientsLive(request?: Request): boolean {
  if (!request) {
    return false;
  }

  return new URL(request.url).searchParams.get("clientsLive") === "1";
}

export async function GET(request?: Request) {
  const twilio = readTwilioWhatsAppConfig();
  const persistence = readPersistenceHealth();
  const conversationStore = readGoogleSheetsConversationStoreHealth();
  const clientDirectory = readGoogleSheetsClientDirectoryHealth();
  const reservationStore = readReservationStoreHealth();
  const entryLogStore = readEntryLogStoreHealth();
  const clients = shouldCheckClientsLive(request)
    ? {
        ...clientDirectory,
        live: await readGoogleSheetsClientDirectoryLiveHealth(clientDirectory.sheetName),
      }
    : clientDirectory;

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
    vercelEnv: process.env.VERCEL_ENV ?? null,
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
    conversationStore: {
      provider: persistence.conversationStoreProvider,
      sheetName: conversationStore.sheetName,
      configured:
        persistence.conversationStoreProvider !== "google_sheets" ||
        conversationStore.configured,
      googleSheetsConfigured: conversationStore.configured,
      hasSpreadsheetId: conversationStore.hasSpreadsheetId,
      hasCredentialSource: conversationStore.hasCredentialSource,
    },
    reservationStore,
    entryLogStore,
    clients,
  });
}
