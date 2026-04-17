"""Unit tests for `VolumeSurgeRedSignal`."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from literati_stock.signal.base import PriceRow
from literati_stock.signal.rules.volume_surge_red import VolumeSurgeRedSignal

AS_OF = date(2026, 4, 17)


def _row(**overrides: object) -> PriceRow:
    defaults: dict[str, object] = {
        "stock_id": "2330",
        "trade_date": AS_OF,
        "open": Decimal("110"),
        "high": Decimal("125"),
        "low": Decimal("109"),
        "close": Decimal("120"),
        "volume": 30_000_000,
        "ma_volume": Decimal("10000000"),
    }
    defaults.update(overrides)
    return PriceRow(**defaults)  # type: ignore[arg-type]


def test_fires_when_all_conditions_met() -> None:
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate([_row()], AS_OF)
    assert len(events) == 1
    ev = events[0]
    assert ev.signal_name == "volume_surge_red"
    assert ev.stock_id == "2330"
    assert ev.trade_date == AS_OF
    assert ev.severity == Decimal("3.0000")
    assert ev.metadata is not None
    assert ev.metadata["vol_ratio"] == 3.0


def test_skip_small_red_bar() -> None:
    # close-open / open = 1/110 < 1.5%
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate([_row(close=Decimal("111"))], AS_OF)
    assert events == []


def test_skip_black_bar() -> None:
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate([_row(close=Decimal("105"))], AS_OF)
    assert events == []


def test_skip_penny_stock() -> None:
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate(
        [_row(open=Decimal("4.7"), close=Decimal("5"))],
        AS_OF,
    )
    assert events == []


def test_skip_insufficient_history() -> None:
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate([_row(ma_volume=None)], AS_OF)
    assert events == []


def test_skip_insufficient_volume_ratio() -> None:
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate([_row(volume=15_000_000)], AS_OF)  # 1.5x
    assert events == []


def test_skip_non_as_of_row() -> None:
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate(
        [_row(trade_date=date(2026, 4, 16))],
        AS_OF,
    )
    assert events == []


def test_parameters_are_honoured() -> None:
    signal = VolumeSurgeRedSignal(volume_multiple=5.0)
    events = signal.evaluate([_row(volume=30_000_000)], AS_OF)  # 3x not enough
    assert events == []

    events2 = signal.evaluate([_row(volume=60_000_000)], AS_OF)  # 6x
    assert len(events2) == 1


def test_emits_severity_and_metadata() -> None:
    signal = VolumeSurgeRedSignal()
    events = signal.evaluate(
        [_row(open=Decimal("100"), close=Decimal("115"), volume=40_000_000)],
        AS_OF,
    )
    assert len(events) == 1
    md = events[0].metadata
    assert md is not None
    assert md["close"] == 115.0
    assert md["open"] == 100.0
    assert md["volume"] == 40_000_000
    assert md["window_days"] == 20
    assert md["red_bar_pct"] == 0.15
