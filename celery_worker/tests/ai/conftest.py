"""Shared fixtures for ai test module.

Provides autouse stubs so that existing handle_reply tests don't need
REDIS_URL set — the scheduling intercepts are no-ops by default.
Tests that specifically test scheduling behaviour patch these themselves.
"""
import pytest
from unittest.mock import patch


@pytest.fixture(autouse=True)
def stub_schedule_intercepts():
    """Return None from both Redis-backed intercepts so tests without Redis pass."""
    with patch("sms.schedule.get_pending_preference", return_value=None), \
         patch("sms.schedule.get_pending_schedule", return_value=None):
        yield
