/**
 * Canvas sync bookkeeping (task 3.4; V2-05 §2.4, §2.5, §2.7, §2.9): the pure parts of
 * sync/store/connect that decide what gets written — feed-hash skip, cap-saturated kinds, course-set
 * change, prepare (lex + parse + Canvas proof), the failure patch over a whole streak (backoff →
 * revoke / 48h notice), the keyed URL fingerprint, and the connect / status error mappings.
 * No DB, no network.
 */
import { randomBytes } from "node:crypto";
import {
  connectErrorForSync,
  connectErrorForUrl,
  connectedConfirmation,
} from "@/server/integrations/canvas/connect";
import type { FeedFetchOk } from "@/server/integrations/canvas/fetch-feed";
import { decideAfterFailure } from "@/server/integrations/canvas/schedule";
import { failurePatch, feedUrlFingerprint, type CanvasIntegration } from "@/server/integrations/canvas/store";
import {
  capSaturatedKindsOf,
  courseSetChanged,
  emptyApplyResult,
  feedHashOf,
  prepareFeed,
  shouldSkipUnchanged,
  withEnvLimits,
} from "@/server/integrations/canvas/sync";
import { normalizeCanvasFeedUrl, type CanvasFeedUrl } from "@/shared/canvas-url";
import { fixtureBytes, generatedFeed } from "./fixtures";

const ID = "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k";
const MIN = 60_000;
const HOUR = 60 * MIN;

function feedUrl(href: string): CanvasFeedUrl {
  const r = normalizeCanvasFeedUrl(href);
  if (!r.ok) throw new Error(r.error);
  return r.url;
}
const YALE = feedUrl(`https://yale.instructure.com/feeds/calendars/user_${ID}.ics`);
const UNLISTED = feedUrl(`https://canvas.example-college.edu/feeds/calendars/user_${ID}.ics`);

function fetched(body: Uint8Array, url: CanvasFeedUrl = YALE, canvasMeta = true): FeedFetchOk {
  return { ok: true, body, finalUrl: url, contentType: "text/calendar", canvasMeta };
}

describe("feed hash + unchanged skip", () => {
  const body = fixtureBytes("basic.ics");

  it("hash depends on body and timezone", () => {
    const a = feedHashOf(body, "America/New_York");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(feedHashOf(body, "America/New_York")).toBe(a);
    expect(feedHashOf(body, "America/Chicago")).not.toBe(a);
    expect(feedHashOf(fixtureBytes("empty.ics"), "America/New_York")).not.toBe(a);
  });

  it("skips only a non-initial sync with the same hash and no deferred removals", () => {
    const h = feedHashOf(body, "UTC");
    expect(shouldSkipUnchanged({ initial: false, feedHash: h, previousHash: h, lastError: null })).toBe(true);
    expect(shouldSkipUnchanged({ initial: true, feedHash: h, previousHash: h, lastError: null })).toBe(false);
    expect(shouldSkipUnchanged({ initial: false, feedHash: h, previousHash: null, lastError: null })).toBe(false);
    expect(shouldSkipUnchanged({ initial: false, feedHash: h, previousHash: "x", lastError: null })).toBe(false);
    // the guard deferred removals last time: re-check even though the body is the same
    expect(shouldSkipUnchanged({ initial: false, feedHash: h, previousHash: h, lastError: "removal_deferred" })).toBe(false);
    // an old fetch error doesn't block the skip
    expect(shouldSkipUnchanged({ initial: false, feedHash: h, previousHash: h, lastError: "timeout" })).toBe(true);
  });

  it("emptyApplyResult is a zero, non-initial result", () => {
    expect(emptyApplyResult()).toMatchObject({ created: 0, removed: 0, batch: { initial: false, changes: [] } });
  });
});

describe("cap saturation + course set", () => {
  const w = { duplicateUids: 0, skippedNoStart: 0, skippedNoUid: 0 };

  it("maps saturated families to timeline kinds", () => {
    expect(capSaturatedKindsOf({ ...w, capSaturated: { assignments: false, events: false } })).toEqual([]);
    expect(capSaturatedKindsOf({ ...w, capSaturated: { assignments: true, events: false } })).toEqual(["assignment", "exam"]);
    expect(capSaturatedKindsOf({ ...w, capSaturated: { assignments: true, events: true } })).toEqual(["assignment", "exam", "event"]);
  });

  it("a 1,000-item feed reports assignment saturation through prepareFeed", () => {
    const r = prepareFeed(fetched(generatedFeed(1000)), "America/New_York");
    if (!r.ok) throw new Error(r.code);
    expect(capSaturatedKindsOf(r.feed.parsed.warnings)).toEqual(["assignment", "exam"]);
  });

  it("compares courses by courseKey, not by label", () => {
    expect(courseSetChanged(["CPSC 323 01 (FA26)", "ENGL 120"], ["CPSC 323", "ENGL 120"])).toBe(false);
    expect(courseSetChanged(["CPSC 323"], ["CPSC 323", "MATH 225"])).toBe(true);
    expect(courseSetChanged(["CPSC 323", "MATH 225"], ["CPSC 323"])).toBe(true);
    expect(courseSetChanged([], [])).toBe(false);
  });
});

