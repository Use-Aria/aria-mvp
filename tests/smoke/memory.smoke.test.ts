/**
 * Memory smoke (V2-04 §10.2; task 2.2): preferences via `decide_preference` + partial unique
 * indexes, `recall_facts` FTS, `claim_escalation` budget, and the /settings web API.
 *
 * Targets the LOCAL Supabase stack by default (keys from `supabase status -o json`); set
 * `SMOKE_TARGET=env` to use NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY instead.
 * Everything hangs off one throwaway user, deleted (cascade) in afterAll.
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

function localTarget(): { url: string; serviceKey: string } {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}

const target =
  process.env.SMOKE_TARGET === "env"
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" }
    : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;

// Server modules read env lazily (db() on first call), so importing after the assignment is safe.
import {
  PreferenceNotOpenError,
  answerProposal,
  decidePreference,
  deleteFact,
  editFact,
  editPreference,
  expireStaleQuestions,
  getOpenQuestion,
  getProfile,
  insertFact,
  insertProposal,
  listActivePreferences,
  listMemory,
  listQueuedProposals,
  listRecentFacts,
  loadProfileBlock,
  recallFacts,
  removePreference,
  retirePreferences,
  saveExplicitPreference,
  setProfileSchool,
} from "@/server/memory";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

let userId = "";
let runId = "";
const DAY = 86_400_000;

/** Throws on a PostgREST error; selects in this file always return rows (writes return null data). */
function must<T>(r: { data: T; error: { message: string } | null }, label: string): NonNullable<T> {
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  return r.data as NonNullable<T>;
}

beforeAll(async () => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const u = must(await sb.from("users").insert({ name: "Smoke Memory" }).select("id").single(), "user");
  userId = u.id;
  const r = must(await sb.from("agent_runs").insert({ user_id: userId, trigger: "inbound", is_eval: true }).select("id").single(), "run");
  runId = r.id;
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (userId) {
    const { error } = await sb.from("users").delete().eq("id", userId);
    expect(error).toBeNull();
    const left = await Promise.all([
      sb.from("user_preferences").select("id", { count: "exact", head: true }).eq("user_id", userId),
      sb.from("memory_facts").select("id", { count: "exact", head: true }).eq("user_id", userId),
      sb.from("agent_runs").select("id", { count: "exact", head: true }).eq("user_id", userId),
    ]);
    expect(left.map((l) => l.count ?? 0)).toEqual([0, 0, 0]);
  }
});

