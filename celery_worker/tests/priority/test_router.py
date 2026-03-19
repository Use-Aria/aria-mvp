"""Unit tests for priority.router — PRIO-03 delivery routing thresholds.

Tests cover all boundary values for the three-tier delivery router:
    immediate: score >= 80
    digest:    score >= 50 and < 80
    silent:    score < 50
"""
import pytest
from priority.router import route_event


class TestRouteEvent:
    def test_route_immediate_exact_80(self):
        """Score of exactly 80 maps to 'immediate'."""
        assert route_event(80) == "immediate"

    def test_route_immediate_above(self):
        """Score above 80 (e.g. 95) maps to 'immediate'."""
        assert route_event(95) == "immediate"

    def test_route_immediate_100(self):
        """Maximum score 100 maps to 'immediate'."""
        assert route_event(100) == "immediate"

    def test_route_digest_exact_50(self):
        """Score of exactly 50 maps to 'digest'."""
        assert route_event(50) == "digest"

    def test_route_digest_mid(self):
        """Score of 65 (middle of digest range) maps to 'digest'."""
        assert route_event(65) == "digest"

    def test_route_digest_79(self):
        """Score of 79 (top of digest range) maps to 'digest'."""
        assert route_event(79) == "digest"

    def test_route_silent_49(self):
        """Score of 49 (just below digest threshold) maps to 'silent'."""
        assert route_event(49) == "silent"

    def test_route_silent_zero(self):
        """Score of 0 maps to 'silent'."""
        assert route_event(0) == "silent"
