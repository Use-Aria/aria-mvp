/**
 * Unit tests for src/server/integrations/canvas/fetch-feed.ts (V2-05 §2.6, §10.2). Run: npm test
 * Fake resolver + fake transport: nothing here touches DNS or the network.
 */
import { gzipSync } from "node:zlib";
import {
  TransportError,
  classifyHttpFailure,
  fetchCanvasFeed,
  isAcceptableFeedSource,
  type FeedFetchOk,
  type FeedTransport,
  type PinnedRequest,
  type PinnedResponse,
} from "@/server/integrations/canvas/fetch-feed";
import type { ResolvedAddress, Resolver } from "@/server/integrations/canvas/ssrf";
import { normalizeCanvasFeedUrl, type CanvasFeedUrl } from "@/shared/canvas-url";
import { fixtureBytes } from "./fixtures";

const ID = "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k";
const PATH = `/feeds/calendars/user_${ID}.ics`;
const CANVAS_META = "q=4396;a=1;g=abc;s=7;c=cluster31;z=us-east-1;o=calendar_events_api;n=public_feed;st=x";
const ICS = fixtureBytes("basic.ics");

function feedUrl(href: string): CanvasFeedUrl {
  const r = normalizeCanvasFeedUrl(href);
  if (!r.ok) throw new Error(r.error);
  return r.url;
}
const YALE = feedUrl(`https://yale.instructure.com${PATH}`);

interface Scripted {
  status: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  hang?: "headers" | "body";
  throws?: Error;
}

/** Records calls; answers from a per-call script. */
function fakeTransport(script: (req: PinnedRequest, n: number) => Scripted) {
  const calls: PinnedRequest[] = [];
  const aborts: number[] = [];
  const transport: FeedTransport = {
    async request(req) {
      const n = calls.push(req) - 1;
      const s = script(req, n);
      if (s.throws) throw s.throws;
      if (s.hang === "headers") return new Promise<PinnedResponse>(() => undefined);
      const chunks = s.chunks ?? [];
      const hang = s.hang === "body";
      async function* body(): AsyncGenerator<Uint8Array> {
        for (const c of chunks) yield c;
        if (hang) await new Promise(() => undefined);
      }
      return { status: s.status, headers: s.headers ?? {}, body: body(), abort: () => aborts.push(n) };
    },
  };
  return { transport, calls, aborts };
}

function fakeResolver(map: Record<string, ResolvedAddress[]> = {}) {
  const hosts: string[] = [];
  const resolver: Resolver = async (host) => {
    hosts.push(host);
    const hit = map[host];
    if (hit) return hit;
    if (host.endsWith(".invalid")) throw new Error("ENOTFOUND");
    return [{ address: "13.32.241.71", family: 4 }];
  };
  return { resolver, hosts };
}

const calendar = (extra: Record<string, string> = {}): Scripted => ({
  status: 200,
  headers: { "content-type": "text/calendar; charset=utf-8", "x-canvas-meta": CANVAS_META, ...extra },
  chunks: [ICS.subarray(0, 100), ICS.subarray(100)],
});

