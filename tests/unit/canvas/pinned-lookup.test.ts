/**
 * Unit tests for the pinned `node:https` transport (V2-05 §2.6 step 5, §10.2). Run: npm test
 *
 * Uses a local HTTPS server on 127.0.0.1 with a throwaway self-signed certificate generated at test
 * time (needs the `openssl` CLI; the TLS cases are skipped without it). No real host is contacted:
 * every connection is pinned to 127.0.0.1, and DNS is never consulted.
 */
import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";
import {
  createHttpsTransport,
  fetchCanvasFeed,
  pinnedLookup,
  type FeedTransport,
} from "@/server/integrations/canvas/fetch-feed";
import type { Resolver } from "@/server/integrations/canvas/ssrf";
import { normalizeCanvasFeedUrl } from "@/shared/canvas-url";
import { fixtureBytes } from "./fixtures";

const HOST = "feed.canvas.test";
const ID = "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k";
const PATH = `/feeds/calendars/user_${ID}.ics`;
const LOCAL = { address: "127.0.0.1", family: 4 as const };

describe("pinnedLookup", () => {
  afterEach(() => jest.restoreAllMocks());

  it("answers with the pinned address for any name, in both callback shapes, without DNS", () => {
    const spy = jest.spyOn(dns, "lookup");
    const lookup = pinnedLookup({ address: "13.32.241.71", family: 4 });
    const single = jest.fn();
    lookup("anything.example", { family: 0 }, single);
    expect(single).toHaveBeenCalledWith(null, "13.32.241.71", 4);
    const all = jest.fn();
    lookup("other.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "13.32.241.71", family: 4 }]);
    const v6 = jest.fn();
    pinnedLookup({ address: "2600:9000:2000::1", family: 6 })("x", {}, v6);
    expect(v6).toHaveBeenCalledWith(null, "2600:9000:2000::1", 6);
    expect(spy).not.toHaveBeenCalled();
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

(hasOpenssl() ? describe : describe.skip)("httpsTransport against a local TLS server", () => {
  let dir = "";
  let cert = "";
  let key = "";
  let server: https.Server;
  let port = 0;
  const seen: { servername: string | false | null; path: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const ics = fixtureBytes("basic.ics");

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "aria-canvas-tls-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2",
        "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`,
      ],
      { stdio: "ignore" },
    );
    cert = readFileSync(join(dir, "cert.pem"), "utf8");
    key = readFileSync(join(dir, "key.pem"), "utf8");
    server = https.createServer({ key, cert }, (req, res) => {
      const socket = req.socket as TLSSocket;
      seen.push({ servername: socket.servername, path: req.url ?? "", headers: req.headers });
      const url = req.url ?? "";
      if (url === PATH) {
        res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "x-canvas-meta": "o=calendar_events_api;n=public_feed" });
        res.end(Buffer.from(ics));
      } else if (url === "/feeds/calendars/user_gzip0000000000000000000.ics") {
        res.writeHead(200, { "content-type": "text/calendar", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.from(ics)));
      } else if (url === "/feeds/calendars/user_redirect00000000000000.ics") {
        res.writeHead(302, { location: PATH });
        res.end();
      } else if (url === "/feeds/calendars/user_huge0000000000000000000.ics") {
        res.writeHead(200, { "content-type": "text/calendar" });
        const chunk = Buffer.alloc(64 * 1024, 0x41);
        let sent = 0;
        const pump = () => {
          while (sent < 64 && res.write(chunk)) sent++;
          if (sent < 64) res.once("drain", pump);
          else res.end();
        };
        pump();
      } else {
        res.writeHead(400, { "content-type": "text/html", "x-canvas-meta": "o=calendar_events_api;n=public_feed" });
        res.end("<html>Unauthorized</html>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Real transport, but every connection goes to the local server regardless of the validated IP. */
  function localTransport(opts: { ca?: string } = {}): FeedTransport {
    const real = createHttpsTransport({ port, ca: opts.ca ?? cert });
    return { request: (args) => real.request({ ...args, pinned: LOCAL }) };
  }
  /** A public-looking answer so the SSRF policy passes; the transport above pins to 127.0.0.1. */
  const publicResolver: Resolver = async () => [{ address: "13.32.241.71", family: 4 }];

  it("connects to the pinned address with SNI = hostname and never calls dns.lookup", async () => {
    const spy = jest.spyOn(dns, "lookup");
    const transport = createHttpsTransport({ port, ca: cert });
    const res = await transport.request({
      url: new URL(`https://${HOST}${PATH}`),
      pinned: LOCAL,
      headers: { accept: "text/calendar" },
      timeoutMs: 5_000,
    });
    const chunks: Uint8Array[] = [];
    for await (const c of res.body) chunks.push(c);
    expect(res.status).toBe(200);
    expect(res.headers["x-canvas-meta"]).toContain("n=public_feed");
    expect(Buffer.concat(chunks).equals(Buffer.from(ics))).toBe(true);
    const last = seen[seen.length - 1];
    expect(last.servername).toBe(HOST);
    expect(last.path).toBe(PATH);
    expect(last.headers.host).toBe(`${HOST}:${port}`); // test-only port; production is always 443
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("verifies the certificate against the real hostname (wrong name / untrusted → tls_error)", async () => {
    const wrongName = createHttpsTransport({ port, ca: cert });
    await expect(
      wrongName.request({ url: new URL(`https://other.canvas.test${PATH}`), pinned: LOCAL, headers: {}, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ name: "TransportError", code: "tls_error" });
    const untrusted = createHttpsTransport({ port });
    await expect(
      untrusted.request({ url: new URL(`https://${HOST}${PATH}`), pinned: LOCAL, headers: {}, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "tls_error" });
  });

  it("times out a server that accepts TCP but never handshakes", async () => {
    const sockets: net.Socket[] = [];
    const silent = net.createServer((s) => sockets.push(s));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const silentPort = (silent.address() as AddressInfo).port;
    const transport = createHttpsTransport({ port: silentPort, ca: cert, connectTimeoutMs: 100 });
    await expect(
      transport.request({ url: new URL(`https://${HOST}${PATH}`), pinned: LOCAL, headers: {}, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "timeout" });
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("end to end: fetch, gzip, manual redirect, revoked feed, and the byte cap over real sockets", async () => {
    const url = (path: string) => {
      const r = normalizeCanvasFeedUrl(`https://${HOST}${path}`);
      if (!r.ok) throw new Error(r.error);
      return r.url;
    };
    const transport = localTransport();

    const ok = await fetchCanvasFeed(url(PATH), { resolver: publicResolver, transport });
    expect(ok.ok && ok.canvasMeta).toBe(true);
    expect(ok.ok && Buffer.from(ok.body).equals(Buffer.from(ics))).toBe(true);

    const gz = await fetchCanvasFeed(url("/feeds/calendars/user_gzip0000000000000000000.ics"), { resolver: publicResolver, transport });
    expect(gz.ok && Buffer.from(gz.body).equals(Buffer.from(ics))).toBe(true);

    const redirected = await fetchCanvasFeed(url("/feeds/calendars/user_redirect00000000000000.ics"), { resolver: publicResolver, transport });
    expect(redirected.ok && redirected.finalUrl.href).toBe(`https://${HOST}${PATH}`);

    const revoked = await fetchCanvasFeed(url("/feeds/calendars/user_revoked000000000000000.ics"), { resolver: publicResolver, transport });
    expect(revoked).toEqual({ ok: false, code: "feed_not_found", cls: "definitive", status: 400 });

    const huge = await fetchCanvasFeed(url("/feeds/calendars/user_huge0000000000000000000.ics"), {
      resolver: publicResolver,
      transport,
      maxBytes: 256 * 1024,
    });
    expect(huge).toEqual({ ok: false, code: "too_large", cls: "transient", status: 200 });
  });
});
