# Phase 8: iOS App + Onboarding - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the native iOS app (React Native / Expo) and the complete onboarding flow. Onboarding delivers: phone verification, Canvas iCal URL entry, Google OAuth connection, TCPA alert consent, and first briefing preview. The iOS app delivers: 4-zone card dashboard, persistent chat + voice bar, card customization (reorder, hide, accent color, dark mode). In-app chat connects to the same Aria backend as SMS but is an independent conversation thread.

This phase does NOT build backend API routes (Josh owns those). It calls existing and upcoming Next.js API routes. GCal and Gmail integrations are Phase 6 — this phase shows placeholder cards for unconnected integrations.

</domain>

<decisions>
## Implementation Decisions

### Platform
- **React Native / Expo** — not Next.js. True native iOS app.
- Lives in `/mobile` directory within the `aria-mvp` repo. Josh never touches `/mobile`; Seb never touches `/src`.
- Directory structure: `mobile/app/` (Expo Router screens), `mobile/components/`, `mobile/lib/` (API client, Supabase), `mobile/package.json`
- Backend communication: mobile calls **Next.js API routes** (`/api/*`) — same routes Josh builds for web
- Auth: **Supabase Auth JS SDK** with `ExpoSecureStoreAdapter` for secure keychain session storage on iOS
- Google OAuth: `expo-auth-session` → Supabase `signInWithIdToken` — same Supabase project and users table as web

### Onboarding Flow
- **Linear multi-step wizard** — one screen per step, progress indicator at top
- Step sequence:
  1. Welcome / value prop
  2. Enter phone number
  3. Enter SMS PIN (auto-advance on 6 digits)
  4. Paste Canvas iCal URL + validate button
  5. Connect Google Account (OAuth popup) — **skippable** via "Skip for now →" secondary CTA
  6. TCPA alert consent (dedicated screen — see below)
  7. First briefing preview → Enter app
- **Google OAuth is optional**: user can skip and connect later from Preferences. When skipped, GCal card shows "Connect Google to see your calendar" placeholder with [Connect →] CTA.
- **TCPA consent screen (Screen 6)**: dedicated screen before first briefing preview. Headline: "Time-sensitive alerts". Explicit toggle (default OFF — user must tap ON). Exact legal copy: *"I agree to receive time-sensitive deadline alerts at any hour."* On confirm, writes `has_alert_consent: true` to `users.preferences_json`. This is the flag Phase 5's `send_sms_alert()` checks before bypassing quiet hours.

### 4-Zone Dashboard Layout
- **Zone 1 — Pinned quick-access bar**: fixed at top (To-Do, Calendar, Notifications shortcuts)
- **Zone 2 — Daily load status bar**: full-width color-coded banner directly below Zone 1. Color fills the bar (green/yellow/red). Label: "Light week", "Busy week", or "Heavy week". Shows deadline count. Tapping expands a breakdown.
- **Zone 3 — Scrollable card grid**: Canvas deadline cards + greyed-out placeholder cards for unconnected integrations ("Connect Google Calendar →", "Connect Gmail →"). Placeholder cards disappear when integrations are connected in Phase 6.
- **Zone 4 — Persistent chat + voice bar**: fixed at bottom (see Chat section)

### Card Behavior
- **Tap**: expands inline to show full detail — due date, course, weight, priority score — with three actions: ✓ Done, 🔕 Snooze, ⋯ More
- **Long-press**: enters drag mode for reordering
- **Swipe left**: reveals "Hide" action — removes card from grid (accessible via Preferences to restore)

### Visual Style
- **Light/dark mode**: follows iOS system setting automatically — no manual toggle needed
- **Accent color**: user-configurable from 6-8 presets (Indigo default `#5856D6`, Blue, Green, Orange, Pink, Purple). Accent applies to CTAs, active card borders, load bar, chat bubbles, and icons.
- Accent color and dark mode preference stored in `users.preferences_json`

