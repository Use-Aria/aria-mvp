import "server-only";
// OWNER: 4.3

/**
 * High-importance email alerts + briefing accessors (master plan §1.12, C31; V2-07 §2.10, §7.3).
 *
 * Alert rule: `importance='high' AND confidence ≥ 0.7`. Ingest (2.5) passes only alert-eligible
 * rows (push < 24h, resync < 2h, never triage), so this module does NOT filter on `source`.
 *  1. Claim atomically: `UPDATE email_items SET alerted_at=now() WHERE id IN (…) AND alerted_at IS
 *     NULL RETURNING …` — of N concurrent callers only one wins each row (AUD-19).
 *  2. One TEMPLATE plan for all claimed rows (no LLM text: never the model summary or the subject,
 *     so third-party text can't speak in Aria's voice), sent with
 *     `deliver(…, {proactive:true, reason:"email_alert", priority:"urgent"})` — quiet hours still
 *     defer it (D8); a deferral is persisted, never dropped.
 *  3. When the alert is sent or queued the rows are marked `surfaced_at` (the briefing skips them);
 *     if delivery fails they stay unsurfaced and the briefing mentions them instead.
 *
 * Briefing (V2-06): `listEmailItemsForBriefing` = unsurfaced high/medium rows; the briefing calls
 * `markEmailItemsSurfaced` after sending.
 */
import { createHash } from "node:crypto";
import { db } from "@/server/db";
import { wrapUntrusted } from "@/server/agent/untrusted";
import { deliver, type DeliverOptions, type DeliverResult } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import type { ReplyPlan } from "@/server/channels/types";
import { getGoogleIntegration } from "@/server/integrations/google/store";
import { gmailPermalink, parseAddressList } from "@/server/integrations/google/gmail/headers";
import type { BriefingEmailItem, ClassifiedEmail } from "@/server/integrations/google/gmail/types";
import { formatForChat, safeTimeZone } from "@/shared/time/tz";

/** Minimum classifier confidence for an immediate alert. */
export const ALERT_MIN_CONFIDENCE = 0.7;
/** Max emails listed in one alert (the rest are counted). */
const ALERT_MAX_LINES = 3;
const BRIEFING_LIMIT = 20;
const NAME_MAX = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A claimed row, as the alert template needs it. */
export interface AlertRow {
  id: string;
  fromAddr: string | null;
  kind: string | null;
  course: string | null;
  newDue: Date | null;
}

/** Injectable dependencies (tests / smoke). */
export interface AlertDeps {
  deliver?: (userId: string, plan: ReplyPlan, opts: DeliverOptions) => Promise<DeliverResult>;
  now?: () => Date;
}

/**
 * Sender label safe to put in Aria's own words: the display name (or the address) with anything
 * but letters, digits, spaces and `.'@-&` removed, capped. Pure.
 * @param fromAddr stored `from_addr` (`Name <email>` or bare email)
 * @returns label, e.g. "Prof. Kim" ("someone" when empty)
 */
export function senderLabel(fromAddr: string | null): string {
  const a = fromAddr ? parseAddressList(fromAddr)[0] : undefined;
  const raw = a ? (a.name?.trim() || a.email) : (fromAddr ?? "");
  const t = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} .'@&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "someone";
  return t.length <= NAME_MAX ? t : `${t.slice(0, NAME_MAX - 1).trimEnd()}…`;
}

function courseLabel(course: string | null): string {
  const c = (course ?? "").replace(/[^\p{L}\p{N} &-]/gu, "").trim().slice(0, 16);
  return c ? ` (${c})` : "";
}

/**
 * One alert line for a classified email (template; register-neutral, lowercase). Pure.
 * @param r claimed row
 * @param tz student's IANA zone
 * @param now reference time (for "tmrw 11:59pm")
 * @returns the line
 */
export function alertLine(r: AlertRow, tz: string, now: Date): string {
  const who = senderLabel(r.fromAddr);
  const course = courseLabel(r.course);
  switch (r.kind) {
    case "deadline_change": {
      const due = r.newDue ? `, looks like it's now due ${formatForChat(r.newDue, tz, now)}` : "";
      return `${who} emailed about a deadline change${course}${due}`;
    }
    case "interview":
      return `${who} emailed about an interview`;
    case "action_needed":
      return `${who} needs something from you${course}`;
    default:
      return `important-looking email from ${who}${course}`;
  }
}

/**
 * The alert plan for one or more claimed emails (≤ 2 bubbles). Pure.
 * @param rows claimed rows (newest first)
 * @param tz student's IANA zone
 * @param now reference time
 * @returns reply plan
 */
export function alertPlan(rows: readonly AlertRow[], tz: string, now: Date): ReplyPlan {
  const zone = safeTimeZone(tz);
  if (rows.length === 1) {
    return textPlan([`heads up: ${alertLine(rows[0], zone, now)}`, "want me to pull it up?"]);
  }
  const shown = rows.slice(0, ALERT_MAX_LINES).map((r) => `• ${alertLine(r, zone, now)}`);
  const more = rows.length - shown.length;
  const tail = more > 0 ? `\n+${more} more` : "";
  return textPlan([`heads up, ${rows.length} emails look important:\n${shown.join("\n")}${tail}`, "want me to pull one up?"]);
}

