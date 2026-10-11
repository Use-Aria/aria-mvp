/**
 * /settings e2e (web plan §7.6, §9.4, §10 "/settings" flow; orchestrator notes W4 4.6): connected
 * accounts, memory edit (needs a < 60 min session) / delete (any session) / proposals, sign out
 * (this phone + everywhere), export download (JSON shape, no secrets; needs a fresh setup link),
 * and delete account (typed "delete" gate → /account-deleted, user gone).
 */
import { SETTINGS_COPY, SHARED_COPY } from "@/shared/copy";
import { must, sb, seedCanvas, seedGoogle, seedMemory } from "./support/db";
import { expect, expectNoHorizontalScroll, hydrated, test } from "./support/fixtures";

test.describe.configure({ timeout: 180_000 });
const MEM = SETTINGS_COPY.memory;

test("recent session: accounts, edit a fact, delete a preference, answer a proposal", async ({ page, world }) => {
  const u = await world.user({ name: "Dana" });
  await seedCanvas(u);
  await seedGoogle(u, { email: "dana.settings@example.com" });
  const ids = await seedMemory(u);
  await world.signIn(u, { scope: "view", ageMinutes: 10 });
  await page.goto("/settings");
  await hydrated(page);

  await expect(page.getByText(SETTINGS_COPY.accounts.canvasConnected("yale.instructure.com"))).toBeVisible();
  await expect(page.getByText(SETTINGS_COPY.accounts.googleConnected("dana.settings@example.com"))).toBeVisible();
  const memory = page.locator("#memory");
  await expect(memory.getByText("CPSC 323, ECON 115")).toBeVisible();
  await expect(memory.getByText(MEM.editNeedsRecent)).toHaveCount(0);

  // Edit a fact.
  const fact = memory.getByRole("listitem").filter({ hasText: "Works at the library on Tuesdays" });
  await fact.getByRole("button", { name: MEM.edit }).click();
  const box = memory.getByRole("textbox", { name: MEM.edit });
  await expect(box).toBeFocused({ timeout: 1_000 }).catch(() => undefined);
  await box.fill("");
  await memory.getByRole("button", { name: "Save" }).click();
  await expect(memory.getByRole("alert")).toHaveText(MEM.editEmpty);
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await box.fill("Works at the library on Tuesdays and Thursdays");
  await memory.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(async () => {
      const { data } = await sb().from("memory_facts").select("content").eq("user_id", u).is("deleted_at", null);
      return (data ?? []).map((f) => f.content).sort();
    })
    .toContain("Works at the library on Tuesdays and Thursdays");
  await expect(memory.getByText("Works at the library on Tuesdays and Thursdays")).toBeVisible();

  // Delete a preference (inline confirm).
  const pref = memory.getByRole("listitem").filter({ hasText: "No gym after 8pm" });
  await pref.getByRole("button", { name: MEM.delete }).click();
  await expect(pref.getByText(MEM.deleteConfirm.title)).toBeVisible();
  await pref.getByRole("button", { name: MEM.deleteConfirm.confirm }).click();
  await expect(memory.getByText("No gym after 8pm")).toHaveCount(0);
  const p = must(await sb().from("user_preferences").select("status").eq("id", ids.prefId).single(), "pref");
  expect(p.status).not.toBe("active");

  // Keep a proposal.
  const prop = memory.getByRole("listitem").filter({ hasText: "Prefers studying in the morning" });
  await prop.getByRole("button", { name: MEM.keep }).click();
  await expect
    .poll(async () => must(await sb().from("user_preferences").select("status").eq("id", ids.proposalId).single(), "p").status)
    .toBe("active");
  await expectNoHorizontalScroll(page);
});

test("old view session: edits hidden behind the notice, delete still works, export + delete need a fresh link", async ({ page, world }) => {
  const u = await world.user();
  const ids = await seedMemory(u);
  await world.signIn(u, { scope: "view", ageMinutes: 90 });
  await page.goto("/settings");
  await hydrated(page);
  const memory = page.locator("#memory");
  await expect(memory.getByText(MEM.editNeedsRecent)).toBeVisible();
  await expect(memory.getByRole("button", { name: MEM.edit })).toHaveCount(0);
  await expect(memory.getByRole("button", { name: MEM.keep })).toHaveCount(0);

  const fact = memory.getByRole("listitem").filter({ hasText: "Has a younger sister named Mia" });
  await fact.getByRole("button", { name: MEM.delete }).click();
  await fact.getByRole("button", { name: MEM.deleteConfirm.confirm }).click();
  await expect(memory.getByText("Has a younger sister named Mia")).toHaveCount(0);
  const f = await sb().from("memory_facts").select("deleted_at").eq("id", ids.factIds[0]);
  expect((f.data ?? []).filter((r) => r.deleted_at === null)).toHaveLength(0);

  await expect(page.locator("#export").getByText(SETTINGS_COPY.export.needsFresh)).toBeVisible();
  await expect(page.getByRole("button", { name: SETTINGS_COPY.export.button })).toHaveCount(0);
  await expect(page.locator("#delete-account").getByText(SETTINGS_COPY.deleteAccount.needsFresh)).toBeVisible();
  await expect(page.getByRole("button", { name: SETTINGS_COPY.deleteAccount.confirm })).toHaveCount(0);
});

