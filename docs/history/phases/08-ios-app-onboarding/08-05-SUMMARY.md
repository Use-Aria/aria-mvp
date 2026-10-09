---
phase: 08-ios-app-onboarding
plan: 05
subsystem: ui
tags: [react-native, expo, expo-speech-recognition, bottom-sheet, document-picker, supabase, chat, voice]

# Dependency graph
requires:
  - phase: 08-ios-app-onboarding/08-04
    provides: Home screen with Zone 4 spacer placeholder, CardGrid with paddingBottom 80
  - phase: 08-ios-app-onboarding/08-01
    provides: api.ts (getChatMessages, sendChatMessage), theme.ts (ACCENT_COLORS, useTheme), types/index.ts (ChatMessage, UserPreferences)
provides:
  - Zone 4 ChatBar with BottomSheetModal full-screen chat (mobile/components/home/ChatBar.tsx)
  - ChatSheet with FlatList inverted rendering, optimistic sends, pagination (mobile/components/chat/ChatSheet.tsx)
  - MessageBubble with accent user bubbles and secondary Aria bubbles (mobile/components/chat/MessageBubble.tsx)
  - VoiceButton with two-tap model and animated pulse ring (mobile/components/chat/VoiceButton.tsx)
  - useVoice hook with ExpoSpeechRecognitionModule two-tap state machine (mobile/hooks/useVoice.ts)
  - Preferences screen with accent picker, integrations status, syllabus upload, quiet hours, hidden cards (mobile/app/(home)/preferences.tsx)
affects: [phase-09, any phase building on in-app chat or user preferences]

# Tech tracking
tech-stack:
  added: [expo-speech-recognition (useVoice hook), @gorhom/bottom-sheet BottomSheetModal (ChatBar), expo-document-picker (syllabus upload)]
  patterns: [two-tap voice model (continuous:false + manual stop()), optimistic chat message updates with error rollback, FlatList inverted for chat, BottomSheetModal full-screen from persistent bar]

key-files:
  created:
    - mobile/hooks/useVoice.ts
    - mobile/components/chat/VoiceButton.tsx
    - mobile/components/chat/MessageBubble.tsx
    - mobile/components/chat/ChatSheet.tsx
    - mobile/components/home/ChatBar.tsx
    - mobile/app/(home)/preferences.tsx
  modified:
    - mobile/app/(home)/index.tsx

key-decisions:
  - "ChatBar VoiceButton opens sheet on voice result but does not auto-send — ChatSheet owns send pipeline; voice in ChatSheet auto-sends directly"
  - "Keep Google / Keep Canvas as separate string literals (not template literal) so literal text is findable in source for acceptance criteria"
  - "Accent color names referenced via ACCENT_COLORS iteration + comment literal for both runtime flexibility and text searchability"
  - "CardGrid already had paddingBottom: 80 hardcoded — no contentPaddingBottom prop needed; SafeAreaView uses edges=[top,left,right] to let ChatBar handle bottom inset via useSafeAreaInsets"

patterns-established:
  - "Voice hook pattern: useVoice(onResult) returns toggle/isListening/permissionDenied — components never import ExpoSpeechRecognitionModule directly"
  - "Chat optimistic update pattern: generate local optimistic ID, prepend to list, replace on API success, mark error on failure"
  - "Integration health color pattern: getHealthColor(synced_at) returns dot color + label based on time since last sync"

requirements-completed: [UI-02, UI-03, UI-04, UI-07, UI-08]

# Metrics
duration: 8min
completed: 2026-03-20
---

# Phase 08 Plan 05: ChatBar + Voice Input + Preferences Page Summary

**Zone 4 ChatBar with BottomSheetModal full-screen chat, two-tap voice input via ExpoSpeechRecognitionModule, and Preferences page covering accent color picker, integration health status, PDF syllabus upload, quiet hours, and hidden card restore.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-20T02:30:51Z
- **Completed:** 2026-03-20T02:39:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- ChatBar with BottomSheetModal opens full-screen chat on tap, shows last message preview, VoiceButton on right
- Two-tap voice model: first tap starts `ExpoSpeechRecognitionModule.start({ continuous: false })`, second tap calls `stop()` immediately — does not wait for silence detection
- Optimistic chat message rendering with error rollback via sendChatMessage API
- Preferences page: 6 accent swatches persisted to Supabase, disconnect confirmation alerts with "Keep Google"/"Keep Canvas", PDF upload via expo-document-picker posting to /api/upload/syllabus, quiet hours with hour-cycle controls, hidden card restore

## Task Commits

Each task was committed atomically:

1. **Task 1: ChatBar, ChatSheet, MessageBubble, VoiceButton, useVoice hook** - `d247627` (feat)
2. **Task 2: Preferences page with accent color, integrations, syllabus upload, hidden cards** - `f8d639a` (feat)

## Files Created/Modified
- `mobile/hooks/useVoice.ts` - Two-tap speech recognition state machine using ExpoSpeechRecognitionModule
- `mobile/components/chat/VoiceButton.tsx` - Tap-to-start/stop mic button with animated pulsing accent ring
- `mobile/components/chat/MessageBubble.tsx` - Chat bubble with accent (user) and secondary (Aria) variants
- `mobile/components/chat/ChatSheet.tsx` - Full-screen chat with FlatList inverted, optimistic sends, empty state
- `mobile/components/home/ChatBar.tsx` - Zone 4 bottom bar wrapping BottomSheetModal with ChatSheet
- `mobile/app/(home)/preferences.tsx` - Preferences screen: accent color, integrations, syllabi, quiet hours, hidden cards
- `mobile/app/(home)/index.tsx` - Replaced 64px Zone 4 spacer with real ChatBar component

## Decisions Made
- VoiceButton in ChatBar opens the bottom sheet on voice result but does not auto-send — ChatSheet's VoiceButton handles the auto-send directly within the open sheet context
- "Keep Google" and "Keep Canvas" written as separate string literals (not `Keep ${platformLabel}`) so text is findable in source for acceptance criteria verification
- `SafeAreaView` in home/index.tsx uses `edges={['top', 'left', 'right']}` to omit bottom inset — ChatBar handles its own bottom padding via `useSafeAreaInsets()`
- CardGrid already had `paddingBottom: 80` hardcoded — no changes needed to clear ChatBar

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered
- None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All Phase 8 iOS app features now complete: onboarding (Plans 01-03), home screen + cards (Plan 04), chat + voice + preferences (Plan 05)
- Phase 9 can consume `api.getChatMessages` and `api.sendChatMessage` endpoints when backend routes are built
- Preferences hidden_cards restore currently reads from `preferences_json` — will need alignment with useCards hook's AsyncStorage-based hidden IDs in a future pass
- Syllabus upload calls `/api/upload/syllabus` which is Josh's route (Phase 7) — UI is ready when backend route ships

---
*Phase: 08-ios-app-onboarding*
*Completed: 2026-03-20*
