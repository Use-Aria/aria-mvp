/**
 * Send safety for non-idempotent Google writes (V2 review 5.5 #1).
 *
 * - `messages.send`, `events.insert` and `calendars.insert` go out exactly once: no retry on 429,
 *   500, 503, a network error or a timeout. Those failures throw `GoogleWriteUnknownError`
 *   (outcome unknown); a definite rejection (400/403/404) stays a plain `GoogleApiError`.
 * - GETs (and the idempotent POSTs such as `watch`) still back off and retry as before.
 * - `executeSendEmail` / the `send_email` executor resolve an unknown outcome with a Sent-folder
 *   lookup and never post `messages/send` a second time.
 *
 * The token layer and the integration row are mocked at their source modules; the HTTP boundary
 * is a counting fake `fetch`.
 */
import { GoogleApiError } from "@/server/integrations/google/errors";
import { GoogleWriteUnknownError, googleFetch, isWriteOutcomeUnknown } from "@/server/integrations/google/http";
import { GMAIL_BASE, gmailWatch, listMessageIds, sendRaw } from "@/server/integrations/google/gmail/api";
import { CALENDAR_BASE, findEventByAriaKey, insertCalendar, insertEvent, listCalendars } from "@/server/integrations/google/calendar/api";
import { ariaMessageId, executeSendEmail, SEND_UNCONFIRMED, sentFolderQuery } from "@/server/integrations/google/gmail/send";
import { sendEmailExecutor } from "@/server/agent/pending/executors/send-email";
import type { GoogleIntegration } from "@/server/integrations/google/store";
import type { SendEmailPayloadT } from "@/shared/email-draft";
import { z } from "zod";
import { apiError, json } from "./fakes";

jest.mock("@/server/integrations/google/tokens", () => ({
  getGoogleAccess: jest.fn(async () => ({ accessToken: "at-test", integration: {} })),
}));

const SENDER = "dan@gmail.com";
const mockIntegration: Partial<GoogleIntegration> = {
  id: "int-1",
  user_id: "user-1",
  provider: "google",
  status: "active",
  account_email: SENDER,
  scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/gmail.send"],
};
jest.mock("@/server/integrations/google/store", () => ({
  getGoogleIntegration: jest.fn(async () => mockIntegration),
}));

const USER = "user-1";
const CAL = "aria1@group.calendar.google.com";
const RAW = Buffer.from("From: dan@gmail.com\r\nTo: a@x.com\r\nSubject: hi\r\n\r\nhello", "utf8").toString("base64url");

type Failure = "429" | "500" | "503" | "network" | "timeout";
const FAILURES: Failure[] = ["429", "500", "503", "network", "timeout"];

/** One failing response (or a thrown fetch error) for a failure kind. */
function fail(kind: Failure): Response {
  switch (kind) {
    case "429":
      return apiError(429, "rateLimitExceeded");
    case "500":
      return apiError(500, "backendError");
    case "503":
      return apiError(503, "backendError");
    case "network":
      throw new TypeError("fetch failed");
    case "timeout":
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }
}

interface Hit {
  method: string;
  url: URL;
}

/**
 * Counting fake fetch. `handler` answers each request (may throw to simulate a network failure).
 * @param handler request → response
 * @returns fetch + recorded hits + sleep seam that records waits
 */
function counting(handler: (h: Hit, n: number) => Response) {
  const hits: Hit[] = [];
  const sleeps: number[] = [];
  const f: typeof fetch = async (input, init) => {
    const h = { method: init?.method ?? "GET", url: new URL(String(input)) };
    hits.push(h);
    return handler(h, hits.length);
  };
  const deps = { fetch: f, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0 };
  const count = (method: string, path: RegExp) => hits.filter((h) => h.method === method && path.test(h.url.pathname)).length;
  return { hits, sleeps, deps, count };
}

