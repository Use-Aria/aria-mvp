# Phase 8: iOS App + Onboarding - Research

**Researched:** 2026-03-19
**Domain:** React Native / Expo — iOS app, onboarding flow, voice input, drag/swipe gestures, Supabase Auth mobile
**Confidence:** HIGH (core stack), MEDIUM (voice library selection)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Platform:** React Native / Expo — not Next.js. True native iOS app.
- Lives in `/mobile` directory within the `aria-mvp` repo. Josh never touches `/mobile`; Seb never touches `/src`.
- Directory structure: `mobile/app/` (Expo Router screens), `mobile/components/`, `mobile/lib/` (API client, Supabase), `mobile/package.json`
- Backend communication: mobile calls **Next.js API routes** (`/api/*`) — same routes Josh builds for web
- Auth: **Supabase Auth JS SDK** with `ExpoSecureStoreAdapter` for secure keychain session storage on iOS
- Google OAuth: `expo-auth-session` → Supabase `signInWithIdToken` — same Supabase project and users table as web
- **Onboarding:** Linear multi-step wizard — one screen per step, progress indicator at top
- Step sequence: (1) Welcome, (2) Enter phone, (3) Enter SMS PIN auto-advance on 6 digits, (4) Paste Canvas iCal URL + validate button, (5) Connect Google Account (skippable), (6) TCPA alert consent, (7) First briefing preview → Enter app
- Google OAuth is optional — skip allowed, placeholder card shown until connected
- **TCPA consent screen (Screen 6):** Toggle default OFF, must be explicitly enabled. Writes `has_alert_consent: true` to `users.preferences_json`. Legal copy: *"I agree to receive time-sensitive deadline alerts at any hour."*
- **4-Zone Dashboard:** Zone 1 = pinned quick-access bar, Zone 2 = daily load status bar (full-width color fill), Zone 3 = scrollable card grid, Zone 4 = persistent chat + voice bar
- **Card behavior:** Tap expands inline; Long-press enters drag mode; Swipe left reveals "Hide"
- **Light/dark mode:** follows iOS system setting automatically — no manual toggle
- **Accent color:** 6-8 presets, Indigo default `#5856D6`, stored in `users.preferences_json`
- **In-App Chat:** persistent bottom bar showing last message + mic button; tapping slides up full-screen iMessage-style chat; swipe down collapses
- **Voice input:** tap-to-start / tap-to-stop (not hold-to-record); on-device speech recognition; transcribed text → same Claude pipeline as typed messages
- **TTS read-back:** deferred — not in Phase 8 scope
- Chat history: loads last 20 in-app messages on open; pagination on scroll up
- Thread independence: in-app chat separate from SMS history; both call same backend

### Claude's Discretion
- Expo Router navigation structure (tab bar vs stack nav for secondary screens)
- Exact loading skeleton designs for cards and chat
- Error state handling for failed Canvas URL validation
- Pinned quick-access bar icon set and tap behavior

