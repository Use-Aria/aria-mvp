# Aria V2 — Production Plan (deferred from the free test)

> **Status:** Reference. Everything here is deferred while V2 runs as a free private test (`docs/plans/2026-10-09-aria-v2-free-testing-plan.md`).
> **Full architecture and rationale:** `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md` (§2 ownership, §6 cost, §7 phases).

This is the path from a 4-person private test to a real product. Pull an item forward only when a trigger below fires.

---

## Triggers that force production work

| Trigger | What it forces |
|---|---|
| Approaching **100 Google users** (lifetime, incl. churned/testers) | Google brand verification + restricted-scope review + **CASA** security assessment. Start ~user 60–70; it takes 6–10 weeks. |
| Any **SMS fallback** to real recurring messaging | TCPA-grade consent capture, per-channel STOP, 10DLC registration (Sendblue handles A2P). |
| Opening signup to **the public / minors** | Age-gate 13+ (provider ToS), COPPA if under-13 possible, state laws (SOPIPA) for high-schoolers, ToS + privacy policy. |
| **Charging money** | Leave Vercel Hobby (non-commercial) → Vercel Pro; Supabase Free → Pro. |
| **Real users' tokens/reminders** stored | Supabase Pro (backups, no pausing); request zero-data-retention from Anthropic/OpenAI. |
| **>~300–500 users per iMessage line** | Additional Sendblue lines (pin each user to a line); Enterprise pricing. |

---

## Paid infrastructure (when the triggers fire)

| Layer | Free test | Production |
|---|---|---|
| Hosting | Vercel Hobby | Vercel Pro ($20/mo), spend limits set |
| Database | Supabase Free | Supabase Pro ($25/mo), daily backups |
| iMessage | Photon Free / Sendblue sandbox | Sendblue AI Agent line(s) ($100/line/mo) |
| Domain | `*.vercel.app` | Owned domain (Cloudflare Registrar) — also required for Google verification + privacy policy |
| Observability | Sentry free | + Langfuse (sampled traces), PostHog |
| LLM data | Default retention | ZDR agreements; `store=false` on OpenAI; email workloads synchronous (Batch isn't ZDR-eligible) |

Cost model at 50 / 500 / 5,000 users: spec §6. Summary: ~$4.1–4.7, ~$1.8–2.7, ~$1.5–2.5 per user/month all-in.

---

## Ownership re-provisioning (spec §2)

V1 was never deployed, so the clean move is **fresh accounts under Daniel's org with no data migration**, and rotating every secret a former teammate could have seen (Anthropic, Supabase service-role, Twilio, Google client secret). The `TOKEN_ENCRYPTION_KEY` that may live only on the old Railway project is irrelevant if no real users exist — confirm the old Supabase `users`/`integrations` tables hold only test rows, then proceed. Ask the former teammate to delete the Railway project; rotate regardless.

---

## Canvas credential login — Daniel's decision, with risks recorded

**Decision (2026-10-09):** in addition to the iCal feed, offer a credential-based Canvas login (school NetID/password), **encrypted at rest**.

**Honest assessment — encryption does not address the core risks, which are not about data-at-rest:**

- **Yale Policy 1601 PR.02 and 1607** forbid sharing a NetID/password. The **student (your friend) carries the disciplinary risk**, which can include loss of IT privileges.
- **Instructure's Acceptable Use Policy** forbids sharing credentials and accessing Canvas by means other than supported interfaces; driving a headless browser through SSO is exactly that.
- Bot-triggered **Duo pushes from server IPs** look like the MFA-fatigue attacks Yale trains students to report.
- A store of university passwords is a **high-value breach target** and would undermine the Google CASA review (storing third-party credentials weakens the security posture reviewers assess).
- Under *Facebook v. Power Ventures*, continued access after a cease-and-desist creates **CFAA exposure**.

**Recommendation:** keep **iCal + notification emails** as the default and only Canvas path for the foreseeable future — it already delivers deadlines, and emails fill in announcements, due-date changes, and submission/grade notices with no credentials. If a credential path is ever pursued, gate it behind each user's explicit informed consent, ideally institutional approval, isolated infrastructure, and legal review — never as a default onboarding step. This path is intentionally **not designed or built**; this section records the decision and its risks only.

---

## Other production items

- **Prompt-injection hardening** for the email-reading agent (Google's Workspace policy expects it): wrap untrusted content, no direct send tool, outbound links only to our domain or the original Gmail permalink, memory only from user-authored chat. Evaluate Model Armor or an open classifier.
- **Scaling the job system** (spec §4.4): the Postgres `jobs` table + Supabase Cron scales to thousands; add a dedicated interactive queue if reply latency spikes. Inngest is the escape hatch if the hand-rolled debounce/singleton proves painful.
- **PWA install + "text Aria to sign in" pairing** (spec §3.8).
- **Gmail archive/unsubscribe** ("clean up the junk") needs `gmail.modify` (also restricted — no extra CASA cost once assessed for `readonly`).
- **Apple Messages for Business** as the ToS-safe iMessage path to explore past ~5k users.
- **WhatsApp** re-evaluation only if Meta's policy changes or the "connect third-party AI agents" beta ships with usable terms (spec §3.4).
- **Second school** onboarding (university list already ported; add "Other").
- **Celery/Redis task processing + Docker Compose (V3 reconsideration).** V2 keeps Docker and a serverless Redis (Upstash, for locks/debounce/rate-limits) but drops Celery. For V3/production, reconsider a first-class Celery+Redis worker **only if** the backend consolidates on Python (so there's no cross-language queue boundary) and there's a reliable always-on host. Even then, keep arbitrary-time reminders on the Postgres jobs table (Celery ETA re-delivery past the visibility timeout is unreliable); use Celery for throughput-oriented background work (bulk email triage, nightly consolidation). Decision deferred to V3.