const EVENT = { summary: "Gym", start: new Date("2026-10-15T22:30:00Z"), end: new Date("2026-10-15T23:30:00Z"), privateProperties: { aria_key: "k1" } };

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("non-idempotent POSTs are never retried", () => {
  const writes: { name: string; path: RegExp; call: (deps: ReturnType<typeof counting>["deps"]) => Promise<unknown> }[] = [
    { name: "gmail messages.send", path: /\/messages\/send$/, call: (deps) => sendRaw(USER, RAW, undefined, deps) },
    { name: "calendar events.insert", path: /\/calendars\/[^/]+\/events$/, call: (deps) => insertEvent(USER, CAL, EVENT, deps) },
    {
      name: "calendar calendars.insert",
      path: /\/calendar\/v3\/calendars$/,
      call: (deps) => insertCalendar(USER, { summary: "Aria", description: "d", timeZone: "America/New_York" }, deps),
    },
  ];

  for (const w of writes) {
    for (const kind of FAILURES) {
      it(`${w.name}: ${kind} → one POST, GoogleWriteUnknownError`, async () => {
        const t = counting(() => fail(kind));
        const err = await w.call(t.deps).then(
          () => null,
          (e: unknown) => e,
        );
        expect(t.count("POST", w.path)).toBe(1);
        expect(t.hits).toHaveLength(1);
        expect(t.sleeps).toEqual([]);
        expect(err).toBeInstanceOf(GoogleWriteUnknownError);
        expect(isWriteOutcomeUnknown(err)).toBe(true);
        expect((err as GoogleApiError).retryable).toBe(false);
      });
    }

    it(`${w.name}: a definite 400 is a plain GoogleApiError (one POST)`, async () => {
      const t = counting(() => apiError(400, "invalid"));
      const err = await w.call(t.deps).catch((e: unknown) => e);
      expect(t.hits).toHaveLength(1);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect(isWriteOutcomeUnknown(err)).toBe(false);
    });

    it(`${w.name}: a 2xx with an unreadable body is an unknown outcome, not resent`, async () => {
      const t = counting(() => new Response("<html>oops</html>", { status: 200 }));
      const err = await w.call(t.deps).catch((e: unknown) => e);
      expect(t.hits).toHaveLength(1);
      expect(isWriteOutcomeUnknown(err)).toBe(true);
    });
  }

  it("a 403 rate limit on messages.send is an unknown outcome (one POST)", async () => {
    const t = counting(() => apiError(403, "userRateLimitExceeded"));
    const err = await sendRaw(USER, RAW, undefined, t.deps).catch((e: unknown) => e);
    expect(t.hits).toHaveLength(1);
    expect(isWriteOutcomeUnknown(err)).toBe(true);
  });

  it("googleFetch retry:'none' succeeds normally on a 2xx", async () => {
    const t = counting(() => json(200, { id: "x" }));
    await expect(googleFetch(USER, { method: "POST", url: `${GMAIL_BASE}/messages/send`, body: {}, retry: "none" }, z.object({ id: z.string() }), t.deps)).resolves.toEqual({ id: "x" });
    expect(t.hits).toHaveLength(1);
  });
});

describe("GETs and idempotent POSTs still retry", () => {
  it.each(FAILURES)("googleFetch GET: %s, %s → 200 after 3 tries", async (kind) => {
    const t = counting((_h, n) => (n < 3 ? fail(kind) : json(200, { items: [] })));
    await expect(listCalendars(USER, t.deps)).resolves.toEqual([]);
    expect(t.count("GET", /calendarList$/)).toBe(3);
    expect(t.sleeps).toHaveLength(2);
  });

  it("findEventByAriaKey retries a 503", async () => {
    const t = counting((_h, n) => (n === 1 ? fail("503") : json(200, { items: [] })));
    await expect(findEventByAriaKey(USER, CAL, "k1", t.deps)).resolves.toBeNull();
    expect(t.hits).toHaveLength(2);
  });

  it("listMessageIds (sent-folder lookup) retries a network error", async () => {
    const t = counting((_h, n) => (n === 1 ? fail("network") : json(200, { messages: [{ id: "abcdef0123456789" }] })));
    await expect(listMessageIds(USER, "in:sent rfc822msgid:x@y.z", { max: 1 }, t.deps)).resolves.toEqual(["abcdef0123456789"]);
    expect(t.hits).toHaveLength(2);
  });

  it("gmail watch (POST, idempotent) keeps the default retry", async () => {
    const t = counting((_h, n) => (n === 1 ? fail("500") : json(200, { historyId: "123", expiration: "1790000000000" })));
    await expect(gmailWatch(USER, "projects/p/topics/t", t.deps)).resolves.toEqual({ historyId: "123", expiration: 1790000000000 });
    expect(t.count("POST", /\/watch$/)).toBe(2);
  });

  it("GET retries are exhausted after 3 tries with a retryable GoogleApiError", async () => {
    const t = counting(() => fail("500"));
    const err = await listCalendars(USER, t.deps).catch((e: unknown) => e);
    expect(t.hits).toHaveLength(3);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(isWriteOutcomeUnknown(err)).toBe(false);
    expect((err as GoogleApiError).retryable).toBe(true);
  });
});

