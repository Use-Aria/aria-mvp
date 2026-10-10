/** Session freshness and Origin checks (web plan §10 guard.test; §2.3 matrix). */
import { freshUntil, isRecent, originMatches, sessionFailsNeed } from "@/server/web/guard";
import type { WebSession } from "@/server/security/sessions";

const T0 = Date.parse("2026-10-10T12:00:00Z");
const MIN = 60_000;
const SEC = 1_000;

function session(scope: "view" | "setup"): WebSession {
  return { userId: "u1", scope, createdAt: new Date(T0) };
}

describe("isRecent", () => {
  it("is true up to 59:59 and false at 60:00", () => {
    expect(isRecent(session("view"), T0)).toBe(true);
    expect(isRecent(session("view"), T0 + 59 * MIN + 59 * SEC)).toBe(true);
    expect(isRecent(session("view"), T0 + 60 * MIN)).toBe(false);
  });
});

describe("freshUntil", () => {
  it("setup sessions are fresh until +15:00", () => {
    expect(freshUntil(session("setup"), T0 + 14 * MIN + 59 * SEC)?.getTime()).toBe(T0 + 15 * MIN);
    expect(freshUntil(session("setup"), T0 + 15 * MIN)).toBeNull();
  });

  it("view sessions are never fresh", () => {
    expect(freshUntil(session("view"), T0)).toBeNull();
  });
});

describe("sessionFailsNeed (§2.3 matrix)", () => {
  it("any: always allowed", () => {
    expect(sessionFailsNeed(session("view"), "any", T0 + 13 * 24 * 60 * MIN)).toBeNull();
  });

  it("recent: < 60 min, any scope", () => {
    expect(sessionFailsNeed(session("view"), "recent", T0 + 30 * MIN)).toBeNull();
    expect(sessionFailsNeed(session("setup"), "recent", T0 + 60 * MIN)).toBe("needs_recent_link");
  });

  it("fresh_setup: setup scope and < 15 min", () => {
    expect(sessionFailsNeed(session("setup"), "fresh_setup", T0 + 14 * MIN + 59 * SEC)).toBeNull();
    expect(sessionFailsNeed(session("setup"), "fresh_setup", T0 + 15 * MIN)).toBe("needs_fresh_link");
    expect(sessionFailsNeed(session("view"), "fresh_setup", T0)).toBe("needs_fresh_link");
  });
});

describe("originMatches", () => {
  const app = "https://aria.vercel.app";

  it("accepts only the exact origin", () => {
    expect(originMatches("https://aria.vercel.app", app)).toBe(true);
    expect(originMatches("https://aria.vercel.app", "https://aria.vercel.app/")).toBe(true);
  });

  it("rejects missing, null, scheme, host, port, and path mismatches", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "null",
      "http://aria.vercel.app",
      "https://aria.vercel.app:8443",
      "https://evil.vercel.app",
      "https://aria.vercel.app.evil.com",
      "https://aria.vercel.app/path",
      "garbage",
    ]) {
      expect(originMatches(bad, app)).toBe(false);
    }
    expect(originMatches("http://localhost:3000", "http://localhost:3100")).toBe(false);
    expect(originMatches("http://localhost:3000", "http://localhost:3000")).toBe(true);
  });
});
