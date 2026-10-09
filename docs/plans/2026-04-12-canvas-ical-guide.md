# Canvas iCal URL Guide — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce friction for users entering their Canvas iCal URL by adding an in-app guide (3 steps) and a "Open Canvas" button that launches `https://yale.instructure.com/profile/settings#feed_holder` in an in-app browser so users can copy their URL directly.

**Architecture:** The guide + button are added inline to the Canvas card in `tools.tsx`, rendered only when the Canvas connection status is not `valid` (hidden once connected). `WebBrowser.openBrowserAsync` is already imported in `tools.tsx` for the Google OAuth flow — no new dependencies needed. `CanvasUrlInput` component is unchanged.

**Tech Stack:** React Native / Expo, `expo-web-browser` (already installed), `@testing-library/react-native`

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `mobile/app/(onboarding)/tools.tsx` | **Modify** | Add `CanvasGuideSection` inline — 3-step callout + "Open Canvas" button, rendered when `canvasStatus !== 'valid'` |
| `mobile/__tests__/onboarding.test.tsx` | **Modify** | Add Tools screen describe block: guide visibility, button press, hidden when connected |

---

## Task 1: Write failing tests for the Canvas guide

**Files:**
- Modify: `mobile/__tests__/onboarding.test.tsx`

The test file already mocks `supabase`, `expo-router`, `@/lib/theme`, and `@/lib/api`. You need to add mocks for `expo-web-browser`, `expo-document-picker`, and `@/components/onboarding/CanvasUrlInput` + `@/components/onboarding/ProgressBar`. Add a new `describe` block for the Tools screen.

- [ ] **Step 1: Add missing mocks at the top of the test file** (after existing mocks, before any imports of screen components)

```typescript
// Mock expo-web-browser
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
}))

// Mock expo-document-picker
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}))

// Mock ProgressBar (no-op)
jest.mock('@/components/onboarding/ProgressBar', () => () => null)

// Mock CanvasUrlInput — renders a simple TextInput + Validate button for test control
jest.mock('@/components/onboarding/CanvasUrlInput', () => {
  const { TextInput, TouchableOpacity, Text } = require('react-native')
  return function MockCanvasUrlInput({
    value,
    onChangeText,
    onValidate,
    status,
  }: {
    value: string
    onChangeText: (t: string) => void
    onValidate: () => void
    status: string
  }) {
    if (status === 'valid') {
      return <Text>Connected</Text>
    }
    return (
      <>
        <TextInput
          testID="canvas-url-input"
          value={value}
          onChangeText={onChangeText}
        />
        <TouchableOpacity testID="canvas-validate-btn" onPress={onValidate}>
          <Text>Validate</Text>
        </TouchableOpacity>
      </>
    )
  }
})
```

- [ ] **Step 2: Add the api mock entries for Canvas validation**

The existing `@/lib/api` mock only has `saveProfile`. Extend it:

```typescript
jest.mock('@/lib/api', () => ({
  API_BASE: 'http://localhost:3000',
  api: {
    saveProfile: jest.fn(),
    validateCanvasUrl: jest.fn(),
  },
}))
```

- [ ] **Step 3: Add the Tools screen describe block**

Add after the last existing describe block in `mobile/__tests__/onboarding.test.tsx`:

```typescript
// ── Tools screen ─────────────────────────────────────────────────────────────

import Tools from '@/app/(onboarding)/tools'
import * as WebBrowser from 'expo-web-browser'
const mockOpenBrowser = WebBrowser.openBrowserAsync as jest.Mock
const mockValidateCanvasUrl = (api as { validateCanvasUrl: jest.Mock }).validateCanvasUrl

describe('Tools screen — Canvas guide', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders the 3-step Canvas guide when not yet connected', () => {
    const { getByText } = render(<Tools />)
    expect(getByText(/step 1/i)).toBeTruthy()
    expect(getByText(/step 2/i)).toBeTruthy()
    expect(getByText(/step 3/i)).toBeTruthy()
  })

  it('renders the "Open Canvas" button when not yet connected', () => {
    const { getByText } = render(<Tools />)
    expect(getByText('Open Canvas')).toBeTruthy()
  })

  it('tapping "Open Canvas" calls openBrowserAsync with Yale settings URL', async () => {
    mockOpenBrowser.mockResolvedValue(undefined)
    const { getByText } = render(<Tools />)
    fireEvent.press(getByText('Open Canvas'))
    await waitFor(() => {
      expect(mockOpenBrowser).toHaveBeenCalledWith(
        'https://yale.instructure.com/profile/settings#feed_holder',
      )
    })
  })

  it('hides the guide and "Open Canvas" button when Canvas is connected', async () => {
    mockValidateCanvasUrl.mockResolvedValue({ deadline_count: 5, sample_courses: [] })
    const { getByTestId, queryByText } = render(<Tools />)
    fireEvent.changeText(getByTestId('canvas-url-input'), 'https://yale.instructure.com/feeds/calendars/user_abc.ics')
    fireEvent.press(getByTestId('canvas-validate-btn'))
    await waitFor(() => {
      expect(queryByText(/step 1/i)).toBeNull()
      expect(queryByText('Open Canvas')).toBeNull()
    })
  })
})
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --verbose 2>&1 | tail -30
```

