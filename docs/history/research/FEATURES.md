# Feature Research

**Domain:** SMS-first AI personal assistant for college students (Canvas/LMS integration, proactive briefings, deadline alerting, conversational AI)
**Researched:** 2026-03-18
**Confidence:** MEDIUM — primary sources unavailable (web search denied); based on training knowledge of the student productivity landscape through August 2025 plus first-principles analysis of the domain. Flag any competitive claim for manual validation.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete or untrustworthy.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Canvas deadline sync (accurate, always-on) | Students' entire academic calendar lives in Canvas. If Aria ever shows a wrong due date, trust is destroyed permanently. | MEDIUM | iCal feed is the right approach — no FERPA exposure, no institutional auth. Must diff correctly on every sync; stale data is worse than no data. |
| Opt-out / STOP command (TCPA compliance) | Required by US law (TCPA). Students expect it from any SMS service. Missing = legal liability. | LOW | Twilio handles STOP keyword natively; must also handle PAUSE, UNSTOP, HELP. Never send after STOP is received. |
| Quiet hours (no SMS during sleep) | Students will immediately opt out if they get a 2am deadline alert. No quiet hours = churn on day 1. | LOW | Default quiet window: 10pm–8am. User-configurable. Store in preferences_json. |
| Daily max message cap | Receiving 15 texts/day from an assistant feels like spam, not help. | LOW | Enforce max 3 unsolicited/day as planned. Replies to user-initiated conversations don't count toward cap. |
| Proactive deadline reminders (T-24h, T-1h) | Students expect to be reminded before deadlines, not just when the deadline is added. The reminder is the core value. | MEDIUM | Two tiers: a 24-hour heads-up (strategic), and a 1-hour warning (tactical). Configurable. Grade-weighted items get priority. |
| Onboarding in under 5 minutes | College students have zero patience. If connecting Canvas + Google + verifying phone takes more than 5 minutes, they drop off. | MEDIUM | Canvas = paste iCal URL (30 seconds). Google = OAuth click-through (1 minute). Phone = SMS verification code (1 minute). Keep the funnel tight. |
| "What's due this week?" conversational query | The most natural, obvious thing to ask an academic assistant. If this doesn't work reliably, Aria feels broken. | MEDIUM | Claude Sonnet with Canvas deadlines in context. Must handle variations: "what do I have due", "upcoming deadlines", "this week's assignments". |
| Accurate first name personalization | "Hey [Name], here's your week" vs. "Hello user." Generic = feels like spam. | LOW | Captured at onboarding. Store in users table. Every outbound message uses it. |
| SMS link to assignment URL | Students need to be able to tap the assignment directly from the SMS. Reading the title alone doesn't get the work done. | LOW | Canvas iCal VEVENT includes URL field. Pass through to Task.url, include in briefing/alert messages. |

### Differentiators (Competitive Advantage)

