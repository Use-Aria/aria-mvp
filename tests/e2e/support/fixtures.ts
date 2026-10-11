/**
 * Playwright fixtures for the e2e suite: `world` seeds throwaway users and signs the browser in
 * (a session row + the `aria` cookie on the page's context), and deletes every user it created
 * after the test (cascade + `llm_calls` + signups). A worker-scoped sweep removes leftovers of
 * crashed runs (> 30 min old) once per worker.
 *
 * Run against `next dev` with `--workers=1` (`npm run e2e -- --project=iphone-15 --workers=1`):
 * under `next dev`, server-action responses that overlap in time never finish streaming (headers
 * arrive, the RSC body never ends, the form stays "Saving…"), so parallel workers flake on any
 * test that waits for an action result. Sequential runs are green. See the 5.4 hand-off.
 */
import { test as base, expect as baseExpect, type BrowserContext, type Page } from "@playwright/test";
import {
  SESSION_COOKIE,
  createSessionRow,
  createUser,
  deleteUsers,
  leftoverCount,
  sweepStale,
  type NewUser,
} from "./db";

/** Base URL host for cookies (the dev server). */
export function baseHost(baseURL: string | undefined): string {
  return new URL(baseURL ?? "http://localhost:3000").hostname;
}

export interface World {
  /** Creates a user that is deleted after the test. */
  user: (u?: NewUser) => Promise<string>;
  /** Registers an id created elsewhere (e.g. by the app) for cleanup. */
  track: (userId: string) => void;
  /**
   * Signs `context` in as `userId` with a fresh session row.
   * @returns the raw session id
   */
  signIn: (
    userId: string,
    opts?: { scope?: "view" | "setup"; ageMinutes?: number; context?: BrowserContext },
  ) => Promise<string>;
}

export const test = base.extend<{ world: World }, { sweep: void }>({
  sweep: [
    async ({}, provide) => {
      await sweepStale(30).catch(() => undefined);
      await provide();
    },
    { scope: "worker", auto: true },
  ],
  // (`provide` = Playwright's `use`; renamed so react-hooks/rules-of-hooks doesn't misfire.)
  world: async ({ context, baseURL }, provide) => {
    const ids: string[] = [];
    const world: World = {
      user: async (u) => {
        const id = await createUser(u);
        ids.push(id);
        return id;
      },
      track: (id) => {
        ids.push(id);
      },
      signIn: async (userId, opts = {}) => {
        const raw = await createSessionRow(userId, opts);
        await (opts.context ?? context).addCookies([
          {
            name: SESSION_COOKIE,
            value: raw,
            domain: baseHost(baseURL),
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ]);
        return raw;
      },
    };
    await provide(world);
    await deleteUsers(ids);
    baseExpect(await leftoverCount(ids)).toBe(0);
  },
});

/**
 * `expect` with a 45s default: the shared dev server compiles routes on first hit and serves
 * other Wave 5 suites at the same time, so action round-trips under parallel load can take 20s+.
 */
export const expect = baseExpect.configure({ timeout: 45_000 });

/**
 * Asserts the page doesn't scroll horizontally (web plan §10).
 * @param page the page
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
}

/**
 * Waits until client components have hydrated (React attaches `__reactFiber` keys / Next sets
 * `next-route-announcer`). Clicking before hydration posts nothing.
 * @param page the page
 */
export async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector("next-route-announcer") !== null, null, { timeout: 30_000 });
}
