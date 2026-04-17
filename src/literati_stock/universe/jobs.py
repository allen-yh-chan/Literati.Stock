"""Scheduler registration for universe sync + daily price ingest."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import structlog
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.core.settings import Settings
from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.universe.daily_ingest import DailyPriceIngestService
from literati_stock.universe.service import UniverseSyncService

logger = structlog.get_logger(__name__)

UNIVERSE_SYNC_JOB_ID = "universe_sync"
PRICE_INGEST_DAILY_JOB_ID = "price_ingest_daily"


def register_universe_jobs(
    scheduler: IngestScheduler,
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    *,
    timezone: str = "Asia/Taipei",
) -> None:
    """Register weekly universe sync + daily watchlist price ingest jobs."""
    tz = ZoneInfo(timezone)
    sync_service = UniverseSyncService(session_factory, settings)
    ingest_service = DailyPriceIngestService(session_factory, settings)

    async def _sync_tick() -> None:
        await sync_service.sync()

    async def _ingest_tick() -> None:
        as_of = datetime.now(tz).date()
        await ingest_service.run(as_of)

    scheduler.add_job(
        _sync_tick,
        CronTrigger(day_of_week="sun", hour=22, minute=0, timezone=tz),
        job_id=UNIVERSE_SYNC_JOB_ID,
    )
    scheduler.add_job(
        _ingest_tick,
        CronTrigger(day_of_week="mon-fri", hour=14, minute=30, timezone=tz),
        job_id=PRICE_INGEST_DAILY_JOB_ID,
    )
