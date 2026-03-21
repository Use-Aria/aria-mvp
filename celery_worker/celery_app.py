import os
from celery import Celery
from celery.schedules import crontab

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "aria",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        "canvas-sync-all-users": {
            "task": "tasks.canvas_sync_all",
            "schedule": 3600.0,  # every 60 minutes
        },
        "generate-daily-briefings": {
            "task": "tasks.generate_daily_briefings_all",
            "schedule": crontab(minute="*/15", hour="6-12"),
        },
        "renew-watch-channels": {
            "task": "tasks.renew_watch_channels",
            "schedule": crontab(hour="*/6", minute=0),  # every 6 hours
        },
        "gap-analysis-daily": {
            "task": "tasks.gap_analysis_all_users",
            "schedule": crontab(hour=3, minute=0),  # 03:00 UTC daily -- avoids briefing window
        },
    },
)