describe("fetchCanvasFeed — success", () => {
  it("returns the body, final URL, and Canvas header flag; pins the resolved IP", async () => {
    const { resolver, hosts } = fakeResolver();
    const { transport, calls } = fakeTransport(() => calendar());
    const r = await fetchCanvasFeed(YALE, { resolver, transport });
    expect(r.ok).toBe(true);
    const ok = r as FeedFetchOk;
    expect(Buffer.from(ok.body).equals(Buffer.from(ICS))).toBe(true);
    expect(ok.finalUrl).toEqual(YALE);
    expect(ok.contentType).toBe("text/calendar");
    expect(ok.canvasMeta).toBe(true);
    expect(hosts).toEqual(["yale.instructure.com"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].pinned).toEqual({ address: "13.32.241.71", family: 4 });
    expect(calls[0].url.hostname).toBe("yale.instructure.com"); // SNI / cert name stays the real host
    expect(calls[0].url.pathname).toBe(PATH);
    expect(calls[0].headers).toMatchObject({ accept: "text/calendar", "accept-encoding": "gzip" });
    expect(calls[0].headers["user-agent"]).toMatch(/^AriaCalendarSync\/1\.0/);
    expect(calls[0].headers.cookie).toBeUndefined();
  });

  it("decompresses gzip and tolerates text/plain and octet-stream", async () => {
    const { resolver } = fakeResolver();
    const gz = fakeTransport(() => ({ status: 200, headers: { "content-type": "text/calendar", "content-encoding": "gzip" }, chunks: [gzipSync(ICS)] }));
    const r = await fetchCanvasFeed(YALE, { resolver, transport: gz.transport });
    expect(r.ok && Buffer.from(r.body).equals(Buffer.from(ICS))).toBe(true);
    expect(r.ok && r.canvasMeta).toBe(false);
    for (const type of ["text/plain", "application/octet-stream"]) {
      const t = fakeTransport(() => ({ status: 200, headers: { "content-type": type }, chunks: [ICS] }));
      expect((await fetchCanvasFeed(YALE, { resolver, transport: t.transport })).ok).toBe(true);
    }
  });

  it("follows a redirect to another valid feed URL, re-resolving the new host", async () => {
    const { resolver, hosts } = fakeResolver();
    const next = `https://canvas.harvard.edu${PATH}`;
    const { transport, calls, aborts } = fakeTransport((_req, n) =>
      n === 0 ? { status: 301, headers: { location: next } } : calendar(),
    );
    const r = await fetchCanvasFeed(YALE, { resolver, transport });
    expect(r.ok && r.finalUrl).toEqual(feedUrl(next));
    expect(hosts).toEqual(["yale.instructure.com", "canvas.harvard.edu"]);
    expect(calls.map((c) => c.url.hostname)).toEqual(["yale.instructure.com", "canvas.harvard.edu"]);
    expect(aborts).toContain(0); // the redirect response is torn down, not read
  });
});

