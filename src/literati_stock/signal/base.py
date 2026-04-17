"""Core types for the signal engine: row types, `SignalFeatures`, `Signal`."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict


@dataclass(frozen=True, slots=True)
class PriceRow:
    """One OHLCV row with pre-computed moving-average volume.

    `ma_volume` is ``None`` when there is insufficient history; signals MUST
    handle the `None` case explicitly.
    """

    stock_id: str
    trade_date: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    ma_volume: Decimal | None


@dataclass(frozen=True, slots=True)
class InstitutionalRow:
    """One aggregated institutional buy-sell row for (stock, trade_date)."""

    stock_id: str
    trade_date: date
    foreign_net: int
    trust_net: int
    dealer_net: int
    total_net: int


@dataclass(frozen=True, slots=True)
class MarginRow:
    """One margin / short-sale snapshot row."""

    stock_id: str
    trade_date: date
    margin_today_balance: int
    margin_yesterday_balance: int
    short_today_balance: int
    short_yesterday_balance: int


@dataclass(frozen=True, slots=True)
class SignalFeatures:
    """All input data surfaces a signal may consume.

    Each sequence is pre-filtered to `trade_date <= as_of` by the service
    layer; missing data defaults to an empty sequence so signals depending
    only on prices don't need to check for None.
    """

    prices: Sequence[PriceRow]
    institutional: Sequence[InstitutionalRow] = field(default_factory=tuple)
    margin: Sequence[MarginRow] = field(default_factory=tuple)


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

    Implementations MUST be pure with respect to `(features, as_of)` — no
    hidden I/O, no future-row access. `window_days` is the historical window
    size the signal depends on; the service uses it to drive SQL window
    functions and row selection.

    Both `name` and `window_days` are expressed as read-only properties so
    frozen dataclass implementations satisfy the protocol.
    """

    @property
    def name(self) -> str: ...

    @property
    def window_days(self) -> int: ...

    def evaluate(self, features: SignalFeatures, as_of: date) -> list[SignalEventOut]: ...
