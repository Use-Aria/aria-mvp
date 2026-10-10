import "server-only";
// OWNER: 4.1

/**
 * Briefing job bodies (V2-06 §2.5, §2.6, §7 `briefing/run.ts`; T6). Kept out of `jobs/kinds/*`
 * so they are callable from tests with an injected clock and model.
 *
 * prepare (`briefing_prepare`, 10–20 min before the target):
 *   verify target == users.next_briefing_at (else re-derive and exit) → claim the
 *   `briefings (user_id, local_date)` row → chain the NEXT day's prepare first → ensure auto
 *   nudges → load → snapshot → decide (connect nudge / empty-day rules) → generate (LLM ≤2 tries,
 *   template fallback) → row 'ready' → enqueue `briefing_send` at the target.
 * send (`briefing_send`, at the target):
 *   reload → snapshot → regenerate when the freshness hash moved (or after a deferral) → mint the
 *   `/week` digest link (12h, master plan §1.15) → `deliver(…, {deferMode:"return"})` →
 *   sent: consume notes, mark emails surfaced, promote the queued preference question;
 *   deferred: staleness rule (regenerate / catch-up / skip at ≥18:00).
 * Idempotency: the `(user_id, local_date)` unique row, job dedupe keys, and the deliver dedupe key
 * `briefing:<userId>:<localDate>`.
 */
import { scheduleNextBriefing } from "@/server/briefing/scheduler";
import { generateBriefingPlan, type BriefingModel } from "@/server/briefing/generate";
import { loadBriefingInputs } from "@/server/briefing/load";
import {
  buildBriefingSnapshot,
  decideBriefing,
  snapshotHash,
  type BriefingDecision,
  type BriefingHistory,
  type BriefingKind,
  type BriefingSnapshot,
} from "@/server/briefing/snapshot";
import { deliver } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { db, type Tables } from "@/server/db";
import type { Json } from "@/server/db/types";
import { markEmailItemsSurfaced } from "@/server/integrations/google";
import { enqueueJob } from "@/server/jobs/enqueue";
import { loadUserSchedule } from "@/server/proactive/settings";
import { briefingDeferral } from "@/server/proactive/schedule";
import { renderConnectNudge, type Register } from "@/server/reminders/render";
import { ensureAutoNudges } from "@/server/reminders/service";
import { mintMagicLink } from "@/server/security/magic-links";
import { addLocalDays, formatLocalDate, localDateOf, parseLocalDate, zonedToUtc, type LocalDate } from "@/shared/time/tz";

/** Injectable dependencies (tests). */
export interface BriefingDeps {
  model?: BriefingModel;
  signal?: AbortSignal;
  jobId?: string;
}

/** What `prepareBriefing` did. */
export type PrepareOutcome = "disabled" | "stale_target" | "already_done" | "skipped" | "ready";
/** What `sendBriefing` did. */
export type SendOutcome = "disabled" | "already_done" | "skipped" | "deferred" | "sent";

/** Stored in `briefings.plan` (bubbles + what they included, for consumption on send). */
export interface StoredPlan {
  kind: BriefingKind;
  bubbles: string[];
  source: "llm" | "template";
  noteIds: string[];
  emailIds: string[];
  proposalId: string | null;
  weekCount: number;
  canvasHint: boolean;
}

type BriefingRow = Tables<"briefings">;

const MIN_MS = 60_000;
/** Chained prepare is solved from just after today's target. */
const CHAIN_OFFSET_MS = MIN_MS;
/** A send this late (vs the target) renders labels from the real clock instead of the target. */
const LATE_SEND_MS = 30 * MIN_MS;
/** Briefings never go out at or after this local hour (staleness rule, V2-06 §2.6). */
const STALE_AFTER_HOUR = 18;

/** Dedupe key of a user's send job for a local date. */
export function briefingSendKey(userId: string, localDate: string): string {
  return `briefing_send:${userId}:${localDate}`;
}

