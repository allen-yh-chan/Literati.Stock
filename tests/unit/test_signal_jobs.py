"""Tests for `literati_stock.signal.jobs.register_signal_jobs`."""

from __future__ import annotations

from unittest.mock import MagicMock

from apscheduler.triggers.cron import CronTrigger

from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.signal.jobs import (
    DEFAULT_EVAL_HOUR,
    DEFAULT_EVAL_MINUTE,
    SIGNAL_EVALUATION_JOB_ID,
    register_signal_jobs,
)
from literati_stock.signal.rules.volume_surge_red import VolumeSurgeRedSignal


def test_registers_signal_evaluation_job() -> None:
    scheduler = IngestScheduler()
    register_signal_jobs(scheduler, MagicMock(), signals=[VolumeSurgeRedSignal()])
    ids = [str(j.id) for j in scheduler.jobs]
    assert SIGNAL_EVALUATION_JOB_ID in ids


def test_default_trigger_is_1745_taipei_cron() -> None:
    scheduler = IngestScheduler()
    register_signal_jobs(scheduler, MagicMock(), signals=[VolumeSurgeRedSignal()])
    job = next(j for j in scheduler.jobs if str(j.id) == SIGNAL_EVALUATION_JOB_ID)
    trigger = job.trigger
    assert isinstance(trigger, CronTrigger)

    fields = {f.name: str(f) for f in trigger.fields}
    assert fields["hour"] == str(DEFAULT_EVAL_HOUR)
    assert fields["minute"] == str(DEFAULT_EVAL_MINUTE)
    assert str(trigger.timezone) == "Asia/Taipei"