Expected: Tests in `Tools screen — Canvas guide` fail with "unable to find element" or similar. All previously passing tests (11) still pass.

- [ ] **Step 5: Commit failing tests**

```bash
cd mobile && git add __tests__/onboarding.test.tsx
git commit -m "test(tools): add failing tests for Canvas iCal guide + Open Canvas button"
```

---

## Task 2: Implement the Canvas guide in tools.tsx

**Files:**
- Modify: `mobile/app/(onboarding)/tools.tsx`

`WebBrowser` is already imported. Add a `handleOpenCanvas` function and a guide section rendered inside the Canvas card, above `<CanvasUrlInput>`, visible only when `canvasStatus !== 'valid'`.

- [ ] **Step 1: Add `handleOpenCanvas` function**

Add after `handleCanvasValidate` (around line 157), before `handleSyllabusPick`:

```typescript
const handleOpenCanvas = async () => {
  await WebBrowser.openBrowserAsync(
    'https://yale.instructure.com/profile/settings#feed_holder',
  )
}
```

- [ ] **Step 2: Add the guide section inside the Canvas card**

Find the Canvas card's `<CanvasUrlInput ... />` block (around line 286). Replace it with:

```tsx
{canvasStatus !== 'valid' && (
  <View style={{ marginBottom: 16 }}>
    {/* 3-step guide */}
    {[
      'Step 1: Tap "Open Canvas" below',
      'Step 2: Scroll to "Calendar Feed" and tap the link',
      'Step 3: Copy the URL and paste it here',
    ].map((step) => (
      <View key={step} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 }}>
        <Text style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 20 }}>
          {step}
        </Text>
      </View>
    ))}

    {/* Open Canvas button */}
    <TouchableOpacity
      onPress={handleOpenCanvas}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: accent,
        borderRadius: 10,
        height: 40,
        marginTop: 10,
        gap: 6,
      }}
    >
      <Ionicons name="open-outline" size={16} color={accent} />
      <Text style={{ fontSize: 14, fontWeight: '600', color: accent }}>Open Canvas</Text>
    </TouchableOpacity>

    {/* Divider */}
    <View style={{ height: 1, backgroundColor: colors.cardBorder, marginVertical: 16 }} />
  </View>
)}
<CanvasUrlInput
  value={canvasUrl}
  onChangeText={(text) => {
    setCanvasUrl(text)
    if (canvasStatus !== 'idle') setCanvasStatus('idle')
  }}
  onValidate={handleCanvasValidate}
  status={canvasStatus}
  errorMessage={canvasError}
/>
```

- [ ] **Step 3: Run tests**

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --verbose 2>&1 | tail -30
```

Expected: All tests pass, including the 4 new Tools screen tests. Total should be 15 tests passing.

- [ ] **Step 4: Run lint**

```bash
cd /Users/daniellee/Code/aria-mvp && npm run lint 2>&1 | tail -20
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniellee/Code/aria-mvp
git add mobile/app/(onboarding)/tools.tsx mobile/__tests__/onboarding.test.tsx
git commit -m "feat(onboarding): add Canvas iCal guide + Open Canvas button to tools screen"
```

---

## Self-Review

### Spec coverage
- [x] Option A: "Open Canvas" button → `handleOpenCanvas` → `WebBrowser.openBrowserAsync` with resolved Canvas domain + `/calendar`
- [x] Option B: 3-step inline guide rendered above the URL input
- [x] Guide + button hidden once Canvas is connected (`canvasStatus === 'valid'`)
- [x] No backend changes needed

### Post-plan amendments (2026-04-12)
- **"Open Canvas" domain resolution:** No longer hardcoded to Yale. Priority: (1) extract origin from typed iCal URL, (2) lookup `university` from `users` table via `canvasDomainForUniversity()` in `lib/universities.ts`, (3) null → button disabled with hint text. Yale URL updated from `/profile/settings#feed_holder` to `/calendar` (direct calendar page).
- **Guide steps updated:** 3 steps reflecting correct Canvas navigation (Tap Open Canvas → scroll to Calendar Feed → copy and paste URL).
- **University picker:** Profile screen now uses `UniversityPicker` component (searchable modal) instead of a TextInput, ensuring `university` values are always from the known list in `lib/universities.ts`.
- **Syllabus upload removed:** Removed from tools screen. Will be post-onboarding settings flow.
- **Todoist + iOS Reminders added:** Coming-soon cards in the optional section.

### Placeholder scan
- No TBDs, no "similar to Task N", all code blocks complete.

### Type consistency
- `handleOpenCanvas` is `async () => void` — consistent with `handleConnectGoogle` pattern already in the file.
- `canvasStatus` type `CanvasStatus = 'idle' | 'validating' | 'valid' | 'error'` — used correctly in guard condition `canvasStatus !== 'valid'`.
- Mock for `CanvasUrlInput` renders `<Text>Connected</Text>` when `status === 'valid'` — matches the real component's valid state output exactly.
