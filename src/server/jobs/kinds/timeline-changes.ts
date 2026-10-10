import "server-only";
// OWNER: 4.1

/**
 * Job kind `timeline_changes` (master plan §1.3). Calls `handleTimelineChanges`. Until 4.1 lands it returns `done` so Canvas batches don't dead-letter (§1.3, V2-05 Q16). Wave 0 stub (returns done).
 */
import { TimelineChangeBatchSchema } from "@/server/timeline/types";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `timeline_changes`. Dedupe key: `tlc:<userId>:<syncRunId>`. */
export const timelineChangesPayload = TimelineChangeBatchSchema;

/** `timeline_changes` handler (maxAttempts 5). */
export const timelineChanges = defineJobKind({
  payload: timelineChangesPayload,
  maxAttempts: 5,
  run: async () => ({ type: "done" }),
});
