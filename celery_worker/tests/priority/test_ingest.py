"""Unit tests for ingest_canonical_event().

Mocks _get_supabase (via ai.db), score_event (via priority.engine), and
route_event (via priority.router) to control behavior and capture Supabase calls.

Since ingest.py uses local imports inside the function, we patch the source modules
directly (e.g. priority.engine.score_event, priority.router.route_event).

Tests verify:
- Correct upsert payload fields (priority_score, delivery_status)
- skip_routing=True forces delivery_status='silent'
- NULL grade_weight handled without TypeError (stored as 0)
- score >= 80 with skip_routing=False dispatches send_priority_alert.delay
- grade_weight percentage (e.g. 25.0) normalized to fraction (0.25) before scoring
"""
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_USER_ID = "user-uuid-ingest-test"
_TITLE = "Midterm Essay"
_DUE_AT = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()


def _make_supabase_mock(event_id: str = "canonical-event-uuid-123"):
    """Return a mock Supabase client that captures upsert calls."""
    mock_client = MagicMock()
    mock_result = MagicMock()
    mock_result.data = [{"id": event_id, "delivery_status": "digest"}]
    mock_client.table.return_value.upsert.return_value.execute.return_value = mock_result
    return mock_client


# ---------------------------------------------------------------------------
# Test: happy path — inserts with correct score and delivery_status
# ---------------------------------------------------------------------------

def test_ingest_canonical_event_inserts_and_scores():
    """ingest_canonical_event upserts with correct priority_score and delivery_status."""
    mock_client = _make_supabase_mock()

    with patch("priority.engine.score_event", return_value=65) as mock_score, \
         patch("priority.router.route_event", return_value="digest") as mock_route, \
         patch("ai.db._get_supabase", return_value=mock_client):
        from priority.ingest import ingest_canonical_event
        ingest_canonical_event(
            user_id=_USER_ID,
            source="canvas",
            event_type="assignment",
            title=_TITLE,
            due_at=_DUE_AT,
            course_id="CPSC 365",
            grade_weight=0.25,
        )

    mock_client.table.assert_called_with("canonical_events")
    upsert_call = mock_client.table.return_value.upsert.call_args
    payload = upsert_call[0][0]
    assert payload["priority_score"] == 65
    assert payload["delivery_status"] == "digest"
    assert payload["user_id"] == _USER_ID
    assert payload["source"] == "canvas"
    assert payload["title"] == _TITLE


# ---------------------------------------------------------------------------
# Test: skip_routing=True forces delivery_status='silent'
# ---------------------------------------------------------------------------

def test_ingest_skip_routing_sets_silent():
    """skip_routing=True overrides delivery_status to 'silent' regardless of score."""
    mock_client = _make_supabase_mock()

    with patch("priority.engine.score_event", return_value=95), \
         patch("priority.router.route_event", return_value="immediate"), \
         patch("ai.db._get_supabase", return_value=mock_client):
        from priority.ingest import ingest_canonical_event
        ingest_canonical_event(
            user_id=_USER_ID,
            source="canvas",
            event_type="exam",
            title="Final Exam",
            due_at=_DUE_AT,
            skip_routing=True,
        )

    upsert_call = mock_client.table.return_value.upsert.call_args
    payload = upsert_call[0][0]
    assert payload["delivery_status"] == "silent", (
        "skip_routing=True should force 'silent' even when route_event returns 'immediate'"
    )


# ---------------------------------------------------------------------------
# Test: grade_weight=None stored as 0, no TypeError
# ---------------------------------------------------------------------------

def test_ingest_null_grade_weight():
    """grade_weight=None does not raise TypeError and is stored as 0 in payload."""
    mock_client = _make_supabase_mock()

    with patch("priority.engine.score_event", return_value=40) as mock_score, \
         patch("priority.router.route_event", return_value="silent"), \
         patch("ai.db._get_supabase", return_value=mock_client):
        from priority.ingest import ingest_canonical_event
        # Should not raise
        ingest_canonical_event(
            user_id=_USER_ID,
            source="canvas",
            event_type="assignment",
            title="No Weight Assignment",
            due_at=_DUE_AT,
            grade_weight=None,
        )

    upsert_call = mock_client.table.return_value.upsert.call_args
    payload = upsert_call[0][0]
    assert payload["grade_weight"] == 0.0
    # score_event called with 0.0, not None
    score_call_gw = mock_score.call_args[0][0]
    assert score_call_gw == 0.0


# ---------------------------------------------------------------------------
# Test: score >= 80 + skip_routing=False dispatches send_priority_alert
# ---------------------------------------------------------------------------

def test_ingest_immediate_dispatches_alert():
    """When score >= 80 and skip_routing=False, send_priority_alert.delay is called."""
    mock_client = _make_supabase_mock(event_id="event-uuid-immediate")
    mock_task = MagicMock()

    with patch("priority.engine.score_event", return_value=85), \
         patch("priority.router.route_event", return_value="immediate"), \
         patch("ai.db._get_supabase", return_value=mock_client), \
         patch("tasks.send_priority_alert", mock_task, create=True):
        from priority.ingest import ingest_canonical_event
        ingest_canonical_event(
            user_id=_USER_ID,
            source="canvas",
            event_type="exam",
            title="High Priority Exam",
            due_at=_DUE_AT,
            grade_weight=0.4,
            skip_routing=False,
        )

    mock_task.delay.assert_called_once_with(_USER_ID, "event-uuid-immediate")


# ---------------------------------------------------------------------------
# Test: grade_weight percentage normalization (25.0 → 0.25)
# ---------------------------------------------------------------------------

def test_ingest_grade_weight_normalization():
    """grade_weight=25.0 (raw percentage) is normalized to 0.25 before scoring."""
    mock_client = _make_supabase_mock()

    with patch("priority.engine.score_event", return_value=60) as mock_score, \
         patch("priority.router.route_event", return_value="digest"), \
         patch("ai.db._get_supabase", return_value=mock_client):
        from priority.ingest import ingest_canonical_event
        ingest_canonical_event(
            user_id=_USER_ID,
            source="canvas",
            event_type="assignment",
            title="Weighted Assignment",
            due_at=_DUE_AT,
            grade_weight=25.0,
        )

    score_call_gw = mock_score.call_args[0][0]
    assert score_call_gw == pytest.approx(0.25), (
        f"Expected normalized grade_weight 0.25, got {score_call_gw}"
    )

    # Also verify payload stores normalized value
    upsert_call = mock_client.table.return_value.upsert.call_args
    payload = upsert_call[0][0]
    assert payload["grade_weight"] == pytest.approx(0.25)
