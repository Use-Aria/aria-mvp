# Aria V2 — Web App Surfaces (finish V2-02 + /setup, /week, /settings, /email/[id])

> **Status:** Plan only. No code was changed while writing this.
> **Date:** 2026-10-10. **Branch owner:** web surfaces. **Binding contracts:** `docs/plans/2026-10-10-v2-build-brief.md`.
> **Stack facts checked against** the Next.js docs bundled in `node_modules/next/dist/docs` (Next **16.4.0**, which the foundation agent installed) and the public URLs in §3.

---

## 1. Scope and spec references

**In scope**

| Area | What this branch delivers | Spec |
|---|---|---|
| Finish V2-02 | PWA manifest (no service worker), icons, static OG images (landing plus per-purpose `/m` cards), `robots`, 404/500/global-error pages, sign out, session hardening, CSP, `metadataBase` | §3.6, §3.7, §3.8 |
| `/setup` | Canvas connect (school picker, guide, paste, inline errors), Google connect (disclosure plus unverified-app warning), briefing time, quiet hours, persona tone | §3.8, §3.9, §3.10, §3.14, §3.15 |
| `/week` | Deadlines plus classes and events, grouped by local day, a load bar per day, mark done, Canvas links, empty states | §3.8, §3.15 |
| `/settings` | Connected accounts (with disconnect), "What Aria knows about you" (edit and delete), sign out everywhere, export (JSON), delete account | §3.6, §3.13, §3.22 |
| `/email/[id]` | Draft preview, edit, Send (the same deterministic pending-action path chat uses), Cancel | §3.9, §3.18 |
| Cross-cutting | Mutation pattern (server actions), scope and freshness guards, a11y, mobile-first layout, dark mode, reduced motion, visual QA | §3.6, §3.8, §3.22 |

**Out of scope (owned elsewhere; consumed through §8 contracts)**
- iCal fetch, parse, and sync, the SSRF hardening, `/api/canvas/connect`, and `src/server/timeline` belong to **V2-05**.
- OAuth routes, token storage, watches, `send_email` executor, and the draft payload belong to **V2-07**.
- Memory module, agent tools (including "send me a setup link"), and persona prompt belong to **V2-04**.
- Briefing scheduling and the `onSchedulePrefsChanged` hook belong to **V2-06**.
- `deliver()` quiet-hours guard belongs to **V2-03**.