describe("preferences", () => {
  it("propose → confirm → supersede, with the partial unique indexes enforced", async () => {
    const p1 = await insertProposal({ userId, key: "gym.latest_time", category: "schedule", statement: "no gym after 8pm", status: "proposed", runId, evidenceMessageId: null, constraintJson: { applies_to: ["gym"] } });
    expect((await getOpenQuestion(userId))?.id).toBe(p1.id);

    // one open question per user
    const dupQ = await sb.from("user_preferences").insert({ user_id: userId, key: "x.y", statement: "s", status: "proposed" });
    expect(dupQ.error?.code).toBe("23505");

    const a1 = await decidePreference(userId, p1.id, "confirm");
    expect(a1.status).toBe("active");
    expect(a1.constraintJson).toEqual({ applies_to: ["gym"] });
    await expect(decidePreference(userId, p1.id, "confirm")).rejects.toBeInstanceOf(PreferenceNotOpenError);

    // one active row per key
    const dupA = await sb.from("user_preferences").insert({ user_id: userId, key: "gym.latest_time", statement: "s", status: "active" });
    expect(dupA.error?.code).toBe("23505");

    // a replacement proposal coexists with the active row, then supersedes it
    const p2 = await insertProposal({ userId, key: "gym.latest_time", category: "schedule", statement: "no gym after 9pm", status: "proposed", runId, evidenceMessageId: null });
    await decidePreference(userId, p2.id, "confirm");
    const active = await listActivePreferences(userId);
    expect(active.map((p) => p.statement)).toEqual(["no gym after 9pm"]);
    const old = must(await sb.from("user_preferences").select("status, superseded_by, valid_to").eq("id", p1.id).single(), "old");
    expect(old).toMatchObject({ status: "superseded", superseded_by: p2.id });
    expect(old.valid_to).not.toBeNull();
  });

  it("reject, queue, re-queue an older open question, explicit save, retire, expire", async () => {
    const q = await insertProposal({ userId, key: "study.time", category: "study", statement: "study mornings", status: "proposed", runId, evidenceMessageId: null });
    // a second "proposed" re-queues the first instead of violating the index
    const q2 = await insertProposal({ userId, key: "email.signoff", category: "email", statement: "sign off Best", status: "proposed", runId, evidenceMessageId: null });
    expect((await getOpenQuestion(userId))?.id).toBe(q2.id);
    expect((await listQueuedProposals(userId, 5)).map((p) => p.id)).toContain(q.id);
    expect((await decidePreference(userId, q2.id, "reject")).status).toBe("rejected");

    const ex = await saveExplicitPreference({ userId, key: "persona.emoji", category: "persona", statement: "fewer emoji", runId, evidenceMessageId: null });
    expect(ex).toMatchObject({ status: "active", source: "explicit" });
    expect(await retirePreferences(userId, [ex.id, q.id])).toBe(2);
    const states = must(await sb.from("user_preferences").select("id, status").in("id", [ex.id, q.id]), "states");
    expect(Object.fromEntries(states.map((s) => [s.id, s.status]))).toEqual({ [ex.id]: "superseded", [q.id]: "rejected" });

    const stale = await insertProposal({ userId, key: "sleep.time", category: "other", statement: "sleep by 1", status: "proposed", runId, evidenceMessageId: null });
    must(await sb.from("user_preferences").update({ asked_at: new Date(Date.now() - 2 * DAY).toISOString(), valid_from: new Date(Date.now() - 8 * DAY).toISOString() }).eq("id", stale.id), "age");
    expect(await expireStaleQuestions(userId)).toEqual({ requeued: 1, expired: 1 });
    expect(must(await sb.from("user_preferences").select("status").eq("id", stale.id).single(), "s").status).toBe("expired");
  });
});

describe("facts (recall_facts)", () => {
  it("ranks keyword matches, excludes expired/deleted, survives punctuation, bumps last_recalled_at", async () => {
    const hit = await insertFact({ userId, content: "interviewing at Stripe for a summer internship", source: "extraction", category: "career" });
    const weak = await insertFact({ userId, content: "friend from Stripe club", source: "extraction" });
    const other = await insertFact({ userId, content: "likes sushi", source: "extraction" });
    const expired = await insertFact({ userId, content: "Stripe interview prep call", source: "extraction", expiresAt: new Date(Date.now() - DAY) });
    const deleted = await insertFact({ userId, content: "Stripe internship offer", source: "extraction" });
    must(await sb.from("memory_facts").update({ deleted_at: new Date().toISOString() }).eq("id", deleted.id), "soft-delete");

    const r = await recallFacts(userId, "stripe internship?! (summer) & 'interview' | !!", 8);
    expect(r[0]?.id).toBe(hit.id);
    expect(r.map((f) => f.id)).toContain(weak.id);
    expect(r.map((f) => f.id)).not.toEqual(expect.arrayContaining([other.id]));
    expect(r.map((f) => f.id)).not.toContain(expired.id);
    expect(r.map((f) => f.id)).not.toContain(deleted.id);
    expect(await recallFacts(userId, "?!*&", 8)).toEqual([]);

    const bumped = must(await sb.from("memory_facts").select("last_recalled_at").eq("id", hit.id).single(), "bump");
    expect(bumped.last_recalled_at).not.toBeNull();
    const recent = await listRecentFacts(userId, 10);
    expect(recent.map((f) => f.id)).not.toContain(expired.id);
    expect(recent.map((f) => f.id)).not.toContain(deleted.id);
  });
});

