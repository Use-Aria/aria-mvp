/** SSRF-safe attachment download (V2-08 §2.13, §10 `media.test.ts`) with injected fetch + DNS. */
import { fetchAttachmentPdf, hostAllowed, isPrivateAddress, MediaFetchError } from "@/server/integrations/syllabus/media";

const PDF = Buffer.from("%PDF-1.4\nhello\n%%EOF\n");
const HOSTS = ["cdn.sendblue.test"];
const PUBLIC = async () => ["93.184.216.34"];

function okFetch(body: Buffer = PDF, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status: 200, headers })) as typeof fetch;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof MediaFetchError ? e.code : `other:${String(e)}`;
  }
}

describe("fetchAttachmentPdf", () => {
  it("downloads an allowlisted https PDF and hashes it", async () => {
    const r = await fetchAttachmentPdf("https://cdn.sendblue.test/a/b.pdf?sig=1", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: okFetch(), lookup: PUBLIC });
    expect(r.bytes.equals(PDF)).toBe(true);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects http:", async () => {
    expect(await code(fetchAttachmentPdf("http://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: okFetch(), lookup: PUBLIC }))).toBe("scheme");
  });

  it("rejects a non-allowlisted host", async () => {
    expect(await code(fetchAttachmentPdf("https://evil.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: okFetch(), lookup: PUBLIC }))).toBe("host");
  });

  it.each(["10.0.0.5", "169.254.169.254", "127.0.0.1", "::1", "fd00::1"])("rejects a host resolving to %s", async (ip) => {
    expect(
      await code(fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: okFetch(), lookup: async () => [ip] })),
    ).toBe("private_ip");
  });

  it("rejects a redirect to another host, and more than 2 redirects", async () => {
    const redirectTo = (loc: string) => (async () => new Response(null, { status: 302, headers: { location: loc } })) as typeof fetch;
    expect(
      await code(fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: redirectTo("https://evil.test/x.pdf"), lookup: PUBLIC })),
    ).toBe("host");
    expect(
      await code(fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: redirectTo("/again"), lookup: PUBLIC })),
    ).toBe("redirect");
  });

  it("follows a same-host redirect", async () => {
    let n = 0;
    const f = (async () => {
      n += 1;
      return n === 1 ? new Response(null, { status: 301, headers: { location: "/real.pdf" } }) : new Response(new Uint8Array(PDF), { status: 200 });
    }) as typeof fetch;
    const r = await fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: f, lookup: PUBLIC });
    expect(r.bytes.length).toBe(PDF.length);
  });

  it("aborts a streamed body over the cap with too_large (declared or streamed)", async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(5000, 0x41)]);
    expect(await code(fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: okFetch(big), lookup: PUBLIC }))).toBe("too_large");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(PDF);
        for (let i = 0; i < 10; i += 1) c.enqueue(new Uint8Array(500));
        c.close();
      },
    });
    const f = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    expect(await code(fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: f, lookup: PUBLIC }))).toBe("too_large");
  });

  it("a non-%PDF- body gives not_pdf", async () => {
    expect(
      await code(fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: okFetch(Buffer.from("<html>nope</html>")), lookup: PUBLIC })),
    ).toBe("not_pdf");
  });

  it("maps HTTP errors to status (403 not retryable, 503 retryable)", async () => {
    const st = (s: number) => (async () => new Response("x", { status: s })) as typeof fetch;
    const e403 = await fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: st(403), lookup: PUBLIC }).catch((e: unknown) => e);
    expect(e403).toMatchObject({ code: "status", status: 403, retryable: false });
    const e503 = await fetchAttachmentPdf("https://cdn.sendblue.test/a.pdf", { maxBytes: 1000, allowedHosts: HOSTS }, { fetchImpl: st(503), lookup: PUBLIC }).catch((e: unknown) => e);
    expect(e503).toMatchObject({ code: "status", status: 503, retryable: true });
  });

  it("dev loopback: allowed only with allowLocal and an allowlisted loopback host", async () => {
    const local = { maxBytes: 1000, allowedHosts: ["localhost", "127.0.0.1"] };
    const lookup = async () => ["127.0.0.1"];
    expect(await code(fetchAttachmentPdf("http://localhost:3000/dev-fixtures/s.pdf", { ...local, allowLocal: true }, { fetchImpl: okFetch(), lookup }))).toBe("resolved");
    expect(await code(fetchAttachmentPdf("http://localhost:3000/dev-fixtures/s.pdf", local, { fetchImpl: okFetch(), lookup }))).toBe("scheme");
    expect(await code(fetchAttachmentPdf("https://localhost/s.pdf", local, { fetchImpl: okFetch(), lookup }))).toBe("private_ip");
  });
});

describe("helpers", () => {
  it("isPrivateAddress", () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });

  it("hostAllowed: exact and *.suffix entries", () => {
    expect(hostAllowed("cdn.sendblue.test", ["cdn.sendblue.test"])).toBe(true);
    expect(hostAllowed("x.cdn.sendblue.test", ["*.sendblue.test"])).toBe(true);
    expect(hostAllowed("sendblue.test", ["*.sendblue.test"])).toBe(false);
    expect(hostAllowed("evilsendblue.test", ["*.sendblue.test"])).toBe(false);
  });
});
