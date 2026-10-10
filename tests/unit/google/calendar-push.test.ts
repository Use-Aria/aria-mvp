/**
 * Calendar push: header parsing, token/resource verification, the route logic and the renewal
 * schedule (V2-07 §10 `calendar-push.test.ts`, 07a-4).
 */
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@/server/security/crypto";
import {
  handleCalendarPush,
  nextWatchRenewAt,
  parseCalendarPushHeaders,
  verifyCalendarPush,
} from "@/server/integrations/google/calendar/watch";
import type { GoogleIntegration } from "@/server/integrations/google/store";
import { googleRow } from "./fakes";

const key = randomBytes(32);
const TOKEN = "chan-token-123";
const stored = { tokenHash: sha256Hex(TOKEN), resourceId: "res-1" };

function headers(over: Record<string, string> = {}): Headers {
  return new Headers({
    "X-Goog-Channel-ID": "chan-1",
    "X-Goog-Channel-Token": TOKEN,
    "X-Goog-Resource-ID": "res-1",
    "X-Goog-Resource-State": "exists",
    ...over,
  });
}

describe("parseCalendarPushHeaders", () => {
  it("reads the four headers case-insensitively; blank → null", () => {
    const h = new Headers({ "x-goog-channel-id": "c", "X-GOOG-CHANNEL-TOKEN": "t", "X-Goog-Resource-Id": " r ", "x-goog-resource-state": "" });
    expect(parseCalendarPushHeaders(h)).toEqual({ channelId: "c", token: "t", resourceId: "r", state: null });
    expect(parseCalendarPushHeaders(new Headers())).toEqual({ channelId: null, token: null, resourceId: null, state: null });
  });
});

describe("verifyCalendarPush", () => {
  const base = parseCalendarPushHeaders(headers());
  it("accepts the right token + resource", () => expect(verifyCalendarPush(base, stored)).toBe(true));
  it("rejects a wrong token", () => expect(verifyCalendarPush({ ...base, token: "nope" }, stored)).toBe(false));
  it("rejects a missing token", () => expect(verifyCalendarPush({ ...base, token: null }, stored)).toBe(false));
  it("rejects a resource-id mismatch", () => expect(verifyCalendarPush({ ...base, resourceId: "res-2" }, stored)).toBe(false));
  it("rejects when nothing is stored", () => {
    expect(verifyCalendarPush(base, { tokenHash: null, resourceId: "res-1" })).toBe(false);
    expect(verifyCalendarPush(base, { tokenHash: stored.tokenHash, resourceId: null })).toBe(false);
  });
});

describe("handleCalendarPush", () => {
  const row: GoogleIntegration = googleRow(key, {
    gcal_channel_id: "chan-1",
    gcal_channel_token_hash: stored.tokenHash,
    gcal_resource_id: "res-1",
  });

  function run(h: Headers, found: GoogleIntegration | null = row) {
    const requested: string[] = [];
    const looked: string[] = [];
    const p = handleCalendarPush(h, {
      find: async (id) => {
        looked.push(id);
        return found;
      },
      request: async (u) => {
        requested.push(u);
      },
    });
    return { p, requested, looked };
  }

  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("verified exists → one sync request for the channel's user", async () => {
    const r = run(headers());
    expect(await r.p).toBe("enqueued");
    expect(r.looked).toEqual(["chan-1"]);
    expect(r.requested).toEqual(["user-1"]);
  });

  it("not_exists also syncs", async () => {
    const r = run(headers({ "X-Goog-Resource-State": "not_exists" }));
    expect(await r.p).toBe("enqueued");
  });

  it("the initial sync ping is acknowledged without a sync", async () => {
    const r = run(headers({ "X-Goog-Resource-State": "sync" }));
    expect(await r.p).toBe("sync_ack");
    expect(r.requested).toEqual([]);
  });

  it("unknown channel, wrong token, missing channel id, inactive row, odd state → no sync", async () => {
    const cases: [Headers, GoogleIntegration | null, string][] = [
      [headers(), null, "unknown_channel"],
      [headers({ "X-Goog-Channel-Token": "forged" }), row, "rejected"],
      [headers({ "X-Goog-Resource-ID": "other" }), row, "rejected"],
      [new Headers({ "X-Goog-Resource-State": "exists" }), row, "no_channel"],
      [headers(), { ...row, status: "revoked" }, "inactive"],
      [headers({ "X-Goog-Resource-State": "weird" }), row, "ignored_state"],
    ];
    for (const [h, found, outcome] of cases) {
      const r = run(h, found);
      expect(await r.p).toBe(outcome);
      expect(r.requested).toEqual([]);
    }
  });

  it("never logs the channel token", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await run(headers({ "X-Goog-Channel-Token": "forged-secret-token" })).p;
    expect(JSON.stringify(warn.mock.calls)).not.toContain("forged-secret-token");
  });
});

describe("nextWatchRenewAt", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const day = 86_400_000;
  it("caps at now + 6d for a 7-day channel", () => {
    expect(nextWatchRenewAt(new Date(now.getTime() + 7 * day), now)).toEqual(new Date(now.getTime() + 6 * day));
  });
  it("renews 24h before a shorter expiry", () => {
    expect(nextWatchRenewAt(new Date(now.getTime() + 3 * day), now)).toEqual(new Date(now.getTime() + 2 * day));
  });
  it("never schedules in the past", () => {
    expect(nextWatchRenewAt(new Date(now.getTime() + 3600_000), now)).toEqual(new Date(now.getTime() + 60_000));
  });
});
