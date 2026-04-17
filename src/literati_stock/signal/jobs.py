"""Scheduler registration for the daily signal evaluation job."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from zoneinfo import ZoneInfo

import structlog
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.signal.base import Signal
from literati_stock.signal.service import SignalEvaluationService

logger = structlog.get_logger(__name__)

SIGNAL_EVALUATION_JOB_ID = "signal_evaluation"
DEFAULT_EVAL_HOUR = 17
DEFAULT_EVAL_MINUTE = 45


def register_signal_jobs(
    scheduler: IngestScheduler,
    session_factory: async_sessionmaker[AsyncSession],
    signals: Sequence[Signal],
    *,
    hour: int = DEFAULT_EVAL_HOUR,
    minute: int = DEFAULT_EVAL_MINUTE,
    timezone: str = "Asia/Taipei",
) -> None:
    """Register the daily cron that evaluates every registered signal."""
    service = SignalEvaluationService(session_factory)
    tz = ZoneInfo(timezone)

    async def _tick() -> None:
        as_of = datetime.now(tz).date()
        for sig in signals:
            await service.evaluate(sig, as_of)

    scheduler.add_job(
        _tick,
        CronTrigger(hour=hour, minute=minute, timezone=tz),
        job_id=SIGNAL_EVALUATION_JOB_ID,
    )