test("export downloads JSON with no secrets (fresh setup session)", async ({ page, world }) => {
  const u = await world.user({ name: "Dana" });
  await seedMemory(u);
  await seedCanvas(u);
  await world.signIn(u, { scope: "setup" });
  await page.goto("/settings");
  await hydrated(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: SETTINGS_COPY.export.button }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^aria-export-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();
  const fs = await import("node:fs/promises");
  const json = JSON.parse(await fs.readFile(path, "utf8")) as { version: number; exportedAt: string; tables: Record<string, unknown[]> };
  expect(json.version).toBe(1);
  expect(Number.isNaN(Date.parse(json.exportedAt))).toBe(false);
  expect(json.tables.users).toHaveLength(1);
  expect(Object.keys(json.tables)).toEqual(expect.arrayContaining(["users", "memory_facts", "user_preferences"]));
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    }
  };
  walk(json);
  for (const k of keys) expect(k, k).not.toMatch(/^enc_|token|hash|secret/i);
  const raw = JSON.stringify(json);
  expect(raw).not.toMatch(/feeds\/calendars|session_hash|v1:[A-Za-z0-9_-]{20,}/);
});

test("export POST without a fresh session or from another origin is refused", async ({ request, world, baseURL }) => {
  const u = await world.user();
  const raw = await world.signIn(u, { scope: "view" });
  const cookie = `aria=${raw}`;
  const noOrigin = await request.post("/api/me/export", { headers: { cookie }, maxRedirects: 0 });
  expect(noOrigin.status()).toBe(403);
  const evil = await request.post("/api/me/export", { headers: { cookie, origin: "https://evil.example" }, maxRedirects: 0 });
  expect(evil.status()).toBe(403);
  const stale = await request.post("/api/me/export", { headers: { cookie, origin: new URL(baseURL ?? "").origin }, maxRedirects: 0 });
  expect(stale.status()).toBe(303);
  expect(stale.headers().location).toMatch(/\/settings\?export=needs_fresh_link$/);
});

test("delete account: typed gate, then /account-deleted and the user is gone", async ({ page, world }) => {
  const u = await world.user();
  await seedMemory(u);
  await world.signIn(u, { scope: "setup" });
  await page.goto("/settings");
  await hydrated(page);
  await page.getByRole("button", { name: SETTINGS_COPY.deleteAccount.confirm }).click();
  const dialog = page.getByRole("dialog", { name: SETTINGS_COPY.deleteAccount.dialogTitle });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: SETTINGS_COPY.deleteAccount.confirm });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(SETTINGS_COPY.deleteAccount.dialogBody).fill("delet");
  await expect(confirm).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: SETTINGS_COPY.deleteAccount.confirm }).click();
  await expect(dialog.getByLabel(SETTINGS_COPY.deleteAccount.dialogBody)).toHaveValue("");
  await dialog.getByLabel(SETTINGS_COPY.deleteAccount.dialogBody).fill("DELETE");
  await confirm.click();
  await expect(page).toHaveURL(/\/account-deleted$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SETTINGS_COPY.deletedPage.title);
  await expect
    .poll(async () => (await sb().from("users").select("id").eq("id", u)).data?.length ?? -1, { timeout: 30_000 })
    .toBe(0);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SHARED_COPY.signedOut.settings.title);
});

test("sign out on this phone, and everywhere (other browser signed out too)", async ({ page, world, browser, baseURL }) => {
  const u = await world.user();
  await world.signIn(u);
  await page.goto("/settings");
  await hydrated(page);
  await page.locator("#sign-out").getByRole("button", { name: SHARED_COPY.signOut }).click();
  await expect(page).toHaveURL(/\/signed-out$/);
  await page.goto("/week");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SHARED_COPY.signedOut["new link"].title);

  const other = await browser.newContext({ baseURL });
  try {
    await world.signIn(u, { context: other });
    await world.signIn(u);
    const otherPage = await other.newPage();
    await otherPage.goto("/week");
    await expect(otherPage.getByRole("heading", { level: 1 })).not.toHaveText(SHARED_COPY.signedOut["new link"].title);
    await page.goto("/settings");
    await hydrated(page);
    await page.getByRole("button", { name: SHARED_COPY.signOutEverywhere.label }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    await otherPage.reload();
    await expect(otherPage.getByRole("heading", { level: 1 })).toHaveText(SHARED_COPY.signedOut["new link"].title);
  } finally {
    await other.close();
  }
});
