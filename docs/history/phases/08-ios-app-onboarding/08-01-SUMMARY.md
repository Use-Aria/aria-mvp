---
phase: 08-ios-app-onboarding
plan: 01
subsystem: mobile
tags: [expo, react-native, supabase-auth, nativewind, jest, onboarding-foundation]
dependency_graph:
  requires: []
  provides:
    - mobile/package.json (Expo SDK 55 project with all Phase 8 deps)
    - mobile/lib/supabase.ts (Supabase client with ExpoSecureStoreAdapter)
    - mobile/lib/api.ts (typed API client for all Phase 8 routes)
    - mobile/lib/theme.ts (6-preset accent color context)
    - mobile/hooks/useSession.ts (auth state listener)
    - mobile/app/_layout.tsx (root layout with session routing)
    - mobile/__tests__/*.test.tsx (6 Wave 0 test stub files)
  affects:
    - All subsequent Phase 8 plans (depend on this foundation)
tech_stack:
  added:
    - expo@55.0.8 (SDK 55 managed workflow)
    - expo-router@55.0.7 (file-based routing)
    - expo-secure-store@55.0.9 (iOS Keychain session storage)
    - expo-auth-session@55.0.9 (Google OAuth PKCE)
    - expo-speech-recognition@3.1.1 (on-device voice input)
    - expo-document-picker@55.0.9 (syllabus upload)
    - expo-crypto@55.0.10 (OAuth nonce hashing)
    - @supabase/supabase-js@2.99.3 (auth + database)
    - nativewind@4.2.3 (Tailwind utilities for React Native)
    - react-native-draggable-flatlist@4.0.3 (card drag reorder)
    - "@gorhom/bottom-sheet@5.2.8" (chat slide-up sheet)
    - react-native-url-polyfill@3.0.0 (Supabase URL polyfill)
    - jest-expo@55.0.11 (Jest preset for Expo)
    - "@testing-library/react-native@13.3.3" (component testing)
  patterns:
    - ExpoSecureStoreAdapter for iOS Keychain auth session storage
    - Session-based routing guard in root layout (onboarding vs home)
    - ThemeContext for 6-preset accent color propagation
    - Wave 0 test stub pattern (it.todo placeholders for all requirements)
key_files:
  created:
    - mobile/package.json
    - mobile/app.json
    - mobile/tsconfig.json
    - mobile/tailwind.config.js
    - mobile/babel.config.js
    - mobile/metro.config.js
    - mobile/nativewind-env.d.ts
    - mobile/global.css
    - mobile/types/index.ts
    - mobile/lib/supabase.ts
    - mobile/lib/api.ts
    - mobile/lib/theme.ts
    - mobile/hooks/useSession.ts
    - mobile/app/_layout.tsx
    - mobile/app/index.tsx
    - mobile/app/(onboarding)/_layout.tsx
    - mobile/app/(onboarding)/welcome.tsx
    - mobile/app/(home)/_layout.tsx
    - mobile/app/(home)/index.tsx
    - mobile/jest.config.js
    - mobile/jest.setup.js
    - mobile/__mocks__/expo-secure-store.ts
    - mobile/__mocks__/@supabase/supabase-js.ts
    - mobile/__tests__/navigation.test.tsx
    - mobile/__tests__/auth.test.tsx
    - mobile/__tests__/onboarding.test.tsx
    - mobile/__tests__/home.test.tsx
    - mobile/__tests__/card.test.tsx
    - mobile/__tests__/chat.test.tsx
  modified: []
decisions:
  - "Excluded src/ template directory from tsconfig — Expo SDK 55 default template uses src/app but plan specifies mobile/app; tsconfig exclude prevents template file TS errors"
  - "Added @types/jest and types:[jest] in tsconfig — required for jest globals (describe, it, jest.fn) to be recognized by TypeScript in mock and test files"
  - "ThemeContextType.colors typed as union (typeof COLORS.light | typeof COLORS.dark) not just COLORS.light — both light and dark palettes share same key shape but literal string types differ"
  - "Wave 0 test stubs use it.todo() only — no imports of non-existent components; avoids TS errors while satisfying Nyquist Wave 0 requirement"
metrics:
  duration_seconds: 683
  completed_date: "2026-03-20"
  tasks_completed: 2
  tasks_total: 2
  files_created: 29
  files_modified: 0
---

# Phase 08 Plan 01: iOS App Foundation — Expo Scaffold + Wave 0 Test Stubs Summary

**One-liner:** Expo SDK 55 project scaffolded in `/mobile` with ExpoSecureStoreAdapter Supabase auth, 6-preset accent ThemeContext, session-based root routing, NativeWind v4, and 41 Wave 0 test stubs across 6 files.

---

## What Was Built

**Task 1: Expo project scaffold with all dependencies and Wave 0 test stubs**
Commit: `e8eb44d`

Created the `/mobile` Expo project from the `default@sdk-55` template. Installed all Phase 8 dependencies (expo-secure-store, expo-speech-recognition, expo-document-picker, expo-auth-session, expo-crypto, @supabase/supabase-js, nativewind@4, react-native-draggable-flatlist, @gorhom/bottom-sheet, react-native-url-polyfill). Configured NativeWind v4 (tailwind.config.js with `nativewind/preset`, babel.config.js with `nativewind/babel`, metro.config.js with `withNativeWind`). Updated `app.json` with `scheme: "aria"`, `bundleIdentifier: "com.aria.mobile"`, and plugin entries for expo-secure-store and expo-speech-recognition. Created `mobile/types/index.ts` mirroring the web app's Task/CalendarEvent/Message types plus mobile-specific ChatMessage and UserPreferences. Created Jest infrastructure (`jest.config.js` with `setupFilesAfterEnv`, `jest.setup.js` with mocks for expo-secure-store, expo-speech-recognition, and @gorhom/bottom-sheet) and mock files for expo-secure-store and @supabase/supabase-js. Created all 6 Wave 0 test stub files with 41 `it.todo()` placeholders covering requirements UI-01, AUTH-02, AUTH-03, AUTH-05, AUTH-06, UI-01 through UI-07.

**Task 2: Supabase client, API client, theme system, session hook, root layout**
Commit: `d2e8239`

Created `mobile/lib/supabase.ts` with `ExpoSecureStoreAdapter` (iOS Keychain-backed session storage). The Google `provider_token` is intentionally excluded from Keychain storage — documented in comments — because it can exceed the 2KB per-key limit causing silent failures on app re-launch. Created `mobile/lib/api.ts` with a typed `authFetch` wrapper (attaches Supabase JWT as Authorization header), `BriefingPreviewResponse` contract type, and all Phase 8 API route wrappers (deadlines, events, chat, phone OTP, canvas validate, briefing preview). Created `mobile/lib/theme.ts` with `ACCENT_COLORS` (6 presets, Indigo `#5856D6` default), `STATUS_COLORS`, `COLORS` light/dark palette, and `ThemeContext` + `useTheme` hook. Created `mobile/hooks/useSession.ts` listening to both `getSession()` initial state and `onAuthStateChange` updates. Created root layout `mobile/app/_layout.tsx` wrapping in `GestureHandlerRootView`, `ThemeContext.Provider`, and `BottomSheetModalProvider` with session-based routing guard. Created placeholder onboarding and home screen group layouts with `gestureEnabled: false` on the onboarding stack.

---

## Verification Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | PASS — 0 errors |
| `npx jest --passWithNoTests` | PASS — 6 suites, 41 todos |
| package.json expo version | `~55.0.8` |
| app.json scheme | `aria` |
| app.json bundleIdentifier | `com.aria.mobile` |
| ExpoSecureStoreAdapter used | YES (not AsyncStorage) |
| 6 accent presets in ACCENT_COLORS | YES (Indigo, Blue, Green, Orange, Pink, Purple) |
| setupFilesAfterEnv (not setupFilesAfterSetup) | YES |
| All 6 Wave 0 test stub files | YES |

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added @types/jest for TypeScript test globals**
- **Found during:** Task 2 TypeScript verification
- **Issue:** `jest`, `describe`, `it` globals not recognized by TypeScript (TS2582, TS2708 errors)
- **Fix:** Installed `@types/jest` and added `"types": ["jest"]` to tsconfig.json compilerOptions
- **Files modified:** `mobile/tsconfig.json`, `mobile/package.json`
- **Commit:** `d2e8239`

**2. [Rule 1 - Bug] Fixed ThemeContext type for dark mode colors**
- **Found during:** Task 2 TypeScript verification
- **Issue:** `ThemeContextType.colors` was typed as `typeof COLORS.light` but dark mode passes `COLORS.dark` (literal string types differ), causing TS2322
- **Fix:** Changed type to `typeof COLORS.light | typeof COLORS.dark`
- **Files modified:** `mobile/lib/theme.ts`
- **Commit:** `d2e8239`

**3. [Rule 3 - Blocking issue] Excluded Expo SDK 55 template src/ directory from TypeScript**
- **Found during:** Task 2 TypeScript verification
- **Issue:** `create-expo-app --template default@sdk-55` scaffolds with `src/app` structure. With `@/*` path alias pointing to `./`, the template's `src/` components (animated-icon, app-tabs, etc.) tried to resolve using our new paths and produced 20+ TS module-not-found errors. These template files are not part of the Phase 8 implementation.
- **Fix:** Added `"exclude": ["src/**/*", "node_modules"]` to tsconfig.json
- **Files modified:** `mobile/tsconfig.json`
- **Commit:** `d2e8239`

---

## Self-Check: PASSED

All 15 key files verified to exist on disk. Both task commits (e8eb44d, d2e8239) confirmed in git log. TypeScript 0 errors. Jest 6 suites 41 todos all passing.
