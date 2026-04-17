"""Tests for `literati_stock.ingest.scheduler`."""

from __future__ import annotations

from apscheduler.triggers.cron import CronTrigger

from literati_stock.ingest.scheduler import IngestScheduler


def _noop() -> None:
    return None


def test_default_timezone_is_asia_taipei() -> None:
    scheduler = IngestScheduler()
    assert scheduler.timezone == "Asia/Taipei"


def test_custom_timezone_honored() -> None:
    scheduler = IngestScheduler(timezone="UTC")
    assert scheduler.timezone == "UTC"


def test_add_job_is_observable() -> None:
    scheduler = IngestScheduler()
    scheduler.add_job(_noop, CronTrigger(hour=14, minute=30), job_id="price.daily")
    ids: list[str] = [str(j.id) for j in scheduler.jobs]
    assert "price.daily" in ids


def test_defaults_applied_to_registered_job() -> None:
    scheduler = IngestScheduler()
    job = scheduler.add_job(_noop, CronTrigger(minute="*/5"), job_id="x")
    assert job.misfire_grace_time == IngestScheduler.DEFAULT_MISFIRE_GRACE_SECS
    assert job.coalesce is IngestScheduler.DEFAULT_COALESCE
    assert job.max_instances == IngestScheduler.DEFAULT_MAX_INSTANCES


def test_overrides_applied() -> None:
    scheduler = IngestScheduler()
    job = scheduler.add_job(
        _noop,
        CronTrigger(minute="*/5"),
        job_id="x",
        misfire_grace_time=30,
        coalesce=False,
        max_instances=2,
    )
    assert job.misfire_grace_time == 30
    assert job.coalesce is False
    assert job.max_instances == 2
