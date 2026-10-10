import "server-only";
// OWNER: 2.1

/**
 * Job kind `proactive_flush` (master plan §1.3): the per-user outbox. `deliver(…, {proactive})`
 * appends items (dedupe key `outbox:<userId>`, append mode); this handler calls `flushOutbox`,
 * which re-applies every guard at send time.
 */
import { z } from "zod";
import { flushOutbox } from "@/server/channels/deliver";
import { OutboxItemSchema } from "@/server/channels/types";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";

/** Payload of `proactive_flush`. Dedupe key: `outbox:<userId>` (append). */
export const proactiveFlushPayload = z.object({ items: z.array(OutboxItemSchema) });

/** `proactive_flush` handler (maxAttempts 5). */
export const proactiveFlush = defineJobKind({
  payload: proactiveFlushPayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    if (!ctx.userId) throw new PermanentJobError("proactive_flush: job has no user_id");
    return flushOutbox(ctx.userId, ctx.jobId, payload.items, ctx.now);
  },
});
