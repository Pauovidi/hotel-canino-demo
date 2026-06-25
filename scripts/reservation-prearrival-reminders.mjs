#!/usr/bin/env node

import {
  runReservationQueueJob,
  writeJsonError,
  writeJsonResult,
} from "./hotel-scheduled-jobs-lib.mjs";

runReservationQueueJob("prearrival")
  .then((result) => {
    writeJsonResult(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    writeJsonError(error, "prearrival_reminders_failed");
    process.exitCode = 1;
  });
