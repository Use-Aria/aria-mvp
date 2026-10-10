import "server-only";
// OWNER: 3.1

/**
 * Job kind `conversation_turn` (master plan §1.3): one debounced turn for a user, run by
 * `runConversationTurn` (pipeline/turn.ts). Enqueued by ingest (`turn:<userId>`, debounce 2.5s,
 * cap 8s) and kicked inline by the webhook's `after()`; the tick is the backstop.
 */
import { z } from "zod";
import { defineJobKind } from "@/server/jobs/types";
import { runConversationTurn } from "@/server/pipeline/turn";

/** Payload of `conversation_turn`. Dedupe key: `turn:<userId>` (debounce 2.5s, cap 8s). */
export const conversationTurnPayload = z.object({ userId: z.uuid() });

/** `conversation_turn` handler (maxAttempts 3). */
export const conversationTurn = defineJobKind({
  payload: conversationTurnPayload,
  maxAttempts: 3,
  run: (ctx, payload) => runConversationTurn(payload.userId, ctx),
});