Features that set Aria apart from a simple reminder app or a generic AI chatbot.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Grade-weighted deadline prioritization | Not all deadlines are equal. A 0.5% participation post vs. a 30% midterm deserves different urgency. Most reminder apps treat them the same. | HIGH | Requires syllabus parsing (Claude Opus). Weight stored in deadlines.grade_weight. Briefing generator weights urgency by grade impact. Only Aria can do this because competitors don't parse syllabi. |
| Syllabus-aware briefings | "Your CPSC 223 midterm covers chapters 4-7 and is worth 25% of your grade" vs. "CPSC 223 midterm due Friday." Context from the syllabus makes the briefing actionable, not just informational. | HIGH | Claude Opus extracts exam topics, policies, grade breakdown. Stored as structured JSON. Briefing generator uses this as context. Genuinely rare capability. |
| Gmail signal cross-referencing | Professors change deadlines in emails before Canvas is updated. Catching "midterm moved to Tuesday" from an email and alerting before Canvas reflects it is a unique safety net. | HIGH | NLP on email subject/body to detect date/deadline language. Cross-reference against Canvas state. Alert if discrepancy found. This is a meaningful safety net with no competitor equivalent in this space. |
| Conversational back-and-forth via SMS | "Push my ECON paper to tomorrow's to-do list" or "What did my prof say about the final?" Most reminder apps are one-way. Two-way conversation makes Aria feel like a real assistant. | HIGH | Claude Sonnet with per-user context window. Route inbound SMS to replies.ts. Keep last N messages per user for conversation continuity. |
| Calendar write-back (study blocks) | Student texts "block 2 hours for MATH studying tomorrow at 3pm" and it appears in Google Calendar. Closes the loop between knowing about a deadline and scheduling time to work on it. | HIGH | Requires Google Calendar write scope. Claude parses the intent from the conversational SMS and writes a CalendarEvent. |
| Zero-new-app UX | Every other student productivity tool requires downloading an app, learning a new interface, and maintaining a new habit. Aria lives in SMS, which students already use compulsively. Adoption barrier is near-zero. | LOW (product, not code) | This is a positioning differentiator, not a feature to build. But every product decision should preserve it: never require the student to open a web app to get value. |
| Exam countdown cadence | "14 days until CHEM 112 final (worth 35%). You've covered 4/10 topics from the syllabus." A countdown that gets more urgent as the exam approaches, combined with topic coverage tracking. | HIGH | Requires syllabus parsing + study session tracking. Deferred to v2 in current plan. Include in feature landscape for prioritization awareness. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Grade access / submission tracking | "See my current grade" is the #1 ask from students. Sounds useful. | FERPA violation. Canvas grades/submissions require institutional OAuth approval and expose protected education records. One data incident = product is gone. | Stay on iCal only. Use syllabus grade weights as a proxy for what matters, not actual grade data. Frame to users: "I help you not miss deadlines, not track your grades." |
| Real-time Canvas webhook notifications | Developers want push-based sync so deadlines appear instantly. | Canvas does not offer public webhook endpoints for LMS changes. "Real-time" Canvas sync requires institutional API access that Yale would never grant to a student project. | 60-minute iCal poll is the correct and compliant approach. With Gmail cross-referencing, urgent changes still surface quickly. |
| SMS chatbot with persistent memory of all-time history | "Remember everything I've ever told you" sounds like great AI. | Claude context window is finite. Loading all-time history per request is expensive and creates context confusion. Also a privacy risk if user data is ever breached. | Rolling 14-day deadline window + 7-day calendar per request as specified. Store long-term user preferences in Supabase, not in Claude context. |
| Automatic calendar event creation from every Canvas deadline | "Put all my deadlines in Google Calendar automatically." Students ask for this. | Creates calendar spam. 15 Canvas deadlines per week generates 60+ calendar blocks per month that students stop looking at. Calendar becomes noise. | Write study blocks only on user request via SMS. Briefings and SMS alerts are the primary communication channel, not calendar. |
| Notification channel proliferation (push + email + SMS + Slack) | "Cover all my bases." | Duplicate alerts across channels train students to ignore all of them. The value of Aria is that SMS is reliable and high-signal. More channels = lower signal. | SMS-first, always. Add iMessage (Sendblue) in v2 as an upgrade path for the same channel. Do not add email/push/Slack notifications in MVP. |
| Per-assignment AI study plan generation | "Generate a study plan for my ECON 355 final." Sounds like the next logical step from briefings. | Requires LLM calls per request, is computationally expensive, and produces generic advice students ignore after the first week. | Briefings + calendar write-back + conversational queries cover 90% of this need. Study gap detection (v2) is the structured version of this. |
| Social features / shared deadlines | "Let me see what my study group has due." | FERPA risk (sharing academic data between users), added complexity, and dilutes the personal assistant positioning. | Out of scope entirely. Aria is a personal assistant, not a group coordination tool. |

---

## Feature Dependencies

```
Canvas iCal sync
    └──requires──> Background sync engine (Celery + Redis)
    └──enables──> Deadline reminders
    └──enables──> Daily briefing
    └──enables──> Deadline change alerts
    └──enables──> Grade-weighted prioritization (with syllabus)

Syllabus parsing
    └──requires──> Syllabus PDF upload
    └──requires──> Claude Opus API
    └──enables──> Grade-weighted prioritization
    └──enables──> Syllabus-aware briefings
    └──enables──> Exam countdown (v2)
    └──enables──> Study gap detection (v2)

Daily briefing
    └──requires──> Canvas iCal sync (deadlines in DB)
    └──requires──> SMS send (Twilio)
    └──enhanced-by──> Syllabus parsing (adds grade weights + topic context)
    └──enhanced-by──> Google Calendar (adds schedule awareness)

Conversational SMS replies
    └──requires──> Twilio inbound webhook
    └──requires──> Claude Sonnet API
    └──requires──> Canvas iCal sync (context for answers)
    └──enhanced-by──> Syllabus parsing (richer answers)
    └──enhanced-by──> Google Calendar (can answer schedule questions)

Calendar write-back
    └──requires──> Google Calendar OAuth (write scope)
    └──requires──> Conversational SMS replies (intent parsing)

Gmail cross-referencing
    └──requires──> Gmail OAuth (readonly scope)
    └──requires──> Canvas iCal sync (baseline to diff against)
    └──enables──> Deadline change alerts (email-sourced)

Deadline change alerts
    └──requires──> Canvas diff engine
    └──enhanced-by──> Gmail cross-referencing (earlier signal)
    └──requires──> SMS send (Twilio)

User onboarding
    └──required-by──> ALL features (no user = no data)
    └──includes──> Phone verification (Twilio)
    └──includes──> Canvas iCal URL capture
    └──includes──> Google OAuth (Calendar + Gmail)
```

