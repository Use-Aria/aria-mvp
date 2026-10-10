/**
 * channels/guards.ts — quiet windows (DST-safe), SMS widening, the §2.6 class matrix, cap,
 * bundling, follow-up quota, lease deferral, expiry, opt-out.
 */
import {
  capDayStart,
  clockMinutes,
  deliveryClass,
  earliestAllowedSend,
  effectiveQuietWindow,
  evaluateDelivery,
  isQuiet,
  isWindowOpen,
  nextQuietEnd,
  outboxRunAt,
  type DeliveryClass,
  type GuardState,
} from "@/server/channels/guards";

const NY = "America/New_York";
const Q = { startMin: 22 * 60, endMin: 8 * 60 }; // 22:00–08:00
const MIN = 60_000;
const H = 60 * MIN;

/** 2026-10-10 is EDT (UTC−4). */
const at = (iso: string) => new Date(iso);
const NOON = at("2026-10-10T16:00:00Z"); // 12:00 EDT
const LATE = at("2026-10-11T03:00:00Z"); // 23:00 EDT
const NEXT_8AM = at("2026-10-11T12:00:00Z"); // 08:00 EDT

function state(over: Partial<GuardState> = {}): GuardState {
  return {
    tz: NY,
    quiet: Q,
    optedOut: false,
    pausedUntil: null,
    routineSentToday: 0,
    lastProactiveAt: null,
    conversationActive: false,
    windowOpen: true,
    followupRecipients24h: 0,
    ...over,
  };
}

const PROACTIVE: DeliveryClass[] = ["routine", "urgent", "requested"];

describe("isQuiet", () => {
  it("window crossing midnight: 21:59 no, 22:00 yes, 07:59 yes, 08:00 no", () => {
    expect(isQuiet(at("2026-10-11T01:59:00Z"), NY, Q)).toBe(false);
    expect(isQuiet(at("2026-10-11T02:00:00Z"), NY, Q)).toBe(true);
    expect(isQuiet(at("2026-10-11T11:59:00Z"), NY, Q)).toBe(true);
    expect(isQuiet(at("2026-10-11T12:00:00Z"), NY, Q)).toBe(false);
  });
  it("non-crossing window", () => {
    const w = { startMin: 13 * 60, endMin: 15 * 60 };
    expect(isQuiet(at("2026-10-10T16:59:00Z"), NY, w)).toBe(false); // 12:59
    expect(isQuiet(at("2026-10-10T17:00:00Z"), NY, w)).toBe(true); // 13:00
    expect(isQuiet(at("2026-10-10T19:00:00Z"), NY, w)).toBe(false); // 15:00
  });
  it("start == end means no quiet hours", () => {
    expect(isQuiet(LATE, NY, { startMin: 0, endMin: 0 })).toBe(false);
  });
  it("uses the user's zone (Kolkata, half-hour offset)", () => {
    // 2026-10-10T16:45Z = 22:15 IST
    expect(isQuiet(at("2026-10-10T16:45:00Z"), "Asia/Kolkata", Q)).toBe(true);
    expect(isQuiet(at("2026-10-10T16:15:00Z"), "Asia/Kolkata", Q)).toBe(false);
  });
});

