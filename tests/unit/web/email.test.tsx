/**
 * /email/[id] (task 4.5, web plan §11 W9): draft view model, form parsing (recipients never
 * accepted from the web), error copy, and the editor's static render (read-only recipients,
 * hidden version, preserved newlines, escaped hostile text).
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingActionView } from "@/server/agent/pending/types";
import {
  failureCodeOf,
  formatDraftTime,
  isDraftId,
  parseDraftEdit,
  parseDraftRef,
  toDraftView,
} from "@/server/web/email-data";
import { ACTION_ERROR_CODES } from "@/shared/action-result";
import { ACTION_ERROR_COPY, EMAIL_COPY, SHARED_COPY } from "@/shared/copy";

jest.mock("@/app/(app)/email/[id]/actions", () => ({
  saveDraftAction: jest.fn(),
  sendDraftAction: jest.fn(),
  cancelDraftAction: jest.fn(),
}));

import { DraftEditor, DraftErrorBanner, draftErrorCopy } from "@/app/(app)/email/[id]/DraftEditor";

const ID = "8d1f7a52-3c2b-4b8e-9a51-0f6f2a7c9e11";
const TZ = "America/New_York";

function action(over: Partial<PendingActionView> = {}): PendingActionView {
  return {
    id: ID,
    kind: "send_email",
    version: 3,
    status: "pending",
    payload: {
      v: 1,
      from: "dan@example.edu",
      to: ["lee@example.edu"],
      cc: ["ta@example.edu"],
      subject: "Essay ‮extension",
      body_text: "Hi Professor Lee,\r\n\r\nCould I have until Friday?\r\n\r\nDan",
      original_rfc822_id: "<CAF=abc@mail.gmail.com>",
    },
    summary: "email to Prof. Lee",
    createdAt: new Date("2026-10-10T18:00:00Z"),
    expiresAt: new Date("2026-10-10T19:10:00Z"),
    decidedAt: null,
    decidedVia: null,
    result: null,
    error: null,
    ...over,
  };
}

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("isDraftId / formatDraftTime", () => {
  it("accepts only UUIDs", () => {
    expect(isDraftId(ID)).toBe(true);
    expect(isDraftId("not-a-uuid")).toBe(false);
    expect(isDraftId(`${ID}/../x`)).toBe(false);
    expect(isDraftId(undefined)).toBe(false);
  });

  it("formats weekday + clock in the user's zone", () => {
    expect(formatDraftTime(new Date("2026-10-10T19:10:00Z"), TZ)).toBe("Sat 3:10 PM");
  });
});

describe("toDraftView", () => {
  it("maps a pending draft: cleaned subject, LF body, permalink, labels", () => {
    const v = toDraftView(action(), { timezone: TZ, recent: true });
    expect(v).toMatchObject({
      id: ID,
      version: 3,
      status: "pending",
      from: "dan@example.edu",
      to: ["lee@example.edu"],
      cc: ["ta@example.edu"],
      subject: "Essay extension",
      body: "Hi Professor Lee,\n\nCould I have until Friday?\n\nDan",
      expiresAtLabel: "Sat 3:10 PM",
      decidedAtLabel: null,
      sentAtLabel: null,
      failureCode: null,
      canSend: true,
    });
    expect(v?.originalPermalink).toBe("https://mail.google.com/mail/#search/rfc822msgid%3A%3CCAF%3Dabc%40mail.gmail.com%3E");
  });

  it("maps every status", () => {
    const cases: Array<[PendingActionView["status"], string]> = [
      ["pending", "pending"],
      ["executing", "sending"],
      ["done", "sent"],
      ["cancelled", "cancelled"],
      ["expired", "expired"],
      ["failed", "failed"],
    ];
    for (const [status, expected] of cases) {
      expect(toDraftView(action({ status }), { timezone: TZ, recent: false })?.status).toBe(expected);
    }
  });

  it("uses the executor's sent_at for a sent draft, else the decision time", () => {
    const decidedAt = new Date("2026-10-10T19:00:00Z");
    expect(
      toDraftView(action({ status: "done", decidedAt, result: { sent_at: "2026-10-10T19:02:00Z" } }), { timezone: TZ, recent: true })
        ?.sentAtLabel,
    ).toBe("Sat 3:02 PM");
    expect(toDraftView(action({ status: "done", decidedAt }), { timezone: TZ, recent: true })?.sentAtLabel).toBe("Sat 3:00 PM");
  });

  it("a failed draft carries a known failure code only (never the stored error text)", () => {
    const view = (over: Partial<PendingActionView>) => toDraftView(action(over), { timezone: TZ, recent: true });
    expect(view({ status: "failed", error: "google_disconnected" })?.failureCode).toBe("google_disconnected");
    expect(view({ status: "failed", error: "interrupted" })?.failureCode).toBe("executor_failed");
    expect(view({ status: "failed", error: "executor_threw:TypeError" })?.failureCode).toBe("executor_failed");
    expect(view({ status: "failed", error: null })?.failureCode).toBe("executor_failed");
    // Not failed → no code, whatever `error` holds (e.g. a superseded cancel).
    expect(view({ status: "cancelled", error: "superseded" })?.failureCode).toBeNull();
    expect(view({ status: "pending", error: "google_disconnected" })?.failureCode).toBeNull();
    expect(failureCodeOf("GOOGLE_DISCONNECTED")).toBe("executor_failed");
    const raw = JSON.stringify(view({ status: "failed", error: "executor_threw:SecretishError" }));
    expect(raw).not.toContain("SecretishError");
  });

  it("a sending draft whose send Gmail didn't confirm carries send_unconfirmed; a running one carries nothing", () => {
    const view = (over: Partial<PendingActionView>) => toDraftView(action(over), { timezone: TZ, recent: true });
    expect(view({ status: "executing", error: "send_unconfirmed:timeout" })).toMatchObject({ status: "sending", failureCode: "send_unconfirmed" });
    expect(view({ status: "executing", error: "send_unconfirmed" })?.failureCode).toBe("send_unconfirmed");
    expect(view({ status: "executing", error: null })).toMatchObject({ status: "sending", failureCode: null });
    expect(view({ status: "executing", error: "send_unconfirmedX" })?.failureCode).toBeNull();
    expect(view({ status: "pending", error: "send_unconfirmed:503" })?.failureCode).toBeNull();
  });

  it("refuses non-email actions and unparseable payloads", () => {
    expect(toDraftView(action({ kind: "delete_account", payload: {} }), { timezone: TZ, recent: true })).toBeNull();
    expect(toDraftView(action({ payload: { v: 1 } }), { timezone: TZ, recent: true })).toBeNull();
  });

  it("no permalink without the original Message-ID; canSend follows recency", () => {
    const p = { ...(action().payload as Record<string, unknown>) };
    delete p.original_rfc822_id;
    const v = toDraftView(action({ payload: p }), { timezone: TZ, recent: false });
    expect(v?.originalPermalink).toBeNull();
    expect(v?.canSend).toBe(false);
  });
});

describe("parseDraftEdit / parseDraftRef", () => {
  it("reads only id, version, subject, body (recipients are ignored)", () => {
    const r = parseDraftEdit(form({ id: ID, version: "3", subject: "Re: essay", body: "a\r\nb", to: "evil@example.com", cc: "x@y.z" }));
    expect(r).toEqual({ id: ID, version: 3, subject: "Re: essay", body: "a\nb" });
    expect(Object.keys(r ?? {})).toEqual(["id", "version", "subject", "body"]);
  });

  it("rejects bad ids, versions, CR/LF subjects, and oversize fields", () => {
    expect(parseDraftEdit(form({ id: "x", version: "3", subject: "s", body: "b" }))).toBeNull();
    expect(parseDraftEdit(form({ id: ID, version: "0", subject: "s", body: "b" }))).toBeNull();
    expect(parseDraftEdit(form({ id: ID, version: "1.5", subject: "s", body: "b" }))).toBeNull();
    expect(parseDraftEdit(form({ id: ID, version: "3", subject: "a\nBcc: x@y.z", body: "b" }))).toBeNull();
    expect(parseDraftEdit(form({ id: ID, version: "3", subject: "s".repeat(251), body: "b" }))).toBeNull();
    expect(parseDraftEdit(form({ id: ID, version: "3", subject: "s", body: "b".repeat(20_001) }))).toBeNull();
    expect(parseDraftEdit(form({ id: ID, version: "3", body: "b" }))).toBeNull();
  });

  it("parses send refs", () => {
    expect(parseDraftRef(form({ id: ID, version: "7" }))).toEqual({ id: ID, version: 7 });
    expect(parseDraftRef(form({ id: ID }))).toBeNull();
  });
});

describe("draftErrorCopy", () => {
  it("has copy for every action error code; stale links ask for a draft link", () => {
    for (const code of ACTION_ERROR_CODES) expect(draftErrorCopy(code).text.length).toBeGreaterThan(10);
    expect(draftErrorCopy("needs_recent_link").text).toBe(SHARED_COPY.recentLinkNeeded("draft link"));
    expect(draftErrorCopy("version_conflict").tone).toBe("warn");
    expect(draftErrorCopy("google_disconnected").text).toMatch(/Google isn't connected/);
  });

  it("send_unconfirmed is a warning that says to check the Sent folder (never 'already sent or canceled')", () => {
    expect(draftErrorCopy("send_unconfirmed")).toEqual({
      tone: "warn",
      text: "Gmail hasn't confirmed this one yet. It may already be sent — check your Sent folder before trying again.",
    });
    expect(draftErrorCopy("send_unconfirmed").text).not.toBe(draftErrorCopy("not_pending").text);
  });
});

describe("DraftErrorBanner", () => {
  it("google_disconnected: specific copy + Open Setup link; executor_failed: the generic failed copy", () => {
    const gd = renderToStaticMarkup(<DraftErrorBanner code="google_disconnected" />);
    expect(gd).toContain(ACTION_ERROR_COPY.google_disconnected.replace(/'/g, "&#x27;"));
    expect(gd).toContain('href="/setup#google"');
    expect(gd).toContain('role="alert"');
    const ef = renderToStaticMarkup(<DraftErrorBanner code="executor_failed" />);
    expect(ef).toContain(EMAIL_COPY.failed.replace(/'/g, "&#x27;").replace(/"/g, "&quot;"));
    expect(ef).not.toContain("/setup");
  });
});

describe("DraftEditor render", () => {
  const hostile = action({
    payload: {
      ...(action().payload as Record<string, unknown>),
      subject: "<img src=x onerror=alert(1)>",
      body_text: "line 1\n<script>alert(1)</script>\nline 3",
    },
  });

  it("renders subject/body only (no recipient inputs), the hidden version, and escapes hostile text", () => {
    const draft = toDraftView(hostile, { timezone: TZ, recent: true });
    if (!draft) throw new Error("draft");
    const html = renderToStaticMarkup(<DraftEditor draft={draft} />);
    expect(html).toContain('name="subject"');
    expect(html).toContain('name="body"');
    expect(html).not.toMatch(/name="(to|cc|from)"/);
    expect(html).toContain('name="version" value="3"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("line 1\n&lt;script&gt;alert(1)&lt;/script&gt;\nline 3");
    expect(html).toContain("Send email");
    expect(html).toContain("Save changes");
  });

  it("is read-only without Save/Send for a stale session, but Cancel stays", () => {
    const draft = toDraftView(action(), { timezone: TZ, recent: false });
    if (!draft) throw new Error("draft");
    const html = renderToStaticMarkup(<DraftEditor draft={draft} />);
    expect(html.match(/readonly=""/gi)).toHaveLength(2);
    expect(html).not.toContain("Send email");
    expect(html).not.toContain("Save changes");
    expect(html).toContain("Cancel draft");
  });
});
