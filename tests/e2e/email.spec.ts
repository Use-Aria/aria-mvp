/**
 * /email/[id] e2e (web plan §7.7, §9.5, §10 "/email/[id]" flow; orchestrator notes W4 4.5):
 * recipients read-only, edit + save bumps the version (recipients untouched), Send blocked while
 * dirty, a chat revision → `version_conflict` with the latest version shown, a double-clicked Send
 * confirms exactly once (no Google row → the executor fails closed with `google_disconnected`, so
 * nothing reaches the network), stale sessions can't edit/send, every non-pending status, cancel,
 * and 404s (bad id, other user's draft).
 */
import { randomUUID } from "node:crypto";
import { ACTION_ERROR_COPY, EMAIL_COPY, SHARED_COPY } from "@/shared/copy";
import { DRAFT_PAYLOAD, must, sb, seedDraft } from "./support/db";
import { expect, expectNoHorizontalScroll, hydrated, test } from "./support/fixtures";

test.describe.configure({ timeout: 180_000 });

async function row(id: string) {
  return must(
    await sb().from("pending_actions").select("status, version, payload, error, decided_via, executed_at").eq("id", id).single(),
    "draft",
  );
}

test("edit + save bumps the version; recipients are read-only; send blocked while dirty", async ({ page, world }) => {
  const u = await world.user();
  const id = await seedDraft(u);
  await world.signIn(u, { ageMinutes: 5 });
  await page.goto(`/email/${id}`);
  await hydrated(page);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(EMAIL_COPY.title);
  await expect(page.getByText("lee@example.edu")).toBeVisible();
  await expect(page.getByText("ta@example.edu")).toBeVisible();
  await expect(page.getByText(EMAIL_COPY.recipientsHint)).toBeVisible();
  // No control carries a recipient.
  const controls = await page.locator("input:not([type=hidden]), textarea, select").evaluateAll((els) =>
    els.map((e) => (e as HTMLInputElement).value),
  );
  expect(controls.join("\n")).not.toContain("lee@example.edu");
  await expect(page.getByText(/^This draft expires at /)).toBeVisible();

  const subject = page.getByLabel(EMAIL_COPY.subjectLabel);
  const body = page.getByLabel(EMAIL_COPY.bodyLabel);
  await expect(subject).toHaveValue(DRAFT_PAYLOAD.subject);
  await expect(body).toHaveValue(DRAFT_PAYLOAD.body_text);
  const save = page.getByRole("button", { name: EMAIL_COPY.save.idle });
  const send = page.getByRole("button", { name: EMAIL_COPY.send.idle });
  await expect(save).toBeDisabled();
  await expect(send).toBeEnabled();

  await subject.fill("Essay extension request");
  await body.fill("Hi Professor Lee,\n\nCould I have until Monday?\n\nThanks,\nDana");
  await expect(send).toBeDisabled();
  await expect(page.getByText(EMAIL_COPY.sendBlockedDirty)).toBeVisible();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: EMAIL_COPY.save.done })).toBeVisible();
  await expect(send).toBeEnabled();
  const r = await row(id);
  expect(r.version).toBe(2);
  expect(r.payload).toMatchObject({
    subject: "Essay extension request",
    body_text: "Hi Professor Lee,\n\nCould I have until Monday?\n\nThanks,\nDana",
    to: DRAFT_PAYLOAD.to,
    cc: DRAFT_PAYLOAD.cc,
  });
  await page.reload();
  await expect(page.getByLabel(EMAIL_COPY.bodyLabel)).toHaveValue(/until Monday\?\n\nThanks,\nDana$/);
  await expectNoHorizontalScroll(page);
});

test("a chat revision while the page is open → version_conflict shows the latest version", async ({ page, world }) => {
  const u = await world.user();
  const id = await seedDraft(u);
  await world.signIn(u, { ageMinutes: 5 });
  await page.goto(`/email/${id}`);
  await hydrated(page);
  // Aria revises the draft in chat (version bump) after the page loaded.
  must(
    await sb()
      .from("pending_actions")
      .update({ version: 2, payload: { ...DRAFT_PAYLOAD, subject: "Revised in chat" } })
      .eq("id", id)
      .select("id")
      .single(),
    "revise",
  );
  await page.getByRole("button", { name: EMAIL_COPY.send.idle }).click();
  await expect(page.getByText(/This draft changed in your chat with Aria/)).toBeVisible();
  await expect(page.getByLabel(EMAIL_COPY.subjectLabel)).toHaveValue("Revised in chat");
  expect((await row(id)).status).toBe("pending");
});

