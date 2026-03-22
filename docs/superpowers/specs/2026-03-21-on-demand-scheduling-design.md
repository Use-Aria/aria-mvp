# Design Spec: On-Demand Scheduling with Activity Intelligence

**Date:** 2026-03-21
**Feature:** Phase 4 enhancement — on-demand scheduling via SMS
**Status:** Approved by user, reviewed and updated

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
Aria:    "Your calendar's fully booked tonight — text me 'find time to study [subject] tomorrow' if you'd like me to check then."
```

### Flow D — Student declines suggested slot
```
Aria:    "Best window is 8–10pm tonight. Should I add it?"
Student: "no, find something earlier"
Aria:    "Next best is 3–5pm this afternoon. Should I add that instead?"
```

### Flow E — No more alternatives
```
Aria:    "Next best is 3–5pm this afternoon. Should I add that instead?"
Student: "no"
Aria:    "No other slots available today — text me 'find time to [activity] tomorrow' to check a different day."
```

---

## Data Model

### `preferences_json` extension (existing column on `users` table)

No schema migration needed. The existing `preferences_json` JSONB column is extended:

```json
{
  "study_preference": "evening",
  "timezone": "America/New_York",
  "activity_preferences": {
    "study": {
      "preference": "evening",
      "confirmations": 4,
      "recent_blocks": ["evening", "evening", "afternoon"]
    },
    "workout": {
      "preference": "morning",
      "confirmations": 2,
      "recent_blocks": ["morning", "morning"]
    }
  }
}
```

- `preference`: current time-of-day preference (`morning` / `afternoon` / `evening`)
- `confirmations`: total count of confirmed bookings (informational)
- `recent_blocks`: rolling list of last 3 confirmed time-of-day blocks (oldest first)

**User timezone:** Read from `preferences_json.timezone`. Default: `"America/New_York"` if absent.

**Preference learning rule:** On each confirmation, compute time-of-day block (morning = 7–11, afternoon = 12–16, evening = 17–22, before 7am = evening). Append to `recent_blocks`, trim to last 3. If all 3 entries agree and differ from `preference`, update `preference` silently.

### Redis pending schedule state

```
Key:   aria:pending_schedule:{user_id}
Value: JSON { activity_type, subject, title, start, end, alternative_slots[] }
TTL:   300 seconds (5 minutes)
```

`alternative_slots` holds up to 2 runner-up slots for Flow D/E.

### Redis pending preference state (Flow A)

```
Key:   aria:pending_preference:{user_id}
Value: JSON { activity_type, original_request }
TTL:   300 seconds (5 minutes)
```

Stores context while waiting for the student's morning/afternoon/evening answer.

---

## Intercept Order in `handle_reply()`

These checks run **before** Claude is called, in this exact order:

1. **`aria:pending_preference:{user_id}` check** — if present, student is answering "morning/afternoon/evening?". Capture answer, store preference, clear key, resume scheduling. Return result. Do not fall through.

2. **`aria:pending_schedule:{user_id}` check** — if present, check against affirmative/negative lists. Match → route to confirmation or decline. No match → fall through to step 3 with pending key still alive (NOT consumed).

3. **Existing `_handle_study_preference_reply` check** — runs only when both Redis keys are absent.

4. **Claude intent extraction** — runs only when all 3 checks return None.

**Affirmatives** (case-insensitive): `yes`, `sure`, `ok`, `okay`, `yeah`, `yep`, `yup`, `add it`, `confirm`, `sounds good`, `do it`, `go ahead`, `book it`

**Negatives**: `no`, `nope`, `skip`, `cancel`, `different`, `earlier`, `later`, `another`

---

## Intent Schema

`INTENT_SYSTEM_PROMPT` is extended with `schedule` action. **No `set_preference` action is added** — preference answers are handled entirely by the Redis intercept above.

```json
{
  "action": "schedule",
  "activity_type": "<study | workout | meal | personal | [any lowercase]>",
  "subject": "<specific topic or null>",
  "target_date_string": "<'tomorrow', 'Friday', 'tonight', etc.>",
  "duration_hours": "<integer or null>"
}
```

**Activity type normalization:**
- "study", "review", "homework", "exam prep", "cram" → `study`
- "workout", "gym", "run", "lift", "exercise", "yoga" → `workout`
- "lunch", "dinner", "breakfast", "eat", "meal" → `meal`
- Anything else → pass through lowercase

**Duration defaults:** `study` → 2h, all others → 1h

---

## New File: `celery_worker/sms/schedule.py`

### Exported functions

**`parse_target_date(date_string, user_tz) -> datetime | None`**
Uses `dateparser` with `PREFER_DATES_FROM=future`. Returns `None` on failure.

**`get_user_tz(user_id) -> str`**
Reads `preferences_json.timezone`. Fallback: `"America/New_York"`.

**`get_activity_preference(user_id, activity_type) -> str | None`**
Returns stored preference or `None` if unseen.

**`set_activity_preference(user_id, activity_type, preference) -> None`**
Writes preference; initializes `confirmations=0`, `recent_blocks=[]` on first write.

**`learn_from_confirmation(user_id, activity_type, confirmed_start_iso) -> None`**
Classifies time block, appends to `recent_blocks` (trim to 3), increments `confirmations`. Updates `preference` if all 3 recent blocks agree and differ from current.

**`store_pending_schedule / get_pending_schedule / clear_pending_schedule`**
Redis CRUD for `aria:pending_schedule:{user_id}` with 300s TTL.

**`store_pending_preference / get_pending_preference / clear_pending_preference`**
Redis CRUD for `aria:pending_preference:{user_id}` with 300s TTL.

**`get_user_tz(user_id) -> str`**
Reads `preferences_json.timezone`. Fallback: `"America/New_York"`.

**`handle_schedule_request(user_id, activity_type, subject, target_date_string, duration_hours) -> str`**
Orchestrates: tz lookup → date parse → GCal connected check → preference lookup/ask → slot-find → pending store → confirmation prompt.

**`handle_schedule_confirmation(user_id) -> str`**
Books event via `create_study_block` (parses ISO strings to datetime first), calls `learn_from_confirmation`, clears pending.

**`handle_schedule_decline(user_id) -> str`**
Pops first alternative slot into pending, returns new confirmation prompt. If no alternatives, clears pending and returns Flow E message.

---

## Files Changed

| File | Change |
|---|---|
| `celery_worker/sms/schedule.py` | New |
| `celery_worker/ai/replies.py` | Modified (intent prompt + 4-step intercept + schedule branch) |
| `celery_worker/requirements.txt` | Add `dateparser>=1.2.0` |
| `celery_worker/tests/sms/test_schedule.py` | New |
| `celery_worker/tests/ai/test_replies.py` | Modified (intercept + routing tests) |
| `.planning/ROADMAP.md` | Modified (add Phase 13) |

**Untouched:** `gcal/slots.py`, `gcal/writeback.py`, `gcal/db.py`

---

## Error Cases

| Scenario | Response |
|---|---|
| No GCal connected | "You'll need to connect Google Calendar first — head to Preferences in the app." |
| No free slot | "Your calendar's fully booked [date] — text me 'find time to [activity] tomorrow' to check then." |
| No more alternatives | "No other slots available [date] — text me 'find time to [activity] tomorrow' to check a different day." |
| Unparseable date | "What date did you have in mind? Try something like 'tomorrow' or 'Friday'." |
| Pending expired before reply | Treat next message as fresh — no error surfaced |
| Unmatched reply while pending | Fall through to Claude; pending key preserved |

---

## Testing Coverage

`celery_worker/tests/sms/test_schedule.py`:
- `parse_target_date`: tomorrow, unparseable, future date, before-7am time block classification
- `get_user_tz`: stored value, default fallback
- Preference CRUD: unknown returns None, round-trip, preserves other activities
- `learn_from_confirmation`: appends block, trims to 3, updates on consensus, no update on mixed, increments count
- Redis state: store/get round-trip, None on missing, delete called, TTL set with setex
- `handle_schedule_request`: asks preference when unknown, returns confirmation prompt, Flow C no-slot, no GCal, bad date
- `handle_schedule_confirmation`: books event, clears pending, calls learn, expired pending graceful
- `handle_schedule_decline`: offers alternative, clears and Flow E on empty alternatives, no-pending graceful

`celery_worker/tests/ai/test_replies.py` additions:
- Preference intercept fires before Claude
- Affirmative → confirmation; negative → decline
- Unmatched reply falls through (and pending key is NOT cleared)
- `schedule` intent routes to `handle_schedule_request`
