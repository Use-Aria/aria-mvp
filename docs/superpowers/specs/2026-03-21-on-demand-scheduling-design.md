# Design Spec: On-Demand Scheduling with Activity Intelligence

**Date:** 2026-03-21
**Feature:** Phase 4 enhancement — on-demand scheduling via SMS
**Status:** Approved by user

---

## Problem

Aria currently generates study block suggestions automatically on Monday briefings, but has no way to respond to on-demand scheduling requests via SMS. If a student texts "find me time to study chem tomorrow", Aria treats it as off-topic. All scheduling logic (slot-finding, calendar writeback) is already built — it just isn't reachable from the conversational SMS layer.

---

## Solution Overview

Add a `schedule` intent to the SMS reply handler that:
1. Recognizes any activity scheduling request
2. Looks up (or asks for) the student's preferred time for that activity type
3. Finds the best free slot on the requested date
4. Asks for confirmation before booking
5. Books the calendar event and silently learns from what the student confirmed

---

## Conversation Flows

### Flow A — First time (no preference on file)
```
Student: "find me time to workout tomorrow"
Aria:    "When do you usually like to work out — morning, afternoon, or evening?"
Student: "morning"
Aria:    "Got it! Best window tomorrow morning is 7–9am. Should I add it?"
Student: "yes"
Aria:    "Done — workout block added for 7–9am tomorrow."
```

### Flow B — Known preference
```
Student: "can you schedule 2 hours to study for my biochem exam tomorrow"
Aria:    "Best window tomorrow evening is 8–10pm. Should I add it?"
Student: "yes"
Aria:    "Done — Biochem Study added for 8–10pm tomorrow."
```

### Flow C — No slot available
```
Student: "find me time to study tonight"
Aria:    "Your calendar is fully booked tonight. Want me to check tomorrow instead?"
```

### Flow D — Student declines suggested slot
```
Aria:    "Best window is 8–10pm tonight. Should I add it?"
Student: "no, find something earlier"
Aria:    "Next best is 3–5pm this afternoon. Should I add that instead?"
```

---

## Data Model

### `preferences_json` extension (existing column on `users` table)

No schema migration needed. The existing `preferences_json` JSONB column is extended with a new `activity_preferences` key:

```json
{
  "study_preference": "evening",
  "activity_preferences": {
    "study":   { "preference": "evening", "confirmations": 4 },
    "workout": { "preference": "morning", "confirmations": 2 },
    "meal":    { "preference": "afternoon", "confirmations": 1 }
  }
}
```

- `preference`: current inferred time-of-day preference for this activity type
- `confirmations`: count of slots confirmed by the student for this activity type

**Preference learning rule:** After each confirmation, increment `confirmations`. Track the last 3 confirmed time-of-day blocks. If all 3 differ from `preference`, update `preference` silently (no announcement to student).

### Redis pending schedule state

Redis is already running for Celery. Pending confirmation state is stored as:

```
Key:   aria:pending_schedule:{user_id}
Value: JSON { activity_type, subject, title, start, end, alternative_slots[] }
TTL:   300 seconds (5 minutes)
```

`alternative_slots` holds up to 2 runner-up slots for Flow D (student declines).

---

## Intent Schema

The existing `INTENT_SYSTEM_PROMPT` in `replies.py` is extended with a new `schedule` action and additional fields:

```json
{
  "action": "schedule",
  "activity_type": "<normalized category: study | workout | meal | personal | [any]>",
  "subject": "<what specifically, e.g. 'biochem exam', 'chest day', or null>",
  "target_date_string": "<natural language date: 'tomorrow', 'Friday', 'tonight', etc.>",
  "duration_hours": <integer, e.g. 2, or null to use activity default>
}
```

**Activity type normalization rules for the classifier:**
- "study", "review", "homework", "exam prep" → `study`
- "workout", "gym", "run", "lift", "exercise" → `workout`
- "lunch", "dinner", "breakfast", "eat", "meal" → `meal`
- Anything else → pass through as-is (lowercase, single word)

**Duration defaults (used when `duration_hours` is null):**
- `study` → 2 hours
- `workout` → 1 hour
- `meal` → 1 hour
- all others → 1 hour

---

## New File: `celery_worker/sms/schedule.py`

Owns all scheduling-specific logic. Keeps `replies.py` clean.

### Exported functions

**`get_activity_preference(user_id, activity_type) -> str | None`**
Returns stored preference for this activity type, or `None` if unseen.

**`set_activity_preference(user_id, activity_type, preference) -> None`**
Stores preference in `preferences_json.activity_preferences`.

**`learn_from_confirmation(user_id, activity_type, confirmed_start_iso) -> None`**
Called after a slot is confirmed. Increments confirmation count. If last 3 confirmed time-of-day blocks all differ from stored preference, updates it.