/** Deliver (proactive_dedupe) key of a user's briefing for a local date. */
export function briefingDeliverKey(userId: string, localDate: string): string {
  return `briefing:${userId}:${localDate}`;
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

function isStoredPlan(v: unknown): v is StoredPlan {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return Array.isArray(p.bubbles) && p.bubbles.every((b) => typeof b === "string") && typeof p.kind === "string";
}

async function getRow(userId: string, localDate: string): Promise<BriefingRow | null> {
  const { data, error } = await db().from("briefings").select("*").eq("user_id", userId).eq("local_date", localDate).maybeSingle();
  if (error) throw new Error(`briefing(row): ${error.message}`);
  return data;
}

async function claimRow(userId: string, localDate: string, targetAt: Date): Promise<BriefingRow> {
  const ins = await db()
    .from("briefings")
    .upsert(
      { user_id: userId, local_date: localDate, target_at: targetAt.toISOString(), status: "preparing" },
      { onConflict: "user_id,local_date", ignoreDuplicates: true },
    );
  if (ins.error) throw new Error(`briefing(claim): ${ins.error.message}`);
  const row = await getRow(userId, localDate);
  if (!row) throw new Error("briefing(claim): row missing after insert");
  return row;
}

async function updateRow(id: string, patch: Partial<Tables<"briefings">>): Promise<void> {
  const { error } = await db().from("briefings").update(patch).eq("id", id);
  if (error) throw new Error(`briefing(update): ${error.message}`);
}

/** Local days from `a` to `b`. */
function dayDiff(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

async function loadHistory(userId: string, localDate: LocalDate, createdAt: Date, tz: string): Promise<BriefingHistory> {
  const prior = [addLocalDays(localDate, -1), addLocalDays(localDate, -2)].map(formatLocalDate);
  const [prevRes, nudgeRes, hintRes] = await Promise.all([
    db().from("briefings").select("local_date, kind, status").eq("user_id", userId).in("local_date", prior),
    db().from("briefings").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "connect_nudge").eq("status", "sent"),
    db().from("briefings").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "sent").eq("plan->>canvasHint", "true"),
  ]);
  if (prevRes.error) throw new Error(`briefing(history): ${prevRes.error.message}`);
  if (nudgeRes.error) throw new Error(`briefing(history): ${nudgeRes.error.message}`);
  if (hintRes.error) throw new Error(`briefing(history): ${hintRes.error.message}`);
  return {
    previous: (prevRes.data ?? []).map((r) => ({ localDate: r.local_date, kind: r.kind, status: r.status })),
    connectNudgesSent: nudgeRes.count ?? 0,
    canvasHintsSent: hintRes.count ?? 0,
    daysSinceSignup: Math.max(0, dayDiff(localDateOf(createdAt, tz), localDate)),
  };
}

interface Built {
  snapshot: BriefingSnapshot;
  hash: string;
  decision: BriefingDecision;
  register: Register;
  tz: string;
}

async function build(userId: string, at: Date, mode: "daily" | "catchup"): Promise<Built> {
  const ctx = await loadBriefingInputs(userId, at, mode);
  const snapshot = buildBriefingSnapshot(ctx.inputs);
  const history = await loadHistory(userId, ctx.inputs.localDate, ctx.createdAt, ctx.inputs.user.tz);
  return {
    snapshot,
    hash: snapshotHash(snapshot),
    decision: decideBriefing(snapshot, history),
    register: ctx.inputs.user.register,
    tz: ctx.inputs.user.tz,
  };
}

