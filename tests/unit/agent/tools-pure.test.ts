/**
 * Task 3.3 pure helpers: pause ends (DST), timezone canonicalization, link specs, confirm error
 * copy, and the pending-action read model.
 */
import { toPendingView, WEB_REVISABLE_FIELDS } from "@/server/agent/pending/actions";
import { confirmErrorMessage } from "@/server/agent/tools/confirm-action";
import { PAUSE_FOREVER, pauseEnd } from "@/server/agent/tools/pause";
import { linkSpecFor } from "@/server/agent/tools/send-link";
import { canonicalTimeZone, cleanName } from "@/server/agent/tools/update-profile";
import type { Tables } from "@/server/db";

const NY = "America/New_York";

describe("pauseEnd", () => {
  const now = new Date("2026-10-12T16:00:00Z"); // Mon 12:00 EDT

  it("1h, tonight, tomorrow morning, resume, indefinitely", () => {
    expect(pauseEnd("1h", now, NY)).toEqual(new Date("2026-10-12T17:00:00Z"));
    expect(pauseEnd("tonight", now, NY)).toEqual(new Date("2026-10-13T03:59:00Z"));
    expect(pauseEnd("tomorrow_morning", now, NY)).toEqual(new Date("2026-10-13T12:00:00Z"));
    expect(pauseEnd("resume", now, NY)).toBeNull();
    expect(pauseEnd("indefinitely", now, NY)).toEqual(PAUSE_FOREVER);
  });

  it("tonight after 23:59 local falls back to +1h", () => {
    const late = new Date("2026-10-13T03:59:30Z"); // 23:59:30 EDT
    expect(pauseEnd("tonight", late, NY)).toEqual(new Date(late.getTime() + 3_600_000));
  });

  it("is DST-safe: tomorrow 8am across fall-back, 1 week keeps wall-clock time", () => {
    const sat = new Date("2026-10-31T16:00:00Z"); // Sat Oct 31 12:00 EDT; DST ends Sun Nov 1
    expect(pauseEnd("tomorrow_morning", sat, NY)).toEqual(new Date("2026-11-01T13:00:00Z")); // 08:00 EST
    expect(pauseEnd("1_week", sat, NY)).toEqual(new Date("2026-11-07T17:00:00Z")); // Sat 12:00 EST
  });
});

describe("update_profile helpers", () => {
  it("canonicalTimeZone accepts IANA ids (any case), rejects abbreviations and junk", () => {
    expect(canonicalTimeZone("America/Chicago")).toBe("America/Chicago");
    expect(canonicalTimeZone("america/chicago")).toBe("America/Chicago");
    expect(canonicalTimeZone(" Europe/London ")).toBe("Europe/London");
    expect(canonicalTimeZone("America/Argentina/Buenos_Aires")).toMatch(/Buenos_Aires$/); // ICU may canonicalize the alias
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("EST")).toBeNull();
    expect(canonicalTimeZone("PST")).toBeNull();
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
    expect(canonicalTimeZone("</aria_now>")).toBeNull();
  });

  it("cleanName strips control chars and angle brackets", () => {
    expect(cleanName("  Dan\n\tLee ")).toBe("Dan Lee");
    expect(cleanName("<aria_now>")).toBe("aria_now");
    expect(cleanName("   ")).toBeNull();
  });
});

describe("send_link kinds (master plan §1.4 #2)", () => {
  it("maps kinds to purposes, targets and preview kinds", () => {
    expect(linkSpecFor("week")).toEqual({ purpose: "view", target: "/week", preview: "week" });
    expect(linkSpecFor("setup")).toEqual({ purpose: "setup", target: "/setup", preview: "setup" });
    expect(linkSpecFor("connect_canvas")).toEqual({ purpose: "setup", target: "/setup", preview: "setup" });
    expect(linkSpecFor("settings")).toEqual({ purpose: "setup", target: "/settings", preview: "settings" });
    expect(linkSpecFor("connect_google")).toEqual({ purpose: "connect_google", target: "/setup", preview: "setup" });
  });
});

describe("confirm_action error copy", () => {
  it("same_run tells the model to wait for the next message", () => {
    expect(confirmErrorMessage("same_run")).toMatch(/next message/);
    expect(confirmErrorMessage("google_disconnected")).toMatch(/connect_google/);
  });
});

describe("pending-action view", () => {
  const row: Tables<"pending_actions"> = {
    id: "66666666-6666-4666-8666-666666666666",
    user_id: "00000000-0000-4000-8000-000000000001",
    kind: "send_email",
    payload: { v: 1 },
    preview_message_id: null,
    status: "pending",
    created_at: "2026-10-12T15:00:00Z",
    expires_at: "2026-10-13T15:00:00Z",
    run_id: null,
    summary: "draft to prof",
    version: 2,
    updated_at: "2026-10-12T15:00:00Z",
    decided_at: null,
    decided_via: null,
    executed_at: null,
    result: { sent_at: "x", nested: { a: 1 } },
    error: null,
  };

  it("maps fields; a pending row past expiry reads as expired; expiry decisions read as null via", () => {
    const v = toPendingView(row, new Date("2026-10-12T16:00:00Z"));
    expect(v).toMatchObject({ status: "pending", version: 2, summary: "draft to prof", decidedVia: null, result: { sent_at: "x", nested: { a: 1 } } });
    expect(toPendingView(row, new Date("2026-10-14T00:00:00Z")).status).toBe("expired");
    expect(toPendingView({ ...row, status: "expired", decided_via: "expiry" }).decidedVia).toBeNull();
    expect(toPendingView({ ...row, status: "done", decided_via: "web", result: null })).toMatchObject({ status: "done", decidedVia: "web", result: null });
  });

  it("the web may edit only subject/body of a send_email draft and nothing of delete_account", () => {
    expect(WEB_REVISABLE_FIELDS.send_email).toEqual(["subject", "body_text"]);
    expect(WEB_REVISABLE_FIELDS.delete_account).toEqual([]);
  });
});
