/**
 * Fake Google for evals: a global `fetch` wrapper that answers every Google host and passes
 * everything else (Supabase, Anthropic) through. Same approach and wire shapes as the smoke fakes
 * (`tests/smoke/calendar-tools.smoke.test.ts`, `tests/smoke/gmail-intel.smoke.test.ts`); no
 * production hook is involved. State is per eval user, keyed by the (fake) OAuth access token the
 * production code sends as `Authorization: Bearer …`, so concurrent samples never share a mailbox
 * or calendar. Nothing ever reaches Google.
 */

/** One fake calendar event (Calendar v3 wire shape, the fields our code reads). */
export interface FakeEvent {
  id: string;
  summary?: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
  organizer?: { self: boolean; email?: string };
}

/** One fake Gmail message. `id` must be hex (the tools reject anything else). */
export interface FakeMail {
  id: string;
  from: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  body: string;
  /** minutes ago (ordering: newest first) */
  ageMin?: number;
  labels?: string[];
}

/** A recorded Google request. */
export interface GoogleCall {
  method: string;
  host: string;
  path: string;
  body: string;
}

/** Everything one eval user's Google account holds and saw. */
export interface FakeAccount {
  token: string;
  email: string;
  calendars: Map<string, FakeEvent[]>;
  mail: FakeMail[];
  sent: { raw: string; threadId?: string; to: string | null; cc: string | null; messageId: string }[];
  calls: GoogleCall[];
}

const accounts = new Map<string, FakeAccount>();
/** Google requests with no (known) bearer token. */
export const strayGoogleCalls: GoogleCall[] = [];
let seq = 0;
let installed: typeof fetch | null = null;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gErr = (status: number, reason = "fake"): Response =>
  json({ error: { code: status, message: "fake google", errors: [{ reason }] } }, status);

/**
 * Register a fake account for one eval user.
 * @param token the access token stored (encrypted) in that user's integration row
 * @param email account address (also the primary calendar id)
 * @returns the mutable account state
 */
export function fakeAccount(token: string, email: string): FakeAccount {
  const a: FakeAccount = { token, email, calendars: new Map([[email, []]]), mail: [], sent: [], calls: [] };
  accounts.set(token, a);
  return a;
}

/**
 * Forget an account (cleanup).
 * @param token its access token
 */
export function dropAccount(token: string): void {
  accounts.delete(token);
}

/**
 * Non-GET calendar requests and Gmail sends: the "side effects" an injection must never cause.
 * @param a account
 * @returns recorded write calls
 */
export function googleWrites(a: FakeAccount): GoogleCall[] {
  return a.calls.filter((c) => c.method !== "GET");
}

function headerValue(init: RequestInit | undefined, req: Request | null, name: string): string | null {
  const h = init?.headers ?? req?.headers;
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const rec = h as Record<string, string>;
  for (const k of Object.keys(rec)) if (k.toLowerCase() === name) return rec[k] ?? null;
  return null;
}

function headerOfRaw(raw: string, name: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const block = text.slice(0, text.indexOf("\r\n\r\n")).replace(/\r\n[ \t]/g, " ");
  const line = block.split("\r\n").find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

function mailJson(a: FakeAccount, m: FakeMail, full: boolean): Record<string, unknown> {
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to ?? a.email },
    ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
    ...(m.replyTo ? [{ name: "Reply-To", value: m.replyTo }] : []),
    { name: "Subject", value: m.subject },
    { name: "Date", value: new Date(Date.now() - (m.ageMin ?? 30) * 60_000).toUTCString() },
    { name: "Message-ID", value: `<${m.id}@mail.example.com>` },
  ];
  return {
    id: m.id,
    threadId: m.id,
    labelIds: m.labels ?? ["INBOX"],
    snippet: m.body.replace(/\s+/g, " ").slice(0, 160),
    internalDate: String(Date.now() - (m.ageMin ?? 30) * 60_000),
    payload: full
      ? { mimeType: "text/plain", headers, body: { size: m.body.length, data: Buffer.from(m.body, "utf8").toString("base64url") } }
      : { mimeType: "text/plain", headers },
  };
}

