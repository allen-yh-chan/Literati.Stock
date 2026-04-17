"""Tests for `register_universe_jobs`."""

from __future__ import annotations

from unittest.mock import MagicMock

from apscheduler.triggers.cron import CronTrigger

from literati_stock.core.settings import Settings
from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.universe.jobs import (
    PRICE_INGEST_DAILY_JOB_ID,
    UNIVERSE_SYNC_JOB_ID,
    register_universe_jobs,
)


def _settings() -> Settings:
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        database_url="postgresql+asyncpg://x/y",
        finmind_token="",
    )


def test_both_jobs_registered() -> None:
    scheduler = IngestScheduler()
    register_universe_jobs(scheduler, MagicMock(), _settings())
    ids = [str(j.id) for j in scheduler.jobs]
    assert UNIVERSE_SYNC_JOB_ID in ids
    assert PRICE_INGEST_DAILY_JOB_ID in ids


def test_universe_sync_trigger_is_weekly_sunday_2200() -> None:
    scheduler = IngestScheduler()
    register_universe_jobs(scheduler, MagicMock(), _settings())
    job = next(j for j in scheduler.jobs if str(j.id) == UNIVERSE_SYNC_JOB_ID)
    trigger = job.trigger
    assert isinstance(trigger, CronTrigger)
    fields = {f.name: str(f) for f in trigger.fields}
    assert fields["day_of_week"] == "sun"
    assert fields["hour"] == "22"
    assert fields["minute"] == "0"
    assert str(trigger.timezone) == "Asia/Taipei"


def test_price_ingest_trigger_is_mon_fri_1430() -> None:
    scheduler = IngestScheduler()
    register_universe_jobs(scheduler, MagicMock(), _settings())
    job = next(j for j in scheduler.jobs if str(j.id) == PRICE_INGEST_DAILY_JOB_ID)
    trigger = job.trigger
    assert isinstance(trigger, CronTrigger)
    fields = {f.name: str(f) for f in trigger.fields}
    assert fields["day_of_week"] == "mon-fri"
    assert fields["hour"] == "14"
    assert fields["minute"] == "30"
    assert str(trigger.timezone) == "Asia/Taipei"
