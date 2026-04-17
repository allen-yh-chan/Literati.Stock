"""Tests for `register_notification_jobs`."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from apscheduler.triggers.cron import CronTrigger

from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.notify.jobs import (
    DEFAULT_DISPATCH_HOUR,
    DEFAULT_DISPATCH_MINUTE,
    NOTIFICATION_DISPATCH_JOB_ID,
    register_notification_jobs,
)


def test_job_is_registered() -> None:
    scheduler = IngestScheduler()
    register_notification_jobs(
        scheduler,
        MagicMock(),
        channel=AsyncMock(),
        signal_names=["volume_surge_red"],
    )
    assert NOTIFICATION_DISPATCH_JOB_ID in [str(j.id) for j in scheduler.jobs]


def test_default_trigger_is_1750_taipei_cron() -> None:
    scheduler = IngestScheduler()
    register_notification_jobs(
        scheduler,
        MagicMock(),
        channel=AsyncMock(),
        signal_names=["volume_surge_red"],
    )
    job = next(j for j in scheduler.jobs if str(j.id) == NOTIFICATION_DISPATCH_JOB_ID)
    trigger = job.trigger
    assert isinstance(trigger, CronTrigger)
    fields = {f.name: str(f) for f in trigger.fields}
    assert fields["hour"] == str(DEFAULT_DISPATCH_HOUR)
    assert fields["minute"] == str(DEFAULT_DISPATCH_MINUTE)
    assert str(trigger.timezone) == "Asia/Taipei"
