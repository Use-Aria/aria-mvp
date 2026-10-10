/**
 * Display-safety helpers for untrusted third-party text and links (web plan §2.5, §2.6).
 * Pure and client-safe. Canvas titles, course names, email subjects, and calendar titles
 * are untrusted: React escapes them, `cleanText` strips spoofing characters, and links
 * are rendered only when `safeExternalUrl` accepts them.
 */

const MAX_URL_LENGTH = 2048;

/**
 * Whether `host` matches an allow-list entry. `*.domain` matches any subdomain of
 * `domain` (not `domain` itself); other entries match exactly. Case-insensitive.
 */
function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowHosts.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!e) return false;
    if (e.startsWith("*.")) {
      const base = e.slice(2);
      return base.length > 0 && h.endsWith(`.${base}`);
    }
    return h === e;
  });
}

/**
 * Returns a link target only if it is safe to render as `<a href>`.
 * Rules: `https:` only, no userinfo, no explicit port, at most 2048 characters, and the
 * host must match `allowHosts` (exact host, or `*.domain` for subdomains).
 * @param raw URL from untrusted data (Canvas, Google)
 * @param allowHosts allowed hosts, e.g. `["*.instructure.com", "calendar.google.com"]`
 * @returns the normalized href, or null when the URL must be shown as plain text
 */
export function safeExternalUrl(
  raw: string | null | undefined,
  allowHosts: readonly string[],
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  if (!url.hostname || !hostAllowed(url.hostname, allowHosts)) return null;
  return url.href.length > MAX_URL_LENGTH ? null : url.href;
}

/**
 * Bidi overrides/isolates (U+202A–202E, U+2066–2069), bidi marks (U+200E/F, U+061C),
 * zero-width characters (U+200B–200D, U+2060, U+FEFF), and C0/C1 controls except tab
 * and newline. Built at runtime so the source stays ASCII.
 */
const STRIP_RE = new RegExp(
  "[\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C\\u200B-\\u200D\\u2060\\uFEFF\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]",
  "g",
);

/**
 * Cleans an untrusted display string: strips RTL-spoofing and invisible characters,
 * trims, and truncates to `max` characters (code points) with an ellipsis.
 * React still escapes the result; this only removes characters that mislead readers.
 * @param s untrusted text
 * @param max maximum length in code points (default 500)
 * @returns cleaned text
 */
export function cleanText(s: string, max = 500): string {
  const cleaned = s.replace(STRIP_RE, "").trim();
  const chars = Array.from(cleaned);
  if (chars.length <= max) return cleaned;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/**
 * Gmail web link that finds a message by its RFC 822 Message-ID (works for any account
 * the browser is signed in to, without exposing Gmail's internal ids).
 * @param rfc822MessageId e.g. `<CAF=abc@mail.gmail.com>`
 * @returns `https://mail.google.com/mail/#search/rfc822msgid%3A…`
 */
export function gmailPermalink(rfc822MessageId: string): string {
  return `https://mail.google.com/mail/#search/rfc822msgid%3A${encodeURIComponent(
    rfc822MessageId.trim(),
  )}`;
}
