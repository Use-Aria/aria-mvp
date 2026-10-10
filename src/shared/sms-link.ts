/**
 * `sms:` deep links that open Messages with a pre-filled body (spec §3.1).
 * Pure module, shared by server and client, unit-tested.
 *
 * iOS/macOS use `sms:<num>&body=`, Android uses `sms:<num>?body=`. Bodies are
 * encoded with encodeURIComponent (`%20`, never `+`).
 */

export type Platform = "apple" | "android" | "desktop";

/** Rough platform sniff from a user agent string. */
export function detectPlatform(userAgent: string): Platform {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod|macintosh|mac os x/i.test(userAgent)) {
    // Desktop Macs can text via Messages too, so they count as "apple".
    return "apple";
  }
  return "desktop";
}

export function smsLink(numberE164: string, body: string, platform: Platform): string {
  const sep = platform === "android" ? "?" : "&";
  return `sms:${numberE164}${sep}body=${encodeURIComponent(body)}`;
}

/** "+12035550142" → "(203) 555-0142"; other countries returned unchanged. */
export function formatNumber(numberE164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(numberE164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : numberE164;
}
