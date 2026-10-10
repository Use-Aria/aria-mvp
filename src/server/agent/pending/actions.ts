import "server-only";
// OWNER: 3.3

/**
 * Pending actions — the ONE path for chat and web (master plan §1.5, conflict C15; V2-04 §2.8.2).
 *
 *   create (tool, evidence-gated) → [revise (version guard)] → confirm | cancel | expire
 *   confirm = one atomic `UPDATE … SET status='executing' WHERE status='pending' AND
 *             expires_at > now() AND version = <read version>` → executor → done | failed
 *
 * At-most-once: only the caller whose UPDATE returns the row runs the executor; a crash leaves the
 * row `executing` and it is never re-run (`recoverStuckActions` asks the executor's `recover`
 * whether the side effect happened). The chat path passes `runId`: an action created in the same
 * run is refused (`same_run`), so the model can never create and approve in one turn.
 * A web confirm also posts a confirmation bubble into the chat thread.
 */
import type { ToolCtx } from "@/server/agent/types";
import { getExecutor } from "@/server/agent/pending/executors";
import type {
  ExecContext,
  ExecResult,
  OpenAction,
  PendingActionExecutor,
  PendingActionView,
  PendingKind,
  PendingStatus,
} from "@/server/agent/pending/types";
import { deliver } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { db, type Tables } from "@/server/db";
import type { Json } from "@/server/db/types";
import type { JsonValue } from "@/server/timeline/types";

type Row = Tables<"pending_actions">;

/** Thrown for programming errors at the boundary: unknown kind, payload failing the executor schema, disallowed web edit. */
export class PendingActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingActionError";
  }
}

/** Codes `confirmPendingAction` can return. */
export type ConfirmCode =
  | "not_found"
  | "not_pending"
  | "expired"
  | "version_conflict"
  | "same_run"
  | "executor_failed"
  | "google_disconnected";

/** Result of `confirmPendingAction`. */
export type ConfirmResult =
  | { ok: true; summary: string; result?: Record<string, JsonValue> }
  | { ok: false; code: ConfirmCode };

/** Result of `revisePendingAction`. */
export type ReviseResult = { ok: true; version: number } | { ok: false; code: "not_found" | "not_pending" | "expired" | "version_conflict" };

/**
 * Payload fields the web may edit, per kind (master plan §1.17: recipients are read-only on the
 * web). The chat path may revise any field; every revision is re-validated against the executor schema.
 */
export const WEB_REVISABLE_FIELDS: Readonly<Record<PendingKind, readonly string[]>> = {
  send_email: ["subject", "body_text"],
  delete_account: [],
};

/** Executor error string that maps to the `google_disconnected` confirm code (4.3's send_email). */
export const GOOGLE_DISCONNECTED = "google_disconnected";

/** A row stuck in `executing` longer than this is handed to the executor's `recover`. */
export const STUCK_EXECUTING_MS = 5 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: ReadonlySet<string> = new Set<PendingStatus>(["pending", "executing", "done", "failed", "cancelled", "expired"]);
const MAX_SUMMARY = 300;
const MAX_ERROR = 200;

function fail(where: string, message: string): never {
  throw new Error(`pending.${where}: ${message}`);
}

function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

function isKind(kind: string): kind is PendingKind {
  return kind === "send_email" || kind === "delete_account";
}

function asStatus(s: string): PendingStatus {
  return STATUSES.has(s) ? (s as PendingStatus) : "failed";
}

function isJsonRecord(v: Json | null): v is { [k: string]: Json | undefined } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** DB Json → JsonValue record (drops `undefined` members). */
function toRecord(v: Json | null): Record<string, JsonValue> | null {
  if (!isJsonRecord(v)) return null;
  return JSON.parse(JSON.stringify(v)) as Record<string, JsonValue>;
}

