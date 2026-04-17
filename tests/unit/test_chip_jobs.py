"""Tests for `register_chip_jobs`."""

from __future__ import annotations

from unittest.mock import MagicMock

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from literati_stock.chip.jobs import (
    CHIP_INGEST_INSTITUTIONAL_JOB_ID,
    CHIP_INGEST_MARGIN_JOB_ID,
    INSTITUTIONAL_TRANSFORM_JOB_ID,
    MARGIN_TRANSFORM_JOB_ID,
    register_chip_jobs,
)
from literati_stock.core.settings import Settings
from literati_stock.ingest.scheduler import IngestScheduler


def _settings() -> Settings:
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        database_url="postgresql+asyncpg://x/y",
        finmind_token="",
    )


def test_all_four_jobs_registered() -> None:
    scheduler = IngestScheduler()
    register_chip_jobs(scheduler, MagicMock(), _settings())
    ids = {str(j.id) for j in scheduler.jobs}
    assert {
        CHIP_INGEST_INSTITUTIONAL_JOB_ID,
        CHIP_INGEST_MARGIN_JOB_ID,
        INSTITUTIONAL_TRANSFORM_JOB_ID,
        MARGIN_TRANSFORM_JOB_ID,
    }.issubset(ids)


def test_institutional_ingest_cron_1630_taipei() -> None:
    scheduler = IngestScheduler()
    register_chip_jobs(scheduler, MagicMock(), _settings())
    job = next(j for j in scheduler.jobs if str(j.id) == CHIP_INGEST_INSTITUTIONAL_JOB_ID)
    assert isinstance(job.trigger, CronTrigger)
    fields = {f.name: str(f) for f in job.trigger.fields}
    assert fields["day_of_week"] == "mon-fri"
    assert fields["hour"] == "16"
    assert fields["minute"] == "30"
    assert str(job.trigger.timezone) == "Asia/Taipei"


def test_margin_ingest_cron_1530_taipei() -> None:
    scheduler = IngestScheduler()
    register_chip_jobs(scheduler, MagicMock(), _settings())
    job = next(j for j in scheduler.jobs if str(j.id) == CHIP_INGEST_MARGIN_JOB_ID)
    assert isinstance(job.trigger, CronTrigger)
    fields = {f.name: str(f) for f in job.trigger.fields}
    assert fields["hour"] == "15"
    assert fields["minute"] == "30"


def test_transform_jobs_interval_300s() -> None:
    scheduler = IngestScheduler()
    register_chip_jobs(scheduler, MagicMock(), _settings())
    for job_id in (INSTITUTIONAL_TRANSFORM_JOB_ID, MARGIN_TRANSFORM_JOB_ID):
        job = next(j for j in scheduler.jobs if str(j.id) == job_id)
        assert isinstance(job.trigger, IntervalTrigger)
        assert job.trigger.interval.total_seconds() == 300
