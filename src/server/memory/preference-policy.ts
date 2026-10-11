import "server-only";
// OWNER: 2.2

/**
 * Preference lifecycle decisions + rendering (V2-04 §2.7, §2.8). Pure.
 *
 * Lifecycle: proposed → active → superseded (or rejected / queued / expired). An explicit
 * "remember: …" saves at once only when the user's own message in this batch asked for it and
 * the run hasn't read untrusted content yet; everything else asks first, at most one question
 * per conversation.
 */
import { BUDGET, PREFS_MAX_ROWS } from "@/server/agent/config";
import { clampLines } from "@/server/agent/context/budget";
import type { AliasTable } from "@/server/agent/types";
import { neutralizeTags } from "@/server/agent/untrusted";
import type { PreferenceRow } from "@/server/memory/preferences";
import { ConstraintPrefSchema, type Constraint, type ConstraintPref } from "@/shared/scheduling-constraints";

/** What to do with a new preference proposal. */
export type ProposalDecision = "activate" | "ask" | "queue" | "reject_no_evidence";

/** Inputs to `decideProposal`. */
export interface ProposalState {
  /** a preference question was already asked in the current conversation */
  openQuestionInConversation: boolean;
  /** the user explicitly said to remember it ("remember: …") */
  explicit: boolean;
  /** the run has read untrusted content (email, Canvas, calendar, syllabus) */
  tainted: boolean;
  /** the evidence alias is a user-authored message of this run's batch */
  evidenceInBatch: boolean;
}

/**
 * Lifecycle decision for a proposal.
 * - no batch evidence → `reject_no_evidence` (memories come only from the user's own words)
 * - explicit + untainted → `activate` (save now, source 'explicit')
 * - a question was already asked this conversation → `queue` (ask later, e.g. in a briefing)
 * - otherwise → `ask` (insert as the one open `proposed` question)
 * @param s proposal state
 * @returns the decision
 */
export function decideProposal(s: ProposalState): ProposalDecision {
  if (!s.evidenceInBatch) return "reject_no_evidence";
  if (s.explicit && !s.tainted) return "activate";
  if (s.openQuestionInConversation) return "queue";
  return "ask";
}

const MAX_STATEMENT = 200;

function categoryOf(r: PreferenceRow): string {
  return r.category ?? "other";
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort preferences for rendering: category, then key, then id (total order → stable bytes).
 * @param rows preference rows
 * @returns a sorted copy
 */
export function sortPreferences(rows: readonly PreferenceRow[]): PreferenceRow[] {
  return [...rows].sort((a, b) => cmp(categoryOf(a), categoryOf(b)) || cmp(a.key, b.key) || cmp(a.id, b.id));
}

/**
 * Render active preferences for a prompt: ≤30 rows, ≤600 tokens, sorted by category then key.
 * With an alias table each line carries its `p_` alias (so `forget` can reference it).
 * @param rows active preference rows (any order)
 * @param opts.aliases alias table to mint `p_` aliases in (omit for briefing prompts)
 * @returns newline-joined lines, "" when there are none
 */
export function renderPreferences(rows: readonly PreferenceRow[], opts?: { aliases?: AliasTable }): string {
  const lines = sortPreferences(rows)
    .slice(0, PREFS_MAX_ROWS)
    .map((r) => {
      const statement = neutralizeTags(r.statement.replace(/\s+/g, " ").trim());
      const text = statement.length > MAX_STATEMENT ? `${statement.slice(0, MAX_STATEMENT - 1)}…` : statement;
      const head = opts?.aliases ? `[${opts.aliases.mint("p", r.id)}]` : "-";
      return `${head} ${categoryOf(r)} · ${r.key}: ${text}`;
    });
  return clampLines(lines, BUDGET.prefs).join("\n");
}

/** A preference about to be proposed or confirmed. */
export interface PreferenceCandidate {
  key: string;
  statement: string;
  constraintJson: unknown | null;
}

/** Constraint kinds that hold ONE value per activity (a second one replaces the first). */
const SINGLE_VALUED: ReadonlySet<Constraint["type"]> = new Set(["not_after", "not_before", "only_days", "buffer_minutes"]);

function parseConstraintPref(v: unknown): ConstraintPref | null {
  if (v === null || v === undefined) return null;
  const r = ConstraintPrefSchema.safeParse(v);
  return r.success ? r.data : null;
}

function activityKey(a: string): string {
  const t = a.toLowerCase().trim().replace(/\s+/g, " ");
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

function sameDays(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = [...new Set(a ?? [])].sort();
  const y = [...new Set(b ?? [])].sort();
  return x.length === y.length && x.every((d, i) => d === y[i]);
}

/**
 * Whether two machine-readable preferences say different things about the same single-valued
 * setting, so the newer must replace the older: an email sign-off, waking hours, or the same
 * `not_after` / `not_before` / `only_days` / `buffer_minutes` constraint on an overlapping
 * activity (same weekday filter). Additive kinds (`avoid_range`, `avoid_days`) never conflict.
 * @param a one constraint_json (unparseable → no conflict)
 * @param b the other
 * @returns true when they conflict
 */
export function constraintsConflict(a: unknown, b: unknown): boolean {
  const x = parseConstraintPref(a);
  const y = parseConstraintPref(b);
  if (!x || !y) return false;
  if (x.signoff !== null && y.signoff !== null) return true;
  if (x.waking !== null && y.waking !== null) return true;
  const cx = x.constraint;
  const cy = y.constraint;
  if (!cx || !cy || cx.type !== cy.type || !SINGLE_VALUED.has(cx.type)) return false;
  const ax = new Set(x.applies_to.map(activityKey));
  if (!y.applies_to.map(activityKey).some((v) => ax.has(v))) return false;
  if ((cx.type === "not_after" || cx.type === "not_before") && (cy.type === "not_after" || cy.type === "not_before")) {
    return sameDays(cx.days, cy.days);
  }
  return true;
}

function normStatement(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The active preference a candidate replaces (V2-04 §2.7 supersede), or null for a new rule:
 * 1. the active row with the same key;
 * 2. else an active row whose constraint conflicts (`constraintsConflict`) — the model picked a
 *    different key for the same rule ("workout.latest_time" vs "gym.latest_time");
 * 3. else an active row with the same statement.
 * Ties resolve in `sortPreferences` order (deterministic).
 * @param active the user's active preferences
 * @param c the candidate
 * @returns the replaced row, or null
 */
export function findReplacedPreference(active: readonly PreferenceRow[], c: PreferenceCandidate): PreferenceRow | null {
  const rows = sortPreferences(active.filter((r) => r.status === "active"));
  const sameKey = rows.find((r) => r.key === c.key);
  if (sameKey) return sameKey;
  const conflicting = rows.find((r) => constraintsConflict(r.constraintJson, c.constraintJson));
  if (conflicting) return conflicting;
  const stmt = normStatement(c.statement);
  return rows.find((r) => normStatement(r.statement) === stmt) ?? null;
}
