# App Store Submission Checklist

Track everything needed to get Aria live on the App Store.

---

## 1. Backend Deployment

- [ ] Deploy Next.js API to Vercel
- [ ] Deploy Celery workers to Railway
- [ ] Deploy Redis to Railway
- [ ] Set all production environment variables in Vercel (Supabase, Twilio, Google OAuth, Anthropic)
- [ ] Set all production environment variables in Railway
- [ ] Verify `/api/health` endpoint returns 200 in production
- [ ] Test Twilio webhook is reachable from Twilio dashboard (not localhost)
- [ ] Test Google OAuth callback URL updated to production domain

---

## 2. iOS App Config (`mobile/app.json`)

- [ ] Add Apple Developer Team ID to `ios.appleTeamId`
- [ ] Add microphone privacy string: `NSMicrophoneUsageDescription`
- [ ] Add speech recognition privacy string: `NSSpeechRecognitionUsageDescription`
- [ ] Fix iOS icon path (currently `./assets/expo.icon` — verify this works with EAS or replace with `./assets/images/icon.png`)
- [ ] Set `ios.buildNumber` to `"1"`

---

## 3. EAS Build Setup (`mobile/eas.json`)

- [ ] Create `eas.json` with `preview` and `production` build profiles
- [ ] Run `eas build --platform ios --profile preview` and confirm it succeeds
- [ ] Fix any build errors before moving to production profile

Example `eas.json`:
```json
{
  "cli": { "version": ">= 10.0.0" },
  "build": {
    "preview": {
      "distribution": "internal",
      "ios": { "simulator": false }
    },
    "production": {
      "ios": { "buildConfiguration": "Release" }
    }
  },
  "submit": {
    "production": {}
  }
}
```

---

## 4. TestFlight Testing

- [ ] Upload preview build to TestFlight via `eas submit` or Transporter
- [ ] Install on physical iPhone and test full onboarding flow
- [ ] Test Canvas URL entry and welcome briefing SMS
- [ ] Test Google OAuth connects and GCal syncs
- [ ] Test Todoist OAuth connect/disconnect
- [ ] Test in-app chat sends and receives replies
- [ ] Test voice input transcribes and sends
- [ ] Test syllabus PDF upload in Preferences
- [ ] Verify daily briefing SMS arrives at 8am
- [ ] Test STOP / PAUSE / HELP SMS commands
- [ ] Invite at least 2 Yale beta testers via TestFlight

---

## 5. App Store Connect Setup

- [ ] Create app record in App Store Connect (bundle ID: `com.aria.mobile`)
- [ ] Write app description (call out Canvas, SMS briefings, no new app to open)
- [ ] Add keywords (student, AI assistant, Canvas, deadlines, planner)
- [ ] Upload screenshots — required sizes:
  - [ ] 6.7" iPhone (iPhone 15 Pro Max)
  - [ ] 6.1" iPhone (iPhone 15)
- [ ] Set age rating (likely 4+)
- [ ] Add support URL
- [ ] Add privacy policy URL (required — app collects phone number + OAuth tokens)
- [ ] Answer App Privacy questionnaire (data types: contact info, identifiers, usage data)

---

## 6. Legal / Compliance (required before launch)

- [ ] Publish Privacy Policy (covers TCPA, SMS consent, OAuth token storage, 30-day deletion)
- [ ] Publish Terms of Service
- [ ] Confirm SMS opt-in consent language is visible during onboarding (TCPA)
- [ ] Confirm phone numbers are hashed in all server logs

---

## 7. Submit for Review

- [ ] Run `eas build --platform ios --profile production`
- [ ] Submit to App Store via `eas submit --platform ios`
- [ ] Fill out export compliance (uses HTTPS — answer Yes to encryption, standard)
- [ ] Submit for Apple review
- [ ] Address any rejection feedback from Apple

---

## Status

| Area | Status |
|------|--------|
| Backend deployment | ⬜ Not started |
| app.json fixes | ⬜ Not started |
| eas.json created | ⬜ Not started |
| TestFlight build | ⬜ Not started |
| App Store listing | ⬜ Not started |
| Legal docs | ⬜ Not started |
| Submitted for review | ⬜ Not started |