### Deferred Ideas (OUT OF SCOPE)
- TTS read-back for voice output — future phase
- Android app — iOS only for v1; Android is Phase 3+
- Web dashboard — Next.js web pages for onboarding/preferences may be needed as a fallback, but iOS app is the primary Phase 8 deliverable
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AUTH-02 | User can connect Google account via OAuth 2.0 (Calendar + Gmail scopes) | expo-auth-session + Supabase signInWithIdToken pattern; nonce mismatch pitfall documented |
| AUTH-03 | Google OAuth tokens stored encrypted (AES-256) in Supabase with refresh rotation | ExpoSecureStoreAdapter for mobile; backend stores encrypted tokens server-side (Josh's domain) |
| AUTH-05 | User can enter Canvas iCal URL during onboarding (validated before saving) | Call `/api/sync/canvas` after URL saved; frontend does basic URL shape check + backend validates on sync |
| AUTH-06 | User can enter phone number during onboarding and verify via SMS PIN | Twilio Verify API via backend `/api/auth/phone/send` and `/api/auth/phone/verify` routes |
| UI-01 | Onboarding flow — phone number entry, Canvas iCal URL, Google OAuth connect | 7-step linear wizard with Expo Router stack screens |
| UI-02 | Syllabus upload UI — file picker, upload progress, confirmation | expo-document-picker + fetch multipart to `/api/upload/syllabus` |
| UI-03 | Preferences page — quiet hours, notification frequency, connected integrations | Settings screen under Expo Router stack; reads/writes `users.preferences_json` via Supabase JS |
| UI-04 | Connection status page — shows linked Google/Canvas status with health indicators | Reads `integrations` table via Supabase JS; renders connect/disconnect CTAs |
| UI-05 | First briefing preview — shows what user's first briefing will look like after onboarding | Call `/api/briefing/preview` (Josh builds); render markdown-style text in a ScrollView |
| UI-06 | iOS home screen with 4-zone layout | Expo Router tabs; custom tab bar hidden; zones built as stacked View components |
| UI-07 | In-app chat connected to same backend as SMS; separate thread | WebSocket or polling to `/api/chat`; render with @gorhom/bottom-sheet slide-up |
| UI-08 | Voice input via on-device speech recognition | expo-speech-recognition (SFSpeechRecognizer on iOS); tap-start/tap-stop UX |
| UI-09 | Card customization — drag to reorder, swipe to hide, accent color, dark mode, tap to expand | react-native-draggable-flatlist + react-native-gesture-handler Swipeable; accent stored in preferences_json |
</phase_requirements>

---

## Summary

Phase 8 builds a standalone React Native / Expo app inside the `aria-mvp` monorepo at `/mobile`. The primary deliverables are a 7-step onboarding wizard and a 4-zone iOS home screen with in-app chat and voice input. The mobile app is a pure consumer of existing Next.js API routes — it does not own any backend logic.

The technology stack is well-established for 2026: Expo SDK 55 (React Native 0.83, React 19.2, New Architecture mandatory), Expo Router v4 (file-based routing), and `@supabase/supabase-js` with `ExpoSecureStoreAdapter` for keychain-backed session storage. NativeWind v4 provides Tailwind-style utility classes compatible with the New Architecture. The card interaction layer uses `react-native-draggable-flatlist` for drag-to-reorder and `react-native-gesture-handler`'s `Swipeable` for swipe-to-hide. Voice input uses `expo-speech-recognition` (wraps iOS SFSpeechRecognizer directly, fully on-device).

The biggest implementation risks are: the Google OAuth nonce mismatch on iOS (documented pitfall requiring explicit nonce threading through `expo-auth-session` → `signInWithIdToken`); the `expo-secure-store` 2KB per-key size limit (Google's provider token can exceed this, requiring split storage); and the New Architecture requirement in SDK 55 (no Legacy Architecture fallback). The planner must account for an EAS development build being required for any native module (no Expo Go support for `expo-speech-recognition`).

**Primary recommendation:** Scaffold `/mobile` as an Expo managed workflow project with SDK 55, Expo Router v4, NativeWind v4, and EAS Build for iOS device testing. Never use Expo Go for this project — development builds from day one.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| expo | 55.0.8 | Managed workflow runtime, EAS Build | Official Expo framework; SDK 55 = New Architecture mandatory, React Native 0.83 |
| expo-router | 55.0.7 | File-based routing, stack + tab navigation | Official Expo routing; v4 introduces native Stack API for declarative headers |
| react-native | 0.83 (managed by expo) | Core RN; managed via Expo SDK | Bundled with Expo SDK 55; New Architecture always on (no Legacy) |
| @supabase/supabase-js | 2.99.3 | Auth, database queries, realtime | Same Supabase project as web; mobile uses anon key + RLS |
| expo-secure-store | 55.0.9 | Keychain-backed session storage (iOS Keychain) | Required for ExpoSecureStoreAdapter; native iOS Keychain integration |
| nativewind | 4.2.3 | Tailwind utility classes in React Native | Works with New Architecture; team already uses Tailwind on web |
| react-native-reanimated | 4.2.2 | Animation primitives (required by gesture + drag libs) | Software Mansion standard; required by draggable-flatlist and gesture-handler |
| react-native-gesture-handler | 2.30.0 | Touch gesture primitives (Swipeable, GestureDetector) | Software Mansion standard; required by Expo Router and draggable-flatlist |
| react-native-safe-area-context | 5.7.0 | iOS safe area insets (notch, home bar) | Required by Expo Router installation |
| react-native-screens | 4.24.0 | Native screen optimization | Required by Expo Router installation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| expo-auth-session | 55.0.9 | Google OAuth PKCE flow in mobile | AUTH-02: Google OAuth on iOS via expo-auth-session → Supabase signInWithIdToken |
| expo-web-browser | 55.0.9 | Opens OAuth login in in-app browser | Paired with expo-auth-session for OAuth redirect |
| expo-speech-recognition | 3.1.1 | On-device iOS SFSpeechRecognizer wrapper | UI-08: tap-to-start/tap-to-stop voice input; no cloud API needed |
| react-native-draggable-flatlist | 4.0.3 | Long-press drag to reorder list items | UI-09: card grid drag-to-reorder |
| @gorhom/bottom-sheet | 5.2.8 | Slide-up bottom sheet for chat view | UI-07: persistent chat bar expands to full-screen sheet |
| expo-document-picker | 55.0.9 | Native file picker for syllabus upload | UI-02: syllabus PDF selection |
| @react-native-async-storage/async-storage | 3.0.1 | Fallback storage for non-sensitive data | Session cache, card order persistence |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| expo-speech-recognition | @react-native-voice/voice | expo-speech-recognition is Expo-native, works in managed workflow without ejecting; @react-native-voice requires bare workflow config |
| react-native-draggable-flatlist | react-native-reorderable-list | draggable-flatlist is more mature (4.0.3), wider community; reorderable-list is newer (0.18.0) and may be more stable with New Architecture |
| @gorhom/bottom-sheet | Expo Router modal screens | bottom-sheet gives continuous drag gesture for slide-up/down; Expo Router modals are full-screen only (no snap points) |
| NativeWind | StyleSheet + custom theme | NativeWind mirrors web Tailwind; reduces context-switching for Seb who already knows Tailwind |

**Installation:**
```bash
# From /mobile directory
npx create-expo-app@latest . --template default@sdk-55
npx expo install expo-router expo-secure-store expo-auth-session expo-web-browser
npx expo install expo-speech-recognition expo-document-picker
npx expo install react-native-reanimated react-native-gesture-handler
npx expo install react-native-safe-area-context react-native-screens
npx expo install @supabase/supabase-js @react-native-async-storage/async-storage
npm install nativewind@4 tailwindcss@^3.4.17
npm install react-native-draggable-flatlist @gorhom/bottom-sheet
```

**Version verification:** Versions above confirmed against npm registry on 2026-03-19.

---

## Architecture Patterns

### Recommended Project Structure
```
mobile/
├── app/
│   ├── _layout.tsx              # Root layout: GestureHandlerRootView + BottomSheetModalProvider + Supabase session guard
│   ├── (onboarding)/
│   │   ├── _layout.tsx          # Stack layout, no back button on first screen
│   │   ├── welcome.tsx          # Step 1
│   │   ├── phone.tsx            # Step 2
│   │   ├── verify.tsx           # Step 3 (PIN auto-advance)
│   │   ├── canvas.tsx           # Step 4 (URL entry + validate)
│   │   ├── google.tsx           # Step 5 (OAuth, skippable)
│   │   ├── tcpa.tsx             # Step 6 (consent toggle)
│   │   └── preview.tsx          # Step 7 (briefing preview)
│   ├── (home)/
│   │   ├── _layout.tsx          # Tab-less layout; home is the only "tab" — use Stack
│   │   ├── index.tsx            # 4-zone home screen
│   │   └── preferences.tsx      # Settings / connected integrations
│   └── +not-found.tsx
├── components/
│   ├── onboarding/
│   │   ├── ProgressBar.tsx
│   │   ├── PhoneInput.tsx
│   │   ├── PinInput.tsx         # 6-digit auto-advance
│   │   └── CanvasUrlInput.tsx   # URL + validate button
│   ├── home/
│   │   ├── QuickAccessBar.tsx   # Zone 1
│   │   ├── LoadStatusBar.tsx    # Zone 2 (green/yellow/red)
│   │   ├── CardGrid.tsx         # Zone 3 (draggable-flatlist)
│   │   ├── DeadlineCard.tsx     # Expanded/collapsed states
│   │   ├── PlaceholderCard.tsx  # Greyed-out unconnected integration
│   │   └── ChatBar.tsx          # Zone 4 (bottom bar + bottom-sheet)
│   └── chat/
│       ├── ChatSheet.tsx        # Full-screen chat (gorhom bottom-sheet)
│       ├── MessageBubble.tsx
│       └── VoiceButton.tsx      # Tap-start / tap-stop mic
├── lib/
│   ├── supabase.ts              # Supabase client with ExpoSecureStoreAdapter
│   ├── api.ts                   # Typed fetch wrappers to Next.js /api/* routes
│   └── theme.ts                 # Accent color constants (6 presets)
├── hooks/
│   ├── useSession.ts            # Supabase session listener
│   ├── useCards.ts              # Card data + order from canonical_events
│   └── useVoice.ts              # expo-speech-recognition state machine
├── tailwind.config.js
├── babel.config.js              # babel-preset-expo + nativewind/babel
├── metro.config.js              # withNativeWind
├── app.json                     # Expo config (bundle ID, scheme for deep links)
└── package.json
```

### Pattern 1: ExpoSecureStoreAdapter for Supabase Auth
**What:** Replaces cookie/localStorage with iOS Keychain-backed storage for Supabase sessions.
**When to use:** All mobile Supabase client initialization — never use AsyncStorage for auth tokens.
**Example:**
```typescript
// mobile/lib/supabase.ts
// Source: Supabase React Native quickstart + expo-secure-store docs
import * as SecureStore from 'expo-secure-store'
import { createClient } from '@supabase/supabase-js'

// expo-secure-store has a 2KB per-key limit.
// Split large tokens across multiple keys if needed.
const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
}

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: ExpoSecureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // must be false for native
    },
  }
)
```

### Pattern 2: Google OAuth via expo-auth-session → Supabase signInWithIdToken
**What:** Opens Google sign-in in an in-app browser, captures the ID token, passes it to Supabase.
**When to use:** Onboarding Step 5 (and "Connect Google" CTA in Preferences).
**Example:**
```typescript
// mobile/app/(onboarding)/google.tsx
// Source: Supabase login-with-google guide (native mobile section)
import * as Google from 'expo-auth-session/providers/google'
import * as WebBrowser from 'expo-web-browser'
import { supabase } from '@/lib/supabase'

WebBrowser.maybeCompleteAuthSession() // REQUIRED — must be called at module level

export function useGoogleAuth() {
  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    // webClientId required for signInWithIdToken nonce threading
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  })

  useEffect(() => {
    if (response?.type === 'success') {
      const { id_token } = response.params
      supabase.auth.signInWithIdToken({
        provider: 'google',
        token: id_token,
      })
    }
  }, [response])

  return { promptAsync, request }
}
```

**Critical:** `WebBrowser.maybeCompleteAuthSession()` MUST be called at module level (not in useEffect). Forgetting this causes OAuth redirect to hang on iOS.

### Pattern 3: Onboarding Linear Wizard Navigation
**What:** Each step is a separate screen in a Stack navigator. The stack prevents back-swiping between completed steps after PIN verification.
**When to use:** All onboarding screens.
**Example:**
```typescript
// mobile/app/(onboarding)/_layout.tsx
import { Stack } from 'expo-router'

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: false }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="phone" />
      <Stack.Screen name="verify" />
      <Stack.Screen name="canvas" />
      <Stack.Screen name="google" />
      <Stack.Screen name="tcpa" />
      <Stack.Screen name="preview" />
    </Stack>
  )
}
```

### Pattern 4: 4-Zone Home Screen Layout
**What:** A single screen with four stacked sections: top fixed bar, color bar, scrollable card area, bottom fixed chat bar.
**When to use:** Home screen (Zone 4 uses @gorhom/bottom-sheet anchored to screen bottom).
**Example:**
```typescript
// Structure — not full implementation
<SafeAreaView style={{ flex: 1 }}>
  <QuickAccessBar />        {/* Zone 1: fixed height ~56px */}
  <LoadStatusBar />         {/* Zone 2: fixed height ~44px, color-coded */}
  <CardGrid style={{ flex: 1 }} />  {/* Zone 3: DraggableFlatList */}
  <ChatBar />               {/* Zone 4: fixed bottom bar, triggers bottom-sheet */}
  <BottomSheetModal ref={sheetRef}>  {/* Full-screen chat */}
    <ChatSheet />
  </BottomSheetModal>
</SafeAreaView>
```

### Pattern 5: Voice Input State Machine
**What:** Two-tap model (tap to start, tap to stop) using expo-speech-recognition.
**When to use:** Voice button in ChatBar.
**Example:**
```typescript
// mobile/hooks/useVoice.ts
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition'

export function useVoice(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false)

  const toggle = async () => {
    if (isListening) {
      ExpoSpeechRecognitionModule.stop()
    } else {
      await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      ExpoSpeechRecognitionModule.start({ lang: 'en-US', continuous: false })
      setIsListening(true)
    }
  }

  useSpeechRecognitionEvent('result', (event) => {
    if (event.isFinal) {
      setIsListening(false)
      onResult(event.results[0]?.transcript ?? '')
    }
  })

  useSpeechRecognitionEvent('end', () => setIsListening(false))

  return { toggle, isListening }
}
```

### Anti-Patterns to Avoid
- **Using Expo Go for testing:** `expo-speech-recognition` and `expo-secure-store` require a development build. Expo Go does not support these modules. Set up EAS Build (or local `npx expo run:ios`) from day one.
- **Storing OAuth tokens in AsyncStorage:** Always use `ExpoSecureStoreAdapter` (iOS Keychain) for auth tokens. AsyncStorage is unencrypted.
- **Calling the Canvas iCal URL directly from mobile:** Mobile never hits external APIs directly. Route through `/api/sync/canvas` (Josh's backend). Canvas rate limits apply to server, not client.
- **Using `@supabase/ssr` in the mobile app:** That package is for Next.js SSR. Mobile uses `@supabase/supabase-js` directly with the ExpoSecureStoreAdapter.
- **Legacy Architecture assumptions:** SDK 55 requires New Architecture. Any library not supporting the New Architecture will not work. All libraries in the standard stack above are New Architecture compatible.
- **Nesting tabs inside tabs:** Expo Router does not support this. The 4-zone home layout is one screen with no tab navigator — use a Stack with a custom layout.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| iOS drag-to-reorder list | Custom PanGestureHandler + position tracking | `react-native-draggable-flatlist` | Handles scroll + drag interaction, item size variance, haptic feedback wiring |
| Swipe-to-reveal action on list item | Custom gesture translation + animated width | `react-native-gesture-handler` Swipeable | Handles velocity thresholds, snap-to-position, simultaneous gesture conflicts |
| Full-screen bottom sheet chat | Animated `position: absolute` + pan gesture | `@gorhom/bottom-sheet` | Handles snap points, keyboard avoiding, backdrop, gesture-driven dismiss |
| On-device speech recognition | Native module bridge to SFSpeechRecognizer | `expo-speech-recognition` | Handles permission request, result streaming, cancellation, managed workflow compatible |
| iOS Keychain storage | Direct native module calls | `expo-secure-store` | Abstract Keychain API, biometric unlock option, managed workflow compatible |
| Phone OTP send/verify | Custom Twilio Verify integration in mobile | Backend `/api/auth/phone/send` + `/api/auth/phone/verify` routes (Josh builds) | OTP logic never runs client-side; Twilio credentials never in mobile bundle |
| Accent color theming | Manual StyleSheet override per component | NativeWind CSS variables + Tailwind config | Consistent token propagation across all components from one config change |

**Key insight:** The React Native gesture and animation ecosystem (Reanimated + Gesture Handler) handles physics that are genuinely hard to replicate — velocity decay, simultaneous gesture resolution, native driver offloading. Hand-rolling drag lists or swipe actions causes janky 30fps animations that feel un-iOS-like.

---

## Common Pitfalls

### Pitfall 1: Google OAuth Nonce Mismatch on iOS
**What goes wrong:** `signInWithIdToken` throws "Passed nonce and nonce in id_token must align." Auth flow silently fails.
**Why it happens:** Google's iOS SDK omits nonces by default; Supabase expects the nonce hash in the ID token. The nonce must be generated, hashed (SHA256), passed to `expo-auth-session`, and the raw nonce passed to `signInWithIdToken`.
**How to avoid:** Use `expo-crypto` to generate and hash the nonce before the auth request:
```typescript
import * as Crypto from 'expo-crypto'
const rawNonce = Crypto.randomUUID()
const hashedNonce = await Crypto.digestStringAsync(
  Crypto.CryptoDigestAlgorithm.SHA256,
  rawNonce
)
// Pass hashedNonce to Google.useAuthRequest nonce param
// Pass rawNonce to supabase.auth.signInWithIdToken nonce param
```
**Warning signs:** Auth flow completes in browser, redirects back, but no Supabase session is created.

### Pitfall 2: expo-secure-store 2KB Per-Key Limit
**What goes wrong:** Google OAuth provider token (typically ~2800 chars) fails to store. Session silently breaks on next app launch.
**Why it happens:** iOS Keychain items have a size limit; expo-secure-store exposes this limitation.
**How to avoid:** The Supabase session object stores multiple pieces. The `provider_token` (Google's access token) is large. Split across multiple keys or omit `provider_token` from keychain storage if only using `id_token` flows.
**Warning signs:** User appears logged in, but Google-scoped API calls fail with 401 on app re-launch.

### Pitfall 3: Missing WebBrowser.maybeCompleteAuthSession()
**What goes wrong:** OAuth redirect never resolves; app appears stuck on loading screen after returning from Google sign-in.
**Why it happens:** `expo-auth-session` uses a deep link to return the auth code to the app. `maybeCompleteAuthSession()` processes that link. If not called at module level in the redirect screen, the session close event is missed.
**How to avoid:** Always call `WebBrowser.maybeCompleteAuthSession()` at the top level of the screen that handles the OAuth redirect (before the component definition, not inside useEffect).
**Warning signs:** OAuth browser closes, app re-opens, loading spinner continues indefinitely.

### Pitfall 4: No Development Build = No Native Modules
**What goes wrong:** `expo-speech-recognition` crashes with "Native module not found." Canvas URL validation via fetch works, but voice button does nothing.
**Why it happens:** Expo Go ships a fixed set of native modules. Custom native modules (including `expo-speech-recognition`) require a development build with the module compiled in.
**How to avoid:** Run `npx expo run:ios` (local) or `eas build --profile development --platform ios` from the first day of Phase 8. Never test voice or secure storage features in Expo Go.
**Warning signs:** Any import from `expo-speech-recognition` or other non-Expo-Go-compatible module.

### Pitfall 5: GestureHandlerRootView and BottomSheetModalProvider Must Wrap Root
**What goes wrong:** Gestures (swipe, drag) don't register; bottom sheet refuses to open.
**Why it happens:** `react-native-gesture-handler` v2+ requires `GestureHandlerRootView` at the app root. `@gorhom/bottom-sheet` requires `BottomSheetModalProvider` as an ancestor.
**How to avoid:** Both providers go in `mobile/app/_layout.tsx` (the root layout), not in individual screens.
**Warning signs:** Touches pass through Swipeable components; `useBottomSheetModal()` throws "context is null".

### Pitfall 6: Supabase RLS — Mobile Uses Anon Key
**What goes wrong:** Mobile Supabase queries return empty arrays even when data exists. Or mobile can read other users' data.
**Why it happens:** Mobile uses `SUPABASE_ANON_KEY` + user JWT from Supabase Auth. RLS policies must be in place and the user must be authenticated for queries to return data scoped to that user.
**How to avoid:** All `canonical_events`, `deadlines`, and `messages` tables must have RLS policies allowing `auth.uid() = user_id`. Mobile should never call any route that bypasses RLS — that is strictly the backend's service role domain.
**Warning signs:** Empty arrays from `supabase.from('canonical_events').select(*)` even after Canvas sync.

### Pitfall 7: Canvas iCal URL Validation UX
**What goes wrong:** User pastes an invalid URL, taps "Validate", gets a confusing error after a long timeout.
**Why it happens:** The actual validation is a backend operation (call `/api/sync/canvas` which tries to fetch the iCal). If the URL is wrong or the Canvas feed is rate-limited, this can take several seconds.
**How to avoid:** (1) Client-side regex check for `webcal://` or `https://` Canvas domain URL shape before sending to backend. (2) Show a spinner on "Validate" tap with a 10-second timeout. (3) Return a specific error message distinguishing "invalid URL format" vs "Canvas URL not reachable" vs "valid but empty feed".
**Warning signs:** User gets stuck on Step 4 with no feedback.

---

## Code Examples

Verified patterns from official sources:

### Root Layout with Required Providers
```typescript
// mobile/app/_layout.tsx
// Source: @gorhom/bottom-sheet docs + Expo Router root layout pattern
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { Stack } from 'expo-router'
import { useSession } from '@/hooks/useSession'

export default function RootLayout() {
  const { session, loading } = useSession()

  if (loading) return <LoadingScreen />

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BottomSheetModalProvider>
        <Stack screenOptions={{ headerShown: false }}>
          {session ? (
            <Stack.Screen name="(home)" />
          ) : (
            <Stack.Screen name="(onboarding)" />
          )}
        </Stack>
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  )
}
```

### Supabase Session Hook
```typescript
// mobile/hooks/useSession.ts
// Source: Supabase React Native quickstart
import { useEffect, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => setSession(session)
    )

    return () => subscription.unsubscribe()
  }, [])

  return { session, loading }
}
```

### 6-Digit PIN Input with Auto-Advance
```typescript
// mobile/components/onboarding/PinInput.tsx
// Pattern: 6 individual TextInput refs, focus advances on each digit
const inputs = Array(6).fill(null).map(() => useRef<TextInput>(null))

const handleChange = (text: string, index: number) => {
  setPins(prev => { const next = [...prev]; next[index] = text; return next })
  if (text && index < 5) inputs[index + 1].current?.focus()
  if (!text && index > 0) inputs[index - 1].current?.focus()
  // When all 6 filled: auto-advance to next screen
  if (text && index === 5) onComplete(pins.join('') + text)
}
```

### Card Swipe-to-Hide with react-native-gesture-handler
```typescript
// mobile/components/home/DeadlineCard.tsx
// Source: react-native-gesture-handler Swipeable docs
import { Swipeable } from 'react-native-gesture-handler'

const renderRightActions = () => (
  <TouchableOpacity onPress={onHide} style={styles.hideAction}>
    <Text style={styles.hideText}>Hide</Text>
  </TouchableOpacity>
)

return (
  <Swipeable renderRightActions={renderRightActions}>
    <CardContent {...props} />
  </Swipeable>
)
```

### TCPA Consent Toggle (Screen 6)
```typescript
// mobile/app/(onboarding)/tcpa.tsx
// Exact legal copy and default-OFF behavior per CONTEXT.md
const [hasConsent, setHasConsent] = useState(false) // MUST default to false

const handleConfirm = async () => {
  const { error } = await supabase
    .from('users')
    .update({
      preferences_json: { ...currentPrefs, has_alert_consent: hasConsent }
    })
    .eq('id', userId)
  if (!error) router.push('/(onboarding)/preview')
}

// Render: toggle with label "I agree to receive time-sensitive deadline alerts at any hour."
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Expo SDK without New Architecture | New Architecture mandatory in SDK 55 | SDK 55 (2026) | All libraries must support New Architecture; no Legacy fallback |
| Expo Go for all development | Development builds (EAS / local run) | Ongoing since 2023 | Native modules require dev build; Expo Go testing is limited |
| `@supabase/auth-helpers` | `@supabase/supabase-js` v2 direct | 2023 | auth-helpers deprecated; use direct SDK with ExpoSecureStoreAdapter |
| `getSession()` for session check | `getClaims()` or `onAuthStateChange` | 2024 | getSession() deprecated in SSR contexts; direct session listener preferred |
| Hold-to-record voice | Tap-start / tap-stop | UX preference per CONTEXT.md | Less fatiguing for longer voice inputs |
| NativeWind v2 (Babel transform) | NativeWind v4 (jsxImportSource transform) | NativeWind v4 (2024) | v4 is New Architecture compatible; v2/v3 are not |

**Deprecated/outdated:**
- `@supabase/auth-helpers`: Replaced by `@supabase/supabase-js` v2 with platform-specific adapters
- Expo Go for testing native modules: Use development builds only
- Legacy Architecture (React Native): Removed in Expo SDK 55 — any library requiring Legacy will not build

---

## Open Questions

1. **Backend routes for phone OTP (AUTH-06)**
   - What we know: Mobile needs to call a backend endpoint to trigger Twilio Verify send and check. Twilio credentials live in backend env vars, not in the mobile app.
   - What's unclear: Josh needs to build `/api/auth/phone/send` (POST: `{ phone }`) and `/api/auth/phone/verify` (POST: `{ phone, code }`) before mobile can implement Step 2-3 of onboarding. These routes are not in the existing API surface.
   - Recommendation: Flag this as a Josh dependency. Mobile can build the UI first with mock responses, then wire to real backend routes. Define the API contract in this phase's plan.

2. **Backend route for briefing preview (UI-05)**
   - What we know: Onboarding Step 7 shows the first briefing preview. This requires calling a `/api/briefing/preview` route that returns formatted briefing text.
   - What's unclear: This route does not exist yet. It's implied by AUTH-07 (welcome briefing) being complete, but a preview endpoint is distinct from sending.
   - Recommendation: Planner should include a task to define the `/api/briefing/preview` contract; Josh implements, mobile consumes.

3. **Backend route for canonical events (UI-06 card grid)**
   - What we know: Card grid reads from `canonical_events` table (built in Phase 5). CONTEXT.md notes a future `/api/events` route that Josh builds in Phase 6.
   - What's unclear: Phase 8 runs parallel to Phase 6. If `/api/events` isn't ready, the card grid cannot display real data.
   - Recommendation: Define the `/api/events` API contract between Josh and Seb early. Mobile can build with mock data, wire to real endpoint when available. Placeholder cards for unconnected integrations must be handled regardless.

4. **EAS Build setup and Apple Developer account**
   - What we know: iOS development builds require either `npx expo run:ios` (needs local Xcode) or EAS Build (cloud, needs Apple Developer account + provisioning).
   - What's unclear: Whether Seb has Xcode installed and an Apple Developer account configured.
   - Recommendation: Wave 0 of Phase 8 should include EAS Build setup and verify `npx expo run:ios` works on Seb's machine.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest + `@testing-library/react-native` (standard for Expo projects) |
| Config file | `mobile/jest.config.js` — Wave 0 creation |
| Quick run command | `cd mobile && npx jest --testPathPattern=unit` |
| Full suite command | `cd mobile && npx jest` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-06 | Phone + PIN fields render; auto-advance on 6 digits | unit | `npx jest --testPathPattern=PinInput` | ❌ Wave 0 |
| AUTH-05 | Canvas URL validated before navigation advance | unit | `npx jest --testPathPattern=CanvasUrlInput` | ❌ Wave 0 |
| AUTH-02 | Google OAuth screen renders; skip CTA fires onSkip | unit | `npx jest --testPathPattern=google` | ❌ Wave 0 |
| UI-01 | Onboarding wizard navigates forward on each step completion | unit | `npx jest --testPathPattern=onboarding` | ❌ Wave 0 |
| UI-05 | TCPA toggle defaults to OFF; confirm writes to Supabase | unit | `npx jest --testPathPattern=tcpa` | ❌ Wave 0 |
| UI-06 | 4-zone layout renders all zones | unit | `npx jest --testPathPattern=HomeScreen` | ❌ Wave 0 |
| UI-07 | ChatBar opens BottomSheet on tap | unit | `npx jest --testPathPattern=ChatBar` | ❌ Wave 0 |
| UI-08 | VoiceButton toggles isListening state | unit | `npx jest --testPathPattern=VoiceButton` | ❌ Wave 0 |
| UI-09 | Card tap changes expanded state; accent color applied | unit | `npx jest --testPathPattern=DeadlineCard` | ❌ Wave 0 |
| AUTH-03 | ExpoSecureStoreAdapter used for session storage (mock) | unit | `npx jest --testPathPattern=supabase` | ❌ Wave 0 |
| Voice E2E | Speech recognition on real device | manual-only | Requires physical iOS device + SFSpeechRecognizer | N/A |
| Google OAuth E2E | Full OAuth redirect flow | manual-only | Requires physical device + Google account | N/A |

**Note:** Voice recognition (UI-08) and Google OAuth (AUTH-02) end-to-end flows cannot be tested in CI (require physical device and real OAuth). Unit tests cover the state machine and UI layer only.

### Sampling Rate
- **Per task commit:** `cd mobile && npx jest --testPathPattern=<component>`
- **Per wave merge:** `cd mobile && npx jest`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `mobile/jest.config.js` — Jest configuration for Expo React Native
- [ ] `mobile/jest.setup.js` — Mock expo modules (expo-speech-recognition, expo-secure-store)
- [ ] `mobile/__mocks__/expo-secure-store.ts` — Mock for ExpoSecureStoreAdapter tests
- [ ] `mobile/__mocks__/@supabase/supabase-js.ts` — Mock Supabase client
- [ ] Framework install: `cd mobile && npm install --save-dev jest @testing-library/react-native jest-expo`

---

## Sources

### Primary (HIGH confidence)
- Expo SDK 55 changelog — https://expo.dev/changelog/sdk-55 — New Architecture requirement, React Native 0.83, Expo Router v4 features
- Expo Router installation docs — https://docs.expo.dev/router/installation/ — Required packages and setup
- Expo speech-recognition GitHub — https://github.com/jamsch/expo-speech-recognition — iOS SFSpeechRecognizer integration
- npm registry — verified: expo@55.0.8, expo-router@55.0.7, react-native@0.84.1, expo-speech-recognition@3.1.1, react-native-draggable-flatlist@4.0.3, @gorhom/bottom-sheet@5.2.8, nativewind@4.2.3

### Secondary (MEDIUM confidence)
- Supabase React Native quickstart — https://supabase.com/docs/guides/auth/quickstarts/react-native — Supabase Auth setup, ExpoSecureStoreAdapter pattern
- Expo Supabase integration guide — https://docs.expo.dev/guides/using-supabase/ — Storage and deep link configuration
- NativeWind v4 installation — https://www.nativewind.dev/docs/getting-started/installation — New Architecture compatibility, Tailwind v3 requirement
- Google OAuth nonce mismatch — community discussions (GitHub orgs/supabase/discussions/27618) — verified pattern via multiple sources

### Tertiary (LOW confidence — flagged for validation)
- expo-secure-store 2KB limit workaround strategies — community discussions only; no official Expo docs confirm the split-key approach. Validate before implementing.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all package versions verified against npm registry 2026-03-19; Expo SDK 55 officially released
- Architecture: HIGH — Expo Router, Supabase Auth, and gesture handler patterns from official docs
- Pitfalls: MEDIUM-HIGH — nonce mismatch and maybeCompleteAuthSession confirmed by multiple community sources and Supabase discussions; 2KB limit is LOW (community only)
- Voice library (expo-speech-recognition): MEDIUM — library exists and is maintained but is third-party, not first-party Expo; @react-native-voice is the alternative if issues arise

**Research date:** 2026-03-19
**Valid until:** 2026-04-18 (stable ecosystem — Expo SDK 55 just released, unlikely to update mid-cycle)
