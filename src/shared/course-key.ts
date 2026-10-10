/**
 * Course-key normalization shared by Canvas (V2-05), syllabus (V2-08), briefing and Google.
 * Pure. Mirrored by `services/parser/app/normalize.py::course_key`; both sides must pass
 * `tests/fixtures/contract/course_key_vectors.json`.
 *
 * Rules (V2-08 §7.2):
 *  1. null / empty / whitespace → `null` (the V1 "empty matches everything" bug).
 *  2. A course code (subject 2–5 letters, `&` allowed, then a 2–4 digit number with an
 *     optional letter suffix) → `SUBJECT+NUMBER`, uppercase, no separator:
 *     `"CPSC 223 01 (FA26)"` → `"CPSC223"`, `"[s&ds 230]"` → `"S&DS230"`.
 *     The first code wins (`"CPSC 223/523"` → `"CPSC223"`). A code is only searched after
 *     the start when it is preceded by a space or bracket and its subject is not a
 *     term/structure word (FALL, UNIT, PSET, …).
 *  3. Otherwise a title slug: `"Data Structures"` → `"t:data-structures"` (parenthesized
 *     and bracketed asides dropped when something else remains; ASCII-folded; ≤ 60 chars).
 *  4. Already-normalized keys map to themselves (idempotent).
 */

const SUBJECT_STOPWORDS = new Set([
  "FALL", "SPRING", "SUMMER", "WINTER", "TERM", "YEAR", "WEEK", "DAY", "UNIT", "PART",
  "EXAM", "QUIZ", "TEST", "PSET", "SET", "HW", "LAB", "SEC", "SECT", "LEC", "CLASS",
  "ROOM", "RM", "CH", "CHAP", "PAGE", "PP", "FA", "SP", "SU", "WI", "AT", "BY", "OF",
  "IN", "ON", "TO", "AND", "THE", "FOR",
]);

/** Code at the very start (after optional opening brackets). */
const CODE_AT_START = /^[\[(\s]*([A-Z&]{2,5})\s*[-_.]?\s*(\d{2,4}[A-Z]?)(?![A-Z0-9])/;
/** Code later in the text, preceded by whitespace or a bracket. */
const CODE_ANYWHERE = /[\s\[(]([A-Z&]{2,5})\s*[-_.]?\s*(\d{2,4}[A-Z]?)(?![A-Z0-9])/g;
const NORMALIZED_TITLE = /^t:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 60;

function validSubject(subject: string): boolean {
  return /[A-Z]/.test(subject) && !SUBJECT_STOPWORDS.has(subject);
}

function findCode(upper: string): string | null {
  const start = CODE_AT_START.exec(upper);
  if (start && validSubject(start[1])) return start[1] + start[2];
  CODE_ANYWHERE.lastIndex = 0;
  for (let m = CODE_ANYWHERE.exec(upper); m; m = CODE_ANYWHERE.exec(upper)) {
    if (validSubject(m[1])) return m[1] + m[2];
  }
  return null;
}

function slugify(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ");
  let slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > MAX_SLUG) slug = slug.slice(0, MAX_SLUG).replace(/-+$/g, "");
  return slug;
}

/**
 * Normalizes free course text (Canvas bracket code, syllabus course line, user query)
 * to a stable key.
 * @param input raw course text, e.g. "CPSC 223 01 (FA26)" or "Data Structures"
 * @returns "CPSC223", "t:data-structures", or null when nothing usable remains
 */
export function courseKey(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const text = input.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  if (NORMALIZED_TITLE.test(text)) return text;

  const code = findCode(text.toUpperCase());
  if (code) return code;

  const withoutAsides = text.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  const slug = slugify(withoutAsides) || slugify(text);
  return slug ? `t:${slug}` : null;
}

/**
 * Whether two course texts refer to the same course (compares `courseKey`s).
 * @param a course text or key (null → false)
 * @param b course text or key (null → false)
 * @returns true only when both normalize to the same non-null key
 */
export function sameCourse(a: string | null, b: string | null): boolean {
  const ka = courseKey(a);
  const kb = courseKey(b);
  return ka !== null && ka === kb;
}