describe("prepareFeed", () => {
  it("parses a Canvas feed: date-only due → 23:59 local, course from the bracket", () => {
    const r = prepareFeed(fetched(fixtureBytes("basic.ics")), "America/New_York");
    if (!r.ok) throw new Error(r.code);
    expect(r.feed.url).toBe(YALE);
    expect(r.feed.timezone).toBe("America/New_York");
    expect(r.feed.feedHash).toBe(feedHashOf(fixtureBytes("basic.ics"), "America/New_York"));
    const essay = r.feed.parsed.items.find((i) => i.title.startsWith("Essay 2"));
    expect(essay).toMatchObject({ course: "ENGL 120", allDay: true, timingKey: "D:20261015" });
    expect(essay?.dueAt?.toISOString()).toBe("2026-10-16T03:59:00.000Z");
  });

  it("an HTML body is parse_error (never reaches the timeline)", () => {
    expect(prepareFeed(fetched(fixtureBytes("unauthorized-feed.html")), "UTC")).toEqual({ ok: false, code: "parse_error" });
  });

  it("an unlisted host needs x-canvas-meta AND a Canvas-shaped body", () => {
    const body = fixtureBytes("basic.ics");
    expect(prepareFeed(fetched(body, UNLISTED, false), "UTC")).toEqual({ ok: false, code: "not_canvas" });
    const plain = new TextEncoder().encode(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Evil//EN\r\nBEGIN:VEVENT\r\nUID:x1\r\nDTSTART:20261016T210000Z\r\nSUMMARY:hi\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    );
    expect(prepareFeed(fetched(plain, UNLISTED, true), "UTC")).toEqual({ ok: false, code: "not_canvas" });
    expect(prepareFeed(fetched(body, UNLISTED, true), "UTC").ok).toBe(true);
    // listed / instructure hosts don't need the proof
    expect(prepareFeed(fetched(plain, YALE, false), "UTC").ok).toBe(true);
  });
});

describe("failure streak → integration patch", () => {
  const T0 = new Date("2026-10-10T12:00:00Z");
  type State = Pick<CanvasIntegration, "consecutiveFailures" | "firstFailureAt" | "status"> & { notified: boolean };
  const rand = () => 0.5;

  /** Runs one failed sync through decideAfterFailure + failurePatch, like `failSync` does. */
  function step(s: State, cls: "definitive" | "transient" | "slow_transient", at: Date, code = "feed_not_found") {
    const decision = decideAfterFailure({
      cls,
      consecutiveFailures: s.consecutiveFailures + 1,
      firstFailureAt: s.firstFailureAt,
      now: at,
      alreadyNotified: s.notified,
      rand,
    });
    const patch = failurePatch(s, { code, decision, now: at });
    const next: State = {
      consecutiveFailures: patch.consecutive_failures,
      firstFailureAt: new Date(patch.first_failure_at),
      status: patch.status,
      notified: s.notified || decision.action !== "retry",
    };
    return { decision, patch, next };
  }

  it("3 definitive failures spanning ≥ 2h revoke (but not within 2h)", () => {
    let s: State = { consecutiveFailures: 0, firstFailureAt: null, status: "active", notified: false };
    const a = step(s, "definitive", T0);
    expect(a.decision.action).toBe("retry");
    expect(a.patch).toMatchObject({ consecutive_failures: 1, first_failure_at: T0.toISOString(), status: "active", last_error: "feed_not_found" });
    expect(a.patch.next_sync_at).toBe(new Date(T0.getTime() + 5 * MIN).toISOString());
    s = a.next;
    s = step(s, "definitive", new Date(T0.getTime() + 30 * MIN)).next;
    const early = step(s, "definitive", new Date(T0.getTime() + 90 * MIN));
    expect(early.decision.action).toBe("retry"); // 3 failures but only 90 min
    const late = step(early.next, "definitive", new Date(T0.getTime() + 2 * HOUR));
    expect(late.decision.action).toBe("revoke");
    expect(late.patch).toMatchObject({ status: "revoked", next_sync_at: null, status_reason: "feed_not_found", consecutive_failures: 4 });
    expect(late.patch.first_failure_at).toBe(T0.toISOString()); // streak start kept
  });

  it("a 400 without public_feed (slow_transient) never revokes; 48h → one error notice, then 6h retries", () => {
    let s: State = { consecutiveFailures: 0, firstFailureAt: null, status: "active", notified: false };
    for (let h = 0; h < 48; h += 6) {
      const r = step(s, "slow_transient", new Date(T0.getTime() + h * HOUR), "feed_not_found");
      expect(r.decision.action).toBe("retry");
      s = r.next;
    }
    const notice = step(s, "slow_transient", new Date(T0.getTime() + 48 * HOUR));
    expect(notice.decision.action).toBe("error_notify");
    expect(notice.patch).toMatchObject({ status: "error", status_reason: "feed_not_found" });
    expect(notice.patch.next_sync_at).toBe(new Date(T0.getTime() + 54 * HOUR).toISOString());
    const after = step(notice.next, "transient", new Date(T0.getTime() + 54 * HOUR), "timeout");
    expect(after.decision).toEqual({ action: "retry", at: new Date(T0.getTime() + 60 * HOUR) });
    expect(after.patch.status).toBe("error"); // stays in error until a success
  });

  it("transient backoff grows 5m → 15m → 45m → 2h → 6h", () => {
    let s: State = { consecutiveFailures: 0, firstFailureAt: null, status: "active", notified: false };
    const delays: number[] = [];
    let at = T0;
    for (let i = 0; i < 6; i++) {
      const r = step(s, "transient", at, "timeout");
      if (r.decision.action !== "retry") throw new Error(r.decision.action);
      delays.push((r.decision.at.getTime() - at.getTime()) / MIN);
      at = r.decision.at;
      s = r.next;
    }
    expect(delays).toEqual([5, 15, 45, 120, 360, 360]);
  });
});

describe("feed URL fingerprint", () => {
  it("is keyed, stable, and per-URL", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const fp = feedUrlFingerprint(YALE.href, k1);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(feedUrlFingerprint(YALE.href, k1)).toBe(fp);
    expect(feedUrlFingerprint(YALE.href, k2)).not.toBe(fp);
    expect(feedUrlFingerprint(UNLISTED.href, k1)).not.toBe(fp);
    expect(fp).not.toContain(ID.toLowerCase().slice(0, 8));
  });
});