### Dependency Notes

- **Syllabus parsing enhances briefings but is not required for them.** A useful briefing is possible with Canvas data alone. Syllabus data makes it great. This means briefings can ship before syllabus parsing is complete.
- **Gmail cross-referencing enhances deadline alerts but is not required.** Canvas diff alone produces useful alerts. Gmail adds a signal layer for catching professor-sourced changes before Canvas reflects them.
- **Calendar write-back requires conversational replies.** The intent to create a study block only surfaces through natural language SMS. It cannot be triggered by a batch job.
- **Google Calendar read-only is useful before write is needed.** The briefing can incorporate schedule context (classes, existing events) without needing write scope. Implement read first, add write when conversational replies are ready.

---

## MVP Definition

### Launch With (v1)

Minimum viable product to validate that students will use an SMS-based academic assistant.

- [ ] Canvas iCal sync (60-min background job, diff engine, Supabase storage) — without this, there's nothing to brief about
- [ ] Daily briefing (7am generation, 8am send via SMS) — this is the primary value delivery mechanism; without it there's no reason to sign up
- [ ] Deadline change alerts (Canvas diff fires SMS within 15 min) — this is the "rescue" moment; students who get one of these become believers
- [ ] Conversational reply to "what's due this week?" — students will text back immediately after the first briefing; they need to get a useful reply
- [ ] User onboarding (phone, Canvas iCal URL, Google OAuth, SMS verification) — without this nobody can use the product
- [ ] STOP/PAUSE/HELP command handling (TCPA compliance) — required by US law before any SMS is sent
- [ ] Quiet hours + daily message cap — students will churn on day 1 without this
- [ ] Gmail integration (read professor emails, detect deadline language, alert on discrepancy) — included in MVP because the build plan has it before Twilio; it upgrades alert quality significantly

### Add After Validation (v1.x)

Add when core pipeline is working and first 10 users are active.

- [ ] Syllabus PDF parsing — massive quality upgrade for briefings (adds grade weights, topic context), but briefings work without it; add once students are using the core product
- [ ] Syllabus-aware briefing generation — activated once syllabus parsing is in place; Claude Sonnet uses parsed JSON as additional context
- [ ] Google Calendar integration (read) — lets Aria say "you have CPSC lecture at 2pm and the problem set is due at midnight"; requires Google OAuth which is already in onboarding
- [ ] Calendar write-back (study blocks via SMS) — "block 2 hours for MATH tomorrow" — high-value but requires conversational replies to be solid first

### Future Consideration (v2+)

Defer until product-market fit is established with Yale beta cohort.

- [ ] Exam countdown scheduling — high complexity, requires syllabus parsing to be solid + study session tracking
- [ ] Study gap detection — requires syllabus topic extraction + student's own notes or study log input; complex to do well
- [ ] Todoist integration — adds personal task layer; nice-to-have once academic tasks are solid
- [ ] Sendblue iMessage — upgrade path for iOS users who prefer iMessage over SMS; lower priority than core features
- [ ] Conflict detection (Canvas vs GCal) — detects when a class or exam conflicts with a student's personal calendar; useful but not core
- [ ] Spotify focus session automation — delightful but firmly v2; adds no academic value

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Canvas iCal sync + diff engine | HIGH | MEDIUM | P1 |
| Daily morning briefing (SMS) | HIGH | MEDIUM | P1 |
| Deadline change alerts | HIGH | LOW (given diff engine) | P1 |
| User onboarding (phone + Canvas URL + Google OAuth) | HIGH | MEDIUM | P1 |
| STOP/PAUSE/HELP TCPA compliance | HIGH (legal) | LOW | P1 |
| Quiet hours + message cap | HIGH | LOW | P1 |
| Conversational "what's due this week?" | HIGH | MEDIUM | P1 |
| Gmail deadline signal detection | MEDIUM-HIGH | MEDIUM | P1 |
| Syllabus PDF parsing | HIGH | HIGH | P2 |
| Grade-weighted prioritization | HIGH | LOW (given syllabus parsing) | P2 |
| Google Calendar read integration | MEDIUM | MEDIUM | P2 |
| Syllabus-aware briefing text | MEDIUM-HIGH | LOW (given parsed JSON) | P2 |
| Calendar write-back via SMS | MEDIUM | MEDIUM | P2 |
| Exam countdown (v2) | MEDIUM | HIGH | P3 |
| Study gap detection (v2) | MEDIUM | HIGH | P3 |
| Todoist integration (v2) | LOW-MEDIUM | MEDIUM | P3 |
| Sendblue iMessage (v2) | LOW (MVP) | MEDIUM | P3 |
| Spotify focus sessions (v2) | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch (March 19, 2026 deadline)
- P2: Should have, add in first weeks of beta
- P3: Nice to have, v2 or later

