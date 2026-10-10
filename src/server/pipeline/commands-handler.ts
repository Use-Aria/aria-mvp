import "server-only";
// OWNER: 2.1

/**
 * Applies deterministic keyword commands (V2-03 §2.8), before any agent run.
 *
 * Two phases so the webhook stays fast and the legally required state change is never lost:
 * - `recordCommand` (synchronous in the webhook): DB state (opt-out / opt-in / pause), a
 *   `consents` row for opt-out/in, and the message marked consumed under a finished
 *   `trigger='command'` agent run (so no agent turn ever replies to it).
 * - `confirmCommand` (in `after()`): one fixed confirmation bubble via `deliverReply`; the opt-out
 *   confirmation bypasses the opt-out guard (CTIA/TCPA allow exactly that one message).
 */
import { textPlan } from "@/server/channels/plan";
import { commandReply, type Command } from "@/server/channels/commands";
import { deliverReply, type DeliverResult } from "@/server/channels/deliver";
import { closeWithoutAgent, getUserDeliveryState, setOptOut, setPause } from "@/server/channels/repo";
import { safeTimeZone } from "@/shared/time/tz";

/** Where a command came from. */
export interface CommandContext {
  userId: string;
  channelId: string;
  /** The inbound messages.id carrying the command. */
  messageId: string;
  /** Clock (default: now). */
  now?: Date;
  /** User's IANA zone for the pause confirmation (default: loaded from `users`). */
  tz?: string;
}

/**
 * Applies a command's state change and closes its message under a `command` run.
 * @param cmd detected command
 * @param ctx user, channel, message, clock
 * @returns the agent_runs.id that consumed the message
 */
export async function recordCommand(cmd: Command, ctx: CommandContext): Promise<{ runId: string }> {
  const now = ctx.now ?? new Date();
  switch (cmd.kind) {
    case "opt_out":
      await setOptOut(ctx.channelId, now, "keyword");
      break;
    case "opt_in":
      await setOptOut(ctx.channelId, null, "keyword");
      await setPause(ctx.channelId, null);
      break;
    case "pause":
      await setPause(ctx.channelId, cmd.until);
      break;
    case "help":
      break;
  }
  const runId = await closeWithoutAgent({
    userId: ctx.userId,
    channelId: ctx.channelId,
    messageIds: [ctx.messageId],
  });
  return { runId };
}

/**
 * Sends the command's fixed confirmation bubble (idempotent per message: key `cmd:<messageId>:<i>`).
 * @param cmd detected command
 * @param ctx user, channel, message, clock, zone, and the run from `recordCommand`
 * @returns the delivery result
 */
export async function confirmCommand(cmd: Command, ctx: CommandContext & { runId: string }): Promise<DeliverResult> {
  const now = ctx.now ?? new Date();
  const tz = ctx.tz ?? safeTimeZone((await getUserDeliveryState(ctx.userId))?.timezone);
  return deliverReply({
    userId: ctx.userId,
    channelId: ctx.channelId,
    runId: ctx.runId,
    plan: textPlan([commandReply(cmd, { tz, now })]),
    elapsedMs: 0,
    trigger: "command",
    keyPrefix: `cmd:${ctx.messageId}`,
    bypassOptOut: cmd.kind === "opt_out",
  });
}

/**
 * Applies a command end to end: state change, consume, confirmation (DB update, consent row,
 * confirmation via `deliverReply(bypassOptOut)`, message consumed under a `command` agent run).
 * @param cmd detected command
 * @param ctx user, channel, message (optional clock / zone)
 */
export async function applyCommand(cmd: Command, ctx: CommandContext): Promise<void> {
  const { runId } = await recordCommand(cmd, ctx);
  const result = await confirmCommand(cmd, { ...ctx, runId });
  if (result.status === "failed") console.warn(`[pipeline] ${cmd.kind} confirmation failed: ${result.error}`);
}
