"""Unit tests for `InstitutionalChaseWarningSignal`."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from literati_stock.signal.base import (
    InstitutionalRow,
    MarginRow,
    PriceRow,
    SignalFeatures,
)
from literati_stock.signal.rules.institutional_chase import (
    InstitutionalChaseWarningSignal,
)

AS_OF = date(2026, 4, 17)


def _inst(stock: str, trade_date: date, total: int) -> InstitutionalRow:
    return InstitutionalRow(
        stock_id=stock,
        trade_date=trade_date,
        foreign_net=total,
        trust_net=0,
        dealer_net=0,
        total_net=total,
    )


def _margin(stock: str, trade_date: date, balance: int) -> MarginRow:
    return MarginRow(
        stock_id=stock,
        trade_date=trade_date,
        margin_today_balance=balance,
        margin_yesterday_balance=balance,
        short_today_balance=0,
        short_yesterday_balance=0,
    )


def _price(stock: str, trade_date: date, close: float) -> PriceRow:
    return PriceRow(
        stock_id=stock,
        trade_date=trade_date,
        open=Decimal(str(close)) - Decimal("1"),
        high=Decimal(str(close)) + Decimal("1"),
        low=Decimal(str(close)) - Decimal("2"),
        close=Decimal(str(close)),
        volume=1_000_000,
        ma_volume=Decimal("500000"),
    )


def _consecutive_dates(end: date, days: int) -> list[date]:
    return [end - timedelta(days=i) for i in range(days)]


def test_fires_when_all_conditions_met() -> None:
    signal = InstitutionalChaseWarningSignal()
    dates = _consecutive_dates(AS_OF, 5)
    inst = [_inst("2330", d, 1_000_000) for d in dates]
    margin = [
        _margin("2330", dates[4], 100_000),
        _margin("2330", dates[2], 105_000),
        _margin("2330", dates[0], 115_000),  # as_of
    ]
    price = [
        _price("2330", dates[4], 100.0),
        _price("2330", dates[2], 105.0),
        _price("2330", dates[0], 112.0),
    ]
    events = signal.evaluate(SignalFeatures(prices=price, institutional=inst, margin=margin), AS_OF)
    assert len(events) == 1
    ev = events[0]
    assert ev.stock_id == "2330"
    assert ev.severity is not None and ev.severity > Decimal("1.05")


def test_one_negative_day_skips() -> None:
    signal = InstitutionalChaseWarningSignal()
    dates = _consecutive_dates(AS_OF, 5)
    inst = [_inst("2330", d, 1_000_000) for d in dates]
    inst[1] = _inst("2330", dates[1], -500_000)  # one negative day
    margin = [
        _margin("2330", dates[4], 100_000),
        _margin("2330", dates[0], 115_000),
    ]
    price = [
        _price("2330", dates[4], 100.0),
        _price("2330", dates[0], 112.0),
    ]
    events = signal.evaluate(SignalFeatures(prices=price, institutional=inst, margin=margin), AS_OF)
    assert events == []


def test_stale_margin_skips() -> None:
    signal = InstitutionalChaseWarningSignal()
    dates = _consecutive_dates(AS_OF, 5)
    inst = [_inst("2330", d, 1_000_000) for d in dates]
    margin = [
        _margin("2330", dates[4], 100_000),
        _margin("2330", dates[0], 100_000),  # unchanged balance
    ]
    price = [
        _price("2330", dates[4], 100.0),
        _price("2330", dates[0], 110.0),
    ]
    events = signal.evaluate(SignalFeatures(prices=price, institutional=inst, margin=margin), AS_OF)
    assert events == []


def test_price_down_skips() -> None:
    signal = InstitutionalChaseWarningSignal()
    dates = _consecutive_dates(AS_OF, 5)
    inst = [_inst("2330", d, 1_000_000) for d in dates]
    margin = [
        _margin("2330", dates[4], 100_000),
        _margin("2330", dates[0], 115_000),
    ]
    price = [
        _price("2330", dates[4], 100.0),
        _price("2330", dates[0], 95.0),  # down
    ]
    events = signal.evaluate(SignalFeatures(prices=price, institutional=inst, margin=margin), AS_OF)
    assert events == []


def test_insufficient_history_skips() -> None:
    signal = InstitutionalChaseWarningSignal()
    # Only 2 institutional days — below min_institutional_days=3.
    inst = [
        _inst("2330", AS_OF, 1_000_000),
        _inst("2330", AS_OF - timedelta(days=1), 1_000_000),
    ]
    margin = [
        _margin("2330", AS_OF - timedelta(days=4), 100_000),
        _margin("2330", AS_OF, 115_000),
    ]
    price = [
        _price("2330", AS_OF - timedelta(days=4), 100.0),
        _price("2330", AS_OF, 112.0),
    ]
    events = signal.evaluate(SignalFeatures(prices=price, institutional=inst, margin=margin), AS_OF)
    assert events == []
