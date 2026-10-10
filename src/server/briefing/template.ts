import "server-only";
// OWNER: 4.1

/**
 * LLM-free briefing fallback (V2-06 §2.5, §7 `briefing/template.ts`): used when the model fails
 * twice, so a briefing is never blocked by an LLM outage. Deterministic, two registers, never
 * emits URLs (the `/week` link is a separate bubble added by code). At most 2 text bubbles, since
 * the link bubble counts toward the 3-bubble cap (master plan §1.1).
 */
import type { BriefingSnapshot, SnapshotItem } from "@/server/briefing/snapshot";
import { stripUrls, type Register } from "@/server/reminders/render";

/** Most deadlines listed one per line before "+N more". */
export const TEMPLATE_LIST_MAX = 5;

function lines(items: SnapshotItem[], max: number, register: Register): string[] {
  const shown = items.slice(0, max).map((it) => `• ${it.label}: ${it.when}${it.weightPct !== null ? ` (${Math.round(it.weightPct)}%)` : ""}`);
  if (items.length > max) shown.push(register === "casual" ? `+${items.length - max} more` : `and ${items.length - max} more`);
  return shown;
}

function greeting(s: BriefingSnapshot, register: Register): string {
  const name = s.name ? (register === "casual" ? ` ${s.name}` : `, ${s.name}`) : "";
  if (s.kind === "catchup") return register === "casual" ? "quick catch-up:" : "A quick catch-up:";
  if (s.kind === "monday") return register === "casual" ? `happy monday${name}!` : `Good morning${name}. Here is your week.`;
  return register === "casual" ? `morning${name}!` : `Good morning${name}.`;
}

function examLine(e: BriefingSnapshot["exams"][number], register: Register): string {
  const when = e.daysUntil === 0 ? "today" : e.daysUntil === 1 ? (register === "casual" ? "tmrw" : "tomorrow") : `in ${e.daysUntil} days`;
  return register === "casual" ? `${e.label} is ${when}` : `${e.label} is ${when}.`;
}

/**
 * Template briefing.
 * @param s snapshot
 * @param register casual | neutral
 * @param o canvasHint: add the one-line "connect Canvas" hint
 * @returns 1–2 bubbles, URL-free
 */
export function templateBriefing(s: BriefingSnapshot, register: Register, o: { canvasHint?: boolean } = {}): string[] {
  const casual = register === "casual";
  const first: string[] = [greeting(s, register)];

  if (s.kind === "monday") {
    if (!s.week || s.week.length === 0) first.push(casual ? "nothing due this week so far 🙌" : "Nothing is due this week so far.");
    else {
      const ls: string[] = [];
      let count = 0;
      for (const d of s.week) {
        for (const it of d.items) {
          if (count >= TEMPLATE_LIST_MAX * 2) break;
          ls.push(`• ${d.day}: ${it.label} (${it.when})`);
          count += 1;
        }
      }
      const total = s.week.reduce((n, d) => n + d.items.length, 0);
      if (total > count) ls.push(casual ? `+${total - count} more` : `and ${total - count} more`);
      first.push(casual ? "this week:" : "Due this week:", ...ls);
    }
  } else if (s.dueToday.length > 0) {
    first.push(s.kind === "catchup" ? (casual ? "still due today:" : "Still due today:") : casual ? "due today:" : "Due today:");
    first.push(...lines(s.dueToday, TEMPLATE_LIST_MAX, register));
  } else if (s.kind === "empty") {
    first.push(casual ? "nothing due today 🙌 enjoy it" : "Nothing is due today.");
  } else if (s.kind !== "catchup") {
    first.push(casual ? "nothing due today." : "Nothing is due today.");
  }

  const second: string[] = [];
  if (s.dueNext.length > 0) {
    second.push(s.kind === "catchup" ? (casual ? "coming up:" : "Coming up:") : casual ? "tmrw morning:" : "Tomorrow morning:");
    second.push(...lines(s.dueNext, 3, register));
  }
  if (s.events.length > 0) {
    const ev = s.events.slice(0, 4).map((e) => `${e.label} ${e.when}`);
    second.push(`${casual ? "today:" : "Today:"} ${ev.join(", ")}${s.events.length > 4 ? ", …" : ""}`);
  }
  for (const e of s.exams) second.push(examLine(e, register));
  if (s.changes.length > 0) {
    second.push(casual ? "changes:" : "Changes:");
    for (const c of s.changes.slice(0, 3)) second.push(`• ${c.text}`);
  }
  if (s.emails.length > 0) {
    second.push(casual ? "emails worth a look:" : "Emails worth a look:");
    for (const e of s.emails) second.push(`• ${e.from}: ${e.subject}`);
  }
  if (s.suggestion) {
    second.push(
      casual
        ? `you're free ${s.suggestion.gap}, good window for ${s.suggestion.itemLabel}`
        : `You are free ${s.suggestion.gap}, a good window for ${s.suggestion.itemLabel}.`,
    );
  }
  if (o.canvasHint) {
    second.push(casual ? "btw I can track your Canvas deadlines too if you connect it" : "I can also track your Canvas deadlines if you connect Canvas.");
  }
  if (s.proposal) {
    const st = s.proposal.statement.replace(/[.?!\s]+$/, "");
    second.push(casual ? `also, want me to remember this: "${st}"?` : `Also, should I remember this: "${st}"?`);
  }

  const out = [first.join("\n"), second.join("\n")].map((b) => stripUrls(b, "")).filter((b) => b.trim().length > 0);
  return out.slice(0, 2);
}
