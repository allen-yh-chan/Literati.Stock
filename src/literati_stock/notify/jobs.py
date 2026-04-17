"""Scheduler registration for the daily notification dispatch job."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from zoneinfo import ZoneInfo

import structlog
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.notify.base import NotificationChannel
from literati_stock.notify.service import NotificationService

logger = structlog.get_logger(__name__)

NOTIFICATION_DISPATCH_JOB_ID = "notification_dispatch"
DEFAULT_DISPATCH_HOUR = 17
DEFAULT_DISPATCH_MINUTE = 50


def register_notification_jobs(
    scheduler: IngestScheduler,
    session_factory: async_sessionmaker[AsyncSession],
    channel: NotificationChannel,
    signal_names: Sequence[str],
    *,
    hour: int = DEFAULT_DISPATCH_HOUR,
    minute: int = DEFAULT_DISPATCH_MINUTE,
    timezone: str = "Asia/Taipei",
) -> None:
    """Register the daily cron that reads signal_event and posts to channel."""
    service = NotificationService(session_factory, channel, signal_names)
    tz = ZoneInfo(timezone)

    async def _tick() -> None:
        as_of = datetime.now(tz).date()
        await service.publish_daily(as_of)

    scheduler.add_job(
        _tick,
        CronTrigger(hour=hour, minute=minute, timezone=tz),
        job_id=NOTIFICATION_DISPATCH_JOB_ID,
    )