---

## Competitor Feature Analysis

Confidence: MEDIUM — based on training knowledge through August 2025. Validate against current product pages before drawing hard conclusions.

| Feature | Notion AI / Student Tools | Reclaim.ai / Motion | Our Approach |
|---------|--------------------------|---------------------|--------------|
| Canvas/LMS sync | None (Notion has no LMS sync) | None (calendar-only, no LMS) | iCal feed — only no-approval method that works at scale |
| SMS-first delivery | None (app-only) | None (web/app only) | Core differentiator: zero new apps, lives in texts |
| AI-generated briefings | Generic Notion summaries, not deadline-aware | Daily agenda emails (calendar-only) | Claude Sonnet synthesizing Canvas + Calendar + syllabus — uniquely academic |
| Syllabus parsing | None | None | Claude Opus extraction — grade weights + exam topics; no competitor does this |
| Proactive deadline alerts | None (passive, you must check) | Calendar-based only | Canvas diff + Gmail signal = proactive, not reactive |
| Conversational query via SMS | None | None | Two-way SMS with Claude; feels like texting a knowledgeable TA |
| Grade-weighted priority | None | None | Unique; requires syllabus data that only Aria captures |
| TCPA compliance | N/A | N/A | Required for SMS; build in from day 1, not retrofitted |

**Key competitive insight:** No current competitor combines LMS-awareness + SMS delivery + proactive AI briefings. The space is occupied by calendar schedulers (Reclaim, Motion) that know nothing about Canvas, and note-taking AI (Notion AI, Khanmigo) that require app interaction. Aria's gap is real — the SMS-first, LMS-integrated position is uncontested as of early 2026.

---

## SMS UX Patterns (Specific to This Domain)

These are patterns that SMS-based services have validated; important for briefing and reply design.

### Briefing message format constraints

- SMS has 160-character segments. Multi-segment messages (MMS fallback or concatenated SMS) work but feel clunky.
- Effective briefings are scannable in 10 seconds. Use numbered lists, not paragraphs.
- Include exactly 3-5 items per briefing. More = ignored. Less = feels sparse.
- Always end with a call-to-action or reply prompt: "Reply with any Q" or "Text WEEK for full list."
- Links must be shortened. Full Canvas URLs are 80+ characters. Use Twilio's built-in link shortening or a slug.

### Conversational reply constraints

- Students do not want to learn command syntax. "STOP", "PAUSE", "HELP" are acceptable because they're industry-standard. Custom commands like "BRIEF", "LIST" are anti-patterns — students forget them.
- Natural language intent parsing via Claude is the right approach. Let students text naturally.
- Ambiguous queries should ask one clarifying question, not return an error.
- Response latency must be under 10 seconds for conversational replies. Students expect SMS to be instant.

### Alert fatigue threshold

- Research in notification design consistently shows that high-frequency, low-relevance alerts train users to ignore or disable all alerts from a sender.
- For academic alerts: 1-2 alerts per week per student is sustainable. More than 3/day causes opt-out.
- Grade-weighting is the key signal filter: only alert on assignments worth >5% of the course grade, or on any deadline moved within 48 hours.
- "Batch" low-weight reminders into the daily briefing rather than sending individual alerts.

---

## Sources

- Project context: `CLAUDE.md`, `FEATURES.md`, `.planning/PROJECT.md` (authoritative for Aria's scope)
- Competitive landscape: training knowledge through August 2025 — Reclaim.ai, Motion, Notion AI, Khanmigo; validate before citing publicly
- TCPA compliance patterns: industry-standard Twilio documentation knowledge (HIGH confidence — regulatory requirements do not change frequently)
- SMS UX patterns: aggregated from notification research + Twilio best-practices knowledge through August 2025 (MEDIUM confidence — stable patterns)
- Canvas iCal limitations: known from Canvas LMS documentation (HIGH confidence — iCal is the established no-auth integration path)

---
*Feature research for: Aria — SMS-first AI academic assistant for college students*
*Researched: 2026-03-18*
