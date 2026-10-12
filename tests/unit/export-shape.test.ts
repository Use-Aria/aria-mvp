/**
 * `shapeExport` (web plan §10): never emits secret-looking keys, keeps only allow-listed columns,
 * has a version and a timestamp, and coerces values to JSON.
 */
import { EXPORT_COLUMNS, FORBIDDEN_EXPORT_KEY, shapeExport, type RawExport } from "@/server/account/export";

const SECRETISH = /^enc_|token|hash/i;

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, inner] of Object.entries(v)) {
      out.push(k);
      allKeys(inner, out);
    }
  }
  return out;
}

describe("shapeExport", () => {
  const now = new Date("2026-10-10T15:00:00Z");
  const raw: RawExport = {
    users: [{ id: "u1", name: "Dan", timezone: "America/New_York", deleted_at: null, created_at: "2026-10-01T00:00:00Z" }],
    integrations: [
      {
        id: "i1",
        provider: "google",
        account_email: "dan@example.edu",
        scopes: ["a", "b"],
        status: "active",
        synced_at: null,
        enc_access_token: "v1:secret",
        enc_refresh_token: "v1:secret2",
        enc_ical_url: "v1:feed",
        gcal_channel_token_hash: "abc",
        feed_hash: "def",
        ical_url_fp: "fp",
        gmail_history_id: "123",
        token_expires_at: "2026-10-10T16:00:00Z",
      },
      { provider: "canvas_ical", status: "active", enc_ical_url: "v1:feed", ical_host: "canvas.yale.edu" },
    ],
    signups: [
      {
        id: "s1",
        name: "Dan",
        phone_e164: "+15551234567",
        ip: "1.2.3.4",
        user_agent: "Mozilla/5.0 (iPhone)",
        created_at: new Date("2026-10-02T00:00:00Z"),
        timezone: Number.NaN,
        matched_user_id: "u1",
      },
    ],
    messages: [{ id: "m1", direction: "in", body: "hi", created_at: "2026-10-09T00:00:00Z", idempotency_key: "k", media: null }],
  };
  const out = shapeExport(raw, now);

  it("has a version and an ISO timestamp", () => {
    expect(out.version).toBe(1);
    expect(out.exportedAt).toBe("2026-10-10T15:00:00.000Z");
  });

  it("never includes a key matching /^enc_|token|hash/ anywhere", () => {
    const keys = allKeys(out.tables);
    expect(keys.filter((k) => SECRETISH.test(k))).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/v1:secret|v1:feed/);
  });

  it("keeps only the allow-listed columns (integrations: provider, email, scopes, status, synced_at)", () => {
    expect(out.tables.integrations[0]).toEqual({
      provider: "google",
      account_email: "dan@example.edu",
      scopes: ["a", "b"],
      status: "active",
      synced_at: null,
    });
    expect(out.tables.integrations[1]).toEqual({ provider: "canvas_ical", status: "active" });
    expect(out.tables.users[0]).toEqual({ name: "Dan", timezone: "America/New_York", created_at: "2026-10-01T00:00:00Z" });
    expect(out.tables.messages[0]).toEqual({ direction: "in", body: "hi", created_at: "2026-10-09T00:00:00Z", media: null });
  });

  it("never exports a signup's IP address or user agent (5.5 #8)", () => {
    expect(EXPORT_COLUMNS.signups).not.toContain("ip");
    expect(EXPORT_COLUMNS.signups).not.toContain("user_agent");
    expect(FORBIDDEN_EXPORT_KEY.test("ip")).toBe(true);
    expect(FORBIDDEN_EXPORT_KEY.test("user_agent")).toBe(true);
    expect(FORBIDDEN_EXPORT_KEY.test("timezone_source")).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/1\.2\.3\.4|Mozilla/);
  });

  it("drops internal ids and foreign keys", () => {
    const keys = allKeys(out.tables);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("user_id");
    expect(keys).not.toContain("matched_user_id");
  });

  it("emits every table, empty ones as []", () => {
    expect(Object.keys(out.tables).sort()).toEqual(Object.keys(EXPORT_COLUMNS).sort());
    expect(out.tables.reminders).toEqual([]);
  });

  it("coerces values to JSON (Date → ISO, NaN → null)", () => {
    expect(out.tables.signups[0]).toEqual({
      name: "Dan",
      phone_e164: "+15551234567",
      created_at: "2026-10-02T00:00:00.000Z",
      timezone: null,
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("no allow-listed column is itself secret-looking", () => {
    for (const cols of Object.values(EXPORT_COLUMNS)) {
      for (const c of cols) expect(FORBIDDEN_EXPORT_KEY.test(c)).toBe(false);
    }
  });

  it("excludes internal tables", () => {
    for (const t of ["magic_links", "web_sessions", "jobs", "agent_runs", "llm_calls", "user_runtime", "conversation_summaries"]) {
      expect(out.tables).not.toHaveProperty(t);
    }
  });
});
