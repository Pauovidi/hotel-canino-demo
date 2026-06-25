#!/usr/bin/env node

import {
  runDispatchScheduledMessages,
  writeJsonError,
  writeJsonResult,
} from "./hotel-scheduled-jobs-lib.mjs";

runDispatchScheduledMessages()
  .then((result) => {
    writeJsonResult(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    writeJsonError(error, "scheduled_dispatch_failed");
    process.exitCode = 1;
  });