describe("effectiveQuietWindow", () => {
  it("defaults to 22:00–08:00 and parses Postgres time text", () => {
    expect(effectiveQuietWindow({ quietStart: null, quietEnd: null }, "imessage")).toEqual(Q);
    expect(effectiveQuietWindow({ quietStart: "23:30:00", quietEnd: "07:15:00" }, "imessage")).toEqual({
      startMin: 23 * 60 + 30,
      endMin: 7 * 60 + 15,
    });
    expect(effectiveQuietWindow({ quietStart: "garbage", quietEnd: "25:00" }, "imessage")).toEqual(Q);
  });
  it("SMS/RCS widen to at least 21:00–08:00", () => {
    expect(effectiveQuietWindow({ quietStart: "22:00", quietEnd: "08:00" }, "sms")).toEqual({ startMin: 1260, endMin: 480 });
    expect(effectiveQuietWindow({ quietStart: "23:00", quietEnd: "07:00" }, "rcs")).toEqual({ startMin: 1260, endMin: 480 });
    expect(effectiveQuietWindow({ quietStart: "22:00", quietEnd: "09:00" }, "sms")).toEqual({ startMin: 1260, endMin: 540 });
    expect(effectiveQuietWindow({ quietStart: "20:00", quietEnd: "08:00" }, "sms")).toEqual({ startMin: 1200, endMin: 480 });
  });
  it("SMS with quiet hours disabled still gets the legal minimum", () => {
    expect(effectiveQuietWindow({ quietStart: "00:00", quietEnd: "00:00" }, "sms")).toEqual({ startMin: 1260, endMin: 480 });
  });
  it("a disjoint daytime window is covered by one window that violates neither", () => {
    const w = effectiveQuietWindow({ quietStart: "13:00", quietEnd: "14:00" }, "sms");
    expect(w).toEqual({ startMin: 1260, endMin: 840 }); // 21:00–14:00
  });
  it("clockMinutes falls back on bad input", () => {
    expect(clockMinutes("8:05", "22:00")).toBe(485);
    expect(clockMinutes(undefined, "22:00")).toBe(1320);
  });
});

describe("nextQuietEnd", () => {
  it("23:00 → next morning 08:00 local, plus jitter", () => {
    expect(nextQuietEnd(LATE, NY, Q, 0)).toEqual(NEXT_8AM);
    expect(nextQuietEnd(LATE, NY, Q, 90_000)).toEqual(new Date(NEXT_8AM.getTime() + 90_000));
  });
  it("after midnight → same-day 08:00", () => {
    expect(nextQuietEnd(at("2026-10-11T06:30:00Z"), NY, Q, 0)).toEqual(NEXT_8AM);
  });
  it("returns the input when not quiet", () => {
    expect(nextQuietEnd(NOON, NY, Q, 5000)).toEqual(NOON);
  });
  it("across fall-back (2026-11-01): 08:00 EST = 13:00Z", () => {
    expect(nextQuietEnd(at("2026-11-01T03:00:00Z"), NY, Q, 0)).toEqual(at("2026-11-01T13:00:00Z"));
  });
  it("across spring-forward (2026-03-08): 08:00 EDT = 12:00Z", () => {
    expect(nextQuietEnd(at("2026-03-08T04:00:00Z"), NY, Q, 0)).toEqual(at("2026-03-08T12:00:00Z"));
  });
  it("quiet end inside the spring-forward gap shifts forward (02:30 → 03:30 EDT)", () => {
    const w = { startMin: 22 * 60, endMin: 2 * 60 + 30 };
    // 2026-03-07 23:00 EST = 2026-03-08T04:00Z
    expect(nextQuietEnd(at("2026-03-08T04:00:00Z"), NY, w, 0)).toEqual(at("2026-03-08T07:30:00Z"));
  });
  it("quiet end in the repeated fall-back hour never goes backwards", () => {
    const w = { startMin: 0, endMin: 90 }; // 00:00–01:30
    // 2026-11-01 01:15 EST (second pass) = 06:15Z; 01:30 EDT would be 05:30Z (in the past)
    const t = at("2026-11-01T06:15:00Z");
    const end = nextQuietEnd(t, NY, w, 0);
    expect(end.getTime()).toBeGreaterThan(t.getTime());
    expect(end).toEqual(at("2026-11-01T06:30:00Z"));
  });
});