describe("send_email: an unknown outcome falls back to the Sent folder, never a resend", () => {
  const ACTION = "11111111-2222-4333-8444-555555555555";
  const PAYLOAD: SendEmailPayloadT = { v: 1, from: SENDER, to: ["kim@yale.edu"], cc: [], subject: "Hi", body_text: "Hello" };
  const SENT_ID = "5e5e5e5e5e5e5e5e";

  /** Fake Gmail: `messages/send` fails with `kind` (after `applied` decides whether it really sent). */
  function gmail(kind: Failure, o: { applied: boolean; visibleAfterLookups?: number; lookupFails?: boolean }) {
    let lookups = 0;
    let delivered = false;
    const t = counting((h) => {
      if (h.method === "POST" && h.url.pathname.endsWith("/messages/send")) {
        if (o.applied) delivered = true;
        return fail(kind);
      }
      if (h.method === "GET" && h.url.pathname.endsWith("/messages")) {
        expect(h.url.searchParams.get("q")).toBe(sentFolderQuery(ariaMessageId(ACTION, SENDER)));
        lookups++;
        if (o.lookupFails) return fail("500");
        const visible = delivered && lookups > (o.visibleAfterLookups ?? 0);
        return json(200, visible ? { messages: [{ id: SENT_ID }] } : {});
      }
      return apiError(404, "notFound");
    });
    return { ...t, sends: () => t.count("POST", /\/messages\/send$/), lookups: () => lookups };
  }

  it.each(FAILURES)("%s, the message did go out → reported sent, one POST", async (kind) => {
    const g = gmail(kind, { applied: true });
    const r = await executeSendEmail({ userId: USER, actionId: ACTION, payload: PAYLOAD }, g.deps);
    expect(r).toMatchObject({
      ok: true,
      summary: "Sent your email to kim@yale.edu",
      result: { recovered: true, gmail_message_id: SENT_ID, rfc822_message_id: ariaMessageId(ACTION, SENDER) },
    });
    expect(g.sends()).toBe(1);
    expect(g.lookups()).toBe(1);
  });

  it("the Sent folder shows it only on the second look (index lag) → sent, still one POST", async () => {
    const g = gmail("timeout", { applied: true, visibleAfterLookups: 1 });
    const r = await executeSendEmail({ userId: USER, actionId: ACTION, payload: PAYLOAD }, g.deps);
    expect(r.ok).toBe(true);
    expect(g.sends()).toBe(1);
    expect(g.lookups()).toBe(2);
    expect(g.sleeps).toContain(2000);
  });

  it("not in the Sent folder → send_unconfirmed (non-retryable), one POST", async () => {
    const g = gmail("503", { applied: false });
    const r = await executeSendEmail({ userId: USER, actionId: ACTION, payload: PAYLOAD }, g.deps);
    expect(r).toEqual({ ok: false, error: `${SEND_UNCONFIRMED}:503`, retryable: false });
    expect(g.sends()).toBe(1);
    expect(g.lookups()).toBe(2);
  });

  it("the Sent-folder lookup itself fails → send_unconfirmed, one POST", async () => {
    const g = gmail("network", { applied: true, lookupFails: true });
    const r = await executeSendEmail({ userId: USER, actionId: ACTION, payload: PAYLOAD }, g.deps);
    expect(r).toEqual({ ok: false, error: `${SEND_UNCONFIRMED}:0`, retryable: false });
    expect(g.sends()).toBe(1);
  });

  it("a definite rejection is send_rejected, with no Sent-folder lookup", async () => {
    const t = counting(() => apiError(400, "invalidArgument"));
    const r = await executeSendEmail({ userId: USER, actionId: ACTION, payload: PAYLOAD }, t.deps);
    expect(r).toEqual({ ok: false, error: "send_rejected:400", retryable: false });
    expect(t.hits).toHaveLength(1);
  });

  it("the send_email executor and its recover never post messages/send a second time", async () => {
    // Production executor (no deps): route the real global fetch through the fake.
    const g = gmail("500", { applied: false });
    const realFetch = global.fetch;
    global.fetch = g.deps.fetch;
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      const ctx = { userId: USER, actionId: ACTION, via: "chat" as const, now: new Date() };
      const pending = sendEmailExecutor.execute(ctx, PAYLOAD);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ ok: false, error: `${SEND_UNCONFIRMED}:500`, retryable: false });
      expect(await sendEmailExecutor.recover?.(ctx, PAYLOAD)).toBe("not_done");
      expect(g.sends()).toBe(1);
    } finally {
      jest.useRealTimers();
      global.fetch = realFetch;
    }
  });
});

describe("URLs", () => {
  it("the write endpoints under test are the real Google paths", () => {
    expect(GMAIL_BASE).toBe("https://gmail.googleapis.com/gmail/v1/users/me");
    expect(CALENDAR_BASE).toBe("https://www.googleapis.com/calendar/v3");
  });
});