async function renderPlan(
  userId: string,
  b: Built & { decision: Extract<BriefingDecision, { action: "send" }> },
  deps: BriefingDeps,
): Promise<{ plan: StoredPlan; costUsd: number }> {
  const s = b.snapshot;
  const base = {
    kind: b.decision.kind,
    noteIds: s.changes.map((c) => c.noteId),
    emailIds: s.emails.map((e) => e.id),
    proposalId: s.proposal?.id ?? null,
    weekCount: s.weekCount,
    canvasHint: b.decision.canvasHint,
  };
  if (b.decision.kind === "connect_nudge") {
    return {
      plan: { ...base, bubbles: renderConnectNudge(b.decision.connectAttempt ?? 1, b.register), source: "template", proposalId: null },
      costUsd: 0,
    };
  }
  const gen = await generateBriefingPlan(s, b.register, userId, {
    model: deps.model,
    canvasHint: b.decision.canvasHint,
    linkFollows: true,
    signal: deps.signal,
    jobId: deps.jobId,
  });
  return { plan: { ...base, bubbles: gen.bubbles, source: gen.source }, costUsd: gen.costUsd };
}

/** 18:00 local on the briefing's date: a queued briefing must not go out later than this. */
function staleAt(localDate: LocalDate, tz: string): Date {
  return zonedToUtc({ ...localDate, hour: STALE_AFTER_HOUR, minute: 0 }, tz).instant;
}

async function mintLink(userId: string, plan: StoredPlan): Promise<string | null> {
  try {
    if (plan.kind === "connect_nudge") return await mintMagicLink({ userId, purpose: "setup", preview: { kind: "setup" } });
    return await mintMagicLink({ userId, purpose: "digest", preview: { kind: "week", n: plan.weekCount } });
  } catch (e) {
    console.warn(`[briefing] link mint failed: ${errName(e)}`);
    return null;
  }
}

/** Without a link, don't end on "here:" and give connect nudges a text fallback. */
function linklessBubbles(plan: StoredPlan, register: Register): string[] {
  const out = [...plan.bubbles];
  const last = out.length - 1;
  if (last >= 0) out[last] = out[last].replace(/:\s*$/, ".");
  if (plan.kind === "connect_nudge") {
    out.push(register === "casual" ? 'text me "canvas" whenever and I\'ll send you the setup link' : 'Text me "canvas" any time and I will send you the setup link.');
  }
  return out;
}

async function consumeNotes(userId: string, briefingId: string, noteIds: string[], now: Date): Promise<void> {
  if (noteIds.length === 0) return;
  const { error } = await db()
    .from("briefing_notes")
    .update({ consumed_at: now.toISOString(), consumed_by: briefingId })
    .eq("user_id", userId)
    .in("id", noteIds)
    .is("consumed_at", null);
  if (error) throw new Error(`briefing(consume notes): ${error.message}`);
}

/**
 * The briefing asked the queued preference question: make it the open question (`proposed`,
 * `asked_at`) so the user's yes/no reply confirms it. Skipped when another question is open.
 */
async function promoteProposal(userId: string, prefId: string, now: Date): Promise<void> {
  const open = await db().from("user_preferences").select("id").eq("user_id", userId).eq("status", "proposed").limit(1);
  if (open.error) throw new Error(`briefing(proposal): ${open.error.message}`);
  if ((open.data ?? []).length > 0) return;
  const { error } = await db()
    .from("user_preferences")
    .update({ status: "proposed", asked_at: now.toISOString() })
    .eq("id", prefId)
    .eq("user_id", userId)
    .eq("status", "queued");
  if (error && error.code !== "23505") throw new Error(`briefing(proposal): ${error.message}`);
}

async function markSent(userId: string, row: BriefingRow, plan: StoredPlan, now: Date): Promise<void> {
  await updateRow(row.id, { status: "sent", sent_at: now.toISOString(), kind: plan.kind, plan: plan as unknown as Json, skip_reason: null });
  const after: [string, () => Promise<void>][] = [
    ["notes", () => consumeNotes(userId, row.id, plan.noteIds, now)],
    ["emails", () => markEmailItemsSurfaced(plan.emailIds)],
    [
      "last_sent",
      async () => {
        const { error } = await db().from("users").update({ last_briefing_sent_at: now.toISOString() }).eq("id", userId);
        if (error) throw new Error(error.message);
      },
    ],
    ["proposal", () => (plan.proposalId ? promoteProposal(userId, plan.proposalId, now) : Promise.resolve())],
  ];
  for (const [name, fn] of after) {
    try {
      await fn();
    } catch (e) {
      // The briefing is out; bookkeeping failures must not re-send it.
      console.warn(`[briefing] post-send ${name} failed: ${errName(e)}`);
    }
  }
}

