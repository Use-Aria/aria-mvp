import "server-only";
// OWNER: 2.5

/**
 * Rules prefilter (V2-07 §2.10 table, rules applied in order; first match wins). Pure.
 *
 * Decides, from metadata only, whether an email is worth one classifier slot. Skipped emails are
 * still stored (metadata only, `importance='skipped'`) so they dedupe and count in triage.
 */
import type { EmailMeta, PrefilterHint } from "@/server/integrations/google/gmail/types";

export type { PrefilterHint };

/** Prefilter decision; `reason` is what lands in `email_items.prefilter_reason`. */
export type PrefilterResult =
  | { decision: "classify"; hint: PrefilterHint; reason: string }
  | { decision: "skip"; reason: string };

/** Per-user context for the prefilter. */
export interface PrefilterContext {
  /** The connected Gmail address (self-sent mail is skipped). */
  selfEmail: string;
  /** Course labels from the profile, e.g. "CPSC 323" or "CPSC 323: Systems Programming". */
  courses: string[];
  /** Extra school email domains (beyond any `.edu`), e.g. "yale.edu". */
  schoolDomains: string[];
}

const JUNK_LABELS = new Set(["SPAM", "TRASH", "SENT", "DRAFT"]);
const SKIP_CATEGORIES = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]);

/** Applicant-tracking / recruiting senders (V2-07 §2.10 rule 5). */
export const RECRUITER_DOMAINS: readonly string[] = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "hire.lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "workday.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "joinhandshake.com",
  "gem.com",
  "rippling.com",
  "goodtime.io",
];

/** Rule 7 keywords (subject + snippet). */
export const KEYWORD_RE =
  /\b(deadline|due|extension|extended|postpon\w*|reschedul\w*|moved to|cancell?ed|exam|midterm|quiz|interview|offer|onsite|phone screen|next steps|action required|please (respond|confirm|reply)|rsvp|urgent|asap|by (mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** True when `domain` equals `base` or is a subdomain of it. */
function inDomain(domain: string, base: string): boolean {
  const b = base.toLowerCase().replace(/^\.+/, "");
  return b !== "" && (domain === b || domain.endsWith(`.${b}`));
}

/**
 * Course-code patterns (e.g. "CPSC 323" → /\bCPSC[\s_-]*323\b/i) from profile course labels.
 * Labels without a dept+number code are ignored (a bare word like "Art" would over-match).
 * @param courses course labels
 * @returns one regex per distinct code
 */
export function courseCodePatterns(courses: readonly string[]): RegExp[] {
  const seen = new Set<string>();
  const out: RegExp[] = [];
  for (const c of courses) {
    for (const m of c.matchAll(/\b([A-Za-z]{2,6})[\s_-]*(\d{2,4}[A-Za-z]?)\b/g)) {
      const key = `${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(new RegExp(`\\b${m[1]}[\\s_-]*${m[2]}\\b`, "i"));
    }
  }
  return out;
}

function classify(hint: PrefilterHint): PrefilterResult {
  return { decision: "classify", hint, reason: `classify:${hint}` };
}

function skip(why: "self_or_junk" | "category" | "bulk"): PrefilterResult {
  return { decision: "skip", reason: `skip:${why}` };
}

/**
 * Apply the §2.10 prefilter rules in order.
 * @param m email metadata
 * @param ctx self address, profile courses, extra school domains
 * @returns classify (with hint) or skip, plus the stored reason string
 */
export function prefilterEmail(m: EmailMeta, ctx: PrefilterContext): PrefilterResult {
  const labels = new Set(m.labels);
  const from = m.from?.email.toLowerCase() ?? "";
  const self = ctx.selfEmail.trim().toLowerCase();

  // 1. junk / self
  if (m.labels.some((l) => JUNK_LABELS.has(l)) || (from !== "" && from === self)) return skip("self_or_junk");
  // 2. promotions / social
  if (m.labels.some((l) => SKIP_CATEGORIES.has(l))) return skip("category");

  const domain = from ? domainOf(from) : "";
  // 3. Canvas
  if (from === "notifications@instructure.com" || (domain !== "" && inDomain(domain, "instructure.com"))) {
    return classify("canvas");
  }
  // 4. Gradescope
  if (domain !== "" && inDomain(domain, "gradescope.com")) return classify("gradescope");
  // 5. recruiters
  if (domain !== "" && RECRUITER_DOMAINS.some((d) => inDomain(domain, d))) return classify("recruiter");
  // 6. school
  if (
    (domain !== "" && (domain.endsWith(".edu") || ctx.schoolDomains.some((d) => inDomain(domain, d)))) ||
    courseCodePatterns(ctx.courses).some((re) => re.test(m.subject))
  ) {
    return classify("school");
  }
  // 7. keywords
  if (KEYWORD_RE.test(`${m.subject}\n${m.snippet}`)) return classify("keyword");
  // 8. human-looking
  const auto = m.autoSubmitted?.toLowerCase() ?? "";
  const precedence = m.precedence?.toLowerCase() ?? "";
  const categories = m.labels.filter((l) => l.startsWith("CATEGORY_"));
  if (
    !m.listUnsubscribe &&
    !auto.startsWith("auto-") &&
    !["bulk", "list", "junk"].includes(precedence) &&
    (labels.has("CATEGORY_PERSONAL") || categories.length === 0)
  ) {
    return classify("personal");
  }
  // 9. everything else
  return skip("bulk");
}
