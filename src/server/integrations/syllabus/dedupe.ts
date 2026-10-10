import "server-only";
// OWNER: 3.5

/**
 * Read-time collapse of syllabus items shadowed by Canvas items (V2-08 §2.11). Pure.
 *
 * A syllabus item is dropped when a Canvas item has
 *  - the same `courseKey`,
 *  - a compatible kind (syllabus exam ↔ Canvas exam | assignment | event; assignment ↔ assignment),
 *  - a local date within 1 day (exams) / 2 days (assignments),
 *  - a matching title (same exam keyword + ordinal, or token-set Jaccard ≥ 0.5 after stopwords).
 * Canvas wins (authoritative, updated dates). When the dropped item carries `syllabus` info
 * (weight/topics) it is attached to the Canvas twin (a new object; inputs are never mutated).
 */
import { courseKey } from "@/shared/course-key";
import { compareLocalDate, localDateOf, parseLocalDate, type LocalDate } from "@/shared/time/tz";
import type { TimelineItemView, TimelineLike } from "@/server/timeline/types";

type SyllabusInfo = NonNullable<TimelineItemView["syllabus"]>;

const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "to", "in", "on", "at", "by", "with", "due",
  "assignment", "submission", "submit", "upload", "online", "class", "lecture",
]);

/** Keyword families: synonyms map to one canonical keyword. */
const KEYWORDS: [RegExp, string][] = [
  [/\bmid[- ]?terms?\b/g, " midterm "],
  [/\bprelims?\b/g, " midterm "],
  [/\bfinals?\b(?:\s+exam(?:ination)?)?/g, " final "],
  [/\bquiz(?:zes)?\b/g, " quiz "],
  [/\bproblem\s*sets?\b|\bp\.?\s?sets?\b|\bps\b/g, " pset "],
  [/\bhomeworks?\b|\bhw\b/g, " hw "],
  [/\blabs?\b/g, " lab "],
  [/\bexams?\b|\bexamination\b|\btests?\b/g, " exam "],
  [/\bessays?\b|\bpapers?\b/g, " paper "],
];
const CANON = new Set(["midterm", "final", "quiz", "pset", "hw", "lab", "exam", "paper"]);
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const WORDNUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

function tokens(title: string): string[] {
  let t = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/#/g, " ");
  for (const [re, canon] of KEYWORDS) t = t.replace(re, canon);
  return t
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0);
}

/** Main keyword and ordinal of a title ("Midterm Exam 2" → midterm, 2). Pure. */
function keywordOf(toks: string[]): { kw: string | null; ordinal: number | null } {
  let kw: string | null = null;
  let ordinal: number | null = null;
  for (let i = 0; i < toks.length; i += 1) {
    const w = toks[i];
    if (CANON.has(w)) {
      // the more specific keyword wins ("midterm exam" → midterm)
      if (kw === null || kw === "exam") kw = w;
      const next = toks[i + 1];
      if (ordinal === null && next !== undefined) ordinal = numberOf(next);
    } else if (ordinal === null && kw === null) {
      const n = WORDNUM[w];
      if (n !== undefined && CANON.has(toks[i + 1] ?? "")) ordinal = n;
    }
  }
  return { kw, ordinal };
}

function numberOf(w: string): number | null {
  if (/^\d{1,3}$/.test(w)) return Number(w);
  return ROMAN[w] ?? WORDNUM[w] ?? null;
}

/**
 * Whether two item titles name the same thing: same keyword family with compatible ordinals
 * ("Midterm" ~ "Midterm Exam"; "Quiz 2" ≁ "Quiz 3"), else token-set Jaccard ≥ 0.5 after stopwords.
 * @param a first title
 * @param b second title
 * @returns true on a match
 */
export function titlesMatch(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  const ka = keywordOf(ta);
  const kb = keywordOf(tb);
  if (ka.kw && kb.kw && ka.kw === kb.kw) {
    if (ka.ordinal !== null && kb.ordinal !== null) return ka.ordinal === kb.ordinal;
    return true;
  }
  if (ka.kw && kb.kw && ka.kw !== kb.kw && ka.kw !== "exam" && kb.kw !== "exam") return false;
  const sa = new Set(ta.filter((w) => !STOPWORDS.has(w)));
  const sb = new Set(tb.filter((w) => !STOPWORDS.has(w)));
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return inter / union >= 0.5;
}

function localDay(item: TimelineLike, tz: string): LocalDate | null {
  if (item.allDayDate) {
    const d = parseLocalDate(item.allDayDate);
    if (d) return d;
  }
  const at = item.dueAt ?? item.startsAt;
  return at ? localDateOf(at, tz) : null;
}

function dayDistance(a: LocalDate, b: LocalDate): number {
  const ms = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);
  return Math.abs(ms(a) - ms(b)) / 86_400_000;
}

function kindsCompatible(syllabusKind: TimelineLike["kind"], canvasKind: TimelineLike["kind"]): boolean {
  if (syllabusKind === "exam") return canvasKind === "exam" || canvasKind === "assignment" || canvasKind === "event";
  if (syllabusKind === "assignment") return canvasKind === "assignment";
  return false;
}

function syllabusInfoOf(item: TimelineLike): SyllabusInfo | null {
  const info = (item as TimelineLike & { syllabus?: SyllabusInfo }).syllabus;
  return info && typeof info === "object" ? info : null;
}

/**
 * Read-time collapse: drop syllabus items shadowed by Canvas items and attach `syllabus` info.
 * Each Canvas item absorbs at most one syllabus item (the closest date). Order is preserved.
 * @param items timeline items (any shape with the `TimelineLike` fields)
 * @param timezone user zone (local-date distance)
 * @returns a new array without the shadowed syllabus items
 */
export function collapseSyllabusDuplicates<T extends TimelineLike>(items: readonly T[], timezone: string): T[] {
  const canvas = items
    .map((item, index) => ({ item, index, key: courseKey(item.course), day: localDay(item, timezone) }))
    .filter((c) => c.item.source === "canvas" && c.key !== null && c.day !== null);
  if (canvas.length === 0) return [...items];

  const drop = new Set<number>();
  const attach = new Map<number, SyllabusInfo>();
  const taken = new Set<number>();
  items.forEach((item, index) => {
    if (item.source !== "syllabus") return;
    const key = courseKey(item.course);
    const day = localDay(item, timezone);
    if (!key || !day) return;
    const maxDays = item.kind === "exam" ? 1 : 2;
    let best: { index: number; dist: number } | null = null;
    for (const c of canvas) {
      if (taken.has(c.index) || c.key !== key || !c.day || !kindsCompatible(item.kind, c.item.kind)) continue;
      const dist = dayDistance(day, c.day);
      if (dist > maxDays || !titlesMatch(item.title, c.item.title)) continue;
      if (!best || dist < best.dist || (dist === best.dist && compareLocalDate(c.day, day) === 0)) best = { index: c.index, dist };
    }
    if (!best) return;
    drop.add(index);
    taken.add(best.index);
    const info = syllabusInfoOf(item);
    if (info) attach.set(best.index, info);
  });
  if (drop.size === 0) return [...items];

  const out: T[] = [];
  items.forEach((item, index) => {
    if (drop.has(index)) return;
    const info = attach.get(index);
    out.push(info ? { ...item, syllabus: info } : item);
  });
  return out;
}
