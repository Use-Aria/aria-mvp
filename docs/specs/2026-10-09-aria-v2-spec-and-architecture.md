# Aria V2: Spec Refinement and Architecture Decisions

> **Status:** DRAFT for Daniel's review and approval. Nothing in here is built yet.
> **Date:** 2026-10-09
> **Inputs:** Daniel's V2 spec; a read-only audit of this repo; and seven web research passes run 2026-10-09 (iMessage providers, WhatsApp policy and pricing, LLMs, memory and agent frameworks, hosting and jobs, Google/Canvas/compliance, magic links and PWA). Sources are in Appendix B. Items marked **[verify]** couldn't be confirmed from a primary source and need a check before we rely on them.

---

## 0. TL;DR

### 0.1 Recommended stack

| Layer | Choice | Runner-up |
|---|---|---|
| iMessage | **Sendblue**, AI Agent plan ($100/line/mo, dedicated line, SMS/RCS fallback included) | Linq (used by Poke, Tomo, and Lindy) |
| WhatsApp | **Defer in the US** (Meta bans AI-first assistants). Build a channel abstraction so it can be added later. | "Utility-only" WhatsApp: templated reminders that hand off to iMessage or the web |
| Language/runtime | **TypeScript only.** One Next.js app on Vercel. | Python only (FastAPI + Pydantic AI + DBOS) with Next.js just for web pages |
| Hosting | **Vercel Pro** ($20/mo) | Cloudflare Workers ($5/mo plus usage) |
| Database | **Supabase Pro** (Postgres, pgvector, pg_cron, pg_net) | Neon |
| Jobs and scheduling | **A Postgres `jobs` table, ticked by Supabase Cron, dispatched to a Vercel route.** No Redis, Celery, or Railway. | Inngest |
| Main chat model | **Claude Haiku 5.5** at low effort, with prompt caching | GPT-6 Luna (same price; doubles as the fallback) |
| Escalation model | **Claude Sonnet 5.5**, capped at 5–10% of turns | — |
| Agent framework | **A thin in-house loop over the native Anthropic and OpenAI SDKs** | Vercel AI SDK v7 |
| Memory | **Built on Supabase.** Profile and preferences are always in context; facts are searched with a `recall` tool. | Mem0 OSS on pgvector, facts tier only |
| Gmail/Calendar access | **Our own Google OAuth client.** Beta runs unverified; CASA assessment happens before 100 users. | Composio (rejected for production) |
| Canvas | **iCal feed plus Canvas/Gradescope notification emails read from Gmail** | Per-school developer keys (for scale) |
| Web | **Next.js 16**, mobile-first, Tailwind v4 + shadcn/ui, installable PWA, our own magic-link sessions | Next.js 15.5 as-is (support ends ~2026-10-21) |
| Observability | Langfuse Hobby (sampled), Sentry free, PostHog free, plus a `llm_calls` cost table in our DB | — |

### 0.2 Findings that change the spec (decisions needed)

1. **WhatsApp as specced is very likely banned in the US.**
   - Meta's terms (§4.7, last modified 2026-09-23) prohibit "general-purpose artificial intelligence assistants" from the WhatsApp Business Platform when AI is the "primary (rather than incidental or ancillary) functionality".
   - It's suspended only in the EEA, Italy, and Brazil, where regulators forced it.
   - Poke, the closest comparable product (assistant plus email and calendar), was cut off and now runs on WhatsApp only "in some markets".
   - Since Oct 1, 2026, every in-window reply also costs **$0.0034** in the US.
   - → §3.4
2. **The Canvas "sign in with your Yale NetID" vault flow should not be built.**
   - It breaks Yale Policy 1601 PR.02 ("Individuals must not share their NetIDs and/or passwords with others") and Policy 1607, and **students carry the disciplinary risk**.
   - It also violates Instructure's Acceptable Use Policy (no sharing credentials, no scraping).
   - The vault would be a catastrophic breach target.
   - → §3.10
3. **Reading Gmail needs a *restricted* scope, which means an annual CASA security assessment.**
   - Every scope that reads mail (`gmail.readonly`, `gmail.metadata`, `gmail.compose`, `gmail.modify`) is restricted. `CLAUDE.md` and `PRODUCTION.md` wrongly call it "sensitive".
   - Cost: about $675–855/yr at assurance level 1, up to $5.4k/yr at level 2, plus 1–3 engineer-weeks and 6–10 weeks of calendar time.
   - The beta can run unverified, but there's a **100-user lifetime cap**.
   - Drafting doesn't need a restricted scope: Aria holds the draft and sends with `gmail.send`, which is only sensitive.
   - → §3.9
4. **iMessage link previews will burn single-use magic links.**
   - The provider's Mac fetches every URL to build the preview before the student ever taps it.
   - So the token goes in the URL **fragment** and is redeemed only by a JavaScript POST.
   - → §3.6
5. **Phone verification works differently.**
   - The student texting Aria proves they control a messaging handle.
   - That handle may be an **Apple ID email**, not a phone number, and WhatsApp users may now arrive without a number at all.
   - Identity = channel handle. The web form's phone number is used for matching and consent, not as proof.
   - → §3.1–3.2
6. **High-school users are a separate legal and technical project.**
   - COPPA (amended rule enforced since 2026-04-22) and state student-privacy laws such as SOPIPA apply.
   - Google Workspace for Education blocks under-18 accounts from unconfigured third-party apps by default, so school Google accounts won't connect.
   - **Recommendation:** college-only, 18+ beta.
   - → §3.22
7. **V1 is mostly a rewrite, not a port.**
   - V1's "AI" is a JSON intent classifier plus one-shot replies: no tool use, no caching, no agent loop.
   - The priority engine is broken (AUD-08).
   - Briefings show due times in UTC.
   - V1 was never deployed.
   - Only ~1,000 lines of Python logic are worth carrying over.
   - → §1
8. **An ownership risk to settle first.**
   - Google tokens are encrypted with `TOKEN_ENCRYPTION_KEY`, which is **not** in Daniel's `.env.local` and may exist only in the Railway project Daniel can't access.
   - Dev and prod share one Supabase project, and the dev OAuth path writes Google tokens **unencrypted**.
   - Because V1 never had production users, the clean move is **fresh accounts with no data migration**, plus rotating every secret the former teammate could see.
   - → §2

### 0.3 Cost at a glance (all-in, per month)

| Active users | LLM | iMessage | Infra | Compliance | **Total** | **Per user** |
|---|---|---|---|---|---|---|
| 50 (beta) | $60–90 | $100 | ~$46 | $0 | **~$205–235** | **~$4.1–4.7** |
| 500 | $600–900 | $200–300 | $46–90 | ~$60–85 | **~$0.9k–1.4k** | **~$1.8–2.7** |
| 5,000 | $6k–9k | $1.5k–2.5k | $155–440 | $60–450 | **~$7.7k–12.4k** | **~$1.5–2.5** |

These figures assume a heavy user (15 conversational turns a day). Typical usage is likely half that, which roughly halves the LLM column. For comparison, V1's design (uncached Sonnet 4.6 plus Twilio SMS) would cost about **$18/user/month**. Full model in §6.

---

## 1. Where the codebase stands

### 1.1 What V1 actually is

| Component | Size | Reality |
|---|---|---|
| `celery_worker/` (Python) | 5.4k LOC + 7.1k LOC tests | This is the brain. Most tests are `MagicMock` call-chain checks; about 58 test real logic. |
| `src/app/api/` (Next.js) | 1.3k LOC | Thin routes that enqueue Celery tasks. `src/app/page.tsx` is a placeholder. |
| `mobile/` (Expo) | 5.7k LOC | Removed in V2. The home dashboard ran on mock data, and its API endpoints were never built (AUD-09). |
| `supabase/migrations/` | 10 files | Identity is hard-wired to Supabase Auth phone OTP (FK to `auth.users`, the `handle_new_user` trigger, and every RLS policy). The live DB has drifted: an `"Email"` column exists that no migration creates. |
| Deployment | — | **Never deployed.** PRODUCTION.md shows Vercel and Railway both unchecked. |

Key finding from the worker audit: **no Celery task enqueued from Next.js ever ran until 2026-09-24**. The cause was a hand-built cross-language message envelope that kombu silently dropped. That's the cost of a two-language, queue-in-the-middle architecture, and it weighs on §4.1.

### 1.2 Module verdicts

| Module | Verdict | Why |
|---|---|---|
| `ai/replies.py` | **Replace** | Intent classifier plus keyword intercepts plus one-shot Sonnet replies. Other problems: no tools or caching; history duplicates the current message; the intent call gets no history; truncated JSON silently becomes `off_topic`. |
| `ai/briefing.py` | **Port the ideas** | Keep the context assembly (`compute_load_score`, exam touchpoints). Fix UTC display of due times (`briefing.py:315-319`) and drop the 800-character cap. |
| `ai/syllabus.py` | **Port** | Native PDF parsing works. Raise `max_tokens` (1024 truncates), and fix gap topics always coming from `exams[0]` and the empty `course_id` that matches every syllabus. |
| `canvas/` | **Port** | Clean fetch/parse/diff. **But** the course name is extracted by splitting on `" - "`, while real Canvas feeds use `Title [Course]`, so course is probably `None` on real data. Also: all-day events land at 7:59pm ET, and the event URL isn't captured. |
| `gcal/slots.py` | **Rewrite the placement logic** | Always offers the start of the earliest gap (7am to an evening person). Doesn't filter out past times. No buffers, no hard constraints. |
| `gcal/` (auth, fetch, watch) | **Port and fix** | AUD-18/20: refresh tokens never persist. Deleted events are never pruned. |
| `gcal/conflicts.py` | **Delete** | Every class day counts as a "conflict", and the follow-up question has no handler. |
| `gmail/` | **Port and fix** | AUD-01/04/19: webhook fans out to all users, watch expiry is shared, duplicate alerts. Watch renewal also overwrites the history cursor, so mail gets skipped. |
| `google_auth/` | **Replace crypto** | Fernet is AES-128-CBC, not the AES-256 that CLAUDE.md claims. Tokens also pass through Redis in plaintext. |
| `priority/` + `canonical_events` | **Replace** | AUD-08: the "immediate" tier can never be reached. A due-date change inserts a duplicate row. Calendar events pollute "deadlines". Nothing is ever re-scored. |
| `sms/send.py` | **Port the guard logic** | Opt-out, pause, quiet-hours, and cap logic is reusable. Suppressed messages are currently *dropped* instead of deferred. |
| `sms/schedule.py`, `batch.py`, `commands.py` | **Replace** | Exact-keyword confirmations ("yes but 6pm" falls through). Redis is used for pending state. |
| `todoist/` | **Delete** | Not in the V2 spec, and the token is stored in plaintext (AUD-03). |
| `tasks.py`, `celery_app.py` | **Delete** | Replaced by the jobs table (§4.4). Its fan-out wouldn't scale: 96·N tasks a day, concurrency 2, briefings missed after 8:59. |
| `src/app/api/*` | **Rewrite** | AUD-01/02 (unsigned `user_id` in OAuth and webhooks). SSRF hole in `/api/sync/canvas` (follows redirects). Phone-OTP coupling. The Twilio webhook pattern (signature check plus fast ACK) is worth keeping. |
| `mobile/` | **Delete, after salvage** | See §1.3. |

