import "server-only";
// OWNER: 3.5

/**
 * SSRF-safe download of an inbound attachment (V2-08 §2.13 "SSRF on the media fetch").
 *
 * - `https:` only; the hostname must be on `SYLLABUS_MEDIA_ALLOWED_HOSTS` (exact, or a `*.suffix`
 *   entry). The allowlist is the primary control.
 * - Every resolved address must be public (shared policy with Canvas: `isPublicAddress`). This is
 *   defense in depth: built-in fetch can't pin the address, so DNS-rebinding TOCTOU stays open.
 * - `redirect: "manual"`, ≤ 2 redirects, each hop re-checked.
 * - Streamed read with a byte cap, an overall timeout, and the `%PDF-` magic checked up front.
 * - Dev only (`allowLocal`): `http:` and loopback addresses are allowed for allowlisted loopback
 *   hosts (`localhost`, `127.0.0.1`, `::1`) so the dev channel can point at a local fixture.
 * Logs carry codes only, never the URL (it can be a bearer link).
 */
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { isPublicAddress } from "@/server/integrations/canvas/ssrf";
import { looksLikePdf, sha256Hex } from "@/server/integrations/syllabus/pdf";

/** Injectable I/O for tests. */
export interface FetchDeps {
  fetchImpl: typeof fetch;
  /** all addresses for a hostname */
  lookup: (host: string) => Promise<string[]>;
}

/** Why a download was refused or failed. */
export type MediaFetchErrorCode =
  | "scheme"
  | "host"
  | "private_ip"
  | "redirect"
  | "status"
  | "too_large"
  | "not_pdf"
  | "timeout"
  | "network";

/** A refused or failed attachment download. */
export class MediaFetchError extends Error {
  code: MediaFetchErrorCode;
  status?: number;

  constructor(code: MediaFetchErrorCode, status?: number) {
    super(`media fetch failed: ${code}${status ? ` (${status})` : ""}`);
    this.name = "MediaFetchError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }

  /** Worth retrying later (network blips, timeouts, 5xx/429). */
  get retryable(): boolean {
    return (
      this.code === "timeout" ||
      this.code === "network" ||
      (this.code === "status" && this.status !== undefined && (this.status >= 500 || this.status === 429))
    );
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MAX_REDIRECTS = 2;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * True for anything that is not a globally routable unicast address (private, loopback,
 * link-local / cloud metadata, CGNAT, multicast, documentation, malformed…).
 * @param ip textual IPv4 or IPv6 address
 * @returns true when the address must not be fetched
 */
export function isPrivateAddress(ip: string): boolean {
  return !isPublicAddress(ip);
}

/**
 * Whether `host` is on the allowlist (exact match, or a `*.example.com` entry for subdomains).
 * @param host lowercase hostname
 * @param allowed allowlist entries
 * @returns true when allowed
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (e.startsWith("*.")) return host.endsWith(e.slice(1)) && host.length > e.length - 1;
    return e === host;
  });
}

const systemLookup = async (host: string): Promise<string[]> =>
  (await dnsPromises.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

async function checkHop(
  url: URL,
  allowedHosts: readonly string[],
  allowLocal: boolean,
  lookup: FetchDeps["lookup"],
): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = allowLocal && LOOPBACK_HOSTS.has(host);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new MediaFetchError("scheme");
  if (url.username || url.password) throw new MediaFetchError("host");
  if (!hostAllowed(host, allowedHosts)) throw new MediaFetchError("host");
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await lookup(host);
    } catch {
      throw new MediaFetchError("network");
    }
  }
  if (addrs.length === 0) throw new MediaFetchError("network");
  for (const a of addrs) {
    if (!isPrivateAddress(a)) continue;
    if (local && (a === "::1" || a.startsWith("127.") || a === "::ffff:127.0.0.1")) continue;
    throw new MediaFetchError("private_ip");
  }
}

async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let checkedMagic = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new MediaFetchError("too_large");
      chunks.push(value);
      if (!checkedMagic && total >= 5) {
        if (!looksLikePdf(Buffer.concat(chunks))) throw new MediaFetchError("not_pdf");
        checkedMagic = true;
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  const bytes = Buffer.concat(chunks);
  if (!looksLikePdf(bytes)) throw new MediaFetchError("not_pdf");
  return bytes;
}

/**
 * Download an attachment PDF under the SSRF policy above.
 * @param url the attachment URL from `messages.media[i].url`
 * @param opts byte cap, allowlist, overall timeout (default 20s), dev loopback allowance
 * @param deps injectable fetch and DNS lookup
 * @returns the bytes and their SHA-256
 * @throws MediaFetchError
 */
export async function fetchAttachmentPdf(
  url: string,
  opts: { maxBytes: number; allowedHosts: readonly string[]; timeoutMs?: number; allowLocal?: boolean },
  deps?: Partial<FetchDeps>,
): Promise<{ bytes: Buffer; sha256: string }> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const lookup = deps?.lookup ?? systemLookup;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new MediaFetchError("scheme");
  }

  try {
    for (let hop = 0; ; hop += 1) {
      await checkHop(current, opts.allowedHosts, opts.allowLocal === true, lookup);
      let res: Response;
      try {
        res = await fetchImpl(current, { method: "GET", redirect: "manual", signal, headers: { accept: "application/pdf,*/*" } });
      } catch (e) {
        if (signal.aborted) throw new MediaFetchError("timeout");
        if (e instanceof MediaFetchError) throw e;
        throw new MediaFetchError("network");
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc || hop >= MAX_REDIRECTS) throw new MediaFetchError("redirect");
        try {
          current = new URL(loc, current);
        } catch {
          throw new MediaFetchError("redirect");
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new MediaFetchError("status", res.status);
      }
      const declared = Number(res.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new MediaFetchError("too_large");
      }
      if (!res.body) throw new MediaFetchError("not_pdf");
      const bytes = await readCapped(res.body, opts.maxBytes);
      return { bytes, sha256: sha256Hex(bytes) };
    }
  } catch (e) {
    if (e instanceof MediaFetchError) throw e;
    if (signal.aborted) throw new MediaFetchError("timeout");
    throw new MediaFetchError("network");
  }
}
