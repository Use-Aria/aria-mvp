/** link-policy additions owned by 1.6 (master plan §1.15; web plan §10 link-policy.test). */
import {
  DEFAULT_TARGET,
  LINK_TTL_MS,
  RECENT_SESSION_MS,
  SCOPE_FOR_PURPOSE,
  SETUP_FRESH_MS,
  ogImageFor,
  previewTitle,
  safeTarget,
} from "@/server/security/link-policy";

const MIN = 60_000;

describe("link policy table (§1.15)", () => {
  it("TTLs, scopes, and default targets", () => {
    expect(LINK_TTL_MS).toEqual({
      view: 15 * MIN,
      setup: 30 * MIN,
      connect_google: 20 * MIN,
      email_draft: 60 * MIN,
      digest: 12 * 60 * MIN,
    });
    expect(SCOPE_FOR_PURPOSE).toEqual({
      view: "view",
      setup: "setup",
      connect_google: "setup",
      email_draft: "view",
      digest: "view",
    });
    expect(DEFAULT_TARGET.digest).toBe("/week");
    expect(DEFAULT_TARGET.connect_google).toBe("/setup");
    expect(RECENT_SESSION_MS).toBe(60 * MIN);
    expect(SETUP_FRESH_MS).toBe(15 * MIN);
  });
});

describe("previewTitle", () => {
  it("has a settings title", () => {
    expect(previewTitle("settings", undefined)).toBe("Your Aria settings");
    expect(previewTitle("settings", "4")).toBe("Your Aria settings");
  });

  it("never echoes input", () => {
    expect(previewTitle("<b>hi</b>", "3")).toBe("Open Aria");
    expect(previewTitle(undefined, undefined)).toBe("Open Aria");
  });
});

describe("ogImageFor", () => {
  it("maps every kind", () => {
    expect(ogImageFor("landing")).toBe("/og/landing.jpg");
    expect(ogImageFor("week")).toBe("/og/week.jpg");
    expect(ogImageFor("setup")).toBe("/og/setup.jpg");
    expect(ogImageFor("email")).toBe("/og/email.jpg");
    expect(ogImageFor("settings")).toBe("/og/settings.jpg");
    expect(ogImageFor("default")).toBe("/og/default.jpg");
  });

  it("falls back to default for unknown or prototype keys", () => {
    for (const k of [undefined, "", "admin", "toString", "__proto__", "../week"]) {
      expect(ogImageFor(k)).toBe("/og/default.jpg");
    }
  });
});

describe("safeTarget", () => {
  it("rejects traversal and protocol-relative targets", () => {
    for (const bad of ["/email/../settings", "//evil.com", "/\\evil.com", "/settings?next=//evil.com", "/week#x"]) {
      expect(safeTarget(bad, "/week")).toBe("/week");
    }
    expect(safeTarget("/settings", "/week")).toBe("/settings");
  });
});