function toJson(v: unknown): Json {
  return JSON.parse(JSON.stringify(v ?? null)) as Json;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function isExpired(r: Row, now: Date): boolean {
  return new Date(r.expires_at).getTime() <= now.getTime();
}

/**
 * Row → read model (web §8 shape). `decided_via='expiry'` reads as null. A `pending` row past
 * its expiry reads as `expired` even before the sweep marks it.
 * @param r pending_actions row
 * @param now clock
 * @returns the view
 */
export function toPendingView(r: Row, now: Date = new Date()): PendingActionView {
  const status = asStatus(r.status);
  return {
    id: r.id,
    kind: isKind(r.kind) ? r.kind : "send_email",
    version: r.version,
    status: status === "pending" && isExpired(r, now) ? "expired" : status,
    payload: r.payload,
    summary: r.summary,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    decidedAt: r.decided_at ? new Date(r.decided_at) : null,
    decidedVia: r.decided_via === "chat" || r.decided_via === "web" ? r.decided_via : null,
    result: toRecord(r.result),
    error: r.error,
  };
}

async function readRow(userId: string, id: string): Promise<Row | null> {
  if (!isUuid(id) || !isUuid(userId)) return null;
  const { data, error } = await db().from("pending_actions").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("read", error.message);
  return data;
}

/** pending → expired (best effort, conditional). */
async function markExpired(userId: string, id: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db()
    .from("pending_actions")
    .update({ status: "expired", decided_at: now, decided_via: "expiry", updated_at: now })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .lte("expires_at", now);
  if (error) console.warn("[pending] expire failed", error.code);
}

/** executing → done | failed (only from executing). */
async function finish(
  userId: string,
  id: string,
  out: { ok: true; result: Record<string, JsonValue> | null } | { ok: false; error: string },
): Promise<void> {
  const now = new Date().toISOString();
  const patch = out.ok
    ? { status: "done", executed_at: now, updated_at: now, result: out.result ? toJson(out.result) : null, error: null }
    : { status: "failed", updated_at: now, error: oneLine(out.error, MAX_ERROR) };
  const { error } = await db().from("pending_actions").update(patch).eq("id", id).eq("user_id", userId).eq("status", "executing");
  if (error) fail("finish", error.message);
}

/** Why a guarded UPDATE matched no row (re-read and classify). */
async function classifyMiss(userId: string, id: string): Promise<"not_found" | "not_pending" | "expired" | "version_conflict"> {
  const r = await readRow(userId, id);
  if (!r) return "not_found";
  if (r.status !== "pending") return r.status === "expired" ? "expired" : "not_pending";
  if (isExpired(r, new Date())) {
    await markExpired(userId, id);
    return "expired";
  }
  // Still pending and unexpired, so the version moved under us.
  return "version_conflict";
}

/**
 * Create a pending action from a tool. The payload is validated against the executor's schema;
 * the row records the creating run (`same_run` guard) and expires after the executor's TTL.
 * With `supersedes`, that older pending action of the same user is cancelled first (draft revisions).
 * Refuses proactive runs (only user-authored chat text may trigger actions; master plan §1.0.6).
 * @param ctx tool context (user, run, aliases)
 * @param i kind, payload, model-facing summary (untrusted parts pre-wrapped), optional superseded action id
 * @returns the new row id and its `a_` alias
 * @throws PendingActionError on an unknown kind, an invalid payload, or a proactive run
 */
export async function createPendingAction(
  ctx: ToolCtx,
  i: { kind: PendingKind; payload: unknown; summary: string; supersedes?: string },
): Promise<{ id: string; alias: string }> {
  if (ctx.trigger.kind !== "inbound") throw new PendingActionError("pending actions are created only on inbound runs");
  const exec = getExecutor(i.kind);
  if (!exec) throw new PendingActionError(`unknown pending-action kind "${i.kind}"`);
  const parsed = exec.payload.safeParse(i.payload);
  if (!parsed.success) throw new PendingActionError(`invalid ${i.kind} payload`);

  if (i.supersedes && isUuid(i.supersedes)) {
    const now = ctx.now.toISOString();
    const { error } = await db()
      .from("pending_actions")
      .update({ status: "cancelled", decided_at: now, decided_via: "chat", updated_at: now, error: "superseded" })
      .eq("id", i.supersedes)
      .eq("user_id", ctx.userId)
      .eq("status", "pending");
    if (error) fail("createPendingAction(supersede)", error.message);
  }

  const { data, error } = await db()
    .from("pending_actions")
    .insert({
      user_id: ctx.userId,
      kind: i.kind,
      payload: toJson(parsed.data),
      summary: oneLine(i.summary, MAX_SUMMARY) || exec.describe(parsed.data),
      run_id: isUuid(ctx.runId) ? ctx.runId : null,
      status: "pending",
      version: 1,
      expires_at: new Date(ctx.now.getTime() + exec.ttlMs).toISOString(),
    })
    .select("id")
    .single();
  if (error) fail("createPendingAction", error.message);
  ctx.log("pending_created", { kind: i.kind });
  return { id: data.id, alias: ctx.aliases.mint("a", data.id) };
}

/**
 * Open (pending, unexpired) actions for the agent's "now" block.
 * @param userId owner
 * @returns open actions, newest first
 */
export async function listOpenActions(userId: string): Promise<OpenAction[]> {
  if (!isUuid(userId)) return [];
  const { data, error } = await db()
    .from("pending_actions")
    .select("id, kind, summary, version, run_id, created_at, expires_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(10);
  if (error) fail("listOpenActions", error.message);
  return (data ?? [])
    .filter((r) => isKind(r.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind as PendingKind,
      summary: r.summary ?? r.kind,
      version: r.version,
      runId: r.run_id,
      createdAt: new Date(r.created_at),
      expiresAt: new Date(r.expires_at),
    }));
}

/**
 * One action, owner-scoped (web §8 shape). A pending row past its expiry is marked `expired`;
 * a row stuck in `executing` > 5 min is resolved via the executor's `recover` first.
 * @param userId owner
 * @param id pending_actions.id
 * @returns the view, or null when missing / not owned / not a UUID
 */
export async function getPendingAction(userId: string, id: string): Promise<PendingActionView | null> {
  let r = await readRow(userId, id);
  if (!r) return null;
  const now = new Date();
  if (r.status === "pending" && isExpired(r, now)) {
    await markExpired(userId, id);
  } else if (r.status === "executing" && now.getTime() - new Date(r.updated_at).getTime() > STUCK_EXECUTING_MS) {
    await recoverRow(r, now);
    r = (await readRow(userId, id)) ?? r;
  }
  return toPendingView(r, now);
}

/**
 * Patch a pending action's payload under a version guard (compare-and-set on `version`).
 * The web may change only `WEB_REVISABLE_FIELDS[kind]` (send_email: subject, body_text); the
 * merged payload must still pass the executor schema. The model-facing `summary` is not rewritten.
 * @param userId owner
 * @param id action id
 * @param expectedVersion version the editor saw
 * @param patch payload fields to merge (shallow)
 * @param via surface
 * @returns new version, or why not
 * @throws PendingActionError when the web edits a read-only field or the result fails validation
 */
export async function revisePendingAction(
  userId: string,
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
  via: "chat" | "web",
): Promise<ReviseResult> {
  const r = await readRow(userId, id);
  if (!r) return { ok: false, code: "not_found" };
  if (r.status !== "pending") return { ok: false, code: r.status === "expired" ? "expired" : "not_pending" };
  if (isExpired(r, new Date())) {
    await markExpired(userId, id);
    return { ok: false, code: "expired" };
  }
  if (r.version !== expectedVersion) return { ok: false, code: "version_conflict" };
  if (!isKind(r.kind)) return { ok: false, code: "not_pending" };

  if (via === "web") {
    const allowed = WEB_REVISABLE_FIELDS[r.kind];
    const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (bad.length > 0) throw new PendingActionError(`web may not edit ${bad.join(", ")} of a ${r.kind} action`);
  }
  const exec = getExecutor(r.kind);
  if (!exec) throw new PendingActionError(`unknown pending-action kind "${r.kind}"`);
  const base = isJsonRecord(r.payload) ? r.payload : {};
  const parsed = exec.payload.safeParse({ ...base, ...patch });
  if (!parsed.success) throw new PendingActionError(`invalid ${r.kind} payload after revision`);

  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("pending_actions")
    .update({ payload: toJson(parsed.data), version: expectedVersion + 1, updated_at: now })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .eq("version", expectedVersion)
    .gt("expires_at", now)
    .select("version");
  if (error) fail("revisePendingAction", error.message);
  if (!data || data.length === 0) return { ok: false, code: await classifyMiss(userId, id) };
  return { ok: true, version: data[0].version };
}

async function runExecutor(exec: PendingActionExecutor, ctx: ExecContext, payload: unknown): Promise<ExecResult> {
  try {
    return await exec.execute(ctx, payload);
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    console.error(`[pending] executor ${exec.kind} threw ${name}`);
    return { ok: false, error: `executor_threw:${name}`, retryable: false };
  }
}

/**
 * Atomic pending→executing (version + expiry + same-run guards), run the executor, then
 * →done|failed. At-most-once: of N concurrent confirms exactly one executes; the rest get
 * `not_pending` (or `version_conflict` if the payload changed under them). A web confirm posts
 * the result into the chat (`deliver(…, {proactive:false, reason:"action_confirmed_web", dedupeKey:"act:<id>"})`).
 * @param userId owner
 * @param id action id
 * @param o surface; `expectedVersion` (web: the version the user reviewed); `runId` (chat: the
 *   confirming run — an action created in that same run is refused with `same_run`)
 * @returns executor summary/result, or why not
 */
export async function confirmPendingAction(
  userId: string,
  id: string,
  o: { via: "chat" | "web"; expectedVersion?: number; runId?: string },
): Promise<ConfirmResult> {
  const r = await readRow(userId, id);
  if (!r) return { ok: false, code: "not_found" };
  if (o.runId !== undefined && r.run_id !== null && r.run_id === o.runId) return { ok: false, code: "same_run" };
  if (r.status !== "pending") return { ok: false, code: r.status === "expired" ? "expired" : "not_pending" };
  const now = new Date();
  if (isExpired(r, now)) {
    await markExpired(userId, id);
    return { ok: false, code: "expired" };
  }
  if (o.expectedVersion !== undefined && r.version !== o.expectedVersion) return { ok: false, code: "version_conflict" };
  const exec = getExecutor(r.kind);
  if (!exec || !isKind(r.kind)) return { ok: false, code: "not_pending" };

  const nowIso = now.toISOString();
  const { data, error } = await db()
    .from("pending_actions")
    .update({ status: "executing", decided_at: nowIso, decided_via: o.via, updated_at: nowIso })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .eq("version", r.version)
    .gt("expires_at", nowIso)
    .select("*");
  if (error) fail("confirmPendingAction", error.message);
  const claimed = data?.[0];
  if (!claimed) return { ok: false, code: await classifyMiss(userId, id) };

  const parsed = exec.payload.safeParse(claimed.payload);
  const out: ExecResult = parsed.success
    ? await runExecutor(exec, { userId, actionId: id, via: o.via, now }, parsed.data)
    : { ok: false, error: "invalid_payload", retryable: false };

  if (!out.ok) {
    await finish(userId, id, { ok: false, error: out.error });
    console.warn(`[pending] ${r.kind} failed (${o.via})`);
    return { ok: false, code: out.error === GOOGLE_DISCONNECTED ? "google_disconnected" : "executor_failed" };
  }
  await finish(userId, id, { ok: true, result: out.result ?? null });

  if (o.via === "web") {
    try {
      await deliver(userId, textPlan([`${out.summary} ✅`]), {
        proactive: false,
        reason: "action_confirmed_web",
        dedupeKey: `act:${id}`,
      });
    } catch (e) {
      console.warn("[pending] web-confirm chat post failed", e instanceof Error ? e.name : "error");
    }
  }
  return out.result ? { ok: true, summary: out.summary, result: out.result } : { ok: true, summary: out.summary };
}

/**
 * Cancel a pending action (pending → cancelled; an expired-but-unswept row cancels too).
 * @param userId owner
 * @param id action id
 * @param via surface
 * @returns ok, or why not
 */
export async function cancelPendingAction(
  userId: string,
  id: string,
  via: "chat" | "web",
): Promise<{ ok: true } | { ok: false; code: "not_found" | "not_pending" }> {
  if (!isUuid(id) || !isUuid(userId)) return { ok: false, code: "not_found" };
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("pending_actions")
    .update({ status: "cancelled", decided_at: now, decided_via: via, updated_at: now })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id");
  if (error) fail("cancelPendingAction", error.message);
  if (data && data.length > 0) return { ok: true };
  return (await readRow(userId, id)) ? { ok: false, code: "not_pending" } : { ok: false, code: "not_found" };
}

/** Resolve one row stuck in `executing`: executor `recover` → done | failed (never re-executes). */
async function recoverRow(r: Row, now: Date): Promise<"done" | "failed" | "skipped"> {
  const exec = getExecutor(r.kind);
  let verdict: "done" | "not_done" = "not_done";
  if (exec?.recover) {
    const parsed = exec.payload.safeParse(r.payload);
    if (parsed.success) {
      try {
        verdict = await exec.recover({ userId: r.user_id, actionId: r.id, via: r.decided_via === "web" ? "web" : "chat", now }, parsed.data);
      } catch (e) {
        console.warn(`[pending] recover ${r.kind} threw`, e instanceof Error ? e.name : "error");
        return "skipped";
      }
    }
  }
  if (verdict === "done") {
    await finish(r.user_id, r.id, { ok: true, result: { recovered: true } });
    return "done";
  }
  await finish(r.user_id, r.id, { ok: false, error: "interrupted" });
  return "failed";
}

/**
 * Sweep rows stuck in `executing` for longer than `STUCK_EXECUTING_MS` (crash mid-execution).
 * Each is resolved with its executor's `recover` (send_email: sent-folder lookup) → done, else
 * failed ("interrupted"). Never re-runs an executor.
 * @param userId owner
 * @param now clock
 * @returns how many rows were marked done / failed
 */
export async function recoverStuckActions(userId: string, now: Date = new Date()): Promise<{ done: number; failed: number }> {
  if (!isUuid(userId)) return { done: 0, failed: 0 };
  const { data, error } = await db()
    .from("pending_actions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "executing")
    .lt("updated_at", new Date(now.getTime() - STUCK_EXECUTING_MS).toISOString())
    .limit(20);
  if (error) fail("recoverStuckActions", error.message);
  const out = { done: 0, failed: 0 };
  for (const r of data ?? []) {
    const v = await recoverRow(r, now);
    if (v === "done") out.done++;
    else if (v === "failed") out.failed++;
  }
  return out;
}
