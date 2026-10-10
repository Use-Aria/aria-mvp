/**
 * enqueue.ts guards that run before any DB call: payload validation per kind (fail fast,
 * defaults applied, unknown keys stripped) and cancelJobs filter rules. The DB is replaced by a
 * tripwire so any accidental query fails the test.
 */
jest.mock("@/server/db", () => ({
  db: () => {
    throw new Error("DB must not be touched");
  },
}));

import { cancelJobs, enqueueJob, parseJobPayload } from "@/server/jobs/enqueue";
import { retentionCutoffs, RETENTION_DAYS } from "@/server/jobs/kinds/retention-purge";

const U = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("parseJobPayload", () => {
  it("applies defaults and strips unknown keys", () => {
    expect(parseJobPayload("canvas_sync", undefined)).toEqual({ reason: "scheduled" });
    expect(parseJobPayload("noop", { note: "hi", extra: 1 })).toEqual({ note: "hi" });
    expect(parseJobPayload("retention_purge", {})).toEqual({});
    expect(parseJobPayload("syllabus_parse", { messageId: U })).toEqual({ messageId: U, mediaIndex: 0, replace: false });
  });

  it("rejects an invalid payload naming the kind", () => {
    expect(() => parseJobPayload("reminder_fire", { reminderId: "nope" })).toThrow(/enqueueJob\(reminder_fire\): invalid payload/);
    expect(() => parseJobPayload("conversation_turn", {})).toThrow(/conversation_turn/);
  });
});

describe("enqueueJob", () => {
  it("fails fast on a bad payload, runAt or maxDelayMs before touching the DB", async () => {
    await expect(enqueueJob({ kind: "account_purge", payload: { userId: "x" } })).rejects.toThrow(/invalid payload/);
    await expect(enqueueJob({ kind: "noop", runAt: new Date(Number.NaN) })).rejects.toThrow(/invalid runAt/);
    await expect(enqueueJob({ kind: "noop", maxDelayMs: -1, dedupeKey: "k", mode: "debounce" })).rejects.toThrow(
      /invalid maxDelayMs/,
    );
  });
});

describe("cancelJobs", () => {
  it("refuses to run without a filter", async () => {
    await expect(cancelJobs({})).rejects.toThrow(/at least one filter/);
  });

  it("empty filters match nothing without a query", async () => {
    await expect(cancelJobs({ ids: [] })).resolves.toBe(0);
    await expect(cancelJobs({ kinds: [], userId: U })).resolves.toBe(0);
    await expect(cancelJobs({ dedupeKeyPrefix: "" })).resolves.toBe(0);
  });
});

describe("retentionCutoffs", () => {
  it("subtracts each window in whole days", () => {
    const now = new Date("2026-10-10T08:17:00Z");
    const c = retentionCutoffs(now);
    expect(c.messages).toBe("2026-04-13T08:17:00.000Z"); // 180 days
    expect(c.jobs).toBe("2026-09-10T08:17:00.000Z"); // 30 days
    expect(c.signups).toBe("2026-10-03T08:17:00.000Z"); // 7 days
    expect(c.briefingPlans).toBe(c.messages);
    expect(c.agentRuns).toBe(c.messages);
    expect(c.proactiveDedupe).toBe(c.jobs);
    expect(c.magicLinks).toBe(c.webSessions);
    expect(Object.keys(c).sort()).toEqual(Object.keys(RETENTION_DAYS).sort());
  });
});
