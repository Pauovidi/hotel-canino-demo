import { loadEnvConfig } from "@next/env";

import { selectPrearrivalReminderCandidates } from "@/lib/hotel/conversations/reservation-reminders";

loadEnvConfig(process.cwd());

async function main() {
  const candidates = selectPrearrivalReminderCandidates([], new Date());
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRunOnly: true,
        candidateCount: candidates.length,
        candidates,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "prearrival reminder dry-run failed");
  process.exitCode = 1;
});
