import { loadEnvConfig } from "@next/env";

import { loadDemoState } from "@/lib/hotel/application/demo-store";
import { selectPrearrivalReminderCandidates } from "@/lib/hotel/conversations/reservation-reminders";
import {
  createScheduledMessage,
  getScheduledMessageStore,
} from "@/lib/hotel/conversations/scheduled-messages";

loadEnvConfig(process.cwd());

async function main() {
  const now = new Date();
  const state = await loadDemoState();
  const candidates = selectPrearrivalReminderCandidates(state.reservations, now);
  const store = getScheduledMessageStore();
  let queued = 0;
  for (const candidate of candidates) {
    await store.upsert(
      createScheduledMessage({
        type: "reservation_prearrival_reminder",
        conversationId: undefined,
        reservationId: candidate.reservationId,
        phone: candidate.phone,
        payload: {
          to: candidate.phone,
          message: candidate.message,
          petName: candidate.petName,
        },
        scheduledAt: new Date(candidate.scheduledFor),
        dedupeKey: `${candidate.reservationId}:reservation_prearrival_reminder`,
        dryRun: candidate.dryRun,
        now,
      }),
    );
    queued += 1;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRunOnly: candidates.every((candidate) => candidate.dryRun),
        candidateCount: candidates.length,
        queued,
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
