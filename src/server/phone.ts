import "server-only";
/**
 * Phone helpers. Pure module, unit-tested.
 *
 * Minimal E.164 normalization for the private test (US default). Swap for
 * libphonenumber-js when the beta opens internationally (spec §3.1).
 */

/**
 * Normalize user input to E.164, or null if it isn't a plausible number.
 * "(203) 555-0142" → "+12035550142"; "+44 20 7946 0958" → "+442079460958".
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    // NANP numbers must be +1 followed by exactly 10 digits.
    if (digits.startsWith("1")) return digits.length === 11 ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Normalize a messaging handle from a provider webhook: phones to E.164,
 * Apple ID emails lowercased. Returns null for anything else.
 */
export function normalizeHandle(raw: string): { handle: string; kind: "phone" | "email" } | null {
  const value = raw.trim();
  if (value.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ? { handle: value.toLowerCase(), kind: "email" }
      : null;
  }
  const phone = toE164(value);
  return phone ? { handle: phone, kind: "phone" } : null;
}

/** Last 4 digits only — for logs (never log full handles; spec §3.22). */
export function maskHandle(handle: string): string {
  return handle.includes("@") ? `***@${handle.split("@")[1]}` : `***${handle.slice(-4)}`;
}
