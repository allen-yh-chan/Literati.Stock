"""Unit tests for open/volume parsing used by the volume-surge trigger."""

from __future__ import annotations

from typing import Any

import pytest

from literati_stock.backtest.data import RawMarketRows, parse_open_volume


def _row(day: str, open_: object = 100.0, volume: object = 1000) -> dict[str, Any]:
    return {"date": day, "close": 101.0, "open": open_, "Trading_Volume": volume}


def _raw(prices: list[dict[str, Any]]) -> RawMarketRows:
    return RawMarketRows(prices=prices, dividends=[], splits=[])


def test_open_and_volume_are_sorted_by_date_like_bars() -> None:
    opens, volumes = parse_open_volume(
        _raw([_row("2025-06-11", 102.0, 20), _row("2025-06-10", 101.0, 10)])
    )
    assert opens == (101.0, 102.0)
    assert volumes == (10.0, 20.0)


def test_zero_volume_is_allowed() -> None:
    _, volumes = parse_open_volume(_raw([_row("2025-06-10", volume=0)]))
    assert volumes == (0.0,)


@pytest.mark.parametrize(
    "open_", [None, 0.0, -1.0, True, float("nan"), float("inf"), 10**309, "100"]
)
def test_invalid_open_fails_with_value_error(open_: object) -> None:
    with pytest.raises(ValueError, match="open"):
        parse_open_volume(_raw([_row("2025-06-10", open_=open_)]))


@pytest.mark.parametrize("volume", [None, -1, True, float("nan"), float("inf"), 10**309, "5"])
def test_invalid_volume_fails_with_value_error(volume: object) -> None:
    with pytest.raises(ValueError, match="volume"):
        parse_open_volume(_raw([_row("2025-06-10", volume=volume)]))


def test_missing_date_fails_with_value_error() -> None:
    with pytest.raises(ValueError, match="date"):
        parse_open_volume(_raw([{"open": 1.0, "Trading_Volume": 1}]))