### 1.3 Salvage list (worth carrying into V2)

- **Canvas iCal:** fetch, parse, and diff logic (`celery_worker/canvas/*.py`, ~200 LOC), with the course-name fix.
- **Free-slot core:** the gap-finding loop in `gcal/slots.py`; the placement logic around it gets rewritten.
- **Syllabus:** parsing prompt and schema from `ai/syllabus.py`.
- **Message guards:** quiet-hours window math and opt-out semantics (`sms/send.py:84`).
- **From the mobile app:**
  - the 52-school university list and `canvasDomainForUniversity` (`mobile/lib/universities.ts`); add an "Other" option
  - Canvas iCal guide copy and error states (`tools.tsx:144-190, 298-302`, `CanvasUrlInput.tsx`)
  - TCPA consent pattern (`tcpa.tsx:106-182`)
  - design tokens (`lib/theme.ts`)
  - load thresholds and deadline-card interactions for the week view (`useCards.ts:121-133`, `DeadlineCard`)
  - logo assets for PWA icons
- **Lessons recorded in CLAUDE.md's Implementation Gotchas:**
  - match courses with ILIKE
  - watch channels expire after 7 days
  - never persist PDF bytes
  - the re-parse guard
  - verify webhook signatures against a configured URL

---

## 2. Taking full ownership (do this first)

### 2.1 Inventory

