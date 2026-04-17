"""Tests for `literati_stock.price.jobs.register_price_jobs`."""

from __future__ import annotations

from unittest.mock import MagicMock

from apscheduler.triggers.interval import IntervalTrigger

from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.price.jobs import PRICE_TRANSFORM_JOB_ID, register_price_jobs


def test_registers_price_transform_job() -> None:
    scheduler = IngestScheduler()
    session_factory = MagicMock()

    register_price_jobs(scheduler, session_factory)

    ids = [str(j.id) for j in scheduler.jobs]
    assert PRICE_TRANSFORM_JOB_ID in ids


def test_default_interval_is_300_seconds() -> None:
    scheduler = IngestScheduler()
    session_factory = MagicMock()

    register_price_jobs(scheduler, session_factory)

    job = next(j for j in scheduler.jobs if str(j.id) == PRICE_TRANSFORM_JOB_ID)
    assert isinstance(job.trigger, IntervalTrigger)
    assert job.trigger.interval.total_seconds() == 300


def test_custom_interval_honoured() -> None:
    scheduler = IngestScheduler()
    session_factory = MagicMock()

    register_price_jobs(scheduler, session_factory, interval_seconds=60)

    job = next(j for j in scheduler.jobs if str(j.id) == PRICE_TRANSFORM_JOB_ID)
    assert isinstance(job.trigger, IntervalTrigger)
    assert job.trigger.interval.total_seconds() == 60
