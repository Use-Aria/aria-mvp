import "server-only";
// OWNER: 3.3

/**
 * Agent tool `send_link` (master plan §1.4 #2, §1.15; V2-04 §9.2; web §8 link keywords).
 * Mints one of Aria's own magic links and returns only a handle ("L1"); the URL is substituted
 * into the plan after the loop, so the model never sees a token.
 *
 * | kind            | purpose        | target          | preview            |
 * |-----------------|----------------|-----------------|--------------------|
 * | week            | view           | /week           | week, n = due in 7 days |
 * | setup, connect_canvas | setup    | /setup          | setup              |
 * | settings        | setup          | /settings       | settings           |
 * | connect_google  | connect_google | /setup          | setup              |
 * | email_draft     | email_draft    | /email/<id>     | email              |
 */
import { z } from "zod";
import { getPendingAction, listOpenActions } from "@/server/agent/pending/actions";
import { aliasRef, defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { mintMagicLink, type MintInput } from "@/server/security/magic-links";
import { listTimelineForRange } from "@/server/timeline";

const input = z.strictObject({
  kind: z.enum(["week", "setup", "connect_google", "connect_canvas", "settings", "email_draft"]),
  action: aliasRef("a").nullable(),
});

type LinkKind = z.output<typeof input>["kind"];

/**
 * Mint parameters for a non-draft link kind (pure).
 * @param kind link kind
 * @returns purpose, target and preview kind
 */
export function linkSpecFor(kind: Exclude<LinkKind, "email_draft">): Pick<MintInput, "purpose" | "target"> & { preview: NonNullable<MintInput["preview"]>["kind"] } {
  switch (kind) {
    case "week":
      return { purpose: "view", target: "/week", preview: "week" };
    case "setup":
    case "connect_canvas":
      return { purpose: "setup", target: "/setup", preview: "setup" };
    case "settings":
      return { purpose: "setup", target: "/settings", preview: "settings" };
    case "connect_google":
      return { purpose: "connect_google", target: "/setup", preview: "setup" };
  }
}

async function weekCount(ctx: ToolCtx): Promise<number | undefined> {
  try {
    const items = await listTimelineForRange(ctx.userId, "next_7_days", {
      kinds: ["assignment", "exam"],
      timezone: ctx.timezone,
      now: ctx.now,
    });
    return items.filter((v) => v.status === "upcoming").length;
  } catch {
    return undefined;
  }
}

/** Resolve the draft for an email_draft link: the given a_ alias, else the newest open draft. */
async function draftId(ctx: ToolCtx, action: string | null): Promise<string | ToolResult> {
  if (action) {
    const id = ctx.aliases.resolve(action, "a");
    if (!id) return { ok: false, error: `unknown action ${action}: use an a_ id shown in this run` };
    const view = await getPendingAction(ctx.userId, id);
    if (!view || view.kind !== "send_email") return { ok: false, error: `${action} is not an email draft` };
    if (view.status !== "pending") return { ok: false, error: `that draft is ${view.status}, not open anymore` };
    return id;
  }
  const open = (await listOpenActions(ctx.userId)).find((a) => a.kind === "send_email");
  return open ? open.id : { ok: false, error: "no open email draft; draft one first with draft_email" };
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns `{link: "L1"}` or a model-readable error (`rate_limited` when 10 links/hour were minted)
 */
export async function runSendLink(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  try {
    let mint: MintInput;
    if (i.kind === "email_draft") {
      const id = await draftId(ctx, i.action);
      if (typeof id !== "string") return id;
      mint = { userId: ctx.userId, purpose: "email_draft", target: `/email/${id}`, preview: { kind: "email" } };
    } else {
      const spec = linkSpecFor(i.kind);
      const n = spec.preview === "week" ? await weekCount(ctx) : undefined;
      mint = {
        userId: ctx.userId,
        purpose: spec.purpose,
        target: spec.target,
        preview: n === undefined ? { kind: spec.preview } : { kind: spec.preview, n },
      };
    }
    const url = await mintMagicLink(mint);
    if (!url) return { ok: false, error: "rate_limited: too many links this hour; tell them to try again in a bit" };
    return { ok: true, data: { link: ctx.links.add(url) } };
  } catch (e) {
    ctx.log("send_link_failed", { kind: i.kind, error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't make a link just now", retryable: true };
  }
}

/** `send_link` tool. */
export const sendLinkTool = defineTool({
  name: "send_link",
  description:
    "Mint a private one-tap link to one of Aria's web pages and get back a handle like \"L1\" to put in the reply's link field (never write URLs yourself). kind: week (their week), setup or connect_canvas (setup page), settings, connect_google, email_draft (action = the a_ id of a pending email draft; otherwise null).",
  input,
  strict: true,
  run: runSendLink,
});