describe("connect error mappings", () => {
  it("URL errors", () => {
    expect(connectErrorForUrl("empty")).toBe("not_a_url");
    expect(connectErrorForUrl("bad_scheme")).toBe("not_a_url");
    expect(connectErrorForUrl("ip_literal")).toBe("private_address");
    expect(connectErrorForUrl("course_feed")).toBe("course_feed");
    expect(connectErrorForUrl("has_query")).toBe("not_ical");
    expect(connectErrorForUrl("not_feed_path")).toBe("not_ical");
  });

  it("fetch / sync errors", () => {
    expect(connectErrorForSync("feed_not_found")).toBe("feed_not_found");
    expect(connectErrorForSync("not_calendar")).toBe("not_ical");
    expect(connectErrorForSync("parse_error")).toBe("not_ical");
    expect(connectErrorForSync("non_public_address")).toBe("private_address");
    expect(connectErrorForSync("redirect_rejected")).toBe("not_canvas");
    expect(connectErrorForSync("dns_failed")).toBe("unreachable");
    expect(connectErrorForSync("forbidden")).toBe("forbidden");
    expect(connectErrorForSync("removal_deferred")).toBeNull();
    expect(connectErrorForSync(null)).toBeNull();
    expect(connectErrorForSync("something_new")).toBe("internal");
  });

  it("confirmation copy", () => {
    expect(connectedConfirmation("found 2 deadlines across 1 course", 2)).toBe("canvas connected: found 2 deadlines across 1 course");
    expect(connectedConfirmation("connected, but I don't see upcoming deadlines yet.", 0)).toBe(
      "canvas connected, but I don't see upcoming deadlines yet.",
    );
  });
});

describe("env body cap", () => {
  const prev = process.env.CANVAS_FEED_MAX_BYTES;
  afterEach(() => {
    if (prev === undefined) delete process.env.CANVAS_FEED_MAX_BYTES;
    else process.env.CANVAS_FEED_MAX_BYTES = prev;
  });

  it("applies CANVAS_FEED_MAX_BYTES (never above 10 MiB) unless the caller set one", () => {
    process.env.CANVAS_FEED_MAX_BYTES = "1024";
    expect(withEnvLimits({}).maxBytes).toBe(1024);
    expect(withEnvLimits({ maxBytes: 5 }).maxBytes).toBe(5);
    process.env.CANVAS_FEED_MAX_BYTES = String(50 * 1024 * 1024);
    expect(withEnvLimits({}).maxBytes).toBe(10 * 1024 * 1024);
    delete process.env.CANVAS_FEED_MAX_BYTES;
    expect(withEnvLimits({}).maxBytes).toBeUndefined();
  });
});