describe("web memory API", () => {
  it("listMemory, edits, answers, hard delete, school", async () => {
    await setProfileSchool(userId, "  Yale  ");
    expect((await getProfile(userId)).school).toBe("Yale");
    expect(await loadProfileBlock(userId)).toContain("school: Yale");

    const p = await insertProposal({ userId, key: "briefing.style", category: "briefing", statement: "short briefings", status: "queued", runId, evidenceMessageId: null });
    const view = await listMemory(userId);
    expect(view.profile).toMatchObject({ name: "Smoke Memory", school: "Yale" });
    expect(view.preferences.find((x) => x.id === p.id)?.status).toBe("proposed");
    expect(view.preferences[0].status).toBe("proposed"); // open suggestions first

    expect(await answerProposal(userId, p.id, true)).toEqual({ ok: true });
    expect(await answerProposal(userId, p.id, true)).toEqual({ ok: false, code: "not_pending" });
    expect(await answerProposal(userId, "00000000-0000-4000-8000-000000000000", false)).toEqual({ ok: false, code: "not_found" });

    expect(await editPreference(userId, p.id, "very short briefings")).toEqual({ ok: true });
    const active = (await listActivePreferences(userId)).find((x) => x.key === "briefing.style");
    expect(active).toMatchObject({ statement: "very short briefings", source: "explicit" });
    expect(active?.id).not.toBe(p.id);
    expect(await removePreference(userId, active?.id ?? "")).toEqual({ ok: true });
    expect(await removePreference(userId, active?.id ?? "")).toEqual({ ok: false, code: "not_found" });

    const f = await insertFact({ userId, content: "has a dog named Mochi", source: "extraction" });
    expect(await editFact(userId, f.id, "has a dog named Mochi (shiba)")).toEqual({ ok: true });
    expect(must(await sb.from("memory_facts").select("source").eq("id", f.id).single(), "src").source).toBe("user_edit");
    expect(await deleteFact(userId, f.id)).toEqual({ ok: true });
    const gone = await sb.from("memory_facts").select("id").eq("id", f.id);
    expect(gone.data).toEqual([]); // hard-deleted, not soft
    expect(await deleteFact(userId, f.id)).toEqual({ ok: false, code: "not_found" });
  });
});

describe("claim_escalation", () => {
  it("ignores eval runs and holds the 10% boundary", async () => {
    const WINDOW = "1 minute";
    const count = async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const rows = must(await sb.from("agent_runs").select("escalated").not("model", "is", null).eq("is_eval", false).gt("started_at", since), "count");
      return { total: rows.length, esc: rows.filter((r) => r.escalated).length };
    };
    const seed = async (n: number, isEval: boolean) => {
      if (n <= 0) return [] as string[];
      const rows = Array.from({ length: n }, () => ({ user_id: userId, trigger: "inbound", model: "claude-haiku-5-5", is_eval: isEval }));
      return must(await sb.from("agent_runs").insert(rows).select("id"), "seed").map((r) => r.id);
    };

    await seed(20, true); // eval runs never count
    const base = await count();
    // Allowed iff (esc + 1) * 100 <= 10 * total. Seed to one below the boundary (incl. our run).
    const need = 10 * (base.esc + 1);
    const [mine] = await seed(1, false);
    await seed(need - 1 - (base.total + 1), false);
    const claim = async () => must(await sb.rpc("claim_escalation", { p_run: mine, p_reason: "smoke", p_pct: 10, p_window: WINDOW }), "claim");
    expect(await claim()).toBe(false);
    await seed(1, false);
    expect(await claim()).toBe(true);
    const row = must(await sb.from("agent_runs").select("escalated, escalation_reason").eq("id", mine).single(), "row");
    expect(row).toEqual({ escalated: true, escalation_reason: "smoke" });
  });
});