describe("evaluateDelivery: class matrix (V2-03 §2.6)", () => {
  it("opt-out drops every class, replies included", () => {
    for (const cls of ["reply", ...PROACTIVE] as DeliveryClass[]) {
      expect(evaluateDelivery(state({ optedOut: true }), cls, NOON)).toEqual({ action: "drop", reason: "opted_out" });
    }
  });

  it("reply ignores pause, quiet, cap, bundling, quota and the lease", () => {
    const s = state({
      pausedUntil: at("2026-10-12T00:00:00Z"),
      routineSentToday: 9,
      lastProactiveAt: LATE,
      conversationActive: true,
      windowOpen: false,
      followupRecipients24h: 999,
    });
    expect(evaluateDelivery(s, "reply", LATE)).toEqual({ action: "send" });
  });

  it("all clear → every class sends now", () => {
    for (const cls of PROACTIVE) expect(evaluateDelivery(state(), cls, NOON)).toEqual({ action: "send" });
  });

  it("pause defers every proactive class", () => {
    const until = at("2026-10-10T18:00:00Z");
    for (const cls of PROACTIVE) {
      expect(evaluateDelivery(state({ pausedUntil: until }), cls, NOON)).toEqual({ action: "defer", until, reason: "paused" });
    }
  });
  it("an expired pause doesn't apply", () => {
    expect(evaluateDelivery(state({ pausedUntil: at("2026-10-10T15:00:00Z") }), "routine", NOON)).toEqual({ action: "send" });
  });

  it("quiet hours defer routine and urgent; requested bypasses", () => {
    expect(evaluateDelivery(state(), "routine", LATE)).toEqual({ action: "defer", until: NEXT_8AM, reason: "quiet_hours" });
    expect(evaluateDelivery(state(), "urgent", LATE)).toEqual({ action: "defer", until: NEXT_8AM, reason: "quiet_hours" });
    expect(evaluateDelivery(state(), "requested", LATE)).toEqual({ action: "send" });
  });

  it("requested bypasses quiet but not pause", () => {
    const until = at("2026-10-11T03:30:00Z"); // 23:30 local, still quiet
    expect(evaluateDelivery(state({ pausedUntil: until }), "requested", LATE)).toEqual({ action: "defer", until, reason: "paused" });
    // routine: the pause ends inside quiet hours → quiet end
    expect(evaluateDelivery(state({ pausedUntil: until }), "routine", LATE)).toEqual({
      action: "defer",
      until: NEXT_8AM,
      reason: "quiet_hours",
    });
  });

  it("a pause ending at night lands on quiet end for routine (reason = the bigger push)", () => {
    const until = at("2026-10-11T02:30:00Z"); // 22:30 local: pause pushes 10.5h, quiet 9.5h
    const d = evaluateDelivery(state({ pausedUntil: until }), "routine", NOON);
    expect(d).toEqual({ action: "defer", until: NEXT_8AM, reason: "paused" });
  });

  it("daily cap counts only routine: routine defers to the next local morning; urgent/requested bypass", () => {
    const s = state({ routineSentToday: 3 });
    expect(evaluateDelivery(s, "routine", NOON)).toEqual({ action: "defer", until: NEXT_8AM, reason: "daily_cap" });
    expect(evaluateDelivery(s, "urgent", NOON)).toEqual({ action: "send" });
    expect(evaluateDelivery(s, "requested", NOON)).toEqual({ action: "send" });
    expect(evaluateDelivery(state({ routineSentToday: 2 }), "routine", NOON)).toEqual({ action: "send" });
  });

  it("daily cap with quiet hours disabled → local midnight", () => {
    const d = evaluateDelivery(state({ routineSentToday: 3, quiet: { startMin: 0, endMin: 0 } }), "routine", NOON);
    expect(d).toEqual({ action: "defer", until: at("2026-10-11T04:00:00Z"), reason: "daily_cap" });
  });

  it("bundling: routine waits 10 min after the last proactive send; urgent/requested don't", () => {
    const last = new Date(NOON.getTime() - 4 * MIN);
    const s = state({ lastProactiveAt: last });
    expect(evaluateDelivery(s, "routine", NOON)).toEqual({ action: "defer", until: new Date(last.getTime() + 10 * MIN), reason: "bundling" });
    expect(evaluateDelivery(s, "urgent", NOON)).toEqual({ action: "send" });
    expect(evaluateDelivery(s, "requested", NOON)).toEqual({ action: "send" });
    expect(evaluateDelivery(state({ lastProactiveAt: new Date(NOON.getTime() - 11 * MIN) }), "routine", NOON)).toEqual({ action: "send" });
  });

  it("follow-up quota: ≥180 outside-window recipients defers 1h for every proactive class", () => {
    const s = state({ windowOpen: false, followupRecipients24h: 180 });
    for (const cls of PROACTIVE) {
      expect(evaluateDelivery(s, cls, NOON)).toEqual({ action: "defer", until: new Date(NOON.getTime() + H), reason: "followup_quota" });
    }
    expect(evaluateDelivery(state({ windowOpen: false, followupRecipients24h: 179 }), "routine", NOON)).toEqual({ action: "send" });
    expect(evaluateDelivery(state({ windowOpen: true, followupRecipients24h: 500 }), "routine", NOON)).toEqual({ action: "send" });
  });

  it("conversation_active defers 30s for every proactive class", () => {
    for (const cls of PROACTIVE) {
      expect(evaluateDelivery(state({ conversationActive: true }), cls, NOON)).toEqual({
        action: "defer",
        until: new Date(NOON.getTime() + 30_000),
        reason: "conversation_active",
      });
    }
  });

  it("conversation_active just before quiet hours reports quiet_hours", () => {
    const now = at("2026-10-11T01:59:50Z"); // 21:59:50
    expect(evaluateDelivery(state({ conversationActive: true }), "routine", now)).toEqual({
      action: "defer",
      until: NEXT_8AM,
      reason: "quiet_hours",
    });
  });

  it("notBefore defers", () => {
    const nb = at("2026-10-10T17:00:00Z");
    expect(evaluateDelivery(state({ notBefore: nb }), "urgent", NOON)).toEqual({ action: "defer", until: nb, reason: "not_before" });
  });
});

