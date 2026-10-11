/**
 * Every page the web app renders, with the seed each needs (signed-in pages create a user with
 * realistic data and sign the given context in). Shared by the layout/a11y sweep (`pages.spec.ts`)
 * and the screenshot set (`shots.spec.ts`), so both cover the same pages.
 */
import type { BrowserContext } from "@playwright/test";
import { localAt, localDay, seedCanvas, seedDraft, seedGoogle, seedMemory, seedTimeline, ALL_GOOGLE_SCOPES } from "./db";
import type { World } from "./fixtures";

export interface PageCase {
  /** File-safe name. */
  name: string;
  /** Path for pages that need no data. */
  path?: string;
  /**
   * Seeds what the page needs; returns the owner and the path. Sign-in is separate (`session`),
   * so one seed can serve several browser contexts.
   */
  seed?: (world: World, timezone: string) => Promise<{ userId: string; path: string }>;
  /** Session to sign each context in with (defaults to a fresh view session). */
  session?: { scope?: "view" | "setup"; ageMinutes?: number };
}

/**
 * Seeds (once) and returns the path; signs `context` in when the page needs a user.
 * @param pc the page case
 * @param world fixture
 * @param context browser context to sign in
 * @param tz zone for seeded data
 * @param seeded cache of a previous seed for this case (pass the same object across contexts)
 * @returns the path to open
 */
export async function openCase(
  pc: PageCase,
  world: World,
  context: BrowserContext,
  tz: string,
  seeded: { value?: { userId: string; path: string } } = {},
): Promise<string> {
  if (!pc.seed) return pc.path ?? "/";
  seeded.value ??= await pc.seed(world, tz);
  await world.signIn(seeded.value.userId, { context, ...(pc.session ?? {}) });
  return seeded.value.path;
}

const TZ = "America/New_York";

async function richWeek(world: World, tz: string): Promise<{ userId: string; path: string }> {
  const u = await world.user({ name: "Alexandria-Josephine", timezone: tz });
  await seedCanvas(u);
  await seedTimeline(
    u,
    [
      { title: "Problem Set 4: Dynamic programming and memoization (long title to test wrapping)", dueAt: localAt(tz, 0, 23, 59), course: "CPSC 365" },
      { title: "Reading response", dueAt: localAt(tz, 1, 9, 0), course: "HIST 101", url: "https://yale.instructure.com/courses/1/assignments/2" },
      { title: "Midterm", kind: "exam", dueAt: localAt(tz, 2, 9, 0), course: "ECON 115" },
      { title: "Essay draft", dueAt: localAt(tz, 2, 9, 0), course: "ENGL 120" },
      { title: "Lab report", allDayDate: localDay(tz, 3), course: "CHEM 161" },
      { title: `<img src=x onerror=alert(1)> https://averyveryveryverylongunbrokenurl.example.com/path/segment`, dueAt: localAt(tz, 3, 17, 0) },
      { title: "Late pset", dueAt: localAt(tz, -1, 17, 0), course: "MATH 225" },
      { title: "Finished thing", dueAt: localAt(tz, 0, 12, 0), status: "done" },
      { title: "CPSC 323 lecture", kind: "class", source: "gcal", startsAt: localAt(tz, 1, 10, 30), endsAt: localAt(tz, 1, 11, 45) },
      { title: "Study block", kind: "block", source: "aria", startsAt: localAt(tz, 1, 14, 0), endsAt: localAt(tz, 1, 15, 30) },
    ],
    tz,
  );
  return { userId: u, path: "/week" };
}

/** Pages in the sweep and the shots set. */
export const PAGE_CASES: PageCase[] = [
  { name: "landing", path: "/" },
  { name: "privacy", path: "/privacy" },
  { name: "terms", path: "/terms" },
  { name: "link-expired", path: "/link-expired" },
  { name: "m-missing-token", path: "/m" },
  { name: "signed-out", path: "/signed-out" },
  { name: "account-deleted-g0", path: "/account-deleted?g=0" },
  { name: "not-found", path: "/no-such-page" },
  { name: "week-signed-out", path: "/week" },
  { name: "week", seed: richWeek },
  {
    name: "week-empty",
    seed: async (world, tz) => ({ userId: await world.user({ name: null, timezone: tz }), path: "/week" }),
  },
  {
    name: "setup-fresh",
    session: { scope: "setup" },
    seed: async (world, tz) => ({ userId: await world.user({ timezone: tz, school: "Yale University" }), path: "/setup" }),
  },
  {
    name: "setup-connected",
    session: { scope: "setup" },
    seed: async (world, tz) => {
      const u = await world.user({ timezone: tz, school: "Yale University" });
      await seedCanvas(u, { failing: true });
      await seedGoogle(u, {
        email: "alexandria.josephine.longname@example.com",
        scopes: ALL_GOOGLE_SCOPES.filter((s) => !s.endsWith("gmail.send")),
      });
      return { userId: u, path: "/setup?google=missing_scopes" };
    },
  },
  {
    name: "setup-view",
    session: { scope: "view", ageMinutes: 120 },
    seed: async (world, tz) => ({ userId: await world.user({ timezone: tz }), path: "/setup" }),
  },
  {
    name: "settings-fresh",
    session: { scope: "setup" },
    seed: async (world, tz) => {
      const u = await world.user({ name: "Dana", timezone: tz });
      await seedCanvas(u);
      await seedGoogle(u, { email: "dana.settings@example.com" });
      await seedMemory(u);
      return { userId: u, path: "/settings" };
    },
  },
  {
    name: "settings-stale",
    session: { scope: "view", ageMinutes: 120 },
    seed: async (world, tz) => {
      const u = await world.user({ timezone: tz });
      await seedMemory(u);
      return { userId: u, path: "/settings" };
    },
  },
  {
    name: "email-pending",
    session: { ageMinutes: 5 },
    seed: async (world, tz) => {
      const u = await world.user({ timezone: tz });
      return { userId: u, path: `/email/${await seedDraft(u)}` };
    },
  },
  {
    name: "email-sent",
    session: { ageMinutes: 5 },
    seed: async (world, tz) => {
      const u = await world.user({ timezone: tz });
      return { userId: u, path: `/email/${await seedDraft(u, { status: "done", result: { sent_at: new Date().toISOString() } })}` };
    },
  },
  {
    name: "email-stale",
    session: { ageMinutes: 120 },
    seed: async (world, tz) => {
      const u = await world.user({ timezone: tz });
      return { userId: u, path: `/email/${await seedDraft(u)}` };
    },
  },
];

/** Default seed zone (browser contexts use the same zone unless a test overrides it). */
export const PAGE_TZ = TZ;