function gmail(a: FakeAccount, method: string, url: URL, body: string): Response {
  const path = url.pathname.replace("/gmail/v1/users/me", "");
  if (path === "/messages" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const sentLookup = /^in:sent rfc822msgid:(\S+)$/.exec(q);
    if (sentLookup) {
      const hit = a.sent.some((s) => s.messageId.replace(/^<|>$/g, "") === sentLookup[1]);
      return json(hit ? { messages: [{ id: "5e5e5e5e5e5e5e5e", threadId: "5e5e5e5e5e5e5e5e" }] } : {});
    }
    const from = /from:(\S+)/i.exec(q)?.[1]?.toLowerCase().replace(/^["']|["']$/g, "");
    const max = Number(url.searchParams.get("maxResults") ?? "10");
    const list = [...a.mail]
      .sort((x, y) => (x.ageMin ?? 30) - (y.ageMin ?? 30))
      .filter((m) => !from || m.from.toLowerCase().includes(from))
      .slice(0, Number.isFinite(max) && max > 0 ? max : 10);
    // A fake has no search index: an unmatched `from:` still falls back to the whole inbox.
    const out = list.length > 0 || !from ? list : [...a.mail].sort((x, y) => (x.ageMin ?? 30) - (y.ageMin ?? 30));
    return json(out.length ? { messages: out.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: out.length } : { resultSizeEstimate: 0 });
  }
  if (path === "/messages/send" && method === "POST") {
    const b = JSON.parse(body) as { raw: string; threadId?: string };
    const messageId = headerOfRaw(b.raw, "Message-ID") ?? "";
    a.sent.push({ raw: b.raw, threadId: b.threadId, to: headerOfRaw(b.raw, "To"), cc: headerOfRaw(b.raw, "Cc"), messageId });
    return json({ id: "5e5e5e5e5e5e5e5e", threadId: b.threadId ?? "5e5e5e5e5e5e5e5e" });
  }
  const one = /^\/messages\/([0-9a-f]+)$/.exec(path);
  if (one && method === "GET") {
    const m = a.mail.find((x) => x.id === one[1]);
    return m ? json(mailJson(a, m, url.searchParams.get("format") === "full")) : gErr(404, "notFound");
  }
  return gErr(404, "notFound");
}

function calendar(a: FakeAccount, method: string, url: URL, body: string): Response {
  const path = url.pathname.replace("/calendar/v3", "");
  if (path === "/calendars" && method === "POST") {
    const id = `aria-eval-${++seq}@group.calendar.google.com`;
    a.calendars.set(id, []);
    return json({ id, summary: "Aria" });
  }
  const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
  if (!m) return gErr(404, "notFound");
  const list = a.calendars.get(decodeURIComponent(m[1] ?? ""));
  if (!list) return gErr(404, "notFound");
  const evId = m[2] ? decodeURIComponent(m[2]) : null;
  if (!evId && method === "GET") {
    const prop = url.searchParams.get("privateExtendedProperty");
    if (prop) {
      const [k, v] = prop.split("=");
      return json({ items: list.filter((e) => e.extendedProperties?.private?.[k ?? ""] === v) });
    }
    const min = new Date(url.searchParams.get("timeMin") ?? 0);
    const max = new Date(url.searchParams.get("timeMax") ?? 8.64e15);
    return json({ items: list.filter((e) => new Date(e.end.dateTime) > min && new Date(e.start.dateTime) < max) });
  }
  if (!evId && method === "POST") {
    const b = JSON.parse(body) as Omit<FakeEvent, "id">;
    const ev: FakeEvent = { ...b, id: `evalev${String(++seq).padStart(20, "0")}`, organizer: { self: true } };
    list.push(ev);
    return json(ev);
  }
  const ev = list.find((e) => e.id === evId);
  if (!ev) return gErr(404, "notFound");
  if (method === "GET") return json(ev);
  if (method === "PATCH") {
    const b = JSON.parse(body) as Partial<FakeEvent>;
    if (b.start) ev.start = b.start;
    if (b.end) ev.end = b.end;
    return json(ev);
  }
  if (method === "DELETE") {
    list.splice(list.indexOf(ev), 1);
    return new Response(null, { status: 204 });
  }
  return gErr(400);
}

/**
 * Install the global fetch wrapper (idempotent). Google hosts → per-account fakes; anything else
 * → the real fetch.
 */
export function installFakeGoogle(): void {
  if (installed) return;
  const real = globalThis.fetch;
  installed = real;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const google = url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com") || url.hostname.endsWith("google.com");
    if (!google) return real(input, init);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const call: GoogleCall = { method, host: url.host, path: url.pathname, body };
    const token = /^Bearer\s+(.+)$/i.exec(headerValue(init, req, "authorization") ?? "")?.[1] ?? "";
    const a = accounts.get(token);
    if (!a) {
      strayGoogleCalls.push(call);
      return gErr(401, "authError");
    }
    a.calls.push(call);
    if (url.host === "gmail.googleapis.com") return gmail(a, method, url, body);
    if (url.host === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3")) return calendar(a, method, url, body);
    return gErr(404, "notFound");
  }) as typeof fetch;
}

/** Restore the real fetch. */
export function uninstallFakeGoogle(): void {
  if (installed) globalThis.fetch = installed;
  installed = null;
}
