import { loadEnvConfig } from "@next/env";

import { loadDemoState } from "@/lib/hotel/application/demo-store";
import { selectPostStayFollowupCandidates } from "@/lib/hotel/conversations/reservation-reminders";
import {
  createScheduledMessage,
  getScheduledMessageStore,
} from "@/lib/hotel/conversations/scheduled-messages";

loadEnvConfig(process.cwd());

async function main() {
  const now = new Date();
  const state = await loadDemoState();
  const candidates = selectPostStayFollowupCandidates(state.reservations, now);
  const store = getScheduledMessageStore();
  let queued = 0;
  for (const candidate of candidates) {
    await store.upsert(
      createScheduledMessage({
        type: "post_stay_followup",
        conversationId: undefined,
        reservationId: candidate.reservationId,
        phone: candidate.phone,
        payload: {
          to: candidate.phone,
          message: candidate.message,
          petName: candidate.petName,
        },
        scheduledAt: new Date(candidate.scheduledFor),
        dedupeKey: `${candidate.reservationId}:post_stay_followup`,
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
  console.error(error instanceof Error ? error.message : "post-stay followup dry-run failed");
  process.exitCode = 1;
});
