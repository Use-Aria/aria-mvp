import "server-only";

/**
 * The ONE untrusted-content wrapper (master plan §1.8, V2-04 §2.8(4)).
 *
 * All third-party text (email, Canvas titles/descriptions, external calendar titles,
 * syllabus content, web) goes through `wrapUntrusted` before it reaches any LLM prompt:
 *
 *   <untrusted source="email" id="e_1a2b3c4d">
 *   subject: …
 *   </untrusted>
 *
 * Inside, our reserved tags (`untrusted`, `aria_*`, `new_messages`, `example`) are
 * neutralized by swapping the opening bracket for `‹`, so content can't close the block
 * or forge context. Lookalike brackets/slashes (fullwidth, math, HTML entities), case,
 * whitespace and invisible characters inside the tag are all covered. Control and
 * invisible/bidi characters are stripped and each field is length-capped.
 * User-authored text in `<new_messages>` goes through `neutralizeTags` the same way.
 *
 * Pure; imports nothing outside `src/shared`.
 */

/** Where a piece of untrusted text came from. */
export type UntrustedSource = "email" | "canvas" | "calendar" | "syllabus" | "web";

const SOURCES: readonly UntrustedSource[] = ["email", "canvas", "calendar", "syllabus", "web"];
const DEFAULT_MAX_CHARS = 2000;
const MIN_MAX_CHARS = 16;
const MAX_MAX_CHARS = 100_000;
const MAX_ID = 64;
const MAX_KEY = 40;

/** Zero-width, soft hyphen, word joiners, BOM. */
const INVISIBLE = "\\u00AD\\u180E\\u200B-\\u200F\\u2060-\\u2064\\uFEFF";
/** Bidi embeddings / overrides / isolates. */
const BIDI = "\\u202A-\\u202E\\u2066-\\u2069";
/** C0 (except \t \n) and C1 controls. */
const CONTROL = "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F";

/** Filler a model might skip over between `<`, `/` and the tag name. */
const GAP = `[\\s${INVISIBLE}${BIDI}\\u0000-\\u001F\\u007F-\\u009F]*`;
/** `<` and lookalikes (fullwidth, small, angle brackets, modifier arrowhead, HTML entities). */
const OPEN = "(<|\\uFF1C|\\uFE64|\\u2329|\\u3008|\\u27E8|\\u02C2|&lt;?|&#0*60;?|&#x0*3c;?)";
/** `/` and `\` and lookalikes. */
const SLASH = "(?:/|\\\\|\\uFF0F|\\u2215|\\u2044|\\u29F8|&sol;|&#0*47;|&#x0*2f;)";
const RESERVED = ["untrusted", "aria_", "new_messages", "example"];

/** Matches a reserved name letter by letter, tolerating fullwidth letters and invisibles. */
function namePattern(name: string): string {
  return name
    .split("")
    .map((c) => {
      if (c === "_") return "[_\\uFF3F]";
      const lo = c.toLowerCase();
      const up = c.toUpperCase();
      const fw = (ch: string) => `\\u${(ch.charCodeAt(0) - 0x21 + 0xff01).toString(16).toUpperCase()}`;
      return `[${lo}${up}${fw(lo)}${fw(up)}]`;
    })
    .join(`[${INVISIBLE}${BIDI}]*`);
}

const TAG_RE = new RegExp(
  `${OPEN}(${GAP}(?:${SLASH}${GAP})?(?:${RESERVED.map(namePattern).join("|")}))`,
  "gi",
);
const STRIP_RE = new RegExp(`[${CONTROL}${INVISIBLE}${BIDI}]`, "g");

/**
 * Neutralizes reserved-tag look-alikes (`<untrusted>`, `</untrusted>`, `<aria_now>`,
 * `<new_messages>`, `<example>`, in any case/spacing/lookalike form) by replacing the
 * opening bracket with `‹`. Everything else is left untouched.
 * @param text any text (third-party or user-authored)
 * @returns the text with reserved tags defanged
 */
export function neutralizeTags(text: string): string {
  return text.replace(TAG_RE, "‹$2");
}

/** Strips control/invisible/bidi chars, normalizes newlines, neutralizes tags, caps length. */
function clean(text: string, maxChars: number): string {
  const out = neutralizeTags(
    text
      .replace(/\r\n?/g, "\n")
      .replace(/[\u2028\u2029]/g, "\n")
      .replace(STRIP_RE, ""),
  ).trim();
  if (out.length <= maxChars) return out;
  let cut = maxChars;
  const code = out.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't split a surrogate pair
  return `${out.slice(0, cut)}… [truncated ${out.length - cut} chars]`;
}

function cleanId(id: string): string {
  return id.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, MAX_ID);
}

function cleanKey(key: string): string {
  const k = key.replace(/[^A-Za-z0-9_ -]/g, "_").trim().slice(0, MAX_KEY);
  return k === "" ? "field" : k;
}

/**
 * Wraps third-party content as inert data for an LLM prompt.
 * @param a.source where the text came from (`email` | `canvas` | `calendar` | `syllabus` | `web`)
 * @param a.id optional model-facing alias (e.g. "e_1a2b3c4d"); sanitized to `[A-Za-z0-9_:.-]`, ≤ 64 chars
 * @param a.body a string, or named fields rendered as `key: value` lines in insertion order
 *   (continuation lines indented so a value can't forge another field)
 * @param a.maxChars cap per string/field (default 2000); overflow is cut with a "… [truncated N chars]" marker
 * @returns `<untrusted source="…" id="…">\n…\n</untrusted>` with exactly one real open/close tag
 */
export function wrapUntrusted(a: {
  source: UntrustedSource;
  id?: string;
  body: string | Record<string, string>;
  maxChars?: number;
}): string {
  const source: UntrustedSource = SOURCES.includes(a.source) ? a.source : "web";
  const requested = a.maxChars ?? DEFAULT_MAX_CHARS;
  const maxChars = Number.isFinite(requested)
    ? Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(requested)))
    : DEFAULT_MAX_CHARS;
  const id = a.id === undefined ? "" : cleanId(a.id);

  const content =
    typeof a.body === "string"
      ? clean(a.body, maxChars)
      : Object.entries(a.body)
          .map(([key, value]) => {
            const v = clean(String(value ?? ""), maxChars).replace(/\n/g, "\n  ");
            return v === "" ? `${cleanKey(key)}:` : `${cleanKey(key)}: ${v}`;
          })
          .join("\n");

  return `<untrusted source="${source}"${id ? ` id="${id}"` : ""}>\n${content}\n</untrusted>`;
}
