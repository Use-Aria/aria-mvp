import "server-only";
// OWNER: 3.4

/**
 * Agent tool `canvas_status` (master plan §1.4 #7; V2-05 §9.2). Read-only status plus an optional
 * early sync (`requestCanvasSync(…, "manual")`, deduped per user). The output carries no Canvas
 * titles (host, times, counts and our own copy only).
 */
import { z } from "zod";
import { defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { getCanvasStatus, requestCanvasSync, type CanvasStatusView } from "@/server/integrations/canvas/connect";
import { CANVAS_ERROR_COPY } from "@/shared/canvas-guide";
import { formatForTool } from "@/shared/time/tz";

const input = z.strictObject({ refresh: z.boolean().default(false) });

/**
 * Model-facing status object (pure).
 * @param s status view
 * @param tz the student's zone
 * @param refreshed whether an early sync was requested
 * @returns plain fields for the tool result
 */
export function renderCanvasStatus(s: CanvasStatusView, tz: string, refreshed: boolean): Record<string, unknown> {
  if (!s.connected) {
    return {
      connected: false,
      hint: "Canvas isn't connected. They can paste their Canvas Calendar Feed link here (then call connect_canvas), or use send_link kind connect_canvas.",
    };
  }
  const out: Record<string, unknown> = {
    connected: true,
    host: s.host,
    health: s.health,
    last_synced: s.syncedAt ? formatForTool(s.syncedAt, tz) : "never",
    next_sync: s.nextSyncAt && s.health !== "revoked" ? formatForTool(s.nextSyncAt, tz) : null,
    upcoming_deadlines: s.upcomingCount,
  };
  if (s.lastError) out.problem = `${s.lastError}: ${CANVAS_ERROR_COPY[s.lastError]}`;
  if (s.health === "revoked") {
    out.hint = "The feed link stopped working. Ask for a fresh Calendar Feed link (they paste it → connect_canvas), or send_link kind connect_canvas.";
  }
  if (refreshed) out.refresh = "requested; new items show up within a minute or two";
  return out;
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns the rendered status, or a retryable error
 */
export async function runCanvasStatus(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  try {
    const status = await getCanvasStatus(ctx.userId, ctx.now);
    let refreshed = false;
    if (i.refresh && status.connected && status.health !== "revoked") {
      await requestCanvasSync(ctx.userId, "manual");
      refreshed = true;
    }
    return { ok: true, data: renderCanvasStatus(status, ctx.timezone, refreshed) };
  } catch (e) {
    ctx.log("canvas_status_failed", { error: e instanceof Error ? e.name : "unknown" });
    return { ok: false, error: "couldn't check Canvas just now", retryable: true };
  }
}

/** `canvas_status` tool. */
export const canvasStatusTool = defineTool({
  name: "canvas_status",
  description:
    "Check whether Canvas is connected, when it last synced, and whether the feed has a problem. Can also trigger a refresh.",
  input,
  untrustedOutput: true,
  run: runCanvasStatus,
});