### In-App Chat
- **Layout**: persistent bottom bar on home screen showing last message preview + mic button. Tapping the bar slides up a full-screen chat view (iMessage-style). Swiping down collapses it.
- **Voice input**: tap mic to start recording, tap again to stop and send. Uses on-device speech recognition (`expo-speech` / `@react-native-voice`). Transcribed text routed through the same Claude pipeline as typed messages.
- **TTS read-back**: deferred — not in Phase 8 scope
- **History**: loads last 20 in-app messages on open; scrolling up triggers pagination to load older messages
- **Thread independence**: in-app chat is a separate conversation thread from SMS — SMS history does NOT appear in in-app chat and vice versa. Both connect to the same Aria backend.

### Claude's Discretion
- Expo Router navigation structure (tab bar vs stack nav for secondary screens)
- Exact loading skeleton designs for cards and chat
- Error state handling for failed Canvas URL validation
- Pinned quick-access bar icon set and tap behavior

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 8 requirements
- `.planning/REQUIREMENTS.md` §Authentication & Onboarding — AUTH-02, AUTH-03, AUTH-05, AUTH-06
- `.planning/REQUIREMENTS.md` §Frontend UI — UI-01 through UI-05 (onboarding + preferences screens)
- `.planning/REQUIREMENTS.md` §iOS App — UI-06, UI-07, UI-08, UI-09 (home screen, chat, voice, card customization)

### TCPA consent flag (critical)
- `.planning/phases/05-priority-engine-canonical-timeline-db/05-CONTEXT.md` §Immediate Alerts + TCPA — documents the `has_alert_consent` flag that Phase 5's `send_sms_alert()` checks; Phase 8 onboarding must set this

### Existing normalized types (mobile reads these)
- `src/types/index.ts` — `Task`, `CalendarEvent`, `Message` — the mobile app consumes these types when calling Next.js API routes

### Delivery router (what silent-tier events look like in app)
- `.planning/phases/05-priority-engine-canonical-timeline-db/05-CONTEXT.md` §Delivery Router — score < 50 events are "visible in app only"; Phase 8 cards must surface these silent events

### No external specs — all constraints captured in decisions above

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/types/index.ts`: `Task`, `CalendarEvent`, `Message` — mobile API client should type responses against these
- `src/lib/supabase/client.ts`: pattern for Supabase client initialization — mobile follows same pattern with `ExpoSecureStoreAdapter` replacing cookie storage
- `src/app/api/health/route.ts`: health check endpoint — mobile can ping this to verify backend connectivity on launch

### Established Patterns
- No frontend components exist yet — `src/components/` and `src/app/(pages)/` are empty. Mobile builds from scratch in `/mobile`.
- Backend API routes follow `src/app/api/[domain]/route.ts` pattern — mobile `lib/api.ts` calls these
- All Supabase writes use service role key on the backend (RLS bypassed server-side); mobile uses anon key + RLS user scoping

### Integration Points
- `/api/sync/canvas` (POST): triggers Canvas sync — mobile can call this after Canvas URL is saved in onboarding
- `users.preferences_json`: stores `has_alert_consent`, accent color, quiet hours preferences — mobile reads and writes this via Supabase JS SDK
- `canonical_events` table (Phase 5): source of truth for card data — mobile queries this via a future `/api/events` route (Josh builds in Phase 6)

</code_context>

<specifics>
## Specific Ideas

- TCPA consent toggle must be explicit opt-in (default OFF) — users who don't toggle it don't get quiet-hours bypass, which is fine. The toggle is the legal protection before Yale beta.
- Placeholder cards for unconnected integrations should feel inviting, not broken — greyed out with a clear CTA, not an error state
- Voice: tap-to-start / tap-to-stop (not hold-to-record) — user's explicit preference

</specifics>

<deferred>
## Deferred Ideas

- TTS read-back for voice output — not in Phase 8 scope, future phase
- Android app — iOS only for v1; Android is Phase 3+
- Web dashboard — Next.js web pages for onboarding/preferences may be needed as a fallback, but iOS app is the primary Phase 8 deliverable

</deferred>

---

*Phase: 08-ios-app-onboarding*
*Context gathered: 2026-03-19*