async function userTimezone(userId: string): Promise<string> {
  const { data, error } = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
  if (error) throw new Error(`alerts: users read failed: ${error.message}`);
  return safeTimeZone(data?.timezone);
}

/**
 * Claim and send ONE template alert for this ingest's high-importance emails.
 * @param userId owner
 * @param items classified emails from one ingest (ids are `email_items.id`; already alert-eligible by source/age)
 * @param deps injectable `deliver` / clock
 * @returns number of emails covered by the alert (0 when none qualified or all were claimed elsewhere)
 * @throws on a DB error
 */
export async function alertHighImportance(userId: string, items: ClassifiedEmail[], deps: AlertDeps = {}): Promise<number> {
  const ids = [
    ...new Set(items.filter((c) => c.importance === "high" && c.confidence >= ALERT_MIN_CONFIDENCE && UUID_RE.test(c.id)).map((c) => c.id)),
  ];
  if (ids.length === 0) return 0;
  const now = deps.now?.() ?? new Date();

  const { data, error } = await db()
    .from("email_items")
    .update({ alerted_at: now.toISOString() })
    .eq("user_id", userId)
    .in("id", ids)
    .is("alerted_at", null)
    .select("id, from_addr, kind, course, new_due, received_at");
  if (error) throw new Error(`alertHighImportance: claim failed: ${error.message}`);
  const claimed = (data ?? [])
    .slice()
    .sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? "") || a.id.localeCompare(b.id));
  if (claimed.length === 0) return 0;

  const rows: AlertRow[] = claimed.map((r) => ({
    id: r.id,
    fromAddr: r.from_addr,
    kind: r.kind,
    course: r.course,
    newDue: r.new_due ? new Date(r.new_due) : null,
  }));
  const tz = await userTimezone(userId);
  const key = createHash("sha256")
    .update(rows.map((r) => r.id).sort().join(","))
    .digest("hex")
    .slice(0, 24);
  const send = deps.deliver ?? deliver;
  let res: DeliverResult;
  try {
    res = await send(userId, alertPlan(rows, tz, now), {
      proactive: true,
      reason: "email_alert",
      priority: "urgent",
      dedupeKey: `email_alert:${key}`,
    });
  } catch (e) {
    console.error("[gmail] email alert deliver threw", e instanceof Error ? e.name : "error");
    return 0;
  }
  if (res.status === "sent" || res.status === "queued") {
    const { error: se } = await db()
      .from("email_items")
      .update({ surfaced_at: now.toISOString() })
      .eq("user_id", userId)
      .in(
        "id",
        rows.map((r) => r.id),
      )
      .is("surfaced_at", null);
    if (se) console.warn("[gmail] mark alerted rows surfaced failed", se.code);
    return rows.length;
  }
  console.warn(`[gmail] email alert not delivered (${res.status === "suppressed" ? res.reason : res.status})`);
  return 0;
}

/**
 * High/medium email items not yet surfaced (by an alert, a digest or a briefing), for the
 * briefing (V2-06). `from` / `subject` are raw third-party text — the caller wraps them;
 * `summaryUntrusted` is already `wrapUntrusted("email")`.
 * @param userId owner
 * @param since earliest `received_at`
 * @returns up to 20 items, high first, then newest
 * @throws on a DB error
 */
export async function listEmailItemsForBriefing(userId: string, since: Date): Promise<BriefingEmailItem[]> {
  const { data, error } = await db()
    .from("email_items")
    .select("id, from_addr, subject, kind, importance, course, new_due, summary, rfc822_message_id, received_at")
    .eq("user_id", userId)
    .in("importance", ["high", "medium"])
    .is("surfaced_at", null)
    .gte("received_at", since.toISOString())
    .order("received_at", { ascending: false })
    .limit(BRIEFING_LIMIT * 2);
  if (error) throw new Error(`listEmailItemsForBriefing: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const integ = await getGoogleIntegration(userId);
  const account = integ?.account_email ?? null;
  return rows
    .slice()
    .sort((a, b) => (a.importance === b.importance ? 0 : a.importance === "high" ? -1 : 1))
    .slice(0, BRIEFING_LIMIT)
    .map((r) => ({
      id: r.id,
      from: senderLabel(r.from_addr),
      subject: r.subject ?? "",
      kind: r.kind,
      importance: r.importance === "high" ? ("high" as const) : ("medium" as const),
      course: r.course,
      newDue: r.new_due ? new Date(r.new_due) : null,
      summaryUntrusted: wrapUntrusted({ source: "email", body: r.summary ?? "", maxChars: 200 }),
      permalink: r.rfc822_message_id && account ? gmailPermalink(r.rfc822_message_id, account) : null,
    }));
}

/**
 * Mark email items as included in a briefing/digest (idempotent; already-surfaced rows keep their time).
 * @param ids email_items ids (non-UUIDs ignored)
 * @throws on a DB error
 */
export async function markEmailItemsSurfaced(ids: string[]): Promise<void> {
  const clean = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (clean.length === 0) return;
  const { error } = await db()
    .from("email_items")
    .update({ surfaced_at: new Date().toISOString() })
    .in("id", clean)
    .is("surfaced_at", null);
  if (error) throw new Error(`markEmailItemsSurfaced: ${error.message}`);
}
