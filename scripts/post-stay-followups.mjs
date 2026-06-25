#!/usr/bin/env node

import {
  runReservationQueueJob,
  writeJsonError,
  writeJsonResult,
} from "./hotel-scheduled-jobs-lib.mjs";

runReservationQueueJob("post_stay")
  .then((result) => {
    writeJsonResult(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    writeJsonError(error, "post_stay_followups_failed");
    process.exitCode = 1;
  });