**`store_pending(user_id, data: dict) -> None`**
Stores pending schedule dict in Redis with 5-minute TTL.

**`get_pending(user_id) -> dict | None`**
Retrieves pending schedule from Redis. Returns `None` if expired or absent.

**`clear_pending(user_id) -> None`**
Removes pending schedule key from Redis.

**`parse_target_date(date_string: str, user_tz: str) -> datetime | None`**
Parses natural language date strings using `dateparser`. Returns timezone-aware datetime at midnight in user's timezone, or `None` on failure.

**`handle_schedule_request(user_id, activity_type, subject, target_date_string, duration_hours) -> str`**
Main entry point called from `replies.py`. Orchestrates the full flow:
1. Get/ask for preference
2. Find free slots via `gcal.slots.find_free_slots`
3. Store pending in Redis
4. Return confirmation prompt string

**`handle_schedule_confirmation(user_id) -> str`**
Called when a pending schedule exists and student replies "yes" (or equivalent). Books the event via `gcal.writeback.create_study_block`, calls `learn_from_confirmation`, clears pending, returns confirmation string.

**`handle_schedule_decline(user_id) -> str`**
Called when student declines. Returns the next alternative slot from `pending.alternative_slots` and updates pending with new proposed slot.

---

## Changes to `replies.py`

### 1. INTENT_SYSTEM_PROMPT — add `schedule` action

Add `schedule` to the action enum and document the new fields (`activity_type`, `subject`, `target_date_string`, `duration_hours`).

Also add `set_preference` action for when student answers the "morning/afternoon/evening?" question:
```json
{
  "action": "set_preference",
  "activity_type": "workout",
  "preference": "morning"
}
```

### 2. `handle_reply()` — two new early-exit checks (before intent extraction)

**Check 1 — Pending confirmation intercept:**
Before calling Claude for intent, check Redis for a pending schedule. If found, check if the message is an affirmative (`yes`, `sure`, `ok`, `yeah`, `yep`, `add it`, `confirm`) or negative (`no`, `nope`, `skip`, `cancel`, `different`, `earlier`, `later`). Route to `handle_schedule_confirmation` or `handle_schedule_decline` without burning an intent Claude call.

**Check 2 — Preference answer intercept (already exists for study_preference):**
Extend the existing `_handle_study_preference_reply` into the new `set_activity_preference` flow. If a `set_preference_pending` key exists in Redis for this user, capture the answer and proceed to slot-finding.

### 3. `handle_reply()` — `schedule` branch in the action router

After intent extraction, add a `schedule` branch that calls `handle_schedule_request(...)`.

---

## Dependencies

| Package | Purpose | Already in requirements.txt? |
|---|---|---|
| `dateparser` | Natural language date parsing | No — add |
| `redis` | Pending state storage | Yes (Celery uses it) |

---

## Files Changed

| File | Change type |
|---|---|
| `celery_worker/sms/schedule.py` | New |
| `celery_worker/ai/replies.py` | Modified (intent prompt + handler routing) |
| `requirements.txt` | Add `dateparser>=1.2.0` |

**Untouched (reused as-is):**
- `celery_worker/gcal/slots.py` — `find_free_slots()`
- `celery_worker/gcal/writeback.py` — `schedule_study_block()`, `create_study_block()`
- `celery_worker/gcal/db.py` — `get_calendar_events()`

---

## Error Cases

| Scenario | Aria's response |
|---|---|
| No Google Calendar connected | "You'll need to connect Google Calendar first — head to Preferences in the app." |
| No free slot found on requested date | "Your calendar is fully booked [date]. Want me to check tomorrow instead?" |
| `dateparser` can't parse the date | "What date did you have in mind? Try something like 'tomorrow' or 'Friday'." |
| Pending expires before student replies | Treat next message as fresh — no error surfaced |
| Student asks to reschedule (Flow D) and no more alternatives | "No other slots available [date] — want me to check a different day?" |

---

## Testing

New tests in `celery_worker/tests/sms/test_schedule.py`:

- `test_parse_target_date_tomorrow` — verifies tomorrow resolves to correct date in user tz
- `test_get_activity_preference_unknown` — returns None for unseen activity type
- `test_set_and_get_activity_preference` — round-trip through preferences_json
- `test_learn_from_confirmation_updates_preference` — 3 consecutive different-block confirmations flip the stored preference
- `test_handle_schedule_confirmation_books_event` — mocks GCal writeback, verifies event created and pending cleared
- `test_pending_affirmative_variants` — "yes", "sure", "yep", "add it" all trigger confirmation
- `test_pending_negative_variants` — "no", "nope", "skip" all trigger decline
- `test_no_free_slot_response` — verify correct message when calendar is full