**Confirmed skipped for the free test**
- **`/privacy` and `/terms`:** skipped, per the brief's "ToS/privacy" skip. The Google data disclosure lives on the connect page itself (§3.22 requires that anyway). A short plain-language `/privacy` is only built if the Google Console refuses to save the consent screen without a URL (see §13 Q2).
- **PWA:** no service worker, no install prompt, and no pairing (that's Phase 3).

---

## 2. Analysis

### 2.1 Gaps in the existing V2-02 code (fix list)

| # | Gap | Fix | Task |
|---|---|---|---|
| G1 | No sign out. Only `revokeAllSessions` exists, with no route or UI. | Add `revokeSession(rawId)` plus `signOut` and `signOutEverywhere` server actions, which clear the cookie and route to `/signed-out`. | W1 |
| G2 | No `not-found.tsx`, `error.tsx`, `global-error.tsx`, or `loading.tsx`. Next's defaults are unstyled and off-brand, and a DB error shows a bare 500. | Add all four. In Next 16, `error.tsx` receives `retry()` (preferred) and `reset()`. `global-error` must render its own `<html>/<body>` and import `globals.css`. | W1 |
| G3 | `currentViewer()` runs one DB round trip per call, and `generateMetadata` plus the page both call it. | Wrap it in React `cache()`. | W1 |
| G4 | Setup-scope freshness is only a predicate (`canChangeIntegrations`), with no page or action guard and no "how long do I have" signal. | `src/server/web/guard.ts`: `requireViewer()` for pages, `requireActionViewer(need)` for actions (Origin check plus session plus freshness). `/setup` shows "You can connect accounts until 3:42 PM" from `createdAt + 15 min` in the user's timezone. | W1 |
| G5 | `web_sessions.scope` comment says `view|full`, but the code writes `view|setup`, and there's no CHECK constraint. | Schema delta §4: add a CHECK on `('view','setup')`. | delta |
| G6 | No `metadataBase`, so `og:image` would be relative and Next falls back to `localhost`/`VERCEL_URL`. No landing OG image, no `og:url`, no Twitter card. | `metadataBase: new URL(siteUrl())` in the root layout. Static JPEGs in `public/og/`. `openGraph.images` set explicitly (see 2.4). | W2 |
| G7 | No manifest, the favicon is the create-next-app default (`src/app/favicon.ico`, 25,931 B), and `public/*.svg` are scaffold leftovers. | Add `app/manifest.ts`, `app/icon.png`, and `app/apple-icon.png` (180), plus `public/icons/*`. Delete the scaffold SVGs and `favicon.ico`. | W2 |
| G8 | No CSP. | Static CSP in `next.config.ts` (2.6). | W1 |
| G9 | `--line` border is 1.26:1 on paper. Input outlines fail WCAG 1.4.11 (needs 3:1). | New token `--field`: light `#7f8f85` (3.07:1), dark `#5f7366` (3.51:1). Keep `--line` for dividers only. | W1 |
| G10 | No `color-scheme`, so native `<select>`, `<dialog>`, and scrollbars render light in dark mode. | `:root { color-scheme: light dark; }`. | W1 |
| G11 | `SignedOut` always says "new link". The PWA (`/week?src=pwa`) can never have Safari's cookie on iOS. | `SignedOut` takes `{ask: "new link" \| "setup" \| "settings", pwa?: boolean}` and renders the copy deck variants (§9.1), plus a one-tap `sms:` button. | W1 |
| G12 | `previewTitle` has no `settings` kind. | Add `settings` with the title "Your Aria settings". It maps to `/og/settings.jpg`. | W2 |
| G13 | `src/server/*` lacks `import "server-only"`. | Add it to every new server module and retrofit the existing ones. `next/jest` already maps `server-only` to an empty mock (`node_modules/next/dist/build/jest/jest.js:188`). | W1 |
| G14 | `robots` doesn't exist. Private pages already set `noindex`. | `app/robots.ts`: allow `/`, disallow `/api/`. Keep `/m` crawlable so preview fetchers aren't confused, though they don't honor robots anyway. | W2 |
| G15 | The session cookie is correct (`__Host-aria`, HttpOnly, Secure in prod, SameSite=Lax, Path=/), but the session-id read path doesn't handle bfcache. After sign out, the Back button can show a cached signed-in page. | `RefreshOnFocus` client component: `pageshow` (persisted) and `visibilitychange` after more than 60 s hidden call `router.refresh()`. | W1 |

### 2.2 Mutations: server actions or route handlers?

| Option | For | Against |
|---|---|---|
| **A. Server actions for in-page mutations (chosen)** | Built-in POST-only plus Origin-vs-Host check (`serverActions` docs). Encrypted, non-deterministic action IDs. `refresh()` (Next 16) re-renders the route in the same round trip, so there's no client fetch plumbing. Typed end to end. Progressive enhancement with `<form action>`. | **Version skew:** a tab open across a deploy calls an action ID that no longer exists ("Failed to find Server Action"). **Vercel Skew Protection is Pro/Enterprise only**, and we're on Hobby. Also, a request with no `Origin` header passes with a warning instead of being rejected. |
| B. Route handlers for everything | Stable URLs that survive deploys. We already have the explicit Origin-check pattern (`/api/signup`). | Manual JSON fetches, manual `router.refresh()`, and duplicated error plumbing. About 2× the code for 12+ mutations. |
| C. Mixed | Use each where it fits. | Two patterns to learn. |

**Choice: A, with two route-handler exceptions.**
1. `POST /api/me/export` returns a file download. Actions can't stream a `Content-Disposition: attachment` response.
2. Google OAuth start is V2-07's `GET /api/google/oauth`, reached from a plain `<a>` (never `<Link>`, which would prefetch). This also keeps CSP `form-action 'self'` intact: Chrome applies `form-action` to redirect targets, so a form POST that 302s to `accounts.google.com` would be blocked.

**Why A is still safe and robust:**
- **Defense in depth on CSRF.** Every action calls `requireActionViewer()`, which **requires** `Origin` to be present and equal to `appOrigin()`. That closes the "no Origin passes" hole. The session cookie is also `SameSite=Lax`, so a cross-site POST carries no session at all.
- **Skew handling.** `(app)/error.tsx` detects the "Failed to find Server Action" error and shows "Aria just updated. Reload the page and try again." with a Reload button. Forms keep client state, so a pasted URL survives a reload only if it's still in the field. That's acceptable for 4 users. Production (Vercel Pro) turns on Skew Protection.
- **No closures over secrets.** Actions live in `actions.ts` files (module-level `"use server"`) and are never defined inline in components, so nothing is closure-encrypted to the client.
- **Inputs are re-validated with zod in every action.** Return values are small `ActionResult` objects, never DB rows (§7, `src/shared/action-result.ts`).

### 2.3 Session scope and freshness policy

All pages read with any valid session. Mutations need one of three levels:

| Need | Rule | Used by |
|---|---|---|
| `any` | Any valid session (`view` or `setup`) | Mark done/undo, briefing time, quiet hours, tone, time zone, delete a memory, cancel a draft, sign out (this device or everywhere) |
| `recent` | A session created < 60 min ago (any scope) | Edit a memory or preference, edit a draft, **Send** a draft |
| `fresh_setup` | `scope = 'setup'` and < 15 min old (`canChangeIntegrations`) | Connect or disconnect Canvas, connect or disconnect Google, export my data, delete account |

**Why each level:**
- **`recent` for Send:** a 14-day view session from an old forwarded link can't send email. The `email_draft` link is 60 min (`LINK_TTL_MS`), so tapping the draft link always yields a session that is recent enough.
- **`recent` for memory edits:** edited preferences steer the agent, so a stale or forwarded link shouldn't be able to plant them.
- **Low-risk prefs stay open to any session:** deleting a memory is privacy-positive and reversible by telling Aria again, and briefing and quiet-hours changes are harmless.

**When a check fails**, the UI never throws. The action returns `{ok:false, code:"needs_fresh_link" | "needs_recent_link" | "signed_out"}`. The form shows the copy-deck message plus a **Text Aria "setup"** `sms:` button. The form keeps its client state, so a pasted Canvas URL isn't lost.

### 2.4 OG images: generated at build (`opengraph-image.tsx`) or static files?

| Option | Verdict | Why |
|---|---|---|
| `opengraph-image.tsx` (ImageResponse, statically optimized at build) | ❌ | It outputs **PNG** (Satori → resvg), while the spec asks for JPEG < 300 KB. It's also bound to a **route segment**: `/m` is one segment, but its card must vary by `?k=`. File-based metadata has the higher priority and overrides `metadata`/`generateMetadata`, so a root `opengraph-image` would also fight `/m`'s per-kind image. |
| Route handler `/og/[kind]` with ImageResponse | ❌ | Runtime cost and PNG output, for 5 images that never change. |
| **Static JPEGs in `public/og/`, chosen per page through `openGraph.images` (chosen)** | ✅ | Deterministic, zero runtime, and size-checkable in a unit test. `/m`'s `generateMetadata` already parses `k`, so it maps `k → /og/<k>.jpg`. **No `opengraph-image.*` files anywhere**, which avoids the precedence trap. |

**How the images are produced:**
- `scripts/assets/render.ts` (run with Playwright, which is already a dev dep for QA) screenshots `scripts/assets/og.html?k=<kind>` at 1200×630.
- `sips -s format jpeg -s formatOptions 82` (built into macOS) converts each to JPEG.
- The results are committed. The script is reproducible, but a build never runs it.
- **The cards contain no personal data:** generic headline, sage paper, an iMessage-bubble motif, and the "aria" wordmark (§3.7 privacy rule).

| Kind | File | Headline on card |
|---|---|---|
| landing | `/og/landing.jpg` | "Texts you what's due, before it's due." |
| week | `/og/week.jpg` | "Your week" (bubble stack, no titles) |
| setup | `/og/setup.jpg` | "Finish setting up Aria" |
| email | `/og/email.jpg` | "Your email draft" |
| settings | `/og/settings.jpg` | "Your Aria settings" |
| default | `/og/default.jpg` | "Open Aria" |

**Icons: the V2 mark or `Aria_Logo.png`.**
- `Aria_Logo.png` is a 1024² *composite sheet*: a white tile with a purple→cyan "A", plus a wordmark on navy. The tile is only ~335 px square, so a 512 px icon would be upscaled and blurry, and the gradient clashes with V2's sage/pine/green palette.
- **Default:** render a V2 mark from `scripts/assets/icon.html` at 1024 px (paper "a" in Bricolage Bold on an Aria-green rounded square), then downscale it with `sips` to 512, 512-maskable (20% safe padding), 192, 180 (apple), and 32.
- **Alternative:** crop the logo tile (`sips --cropToHeightWidth`) for 180/192 only. Daniel picks (§13 Q1).

### 2.5 `/week` design decisions

**Window**
- Rolling **today plus 6 days** in the user's timezone.
- An **"Still open"** group sits on top: items that are `upcoming`, past due, and due within the last 7 days.
- `?w=1` shows the following 7 days (validated as the integer 0 or 1).
- Why rolling and not Monday–Sunday: on a Thursday a student cares about the next 7 days, not the 3 left in the calendar week.

**Grouping**
- A pure function `groupWeek(items, {timezone, now, offsetWeeks})` in `src/shared/week.ts`.
- It derives local day keys with `Intl.DateTimeFormat('en-CA', {timeZone, year, month, day})` (`YYYY-MM-DD`).
- Day boundaries are DST-safe because we only compare local-date strings and never add 24 h to instants.
- **All-day items** (Canvas `DTSTART;VALUE=DATE`) must not be converted through UTC, which shifts the day for UTC−x users. The view model needs `allDay: boolean` and for all-day items uses the **floating date** (contract request to V2-05, §8).

**Ordering**
- Each day is split into deadlines (`assignment`, `exam`) and schedule (`class`, `event`, `block`).
- Deadlines are sorted by `dueAt`, then exams first, then title. Done items sink to the bottom, struck through, with an Undo.
- Schedule items are sorted by `startsAt`. This happens at read time, so nothing goes stale (the §3.15 rule).

**Load levels (ported from V1 `useCards.ts`)**
- **Week header:** V1's exact thresholds on upcoming, not-done deadlines in the window: ≤3 light, 4–6 busy, ≥7 heavy.
- **Per day (new):** points = assignments × 1 + exams × 2. 0–1 light, 2 busy, ≥3 heavy.
- The bar is three segments with a **text label**, so it's never color-only.
- Tokens: light `--load-light #1e7a4c`, `--load-busy #a8551a` (4.77:1), `--load-heavy #b3261e`. Dark: `#3fae74`, `#f0a35e`, `#e57373`.

**Mark done**
- Uses `useOptimistic` plus a server action that calls V2-05 `setTimelineItemStatus(userId, itemId, status)`, which is scoped by `user_id`.
- The toggle is idempotent, so a double tap is safe.
- `refresh()` in the action reconciles the view.
- Reminders anchored to an item that's done are suppressed by V2-06 at fire time (contract note).

**Links**
- `safeExternalUrl(url, allowHosts)` allows **`https:` only**, no userinfo, ≤ 2048 chars.
- Allowed hosts: `*.instructure.com`, the user's connected Canvas host, every `UNIVERSITIES` domain, `calendar.google.com`, and `mail.google.com`.
- Any other URL renders as plain text with no link. Links use `target="_blank" rel="noopener noreferrer"`.

**Empty states**
- **No Canvas:** invite to connect. The button links to `/setup#canvas`; `/setup` itself handles a stale session.
- **Canvas connected, nothing due:** say so, and say when Aria checks again.
- **Google not connected:** a one-line hint under the schedule.
- **Sync error:** a banner with the fix.

### 2.6 Security analysis

| Threat | Mitigation |
|---|---|
| CSRF on mutations | Server actions: POST plus the Next Origin/Host check plus our **required** `Origin === appOrigin()` in `requireActionViewer`. `/api/me/export` runs the same check. The cookie is SameSite=Lax. |
| Scope escalation (old view link connects accounts or deletes the account) | Freshness levels in 2.3, re-checked **inside every action**. Render-time gating is never trusted (Next data-security guide). |
| IDOR (`/email/<someone else's id>`, marking someone else's item done) | Every read and write filters on `user_id = viewer.userId`. A non-owner gets `notFound()`, so existence isn't revealed. `[id]` is validated as a UUID before any query. |
| Open redirect | Actions only `redirect()` to literal paths. No `next=` or `returnTo` params anywhere. Magic links already go through `safeTarget()`. The Google callback returns to the fixed `/setup?google=<code>`, and we render banners only for allow-listed codes (never echoing query text). |
| XSS from Canvas titles, course names, email subjects and bodies, calendar titles | React text escaping only. **`dangerouslySetInnerHTML` is banned** (ESLint `react/no-danger: error` for `src/app/**`). Draft bodies render in a `<textarea>` or `white-space: pre-wrap` text and are never parsed as HTML. URLs go through `safeExternalUrl` (blocks `javascript:`, `data:`, `vbscript:`, and `http:`). `cleanText()` strips bidi controls (U+202A–202E, U+2066–2069) and zero-width chars from untrusted display strings to stop RTL-spoofed subjects or filenames. |
| Secret leakage (the Canvas iCal URL is a bearer secret) | It's never logged and never echoed back by the server (an action error returns only a code; the client keeps its own input). Status shows only `host + "…" + last 4`. `autoComplete="off"` and `spellCheck={false}` are set on the field. Referrer-Policy `same-origin` keeps `/setup` URLs out of Canvas's referrer. |
| Clickjacking | Existing `X-Frame-Options: DENY` plus CSP `frame-ancestors 'none'`. |
| Data over-exposure to client components | DAL functions in `src/server/web/*` return view models (plain strings and booleans, dates preformatted on the server). They never select `enc_*` columns. Client components receive only those. `import "server-only"` is everywhere under `src/server`. |
| Export abuse | `fresh_setup` plus a rate limit of 3 per hour per user. `Cache-Control: no-store`. Only the requesting user's rows. Tokens, iCal URLs, session or link hashes, and LLM logs are excluded. |
| Brute force or abuse | `rateLimit` per user: Canvas connect 6 per 10 min, Send 5 per 10 min, export 3 per hour, memory edits 30 per 10 min. |

**CSP (W1, static, no nonce)**
- Header value: `default-src 'self'; script-src 'self' 'unsafe-inline'{dev: 'unsafe-eval'}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`.
- **Why no nonce:** a nonce needs `proxy.ts` and makes every page dynamic. The real XSS defenses are React escaping, no `dangerouslySetInnerHTML`, and the URL allow-list. Revisit for production.
- `form-action 'self'` is what makes the Google connect a GET `<a>` (2.2).

### 2.7 Failure modes

| Failure | Behavior |
|---|---|
| Session expires or goes stale mid-form (e.g., a Canvas URL pasted at minute 16) | The action returns `needs_fresh_link`. An inline notice plus a **Text Aria "setup"** button appear. The input value is kept, so after the fresh link the user can paste again (the clipboard still has it). |
| Double submit (double tap on Send, Connect, or Delete) | `useFormStatus().pending` disables the button. Server operations are idempotent: Canvas connect upserts on `(user_id, provider)`, status toggles are idempotent, delete is idempotent, and Send uses an **atomic `pending → confirmed` transition** guarded by `version` (§4). |
| Agent changes data while a page is open (Aria marks done in chat, revises the draft, a sync lands) | `RefreshOnFocus` refreshes when you come back from Messages. Draft Send/Save carries `expectedVersion`. On a version conflict the page shows "This draft changed in your chat. Here's the latest version." and re-renders. |
| Google callback errors (denied, unchecked scopes, school admin block, state mismatch, timeout) | V2-07 redirects to `/setup?google=<code>` with a fixed code set (§8). `/setup` renders the copy-deck banner, then strips the param with `history.replaceState` so a reload doesn't repeat it. |
| Google consent finishes after the 15-min freshness window | OAuth start requires `fresh_setup`. The **callback must not** (it's bound by the state cookie). Contract note to V2-07. |
| Account deleted with tabs open | Session rows cascade-delete, so the next render or action finds no session → `SignedOut`, or the action returns `signed_out`. |
| Deploy while a tab is open (skew) | `error.tsx` "Aria just updated" plus a Reload button (2.2). |
| Supabase slow or down | `loading.tsx` skeleton. DAL throws → `(app)/error.tsx` shows "Something broke on our end" with `retry()`. |
| Canvas feed fine but empty (summer, new term) | Treated as **success** with `itemCount: 0`, not an error. Copy says Aria checks hourly. |
| Canvas Student app hijacks the "Open Canvas calendar" link on iPhone (universal links) **[verify on device]** | Guide offers "Copy Canvas address" and a hint to open it in Safari or on a laptop. It also says "Or paste the link straight into your chat with Aria." |
| Unverified-app warning scares the user or Yale blocks it | Disclosure explains it before the tap, and a `admin_policy_enforced` code gets its own banner (personal Gmail or skip). |
| PWA opened from the Home Screen (separate cookie jar on iOS) | `SignedOut pwa` copy: "Open your latest link from Aria in Safari." |
| Export larger than PostgREST's 1,000-row cap | `collectAccountExport` pages with `.range()` per table until a short page. |
| Google revoke fails during account delete | Retry once. If it still fails, delete anyway, set `googleRevoked:false`, and show "Also remove Aria at myaccount.google.com/permissions" with the link. We never keep user data to retry a revoke. |

### 2.8 Accessibility and mobile

**Layout and touch**
- `min-h-dvh`, `viewport-fit=cover`, and `env(safe-area-inset-*)` padding on the shell. Top and bottom bars respect the insets.
- Inputs are ≥ 16 px, which prevents iOS focus zoom. Targets are ≥ 44×44 px (Apple HIG, above WCAG 2.5.8's 24 px).

**Structure**
- One `<h1>` per page. Sections use `<section aria-labelledby>`.
- The nav is `<nav aria-label="Aria">` with `aria-current="page"`.

**Forms and feedback**
- Each field has a `<label>`, hint text, and an error linked with `aria-describedby` and `aria-invalid`.
- Errors use `role="alert"`. Success banners use `role="status"`. After an action, focus moves to its result banner.

**Controls**
- The confirm step uses native `<dialog>` with `showModal()` (iOS Safari 15.4+), which gives a focus trap, Esc to close, and inert background. It has a labeled title and a destructive button styled `danger`.
- Native `<select>` is used for school, times, and quiet hours. iOS gives the wheel picker, and it's accessible for free.

**Motion and color**
- Motion: only `motion-safe:` transitions (opacity ≤ 150 ms). The hero animation already respects `prefers-reduced-motion`.
- Dark mode: tokens via `prefers-color-scheme`, plus `color-scheme: light dark`. There is no in-app toggle.

**Text**
- Long titles use `break-words`. Titles are never truncated for screen readers: visual clamping uses `line-clamp-2` with the full title in the text node.

---

## 3. External facts (with URLs)

| Fact | Source |
|---|---|
| Next 16 removed synchronous `cookies()`, `headers()`, `params`, and `searchParams`. All are Promises. Image-generation `params`/`id` are Promises too. | https://nextjs.org/docs/app/guides/upgrading/version-16 (bundled: `01-app/02-guides/upgrading/version-16.md` §"Async Request APIs") |
| `middleware` is renamed `proxy` (`proxy.ts`, export `proxy`). Proxy isn't meant for shared-module or DB auth. **We don't need a proxy.** | https://nextjs.org/docs/app/api-reference/file-conventions/proxy |
| Server Actions: POST only. Origin compared to Host/X-Forwarded-Host. **A request with no Origin is allowed through with a warning.** `allowedOrigins` lives under `experimental.serverActions`. 1 MB body default. | https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions · https://nextjs.org/docs/app/guides/data-security#allowed-origins-advanced |
| Actions must re-authenticate and validate inside. Encrypted action IDs. Closure variables are encrypted. | https://nextjs.org/docs/app/guides/server-actions#security |
| Action IDs rotate on deploy ("Failed to find Server Action"). Surface it as a retry path. | https://nextjs.org/docs/app/guides/server-actions#deployment-considerations · https://nextjs.org/docs/messages/failed-to-find-server-action |
| `refresh()` from `next/cache` (actions only) re-renders the current route in the action response. `updateTag` / `revalidatePath` are alternatives. | https://nextjs.org/docs/app/api-reference/functions/refresh |
| `error.tsx` gets `retry()` (preferred) and `reset()`. `global-error` must render `<html>/<body>` and doesn't get global styles automatically. | https://nextjs.org/docs/app/api-reference/file-conventions/error |
| `forbidden()` / `unauthorized()` need experimental `authInterrupts`, so **we don't use them**. | https://nextjs.org/docs/app/api-reference/functions/forbidden |
| Static `opengraph-image.(jpg\|png)` files are per segment. File-based metadata **overrides** `metadata` / `generateMetadata`. Metadata merges shallowly, and child `openGraph` replaces the parent's. | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image · https://nextjs.org/docs/app/api-reference/functions/generate-metadata#merging |
| `app/manifest.ts` returns `MetadataRoute.Manifest` and is cached by default. | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest |
| `app/icon.png` and `app/apple-icon.png` file conventions emit the `<link>` tags. `favicon.ico` is root only. | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons |
| `app/robots.ts` | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots |
| `server-only` is handled internally by Next. `next/jest` maps it to an empty module. | https://nextjs.org/docs/app/guides/data-security#preventing-client-side-execution-of-server-only-code |
| Vercel Skew Protection is **Pro/Enterprise only**, so it isn't on Hobby. | https://vercel.com/docs/skew-protection |
| CSP `form-action` also governs redirects after a form submit in Chromium, so a form POST that 302s to Google is blocked. | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/form-action |
| iMessage previews: no JS, follow redirects, `og:image` ≥ 900 px wide recommended, 1 MB main resource. | https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages |
| Manifest `id` is resolved against the `start_url` origin and gives the app a stable identity. | https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id |
| `<dialog>` + `showModal()`: focus handling, inert background | https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog |
| WCAG 2.2 1.4.11 non-text contrast is 3:1 (input borders, load bar). 2.5.8 target size is ≥ 24 px. | https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast · https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum |
| Canvas: Calendar (global nav) → **Calendar Feed** link → copy the URL in the field. The feed covers 30 days back to 366 ahead, max 1,000 items, and excludes To-Do items. | https://community.canvaslms.com/t5/Student-Guide/How-do-I-view-the-Calendar-iCal-feed-to-subscribe-to-an-external/ta-p/331 |
| "Unverified app" screen appears for sensitive or restricted scopes without verification. Labels "Advanced" → "Go to *app* (unsafe)" **[verify on first real connect]**. | https://support.google.com/cloud/answer/7454865 |
| Google granular consent: users can uncheck individual scopes. The app must check granted scopes. | https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions |
| Token revocation endpoint `https://oauth2.googleapis.com/revoke` | https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke |
| Playwright device emulation (viewport, DPR, touch, UA via CDP) isn't subject to headless Chrome's ~500 px minimum *window* width. | https://playwright.dev/docs/emulation |
| Supabase/PostgREST returns at most 1,000 rows per request by default ("Max rows"), so export must page. **[verify in project API settings]** | https://supabase.com/docs/guides/api/api-settings |

**Facts verified locally:**
- Installed `next@16.4.0`, `react@19.2.8`, Node v22.16.0.
- `@playwright/test` 1.63.0 was published 2026-09-04 (≥ 2 weeks old). 1.64.0 (2026-10-07) is too new.
- `server-only@0.0.1` was published in 2022.
- Contrast ratios in §2.1 and §2.5 were computed with the WCAG formula.

---

## 4. Schema delta (for `003_v2_build.sql`; the orchestrator consolidates, and **no migration file is written here**)

```sql
-- ── Web surfaces (V2 web branch) ─────────────────────────────────────
-- Briefing on/off + quiet hours (user-level; channels keep pause/opt-out).
-- V2-03 deliver() and V2-06 briefing scheduler READ these. If V2-03/V2-06
-- propose the same columns, keep one definition (names/types below).
alter table users
  add column if not exists briefing_enabled boolean not null default true,
  add column if not exists quiet_start      time    not null default '22:00',
  add column if not exists quiet_end        time    not null default '08:00';

-- Session scope values actually written by src/server/security/sessions.ts
alter table web_sessions
  add constraint web_sessions_scope_check check (scope in ('view','setup'));
create index if not exists web_sessions_user_live_idx
  on web_sessions (user_id) where revoked_at is null;

-- mintMagicLink counts links per user in the last hour
create index if not exists magic_links_user_created_idx
  on magic_links (user_id, created_at);

-- Pending actions: optimistic concurrency between web edits and chat
-- revisions, and an audit of how each was decided. (Co-owned with V2-07's
-- send_email executor / V2-04's confirm_action. If their delta also adds
-- columns here, merge into one ALTER.)
alter table pending_actions
  add column if not exists version     int         not null default 1,
  add column if not exists updated_at  timestamptz not null default now(),
  add column if not exists decided_at  timestamptz,
  add column if not exists decided_via text check (decided_via in ('chat','web','expiry')),
  add column if not exists result      jsonb;       -- e.g. {"gmail_message_id": "...", "sent_at": "..."}; no bodies
create index if not exists pending_actions_user_status_idx
  on pending_actions (user_id, status);

-- Account deletion removes the pre-chat signup rows too (name + phone)
create index if not exists signups_phone_idx on signups (phone_e164);
create index if not exists signups_matched_user_idx on signups (matched_user_id);
```

**Requested from V2-05 (their delta, not ours):**
- `timeline_items.all_day boolean not null default false`, or an equivalent `allDay` derived in the view model from `raw` (see §8).
- If it's derived, no column is needed.

**Persona tone needs no column.** It's stored in the existing `users.persona_prefs jsonb` as `{"tone": "mirror"|"casual"|"polished"}` and validated by `src/shared/persona-prefs.ts`.

No new tables, so RLS is unaffected.

---

## 5. Dependencies (exact versions; minimal)

| Package | Version | Kind | Why |
|---|---|---|---|
| `@playwright/test` | **1.63.0** (2026-09-04) | dev | Mobile-viewport screenshots (CDP emulation avoids the 500 px headless window minimum). Light/dark/reduced-motion runs, e2e of redeem → setup → week, and the OG/icon renderer. Runs against installed Google Chrome (`channel: "chrome"`), so no browser download is needed. `npx playwright install webkit` is optional for an iOS-like engine. It's also the résumé item already planned ("Jest + Playwright"). |
| `server-only` | **0.0.1** | dep | Explicit marker on `src/server/**`. Next handles it internally, but installing keeps `tsc` and editors happy. Zero runtime cost. |

**Explicitly not added:**
- **shadcn/ui** (it would pull Radix, cva, clsx, tailwind-merge, and lucide). We need about 7 primitives, and native `<dialog>`/`<select>` cover the hard ones accessibly.
- **lucide** (we use about 5 inline SVG icons).
- **`@testing-library/*`** (we use `react-dom/server` `renderToStaticMarkup` for the few component render tests).
- **`date-fns`/`luxon`** (`Intl` per the brief).
- **`@axe-core/playwright`** (optional later; manual a11y checklist for now).
- **`sharp`** (macOS `sips` does the resizing).

**Jest config change (foundation-owned file, one line):** `testMatch` → `["<rootDir>/tests/unit/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.tsx"]`, and a separate explicit command for `tests/smoke/**`.

`package.json` scripts to add:
- `"e2e": "playwright test"`
- `"qa:shots": "playwright test --project=shots"`
- `"assets": "playwright test scripts/assets/render.spec.ts --project=assets"`
- `"smoke:web": "jest --testMatch '<rootDir>/tests/smoke/**/*.test.ts' --runInBand"`

---

## 6. Env vars

**No new required vars.** Uses `APP_BASE_URL`, `SENDBLUE_FROM_NUMBER` (for `sms:` buttons), `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_REST_*` (rate limits), and `APP_ENCRYPTION_KEY` (indirectly, via other branches).

| Var | Required | Notes |
|---|---|---|
| `E2E_BASE_URL` | no (dev only) | Playwright target. Default `http://localhost:3000`. |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | no | Only for multi-instance self-hosting. Vercel shares the per-build key, so leave it unset. |

**Build note:**
- `metadataBase` needs an absolute URL at build time. `siteUrl()` = `APP_BASE_URL`, else `https://${VERCEL_PROJECT_PRODUCTION_URL}`, else `http://localhost:3000`.
- It never throws, so preview builds don't fail. Runtime `appBaseUrl()` still throws in production, as today.
- **Preview deployments aren't supported** for magic links in the free test (§13 Q10).

---

## 7. File plan

All new server modules start with `import "server-only"`. All pages are server components unless named `*.client.tsx` or marked `"use client"`. Routes move into a route group `(app)` for a shared shell; URLs are unchanged.

### 7.1 Shell, V2-02 completion

| Path | Purpose | Exports / signature |
|---|---|---|
| `src/app/layout.tsx` (edit) | `metadataBase`, landing OG, `appleWebApp`, twitter card, `color-scheme` | `metadata: Metadata` (adds `metadataBase`, `openGraph.images: [/og/landing.jpg 1200×630 alt]`, `openGraph.url: "/"`, `twitter.card: "summary_large_image"`, `appleWebApp: {capable: true, title: "Aria", statusBarStyle: "default"}`) |
| `src/app/globals.css` (edit) | Tokens `--field`, `--load-{light,busy,heavy}`, `--warn-bg`. `color-scheme`. `.safe-x/.safe-b` utilities. | — |
| `src/app/(app)/layout.tsx` | App shell: top bar (wordmark, `AppNav`), `RefreshOnFocus`, safe-area padding, `max-w-xl` left-aligned column. **Not** an auth boundary. | `default function AppLayout({children}: LayoutProps<"/">)` |
| `src/app/(app)/loading.tsx` | Skeleton (static bars, no shimmer under reduced motion) | default |
| `src/app/(app)/error.tsx` | `"use client"`. Detects "Failed to find Server Action" → reload copy, else generic with `retry()`. | `default function AppError({error, retry}: {error: Error & {digest?: string}; retry: () => void})` |
| `src/app/not-found.tsx` | 404 with links to `/` and "Text Aria" | default |
| `src/app/global-error.tsx` | `"use client"`, own `<html><body>`, imports `./globals.css`, React `<title>` | default |
| `src/app/signed-out/page.tsx` | After sign out: "You're signed out." | default, `robots: noindex` |
| `src/app/account-deleted/page.tsx` | After delete: confirmation plus Google permissions link when revoke failed (`?g=0`) | default |
| `src/app/_components/SignedOut.tsx` (edit) | Variants | `SignedOut({ask = "new link", pwa = false}: {ask?: "new link" \| "setup" \| "settings"; pwa?: boolean})` (async server component; reads UA for `sms:` platform) |
| `src/app/_components/AppNav.tsx` | `"use client"` (needs `usePathname`). Links: Week, Setup, Settings. | `AppNav()` |
| `src/app/_components/RefreshOnFocus.tsx` | `"use client"`. `router.refresh()` on `pageshow.persisted` or visible after > 60 s. | `RefreshOnFocus()` |
| `src/app/_components/TextAriaButton.tsx` | Server component. `sms:` button with prefilled body. Hidden if `SENDBLUE_FROM_NUMBER` is unset. | `TextAriaButton({body, label, variant}: {body: string; label: string; variant?: "primary" \| "secondary"})` |
| `src/app/_components/FreshLinkNotice.tsx` | "Text Aria 'setup'" notice | `FreshLinkNotice({keyword, reason}: {keyword: "setup" \| "settings" \| "draft"; reason: "stale" \| "view_only"})` |
| `src/app/_components/ExternalLink.tsx` | Renders link only if `safeExternalUrl` passes, else text | `ExternalLink({href, allowHosts, children, label}: {...})` |
| `src/app/_components/ui/Button.tsx` | `primary \| secondary \| danger \| ghost`, `as="a"` support, 44 px min | `Button(props)` |
| `src/app/_components/ui/SubmitButton.tsx` | `"use client"`. `useFormStatus` pending → disabled plus pending label. | `SubmitButton({children, pendingLabel, variant})` |
| `src/app/_components/ui/Field.tsx` | Label, hint, error, ids wired | `Field({label, hint, error, children, id})` |
| `src/app/_components/ui/Banner.tsx` | `status \| alert`, tone `ok \| warn \| error`, focusable (`tabIndex=-1`) | `Banner({tone, children, focusOnMount})` |
| `src/app/_components/ui/ConfirmDialog.tsx` | `"use client"`. Native `<dialog>`. Optional "type DELETE" gate. | `ConfirmDialog({trigger, title, children, confirmLabel, requireText?, formAction})` |
| `src/app/_components/ui/Section.tsx` | `<section aria-labelledby>` with status pill | `Section({id, title, status?, children})` |
| `src/server/web/guard.ts` | Page and action guards | `requireViewer(): Promise<Viewer \| null>` (cached); `type Need = "any" \| "recent" \| "fresh_setup"`; `requireActionViewer(need: Need): Promise<{ok: true; viewer: Viewer} \| {ok: false; code: "signed_out" \| "needs_recent_link" \| "needs_fresh_link" \| "bad_origin"}>`; `freshUntil(session: WebSession): Date \| null`; `isRecent(session: WebSession, now?: number): boolean` |
| `src/server/web/site.ts` | Build-safe absolute URL | `siteUrl(): string` |
| `src/server/viewer.ts` (edit) | `cache()`-wrapped, adds `school` | `currentViewer: () => Promise<Viewer \| null>`. `Viewer` gains `school: string \| null`. |
| `src/server/security/sessions.ts` (edit) | Sign-out primitives | add `revokeSession(rawId: string): Promise<void>`, `clearedSessionCookie(): {name; value: ""; options: {...; expires: new Date(0)}}`, `currentSessionRaw(): Promise<string \| undefined>` |
| `src/server/security/link-policy.ts` (edit) | `settings` preview kind. `RECENT_SESSION_MS = 60 min`. | `previewTitle` handles `"settings"`. `MintInput.preview.kind` gains `"settings"`. `ogImageFor(kind?: string): string` |
| `src/app/(app)/session-actions.ts` | `"use server"` | `signOut(): Promise<never>` (revoke current, clear cookie, `redirect("/signed-out")`); `signOutEverywhere(): Promise<never>` |
| `next.config.ts` (edit) | CSP header | — |
| `src/app/robots.ts` | robots | `default function robots(): MetadataRoute.Robots` |
| ESLint config (edit, foundation-owned) | `react/no-danger: "error"` for `src/app/**` | — |

### 7.2 PWA and preview assets

| Path | Purpose |
|---|---|
| `src/app/manifest.ts` | `{name: "Aria", short_name: "Aria", id: "aria", start_url: "/week?src=pwa", scope: "/", display: "standalone", background_color: "#f2f4ef", theme_color: "#f2f4ef", icons: [192, 512, 512 maskable]}` |
| `src/app/icon.png` (32×32), `src/app/apple-icon.png` (180×180) | File-convention icons. Delete `src/app/favicon.ico`. |
| `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Manifest icons |
| `public/og/{landing,week,setup,email,settings,default}.jpg` | 1200×630, < 300 KB each, no personal data |
| `src/app/m/page.tsx` (edit) | `generateMetadata` adds `openGraph.images: [{url: ogImageFor(k), width: 1200, height: 630, alt}]` and `twitter` |
| `scripts/assets/og.html`, `scripts/assets/icon.html` | Templates (Bricolage via Google Fonts link; tokens copied from `globals.css`) |
| `scripts/assets/render.spec.ts` | Playwright "test" that screenshots the templates and calls `sips` via `child_process.execFileSync` (macOS only, documented) |
| `public/{file,globe,next,vercel,window}.svg` | **Delete** (scaffold) |

### 7.3 Shared pure modules (client-safe, unit-tested)

| Path | Exports |
|---|---|
| `src/shared/week.ts` | `type WeekItem = {id: string; source: "canvas" \| "gcal" \| "gmail" \| "syllabus" \| "aria"; kind: "assignment" \| "exam" \| "event" \| "class" \| "block"; title: string; course: string \| null; startsAt: string \| null; endsAt: string \| null; dueAt: string \| null; allDay: boolean; allDayDate: string \| null /* YYYY-MM-DD */; url: string \| null; status: "upcoming" \| "done" \| "dismissed"}`; `type LoadLevel = "light" \| "busy" \| "heavy"`; `localDayKey(iso: string, timeZone: string): string`; `groupWeek(items: WeekItem[], opts: {timeZone: string; now: Date; offsetWeeks: 0 \| 1}): WeekView`; `weekLoad(deadlineCount: number): LoadLevel` (V1 thresholds); `dayLoad(points: number): LoadLevel`; `dayLabel(dayKey: string, todayKey: string, timeZone: string): string`; `formatItemTime(item: WeekItem, timeZone: string): string`; `WeekView = {stillOpen: WeekItem[]; days: Array<{key: string; label: string; load: LoadLevel; points: number; deadlines: WeekItem[]; schedule: WeekItem[]}>; load: LoadLevel; dueCount: number}` |
| `src/shared/safe-url.ts` | `safeExternalUrl(raw: string \| null \| undefined, allowHosts: readonly string[]): string \| null` (suffix match for `*.domain`); `cleanText(s: string, max?: number): string`; `gmailPermalink(rfc822MessageId: string): string` |
| `src/shared/schedule-prefs.ts` | `BRIEFING_OPTIONS: readonly {value: string; label: string}[]` (07:00–12:00 every 30 min; `"off"`); `QUIET_START_OPTIONS` (21:00–01:00 hourly); `QUIET_END_OPTIONS` (06:00–11:00 hourly); `SchedulePrefsInput` zod schema; `briefingInQuietHours(briefing: string, quietStart: string, quietEnd: string): boolean`; `formatClock(hhmm: string): string` |
| `src/shared/persona-prefs.ts` | `PersonaPrefs = z.object({tone: z.enum(["mirror","casual","polished"]).default("mirror")})`; `parsePersonaPrefs(json: unknown): {tone: Tone}` (never throws, defaults); `TONE_OPTIONS` with label, description, sample bubble |
| `src/shared/action-result.ts` | `type ActionErrorCode = "signed_out" \| "needs_recent_link" \| "needs_fresh_link" \| "bad_origin" \| "rate_limited" \| "invalid" \| "not_found" \| "version_conflict" \| "not_pending" \| "expired" \| "unavailable" \| "server" \| CanvasConnectError \| SendErrorCode`; `type ActionResult<T = undefined> = {ok: true; data: T} \| {ok: false; code: ActionErrorCode}` |
| `src/shared/copy.ts` | The §9 strings as typed records: `ACTION_ERROR_COPY: Record<ActionErrorCode, string>`, `CANVAS_ERROR_COPY`, `GOOGLE_STATUS_COPY: Record<GoogleConnectStatus, {tone; text}>`, etc. A unit test asserts full coverage. |

### 7.4 `/setup`

| Path | Purpose | Data |
|---|---|---|
| `src/app/(app)/setup/page.tsx` | Sections: Canvas (`#canvas`), Google (`#google`), Morning briefing, Quiet hours, How Aria talks. Reads `searchParams.google` (allow-listed). | `requireViewer()`. `getSetupView(viewer)` → `{canvas: CanvasStatusView; google: GoogleStatusView; schedule: {briefingTime; briefingEnabled; quietStart; quietEnd; timezone; tzLabel}; tone; canChange: boolean; freshUntilLabel: string \| null; school: string \| null}` |
| `src/server/web/setup-data.ts` | DAL | `getSetupView(viewer: Viewer): Promise<SetupView>`. Calls V2-05 `getCanvasStatus`, V2-07 `getGoogleStatus`, and reads `users` (briefing/quiet/persona_prefs). |
| `src/app/(app)/setup/CanvasConnect.tsx` | `"use client"`. School `<select>` (`UNIVERSITIES` + "My school isn't listed" → host input). Guide with the resolved `https://<host>/calendar`, "Copy Canvas address". Paste field, `precheckIcalUrl` on blur, `useActionState(connectCanvasAction)`. Success → summary plus "See your week". | props: `{school: string \| null; status: CanvasStatusView; canChange: boolean}` |
| `src/app/(app)/setup/GoogleConnect.tsx` | Server component. Disclosure (§9.3) in a `<details open>`. Button `<a href="/api/google/oauth">` only when `canChange`, else `FreshLinkNotice`. Connected state lists what Aria can and can't do from the granted scopes. | props: `{status: GoogleStatusView; canChange: boolean; banner: GoogleConnectStatus \| null}` |
| `src/app/(app)/setup/ScheduleForm.tsx` | `"use client"`. Briefing `<select>`, quiet start/end `<select>`, quiet-hours overlap warning (pure fn), "Use this phone's time zone (X)" when `Intl` tz ≠ saved | props: `{schedule}` |
| `src/app/(app)/setup/ToneForm.tsx` | `"use client"`. Radio group of 3 with a sample bubble each | props: `{tone}` |
| `src/app/(app)/setup/actions.ts` | `"use server"` | `connectCanvasAction(prev: ActionResult<CanvasConnected> \| null, form: FormData): Promise<ActionResult<{host: string; itemCount: number; upcomingCount: number}>>` (`fresh_setup`, rate limit, zod `{url: string ≤ 2048, school?: string ≤ 120, customHost?: string ≤ 253}` → V2-05 `connectCanvas` → V2-04 `setProfileSchool` → `refresh()`); `disconnectCanvasAction(): Promise<ActionResult>` (`fresh_setup`); `saveScheduleAction(prev, form): Promise<ActionResult>` (`any`; updates `users` → V2-06 `onSchedulePrefsChanged(userId)`); `saveTimezoneAction(prev, form): Promise<ActionResult>` (`any`; `Intl` validation → V2-06 hook); `saveToneAction(prev, form): Promise<ActionResult>` (`any`; merges into `persona_prefs`) |

### 7.5 `/week`

| Path | Purpose | Data |
|---|---|---|
| `src/app/(app)/week/page.tsx` | Header (name's week, timezone, week load), "Still open", 7 day groups, schedule rows, prev/next link (`?w=`), empty states, sync-status banner. `searchParams: Promise<{w?: string; src?: string}>`. `src=pwa` without a session → `SignedOut pwa`. | `getWeekView(viewer, {offsetWeeks})` |
| `src/server/web/week-data.ts` | DAL: V2-05 `listTimeline(userId, {from, to, includeDone: true, overdueSince})` → `WeekItem[]` → `groupWeek`. Builds `allowHosts` from the Canvas host. | `getWeekView(viewer: Viewer, opts: {offsetWeeks: 0 \| 1; now?: Date}): Promise<{week: WeekView; canvas: CanvasStatusView; googleConnected: boolean; allowHosts: string[]}>` |
| `src/app/(app)/week/DayGroup.tsx` | Server component: day header, `LoadBar`, deadline list, schedule list | props `{day, timeZone, allowHosts}` |
| `src/app/(app)/week/LoadBar.tsx` | 3 segments plus text label; `role="img"` with `aria-label` "Busy day: 2 things due" | props `{level, points, label}` |
| `src/app/(app)/week/DoneToggle.tsx` | `"use client"`. `useOptimistic`, `aria-pressed`, 44 px. Calls `setItemStatusAction`. | props `{itemId, title, done}` |
| `src/app/(app)/week/actions.ts` | `"use server"` | `setItemStatusAction(itemId: string, done: boolean): Promise<ActionResult>` (`any`; UUID check → V2-05 `setTimelineItemStatus(userId, itemId, done ? "done" : "upcoming")` → `refresh()`) |

### 7.6 `/settings`

| Path | Purpose | Data |
|---|---|---|
| `src/app/(app)/settings/page.tsx` | Sections: Connected accounts, What Aria knows about you (profile, preferences, things Aria remembers, pending suggestions), Sign out, Your data (export), Delete account | `getSettingsView(viewer)` |
| `src/server/web/settings-data.ts` | DAL | `getSettingsView(viewer: Viewer): Promise<{canvas: CanvasStatusView; google: GoogleStatusView; memory: MemoryView; canChange: boolean; isRecent: boolean; freshUntilLabel: string \| null}>`. Uses V2-04 `listMemory(userId)`. |
| `src/app/(app)/settings/MemoryList.tsx` | `"use client"`. Each row: text, "Edit" (inline textarea when `isRecent`), "Delete" (confirm in place). Proposed prefs: "Keep" / "Don't keep". | props `{memory, isRecent}` |
| `src/app/(app)/settings/DeleteAccount.tsx` | `"use client"`. `ConfirmDialog` with `requireText="delete"` | props `{canChange}` |
| `src/app/(app)/settings/actions.ts` | `"use server"` | `editPreferenceAction(prefId: string, statement: string): Promise<ActionResult>` (`recent`, 1–280 chars); `removePreferenceAction(prefId: string)` (`any`); `answerProposalAction(prefId: string, keep: boolean)` (`recent`); `editFactAction(factId: string, content: string)` (`recent`, 1–500 chars); `deleteFactAction(factId: string)` (`any`); `disconnectGoogleAction()` (`fresh_setup` → V2-07 `disconnectGoogle(userId, {reason: "user"})`); `disconnectCanvasAction` re-exported from setup; `deleteAccountAction(prev, form): Promise<ActionResult>` (`fresh_setup`, `form.confirm === "delete"` → `deleteAccount` → clear cookie → `redirect("/account-deleted" + (googleRevoked ? "" : "?g=0"))`) |
| `src/app/api/me/export/route.ts` | `POST` only. Origin check, `fresh_setup`, rate limit 3 per hour → JSON attachment `aria-export-YYYY-MM-DD.json`, `Cache-Control: no-store` | `export async function POST(req: NextRequest): Promise<Response>` |
| `src/server/account/export.ts` | Collects the user's rows, paged by 1,000 | `collectAccountExport(userId: string): Promise<AccountExport>`; `shapeExport(raw: RawExport): AccountExport` (pure, strips `enc_*`, hashes, internal ids where noted) |
| `src/server/account/delete.ts` | Hard delete orchestration (also used by V2-04's chat "delete my account" tool) | `deleteAccount(userId: string, opts: {via: "web" \| "chat"}): Promise<{ok: true; googleRevoked: boolean}>` |

**Export contents (JSON, version `1`):**
- **Included:** `users` (name, timezone, briefing, quiet hours, persona prefs, created_at), `channels` (kind, handle, created_at, opted_out_at, paused_until), `consents`, `signups` (own), `user_profile`, `user_preferences` (all statuses), `memory_facts` (not deleted), `timeline_items`, `reminders`, `messages` (body, direction, created_at; retained 180 days), `email_items` (subject, from, summary; no bodies are stored anyway), `syllabi.parsed_json`, `pending_actions` (kind, payload, status), `integrations` (provider, account_email, scopes, status, synced_at **only**).
- **Excluded:** `enc_*`, `gcal_channel_token_hash`, `magic_links`, `web_sessions`, `jobs`, `agent_runs`, `llm_calls`, `user_runtime`, `conversation_summaries` (internal; include if Daniel wants, §13).

**`deleteAccount` order** (idempotent; safe to re-run):
1. Call V2-07 `disconnectGoogle(userId, {reason: "account_deleted"})`, which revokes at Google, stops the Gmail watch and calendar channels, and deletes the row. Retry once; record `googleRevoked`.
2. Delete `signups` where `matched_user_id = userId` **or** `phone_e164 in (user's phone handles)`. They'd otherwise survive via `on delete set null`.
3. `delete from users where id = userId`. Everything else cascades: channels, messages, sessions, magic_links, jobs, reminders, timeline, memory, pending_actions, integrations, syllabi. `llm_calls.run_id` is set null, and those rows hold no PII.
4. Log `account_deleted` with a masked handle, never the name.

### 7.7 `/email/[id]`

| Path | Purpose | Data |
|---|---|---|
| `src/app/(app)/email/[id]/page.tsx` | `params: Promise<{id: string}>`. Non-UUID → `notFound()`. States: **pending** (editable subject/body; To/Cc read-only), **sent**, **cancelled**, **expired**, **failed**. Links: "Show the email you're replying to" (Gmail permalink, only if `originalRfc822Id`) and "Back to Messages". | `getDraftView(viewer, id)` |
| `src/server/web/email-data.ts` | DAL | `getDraftView(viewer: Viewer, id: string): Promise<DraftView \| null>`, where `DraftView = {id; version: number; status: "pending" \| "sent" \| "cancelled" \| "expired" \| "failed"; to: string[]; cc: string[]; from: string; subject: string; body: string; expiresAtLabel: string; decidedAtLabel: string \| null; originalPermalink: string \| null; canSend: boolean /* isRecent */}`. Built from V2-07's `getPendingAction` + `SendEmailPayload`. All strings go through `cleanText` (display only; the body textarea keeps the raw text). |
| `src/app/(app)/email/[id]/DraftEditor.tsx` | `"use client"`. Subject input, body textarea (auto-grow, `pre-wrap`), "Save changes", **Send** (`SubmitButton`, disabled while dirty → "Save first"), Cancel (`ConfirmDialog`). Hidden `version` field. | props `{draft: DraftView}` |
| `src/app/(app)/email/[id]/actions.ts` | `"use server"` | `saveDraftAction(prev, form): Promise<ActionResult<{version: number}>>` (`recent`; zod `{id: uuid, version: int, subject ≤ 255 (no CR/LF), body ≤ 20,000}` → `revisePendingAction(..., "web")`); `sendDraftAction(prev, form): Promise<ActionResult<{sentAtLabel: string}>>` (`recent`, rate limit → `confirmPendingAction(userId, id, {expectedVersion, via: "web"})` → `refresh()`); `cancelDraftAction(prev, form): Promise<ActionResult>` (`any`) |

**Why To and Cc are read-only on the web:**
- Changing recipients is the one edit that turns a draft into an exfiltration channel if a link is forwarded or an injected draft slips through.
- Changing them in chat keeps that decision in the user-authored chat stream (friend-protection 2).

**Body edits on the web are user-authored**, so they're fine.

---

## 8. Interfaces consumed from other branches (contract requests)

The signatures below are what this branch codes against. Owners may rename them, but the shapes are what the UI needs. Until a branch lands, `src/server/web/ports.ts` is the **only** file that imports other branches. It re-exports these names, and a temporary stub returns `{ok:false, code:"unavailable"}` (marked `// PORT_STUB`). §12 requires zero `PORT_STUB` remaining.

### V2-05: timeline and Canvas

```ts
// src/server/timeline/index.ts
export interface TimelineViewItem {
  id: string;
  source: "canvas" | "gcal" | "gmail" | "syllabus" | "aria";
  kind: "assignment" | "exam" | "event" | "class" | "block";
  title: string;                 // decoded (no iCal escapes / HTML entities), untrusted
  course: string | null;         // e.g. "CPSC 323" (the [Course] fix)
  startsAt: Date | null;
  endsAt: Date | null;
  dueAt: Date | null;
  allDay: boolean;               // DTSTART;VALUE=DATE
  allDayDate: string | null;     // "YYYY-MM-DD" floating date when allDay
  url: string | null;            // raw; UI applies safeExternalUrl
  status: "upcoming" | "done" | "dismissed";
}
/** Items owned by userId intersecting [from, to) by due_at/starts_at; plus, when
 *  overdueSince is set, status='upcoming' items due in [overdueSince, from). */
export function listTimeline(
  userId: string,
  range: { from: Date; to: Date },
  opts?: { includeDone?: boolean; overdueSince?: Date },
): Promise<TimelineViewItem[]>;
/** Scoped by user_id; idempotent. */
export function setTimelineItemStatus(
  userId: string, itemId: string, status: "upcoming" | "done" | "dismissed",
): Promise<{ ok: true } | { ok: false; code: "not_found" }>;

// src/server/integrations/canvas/index.ts
export type CanvasConnectError =
  | "not_a_url" | "not_ical" | "not_canvas" | "private_address"
  | "feed_not_found" | "unreachable" | "timeout" | "too_large";
export function connectCanvas(input: {
  userId: string; rawUrl: string; schoolName?: string | null;
}): Promise<
  | { ok: true; host: string; itemCount: number; upcomingCount: number } // 0 is success
  | { ok: false; code: CanvasConnectError }
>;
export function disconnectCanvas(userId: string): Promise<void>; // delete row + future canvas items; V2-06 cancels anchored reminders
export type CanvasStatusView =
  | { connected: false }
  | { connected: true; host: string; urlHint: string /* "yale.instructure.com/feeds/…a1b2" */;
      syncedAt: Date | null; health: "ok" | "failing"; lastError: CanvasConnectError | null };
export function getCanvasStatus(userId: string): Promise<CanvasStatusView>;

// src/shared/universities.ts (salvaged from mobile/lib/universities.ts, 52 schools)
export interface University { name: string; canvasDomain: string }
export const UNIVERSITIES: readonly University[];
export function canvasHostForSchool(name: string | null): string | null;      // host, no scheme
export function normalizeCanvasHost(input: string): string | null;           // "https://x.edu/..." | "x.edu" → "x.edu"

// src/shared/canvas-url.ts (pure, client-safe pre-check; server re-validates)
export function precheckIcalUrl(raw: string):
  | { ok: true; normalized: string }               // webcal:// → https://
  | { ok: false; code: "empty" | "not_a_url" | "not_ical" };
```

Requests and notes to V2-05:
- **Unlisted schools.** The host allow-list must accept them: `*.instructure.com`, any `UNIVERSITIES` domain, or **any public host whose path matches `/feeds/calendars/user_[A-Za-z0-9]+\.ics`**, after DNS and private-IP checks. Otherwise "My school isn't listed" is a dead end.
- **`universities.ts` ownership.** V2-05 creates it. If web task W5 starts first, W5 creates it verbatim from `mobile/lib/universities.ts` with the exports above, and V2-05 adopts it.

### V2-07: Google and email

```ts
// Routes (V2-07 owns):
// GET /api/google/oauth     → requires fresh_setup (canChangeIntegrations). Else 303 /setup?google=stale.
//                              Sets state+PKCE cookie, 303 to Google (prompt=consent, access_type=offline,
//                              include_granted_scopes=true).
// GET /api/google/callback  → must NOT require freshness (state-cookie bound). Always 303 to
//                              `/setup?google=<GoogleConnectStatus>` (fixed codes only).
export type GoogleConnectStatus =
  | "connected" | "missing_scopes" | "denied" | "admin_blocked" /* error=admin_policy_enforced [verify] */
  | "stale" | "expired" /* state missing/mismatch */ | "error";

// src/server/integrations/google/index.ts
export type GoogleStatusView =
  | { connected: false }
  | { connected: true; email: string; canReadMail: boolean; canSendMail: boolean;
      canReadCalendar: boolean; canWriteAriaCalendar: boolean;
      health: "ok" | "needs_reconnect"; connectedAt: Date };
export function getGoogleStatus(userId: string): Promise<GoogleStatusView>;
/** Revoke refresh token at Google, stop Gmail watch + calendar channels, delete the
 *  integration row and derived gcal timeline items / email_items. Idempotent. */
export function disconnectGoogle(
  userId: string, opts: { reason: "user" | "account_deleted" },
): Promise<{ revoked: boolean }>;

// src/shared/email-draft.ts (pure; zod)
export const SendEmailPayload: z.ZodObject<{
  from: z.ZodString; to: z.ZodArray<z.ZodString>; cc: z.ZodArray<z.ZodString>;
  subject: z.ZodString; body: z.ZodString;          // plain text
  threadId: z.ZodOptional<z.ZodString>;
  inReplyTo: z.ZodOptional<z.ZodString>; references: z.ZodOptional<z.ZodArray<z.ZodString>>;
  originalRfc822Id: z.ZodOptional<z.ZodString>;     // for the Gmail permalink
}>;
```

### Pending-action path: one deterministic path for chat and web

Owner: V2-04 (`confirm_action`) with V2-07's `send_email` executor. File suggestion: `src/server/actions/pending.ts`.

```ts
export interface PendingActionView {
  id: string; kind: "send_email"; version: number;
  status: "pending" | "confirmed" | "cancelled" | "expired" | "failed";
  payload: unknown;        // parse with SendEmailPayload
  createdAt: Date; expiresAt: Date; decidedAt: Date | null;
  result: { sentAt?: string; gmailMessageId?: string; error?: string } | null;
}
export function getPendingAction(userId: string, id: string): Promise<PendingActionView | null>;
/** UPDATE ... SET payload = payload || patch, version = version + 1
 *  WHERE id AND user_id AND status='pending' AND expires_at > now() AND version = expectedVersion */
export function revisePendingAction(
  userId: string, id: string, expectedVersion: number,
  patch: { subject?: string; body?: string }, via: "web" | "chat",
): Promise<{ ok: true; version: number } |
           { ok: false; code: "not_found" | "not_pending" | "expired" | "version_conflict" }>;
/** Atomic pending→confirmed transition (same version guard), then run the executor.
 *  Posts the in-chat confirmation ("sent ✅") when via === "web" so the thread stays
 *  coherent. Idempotent: a second call returns not_pending. */
export function confirmPendingAction(
  userId: string, id: string, opts: { expectedVersion: number; via: "web" | "chat" },
): Promise<{ ok: true; sentAt: Date } |
           { ok: false; code: "not_found" | "not_pending" | "expired" | "version_conflict"
                            | "google_disconnected" | "send_failed" }>;
export function cancelPendingAction(
  userId: string, id: string, via: "web" | "chat",
): Promise<{ ok: true } | { ok: false; code: "not_found" | "not_pending" }>;
```

**Draft link minting.** Draft links must be minted with `{purpose: "email_draft", target: "/email/<id>", preview: {kind: "email"}}`.

### V2-04: memory, profile, and the link tool

```ts
// src/server/memory/index.ts
export interface MemoryView {
  profile: { name: string | null; school: string | null; courses: string[] };
  preferences: Array<{ id: string; key: string; statement: string;
                       status: "active" | "proposed"; validFrom: Date }>;
  facts: Array<{ id: string; content: string; createdAt: Date; expiresAt: Date | null }>;
}
export function listMemory(userId: string): Promise<MemoryView>;
/** Supersede semantics: close the active row, insert a new active row (source 'explicit'). */
export function editPreference(userId: string, prefId: string, statement: string): Promise<{ ok: true } | { ok: false; code: "not_found" }>;
export function removePreference(userId: string, prefId: string): Promise<{ ok: true } | { ok: false; code: "not_found" }>;
export function answerProposal(userId: string, prefId: string, keep: boolean): Promise<{ ok: true } | { ok: false; code: "not_found" | "not_pending" }>;
export function editFact(userId: string, factId: string, content: string): Promise<{ ok: true } | { ok: false; code: "not_found" }>;
/** Hard delete ("forget X" must really forget). */
export function deleteFact(userId: string, factId: string): Promise<{ ok: true } | { ok: false; code: "not_found" }>;
export function setProfileSchool(userId: string, school: string | null): Promise<void>;
```

Further requests to V2-04:
- **Persona.** Read tone through `parsePersonaPrefs(users.persona_prefs)` from `src/shared/persona-prefs.ts`. `mirror` is the default (the locked decision).
- **Link tool.** It must handle "setup" (→ `purpose:"setup"`, `target:"/setup"`, `preview.kind:"setup"`), "settings" (→ `purpose:"setup"`, `target:"/settings"`, `preview.kind:"settings"`), "new link" / "my week" (→ `view`, `/week`, `preview.kind:"week"`, `n`=due count), and "draft link" (latest pending draft). Every web "Text Aria" button relies on these keywords.
- **Chat account commands.** "Delete my account" should call `deleteAccount(userId, {via:"chat"})` from `src/server/account/delete.ts` after an in-chat confirmation. "Export my data" should reply with a settings link (the web export needs a fresh session).

### V2-06 and V2-03: scheduling and delivery

```ts
// V2-06: src/server/briefing/index.ts (or schedule module)
/** Recompute users.next_briefing_at (DST-safe) and re-plan deferred proactive
 *  messages after briefing_time / briefing_enabled / quiet_* / timezone change. */
export function onSchedulePrefsChanged(userId: string): Promise<void>;
```

- **V2-06:** honor `users.briefing_enabled = false`, so no briefing is sent. Suppress anchored reminders whose timeline item is `done`.
- **V2-03:** `deliver()` reads quiet hours from `users.quiet_start/quiet_end` (local time, window may wrap midnight). Non-proactive replies ignore quiet hours. The web never calls `deliver()` directly.

---

## 9. Copy deck

Voice: plain, second person, active, short. Errors say what happened **and** how to fix it. Aria-style casualness lives in chat; the web is calm and clear. Quoted keywords use straight quotes inside the UI: Text Aria "setup".

### 9.1 Shared

| Key | Copy |
|---|---|
| Nav | Week · Setup · Settings |
| SignedOut (default) | **Open this from Aria.** Aria signs you in with links it texts you. Tap your latest link from Aria, or text Aria "new link" to get one. [Text Aria for a link] |
| SignedOut (setup) | **Open this from Aria.** Text Aria "setup" and tap the link it sends. Links work for 30 minutes. [Text Aria "setup"] |
| SignedOut (settings) | **Open this from Aria.** Text Aria "settings" and tap the link it sends. [Text Aria "settings"] |
| SignedOut (pwa) | **Sign in through Messages.** The Home Screen app can't use your Safari sign-in yet. Open your latest link from Aria in Safari, or text Aria "new link". |
| Fresh link needed | For your security, connecting or removing accounts needs a fresh link. Text Aria "setup" and open the link it sends within 15 minutes. [Text Aria "setup"] |
| Fresh until | You can connect accounts until {3:42 PM}. |
| Recent link needed (edit/send) | This link is more than an hour old. Text Aria "{draft link \| settings}" for a fresh one, or reply in Messages instead. |
| signed_out | You're signed out. Text Aria "new link" to sign back in. |
| bad_origin | That request didn't come from this page. Reload the page and try again. |
| rate_limited | Too many tries. Wait 10 minutes and try again. |
| invalid | Something in that form isn't right. Check it and try again. |
| server | Something broke on our end. Try again, and text Aria if it keeps happening. |
| unavailable | This part of Aria isn't ready yet. Text Aria to do it in chat. |
| Skew (error.tsx) | **Aria just updated.** Reload the page and try again. [Reload] |
| Generic error | **Something broke on our end.** Your info is safe. [Try again] or text Aria. |
| 404 | **Nothing here.** This page doesn't exist, or the link is cut off. Text Aria "new link" for a fresh one. [Go to aria home] |
| Signed out page | **You're signed out.** To get back in, tap a link from Aria. |
| Sign out | Sign out on this phone |
| Sign out everywhere | Sign out everywhere · Signs out every browser that opened an Aria link. Your texts with Aria keep working. |
| Back to chat | Back to Messages |
| Offline (client fetch fail) | You look offline. Check your connection and try again. |
| Saving | Saving… / Saved. |

### 9.2 `/setup`

| Key | Copy |
|---|---|
| Title | Set up Aria |
| Intro | Connect your accounts so Aria knows what's due and when you're free. You can change any of this later in Settings. |
| **Canvas** section | **Canvas** · Connected / Not connected |
| Canvas intro | Aria reads your Canvas calendar feed: assignments, quizzes, and exams with their due dates. It can't see your grades or submissions. |
| School label | Your school |
| School unlisted | My school isn't listed |
| Custom host label / hint | Your Canvas address · The part before the first slash when you open Canvas, like canvas.myschool.edu |
| Guide title | Get your Canvas calendar link |
| Step 1 | Open Canvas and go to Calendar. [Open {yale.instructure.com}/calendar] |
| Step 2 | Scroll down and tap **Calendar Feed**. A box with a link pops up. |
| Step 3 | Copy that whole link, come back here, and paste it below. |
| Guide tip | If the Canvas app opens instead of Safari, copy the address and paste it into Safari. It's easiest on a laptop. [Copy Canvas address] / Copied. |
| Guide alt | Or paste the link straight into your chat with Aria. |
| Paste label / placeholder | Calendar Feed link · https://…/feeds/calendars/user_….ics |
| Connect button / pending | Connect Canvas / Checking your feed… |
| precheck empty | Paste your Calendar Feed link first. |
| not_a_url | That isn't a link. Copy the whole address from the Calendar Feed box. It starts with https:// or webcal://. |
| not_ical | That's a Canvas page, not your calendar feed. The link should end in .ics. In Canvas, open Calendar, tap Calendar Feed, and copy the link in that box. |
| not_canvas / private_address | That link isn't from Canvas. Copy it from Calendar Feed in your school's Canvas. |
| feed_not_found | Canvas says that feed doesn't exist. It may have been reset. Copy a fresh link from Calendar Feed and paste it again. |
| unreachable | Aria couldn't reach Canvas. Check the link, then try again in a minute. |
| timeout | Canvas took too long to answer. Try again in a minute. |
| too_large | Your calendar is bigger than Aria can read right now. Text Aria "help" and Daniel will sort it out. |
| Success (n>0) | **Canvas connected.** Aria found {n} things due in the next two weeks. [See your week] |
| Success (n=0) | **Canvas connected.** Nothing's due in the next two weeks. Aria checks Canvas every hour. |
| Connected status | Connected to {host} · Last checked {4:10 PM}. [Use a different link] [Disconnect] |
| Failing status | Aria couldn't read your Canvas feed since {Tue 4:10 PM}. Paste a fresh Calendar Feed link to fix it. |
| Disconnect confirm | **Disconnect Canvas?** Aria stops checking Canvas and removes your upcoming Canvas deadlines. Reminders tied to them are canceled. [Disconnect] [Keep it] |
| **Google** section | **Google** · Connected as {email} / Not connected |
| Google intro | Connect Gmail and Google Calendar so Aria can spot emails that need you, plan around your schedule, and draft replies. |
| What Aria reads | **What Aria reads:** Your Gmail inbox, to flag emails that matter (professors, deadline changes, recruiters) and to give drafts context. Your Google Calendar, to see classes and plans. |
| What Aria does | **What Aria does:** Adds study and gym blocks to its own calendar called "Aria", which you can hide or delete anytime. Sends an email only after you say "send it". |
| What Aria never does | **What Aria never does:** Delete, archive, or change your emails. Edit events on your other calendars. Sell your data, use it for ads, or train AI models on it. |
| AI processing | To write replies, Aria sends the parts of your email and calendar it needs to its AI providers (Anthropic's Claude, with OpenAI as a backup). They don't train on it. |
| Unverified warning | **Google will show a warning.** Aria is a small private test, so Google hasn't reviewed it yet. You'll see "Google hasn't verified this app." To continue, tap **Advanced**, then **Go to Aria (unsafe)**, then check every box. Only continue if you're comfortable with that. |
| Own account only | Connect only your own Google account. |
| School accounts | Some school Google accounts block apps like Aria. If yours does, use a personal Gmail or skip this step. |
| Connect button | Connect Google |
| Disconnect | Disconnect Google |
| Disconnect confirm | **Disconnect Google?** Aria loses access to your Gmail and Calendar right away and deletes the emails and events it pulled in. The "Aria" calendar stays in your Google Calendar until you delete it. [Disconnect] [Keep it] |
| Connected capabilities | Aria can: read your inbox ✓ · send emails you approve ✓ · see your calendar ✓ · add blocks to the "Aria" calendar ✓ (each ✗ when the scope is missing) |
| banner connected | Google connected as {email}. |
| banner missing_scopes | Google connected, but some boxes were unchecked, so Aria can't {read your email \| send email for you \| see your calendar \| add study blocks}. Tap Connect Google again and check every box. |
| banner denied | You canceled Google sign-in, so nothing changed. Tap Connect Google to try again. |
| banner admin_blocked | Your school's Google account blocks apps like Aria. Try a personal Gmail, or skip Google for now. |
| banner stale | That setup link is more than 15 minutes old. Text Aria "setup" for a fresh one, then tap Connect Google. |
| banner expired | That sign-in took too long. Tap Connect Google to start again. |
| banner error | Google sign-in didn't finish. Try again in a minute. |
| needs_reconnect | Google stopped working for Aria. This happens if you removed access in your Google account. Tap Connect Google to fix it. |
| **Briefing** section | **Morning briefing** |
| Briefing label / hint | Send my briefing at · Aria texts you what's due and what's on your calendar. |
| Briefing off option | Don't send a briefing |
| Time zone line | Times are in {Eastern Time}. |
| Time zone mismatch | This phone is set to {Pacific Time}. [Use Pacific Time] |
| **Quiet hours** | **Quiet hours** · Aria won't text you first between these times. It still answers when you text it. |
| Quiet labels | From · Until |
| Overlap warning | Your briefing time is inside quiet hours, so it will arrive at {8:00 AM} instead. |
| Save | Save / Saving… / Saved. |
| **Tone** section | **How Aria talks** |
| Tone mirror | Match me · Aria picks up how you text. *Sample: "3 things due this week, the pset's the big one"* |
| Tone casual | Casual · lowercase, short, a little slang. *Sample: "ok 3 things this week. pset is the big one, start tmr?"* |
| Tone polished | Polished · Full sentences, no slang. *Sample: "You have 3 deadlines this week. The problem set is the largest."* |
| Footer | Done for now? [Back to Messages] |

### 9.3 `/week`

| Key | Copy |
|---|---|
| Title | {Name}'s week / Your week |
| Subtitle | Next 7 days · {Eastern Time} / Following 7 days · {Eastern Time} |
| Week load | Light week · {n} things due / Busy week · {n} things due / Heavy week · {n} things due |
| Still open | **Still open** · Past due and not marked done |
| Day label | Today · Tomorrow · Wed, Oct 14 |
| Day load (a11y label) | Light day / Busy day: 2 things due / Heavy day: 4 things due |
| Due line | Due 11:59 PM / Due today (all day) / Exam 9:00 AM |
| Schedule line | 10:30–11:45 AM · {title} / All day · {title} |
| Done toggle (a11y) | Mark "{title}" done / Mark "{title}" not done |
| Done state | Done · [Undo] |
| Open link | Open in Canvas / Open in Google Calendar |
| Nav | Next week → / ← This week |
| Empty, no Canvas | **Connect Canvas and your deadlines show up here.** It takes about a minute. [Connect Canvas] |
| Empty, connected | **Nothing due in the next 7 days.** Aria checks Canvas every hour. |
| No Google hint | Connect Google to see your classes and plans here too. [Set up Google] |
| Sync failing | Aria couldn't read your Canvas feed since {Tue 4:10 PM}. [Fix it in Setup] |
| Mark-done error | Couldn't save that. Try again. |

### 9.4 `/settings`

| Key | Copy |
|---|---|
| Title | Settings |
| Accounts | **Connected accounts** · Canvas: {Connected to host \| Not connected} · Google: {Connected as email \| Not connected} [Manage in Setup] |
| Memory title | **What Aria knows about you** |
| Memory intro | Aria remembers what you tell it in chat. It never learns from your emails, Canvas, or calendar. Edit or delete anything here, or text Aria "forget …". |
| Profile | About you · Name {Dan} · School {Yale University} · Courses {CPSC 323, ECON 115} |
| Preferences | **How you like things** · e.g. "No gym after 8pm" [Edit] [Delete] |
| Proposed | **Aria's suggestions** · Aria noticed this but hasn't saved it as a rule yet. "{statement}" [Keep it] [Don't keep] |
| Facts | **Things Aria remembers** · {content} · Saved Oct 9 [Edit] [Delete] |
| Empty memory | Aria doesn't remember anything about you yet. Tell it in chat, like "I'm a night owl" or "sign my emails Best, Dan". |
| Delete confirm (inline) | Delete this? Aria will forget it. [Delete] [Cancel] |
| Edit validation | Write something, up to 280 characters. / Keep it under 280 characters. |
| Edit needs recent | Editing needs a link from the last hour. Text Aria "settings" for a fresh one. You can still delete things. |
| Sign out | **Sign out** [Sign out on this phone] [Sign out everywhere] |
| Export | **Your data** · Download everything Aria has stored about you as a JSON file: your profile, messages from the last 180 days, deadlines, reminders, and memories. [Download my data] |
| Export needs fresh | Downloading your data needs a fresh link. Text Aria "settings" and open the link within 15 minutes. |
| Delete title | **Delete my account** |
| Delete body | Aria deletes your messages, deadlines, memories, and settings right away, disconnects Google and Canvas, and stops texting you. This can't be undone. |
| Delete dialog | **Delete your Aria account?** Type **delete** to confirm. [Delete my account] [Keep my account] |
| Delete type error | Type delete to confirm. |
| Deleted page | **Your account is deleted.** Aria removed your data and disconnected your accounts. If you text Aria again, it starts fresh. |
| Deleted, revoke failed | One more step: Google didn't confirm the disconnect. Remove Aria at myaccount.google.com/permissions. [Open Google permissions] |

### 9.5 `/email/[id]`

| Key | Copy |
|---|---|
| Title | Email draft |
| Meta | From {you@gmail.com} · To {prof@yale.edu} · Cc {…} |
| Recipients hint | To change who this goes to, tell Aria in Messages. |
| Subject label | Subject |
| Body label | Message |
| Expires | This draft expires at {Sat 3:10 PM}. |
| Save | Save changes / Saving… / Saved. |
| Send / pending | Send email / Sending… |
| Send blocked while dirty | Save your changes before sending. |
| Sent | **Sent** at {3:12 PM}. Aria also confirmed it in Messages. |
| Cancel | Cancel draft · confirm: **Cancel this draft?** Aria won't send it. [Cancel draft] [Keep it] |
| Cancelled | You canceled this draft. Ask Aria for a new one anytime. |
| Expired | This draft expired, so Aria didn't send it. Ask Aria to draft it again. |
| version_conflict | This draft changed in your chat with Aria. Here's the latest version. Check it, then send. |
| not_pending (already sent) | This draft was already sent or canceled. |
| google_disconnected | Aria can't send this because Google isn't connected. Connect it in Setup, then try again. |
| send_failed | Gmail didn't accept the email, so it wasn't sent. Try again, or text Aria "help". |
| Original email | Show the email you're replying to |
| Subject validation | Subjects can't be longer than 255 characters. |

---

## 10. Test plan

**Unit tests (Jest, `tests/unit/`, pure)**

| File | Covers |
|---|---|
| `week.test.ts` | `localDayKey` across DST start and end (America/New_York 2026-11-01, 2027-03-14), UTC+13, UTC−10. All-day items never shift a day. `groupWeek` window edges (23:59:59 local today vs 00:00 tomorrow), "Still open" (overdue ≤ 7 days, upcoming only), done sorting, exams before assignments at equal time. `weekLoad` boundaries 3/4/6/7. `dayLoad` 1/2/3. `dayLabel` Today/Tomorrow/weekday. `offsetWeeks=1`. |
| `safe-url.test.ts` | Rejects `javascript:`, `JaVaScRiPt:`, `data:`, `http:`, userinfo (`https://a@evil`), lookalike hosts (`instructure.com.evil.io`), and > 2048 chars. Accepts `*.instructure.com` and the configured host. `cleanText` strips U+202E/U+2066 and zero-width chars and truncates. `gmailPermalink` encodes `<`/`>`. |
| `schedule-prefs.test.ts` | Option lists. `briefingInQuietHours` with wrap-around (22:00–08:00, 01:00–06:00, and a non-wrapping window). zod rejects off-list values. |
| `persona-prefs.test.ts` | Defaults to `mirror` on `{}`, garbage, or an unknown tone. Round trip. |
| `copy.test.ts` | Every `ActionErrorCode`, `CanvasConnectError`, and `GoogleConnectStatus` has non-empty copy. No copy says "error occurred" or "invalid input" (lint for vague strings). |
| `export-shape.test.ts` | `shapeExport` never includes keys matching `/^enc_|token|hash/`. Output has a version and timestamps. |
| `link-policy.test.ts` (extend) | `settings` preview title. `ogImageFor` maps every kind and falls back to default. `safeTarget` rejects `/email/../settings` and `//evil.com`. |
| `guard.test.ts` | `isRecent` and `freshUntil` boundaries (59:59 vs 60:00, setup 14:59 vs 15:00). Origin comparison helper (missing, `null`, scheme mismatch, port mismatch). |
| `assets.test.ts` | Each `public/og/*.jpg` is 1200×630 (JPEG SOF0/SOF2 header parse, no deps) and < 300 KB. Icons are the exact sizes (PNG IHDR parse). Manifest object has the required fields. |
| `render.test.tsx` | `renderToStaticMarkup` of `LoadBar` (label text present), `ExternalLink` (no `<a>` for a bad URL), and `DayGroup` with a hostile title `<img src=x onerror=alert(1)>` (escaped, no tag). |

**Smoke tests (`npm run smoke:web`, real Supabase project, throwaway rows deleted in `afterAll`)**
- `account.smoke.test.ts`:
  - Create user, channel, signup, prefs, facts, timeline, messages, and session.
  - `collectAccountExport` returns them, paging works with 1,050 messages, and there are no `enc_*` keys.
  - `deleteAccount` removes the user, the matched signup, and the same-phone signup, and cascades. A second call is a no-op.
  - Google disconnect runs through the port stub, or the real function once landed.
- `session.smoke.test.ts`: `revokeSession` and `revokeAllSessions` make `readSession` return null.
- `schedule.smoke.test.ts`: `saveSchedule` round-trips to `users`, and the V2-06 hook is called (spy via the port).

**E2E and visual (Playwright 1.63.0, `channel: "chrome"`, optional `webkit`)**
- **Global setup:** with the service-role key from `.env.local`, insert a throwaway user, timeline fixtures (including a hostile title and an all-day item), a pending draft, and two sessions (`setup` fresh, `view` old). Write `storageState` files carrying the `aria` cookie for `localhost`. Teardown deletes the user.
- **Projects:** `iphone-se` (375×667, DPR 2), `iphone-15` (393×852, DPR 3, touch, iOS UA), `pro-max` (430×932), `desktop` (1280×800). Each runs light and dark (`colorScheme`) plus one run with `reducedMotion: "reduce"`.
- **Flows:**
  - `/m#t=<minted token>` redeems and lands on `/week`. Reopening the used link with the session still routes; without it, `/link-expired`.
  - `/week` groups and toggles done (optimistic, survives reload).
  - `/setup` with the view session shows the fresh-link notice and no Connect buttons. With the fresh session, Canvas connect is mocked through the port stub returning each error code, and the copy appears.
  - `?google=missing_scopes` banner appears and is stripped from the URL.
  - `/settings` memory edit is blocked for the old session. Delete-account dialog needs "delete".
  - `/email/[id]`: Save bumps the version. A stale version shows the conflict copy. Send hits the stub.
  - 404 page. Action without `Origin` (via `request.post`) → `bad_origin`.
  - No horizontal scroll (`scrollWidth <= clientWidth`) on every page and viewport.
- **Screenshots:** `qa:shots` writes `test-results/shots/<project>/<page>-<scheme>.png` for human review (not pixel-diffed, to avoid flaky font diffs).
- **No-Playwright fallback:** Chrome `--headless=new --window-size=500,1000 --screenshot` at the 500 px minimum, as a coarse check only.

**Manual a11y pass (each page):** VoiceOver rotor shows headings and landmarks. Tab order. Focus visible. Dialog traps focus and Esc closes it. Errors announced. Zoom 200% with no loss. Contrast verified for the new tokens (§2.1).

---

## 11. Ordered implementation tasks (one sub-agent each)

Legend: **Owns** = files the agent may create or edit. **Waits** = which branch must land first. Implementation agents don't run `npm install` or `next build`; they use `npx tsc --noEmit`, `npx eslint <files>`, and `npm test`.

**W1: Shell, guards, and V2-02 fixes** · *Waits:* nothing (Next 16 already installed) · *Owns:* `src/app/layout.tsx`, `globals.css`, `src/app/(app)/{layout,loading,error,session-actions}.tsx|ts`, move `week/` and `setup/` into `(app)/`, `not-found.tsx`, `global-error.tsx`, `signed-out/`, `account-deleted/`, `_components/{SignedOut,AppNav,RefreshOnFocus,TextAriaButton,FreshLinkNotice,ExternalLink}.tsx`, `_components/ui/*`, `src/server/web/{guard,site,ports}.ts`, `src/server/viewer.ts`, `src/server/security/{sessions,link-policy}.ts`, `next.config.ts` (CSP), `server-only` lines in `src/server/**`, `tests/unit/{guard,link-policy}.test.ts`.
- **Acceptance:**
  - Sign out (this phone and everywhere) works end to end.
  - Guards return each code correctly.
  - CSP is present, and the landing form plus `/m` redeem still work under it.
  - 404, 500, and global-error are styled in light and dark.
  - `SignedOut` variants render.
  - Tokens `--field` and `--load-*` exist.
  - `tsc` and `eslint` pass, and the tests pass.

**W2: PWA, icons, OG, robots, Playwright scaffold** · *Waits:* W1 (layout metadata) · *Owns:* `src/app/manifest.ts`, `robots.ts`, `icon.png`, `apple-icon.png`, delete `favicon.ico` and `public/*.svg`, `public/icons/*`, `public/og/*`, `src/app/m/page.tsx` (OG images), `scripts/assets/*`, `playwright.config.ts`, `tests/unit/assets.test.ts`.
- **Acceptance:**
  - `curl -s localhost:3000/m?k=week | grep og:image` shows an absolute `/og/week.jpg`, and the same for every kind.
  - The landing page has an og:image and a twitter card.
  - All JPEGs are < 300 KB at 1200×630.
  - `/manifest.webmanifest` is valid (Chrome DevTools → Application shows no errors).
  - `apple-touch-icon` is 180.
  - `robots.txt` disallows `/api/`.

**W3: Shared pure modules plus tests** · *Waits:* nothing (parallel with W1) · *Owns:* `src/shared/{week,safe-url,schedule-prefs,persona-prefs,action-result,copy}.ts`, `tests/unit/{week,safe-url,schedule-prefs,persona-prefs,copy}.test.ts`.
- **Acceptance:**
  - All §10 unit cases pass, including the DST and all-day cases.
  - `copy.ts` holds every §9 string, and the coverage test passes.
  - There are no imports from `src/server`.

**W4: `/setup` schedule and tone sections** · *Waits:* W1, W3, **migration 003 applied** (users columns). The V2-06 hook goes through a port (a stub is allowed until V2-06 lands). · *Owns:* `src/app/(app)/setup/{page,ScheduleForm,ToneForm,actions}.tsx|ts` (schedule, tone, and timezone actions only), `src/server/web/setup-data.ts` (schedule and tone parts), `tests/smoke/schedule.smoke.test.ts`.
- **Acceptance:**
  - Saving with a view session works.
  - The quiet-hours overlap warning shows.
  - The timezone mismatch button appears when the browser tz differs.
  - Values persist in `users` and `persona_prefs`, and the hook is called.
  - A double submit is harmless.

**W5: `/setup` Canvas** · *Waits:* W4, **V2-05** (`connectCanvas`, `getCanvasStatus`, `disconnectCanvas`, `universities.ts`, `canvas-url.ts`) · *Owns:* `setup/CanvasConnect.tsx`, Canvas actions in `setup/actions.ts`, Canvas parts of `setup-data.ts`, the `ports.ts` lines for V2-05.
- **Acceptance:**
  - Every `CanvasConnectError` shows its §9 copy inline, with `aria-invalid` and focus.
  - The guide link uses the chosen school's host, and an unlisted school uses the custom host.
  - The view session shows the fresh-link notice, with the pasted value kept.
  - Success shows the counts.
  - The URL never appears in server logs (grep the dev log).

**W6: `/setup` Google** · *Waits:* W4, **V2-07** (routes, `getGoogleStatus`, `disconnectGoogle`, status codes) · *Owns:* `setup/GoogleConnect.tsx`, a strip-param client snippet, Google disconnect action.
- **Acceptance:**
  - The disclosure renders before the button.
  - The button is a plain `<a>` (no prefetch) and is shown only when fresh.
  - Each `?google=` code shows the right banner and is removed from the URL.
  - Missing scopes are listed precisely.
  - Disconnect confirms via the dialog.

**W7: `/week`** · *Waits:* W1, W3. **V2-05** `listTimeline` / `setTimelineItemStatus`; W7 can be built first against fixture data through the port. · *Owns:* `src/app/(app)/week/*`, `src/server/web/week-data.ts`, `tests/unit/render.test.tsx` (week parts).
- **Acceptance:**
  - Grouping matches the unit fixtures in a real render.
  - The load bar has text labels.
  - Mark done is optimistic and persists.
  - The hostile title renders escaped.
  - Bad URLs aren't linked.
  - All empty states and the sync-failing banner show.
  - `?w=1` works, and invalid `w` falls back to 0.
  - `src=pwa` signed out shows the PWA copy.

**W8a: `/settings` memory, accounts, and sign out** · *Waits:* W1, W3, **V2-04** memory API (stub allowed while building), W5 and W6 status views · *Owns:* `src/app/(app)/settings/{page,MemoryList}.tsx`, memory actions in `settings/actions.ts`, `src/server/web/settings-data.ts`.
- **Acceptance:**
  - Edit is blocked for sessions older than 60 min, with the copy shown; delete still works.
  - Proposals can be answered.
  - Sign-out buttons work.
  - Untrusted text goes through `cleanText`.

**W8b: Export and delete account** · *Waits:* W8a, **V2-07** `disconnectGoogle`, **V2-05** `disconnectCanvas` · *Owns:* `src/server/account/{export,delete}.ts`, `src/app/api/me/export/route.ts`, `settings/DeleteAccount.tsx`, the delete action, `tests/unit/export-shape.test.ts`, `tests/smoke/account.smoke.test.ts`.
- **Acceptance:**
  - Export downloads on iPhone Safari (Files → Downloads) and is paged.
  - A non-fresh session gets the notice.
  - Delete removes everything including signups.
  - Google revoke failure leads to the `?g=0` page.
  - Other open tabs show `SignedOut` on the next action.
  - The smoke test passes and cleans up.

**W9: `/email/[id]`** · *Waits:* W1, W3, **V2-07** `SendEmailPayload`, **V2-04/V2-07** pending-action path, and migration 003 (`pending_actions.version`) · *Owns:* `src/app/(app)/email/[id]/*`, `src/server/web/email-data.ts`.
- **Acceptance:**
  - A non-owner or bad id gets a 404.
  - Every status renders.
  - Save bumps the version, and a stale version shows the conflict.
  - Send is disabled while dirty and while pending.
  - A double click sends once (verified via the stub call count, then for real once V2-07 lands).
  - To and Cc are read-only.
  - Body newlines are preserved.

**W10: E2E, visual QA, and a11y pass** · *Waits:* W1–W9 · *Owns:* `tests/e2e/**`, fixes limited to presentation in `src/app/**`.
- **Acceptance:**
  - All Playwright flows in §10 pass on `iphone-15` (chrome).
  - The shots set is reviewed (light, dark, and reduced motion) on 375, 393, 430, and 1280.
  - There's no horizontal scroll anywhere.
  - The manual a11y checklist is done.
  - `grep -r PORT_STUB src/` is empty.

**Parallelism:**
- W1 and W3 start immediately.
- W2 and W4 start after W1.
- W7 can begin on fixtures after W3.
- W5, W6, W8, and W9 are gated on V2-05, V2-07, and V2-04 respectively.

---

## 12. Verify checklist (real iPhone, plus Android if a friend has one)

**Links and previews**
- [ ] A link sent from Aria in iMessage shows the **card image and title** per kind: week (with count), setup, settings, email. Aria must be a saved contact, with one URL at the start or end of the message.
- [ ] The preview fetch does **not** burn the token. Tapping still signs in. Log the fetcher UA.
- [ ] Tapping a link opens Safari, auto-submits, lands on the target, and puts no token in history (Back doesn't show `#t=`).
- [ ] `sms:` buttons ("Text Aria 'setup'", "Back to Messages") open the right thread with the body prefilled (iOS 26, and iOS 18 if available).

**Canvas**
- [ ] Canvas guide on iPhone: "Open … /calendar" opens Safari or the Canvas app **[record which]**. "Calendar Feed" is reachable on mobile web. Copy, paste, and connect work end to end at Yale.

**Google**
- [ ] Google connect from iPhone Safari: the unverified screen labels match the copy deck. Unchecking a box gives the `missing_scopes` banner.
- [ ] Repeat with a Yale EliApps account and record the outcome (admin_blocked or success).

**/week**
- [ ] Day groups correct around midnight local. An all-day Canvas item is on the right day.
- [ ] Load bar readable in dark mode.
- [ ] Done toggles persist.
- [ ] Coming back from Messages refreshes the data.

**Layout and device behavior**
- [ ] Safe areas: notch and Dynamic Island in portrait and landscape. Bottom content clears the home indicator.
- [ ] Keyboard: inputs scroll into view, there's no zoom on focus (16 px), and `<select>` wheels work.
- [ ] `<dialog>` delete confirm: VoiceOver reads the title, and focus is trapped.
- [ ] Settings → Accessibility → Reduce Motion: the hero shows statically.
- [ ] Dark mode on every page, including the native controls (`color-scheme`).
- [ ] Add to Home Screen: icon and name are correct, it opens standalone at `/week?src=pwa`, and it shows the PWA sign-in copy (confirms separate storage on iOS 26).

**Account and email**
- [ ] Export downloads and opens in Files.
- [ ] Delete account → other tabs signed out. Google permissions page no longer lists Aria.
- [ ] Email draft: edit on the phone, Send, the email arrives in-thread, and Aria confirms in Messages. Chat "send it" after a web Send says it was already sent.

**Security**
- [ ] Deploy while a tab is open, then press a button: the "Aria just updated" reload path works.
- [ ] Response headers on `/week`: CSP, `X-Frame-Options`, `Referrer-Policy: same-origin`, `Cache-Control` no-store. The cookie is `__Host-aria` Secure HttpOnly Lax.

---

## 13. Open questions (with recommended defaults)

| # | Question | Recommended default |
|---|---|---|
| Q1 | App icon: new V2 "a" mark (crisp, on-palette) or crop of `Aria_Logo.png` (purple-cyan, only ~335 px source)? | **V2 mark.** The logo crop is a one-line swap in `render.spec.ts` if you prefer continuity. |
| Q2 | Build a short plain-language `/privacy`? | **Skip** for the free test (the brief locks it). Build one page from the §9.2 disclosure only if Google Console requires a privacy URL to keep the consent screen "In production". |
| Q3 | Quiet-hours bounds. §3.15 says the default is 22:00–08:00; §3.22 mentions an 8am–9pm minimum (TCPA, SMS). | Default **22:00–08:00**. Options: start 9 PM–1 AM, end 6–11 AM. Earliest briefing 7:00 AM. Re-check against TCPA before production (Android SMS users). |
| Q4 | Memory edits from a view session? | **Edit needs a < 60-min session. Delete is allowed from any session.** |
| Q5 | Let the web edit recipients (To/Cc)? | **No.** Recipients change in chat only. |
| Q6 | On Canvas disconnect, delete Canvas items and cancel anchored reminders? | **Yes, delete future Canvas items and cancel their reminders.** Past items go too (simpler mental model). |
| Q7 | Send a final "account deleted" iMessage? | **No.** The web confirmation is enough, and inbound texts afterward start fresh. |
| Q8 | `/week` window: rolling 7 days or Monday–Sunday? | **Rolling 7 days** plus "Next week →". |
| Q9 | Persona dial values | **Match me (default) / Casual / Polished.** No emoji toggle yet. |
| Q10 | Preview deployments | **Production only** for the free test. Magic links and Origin checks pin to `APP_BASE_URL`. |
| Q11 | Export requires a fresh setup link? | **Yes** (it includes 180 days of messages). |
| Q12 | Allow turning the briefing off? | **Yes** (`briefing_enabled`). People will ask, and "pause" is per channel and heavier. |
| Q13 | Server actions on Vercel Hobby without Skew Protection | **Accept it**, with the reload path. Turn on Skew Protection when moving to Pro. |
| Q14 | Include `conversation_summaries` in the export? | **No.** It's derived data. Add it if a friend asks. |
| Q15 | Add `@playwright/test` as a dev dep (vs a zero-dep CDP script) | **Yes, 1.63.0.** It doubles as the e2e suite and the asset renderer. |
