/**
 * Unit tests for src/server/integrations/canvas/ssrf.ts (V2-05 §2.6 steps 3–4, §10.2). Run: npm test
 * DNS is always a fake resolver; nothing here touches the network.
 */
import { isPublicAddress, resolvePublicHost, type ResolvedAddress, type Resolver } from "@/server/integrations/canvas/ssrf";

describe("isPublicAddress", () => {
  it.each([
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "192.0.2.10",
    "203.0.113.5",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "100::1",
    "fd00::1",
    "fc00::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "2002:7f00:1::",
    "2001:db8::1",
    "2001::1",
    "3fff::1",
    "4000::1",
    "not-an-ip",
    "",
    "1.2.3",
    "::ffff:999.1.1.1",
  ])("%s → false", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["13.32.241.71", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2600:9000:2000::1", "2606:4700::6810:84e5", "::ffff:8.8.8.8", "2001:4860:4860::8888"])(
    "%s → true",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe("resolvePublicHost", () => {
  const fake = (addrs: ResolvedAddress[]): Resolver => async () => addrs;

  it("pins IPv4 when both families are public", async () => {
    const r = await resolvePublicHost("yale.instructure.com", fake([
      { address: "2600:9000:2000::1", family: 6 },
      { address: "13.32.241.71", family: 4 },
    ]));
    expect(r).toEqual({
      ok: true,
      pinned: { address: "13.32.241.71", family: 4 },
      all: [
        { address: "2600:9000:2000::1", family: 6 },
        { address: "13.32.241.71", family: 4 },
      ],
    });
  });

  it("pins IPv6 when that's all there is", async () => {
    const r = await resolvePublicHost("x.edu", fake([{ address: "2600:9000:2000::1", family: 6 }]));
    expect(r.ok && r.pinned).toEqual({ address: "2600:9000:2000::1", family: 6 });
  });

  it("rejects when ANY address is non-public (mixed answers)", async () => {
    expect(
      await resolvePublicHost("x.edu", fake([
        { address: "13.32.241.71", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ])),
    ).toEqual({ ok: false, error: "non_public_address" });
    expect(await resolvePublicHost("x.edu", fake([{ address: "::ffff:169.254.169.254", family: 6 }]))).toEqual({
      ok: false,
      error: "non_public_address",
    });
  });

  it("maps resolver errors and empty answers to dns_failed", async () => {
    const throwing: Resolver = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await resolvePublicHost("nope.invalid", throwing)).toEqual({ ok: false, error: "dns_failed" });
    expect(await resolvePublicHost("x.edu", fake([]))).toEqual({ ok: false, error: "dns_failed" });
  });
});
