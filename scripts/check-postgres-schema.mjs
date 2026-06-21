#!/usr/bin/env node

import { checkPostgresConversationSchema, createPoolFromEnv } from "./postgres-conversation-schema.mjs";

async function main() {
  const pool = createPoolFromEnv();
  try {
    const health = await checkPostgresConversationSchema(pool);
    console.log(JSON.stringify(health, null, 2));
    if (!health.ok) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      databaseReachable: false,
      postgresSchemaReady: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      safeErrorCode:
        error && typeof error === "object" && "code" in error
          ? String(error.code).slice(0, 80)
          : undefined,
    }),
  );
  process.exitCode = 1;
});
