"""Core types for the signal engine: `PriceRow`, `SignalEventOut`, `Signal`."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict


@dataclass(frozen=True, slots=True)
class PriceRow:
    """Input row consumed by ``Signal.evaluate``.

    `ma_volume` is ``None`` when there is insufficient history to compute the
    moving-average; signals MUST handle this case.
    """

    stock_id: str
    trade_date: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    ma_volume: Decimal | None


class SignalEventOut(BaseModel):
    """Domain output from `Signal.evaluate`; upserted into `signal_event`."""

    model_config = ConfigDict(frozen=True)

    signal_name: str
    stock_id: str
    trade_date: date
    severity: Decimal | None = None
    metadata: dict[str, Any] | None = None


@runtime_checkable
class Signal(Protocol):
    """Structural type for a signal rule.

    Implementations MUST be pure with respect to `(rows, as_of)` — no hidden
    I/O, no future-row access. `window_days` is the historical window size the
    signal depends on; the service uses it to parameterise the SQL window fn.

    Both `name` and `window_days` are expressed as read-only properties so
    frozen dataclass implementations satisfy the protocol (the default-field
    form on a frozen dataclass is read-only, which Pyright flags as
    incompatible with a writable attribute on Protocol).
    """

    @property
    def name(self) -> str: ...

    @property
    def window_days(self) -> int: ...

    def evaluate(self, rows: Sequence[PriceRow], as_of: date) -> list[SignalEventOut]: ...
