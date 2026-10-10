import "server-only";
/**
 * Magic-link and session policy: purposes, lifetimes, scopes, and the
 * redirect-target allow-list (spec §3.6). Pure module, unit-tested.
 * OWNER: 1.6 (master plan §1.15).
 */

/** `digest` is used only by briefing links (master plan §1.15). */
export type LinkPurpose = "view" | "setup" | "connect_google" | "email_draft" | "digest";
export type SessionScope = "view" | "setup";

const MINUTE = 60_000;

/** How long a minted link stays redeemable. */
export const LINK_TTL_MS: Record<LinkPurpose, number> = {
  view: 15 * MINUTE,
  setup: 30 * MINUTE,
  connect_google: 20 * MINUTE,
  email_draft: 60 * MINUTE,
  digest: 12 * 60 * MINUTE,
};

/** Where a link lands when no explicit target is given. */
export const DEFAULT_TARGET: Record<LinkPurpose, string> = {
  view: "/week",
  setup: "/setup",
  connect_google: "/setup",
  email_draft: "/week",
  digest: "/week",
};

/** Session scope granted by redeeming a link of each purpose. */
export const SCOPE_FOR_PURPOSE: Record<LinkPurpose, SessionScope> = {
  view: "view",
  setup: "setup",
  connect_google: "setup",
  email_draft: "view",
  digest: "view",
};

/** Session cookie lifetime. */
export const SESSION_TTL_MS = 14 * 24 * 60 * MINUTE;

/** A setup-scope session may change integrations only while this fresh. */
export const SETUP_FRESH_MS = 15 * MINUTE;

/** A session counts as "recent" (may edit memory / drafts) this long after redeeming a link. */
export const RECENT_SESSION_MS = 60 * MINUTE;

/** Max links minted per user per hour. */
export const MINT_LIMIT_PER_HOUR = 10;

/**
 * Type guard for a stored `magic_links.purpose`.
 * @param value raw purpose text
 * @returns true when it is a known `LinkPurpose`
 */
export function isLinkPurpose(value: string): value is LinkPurpose {
  return Object.hasOwn(LINK_TTL_MS, value);
}

const ALLOWED_TARGETS: RegExp[] = [
  /^\/week$/,
  /^\/setup$/,
  /^\/settings$/,
  /^\/email\/[0-9a-f-]{36}$/,
];

/**
 * Return `target` if it is an allow-listed in-app path, else `fallback`.
 * Prevents a stored target from becoming an open redirect.
 */
export function safeTarget(target: string | null | undefined, fallback: string): string {
  if (!target) return fallback;
  return ALLOWED_TARGETS.some((re) => re.test(target)) ? target : fallback;
}

/**
 * Open Graph title for `/m?k=<kind>&n=<count>`. Only an aggregate count from a
 * non-secret query param ever reaches the preview — never names or titles,
 * because previews are cached by third parties (spec §3.7).
 */
export function previewTitle(kind: string | undefined, n: string | undefined): string {
  const count = n !== undefined && /^\d{1,2}$/.test(n) ? Number(n) : undefined;
  switch (kind) {
    case "week":
      return count === undefined
        ? "Your week"
        : `Your week: ${count} deadline${count === 1 ? "" : "s"}`;
    case "setup":
      return "Finish setting up Aria";
    case "email":
      return "Your email draft";
    case "settings":
      return "Your Aria settings";
    default:
      return "Open Aria";
  }
}

/** Preview kinds carried in `/m?k=` (`MintInput.preview.kind`). */
export type PreviewKind = "week" | "setup" | "email" | "settings";

const OG_IMAGES: Record<PreviewKind | "landing" | "default", string> = {
  landing: "/og/landing.jpg",
  week: "/og/week.jpg",
  setup: "/og/setup.jpg",
  email: "/og/email.jpg",
  settings: "/og/settings.jpg",
  default: "/og/default.jpg",
};

/**
 * Static Open Graph image for a preview kind (web plan §2.4). Never echoes input.
 * @param kind `/m?k=` value, or "landing"
 * @returns site-relative JPEG path (1200×630), `/og/default.jpg` for anything unknown
 */
export function ogImageFor(kind?: string): string {
  return kind !== undefined && Object.hasOwn(OG_IMAGES, kind)
    ? OG_IMAGES[kind as keyof typeof OG_IMAGES]
    : OG_IMAGES.default;
}
