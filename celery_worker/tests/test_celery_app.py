"""Tests for celery_app.py configuration, including Beat schedule.

NOTE: test_beat_schedule_* tests will fail until Task 2 adds beat_schedule
to celery_app.py conf.update(). This is expected — tests are written first.
"""
from celery_app import celery_app


class TestCeleryAppConfig:
    def test_beat_schedule_exists(self):
        """Beat schedule must be configured (non-empty dict)."""
        assert celery_app.conf.beat_schedule, "beat_schedule is empty or not set"

    def test_beat_schedule_60min(self):
        """Canvas sync entry must run every 3600 seconds (60 minutes)."""
        schedule = celery_app.conf.beat_schedule
        # Find the canvas sync entry regardless of key name
        canvas_entry = schedule.get("canvas-sync-all-users")
        assert canvas_entry is not None, "No 'canvas-sync-all-users' entry in beat_schedule"
        assert canvas_entry["schedule"] == 3600.0, (
            f"Expected schedule=3600.0, got {canvas_entry['schedule']}"
        )

    def test_beat_schedule_task_name(self):
        """Canvas sync entry must reference the correct task name."""
        schedule = celery_app.conf.beat_schedule
        canvas_entry = schedule.get("canvas-sync-all-users")
        assert canvas_entry is not None, "No 'canvas-sync-all-users' entry in beat_schedule"
        assert canvas_entry["task"] == "tasks.canvas_sync_all", (
            f"Expected task='tasks.canvas_sync_all', got {canvas_entry['task']}"
        )
