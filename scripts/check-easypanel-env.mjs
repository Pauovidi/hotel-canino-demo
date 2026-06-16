#!/usr/bin/env node

const required = [
  "NODE_ENV",
  "APP_BASE_URL",
  "HOTEL_PANEL_USERNAME",
  "HOTEL_PANEL_PASSWORD",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WEBHOOK_AUTH_TOKEN",
];

const warnings = [];
const missing = required.filter((key) => !process.env[key]?.trim());
const configuredConversationStore = (
  process.env.HOTEL_CONVERSATIONS_STORE_PROVIDER ||
  process.env.HOTEL_CONVERSATIONS_STORE ||
  process.env.HOTEL_PERSISTENCE_PROVIDER ||
  ""
).trim().toLowerCase();
const usesPostgresConversationStore = configuredConversationStore === "postgres";

if (!process.env.TWILIO_WHATSAPP_FROM?.trim() && !process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()) {
  missing.push("TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID");
}

if (process.env.HOTEL_CONVERSATIONS_MOCK_TWILIO !== "false") {
  warnings.push("HOTEL_CONVERSATIONS_MOCK_TWILIO should be false for production.");
}

if (process.env.TWILIO_WHATSAPP_PROVIDER_MODE !== "real") {
  warnings.push("TWILIO_WHATSAPP_PROVIDER_MODE should be real for the production sender.");
}

if (
  (process.env.HOTEL_PERSISTENCE_PROVIDER === "postgres" || usesPostgresConversationStore) &&
  !process.env.DATABASE_URL?.trim()
) {
  missing.push("DATABASE_URL");
}

if (usesPostgresConversationStore && process.env.HOTEL_PERSISTENCE_PROVIDER === "postgres") {
  warnings.push(
    "HOTEL_PERSISTENCE_PROVIDER=postgres is valid, but the parallel plan only requires HOTEL_CONVERSATIONS_STORE=postgres.",
  );
}

if (process.env.HOTEL_SHEETS_WRITE_ENABLED === "true") {
  warnings.push("HOTEL_SHEETS_WRITE_ENABLED should stay false during the parallel deploy.");
}

if (process.env.HOTEL_SHEETS_DRY_RUN === "false") {
  warnings.push("HOTEL_SHEETS_DRY_RUN should stay true during the parallel deploy.");
}

if (process.env.HOTEL_LLM_NLU_ENABLED === "true") {
  warnings.push("HOTEL_LLM_NLU_ENABLED should stay false until the NLU branch is promoted.");
}

if (!usesPostgresConversationStore && process.env.HOTEL_PERSISTENCE_PROVIDER !== "postgres") {
  const fileStores = [
    process.env.HOTEL_CONVERSATIONS_STORE_PATH,
    process.env.HOTEL_DEMO_STORE_PATH,
    process.env.HOTEL_REMINDERS_STORE_PATH,
    process.env.HOTEL_FILE_STORE_DIR,
  ].filter(Boolean);
  if (!fileStores.some((value) => value?.startsWith("/data"))) {
    warnings.push("File fallback should use a persistent /data mount, not container-local storage.");
  }
}

for (const warning of warnings) {
  console.warn(`[warn] ${warning}`);
}

if (missing.length > 0) {
  console.error(`[fail] Missing required env: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("[ok] EasyPanel production env shape looks valid.");
