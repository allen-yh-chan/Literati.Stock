"""Scheduler registration for chip-data ingest + transform jobs."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import structlog
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.chip.transform import (
    InstitutionalTransformService,
    MarginTransformService,
)
from literati_stock.core.settings import Settings
from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.universe.daily_ingest import DailyWatchlistIngestService

logger = structlog.get_logger(__name__)

CHIP_INGEST_INSTITUTIONAL_JOB_ID = "chip_ingest_institutional"
CHIP_INGEST_MARGIN_JOB_ID = "chip_ingest_margin"
INSTITUTIONAL_TRANSFORM_JOB_ID = "institutional_transform"
MARGIN_TRANSFORM_JOB_ID = "margin_transform"

_INSTITUTIONAL_DATASET = "TaiwanStockInstitutionalInvestorsBuySell"
_MARGIN_DATASET = "TaiwanStockMarginPurchaseShortSale"


def register_chip_jobs(
    scheduler: IngestScheduler,
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    *,
    timezone: str = "Asia/Taipei",
) -> None:
    """Register the four chip-data jobs.

    - `chip_ingest_institutional` Mon-Fri 16:30 Taipei (法人公布後)
    - `chip_ingest_margin` Mon-Fri 15:30 Taipei (融資融券公布後)
    - `institutional_transform` every 5 min
    - `margin_transform` every 5 min
    """
    tz = ZoneInfo(timezone)

    institutional_ingest = DailyWatchlistIngestService(
        session_factory, settings, dataset=_INSTITUTIONAL_DATASET
    )
    margin_ingest = DailyWatchlistIngestService(session_factory, settings, dataset=_MARGIN_DATASET)
    institutional_transform = InstitutionalTransformService(session_factory)
    margin_transform = MarginTransformService(session_factory)

    async def _institutional_ingest_tick() -> None:
        as_of = datetime.now(tz).date()
        await institutional_ingest.run(as_of)

    async def _margin_ingest_tick() -> None:
        as_of = datetime.now(tz).date()
        await margin_ingest.run(as_of)

    async def _institutional_transform_tick() -> None:
        result = await institutional_transform.process_new()
        if result.raw_rows_processed > 0:
            logger.info("chip.institutional_transform.tick", **result.model_dump())

    async def _margin_transform_tick() -> None:
        result = await margin_transform.process_new()
        if result.raw_rows_processed > 0:
            logger.info("chip.margin_transform.tick", **result.model_dump())

    scheduler.add_job(
        _institutional_ingest_tick,
        CronTrigger(day_of_week="mon-fri", hour=16, minute=30, timezone=tz),
        job_id=CHIP_INGEST_INSTITUTIONAL_JOB_ID,
    )
    scheduler.add_job(
        _margin_ingest_tick,
        CronTrigger(day_of_week="mon-fri", hour=15, minute=30, timezone=tz),
        job_id=CHIP_INGEST_MARGIN_JOB_ID,
    )
    scheduler.add_job(
        _institutional_transform_tick,
        IntervalTrigger(seconds=300),
        job_id=INSTITUTIONAL_TRANSFORM_JOB_ID,
    )
    scheduler.add_job(
        _margin_transform_tick,
        IntervalTrigger(seconds=300),
        job_id=MARGIN_TRANSFORM_JOB_ID,
    )
