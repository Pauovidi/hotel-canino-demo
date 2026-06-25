import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function safeJobEnv() {
  return {
    PATH: process.env.PATH ?? "",
    Path: process.env.Path ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    NODE_ENV: "test",
    DATABASE_URL: "",
    HOTEL_SCHEDULED_MESSAGES_ENABLED: "false",
    HOTEL_SCHEDULED_MESSAGES_DRY_RUN: "true",
    HOTEL_RESERVATION_REMINDERS_ENABLED: "false",
    HOTEL_RESERVATION_REMINDERS_DRY_RUN: "true",
    HOTEL_POST_STAY_FOLLOWUPS_ENABLED: "false",
    HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN: "true",
    HOTEL_SHEETS_WRITE_ENABLED: "false",
    HOTEL_SHEETS_DRY_RUN: "true",
    HOTEL_CONVERSATIONS_MOCK_TWILIO: "true",
    TWILIO_WHATSAPP_PROVIDER_MODE: "mock",
  };
}

async function runNodeScript(relativePath) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(root, relativePath)],
    {
      cwd: root,
      env: safeJobEnv(),
    },
  );
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

describe("EasyPanel production jobs hotfix", () => {
  it("uses node mjs scripts for production jobs instead of tsx", async () => {
    const packageJson = JSON.parse(await readText("package.json"));
    const productionJobs = {
      "jobs:dispatch-scheduled-messages": "node scripts/dispatch-scheduled-messages.mjs",
      "reminders:reservation-prearrival": "node scripts/reservation-prearrival-reminders.mjs",
      "followups:post-stay": "node scripts/post-stay-followups.mjs",
    };

    for (const [name, command] of Object.entries(productionJobs)) {
      expect(packageJson.scripts[name]).toBe(command);
      expect(packageJson.scripts[name]).not.toContain("tsx");
    }
  });

  it("copies migrations and production job scripts into the standalone image", async () => {
    const dockerfile = await readText("Dockerfile");

    expect(dockerfile).toContain("/app/db ./db");
    expect(dockerfile).toContain("/app/scripts ./scripts");
    expect(dockerfile).not.toContain("scripts/postgres-conversation-schema.mjs ./scripts");
  });

  it("keeps the migration runner ordered and aware of 005_scheduled_messages.sql", async () => {
    const runner = await readText("scripts/run-postgres-migrations.mjs");
    const migration = await readText("db/migrations/005_scheduled_messages.sql");

    expect(runner).toContain("readdir(migrationsDir)");
    expect(runner).toContain("^\\d+_.*\\.sql$");
    expect(runner).toContain("005_scheduled_messages.sql");
    expect(runner).toContain("[ok] Postgres scheduled messages schema ready.");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS hotel_scheduled_messages");
    expect(migration).toContain("dedupe_key text NOT NULL UNIQUE");
  });

  it("reports scheduled messages readiness and dedupe in db:check", async () => {
    const moduleUrl = pathToFileURL(
      path.join(root, "scripts/postgres-conversation-schema.mjs"),
    ).href;
    const schema = await import(`${moduleUrl}?test=${Date.now()}`);
    const rows = Object.entries(schema.REQUIRED_POSTGRES_CONVERSATION_SCHEMA).flatMap(
      ([table_name, columns]) => columns.map((column_name) => ({ table_name, column_name })),
    );

    const ready = schema.evaluatePostgresConversationSchemaRows(rows, true);
    const missingScheduled = schema.evaluatePostgresConversationSchemaRows(
      rows.filter((row) => row.table_name !== "hotel_scheduled_messages"),
      false,
    );

    expect(schema.REQUIRED_POSTGRES_SCHEDULED_MESSAGES_SCHEMA.hotel_scheduled_messages).toEqual(
      expect.arrayContaining([
        "id",
        "type",
        "conversation_id",
        "reservation_id",
        "channel",
        "external_user_id",
        "payload",
        "scheduled_at",
        "status",
        "attempts",
        "max_attempts",
        "last_error_code",
        "dedupe_key",
        "dry_run",
        "created_at",
        "updated_at",
        "sent_at",
      ]),
    );
    expect(ready).toMatchObject({
      ok: true,
      conversationSchemaReady: true,
      scheduledMessagesSchemaReady: true,
      scheduledMessagesDedupeReady: true,
    });
    expect(missingScheduled).toMatchObject({
      ok: false,
      scheduledMessagesSchemaReady: false,
      scheduledMessagesDedupeReady: false,
      missingScheduledTables: ["hotel_scheduled_messages"],
    });
  });

  it("starts all production jobs with node in fake dry-run mode", async () => {
    const dispatch = await runNodeScript("scripts/dispatch-scheduled-messages.mjs");
    const prearrival = await runNodeScript("scripts/reservation-prearrival-reminders.mjs");
    const postStay = await runNodeScript("scripts/post-stay-followups.mjs");

    expect(dispatch).toMatchObject({
      ok: true,
      dryRunOnly: true,
      due: 0,
      sent: 0,
      failed: 0,
      reason: "database_url_missing",
    });
    expect(prearrival).toMatchObject({
      ok: true,
      dryRunOnly: true,
      candidateCount: 0,
      queued: 0,
      reason: "disabled",
    });
    expect(postStay).toMatchObject({
      ok: true,
      dryRunOnly: true,
      candidateCount: 0,
      queued: 0,
      reason: "disabled",
    });
  });

  it("keeps dry-run jobs away from real WhatsApp sends and real Sheets writes", async () => {
    const lib = await readText("scripts/hotel-scheduled-jobs-lib.mjs");
    const jobEntrypoints = [
      await readText("scripts/dispatch-scheduled-messages.mjs"),
      await readText("scripts/reservation-prearrival-reminders.mjs"),
      await readText("scripts/post-stay-followups.mjs"),
    ].join("\n");

    expect(lib).toContain("config.scheduledMessagesDryRun || !config.scheduledMessagesEnabled");
    expect(lib).toContain("HOTEL_CONVERSATIONS_MOCK_TWILIO");
    expect(lib).not.toContain("googleapis");
    expect(jobEntrypoints).not.toContain("googleapis");
    expect(jobEntrypoints).not.toContain("TWILIO_AUTH_TOKEN");
  });

  it("keeps existing health and Twilio reset regression coverage in the suite", async () => {
    const healthTest = await readText("src/lib/hotel/security/health-route.test.ts");
    const twilioTest = await readText("src/lib/hotel/conversations/conversations-security.test.ts");

    expect(healthTest).toContain("response.status).toBe(200)");
    expect(twilioTest).toContain("returns exact TwiML for a global reset webhook");
    expect(twilioTest).toContain("<Message>Reiniciado.</Message>");
  });
});
