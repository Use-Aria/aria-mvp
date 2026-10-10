import "server-only";
// OWNER: 3.1

/**
 * Job kind `conversation_turn` (master plan §1.3). Runs `runConversationTurn` (pipeline/turn.ts). Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `conversation_turn`. Dedupe key: `turn:<userId>` (debounce 2.5s, cap 8s). */
export const conversationTurnPayload = z.object({ userId: z.uuid() });

/** `conversation_turn` handler (maxAttempts 3). */
export const conversationTurn = defineJobKind({
  payload: conversationTurnPayload,
  maxAttempts: 3,
  run: async () => {
    throw notImplemented("3.1");
  },
});
