"use server";
/**
 * /week server actions (web plan §7.5). OWNER: 4.4.
 * Every action re-checks the session and Origin itself (`requireActionViewer`); render-time
 * gating is never trusted. Inputs are re-validated; results are small `ActionResult`s.
 */
import { refresh } from "next/cache";
import { z } from "zod";
import { setTimelineItemStatus } from "@/server/timeline";
import { requireActionViewer } from "@/server/web/guard";
import { actionFail, actionOk, type ActionResult } from "@/shared/action-result";

const Input = z.object({ itemId: z.uuid(), done: z.boolean() });

/**
 * Mark a timeline item done, or undo it. Any valid session may do this (freshness `any`).
 * Goes through V2-05 `setTimelineItemStatus` (owner-scoped, idempotent, runs the status
 * subscribers that cancel nudges) — never a direct DB update.
 * @param itemId timeline item id (UUID)
 * @param done true → "done", false → "upcoming"
 * @returns ok, or signed_out / bad_origin / invalid / not_found / server
 */
export async function setItemStatusAction(itemId: string, done: boolean): Promise<ActionResult> {
  const gate = await requireActionViewer("any");
  if (!gate.ok) return actionFail(gate.code);
  const parsed = Input.safeParse({ itemId, done });
  if (!parsed.success) return actionFail("invalid");
  try {
    const res = await setTimelineItemStatus(
      gate.viewer.userId,
      parsed.data.itemId,
      parsed.data.done ? "done" : "upcoming",
    );
    if (!res.ok) return actionFail("not_found");
  } catch (err) {
    console.error("[week] set status failed:", err instanceof Error ? err.message : "unknown");
    return actionFail("server");
  }
  refresh();
  return actionOk();
}