| Service | What exists | Risk | Action |
|---|---|---|---|
| **Railway** | The worker deploy (former teammate's account). May hold `TOKEN_ENCRYPTION_KEY`, the Supabase service-role key, Twilio credentials, and the Anthropic key. | Daniel has no access. Live credentials could be sitting in a project he can't see. | Ask the former teammate to shut it down. **Rotate every secret regardless.** Not needed in V2. |
| **Supabase** | Project `jjnedeyfpgogaizsucxp`, org `boslxmpbiixpedyzezqt`. Dev and prod share it. Test OTP `123456`. Possibly unencrypted Google tokens from the dev path. | Unclear ownership. Schema drift. Plaintext tokens. | Create a **new** project under Daniel's org (prod), plus a separate free dev project. Leave the old one until confirmed empty of real users, then delete. Rotate its keys now. |
| **Vercel** | Probably nothing deployed. | — | Create a new Pro team owned by Daniel. |
| **Google Cloud** | OAuth client in Testing mode with test users. Pub/Sub topic never created. Throwaway tunnel redirect URIs from `scripts/phone-dev.sh`. | No verification progress to lose. The 100-user cap counts per project for its whole lifetime. | **Create a fresh project under Daniel's org.** Recreating costs only test users reconnecting. If Daniel already has Owner on the old project, keeping it is fine too. |
| **Twilio** | Messaging Service, Verify, and a toll-free verification pending since 2026-04-12. Wired into Supabase Auth. | Unknown owner. Not needed in V2 (Sendblue includes SMS fallback). | Confirm the owner, then wind down. Rotate the auth token now. |
| **Anthropic** | API key in use. | Possibly shared. | New key in Daniel's org. Revoke the old ones. Request zero-data-retention (ZDR) review early. |
| **GitHub** | `Use-Aria/aria-mvp`. | Org ownership. | Confirm Daniel is an org Owner. Remove the former teammates' write access and deploy keys when ready. |
| **Apple/EAS/Expo** | Team `B4V6MXCJ5B`, bundle `com.cr7sc3.aria`. | — | Not needed in V2. Optionally revoke certs. |
| **Todoist** | OAuth app. | — | Drop. |
| **Domain** | None. | Blocks Google verification, magic links, and the privacy policy. | **Buy one now** (Cloudflare Registrar, at cost). |
| **New for V2** | — | — | Sendblue account (sandbox → AI Agent line), Langfuse, Sentry, PostHog, and an OpenAI account for the fallback model. All under a company-domain admin mailbox with hardware 2FA and a company card. |

### 2.2 Order of operations

1. **Foundation.**
   - Company-domain admin mailbox, password manager, hardware 2FA, company card.
   - Buy the domain on Cloudflare.
2. **Cut off old access (rotate, don't migrate).**
   - New Anthropic key; revoke the old.
   - Rotate the Supabase service-role/JWT keys and DB password on the old project.
   - Rotate the Twilio auth token.
   - Reset the Google client secret.
   - Ask the former teammate to delete the Railway project.
3. **Confirm there are no real users.** Query the old Supabase `users` and `integrations` tables. If only test rows exist (expected: V1 never launched), **don't migrate data**. That makes the missing `TOKEN_ENCRYPTION_KEY` irrelevant.
4. **New accounts.**
   - Supabase: Pro org with a `aria-prod` project, plus a free `aria-dev` project.
   - Vercel: Pro team.
   - New GCP project with the OAuth consent screen set to **"In production"** (unverified) — never "Testing", because Testing expires refresh tokens after 7 days.
   - Sendblue sandbox.
5. **Start Google brand verification early.** It needs the domain, a homepage, a privacy policy, and Search Console domain verification. The restricted-scope and CASA steps come in Phase 2 (§7).
6. **Repo.**
   - Tag `v1-final`.
   - Do the V2 work on `main` (Daniel prefers pushing to main).
   - Delete `mobile/`, `celery_worker/`, Expo docs, and `APP_STORE_CHECKLIST.md` once the salvage list is ported.
   - Rewrite `CLAUDE.md`, `WORK.md`, `PRODUCTION.md`, and `DEPLOYMENT.md` for a solo engineer and the V2 architecture.
7. **Decommission (after V2 is live).** Delete the old Supabase project. Remove former teammates from every service.

---

## 3. Refined product spec, feature by feature

Each feature uses the same format: **what the spec says**, then **refinement**, **options**, **choice**, and **why**.

### 3.1 Landing page and signup

**Spec:** the home page collects name and phone number, then shows "Text Aria on iMessage" and "Text Aria on WhatsApp" buttons that open the chat with "Hey Aria!" pre-filled.

**Refinement:**
- **The form:** first name, phone (international input via `libphonenumber-js`), birth year (a neutral age gate, §3.22), and an **unchecked** consent checkbox with TCPA-grade disclosure text. That text says recurring automated messages (briefings, reminders), frequency varies, msg & data rates may apply, reply STOP to cancel, and links the Terms and Privacy Policy. We also capture the browser timezone (`Intl`) silently.
- **On submit:**
  - Store a `signups` row: name, E.164 phone, timezone, consent text version, IP, user agent, 24h expiry.
  - Show buttons by platform:

| Platform | Buttons |
|---|---|
| iOS/macOS | "Text Aria on iMessage" (`sms:+1XXXXXXXXXX&body=Hey%20Aria!`) |
| Android | "Text Aria" (same number via SMS/RCS fallback) |
| Desktop | QR code to the landing URL plus a "send to my phone" hint |
| In-app browsers (Instagram, TikTok) | Show "open in Safari/Chrome" — they often block `sms:` |

  - WhatsApp appears only if §3.4 is approved.
- **Deep-link formats:**
  - iOS/macOS: `sms:<E164>&body=...`, encoded with `encodeURIComponent` (`%20`, never `+`).
  - Android: `sms:<E164>?body=...`.
  - WhatsApp: `https://wa.me/<digits>?text=...`.
  - The `sms:` body parameter is de-facto behavior, not documented by Apple **[verify on iOS 17/18/26 devices]**.
  - A link can't force iMessage over SMS. Messages picks iMessage automatically if the student's handle is registered.

**Options:**

| Option | Verdict | Reasoning |
|---|---|---|
| A. Name + phone + consent form, as specced (**chosen**) | ✅ | The phone gives us a TCPA consent record tied to a number (it matters for Android SMS fallback). It lets us greet the student by name and timezone on the first text, and it doubles as waitlist and lead capture. |
| B. No form: just "Text Aria" buttons; ask the name in chat | Runner-up | Least friction and nothing to mismatch. But we lose the pre-captured consent record, the timezone, and lead capture for people who never text. |
| C. Form + a pairing code in the pre-filled text ("Hey Aria! #K7Q2") | Fallback only | Reliable matching even when iMessage sends from an email. But it's ugly, students edit it, and a code must never log a browser in by itself (device-code phishing, RFC 8628 §5.4). |

**Choice:** A, using B's in-chat path whenever the inbound handle doesn't match a signup.

### 3.2 Identity and verification ("Hey Aria!")

**Spec:** after a valid phone, the user is given numbers to text.

**Refinement:** we don't verify the phone with an OTP. **Identity is the messaging handle that texts us:**

1. An inbound message arrives from handle *H* (an E.164 phone, an Apple ID email, or a WhatsApp ID).
2. If *H* is a phone that matches an unexpired `signups.phone`, link it: "hey Dan 👋", with the name and timezone from the signup.
3. If *H* is an email or doesn't match, Aria onboards in chat: "hey! I'm Aria 👋 what should I call you?" Consent is captured in chat ("reply YES to get morning briefings").
4. **Proof of possession comes from Aria's reply**, not from the inbound text. Every setup link goes *to H*. A spoofer never receives it. iMessage sender identity is also cryptographically tied to Apple's identity directory.
5. Data model: `users` (one per person) → `channels` (many per user: `kind`, `handle`, `handle_kind`, `provider`, `line`). Unique on `(kind, handle)`. Opt-out and pause are **per channel**.

**Rejected:**
- Supabase Auth phone OTP (V1). It's a separate SMS round-trip, costs money, and adds friction. The inbound message already proves control.
- Trusting the web form's phone as identity. The student may text from an email handle or a different device.

### 3.3 Channel: iMessage

**Options (pricing as of 2026-10-09):**

| Provider | Tapbacks send / receive | Inline replies | Typing | Price | Verdict |
|---|---|---|---|---|---|
| **Sendblue** | ✅ / **undocumented [verify in sandbox]** | ✅ (V2 lines) | ✅, up to 5 min | **$100/line/mo**, no per-message fee, SMS/RCS fallback free, free sandbox (10 contacts) | ✅ **Choice** |
| Linq | ✅ / ✅ (webhooks) | ✅ | ✅, ~90 s | Pro "from $260/mo" (per line unclear); lines provisioned by a sales rep | Runner-up. Best-documented agent features; powers Poke, Tomo, Lindy. |
| Photon | ✅ / likely | ✅ | ✅ | Pro $25/mo on **shared** numbers; $250/line dedicated | Rejected. Other tenants affect our reputation, the number changes when upgrading, and the SDK is TypeScript-only. |
| LoopMessage | ✅ / ✅ | ✅ | ✅ | $60–130/mo per sender plus add-ons | Rejected. A **2-minute minimum spacing** to contacts who haven't recently texted makes morning briefings infeasible. |
| BlueBubbles (self-hosted Mac) | ✅ (with SIP disabled) | ✅ | ✅ | Mac mini + line | Rejected. Lindy's Apple ID was **banned within half a day**. Clear ToS violation, plus ops burden. |
| Apple Messages for Business | Native | Native | Native | Requires an MSP and per-user fees; months-long approval | Rejected for now. Branded business chat (not "a friend"), restrictions on proactive messages, live-agent requirement. Poke became the first approved AI agent (2026-06-04). **Revisit at more than 5k users** as the ToS-safe path. |
| Twilio SMS / RCS business messaging only | ❌ | ❌ | ❌ | ~$7/user/mo plus 10DLC fees | Rejected as primary. Fallback only (included in Sendblue). |

**Choice:** Sendblue AI Agent plan with one dedicated line for the beta. At scale, stay on Sendblue and negotiate Enterprise pricing, with Linq as the planned alternative. A thin `ChannelProvider` interface (send, react, reply, typing, media, webhook parse) makes a switch a one-file change.

**Known constraints to design around:**
- Every iMessage API provider runs on Macs signed into Apple IDs, and Apple's iCloud terms forbid automated access. **Ban risk is inherent.** Mitigations:
  - inbound-first onboarding (the student texts first)
  - send a contact card (vCard) right after the first reply, so previews expand and Aria isn't screened by iOS 26's "Unknown Senders" filter
  - keep the outbound:inbound ratio sane: ≤3 bubbles per reply, and prefer the typing indicator over filler texts
  - write briefings that invite a reply
  - ~300–500 users per line, with each user pinned to a line
- Sendblue limits:
  - 1,000 inbound contacts/day
  - unlimited replies within 24h of the student's last message
  - **200 contacts/day per line for proactive messages outside that 24h window** (this drives the line count for morning briefings)
  - a cap of 150 consecutive outbound messages without a reply **[verify: per line or per contact]**
- Sendblue's docs don't say it delivers **inbound read receipts**, so we can't know whether a briefing was read.

**Sandbox checks before paying (week 1):**
1. Do the student's tapbacks arrive by webhook, and in what shape? This decides whether "❤️ = yes" confirmations work (§3.12).
2. Confirm the AI Agent line is a "V2 line", which reactions and replies require.
3. Clarify the 150-message cap.
4. Log the preview fetcher's user agent and IP when we send a link.
5. Confirm how an Apple ID email handle is reported.
6. Confirm inbound SMS/RCS from Android lands on the same number.

### 3.4 Channel: WhatsApp — **spec change, needs approval**

**Spec:** Aria lives on iMessage and WhatsApp.

**Finding:**
- Meta Terms for WhatsApp Business Platform §4.7 (last modified 2026-09-23) bars "AI Providers", explicitly including "general-purpose artificial intelligence assistants", when AI is "the primary (rather than incidental or ancillary) functionality… as determined by Meta in its sole discretion."
- It's been enforced since 2026-01-15 (ChatGPT, Copilot, and Perplexity left).
- Suspended only in the **EEA** (EC interim measures, 2026-06-09, under appeal), **Italy**, and **Brazil**.
- No US regulatory action.
- Aria is the AI. There's no separate non-AI business for the AI to be "ancillary" to.
- A ban escalates: warning → messaging blocks → account lock → permanent disablement, possibly of the whole Business portfolio.

**Costs if built anyway:**
- Since 2026-10-01, in-window replies are billed at the utility rate: **$0.0034/message** in the US, $0.017–0.055 in Western Europe.
- A 2-bubble chat style comes to ~$3.26/user/month in the US.
- Outside the 24h window only pre-approved templates can be sent (≤1,024 characters, fixed text plus variables).
- Users who adopt WhatsApp usernames may arrive with a business-scoped user ID (BSUID) and **no phone number**.

**Options:**

| Option | Verdict | Reasoning |
|---|---|---|
| **A. Defer WhatsApp in the US; build the channel abstraction now** | ✅ **Recommended** | No ban exposure. iMessage plus SMS/RCS fallback covers US students (Android included). Revisit if Meta's September 2026 "connect third-party AI agents" beta ships with terms, the EU case concludes, or US regulators act. |
| B. "Utility-only" WhatsApp | Runner-up | Briefings and reminders go out as utility templates with quick-reply buttons and a call-to-action magic link that hands off to the web or iMessage for any AI conversation. Cost is ~$0.30/user/month. Policy risk is lower but not zero. Build directly on Meta's Cloud API, or on Kapso (free US number, no markup) for speed. Twilio is rejected: +$0.005 per message in each direction. |
| C. Full WhatsApp assistant for EEA users only | Not now | Legally protected only for now (interim order, under appeal). EU service-message rates are high, and the market is tiny for a US-college beta. |
| D. Full WhatsApp assistant in the US as specced | ❌ | Matches the prohibited category almost word for word. Losing the number strands every user with no migration path. |
| E. Unofficial libraries (Baileys, whatsapp-web.js) | ❌ | WhatsApp ToS violation; bans are reported. |

### 3.5 Android users and SMS fallback

**Refinement:**
- Android students text the same Sendblue number. Sendblue auto-detects RCS or SMS per recipient at no extra cost.
- On SMS there are no tapbacks, threaded replies, or typing indicators. The renderer degrades: reactions become nothing (or a short "👍" text only when meaningful), reply quotes become plain text, and emoji are fine on RCS.
- **SMS brings TCPA, CTIA, and 10DLC into scope** (Sendblue says it handles A2P registration). The signup consent record from §3.1 covers it.

### 3.6 Magic links

**Spec:** a short-lived signed token in the URL; it expires quickly and opens only that student's view.

**Refinement (design):**

| Element | Decision |
|---|---|
| Token | 16–32 random bytes, base64url. Store only `sha256(token)` with `user_id`, `purpose` (`view` / `setup` / `connect_google` / `email_draft` / `pwa_pair`), `target`, `expires_at`, `used_at`. |
| URL shape | `https://<domain>/m#t=<token>`. **The token sits in the fragment**, so preview fetchers, server logs, and Referer headers never see it. The `/m` page carries generic Open Graph tags; its JavaScript POSTs the token to `/api/session/redeem`. A non-JS fallback "Open Aria" button does the same POST. **A GET request never redeems a token.** |
| Lifetime | View links ~15 min. Setup and connect links 20–60 min. The expired page shows a one-tap "text Aria for a new link" (an `sms:` link with a pre-filled body). |
| Single use | Redeemed by an atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`. If the browser already has a valid session for the same user, skip the token and route straight to the target, so reopening an old link still works. |
| Session | Server-side session row (256-bit ID, stored hashed). Cookie `__Host-aria`, `HttpOnly; Secure; SameSite=Lax; Path=/`. After redeeming, a `303` redirect sends the browser on. |
| Scope | Sessions inherit purpose. A `view` link gives a read-only session. Connecting or disconnecting integrations and deleting the account require a fresh setup-scope session less than 15 minutes old. |
| Abuse controls | Per-IP rate limit on redeem. Per-user mint limit (10/hour). `Referrer-Policy: no-referrer`. `Origin` check on the POST. Hard-coded host (never built from the Host header). Texting "sign me out everywhere" revokes all sessions. |

**Options:**

| Option | Verdict | Reasoning |
|---|---|---|
| **Roll our own (opaque token + Postgres)** | ✅ | ~150 LOC. Handle-based identity is first-class. $0. |
| Signed JWT (jose) | ❌ | ~150+ characters (ugly in a bubble). Single use needs database state anyway, and revocation is harder. |
| Supabase Auth magic link | ❌ | Link types are email-only. Phone-only users would need a synthetic email. Prefetch consumption is its top `otp_expired` cause. |
| Better Auth magic link | Runner-up | Verifies on GET (preview fetchers would burn the token), stores tokens in plaintext by default, and assumes email identity. |
| Clerk sign-in tokens / Stytch | ❌ | Another vendor and identity store for a solved problem. Clerk's default TTL is 30 days. |

### 3.7 Link previews (Open Graph)

**Spec:** a preview card like "Your week: 3 deadlines".

**Refinement:**
- **Who fetches the URL:**
  - iMessage builds previews on the **sender's** side, which for us means Sendblue's Mac. Apple TN3156 says previews render no JavaScript and no meta-refresh, follow server redirects, and use `og:image` ≥900px wide with a 1 MB main resource.
  - WhatsApp's crawler requires non-empty `og:title`, `og:description`, and `og:url`, and `og:image` <600 KB.
  - **One asset fits both:** a 1200×630 JPEG <300 KB plus a 180px apple-touch-icon.
- **Privacy rule: no personal data in Open Graph.**
  - The OG endpoint must be unauthenticated.
  - The preview is cached by third parties and persists in chat backups.
- **Compromise for the spec's card:**
  - The `/m` page can render `og:title` from a non-secret query parameter that carries **only an aggregate**, e.g. `/m?k=week&n=3#t=…` gives "Your week: 3 deadlines". There's no database lookup, and course or assignment names never appear in the title.
  - Specifics go in the message text, which is already end-to-end encrypted in iMessage.
- **Preview display rules:**
  - Previews only expand when Aria is a saved contact (hence the early vCard), the message has exactly one URL, and the URL is at the start or end of the message.
  - Static per-purpose card images (week, setup, email) cost nothing. Dynamic `next/og` images aren't needed.

### 3.8 Mobile-first web app / PWA

**Pages (all server-rendered, mobile-first):**
- `/` — landing
- `/m` — magic-link redeem
- `/setup` — connect Canvas and Google, briefing time, quiet hours, persona tone
- `/week` — week view: deadlines, classes and events, load bar
- `/email/[id]` — draft preview and edit, optional
- `/settings` — integrations, memory ("what Aria knows about you", with edit and delete), export, delete account
- `/privacy`, `/terms`

**PWA:**
- `app/manifest.ts`: `display: standalone`, `scope: "/"`, `start_url: "/week?src=pwa"`, 192/512 icons, `id`, plus an apple-touch-icon.
- No service worker and no Web Push in the MVP. Push duplicates iMessage, and offline isn't needed. Add Serwist later only if we need offline.
- **iOS 26:** every site added to the Home Screen opens as a web app by default. Chrome on iOS can add to the Home Screen, but it opens standalone only if the manifest says so.
- **Storage isolation gotcha:**
  - Home Screen web apps don't share Safari's cookies **[verify on iOS 26]**, and links tapped in Messages always open in the browser, never in the installed app.
  - So the installed PWA needs its own sign-in: **"Text Aria to sign in"**.
  - The PWA shows a 5-minute code and opens `sms:` pre-filled with "sign in K7Q2". Aria replies "✅ signed in to the Aria app — not you? reply SIGN OUT". The PWA polls for the session.
  - That confirmation text is the phishing tripwire.
  - Phase 3 feature. Before that, the PWA simply shows "open your latest link from Aria".

**Frontend stack options:**

| Option | Verdict | Reasoning |
|---|---|---|
| **Next.js 16 (upgrade from 15.5)** | ✅ | 15.x support ends ~2026-10-21. The repo pins 15.5.13 while the backport line is at 15.5.27, and an **out-of-band fix for 2 Critical + 1 High vulnerabilities lands 2026-10-14**. Migration cost is low: `middleware.ts` → `proxy.ts`, async request APIs, Node 20.9+. |
| Astro 7 | ❌ | Great for the landing page, but means two paradigms for the authenticated views. |
| SvelteKit 3 / React Router 8 / TanStack Start | ❌ | Rewrites with no payoff. TanStack Start's 1.0 status is unconfirmed. |
| Plain Vite SPA | ❌ | Still needs a server for the token POST, cookies, and per-path OG tags. |

UI: Tailwind v4 + shadcn/ui. Use `100dvh`, `viewport-fit=cover`, safe-area insets, `theme-color`, and dark mode.

### 3.9 Connecting Google (Gmail + Calendar)

**Spec:** text "Gmail" and get a sign-in link good for ~20 min. Aria triages the inbox and drafts emails that send only after confirmation.

**Scope classification (Google docs, 2026-09):**

| Scope | Class | Needed for |
|---|---|---|
| `gmail.readonly` | **Restricted** (CASA) | Inbox triage, alerts, "show me the email", reply threading |
| `gmail.send` | Sensitive | Sending a confirmed draft |
| `gmail.compose` / `gmail.modify` / `gmail.metadata` | Restricted | Not needed (drafts live in Aria; archiving is Phase 2) |
| `calendar.events` | Sensitive | Read and write events |
| `calendar.events.readonly` + `calendar.calendarlist.readonly` + `calendar.app.created` | Sensitive (app.created class **[verify in Console]**) | Read everything; write only to an "Aria" calendar |

**Refinement:**
- **Calendar writes:** create blocks in a dedicated **"Aria" calendar** (`calendar.app.created`). It shows up in the student's Google Calendar, can be toggled or hidden, and is easy to clean up. It's also a smaller blast radius than write access to the primary calendar. **[decision]** If Daniel wants events on the primary calendar, use `calendar.events` instead.
- **Drafting:**
  - The draft lives in our `pending_actions` table and is shown in chat (or at `/email/[id]` for long ones).
  - "send it" → a **deterministic code path** sends via `gmail.send` with `threadId` + `In-Reply-To`/`References` headers.
  - **The model never has a send tool.**
- **"Show me the full email":** link to Gmail directly (`https://mail.google.com/mail/u/0/#search/rfc822msgid:<id>`). It's free, needs no session, and opens the Gmail app or web.
- **Beta posture:**
  - Our own OAuth client, consent screen **"In production" but unverified**.
  - Students see "Google hasn't verified this app". Warn them on the connect page.
  - **Hard cap: 100 users ever** for sensitive and restricted scopes. It includes testers and churned users, and it can't be reset.
  - **Test with 2–3 real Yale EliApps accounts first**, because Yale's Workspace admin settings for unconfigured third-party apps are unknown **[verify]**.
- **Verification path:**
  1. Brand verification: domain, homepage, privacy policy, demo video.
  2. Sensitive and restricted scope review.
  3. **CASA** at assurance level 1 (TAC Security Basic $675 or Premium $855/yr) or level 2 (up to $5.4k/yr).
  - Start it by ~user 60–70. Budget 6–10 weeks and 1–3 engineer-weeks to fix scan findings.
  - Google's Workspace data policy now **requires prompt-injection protection** for apps that pass Gmail to an LLM, either Model Armor or equivalent. Our defenses are in §3.22.
- **Push notifications:**
  - Gmail `watch` via Pub/Sub. Renew daily (it must be renewed at least every 7 days), with a separate `gmail_watch_expires_at`.
  - Verify the Pub/Sub OIDC token (fixes AUD-01) and match on `emailAddress`.
  - Calendar `events.watch` with a random per-channel token, looked up by `channel_id` (fixes AUD-02).

**Options (build vs buy):**

| Option | Verdict | Reasoning |
|---|---|---|
| **Our own OAuth client + native API calls** | ✅ | V1 already has the plumbing, and **no vendor removes CASA**. With a vendor's OAuth app, users consent to the vendor's name, not Aria, and Google's Limited Use rules restrict that transfer. For production, every vendor says to use your own client. |
| Composio | Rejected for core | Cheap ($0–29/mo), but adds a subprocessor holding restricted tokens. Maybe later for long-tail integrations (Notion, Todoist) with our own OAuth apps. |
| Nango / Arcade / Pipedream Connect | ❌ | ~$1.5k/mo at 5k users (Nango), ~$10k/mo (Pipedream), or per-call fees (Arcade). |
| Gmail auto-forward filter to an Aria inbox (CASA-free) | Fallback only | Clunky mobile setup, admins can disable forwarding, and it loses history and sent-mail context. |

### 3.10 Connecting Canvas — **spec change, needs approval**

**Spec:** Canvas link; for Yale, a NetID-and-password vault plus Duo push so Aria can sign in and read grades and announcements.

**Options:**

| Option | Verdict | Reasoning |
|---|---|---|
| **A. iCal feed + Canvas/Gradescope notification emails via Gmail** | ✅ **Choice** | The iCal URL is a user-owned secret URL outside Instructure's API Policy, free, and works at every school. It carries assignment and event due dates. Notification emails (which the student can set to "Immediately") fill the gaps: announcements, due-date changes, grade-posted notices, and Gradescope submissions. No new auth, no policy surface. |
| B. Personal access tokens | ❌ | Instructure added an admin setting to block student token creation (2025-09-10), which matches what Daniel saw at Yale. Its docs also say asking users to paste tokens into your app "is a violation of Canvas' API Policy". |
| C. Per-school OAuth developer keys / LTI 1.3 / Instructure Partner Program | Scale path | Needs each institution's admin. Watch the API Policy's generative-AI disclosure clause and its ban on MCP or other "technologies not approved by Instructure". |
| D. NetID + password vault + headless browser + Duo | ❌ **Do not build** | Violates Yale Policy 1601 PR.02 and 1607 (sanctions fall on the student) and Instructure's Acceptable Use Policy. Bot-triggered Duo pushes from data-center IPs look exactly like the MFA-fatigue attacks Yale trains students to report. Duo "remember me" lasts only 90 days. A credential vault is a catastrophic breach target that would also sink our Google CASA case. Under *Facebook v. Power Ventures*, continued access after a cease-and-desist creates CFAA exposure. |
| E. Gradescope API | ❌ | No API exists, and its ToS bans scraping. Use its emails. |

**Refinement:**
- The Canvas connect page reuses the V1 guide copy. It opens `https://<school-canvas-domain>/calendar` → "Calendar Feed" → copy → paste, either into the page or straight into iMessage (Aria detects an iCal URL in chat).
- Validate server-side with SSRF hardening: allow-list Canvas hosts, `redirect: 'manual'`, DNS and private-IP checks, size cap.
- Store the URL encrypted.
- **Grades are out of scope** in V2. FERPA doesn't bar a student-authorized app (it binds institutions), but V1's "never access grades" rule is a sound product and privacy choice, and grades aren't reachable via A anyway. Grade-posted *notifications* from email are fine.
- **Known limit:** iCal has no submission status, so Aria can't know whether a pset was turned in. It asks ("did you submit it?"), lets the student say "done", and auto-marks done when a Gradescope submission receipt arrives by email.

### 3.11 Conversation engine (the agent)

**Spec:** human-like assistant with context across tools; don't hard-code the example conversations.

**Design:**

```
inbound message ─► store (idempotent on provider message id) ─► debounce ~2.5s per user
   ─► acquire per-user lease (one run at a time per user)
   ─► build context:
        [cached prefix]  system prompt + persona + rules + tool schemas + 15–20 few-shot exchanges
        [per-user]       profile + active preferences (≤600 tok) + pending actions + "now" snapshot
                         (local time, next 48h agenda, ≤500 tok)
        [history]        last ~20 messages (+ rolling summary of older ones)
        [new]            all unconsumed inbound messages since last run
   ─► LLM loop (Haiku 5.5, effort low; ≤6 tool iterations; escalate to Sonnet 5.5 on rules)
   ─► reply plan: reactions + 1–3 bubbles (+ optional reply-to targets) + optional link
   ─► renderer: typing ▸ pause ∝ length ▸ bubble ▸ … (channel-aware degradation)
   ─► before releasing lease: if new inbound arrived mid-run, loop once more
```

**Tools (~14, narrow, with JSON schemas):**
- **Agenda:** `get_agenda(range)`, `search_deadlines(query)`, `mark_done(item_id)`
- **Calendar:** `find_free_slots(duration, window, constraints)`, `create_block(slot, title)` (only after the student has picked or accepted a slot), `move_block` / `delete_block` (Aria-created events only)
- **Email:** `search_email(query)`, `read_email(id)`, `draft_email(to/thread, intent)` (creates a pending action, never sends)
- **Reminders:** `create_reminder(when | anchor_item + offset, text)`, `list_reminders`, `cancel_reminder`
- **Memory:** `propose_preference(statement)`, `confirm_preference(id)`, `forget(query)`, `recall(query)`
- **Interaction:** `send_link(kind, args)`, `react(message_id, type)`, `send_interim(text)`
- **Pending actions:** `confirm_action(id)` / `cancel_action(id)`. The executor is deterministic code, not the model.

**Approval is "the next turn", not a parked workflow.**
1. `draft_email` writes a `pending_actions` row (24h expiry) and Aria texts the preview.
2. The student's next message starts a normal run with the pending actions in context.
3. The model calls `confirm_action`, and code executes it.
4. Nothing waits for hours.

**Escalation rules (no learned router):** move a turn to Sonnet 5.5 when any of these hold:
- two failed tool loops
- multi-constraint scheduling (more than two constraints, or a third back-and-forth)
- long email drafting
- detected frustration or repetition

Log every escalation. Budget: ≤5–10% of turns.

**Router options (rejected):**
- RouteLLM: last commit 2024.
- NotDiamond, OpenRouter Auto: not justified.
- LLMRouterBench (Jan 2026) found routers "fail to reliably outperform" the best single model, and switching models forfeits the prompt cache.

### 3.12 Human-like chat behaviors

**Spec:** emojis, react to messages, reply to specific messages, very casual friend-like tone, "give me a sec" when slow.

| Behavior | Design |
|---|---|
| **Tone** | A persona style guide plus 15–20 few-shot exchanges in the cached prefix. They're nearly free there and give the persona more than model choice does. **Mirror the student's register:** match their slang, emoji, and message length instead of forcing "bro"/"kid" on everyone (forced slang reads as cringe). A persona dial is stored as a preference ("talk to me like a friend" vs "keep it chill/professional"). Guardrails: no slurs or edgy profanity, nothing sexual, not sycophantic, and **never claims to be human** (if asked, "I'm an AI 🤖"). |
| **Multiple bubbles** | The model emits 1–3 short bubbles. The renderer sends them with the typing indicator on and a pause proportional to length (~35 chars/s, clamped 0.8–4s). Cap at 3 to protect the iMessage outbound:inbound ratio. |
| **Reactions (send)** | A `react` tool. Pure acknowledgments ("ok", "bet", "ty", "sure") get **a tapback only, no text**, as in spec example 1. That also saves outbound messages. |
| **Reactions (receive)** | If Sendblue delivers inbound tapbacks (sandbox check), a ❤️/👍 on Aria's proposal counts as "yes", and a 👎 or "?" on any message is logged as a feedback signal for memory and evals. If Sendblue can't, that's a point for Linq. |
| **Reply to specific message** | The reply plan can target a `message_id`. Use it when answering one of several messages the student sent in a burst, or when a proactive follow-up refers to an earlier thread. |
| **"Give me a sec"** | (a) Turn the typing indicator on immediately (Sendblue holds it up to 5 min). (b) If the model knows the task is long (email triage, multi-calendar search), it calls `send_interim` with a persona-written line ("give me a sec 👀", "ok ts taking a minute lol"). (c) Watchdog: no output within ~8s sends one interim bubble from a varied, persona-matched pool. Long jobs (§3.19) send an immediate acknowledgment, then follow-ups. |
| **Channel degradation** | SMS/RCS: no tapbacks (send nothing, or a short "👍" only when needed), reply targets become plain text, links are kept. |

### 3.13 Memory ("self-improving")

**Spec:** a self-improving memory of preferences, profile, and history.

**Options:**

| Option | Verdict | Reasoning |
|---|---|---|
| **Build on Supabase (tiered)** | ✅ | $0. Preferences can be replaced cleanly over time. We control what may create memories, which is an anti-injection rule. |
| Mem0 OSS 2.x on pgvector | Runner-up (facts tier only) | v2 extraction is **add-only**: old and new facts coexist with no update or delete, so "no gym late" replacing an old preference isn't handled. |
| Zep / Graphiti | ❌ | Best temporal semantics, but needs Neo4j or FalkorDB (a second database) and ~6 LLM steps per episode. We copy its "bi-temporal" idea in SQL instead. |
| Letta | ❌ | Postgres server retired in March 2026; pivoted to "Letta Code". |
| Supermemory / Cognee / MemOS / Memobase / LangMem | ❌ | Closed server, enterprise-gated features, a second database, or stalled projects. |
| Anthropic memory tool | ❌ (hot path) | Claude-only, with at least one extra round trip per conversation. |

**Benchmarks:** LoCoMo and LongMemEval scores are vendor-run and disputed. Full-context baselines beat several memory systems, and LoCoMo has ~6% wrong gold answers. The useful signal is **HaluMem**: every system scored below 62% extraction accuracy, and Mem0 skipped 74% of required updates. **Stale or wrong memories are the real risk.**

**Design:**

| Tier | Example | Storage | In context? | Written how |
|---|---|---|---|---|
| Core profile | Name, school, timezone, courses, class times, wake/sleep | `user_profile` (columns + rendered ≤400 tokens) | Always | Onboarding, explicit edits, syncs |
| Preferences / "how I like things" | "No gym after 8pm", "sign emails 'Best, Daniel'", "remind me 2h before", "short briefings" | `user_preferences`: `key`, `statement`, `status` (proposed/active/superseded/rejected), `source`, `valid_from` / `valid_to` / `superseded_by`. Partial unique index on `(user_id, key) WHERE valid_to IS NULL` | **All active rows always** (cap ~30 rows / 600 tokens) | Inline `propose_preference` → student confirms → old row closed, new row inserted |
| Facts / episodic | "Interview with Google next Thu", "roommate Alex", "struggling in CPSC 323" | `memory_facts` + `tsvector` (+ pgvector later) + `expires_at` | Only via `recall(query)` (top ≤8) | Background extraction ~30 min after a conversation goes idle (Haiku 5.5, add/update/delete/no-op against the 10 nearest facts) |
| Conversation | Last ~20 messages, rolling summary, pending actions | `messages`, `conversation_summaries`, `pending_actions` | Always | Every turn |

**Rules:**
1. **Preferences that change behavior need confirmation.** This is exactly the spec's pattern: "Should I set a new preference: no gym late?" → "sure" → 👍 tapback.
2. Low-stakes facts are written silently. The student can always ask "what do you know about me?" and say "forget X". `/settings` lists everything.
3. **Only text the student wrote in chat can create memories.** Email bodies, Canvas text, and calendar descriptions never can. This blocks persistent prompt injection (SpAIware, MINJA).
4. At most one confirmation question per conversation. Other inferred proposals queue for the next briefing.

**"Self-improving" beyond facts:** a nightly job (Haiku 5.5) consolidates and expires facts and turns behavioral signals into *proposed* preferences. Examples: briefings ignored at 8am but read at 10am → propose a later time; three gym blocks moved later → propose "afternoon gym". It also feeds the eval set (§4.11).

### 3.14 Daily briefing

**Refinement:**
- Per-user `briefing_time` (default 8:00 local, DST-safe from the IANA timezone).
- Pre-generated ~10–20 min early so 8am in a timezone doesn't create a thundering herd.
- Idempotent on `(user_id, local_date)`.
- **Content:** today's deadlines with local times (fixing V1's UTC bug), classes and events, important new email, one suggestion (e.g. "you've got a 2-hour gap at 2pm, good for the 4190 pset"). Then a link to `/week` if useful.
- Written as 1–3 bubbles that **invite a reply**. That keeps the Sendblue 24h window open and helps line reputation.
- Monday brings an extended week view.
- Suppressed briefings (quiet hours, paused) are **deferred, not dropped** (V1 bug).
- Model: Haiku 5.5, medium effort, synchronous. ~$0.002 per briefing.
- **Batch API rejected:** it saves ~$0.03/user/month, turnaround is up to 24h, and it isn't eligible for zero data retention.

### 3.15 Deadline and email alerts

**Refinement:**
- **Canvas diff:**
  - The hourly iCal sync (jittered per user) creates, changes, or removes timeline items.
  - A due-date change → immediate alert if the item is ≤7 days out, otherwise the next briefing.
  - Rows are keyed by **external ID, not title + due date** (V1 created duplicates). Urgency is computed at read time, so nothing goes stale (replaces the priority engine).
- **Deadline nudges:** the defaults are T-24h (in the briefing) and T-3h ("bro do your pset its due tonight" energy, register-matched). Both are suppressed if the item is marked done. The student can tune them ("remind me 2h before" becomes a preference).
- **Email:**
  1. Gmail push.
  2. **Rules prefilter:** Gmail categories, course and professor senders, recruiter domains, keyword regexes.
  3. Haiku 5.5 classifier with structured output: `{importance, kind: deadline_change|interview|action_needed|fyi, course?, old_due?, new_due?, confidence}`.
  4. High importance → alert now ("Yo you just got an email from a Google recruiter 👀 want to see it?"). Otherwise → briefing.
- **Throttle:** quiet hours (default 22:00–08:00 local, editable), max ~3 proactive messages a day plus urgent, and bundling within 10 min. All per channel.

### 3.16 User-set reminders

**Spec example:** "remind me 2 hours before it's due" → "ok but you sure you can finish?" → "ok done."

**Design:**
- `create_reminder` accepts either an absolute time or **an anchor (timeline item) plus an offset**.
- Anchored reminders **move automatically when the due date changes**, which a plain timestamp can't do.
- Each reminder is a row in `reminders` plus a job in `jobs` (§4.4), so it can be edited or cancelled with a SQL update.
- Fires within ~15s of its time.
- Recurring reminders use an RRULE.
- The "you sure?" pushback is persona behavior, not code. It comes from the few-shot examples.

### 3.17 Scheduling (gym/study blocks)

**Spec examples:** find gym time, learn "no gym late", plan the day around midterms, "I put it in your gcal".

**Design:**
- `find_free_slots`:
  - Reads free/busy across the student's calendars, plus class times from the profile and timeline.
  - Applies **hard constraints from active preferences** ("no gym after 8pm"), buffers (default 10 min), and the past-time filter.
  - Returns 3–5 ranked candidates spread across the window.
  - This fixes V1, which always took the earliest gap start and offered 7am to evening people.
- **The model negotiates in plain language** ("4–5:30 tmr instead?"). It creates the event only once the student picks or accepts a specific slot.
  - Calendar writes are reversible and low-risk, so the student's choice is the confirmation.
  - This matches the spec's "ok done. I put it in your gcal."
- Planning a day ("help me plan my day"):
  - The model combines `get_agenda`, syllabus weights, exam dates, and the student's stated state ("done studying for Systems").
  - It proposes blocks, the student edits them ("1 hour is enough, 2:30–3:30"), and Aria creates them.
  - Multi-constraint negotiation is an escalation trigger for Sonnet 5.5.
- **Learning** happens via `propose_preference` (§3.13), not V1's circular "3 confirmations" counter.

### 3.18 Email drafting and sending

**Spec example:** "draft an email saying …" → full draft → "ready to send, just need your confirmation".

**Design:**
1. `draft_email` uses `read_email` for the thread context, writes a `pending_actions` row, and shows the draft in chat (or `/email/[id]` if long).
2. **Sign-off and voice** come from preferences ("Best, Daniel").
3. The student says "send it" → `confirm_action` → deterministic send via `gmail.send` in-thread.
4. "change X" → revise.
5. Expires after 24h.
- **The model can never send email directly.** This breaks the "lethal trifecta" (private data + untrusted content + an exfiltration channel) for the email path.
- Model: Sonnet 5.5 for drafting (quality matters, and volume is low), Haiku 5.5 for everything else.

### 3.19 Inbox triage on connect

**Spec example:** "704 emails in the last 2 weeks… here's what actually needs you."

**Design:**
1. Immediate acknowledgment ("going through your inbox now, give me a few min").
2. A chunked background job:
   - Gmail search for the last 14 days, excluding promotions and social. Metadata first.
   - Rules prefilter so only ~20–30% reach the model.
   - Haiku 5.5 summaries in requests **kept well under 100K tokens** (above that, Haiku 5.5 costs 5×).
3. A progress message if it runs over ~1 min.
4. A final "what needs you" digest of 2–3 bubbles.
- About $0.05 per student, once.
- "Unsubscribe and archive the junk" needs `gmail.modify` (also restricted) → **Phase 2**. It adds no extra CASA cost once we're assessed for `readonly`.

### 3.20 Syllabus parsing (kept from V1)

**Design:**
- Accept a PDF **sent as an iMessage attachment** (Sendblue delivers media) or uploaded on `/setup`.
- Parse with Claude Sonnet 5.5 native PDF (~$0.18 per syllabus, vs V1's Opus 4.6). Re-parse with Opus 5.5 only when validation fails (missing weights, sums ≠ 100).
- Store structured JSON. **Never persist the PDF** (V1 rule).
- Feeds exam dates and topic weights into scheduling suggestions ("Computer Systems has more content, start there").

### 3.21 Dropped from V1

- Expo iOS app
- Twilio SMS (Sendblue covers fallback)
- Supabase phone OTP
- Todoist
- Spotify
- Priority engine and `canonical_events`
- Conflict detection
- Redis, Celery, Railway

### 3.22 Safety, privacy, and compliance

| Area | Decision |
|---|---|
| **Prompt injection** | **Untrusted content:** email, Canvas, and calendar text is wrapped and labeled as untrusted data in context. **No dangerous tools:** the model has no send-email tool, and email/calendar mutations require a confirmed pending action executed by code. **Links:** outbound links only to our domain or the original email's Gmail permalink. **Memory:** created only from student-authored chat text. Evaluate Google **Model Armor** **[verify pricing]** or an open classifier, since Google's Workspace policy now expects prompt-injection protection for Gmail-to-LLM apps. |
| **Age / audience** | **Beta: college students, 18+**, with a neutral birth-year field (a non-leading age gate per the FTC). High school is a separate launch with counsel: COPPA (amended rule, compliance since 2026-04-22), SOPIPA and copycat state laws, and school Google accounts are blocked for under-18s by default. |
| **Consent** | TCPA-grade written consent at signup (§3.1), with copy versioned in `consents`. The FCC's 2023 order scoped "texts" to SMS/MMS, not iMessage, so federal TCPA exposure for iMessage is low, but **SMS fallback brings it fully into scope**. Honor opt-outs by "any reasonable means" ("stop", "unsubscribe", "leave me alone") per channel. Quiet hours 8am–9pm minimum for proactive messages. |
| **Google Limited Use** | No ads, no selling data, no training on Gmail data. The in-app disclosure of what is read and why goes on the connect page itself, not only in the privacy policy. |
| **LLM data handling** | US providers only. No PRC first-party APIs, and no DeepSeek weights in the email-reading agent (NIST CAISI found 12× hijackability). Anthropic deletes API data within 30 days by default. Request **zero data retention** from Anthropic and OpenAI early. OpenAI calls use `store=false`. The Batch API isn't ZDR-eligible, so email workloads stay synchronous. |
| **Token encryption** | App-level **AES-256-GCM** with a versioned key prefix (`v1:`), key in a Vercel Sensitive env var with a break-glass copy in the password manager. Replaces Fernet (AES-128). Tokens are never passed through a queue. |
| **PII in logs** | Hash handles (phone and email). No message bodies in logs. Langfuse traces are sampled and redact email content. |
| **Retention / deletion** | Texting "delete my account" or using `/settings` hard-deletes within 30 days and revokes Google tokens. Message history keeps ~180 days by default **[decision]**. |
| **AI disclosure** | First message and profile card identify Aria as an AI assistant. It never claims to be human. |

---

## 4. Technical architecture decisions

### 4.1 Language and runtime: **TypeScript only** (recommended; Daniel decides)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. TypeScript only: one Next.js app on Vercel** (web + webhooks + agent + jobs) | One language, one deploy, one runtime. Next.js is needed for the web anyway. Nothing always-on to babysit (cron ticks a route). `googleapis` (npm) is actively maintained, while the Python client is in "maintenance mode". First-class TypeScript SDKs for Anthropic, OpenAI, Sendblue, and Linq (Photon is TS-only). Avoids the cross-language queue that silently dropped every task for 6 months. | Port ~1,000 LOC of salvageable Python logic. Per-user debounce and serialization is hand-rolled (~150 LOC). Serverless time limits (800s on Pro) mean long jobs must be chunked. | ✅ **Recommended** |
| B. Python only for the backend: FastAPI + Pydantic AI v2 + DBOS (durable workflows in Postgres), with Next.js only for web pages | Reuses more of V1 and its tests. DBOS gives debouncing, per-user partitioned queues, and timezone-aware schedules for free. Python is strong for AI work. | Still two languages and two deploys (Vercel + an always-on Python host at $5–25/mo). The reusable V1 code is small and mostly being rewritten, and its tests are mostly mocks. | Runner-up. **Choose this if Daniel is much faster in Python.** |
| C. Python everywhere (FastAPI + HTMX/Jinja for web) | Single language, cheapest hosting. | A weaker fit for a polished mobile-first PWA and OG images. | ❌ |
| D. Keep V1's shape (Next.js → Redis → Celery on Railway) | Least change. | Three services, two languages, Redis, and Celery ETA re-delivery bugs past the 1h visibility timeout. It's the architecture that failed silently. | ❌ |

### 4.2 Hosting

| Option | Cost (50 / 500 / 5k users) | Verdict | Reasoning |
|---|---|---|---|
| **Vercel Pro** | $20 / $20–27 / $95–265 | ✅ | First-party Next.js. Full Node with 2 GB of memory. Active-CPU pricing (time spent waiting on the LLM doesn't burn CPU). Up to 800s per function. `after()` for post-response work. Hobby is **non-commercial only**, so it's excluded. Set spend limits (the default alert is only at $200). |
| Cloudflare Workers + OpenNext | $5 / ~$7 / ~$30–40 | Runner-up | Cheapest (wall-clock time isn't billed), but 128 MB isolates, a 30s `waitUntil` limit, no Node middleware on OpenNext, and Node-library compatibility risk (googleapis, PDF, iCal). Move here if Vercel usage stays above ~$150/mo. |
| Railway / Render / Fly | $5–30 always-on | ❌ | Always-on server operations. Only relevant to option B in §4.1. |
| Hetzner + Coolify | Cheapest at scale | ❌ | We'd own patching, backups, TLS, and a single point of failure. US prices tripled in June 2026. |
| Cloud Run / Lambda | Varies | ❌ | GCP/AWS operations overhead; Lambda bills wall-clock time while waiting on the LLM. |

### 4.3 Database

| Option | Verdict | Reasoning |
|---|---|---|
| **Supabase Pro** ($25/mo, includes Micro compute and daily backups, 7-day retention) | ✅ | Postgres + pgvector + pg_cron (down to per-second) + pg_net + Vault in one product. **Use Pro from the first real user:** Free has no backups and pauses after a week of inactivity. A separate free project for dev. |
| Neon | Runner-up | pg_cron only runs while compute is awake (≈$19/mo always-on), and there's no Vault or cron-to-HTTP equivalent. |
| PlanetScale Postgres ($5) | ❌ | pgvector and pg_cron not confirmed **[verify]**. |
| Self-hosted / Railway Postgres | ❌ | We'd own backups. |

We **don't use Supabase Auth** in V2 (own sessions, §3.6). Row-level security stays **on with no anon policies** (deny-all), and all access goes through server routes with the service role.

### 4.4 Background jobs and scheduling

**Design:** Postgres is the single source of truth for everything scheduled.

- `jobs(id, kind, user_id, run_at, payload, status, attempts, locked_until, dedupe_key)`, with a partial unique index on `dedupe_key` where the status is pending.
- **Supabase Cron** runs every 15s. It calls `net.http_post` to `/api/jobs/dispatch` (HMAC secret stored in Vault) **only if due rows exist**.
- The dispatch route claims rows with `FOR UPDATE SKIP LOCKED`, runs them with a concurrency cap (inside `after()`), retries with backoff, and dead-letters after N attempts.
- A sweeper re-dispatches leases that expired mid-run.

| Job kind | Trigger |
|---|---|
| Conversation turn | Inbound webhook (debounced, §4.5) |
| User reminder | `run_at` = reminder time; anchored reminders re-computed on due-date change |
| Daily briefing | `users.next_briefing_at` (DST-safe), pre-generated ~15 min early |
| Canvas sync | `next_sync_at`, hourly + jitter |
| Gmail watch renew | Daily per user |
| Calendar watch renew | Every 6 days per user |
| Memory extraction | ~30 min after conversation idle |
| Nightly consolidation | Per user, in a staggered 2–5am local window |
| Long tasks (triage) | Chained chunk jobs, each ≤ ~5 min |

**Options:**

| Option | Cost | Verdict | Reasoning |
|---|---|---|---|
| **Postgres jobs + Supabase Cron + Vercel route** | $0 | ✅ | Reminders are editable and cancellable with SQL, survive deploys, need no extra vendor, and fire within 15s. |
| Inngest | Free to 50k executions, then **$99/mo** | Runner-up | Best built-in debounce, batching, singleton, and dashboard. Switch if the hand-rolled version proves painful. |
| Vercel Workflow | $0.02/1k events | Optional for long jobs | No max sleep, but **no per-key concurrency or debounce**. ~20 events per agent turn ≈ $480/mo at 1.2M turns, so never wrap every turn in it. |
| Trigger.dev v4 | $10–50+ | ❌ | Billed on wall time, including time spent waiting on the LLM (~$435/mo at 5k users). |
| Upstash QStash | $1 per 100k messages | ❌ | Good one-off scheduler, but flow control doesn't guarantee ordering and has no debounce. |
| Vercel Queues / Celery-on-Vercel | — | ❌ | Beta. Celery-on-Vercel holds `eta` tasks in memory, so it's useless for "remind me at 9:47pm". |
| Temporal Cloud | $50 per 1M actions; Essentials plan removed | ❌ | Overkill. |
| DBOS | $0 | Runner-up **if Python** (§4.1 B) | — |

### 4.5 Per-user conversation pipeline

Students fire 3 bubbles in 2 seconds, and two agent runs for the same user must never overlap.

1. **Webhook** (`/api/channels/sendblue`):
   - Verify the signature against a configured URL.
   - Upsert the message on `(provider, provider_message_id)` so retries are idempotent.
   - Start the typing indicator.
   - Upsert a `conversation_turn` job with `dedupe_key = user_id` and `run_at = now() + 2.5s` (debounce: later messages push `run_at` out).
   - Return 200 in under 1s.
2. **Dispatch** claims the job and acquires a **per-user lease** (`UPDATE user_runtime SET lease_until = now()+5min WHERE user_id=$1 AND (lease_until IS NULL OR lease_until < now()) RETURNING`). If the lease is held, it reschedules for +3s.
3. **The run** consumes all unconsumed inbound messages, runs the agent, sends the reply, then **re-checks for messages that arrived mid-run** and loops once if there are any.
4. It releases the lease. A crashed run expires after 5 min and the sweeper retries.

### 4.6 Models per workload

Prices are USD per 1M tokens. Haiku 5.5's tokenizer counts about 30% more tokens than older models, which is already included in the estimates below.

| Workload | Primary | Fallback | Est. cost | Rejected |
|---|---|---|---|---|
| **Main chat agent** | **Claude Haiku 5.5** ($0.10 in / $0.50 out, cache reads $0.01). Effort low, adaptive thinking (on for tool turns, off for small talk). | **GPT-6 Luna** via the Responses API ($0.10/$0.50; 0.83s time to first token). Also used when Haiku refuses or has an outage (Haiku 5.5 has no server-side fallback). | ~$1.05 per 1k turns cached (~$0.47/user/mo at 15 turns/day) | Gemini 3.8 Flash: best tone, but 5–7× the price and **doubling on 2027-01-01**. GLM-5.3-Flash: best tool evidence per dollar, but thinking is always on (latency) and Chinese-origin weights would be reading email. DeepSeek V4.1: NIST hijackability. gpt-oss-120b: poor tone. Grok: no cheap tier left. gpt-5-mini/nano: shut down 2026-12-11. |
| Escalation | **Claude Sonnet 5.5** ($2/$10), effort low (0.88s time to first token) | — | ~$19 per 1k turns cached; budget ≤5–10% of turns | — |
| Email/deadline classifier | Rules → Haiku 5.5 (thinking off, structured output, no tools) | GPT-6 Luna (effort none) | ~$0.09/user/mo | gpt-oss-20b (pennies saved, third vendor) |
| Daily briefing | Haiku 5.5, medium effort, synchronous | GPT-6 Luna | ~$0.06/user/mo | Batch API (not ZDR-eligible, ≤24h turnaround) |
| Memory extraction / consolidation | Haiku 5.5, medium effort, structured output | GPT-6 Luna | ~$0.05–0.09/user/mo | — |
| Syllabus PDF | **Sonnet 5.5** native PDF | Gemini 3.8 Flash (paid tier); Opus 5.5 for re-parse | ~$0.18 per syllabus | GPT-6 Luna (no PDF input listed) |
| Inbox triage | Haiku 5.5 (requests <100K tokens) | GPT-6 Luna | ~$0.05 per student, once | — |
| Email drafting | Sonnet 5.5 | Haiku 5.5 | Low volume | — |

**Week-one bake-off (decides the primary):**
- Haiku 5.5 vs GPT-6 Luna, on 150–300 scripted and real transcripts.
- Measures: tool-call success on our tools, scheduling-negotiation success, blind tone ratings by 5–10 students, and p95 latency.
- **Why it's needed:**
  - Neither model has public tool-use or tone benchmarks yet; Haiku 5.5 launched 2026-10-07.
  - Artificial Analysis currently shows Haiku 5.5 at **9.7s to first token** with thinking on (low effort) vs Luna's 2.8s.
  - Luna scores higher on AutomationBench (0.53 vs 0.35), but Haiku leads the overall intelligence index (43.4 vs 38.1).
- Latency is partly hidden by the typing indicator, but it matters.

**Rejected outright:**
- **Self-hosting:** break-even is ~15–70B tokens/month at high utilization, while Aria at 2k users is ~3.6B.
- **Learned routers** (§3.11).

**Caching rules (worth ~2.5×):**
- Tools and the static system prompt must be byte-identical across all users and come first.
- Put the cache breakpoint before the per-user context, so the date, time, memory, and history come after it.
- Keep the tool list deterministic.
- Verify `cache_read_input_tokens` in the cost logs.

### 4.7 LLM access layer

| Option | Verdict | Reasoning |
|---|---|---|
| **Native `@anthropic-ai/sdk` + `openai` behind a thin internal `llm` module** (routes → model/effort/cache settings; usage and cost logging; refusal/5xx/timeout fallback) | ✅ | The cost levers are provider-specific and arrive in native SDKs first: cache breakpoints and TTLs, per-message effort without cache loss, refusal handling, the Responses API with `prompt_cache_key`. Two providers keeps the code small. |
| Vercel AI Gateway (bring your own keys) | Runner-up | No markup and free per-request ZDR on Pro. Adds managed failover and spend dashboards. Caveat: if our key fails it silently retries on Vercel's credentials, billing our credits. |
| OpenRouter | Bake-off only | 5.5% fee on credit purchases, and its ZDR pool includes PRC-linked providers. |
| LiteLLM | ❌ | PyPI 1.82.7/1.82.8 were **backdoored on 2026-03-24**. Plus another service to run. |
| Cloudflare AI Gateway | ❌ | Logs payloads by default, and its cache is exact-match only. |

### 4.8 Agent framework

| Option | Verdict | Reasoning |
|---|---|---|
| **No framework: a ~150-line tool loop over the `llm` module, with tools defined as zod → JSON schema** | ✅ | No streaming or UI needed (that's most of what frameworks add). We need fine control of caching, effort, and refusals. Approval is "the next turn" (§3.11), so no durable interrupts are required. No major-version churn. |
| Vercel AI SDK v7 | Runner-up | Excellent provider coverage, but a new major roughly every 6 months, and provider-specific features lag. |
| Mastra | ❌ | Heavier. `ee/` code moved to a source-available license on 2026-09-22. |
| LangGraph (JS) | ❌ | Graph abstraction we don't need. `interrupt()` re-runs nodes on resume. |
| Claude Agent SDK | ❌ | Spawns a CLI subprocess (~1 GiB per session), built for code and file work, Claude-only. |
| OpenAI Agents SDK / Google ADK / Agno | ❌ | Pre-1.0 or churning, provider-skewed. |
| Pydantic AI v2 | Runner-up **if Python** | — |
| MCP for Gmail/Calendar/Canvas | ❌ in the request path | Direct in-process tools are cheaper (no bloat from loading every tool definition), faster, and safer (no tool-poisoning or confused-deputy risk). Google's Workspace MCP servers are Developer Preview and still need our OAuth and CASA. Instructure's API Policy bans "model context protocol servers… not approved by Instructure". We may expose Aria's own tools as an MCP server later for dev and evals. |

### 4.9 Embeddings and retrieval

| Option | Verdict | Reasoning |
|---|---|---|
| **Phase 1: no embeddings.** Postgres full-text search (`tsvector`) + recency over `memory_facts` | ✅ | A student will have tens to low hundreds of facts. FTS plus recency is enough and costs $0. |
| Phase 2 (when facts per user exceed ~150 or the recall eval fails): **OpenAI text-embedding-3-small** ($0.02/M) + pgvector HNSW, hybrid with FTS via reciprocal rank fusion | ✅ later | Same vendor as the fallback LLM, so no new data processor. |
| voyage-4-lite ($0.02/M, 200M free tokens, better retrieval) | Runner-up | **Free-tier data may be used for training and can't be opted out of.** Requires a paid account with "Help Improve Voyage AI Models" switched off. |
| Supabase gte-small (free) | ❌ | 512-token truncation, English-only, weak retrieval. |
| Self-hosted embeddings | ❌ | Not worth it at our volume. |

### 4.10 Secrets and token encryption

- AES-256-GCM in app code, with a versioned prefix so the key can be rotated without downtime.
- The key lives in a Vercel Sensitive env var, with a break-glass copy in the password manager.
- Supabase Vault holds only secrets SQL needs, such as the dispatch HMAC secret. **A dump-and-restore can't decrypt Vault without its root key**, which is relevant for future migrations.
- Not needed: KMS (Vercel's KMS only signs), Doppler, Infisical.

### 4.11 Observability and evals

| Tool | Use | Cost |
|---|---|---|
| Own `llm_calls` table | Tokens (incl. cache read/write), model, route, cost, latency for **every** call | $0 |
| Langfuse Hobby (cloud) | Traces, **sampled** (100% of errors; 20–40% of turns at 50 users, ~10% at 500) | $0 → $29–65/mo |
| Sentry Developer | Errors + cron monitors | $0 |
| PostHog | Landing → signup → first text → connected funnel; web analytics | $0 (1M events) |
| **Evals** | (1) 30–50 preference-change transcripts. (2) Scheduling scenarios. (3) Tone blind-ratings. (4) Prompt-injection emails. (5) Tool-call correctness. Seeded from the spec's example conversations as *test cases*, not hard-coded flows. Run nightly on Haiku (cheap). | ~$1–5/run |

**Rejected:**
- Helicone: maintenance mode since the Mintlify acquisition.
- LangSmith, Braintrust: paid tiers for what Langfuse does free.
- Self-hosted Langfuse: needs ClickHouse with ≥8 GiB.

### 4.12 Repo shape (V2)

```
aria/
├── src/app/                  # Next.js 16: landing, /m, /setup, /week, /settings, /email
│   └── api/
│       ├── channels/sendblue/route.ts      # inbound webhook (verify sig, upsert, debounce)
│       ├── jobs/dispatch/route.ts          # pg_cron tick target (HMAC)
│       ├── session/redeem/route.ts         # magic-link POST
│       ├── google/{oauth,callback,gmail-push,calendar-push}/route.ts
│       └── canvas/connect/route.ts
├── src/server/
│   ├── channels/   (provider interface + sendblue adapter + renderer)
│   ├── agent/      (loop, prompt builder, tools/, escalation rules)
│   ├── llm/        (anthropic + openai adapters, routes, cost logging)
│   ├── memory/     (profile, preferences, facts, extraction)
│   ├── jobs/       (claim, run, kinds/*)
│   ├── integrations/ (google, canvas-ical, syllabus)
│   └── security/   (crypto, magic links, sessions)
├── supabase/migrations/      # fresh V2 baseline migration
├── evals/
└── docs/
```

### 4.13 Testing

- Unit tests on **pure logic**: iCal parse/diff, slot finding with constraints, timezone/DST, magic-link redemption, lease logic, the reply-plan renderer.
- An integration suite against a local Supabase (`supabase start`) for jobs, leases, and idempotency.
- Sendblue sandbox smoke tests.
- Evals (§4.11) for model behavior.
- Avoid V1's pattern of `MagicMock` call-chain tests, which couldn't catch AUD-08.

---

## 5. Data model (V2 baseline, outline)

The old migrations are replaced by one fresh baseline in the new project.

```
users(id, name, timezone, briefing_time, next_briefing_at, persona_prefs jsonb,
      birth_year, created_at, deleted_at)
signups(id, name, phone_e164, timezone, consent_version, ip, user_agent,
        created_at, expires_at, matched_user_id)
channels(id, user_id, kind[imessage|whatsapp|sms], handle, handle_kind[phone|email|bsuid],
         provider, provider_line, verified_at, opted_out_at, paused_until,
         last_inbound_at, UNIQUE(kind, handle))
consents(id, user_id, channel_id, scope, granted, copy_version, captured_at, source)
messages(id, user_id, channel_id, direction, provider, provider_message_id,
         body, media jsonb, reply_to_message_id, status, created_at, consumed_by_run,
         UNIQUE(provider, provider_message_id))
reactions(id, message_id, actor[user|aria], type, created_at, removed_at)
user_runtime(user_id PK, lease_until, last_run_at)
agent_runs(id, user_id, status, model, escalated, started_at, finished_at, error)
llm_calls(id, run_id, route, model, input_tokens, cache_read, cache_write,
          output_tokens, cost_usd, latency_ms, created_at)
jobs(id, kind, user_id, run_at, payload jsonb, status, attempts, locked_until,
     dedupe_key, last_error)
pending_actions(id, user_id, kind[send_email|...], payload jsonb, preview_message_id,
                status, expires_at)
reminders(id, user_id, text, due_at, anchor_item_id, offset_minutes, rrule,
          status, job_id)
integrations(id, user_id, provider[google|canvas_ical], account_email, scopes[],
             enc_access_token, enc_refresh_token, token_expires_at, status,
             gmail_history_id, gmail_watch_expires_at,
             gcal_channel_id, gcal_channel_token_hash, gcal_watch_expires_at,
             enc_ical_url, next_sync_at, synced_at)
timeline_items(id, user_id, source[canvas|gcal|gmail|syllabus|aria], external_id,
               kind[assignment|exam|event|class|block], title, course, starts_at,
               ends_at, due_at, url, status[upcoming|done|dismissed], raw jsonb,
               UNIQUE(user_id, source, external_id))
email_items(id, user_id, gmail_message_id, thread_id, from_addr, subject,
            category, importance, summary, received_at)  -- no bodies stored
syllabi(id, user_id, course_name, parsed_json, parsed_at)
user_profile(user_id PK, school, courses jsonb, class_times jsonb, rendered_block)
user_preferences(id, user_id, key, category, statement, status, source,
                 valid_from, valid_to, superseded_by, evidence_message_id, last_used_at)
memory_facts(id, user_id, content, tsv tsvector, embedding vector NULL,
             source_message_id, confidence, expires_at, deleted_at)
conversation_summaries(user_id, through_message_id, summary, updated_at)
magic_links(token_hash PK, user_id, purpose, target, expires_at, used_at)
web_sessions(session_hash PK, user_id, scope, created_at, expires_at, revoked_at)
```

`timeline_items` replaces V1's `deadlines`, `canonical_events`, and `calendar_events`. It's keyed by external ID and urgency is computed at read time.

---

## 6. Cost model

**Per heavy active user per month:** 15 turns/day, 1 briefing/day, ~1 reminder/day, 30 emails/day classified, 5 syllabi/semester.

| Item | Cost |
|---|---|
| Chat, Haiku 5.5 cached (+ ~200 reasoning tokens/call) | $0.47–0.56 |
| Sonnet 5.5 escalation at 5% (10%) | $0.43 ($0.86) |
| Briefings | $0.06 |
| Email/deadline classification | $0.09 |
| Memory extraction + consolidation | $0.05–0.09 |
| Syllabus (amortized) + one-time triage | ~$0.10 |
| **LLM subtotal** | **~$1.2–1.8** |
| iMessage (Sendblue) | $2.00 (50 users) → $0.40–0.60 (500) → $0.30–0.50 (5k) |
| WhatsApp utility-only, if approved | +$0.30 per WhatsApp user |

**Fixed and infra (monthly):**

| | 50 | 500 | 5,000 |
|---|---|---|---|
| Vercel Pro | $20 | $20–27 | $95–265 |
| Supabase | $25 | $25 | $30–80 |
| Langfuse / Sentry / PostHog | $0 | $29–37 | $29–91 |
| Domain | ~$1 | ~$1 | ~$1 |
| Google CASA (amortized) | $0 (unverified beta) | ~$60–85 | $60–450 |

**Sensitivity (where cost actually moves):**
1. Turns per user (linear).
2. Escalation rate: each +5% adds ~$0.43/user.
3. Prompt-cache hit rate: losing caching costs ~2.5× on chat.
4. Bubbles per reply only matter if WhatsApp is ever full-chat.
5. Sendblue Enterprise pricing at scale.

V1's design at 500 users would be ~$9k/month vs ~$0.9–1.4k for V2.

---

## 7. Proposed phases

Not started; each phase needs approval. Effort assumes Daniel solo.

| Phase | Scope | Exit gate |
|---|---|---|
| **0. Ownership + spikes** (~1 week) | §2 checklist: domain, new accounts, rotations, tag `v1-final`. **Spikes:** Sendblue sandbox checks (§3.3), Yale EliApps OAuth test, deep links on real iPhones and Android, preview-fetcher logging. Start Google brand verification. Write privacy policy and terms. | All accounts owned by Daniel. Spike results recorded. Open questions in §8 answered. |
| **1. Core loop** (~2–3 weeks) | Fresh schema. Landing + signup. Sendblue webhook + conversation pipeline (§4.5). Agent loop + persona + memory core. Magic links + `/setup` + `/week`. Canvas iCal connect + sync. Reminders. Daily briefing. Cost logging. Evals v0. Model bake-off. | 5-friend alpha on iMessage for one week. p95 reply under ~12s. No duplicate sends. |
| **2. Google** (~2–3 weeks) | OAuth (unverified, "In production"). Calendar read + "Aria" calendar writes + scheduling. Gmail push + classifier + alerts + triage + drafting/sending via pending actions. Syllabus via attachment. Prompt-injection evals. **Submit restricted-scope verification + CASA.** | 50-student closed beta (Yale, 18+). |
| **3. Hardening** (ongoing) | CASA remediation. PWA install + pairing sign-in. Nightly self-improvement. Gmail archive/unsubscribe (Phase 2 of the product spec). WhatsApp re-evaluation. Apple Messages for Business exploration at scale. Second school. | Verified Google app before user 100. |

---

## 8. Open questions for Daniel

> **Resolved 2026-10-09 — ship V2 as a free private test first** (`docs/plans/2026-10-09-aria-v2-free-testing-plan.md`). Decisions: WhatsApp **deferred**; Canvas credential vault **kept for production, encrypted** (risks recorded in the production plan; free test uses iCal only); language **both** (TS primary + Python parser service over HTTP); beta **open to anyone** (private test = people Daniel knows); compliance process **deferred** for the private test while keeping confirm-before-send, memory-only-from-user-text, and ask-before-connecting-a-friend's-accounts. Still needed to start: iMessage provider pick, repo strategy, whether Gmail is in from day one, and whether the Anthropic key + Supabase project exist. Original list kept below for the record.

> **Sub-decisions confirmed 2026-10-10 (Daniel):** calendar writes → a dedicated **"Aria" calendar** (`calendar.app.created`); persona → **mirror the user's register**; message history retention → **180 days**; Sonnet 5.5 escalation cap → **10% of turns**; domain → **stay on `*.vercel.app`** for the free test.

1. **WhatsApp:**
   - (A) defer in the US *(recommended)*
   - (B) utility-only templates
   - (D) full assistant anyway, accepting ban risk
2. **Canvas NetID vault:** drop it *(recommended)*?
3. **Language:** TypeScript-only *(recommended)* or Python backend (§4.1 B)? Pick based on which you're faster in.
4. **Beta audience:** college-only, 18+ *(recommended)*; high school later with counsel?
5. **Landing form:** keep name + phone + consent *(recommended)*, or name-only (§3.1 B)?
6. **Calendar writes:** a dedicated "Aria" calendar *(recommended)* or the primary calendar?
7. **Gmail in the beta:** include it, with the unverified warning and 100-user cap, and start CASA in parallel *(recommended)*? Or launch Canvas + Calendar first and add Gmail after verification?
8. **Persona default:** mirror the student's register *(recommended)* or always-slang as in the spec examples?
9. **Message history retention:** 180 days *(proposed)*?
10. **Escalation budget:** Sonnet 5.5 capped at 5% or 10% of turns?
11. **Domain name** for Aria (needed in Phase 0).

## 9. Verify in week one

- **Sendblue:**
  - inbound tapback webhook shape
  - "V2 line" on the AI Agent plan
  - 150-message cap semantics
  - preview-fetcher user agent and IP
  - email-handle reporting
  - Android SMS/RCS landing on the same number
- **iOS/Android:**
  - `sms:` body pre-fill on iOS 17/18/26
  - iOS 26 Home Screen cookie isolation
  - WhatsApp/Messages opening links in Safari vs in-app
- **Google:**
  - Yale EliApps third-party app access for unverified apps
  - `calendar.app.created` sensitivity class
  - Pub/Sub pricing
  - Model Armor pricing
- **Models:** Haiku 5.5 time to first token with thinking off. Sonnet 5.5 cache-read price ($0.10 vs $0.20 — sources disagree).
- **Legal:** a short counsel review of the consent copy, age gate, and privacy policy before the beta.

---

## Appendix A: Architecture at a glance

```
                       ┌──────────────────────── Vercel (Next.js 16, TypeScript) ───────────────────────┐
 Student (iMessage) ──►│ /api/channels/sendblue ─► verify ─► upsert msg ─► debounce job ─┐             │
   ▲   via Sendblue    │                                                                │             │
   │                   │ /api/jobs/dispatch ◄── pg_net POST (HMAC) ◄── Supabase Cron 15s│             │
   │                   │      │ claim (SKIP LOCKED) + per-user lease                      ▼             │
   │                   │      ├─► agent turn: context → llm (Haiku 5.5 ⇄ tools) → reply plan → renderer┼──► Sendblue API
   │                   │      ├─► briefing / reminder / canvas sync / watch renew / memory jobs        │
   │                   │ /m (magic link) /setup /week /settings  ◄── student taps link (Safari/Chrome) │
   │                   │ /api/google/* (OAuth, Gmail Pub/Sub push [OIDC], Calendar push [token])       │
   │                   └───────────────┬─────────────────────────────────────────────────────────────────┘
   │                                   │ service role
   │                         Supabase Postgres (pgvector, pg_cron, pg_net, Vault)
   └──── SMS/RCS fallback (Android) ───┘     Google APIs · Canvas iCal · Anthropic · OpenAI (fallback)
```

## Appendix B: Key sources (fetched 2026-10-09 by research agents)

- **WhatsApp policy and pricing:**
  - Meta Terms for WhatsApp Business Platform §4.7: https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform
  - AI providers page: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers
  - Non-template pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages
  - Poke on Apple Messages for Business: https://techcrunch.com/2026/06/04/apple-approves-poke-as-the-first-ai-agent-on-its-messages-for-business-platform/
- **iMessage providers:**
  - Sendblue: https://www.sendblue.com/pricing · https://docs.sendblue.com/limits · https://docs.sendblue.com/api-v2/reactions · https://docs.sendblue.com/guides/inline-replies · https://docs.sendblue.com/api-v2/typing-indicators
  - Linq: https://linqapp.com/s/pricing · https://docs.linqapp.com/channel/imessage/guides/webhooks/events/index.md · https://linqapp.com/blog/poke-customer-story
  - Photon: https://photon.codes/pricing
  - Lindy's Apple ban: https://www.lindy.ai/blog/imessage-api-three-rewrites-one-apple-ban-and-what-actually-works
- **Link previews, sessions, PWA:**
  - Apple TN3156: https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages
  - WhatsApp link previews: https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/
  - OWASP Session Management: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
  - WebKit (Safari 26): https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
  - Next.js support policy: https://nextjs.org/support-policy · https://nextjs.org/blog/upcoming-nextjs-security-update-october-2026
- **Google:**
  - Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
  - Security assessment: https://support.google.com/cloud/answer/13465431
  - User cap: https://support.google.com/cloud/answer/7454865
  - Workspace API User Data Policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
  - TAC CASA: http://casa.tacsecurity.com/site/home
  - Under-18 Workspace restriction: https://knowledge.workspace.google.com/admin/getting-started/editions/manage-access-to-unconfigured-third-party-apps-for-users-designated-as-under-18
- **Canvas / Yale:**
  - Instructure OAuth docs: https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth
  - Canvas API Policy: https://www.instructure.com/policies/canvas-api-policy
  - Instructure Acceptable Use Policy: https://www.instructure.com/policies/acceptable-use
  - Yale 1601 PR.02: https://your.yale.edu/policies-procedures/procedures/1601-pr02-netids-and-identity-management
  - Yale 1607: https://your.yale.edu/policies-procedures/1607-information-technology-appropriate-use-policy
  - Yale MFA: https://cybersecurity.yale.edu/mfa
- **Legal:**
  - FCC texting order: https://docs.fcc.gov/public/attachments/DOC-398661A1.pdf
  - COPPA amended rule: https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule
  - FTC COPPA FAQ: https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions
- **Models:**
  - Claude pricing: https://platform.claude.com/docs/en/about-claude/pricing
  - GPT-6 Luna: https://developers.openai.com/api/docs/models/gpt-6-luna
  - Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
  - Artificial Analysis: https://artificialanalysis.ai/leaderboards/models
  - LLMRouterBench: https://arxiv.org/abs/2601.07206
  - LiteLLM compromise: https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/
- **Memory and agents:**
  - HaluMem: https://arxiv.org/html/2511.03506v3
  - Mem0 v2 migration: https://docs.mem0.ai/migration/oss-v2-to-v3
  - Letta pivot: https://www.letta.com/blog/our-next-phase/
  - Lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
  - Code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- **Infra:**
  - Vercel Hobby: https://vercel.com/docs/plans/hobby
  - Vercel functions pricing: https://vercel.com/docs/functions/usage-and-pricing
  - Vercel AI Gateway: https://vercel.com/docs/ai-gateway/pricing
  - Supabase pricing: https://supabase.com/pricing
  - Supabase Cron: https://supabase.com/docs/guides/cron
  - Supabase project transfer: https://supabase.com/docs/guides/platform/project-transfer
  - Langfuse pricing: https://langfuse.com/pricing
  - Voyage training opt-out: https://www.mongodb.com/docs/atlas/tutorial/manage-organization-settings/
