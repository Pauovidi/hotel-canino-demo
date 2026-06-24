import { loadEnvConfig } from "@next/env";

import { dispatchDueScheduledMessages } from "@/lib/hotel/conversations/scheduled-messages";

loadEnvConfig(process.cwd());

async function main() {
  const result = await dispatchDueScheduledMessages();
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        dryRunOnly: result.dryRunOnly,
        due: result.due,
        sent: result.sent,
        dryRun: result.dryRun,
        failed: result.failed,
        skipped: result.skipped,
      },
      null,
      2,
    ),
  );

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      safeErrorCode:
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code).slice(0, 80)
          : undefined,
    }),
  );
  process.exitCode = 1;
});
