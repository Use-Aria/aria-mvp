"""Regression tests for ai.db.briefing_sent_today day-window bounds.

With the briefing Beat running every hour, the dedupe window must be the
user's LOCAL day converted to UTC — not the UTC day — or users with large
positive offsets (8am local = previous UTC day) get duplicate briefings.
"""
from unittest.mock import MagicMock, patch


def _client_capturing_bounds(bounds: dict) -> MagicMock:
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.in_.return_value = chain
    chain.limit.return_value = chain

    def _gte(col, val):
        bounds["gte"] = val
        return chain

    def _lte(col, val):
        bounds["lte"] = val
        return chain

    chain.gte.side_effect = _gte
    chain.lte.side_effect = _lte
    chain.execute.return_value = MagicMock(data=[])
    client = MagicMock()
    client.table.return_value = chain
    return client


def test_briefing_sent_today_uses_local_day_bounds_for_tokyo():
    from ai.db import briefing_sent_today

    bounds: dict = {}
    with patch("ai.db._get_supabase", return_value=_client_capturing_bounds(bounds)):
        briefing_sent_today("user-1", "2026-03-20", "Asia/Tokyo")

    # Tokyo local 2026-03-20 00:00 = 2026-03-19 15:00 UTC
    assert bounds["gte"] == "2026-03-19T15:00:00+00:00"
    assert bounds["lte"] == "2026-03-20T14:59:59+00:00"


def test_briefing_sent_today_uses_local_day_bounds_for_new_york():
    from ai.db import briefing_sent_today

    bounds: dict = {}
    with patch("ai.db._get_supabase", return_value=_client_capturing_bounds(bounds)):
        briefing_sent_today("user-1", "2026-03-20", "America/New_York")

    # EDT (UTC-4)
    assert bounds["gte"] == "2026-03-20T04:00:00+00:00"
    assert bounds["lte"] == "2026-03-21T03:59:59+00:00"