test("double-clicked Send confirms exactly once; without Google it fails closed", async ({ page, world }) => {
  const u = await world.user();
  const id = await seedDraft(u);
  await world.signIn(u, { ageMinutes: 5 });
  await page.goto(`/email/${id}`);
  await hydrated(page);
  const actionPosts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.headers()["next-action"]) actionPosts.push(req.url());
  });
  await page.getByRole("button", { name: EMAIL_COPY.send.idle }).dblclick();
  await expect.poll(async () => (await row(id)).status).toMatch(/^(failed|done)$/);
  const r = await row(id);
  expect(r).toMatchObject({ status: "failed", error: "google_disconnected", decided_via: "web" });
  expect(actionPosts).toHaveLength(1);
  // The page re-renders the terminal state, read-only, and keeps the specific reason + Setup link
  // (DraftView.failureCode survives the post-Send refresh), not the generic "Gmail didn't accept".
  const alert = page.getByRole("alert").filter({ hasText: ACTION_ERROR_COPY.google_disconnected });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("link", { name: "Open Setup" })).toHaveAttribute("href", "/setup#google");
  await expect(page.getByText(EMAIL_COPY.failed)).toHaveCount(0);
  // A reload (fresh server render, no client action state) shows the same reason.
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: ACTION_ERROR_COPY.google_disconnected })).toBeVisible();
  await expect(page.getByLabel(EMAIL_COPY.subjectLabel)).toHaveCount(0);
  await expect(page.getByText(DRAFT_PAYLOAD.subject)).toBeVisible();
});

test("a > 60 min session can read but not edit or send; cancel still works", async ({ page, world }) => {
  const u = await world.user();
  const id = await seedDraft(u);
  await world.signIn(u, { ageMinutes: 90 });
  await page.goto(`/email/${id}`);
  await hydrated(page);
  await expect(page.getByText(SHARED_COPY.recentLinkNeeded("draft link"))).toBeVisible();
  await expect(page.getByLabel(EMAIL_COPY.subjectLabel)).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: EMAIL_COPY.send.idle })).toHaveCount(0);
  await expect(page.getByRole("button", { name: EMAIL_COPY.save.idle })).toHaveCount(0);

  await page.getByRole("button", { name: EMAIL_COPY.cancel.button }).click();
  const dialog = page.getByRole("dialog", { name: EMAIL_COPY.cancel.title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: EMAIL_COPY.cancel.confirm }).click();
  await expect(page.getByText(EMAIL_COPY.cancelled)).toBeVisible();
  expect((await row(id)).status).toBe("cancelled");
});

test("every non-pending status renders read-only with its copy", async ({ page, world }) => {
  const u = await world.user();
  const cases: Array<[Parameters<typeof seedDraft>[1], RegExp | string]> = [
    [{ status: "executing" }, "Sending now. Reload in a minute to see whether it went out."],
    [{ status: "done", result: { sent_at: new Date().toISOString() } }, /^Sent at .+\. Aria also confirmed it in Messages\.$/],
    [{ status: "cancelled" }, EMAIL_COPY.cancelled],
    [{ status: "expired" }, EMAIL_COPY.expired],
    [{ status: "failed" }, EMAIL_COPY.failed],
  ];
  await world.signIn(u, { ageMinutes: 5 });
  for (const [over, copy] of cases) {
    const id = await seedDraft(u, over);
    await page.goto(`/email/${id}`);
    await expect(page.getByText(copy), String(over?.status)).toBeVisible();
    await expect(page.getByLabel(EMAIL_COPY.subjectLabel)).toHaveCount(0);
    await expect(page.getByRole("button", { name: EMAIL_COPY.send.idle })).toHaveCount(0);
    // Body newlines preserved in the read-only view.
    const bodyText = await page.locator("p.whitespace-pre-wrap").first().innerText();
    expect(bodyText).toContain("Hi Professor Lee,\n\nCould I have");
  }
});

test("404 for a bad id, an unknown id, and another user's draft", async ({ page, world }) => {
  const owner = await world.user();
  const other = await world.user();
  const id = await seedDraft(owner);
  await world.signIn(other, { ageMinutes: 5 });
  const statuses: number[] = [];
  for (const path of [`/email/not-a-uuid`, `/email/${randomUUID()}`, `/email/${id}`]) {
    const res = await page.goto(path);
    // (app)/loading.tsx makes the page stream, so a notFound() thrown after the shell flushed
    // keeps status 200 (Next soft 404) — the not-found UI and noindex still render.
    statuses.push(res?.status() ?? 0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(SHARED_COPY.notFound.title);
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
    await expect(page.locator("body")).not.toContainText(DRAFT_PAYLOAD.subject);
  }
  test.info().annotations.push({ type: "404 statuses", description: statuses.join(",") });
  for (const s of statuses) expect([200, 404]).toContain(s);
});
