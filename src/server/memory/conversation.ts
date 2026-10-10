import "server-only";
// OWNER: 2.2

/**
 * Conversation boundaries (V2-04 §2.7 "one question per conversation"). Pure.
 * A conversation is a run of messages whose consecutive gaps are all < `gapMin` minutes.
 */
import { CONVERSATION_GAP_MIN } from "@/server/agent/config";

/**
 * Start of the latest conversation in `timestamps`. Include "now" in the list to ask about the
 * conversation happening right now (a long silence before now then yields now itself).
 * @param timestamps message times in any order (invalid dates ignored)
 * @param gapMin minutes of silence that start a new conversation (default 30)
 * @returns the first timestamp of the latest conversation, or null when there are none
 */
export function conversationStartedAt(timestamps: Date[], gapMin: number = CONVERSATION_GAP_MIN): Date | null {
  const ts = timestamps
    .map((d) => d.getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (ts.length === 0) return null;
  const gapMs = gapMin * 60_000;
  let i = ts.length - 1;
  while (i > 0 && ts[i] - ts[i - 1] < gapMs) i--;
  return new Date(ts[i]);
}

/**
 * Whether a preference question asked at `askedAt` belongs to the conversation happening `now`.
 * @param askedAt when the open question was asked (null = never)
 * @param messageTimes recent message times (both directions)
 * @param now the current time (counts as part of the conversation)
 * @param gapMin conversation gap in minutes (default 30)
 * @returns true if the question was asked in the current conversation
 */
export function askedInCurrentConversation(
  askedAt: Date | null,
  messageTimes: Date[],
  now: Date,
  gapMin: number = CONVERSATION_GAP_MIN,
): boolean {
  if (!askedAt || !Number.isFinite(askedAt.getTime())) return false;
  const start = conversationStartedAt([...messageTimes, askedAt, now], gapMin);
  return start !== null && askedAt.getTime() >= start.getTime();
}