async function markSkipped(row: BriefingRow, reason: string, kind?: BriefingKind): Promise<void> {
  await updateRow(row.id, { status: "skipped", skip_reason: reason, ...(kind ? { kind } : {}) });
}

/**
 * `briefing_prepare` body.
 * @param userId owner
 * @param payload target instant + its local date
 * @param now clock
 * @param deps optional model override / abort signal / job id
 * @returns what happened
 * @throws on DB errors (the job retries; the row and chain make retries safe)
 */
export async function prepareBriefing(
  userId: string,
  payload: { targetAt: string; localDate: string },
  now: Date,
  deps: BriefingDeps = {},
): Promise<{ outcome: PrepareOutcome; kind?: BriefingKind; reason?: string }> {
  const s = await loadUserSchedule(userId);
  if (!s || s.deleted || !s.settings.briefingEnabled) return { outcome: "disabled" };
  const target = new Date(payload.targetAt);

  const existing = await getRow(userId, payload.localDate);
  if (existing && (existing.status === "sent" || existing.status === "skipped")) {
    await scheduleNextBriefing(userId, now);
    return { outcome: "already_done" };
  }
  if (!existing && (!s.nextBriefingAt || s.nextBriefingAt.getTime() !== target.getTime())) {
    // Settings changed after this job was enqueued: re-derive the schedule and stop.
    await scheduleNextBriefing(userId, now);
    return { outcome: "stale_target" };
  }
  const row = existing ?? (await claimRow(userId, payload.localDate, target));

  // Chain tomorrow's prepare before anything that can fail below.
  await scheduleNextBriefing(userId, new Date(Math.max(now.getTime(), target.getTime()) + CHAIN_OFFSET_MS));

  try {
    await ensureAutoNudges(userId, now);
  } catch (e) {
    console.warn(`[briefing] ensureAutoNudges failed: ${errName(e)}`);
  }

  const at = new Date(Math.max(now.getTime(), target.getTime()));
  const b = await build(userId, at, "daily");
  if (b.decision.action === "skip") {
    await markSkipped(row, b.decision.reason, b.snapshot.kind);
    return { outcome: "skipped", reason: b.decision.reason };
  }
  const stored = isStoredPlan(row.plan) ? row.plan : null;
  const reusable = row.status === "ready" && stored !== null && row.snapshot_hash === b.hash && stored.kind === b.decision.kind;
  if (!reusable) {
    // A retry/re-run with unchanged content keeps the plan (no second LLM call).
    const { plan, costUsd } = await renderPlan(userId, { ...b, decision: b.decision }, deps);
    await updateRow(row.id, {
      status: "ready",
      kind: plan.kind,
      plan: plan as unknown as Json,
      snapshot_hash: b.hash,
      generated_at: now.toISOString(),
      llm_cost_usd: Math.round(((row.llm_cost_usd ?? 0) + costUsd) * 1e6) / 1e6,
      target_at: target.toISOString(),
    });
  }
  await enqueueJob({
    kind: "briefing_send",
    userId,
    runAt: new Date(Math.max(target.getTime(), now.getTime())),
    payload: { localDate: payload.localDate },
    dedupeKey: briefingSendKey(userId, payload.localDate),
    mode: "replace",
  });
  return { outcome: "ready", kind: b.decision.kind, ...(reusable ? { reason: "reused" } : {}) };
}

/**
 * `briefing_send` body.
 * @param userId owner
 * @param payload local date; `regenerate` after a deferral; `kind:"catchup"` for the compact form
 * @param now clock
 * @param deps optional model override / abort signal / job id
 * @returns what happened (`until` when deferred)
 * @throws when delivery fails (the job retries) or on DB errors
 */
