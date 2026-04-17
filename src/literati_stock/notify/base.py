"""Protocol + value types for the notification pipeline."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

from literati_stock.signal.base import SignalEventOut


class SignalDispatch(BaseModel):
    """One signal's events for a given day (input to a `NotificationChannel`)."""

    model_config = ConfigDict(frozen=True)

    signal_name: str
    events: list[SignalEventOut]


@runtime_checkable
class NotificationChannel(Protocol):
    """Structural type a notification transport must satisfy.

    Implementations MUST be idempotent at the contract level — the service
    layer guarantees at-most-once-per-run call, but channels should not treat
    re-runs as erroneous.
    """

    async def publish_daily(self, dispatches: Sequence[SignalDispatch], as_of: date) -> None: ...
