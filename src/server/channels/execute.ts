import "server-only";
// OWNER: 1.2

/**
 * Runs render steps against a provider (V2-03 §2.5, §2.10). All I/O is injected (`ExecuteIo`),
 * so tests use fake time and a fake provider.
 *
 * Guarantees:
 * - **At-most-once:** `beforeSend` inserts the outbound row (idempotency key) *before* the send;
 *   `null` means the key already exists → the step is skipped. A timeout or ambiguous failure is
 *   never resent.
 * - **Inline reply rejected** (`errorKey: "reply_to_rejected"`): resent once without `reply_to`,
 *   on the same row.
 * - **Reactions** are best-effort. When the provider reports reactions unavailable (after a 422
 *   `unsupported_on_this_line` the Sendblue adapter flips its capability), remaining reactions
 *   are skipped and their `fallbackText` is sent as a bubble instead.
 * - **Abort:** checked before every step and after every pause; nothing is sent once aborted.
 * - **Declined** (e.g. opted out at the provider): later sends are skipped.
 */
import { maskHandle } from "@/server/phone";
import type { ReactStep, RenderStep, SendStep } from "@/server/channels/render";
import type { ChannelProvider, OutboundTarget, ReactionType, SendResult } from "@/server/channels/types";

/** Error key a provider returns when an inline reply was refused (send it again without). */
export const REPLY_REJECTED = "reply_to_rejected";

/** Injected I/O for `executeSteps`. */
export interface ExecuteIo {
  provider: ChannelProvider;
  target: OutboundTarget;
  sleep(ms: number): Promise<void>;
  signal?: AbortSignal;
  /** Insert the outbound row before sending. `null` = idempotency conflict (already attempted). */
  beforeSend(step: SendStep): Promise<{ messageId: string } | null>;
  /** Record the provider result on the row. */
  afterSend(messageId: string, result: SendResult): Promise<void>;
  /** `messages.id` → provider message id (for reactions and inline replies). */
  resolveProviderId(messageId: string): Promise<string | null>;
  /** Persist an outbound reaction we sent. */
  recordReaction(targetMessageId: string, reaction: ReactionType): Promise<void>;
}

/** What happened. */
export interface ExecuteReport {
  /** Rows created by `beforeSend`, in send order (including failed sends). */
  messageIds: string[];
  sent: number;
  failed: number;
  /** Steps skipped because their idempotency key already existed. */
  skipped: number;
  reactionsSent: number;
  reactionsFailed: number;
  aborted: boolean;
  /** Set when the provider declined a send (e.g. "OPTED_OUT"); later sends were skipped. */
  declined: string | null;
}

/**
 * Executes steps in order.
 * @param steps output of `renderPlan`
 * @param io provider, target, clock and bookkeeping callbacks
 * @returns a report; never throws for provider failures (callback errors propagate)
 */
export async function executeSteps(steps: RenderStep[], io: ExecuteIo): Promise<ExecuteReport> {
  const report: ExecuteReport = {
    messageIds: [],
    sent: 0,
    failed: 0,
    skipped: 0,
    reactionsSent: 0,
    reactionsFailed: 0,
    aborted: false,
    declined: null,
  };
  const handleKind = io.target.handle.includes("@") ? "email" : "phone";
  const reactionsAvailable = (): boolean =>
    io.provider.capabilities(io.target.service, handleKind).reactions;

  for (const step of steps) {
    if (io.signal?.aborted) {
      report.aborted = true;
      break;
    }
    switch (step.t) {
      case "pause":
        await io.sleep(step.ms);
        if (io.signal?.aborted) report.aborted = true;
        break;
      case "typing":
        if (report.declined) break;
        try {
          await io.provider.typing(io.target, step.state);
        } catch {
          // best-effort
        }
        break;
      case "react":
        if (report.declined) break;
        await runReact(step, io, report, reactionsAvailable);
        break;
      case "send":
        if (report.declined) break;
        await runSend(step, io, report);
        break;
    }
    if (report.aborted) break;
  }
  return report;
}

async function runReact(
  step: ReactStep,
  io: ExecuteIo,
  report: ExecuteReport,
  reactionsAvailable: () => boolean,
): Promise<void> {
  let ok = false;
  if (reactionsAvailable()) {
    const providerId = await io.resolveProviderId(step.targetMessageId);
    if (providerId) {
      try {
        ok = await io.provider.react(io.target, providerId, step.reaction);
      } catch {
        ok = false;
      }
    }
  }
  if (ok) {
    report.reactionsSent += 1;
    await io.recordReaction(step.targetMessageId, step.reaction);
    return;
  }
  report.reactionsFailed += 1;
  // Fall back to text only when tapbacks are unavailable on this line (not for a one-off failure
  // such as a too-old target, where an extra "👍" bubble would read oddly).
  if (step.fallbackText && !reactionsAvailable()) {
    await runSend({ t: "send", kind: "fallback", text: step.fallbackText, bubbleIndex: step.bubbleIndex }, io, report);
  }
}

async function runSend(step: SendStep, io: ExecuteIo, report: ExecuteReport): Promise<void> {
  const row = await io.beforeSend(step);
  if (!row) {
    report.skipped += 1;
    return;
  }
  report.messageIds.push(row.messageId);

  const replyToProviderId = step.replyToMessageId
    ? ((await io.resolveProviderId(step.replyToMessageId)) ?? undefined)
    : undefined;
  const input = {
    ...(step.text !== undefined ? { text: step.text } : {}),
    ...(step.mediaUrl !== undefined ? { mediaUrl: step.mediaUrl } : {}),
  };

  let result = await safeSend(io, { ...input, ...(replyToProviderId ? { replyToProviderId } : {}) });
  if (replyToProviderId && isFailure(result) && result.errorKey === REPLY_REJECTED && !io.signal?.aborted) {
    result = await safeSend(io, input);
  }
  await io.afterSend(row.messageId, result);

  if (result.status === "declined") {
    report.failed += 1;
    report.declined = result.errorKey ?? "DECLINED";
    console.warn(`[channels] send declined for ${maskHandle(io.target.handle)}: ${report.declined}`);
  } else if (result.status === "failed") {
    report.failed += 1;
  } else {
    report.sent += 1;
  }
}

async function safeSend(io: ExecuteIo, input: Parameters<ChannelProvider["send"]>[1]): Promise<SendResult> {
  try {
    return await io.provider.send(io.target, input);
  } catch (err) {
    console.error(
      `[channels] provider send threw for ${maskHandle(io.target.handle)}: ${err instanceof Error ? err.name : "error"}`,
    );
    return { providerMessageId: null, status: "failed", errorKey: "exception" };
  }
}

function isFailure(r: SendResult): boolean {
  return r.status === "failed" || r.status === "declined";
}
