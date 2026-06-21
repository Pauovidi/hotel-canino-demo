#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPostgresConversationSchema, createPoolFromEnv } from "./postgres-conversation-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "db", "migrations");

async function main() {
  const pool = createPoolFromEnv();
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS hotel_schema_migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const id = Number.parseInt(file.split("_")[0], 10);
      const existing = await pool.query(
        "SELECT 1 FROM hotel_schema_migrations WHERE id = $1",
        [id],
      );

      if (existing.rowCount) {
        console.log(`[skip] ${file}`);
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO hotel_schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [id, file],
        );
        await client.query("COMMIT");
        console.log(`[ok] ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const health = await checkPostgresConversationSchema(pool);
    if (!health.ok) {
      console.error(
        JSON.stringify({
          ok: false,
          postgresSchemaReady: false,
          missingTables: health.missingTables,
          missingColumns: health.missingColumns,
        }),
      );
      process.exitCode = 1;
      return;
    }

    console.log("[ok] Postgres conversation schema ready.");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      safeErrorCode:
        error && typeof error === "object" && "code" in error
          ? String(error.code).slice(0, 80)
          : undefined,
    }),
  );
  process.exitCode = 1;
});
