import "server-only";
// OWNER: 3.3

/**
 * Agent tool `propose_preference` (master plan §1.4 #23; V2-04 §9.2, §2.7, §2.8; + nullable
 * `constraint`, §1.17). Lifecycle via `decideProposal`:
 * - explicit + untainted run → saved active at once (source 'explicit')
 * - a preference question was already asked in this conversation → `queued` (asked later)
 * - otherwise → the one open `proposed` question (the model asks it; `confirm_preference` decides)
 * Evidence must be the student's own message in this batch (only their words create memories).
 */
import { z } from "zod";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { db } from "@/server/db";
import {
  askedInCurrentConversation,
  decideProposal,
  findReplacedPreference,
  getOpenQuestion,
  insertProposal,
  listActivePreferences,
  saveExplicitPreference,
  type ProposalDecision,
} from "@/server/memory";
import { normStatement } from "@/server/memory/preference-policy";
import { ConstraintPrefSchema } from "@/shared/scheduling-constraints";

const input = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/),
  category: z.enum(["schedule", "reminders", "email", "briefing", "persona", "study", "other"]),
  statement: z.string().min(3).max(160),
  explicit: z.boolean(),
  constraint: ConstraintPrefSchema.nullable(),
  evidence: EV,
});

const RECENT_MESSAGES_MS = 12 * 3_600_000;

/** Whether the open question (if any) was asked in the conversation happening now. */
async function questionAskedThisConversation(ctx: ToolCtx): Promise<boolean> {
  const open = await getOpenQuestion(ctx.userId);
  if (!open) return false;
  const { data, error } = await db()
    .from("messages")
    .select("created_at")
    .eq("user_id", ctx.userId)
    .gte("created_at", new Date(ctx.now.getTime() - RECENT_MESSAGES_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`propose_preference: messages read failed: ${error.message}`);
  return askedInCurrentConversation(
    open.askedAt,
    (data ?? []).map((m) => new Date(m.created_at)),
    ctx.now,
  );
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns `ok: active` | `{proposal, ask: true, replaces?}` | `{proposal, ask: false, queued: true}`, or an error
 */
export async function runProposePreference(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const statement = i.statement.replace(/\s+/g, " ").trim();
  const evidenceMessageId = ctx.aliases.resolve(i.evidence, "m");
  try {
    // The active rule this one replaces: same key, or the same single-valued constraint saved under
    // another key. The proposal takes that row's key so confirming supersedes it (decide_preference
    // closes the active row with the same key) instead of leaving two active rules.
    const active = findReplacedPreference(await listActivePreferences(ctx.userId), {
      key: i.key,
      statement,
      constraintJson: i.constraint,
    });
    if (active && normStatement(active.statement) === normStatement(statement)) return { ok: true, data: "ok: already active" };
    const decision: ProposalDecision = decideProposal({
      openQuestionInConversation: i.explicit && !ctx.taint.tainted ? false : await questionAskedThisConversation(ctx),
      explicit: i.explicit,
      tainted: ctx.taint.tainted,
      evidenceInBatch: true,
    });
    const base = {
      userId: ctx.userId,
      key: active?.key ?? i.key,
      category: i.category,
      statement,
      evidenceMessageId,
      ...(i.constraint ? { constraintJson: i.constraint } : {}),
    };
    switch (decision) {
      case "activate": {
        await saveExplicitPreference({ ...base, runId: ctx.runId });
        return { ok: true, data: active ? `ok: active (replaces "${active.statement}")` : "ok: active" };
      }
      case "ask": {
        const row = await insertProposal({ ...base, status: "proposed", runId: ctx.runId });
        const data: Record<string, unknown> = { proposal: ctx.aliases.mint("p", row.id), ask: true };
        if (active) data.replaces = active.statement;
        return { ok: true, data };
      }
      case "queue": {
        const row = await insertProposal({ ...base, status: "queued", runId: ctx.runId });
        return {
          ok: true,
          data: {
            proposal: ctx.aliases.mint("p", row.id),
            ask: false,
            queued: true,
            note: "don't ask now; already asked one question this conversation",
          },
        };
      }
      case "reject_no_evidence":
        return { ok: false, error: "evidence must be the student's own message in <new_messages>" };
    }
  } catch (e) {
    ctx.log("propose_preference_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't save that preference just now", retryable: true };
  }
}

/** `propose_preference` tool. */
export const proposePreferenceTool = defineTool({
  name: "propose_preference",
  description:
    "Save a lasting preference or rule the student expressed (e.g. 'no gym after 8pm'). explicit=true only when they directly asked you to remember it; otherwise it becomes a question to confirm. Fill constraint when it's a scheduling rule find_free_slots should enforce, else null.",
  input,
  mutates: true,
  run: runProposePreference,
});
