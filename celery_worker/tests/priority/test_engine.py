"""Unit tests for priority.engine — PRIO-02 scoring formula.

Tests cover: compute_urgency() spot checks, overdue clamping, score_event()
formula correctness, NULL grade_weight handling, unknown source fallback,
and SOURCE_AUTHORITY dict values.
"""
import pytest
from priority.engine import compute_urgency, score_event, SOURCE_AUTHORITY


class TestComputeUrgency:
    def test_compute_urgency_14_days(self):
        """14 days remaining: e^(-2.1) ≈ 0.122."""
        result = compute_urgency(14.0)
        assert result == pytest.approx(0.12, abs=0.01)

    def test_compute_urgency_7_days(self):
        """7 days remaining: e^(-1.05) ≈ 0.350."""
        result = compute_urgency(7.0)
        assert result == pytest.approx(0.35, abs=0.01)

    def test_compute_urgency_3_days(self):
        """3 days remaining: e^(-0.45) ≈ 0.638."""
        result = compute_urgency(3.0)
        assert result == pytest.approx(0.64, abs=0.01)

    def test_compute_urgency_1_day(self):
        """1 day remaining: e^(-0.15) ≈ 0.861."""
        result = compute_urgency(1.0)
        assert result == pytest.approx(0.86, abs=0.01)

    def test_compute_urgency_0_days(self):
        """0 days remaining: clamped to 1.0."""
        result = compute_urgency(0.0)
        assert result == 1.0

    def test_compute_urgency_overdue(self):
        """Overdue events (days_remaining < 0): clamped to 1.0."""
        result = compute_urgency(-3.0)
        assert result == 1.0


class TestScoreEvent:
    def test_score_event_canvas_due_tomorrow_no_weight(self):
        """Canvas event due in 1 day, no grade weight.

        score = round(((0.0*0.35) + (0.861*0.45) + (1.0*0.20)) * 100)
              = round((0.0 + 0.3875 + 0.20) * 100)
              = round(58.74) = 59
        """
        result = score_event(grade_weight=0.0, days_remaining=1.0, source="canvas")
        assert result == 59

    def test_score_event_canvas_due_today_high_weight(self):
        """Canvas event due today with 25% grade weight.

        score = round(((0.25*0.35) + (1.0*0.45) + (1.0*0.20)) * 100)
              = round((0.0875 + 0.45 + 0.20) * 100)
              = round(73.75) = 74
        """
        result = score_event(grade_weight=0.25, days_remaining=0.0, source="canvas")
        assert result == 74

    def test_score_event_null_grade_weight(self):
        """NULL grade_weight does not raise; treated as 0.0."""
        result = score_event(grade_weight=None, days_remaining=1.0, source="canvas")
        # Should return same as grade_weight=0.0, days_remaining=1.0
        assert result == score_event(grade_weight=0.0, days_remaining=1.0, source="canvas")

    def test_score_event_zero_grade_weight(self):
        """Zero grade_weight treated as 0.0 without raising."""
        result = score_event(grade_weight=0.0, days_remaining=7.0, source="canvas")
        # score = round((0.0 + 0.35*0.45 + 1.0*0.20) * 100)
        assert isinstance(result, int)

    def test_score_event_unknown_source(self):
        """Unknown source uses default authority 0.5."""
        result = score_event(grade_weight=0.0, days_remaining=0.0, source="unknown")
        # score = round(((0.0*0.35) + (1.0*0.45) + (0.5*0.20)) * 100)
        # = round((0.45 + 0.10) * 100) = round(55.0) = 55
        assert result == 55

    def test_score_returns_integer(self):
        """score_event() must return an integer (0-100 scale)."""
        result = score_event(grade_weight=0.25, days_remaining=3.0, source="canvas")
        assert isinstance(result, int)


class TestSourceAuthority:
    def test_source_authority_values(self):
        """SOURCE_AUTHORITY dict contains correct locked values."""
        assert SOURCE_AUTHORITY["canvas"] == 1.0
        assert SOURCE_AUTHORITY["gmail"] == 0.9
        assert SOURCE_AUTHORITY["todoist"] == 0.8
        assert SOURCE_AUTHORITY["discord"] == 0.6
