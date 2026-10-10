import "server-only";
// OWNER: 1.4

/**
 * SSRF address policy (V2-05 §2.6 steps 3–4). Every resolved address must be globally routable
 * unicast; one is pinned for the connection so DNS rebinding can't swap it afterwards.
 */
import { promises as dnsPromises } from "node:dns";
import { BlockList, isIP } from "node:net";

/** IANA special-purpose IPv4 blocks (not globally routable or not unicast). */
const V4_BLOCKED: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4], // includes 255.255.255.255/32
];

/** IANA special-purpose IPv6 blocks inside or alongside global unicast. */
const V6_BLOCKED: ReadonlyArray<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 can reach metadata
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23], // Teredo, ORCHID, benchmarking, …
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 embeds arbitrary v4
  ["3fff::", 20], // documentation (RFC 9637)
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const BLOCKED = new BlockList();
for (const [net, prefix] of V4_BLOCKED) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6_BLOCKED) BLOCKED.addSubnet(net, prefix, "ipv6");

/**
 * True only for globally routable unicast addresses. IANA special-purpose ranges are rejected,
 * IPv6 must be inside 2000::/3, and IPv4-mapped / IPv4-compatible IPv6 is unwrapped and checked as v4.
 * @param ip textual IPv4 or IPv6 address (zone ids are rejected)
 * @returns false for anything that isn't a valid public address
 */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.includes("%")) return false;
  const fam = isIP(ip);
  if (fam === 4) return !BLOCKED.check(ip, "ipv4");
  if (fam !== 6) return false;
  const h = parseIPv6(ip);
  if (!h) return false;
  const embedded = embeddedV4(h);
  if (embedded !== null) return isIP(embedded) === 4 && !BLOCKED.check(embedded, "ipv4");
  if ((h[0] & 0xe000) !== 0x2000) return false; // outside 2000::/3 global unicast
  return !BLOCKED.check(ip, "ipv6");
}

/** One resolved address. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** DNS resolver (injectable for tests). */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/** `dns.promises.lookup(host, { all: true, verbatim: true })`. */
export const systemResolver: Resolver = async (host: string) => {
  const rows = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** Result of {@link resolvePublicHost}. */
export type ResolveResult =
  | { ok: true; pinned: ResolvedAddress; all: ResolvedAddress[] }
  | { ok: false; error: "dns_failed" | "non_public_address" };

/**
 * Resolves a host, requires every address to be public, and pins one (IPv4 preferred).
 * @param host DNS name (already normalized by `canvas-url.ts`)
 * @param resolver DNS resolver (default {@link systemResolver})
 * @returns the pinned address plus all addresses, or `dns_failed` / `non_public_address`
 */
export async function resolvePublicHost(host: string, resolver: Resolver = systemResolver): Promise<ResolveResult> {
  let all: ResolvedAddress[];
  try {
    all = await resolver(host);
  } catch {
    return { ok: false, error: "dns_failed" };
  }
  if (!Array.isArray(all) || all.length === 0) return { ok: false, error: "dns_failed" };
  if (!all.every((a) => isPublicAddress(a.address))) return { ok: false, error: "non_public_address" };
  const pinned = all.find((a) => isIP(a.address) === 4) ?? all[0];
  return { ok: true, pinned: { address: pinned.address, family: isIP(pinned.address) === 6 ? 6 : 4 }, all };
}

// ── IPv6 helpers ────────────────────────────────────────────────────────────

/** Eight 16-bit groups of a valid IPv6 literal (embedded dotted v4 tail allowed), or null. */
function parseIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = last.split(".");
    if (v4.length !== 4 || v4.some((n) => !/^\d{1,3}$/.test(n) || Number(n) > 255)) return null;
    const [a, b, c, d] = v4.map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]);
  const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

/** Colon-separated hex groups ("" → []), or null on a malformed group. */
function parseGroups(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  for (const g of part.split(":")) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** Dotted v4 embedded in an IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96) address. */
function embeddedV4(h: number[]): string | null {
  const zero5 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  if (!zero5) return null;
  const mapped = h[5] === 0xffff;
  const compatible = h[5] === 0 && !(h[6] === 0 && h[7] <= 1); // not :: or ::1
  if (!mapped && !compatible) return null;
  return `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
}
