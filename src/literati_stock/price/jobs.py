"""Scheduler registration for price-domain background work."""

from __future__ import annotations

import structlog
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.price.transform import PriceTransformService

logger = structlog.get_logger(__name__)

PRICE_TRANSFORM_JOB_ID = "price_transform"
DEFAULT_TRANSFORM_INTERVAL_SECONDS = 300


def register_price_jobs(
    scheduler: IngestScheduler,
    session_factory: async_sessionmaker[AsyncSession],
    *,
    interval_seconds: int = DEFAULT_TRANSFORM_INTERVAL_SECONDS,
) -> None:
    """Register the periodic price-transform job on `scheduler`."""
    service = PriceTransformService(session_factory)

    async def _tick() -> None:
        result = await service.process_new()
        if result.raw_rows_processed > 0:
            logger.info("price.transform.tick", **result.model_dump())

    scheduler.add_job(
        _tick,
        IntervalTrigger(seconds=interval_seconds),
        job_id=PRICE_TRANSFORM_JOB_ID,
    )