export async function sendBriefing(
  userId: string,
  payload: { localDate: string; regenerate?: boolean; kind?: "catchup" },
  now: Date,
  deps: BriefingDeps = {},
): Promise<{ outcome: SendOutcome; kind?: BriefingKind; reason?: string; until?: Date; regenerated?: boolean }> {
  const s = await loadUserSchedule(userId);
  if (!s || s.deleted) return { outcome: "disabled" };
  const existing = await getRow(userId, payload.localDate);
  if (existing && (existing.status === "sent" || existing.status === "skipped")) return { outcome: "already_done" };
  if (!s.settings.briefingEnabled) {
    if (existing) await markSkipped(existing, "disabled");
    return { outcome: "disabled" };
  }
  const row = existing ?? (await claimRow(userId, payload.localDate, now));
  const localDate = parseLocalDate(payload.localDate) ?? localDateOf(now, s.settings.tz);

  const target = new Date(row.target_at);
  const deferredBefore = row.status === "deferred";
  const regenerate = payload.regenerate === true || deferredBefore;
  const late = now.getTime() - target.getTime() > LATE_SEND_MS;
  const at = regenerate || late ? now : new Date(Math.max(now.getTime(), target.getTime()));
  const b = await build(userId, at, payload.kind === "catchup" ? "catchup" : "daily");
  if (b.decision.action === "skip") {
    await markSkipped(row, b.decision.reason, b.snapshot.kind);
    return { outcome: "skipped", reason: b.decision.reason };
  }

  let plan: StoredPlan | null = isStoredPlan(row.plan) ? row.plan : null;
  let regenerated = false;
  if (!plan || regenerate || row.snapshot_hash !== b.hash || plan.kind !== b.decision.kind) {
    const r = await renderPlan(userId, { ...b, decision: b.decision }, deps);
    plan = r.plan;
    regenerated = true;
    await updateRow(row.id, {
      kind: plan.kind,
      plan: plan as unknown as Json,
      snapshot_hash: b.hash,
      generated_at: now.toISOString(),
      llm_cost_usd: Math.round(((row.llm_cost_usd ?? 0) + r.costUsd) * 1e6) / 1e6,
    });
  }

  const link = await mintLink(userId, plan);
  const bubbles = link ? plan.bubbles : linklessBubbles(plan, b.register);
  const result = await deliver(userId, textPlan(bubbles, link), {
    proactive: true,
    reason: plan.kind === "connect_nudge" ? "connect_nudge" : "briefing",
    dedupeKey: briefingDeliverKey(userId, payload.localDate),
    deferMode: "return",
    expiresAt: staleAt(localDate, b.tz),
  });

  switch (result.status) {
    case "sent":
    case "queued":
      await markSent(userId, row, plan, now);
      return { outcome: "sent", kind: plan.kind, regenerated };
    case "deferred": {
      const baseKind = plan.kind === "monday" ? "monday" : "daily";
      const d = briefingDeferral(result.until, localDate, b.tz, baseKind);
      if (d.action === "skip") {
        await markSkipped(row, "stale", plan.kind);
        return { outcome: "skipped", reason: "stale" };
      }
      await updateRow(row.id, { status: "deferred" });
      await enqueueJob({
        kind: "briefing_send",
        userId,
        runAt: result.until,
        payload: { localDate: payload.localDate, regenerate: true, ...(d.kind === "catchup" ? { kind: "catchup" as const } : {}) },
        dedupeKey: briefingSendKey(userId, payload.localDate),
        mode: "replace",
      });
      return { outcome: "deferred", until: result.until, kind: plan.kind };
    }
    case "suppressed":
      if (result.reason === "duplicate") {
        await markSent(userId, row, plan, now);
        return { outcome: "sent", kind: plan.kind, regenerated };
      }
      await markSkipped(row, result.reason === "expired" ? "stale" : result.reason, plan.kind);
      return { outcome: "skipped", reason: result.reason === "expired" ? "stale" : result.reason };
    case "failed":
      throw new Error(`sendBriefing: delivery failed: ${result.error}`);
  }
}
