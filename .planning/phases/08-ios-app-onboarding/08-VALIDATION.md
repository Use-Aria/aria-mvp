---
phase: 8
slug: ios-app-onboarding
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest + React Native Testing Library |
| **Config file** | `mobile/jest.config.js` (Wave 0 installs) |
| **Quick run command** | `cd mobile && npx jest --testPathPattern="__tests__" --passWithNoTests` |
| **Full suite command** | `cd mobile && npx jest --coverage --passWithNoTests` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd mobile && npx jest --testPathPattern="__tests__" --passWithNoTests`
- **After every plan wave:** Run `cd mobile && npx jest --coverage --passWithNoTests`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 8-01-01 | 01 | 0 | UI-01 | unit | `cd mobile && npx jest --testPathPattern="navigation"` | ❌ W0 | ⬜ pending |
| 8-01-02 | 01 | 0 | AUTH-02 | unit | `cd mobile && npx jest --testPathPattern="auth"` | ❌ W0 | ⬜ pending |
| 8-02-01 | 02 | 1 | AUTH-02 | unit | `cd mobile && npx jest --testPathPattern="onboarding"` | ❌ W0 | ⬜ pending |
| 8-02-02 | 02 | 1 | AUTH-03 | unit | `cd mobile && npx jest --testPathPattern="google-oauth"` | ❌ W0 | ⬜ pending |
| 8-03-01 | 03 | 2 | UI-01 | unit | `cd mobile && npx jest --testPathPattern="home"` | ❌ W0 | ⬜ pending |
| 8-03-02 | 03 | 2 | UI-02 | unit | `cd mobile && npx jest --testPathPattern="card"` | ❌ W0 | ⬜ pending |
| 8-04-01 | 04 | 3 | UI-07 | unit | `cd mobile && npx jest --testPathPattern="chat"` | ❌ W0 | ⬜ pending |
| 8-04-02 | 04 | 3 | UI-08 | manual | N/A — on-device speech | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `mobile/__tests__/navigation.test.tsx` — stubs for UI-01 (navigation setup)
- [ ] `mobile/__tests__/auth.test.tsx` — stubs for AUTH-02, AUTH-05 (auth store)
- [ ] `mobile/__tests__/onboarding.test.tsx` — stubs for AUTH-02, AUTH-03, AUTH-06 (onboarding flow)
- [ ] `mobile/__tests__/home.test.tsx` — stubs for UI-01, UI-02, UI-03, UI-04 (home screen zones)
- [ ] `mobile/__tests__/card.test.tsx` — stubs for UI-05, UI-06 (card interactions)
- [ ] `mobile/__tests__/chat.test.tsx` — stubs for UI-07 (in-app chat)
- [ ] `mobile/jest.config.js` — Jest config with React Native Testing Library preset

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Voice transcription accuracy | UI-08 | On-device speech recognition requires real microphone | Open app → tap mic → speak "what's due this week" → verify transcript appears in chat bar |
| Google OAuth login flow | AUTH-03 | Requires real Google account and Safari web view | Run on physical device → tap "Sign in with Google" → complete OAuth → verify Supabase session |
| Phone SMS verification | AUTH-02 | Requires Twilio sending real SMS | Enter phone → receive SMS → enter OTP → verify authenticated state |
| Dark mode appearance | UI-09 | Visual inspection required | Toggle dark mode in iOS Settings → reopen app → verify all zones render correctly |
| Card drag-to-reorder | UI-05 | Gesture interaction not fully simulatable | Long-press card → drag to new position → verify order persists on reload |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