describe("expiry", () => {
  it("already expired → drop", () => {
    expect(evaluateDelivery(state({ expiresAt: new Date(NOON.getTime() - 1) }), "routine", NOON)).toEqual({ action: "drop", reason: "expired" });
  });
  it("earliest allowed send after expiresAt → drop", () => {
    const s = state({ expiresAt: at("2026-10-11T11:00:00Z") }); // expires 07:00, quiet ends 08:00
    expect(evaluateDelivery(s, "routine", LATE)).toEqual({ action: "drop", reason: "expired" });
  });
  it("earliest allowed send before expiresAt → defer", () => {
    const s = state({ expiresAt: at("2026-10-11T15:00:00Z") });
    expect(evaluateDelivery(s, "routine", LATE)).toEqual({ action: "defer", until: NEXT_8AM, reason: "quiet_hours" });
  });
  it("replies are never expired by guards", () => {
    expect(evaluateDelivery(state({ expiresAt: new Date(0) }), "reply", NOON)).toEqual({ action: "send" });
  });
});

describe("helpers", () => {
  it("earliestAllowedSend: reply is now", () => {
    expect(earliestAllowedSend(state({ pausedUntil: LATE }), "reply", NOON)).toEqual({ at: NOON, reason: null });
  });
  it("earliestAllowedSend applies jitter at quiet end", () => {
    expect(earliestAllowedSend(state({ quietJitterMs: 120_000 }), "routine", LATE).at).toEqual(
      new Date(NEXT_8AM.getTime() + 120_000),
    );
  });
  it("outboxRunAt: routine holds 30s or until 10 min after the last send; others now", () => {
    expect(outboxRunAt("routine", NOON, null)).toEqual(new Date(NOON.getTime() + 30_000));
    expect(outboxRunAt("routine", NOON, new Date(NOON.getTime() - 2 * MIN))).toEqual(new Date(NOON.getTime() + 8 * MIN));
    expect(outboxRunAt("urgent", NOON, NOON)).toEqual(NOON);
    expect(outboxRunAt("requested", NOON, NOON)).toEqual(NOON);
  });
  it("deliveryClass", () => {
    expect(deliveryClass(false, "urgent")).toBe("reply");
    expect(deliveryClass(true)).toBe("routine");
    expect(deliveryClass(true, "requested")).toBe("requested");
  });
  it("capDayStart is local midnight (DST-safe)", () => {
    expect(capDayStart(NOON, NY)).toEqual(at("2026-10-10T04:00:00Z"));
    expect(capDayStart(at("2026-11-01T18:00:00Z"), NY)).toEqual(at("2026-11-01T04:00:00Z")); // 25h day starts EDT
  });
  it("isWindowOpen: within 24h of the last inbound", () => {
    expect(isWindowOpen(null, NOON)).toBe(false);
    expect(isWindowOpen(new Date(NOON.getTime() - 23 * H), NOON)).toBe(true);
    expect(isWindowOpen(new Date(NOON.getTime() - 24 * H), NOON)).toBe(false);
  });
});
