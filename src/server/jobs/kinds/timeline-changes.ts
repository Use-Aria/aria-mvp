import "server-only";
// OWNER: 4.1

/**
 * Job kind `timeline_changes` (master plan §1.3, §1.9; V2-05 §8.3). Enqueued after every
 * committed timeline write with changes (dedupe `tlc:<userId>:<syncRunId>`, at-least-once) and
 * handled by `handleTimelineChanges`, which is idempotent (replays never double-alert).
 */
import { handleTimelineChanges } from "@/server/alerts/timeline-changes";
import { TimelineChangeBatchSchema } from "@/server/timeline/types";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";

/** Payload of `timeline_changes`. Dedupe key: `tlc:<userId>:<syncRunId>`. */
export const timelineChangesPayload = TimelineChangeBatchSchema;

/** `timeline_changes` handler (maxAttempts 5). */
export const timelineChanges = defineJobKind({
  payload: timelineChangesPayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    if (!ctx.userId) throw new PermanentJobError("timeline_changes: job has no user_id");
    await handleTimelineChanges(ctx.userId, payload, ctx.now);
  },
});