describe("fetchCanvasFeed — SSRF policy", () => {
  it("rejects a first hop that resolves to a private address without connecting", async () => {
    const { resolver } = fakeResolver({ "yale.instructure.com": [{ address: "10.0.0.8", family: 4 }] });
    const { transport, calls } = fakeTransport(() => calendar());
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toEqual({ ok: false, code: "non_public_address", cls: "rejected" });
    expect(calls).toHaveLength(0);
  });

  it("302 → host resolving to 169.254.169.254 → redirect_rejected (never connects there)", async () => {
    const { resolver, hosts } = fakeResolver({ "metadata.evil.com": [{ address: "169.254.169.254", family: 4 }] });
    const { transport, calls } = fakeTransport(() => ({ status: 302, headers: { location: `https://metadata.evil.com${PATH}` } }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toEqual({ ok: false, code: "redirect_rejected", cls: "rejected" });
    expect(calls).toHaveLength(1);
    expect(hosts).toEqual(["yale.instructure.com", "metadata.evil.com"]);
  });

  it.each([
    [`http://yale.instructure.com${PATH}`, "redirect_rejected", "rejected"],
    [`https://127.0.0.1${PATH}`, "redirect_rejected", "rejected"],
    [`https://yale.instructure.com:8443${PATH}`, "redirect_rejected", "rejected"],
    [`https://u:p@yale.instructure.com${PATH}`, "redirect_rejected", "rejected"],
    [`ftp://yale.instructure.com${PATH}`, "redirect_rejected", "rejected"],
    ["/login", "feed_not_found", "definitive"],
    ["https://yale.instructure.com/login/canvas", "feed_not_found", "definitive"],
    [`https://evil.com/api/v1/users`, "feed_not_found", "definitive"],
  ])("302 → %s → %s", async (location, code, cls) => {
    const { resolver, hosts } = fakeResolver();
    const { transport, calls } = fakeTransport(() => ({ status: 302, headers: { location } }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toEqual({ ok: false, code, cls, status: 302 });
    expect(calls).toHaveLength(1);
    expect(hosts).toHaveLength(1);
  });

  it("4 hops → too_many_redirects; resolver called once per hop", async () => {
    const { resolver, hosts } = fakeResolver();
    const { transport, calls } = fakeTransport((_req, n) => ({
      status: 307,
      headers: { location: `https://hop${n + 1}.instructure.com${PATH}` },
    }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toEqual({ ok: false, code: "too_many_redirects", cls: "rejected" });
    expect(calls).toHaveLength(4);
    expect(hosts).toEqual(["yale.instructure.com", "hop1.instructure.com", "hop2.instructure.com", "hop3.instructure.com"]);
  });

  it("a redirect without Location is a transient server error", async () => {
    const { resolver } = fakeResolver();
    const { transport } = fakeTransport(() => ({ status: 302 }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toEqual({ ok: false, code: "server_error", cls: "transient", status: 302 });
  });
});

describe("fetchCanvasFeed — limits", () => {
  it("over the byte cap → too_large and abort()", async () => {
    const { resolver } = fakeResolver();
    const big = new Uint8Array(600).fill(0x41);
    const { transport, aborts } = fakeTransport(() => ({ status: 200, headers: { "content-type": "text/calendar" }, chunks: [big, big] }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport, maxBytes: 1000 })).toEqual({ ok: false, code: "too_large", cls: "transient", status: 200 });
    expect(aborts).toEqual([0]);
  });

  it("declared Content-Length over the cap → too_large without reading", async () => {
    const { resolver } = fakeResolver();
    const { transport, aborts } = fakeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/calendar", "content-length": String(11 * 1024 * 1024) },
      chunks: [ICS],
    }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toMatchObject({ ok: false, code: "too_large" });
    expect(aborts).toEqual([0]);
  });

  it("gzip bomb (tiny on the wire, > 10 MiB inflated) → too_large", async () => {
    const { resolver } = fakeResolver();
    const head = new TextEncoder().encode("BEGIN:VCALENDAR\r\n");
    const bomb = gzipSync(Buffer.concat([Buffer.from(head), Buffer.alloc(12 * 1024 * 1024, 0x20)]));
    expect(bomb.byteLength).toBeLessThan(100_000);
    const { transport } = fakeTransport(() => ({ status: 200, headers: { "content-type": "text/calendar", "content-encoding": "gzip" }, chunks: [bomb] }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toEqual({ ok: false, code: "too_large", cls: "transient", status: 200 });
  });

  it("corrupt gzip → network (transient)", async () => {
    const { resolver } = fakeResolver();
    const { transport } = fakeTransport(() => ({ status: 200, headers: { "content-encoding": "gzip" }, chunks: [new Uint8Array([1, 2, 3])] }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport })).toMatchObject({ ok: false, code: "network", cls: "transient" });
  });

  it("total timeout while waiting for headers or body → timeout", async () => {
    const { resolver } = fakeResolver();
    const h = fakeTransport(() => ({ status: 200, hang: "headers" }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport: h.transport, totalTimeoutMs: 50 })).toEqual({ ok: false, code: "timeout", cls: "transient" });
    const b = fakeTransport(() => ({ ...calendar(), hang: "body" }));
    expect(await fetchCanvasFeed(YALE, { resolver, transport: b.transport, totalTimeoutMs: 50 })).toEqual({
      ok: false,
      code: "timeout",
      cls: "transient",
      status: 200,
    });
    expect(b.aborts).toEqual([0]);
  });

  it("slow DNS counts against the total timeout", async () => {
    const slow: Resolver = () => new Promise(() => undefined);
    const { transport, calls } = fakeTransport(() => calendar());
    expect(await fetchCanvasFeed(YALE, { resolver: slow, transport, totalTimeoutMs: 30 })).toEqual({ ok: false, code: "timeout", cls: "transient" });
    expect(calls).toHaveLength(0);
  });
});

describe("fetchCanvasFeed — failure classes", () => {
  const run = async (s: Scripted) => {
    const { resolver } = fakeResolver();
    const { transport } = fakeTransport(() => s);
    return fetchCanvasFeed(YALE, { resolver, transport });
  };
  const html = new TextEncoder().encode("<!DOCTYPE html><html>Unauthorized</html>");

  it("400 + x-canvas-meta n=public_feed (revoked feed) → feed_not_found / definitive", async () => {
    expect(
      await run({ status: 400, headers: { "content-type": "text/html; charset=utf-8", "x-canvas-meta": CANVAS_META }, chunks: [fixtureBytes("unauthorized-feed.html")] }),
    ).toEqual({ ok: false, code: "feed_not_found", cls: "definitive", status: 400 });
  });

  it.each<[number, Record<string, string>, string, string]>([
    [400, { "content-type": "text/html" }, "feed_not_found", "slow_transient"],
    [400, { "x-canvas-meta": "o=calendar_events_api;n=public_feedx" }, "feed_not_found", "slow_transient"],
    [404, { "x-canvas-meta": "o=errors;n=not_found" }, "feed_not_found", "definitive"],
    [410, {}, "feed_not_found", "definitive"],
    [401, {}, "forbidden", "slow_transient"],
    [403, { server: "cloudflare" }, "forbidden", "slow_transient"],
    [429, {}, "rate_limited", "transient"],
    [500, {}, "server_error", "transient"],
    [503, {}, "server_error", "transient"],
    [418, {}, "server_error", "transient"],
  ])("%i %j → %s / %s", async (status, headers, code, cls) => {
    expect(await run({ status, headers, chunks: [html] })).toEqual({ ok: false, code, cls, status });
  });

  it("200 text/html (login page) and a non-calendar 200 body → not_calendar", async () => {
    expect(await run({ status: 200, headers: { "content-type": "text/html" }, chunks: [html] })).toEqual({
      ok: false,
      code: "not_calendar",
      cls: "definitive",
      status: 200,
    });
    expect(await run({ status: 200, headers: { "content-type": "text/plain" }, chunks: [html] })).toEqual({
      ok: false,
      code: "not_calendar",
      cls: "definitive",
      status: 200,
    });
  });

  it("maps transport errors and DNS failure", async () => {
    expect(await run({ status: 0, throws: new TransportError("timeout") })).toEqual({ ok: false, code: "timeout", cls: "transient" });
    expect(await run({ status: 0, throws: new TransportError("tls_error") })).toEqual({ ok: false, code: "tls_error", cls: "transient" });
    expect(await run({ status: 0, throws: new Error("ECONNRESET") })).toEqual({ ok: false, code: "network", cls: "transient" });
    const { resolver } = fakeResolver();
    const { transport } = fakeTransport(() => calendar());
    const missing = feedUrl(`https://gone.invalid${PATH}`);
    expect(await fetchCanvasFeed(missing, { resolver, transport })).toEqual({ ok: false, code: "dns_failed", cls: "transient" });
  });
});

describe("classifyHttpFailure (pure)", () => {
  it("keys revocation on 400 + n=public_feed only", () => {
    expect(classifyHttpFailure(400, { "x-canvas-meta": CANVAS_META }, "text/html").cls).toBe("definitive");
    expect(classifyHttpFailure(400, { "x-canvas-meta": "n=public_feed" }, "text/html").cls).toBe("definitive");
    expect(classifyHttpFailure(400, {}, "text/html").cls).toBe("slow_transient");
    expect(classifyHttpFailure(200, {}, "text/html")).toEqual({ ok: false, code: "not_calendar", cls: "definitive", status: 200 });
  });
});

describe("isAcceptableFeedSource", () => {
  const ok = (url: CanvasFeedUrl, canvasMeta: boolean): FeedFetchOk => ({ ok: true, body: ICS, finalUrl: url, contentType: "text/calendar", canvasMeta });
  const unlisted = feedUrl(`https://canvas.someschool.edu${PATH}`);

  it("accepts instructure and listed hosts as is", () => {
    expect(isAcceptableFeedSource(ok(YALE, false), false)).toBe(true);
    expect(isAcceptableFeedSource(ok(feedUrl(`https://canvas.harvard.edu${PATH}`), false), false)).toBe(true);
  });

  it("requires x-canvas-meta AND a Canvas-shaped body for unlisted hosts", () => {
    expect(isAcceptableFeedSource(ok(unlisted, true), true)).toBe(true);
    expect(isAcceptableFeedSource(ok(unlisted, true), false)).toBe(false);
    expect(isAcceptableFeedSource(ok(unlisted, false), true)).toBe(false);
  });
});
