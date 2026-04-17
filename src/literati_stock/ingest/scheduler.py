"""Thin async-scheduler wrapper around APScheduler's ``AsyncIOScheduler``.

Exposes just the surface area this project needs (`add_job`, `start`,
`shutdown`, `jobs`) so swapping for Prefect or another orchestrator later
only requires changing this module.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any
from zoneinfo import ZoneInfo

from apscheduler.job import Job
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.base import BaseTrigger


class IngestScheduler:
    """Project-level defaults applied on top of `AsyncIOScheduler`."""

    DEFAULT_MISFIRE_GRACE_SECS: int = 600
    DEFAULT_COALESCE: bool = True
    DEFAULT_MAX_INSTANCES: int = 1

    def __init__(self, timezone: str = "Asia/Taipei") -> None:
        self._timezone = timezone
        self._scheduler = AsyncIOScheduler(timezone=ZoneInfo(timezone))

    def add_job(
        self,
        func: Callable[..., Any],
        trigger: BaseTrigger,
        *,
        job_id: str,
        misfire_grace_time: int | None = None,
        coalesce: bool | None = None,
        max_instances: int | None = None,
    ) -> Job:
        """Register a job with project-default misfire / coalesce / concurrency."""
        return self._scheduler.add_job(
            func,
            trigger=trigger,
            id=job_id,
            replace_existing=True,
            misfire_grace_time=(
                self.DEFAULT_MISFIRE_GRACE_SECS
                if misfire_grace_time is None
                else misfire_grace_time
            ),
            coalesce=self.DEFAULT_COALESCE if coalesce is None else coalesce,
            max_instances=(self.DEFAULT_MAX_INSTANCES if max_instances is None else max_instances),
        )

    def start(self) -> None:
        self._scheduler.start()

    async def shutdown(self, wait: bool = True) -> None:
        """Stop the scheduler and yield so the event loop finalises state.

        `AsyncIOScheduler.shutdown` returns before the state transition to
        STOPPED is visible; yielding once lets the wakeup task be cancelled
        and `running` flip to False synchronously w.r.t. the caller.
        """
        self._scheduler.shutdown(wait=wait)
        await asyncio.sleep(0)

    @property
    def jobs(self) -> list[Job]:
        return self._scheduler.get_jobs()

    @property
    def timezone(self) -> str:
        return self._timezone

    @property
    def running(self) -> bool:
        return self._scheduler.running
