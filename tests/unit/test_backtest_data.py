"""Unit tests for the backtest market-data parser and cache."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from literati_stock.backtest.data import (
    RawMarketRows,
    load_or_fetch,
    parse_market_data,
)

AFTER = date(2025, 7, 1)  # a "today" strictly after the 2025-06-30 cache range


def _price(day: str, close: float) -> dict[str, Any]:
    return {"date": day, "stock_id": "0050", "close": close}


def _dividend(day: str, amount: float, kind: str = "息") -> dict[str, Any]:
    return {
        "date": day,
        "stock_id": "0050",
        "stock_and_cache_dividend": amount,
        "stock_or_cache_dividend": kind,
    }


def _split(day: str, before: float, after: float, kind: str = "分割") -> dict[str, Any]:
    return {
        "date": day,
        "stock_id": "0050",
        "type": kind,
        "before_price": before,
        "after_price": after,
    }


def _raw(
    prices: list[dict[str, Any]],
    dividends: list[dict[str, Any]] | None = None,
    splits: list[dict[str, Any]] | None = None,
) -> RawMarketRows:
    return RawMarketRows(prices=prices, dividends=dividends or [], splits=splits or [])


def test_parse_sorts_bars_and_maps_events_to_bars() -> None:
    data = parse_market_data(
        _raw(
            [_price("2025-06-18", 47.57), _price("2025-06-10", 188.65), _price("2025-07-01", 50.0)],
            dividends=[_dividend("2025-07-01", 0.5)],
            splits=[_split("2025-06-18", 188.65, 47.16)],
        )
    )
    assert [b.day for b in data.bars] == [date(2025, 6, 10), date(2025, 6, 18), date(2025, 7, 1)]
    assert data.splits == {1: 4.0}
    assert data.dividends == {2: 0.5}


def test_event_on_non_trading_day_maps_to_next_bar() -> None:
    data = parse_market_data(
        _raw(
            [_price("2025-06-10", 100.0), _price("2025-06-12", 101.0)],
            dividends=[_dividend("2025-06-11", 1.0)],
        )
    )
    assert data.dividends == {1: 1.0}


def test_event_after_last_bar_fails_loudly() -> None:
    with pytest.raises(ValueError, match="no bar on or after"):
        parse_market_data(
            _raw([_price("2025-06-10", 100.0)], dividends=[_dividend("2025-06-11", 1.0)])
        )


def test_non_cash_dividend_fails_loudly() -> None:
    with pytest.raises(ValueError, match="cash dividend"):
        parse_market_data(
            _raw([_price("2025-06-10", 100.0)], dividends=[_dividend("2025-06-10", 1.0, kind="權")])
        )


@pytest.mark.parametrize("close", [0.0, -1.0, None])
def test_non_positive_or_missing_close_fails_loudly(close: float | None) -> None:
    with pytest.raises(ValueError, match="close"):
        parse_market_data(_raw([_price("2025-06-10", close)]))  # type: ignore[arg-type]


def test_unknown_split_type_fails_loudly() -> None:
    with pytest.raises(ValueError, match="split type"):
        parse_market_data(
            _raw([_price("2025-06-10", 100.0)], splits=[_split("2025-06-10", 100, 50, kind="減資")])
        )


def test_duplicate_bar_date_fails_loudly() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        parse_market_data(_raw([_price("2025-06-10", 100.0), _price("2025-06-10", 101.0)]))


async def test_load_or_fetch_uses_cache_on_second_call(tmp_path: Path) -> None:
    calls: list[int] = []
    raw = _raw([_price("2025-06-10", 100.0)])

    async def fetcher() -> RawMarketRows:
        calls.append(1)
        return raw

    first = await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), fetcher, today=AFTER)
    second = await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), fetcher, today=AFTER)
    assert first == raw
    assert second == raw
    assert len(calls) == 1


async def test_load_or_fetch_refresh_bypasses_cache(tmp_path: Path) -> None:
    calls: list[int] = []

    async def fetcher() -> RawMarketRows:
        calls.append(1)
        return _raw([_price("2025-06-10", 100.0)])

    await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), fetcher, today=AFTER)
    await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), fetcher, refresh=True, today=AFTER)
    assert len(calls) == 2


# --- review round 1 (F2/F4/F5/F6/F7) -----------------------------------------


@pytest.mark.parametrize("prices", [[], [_price("2025-06-10", 100.0)]])
def test_fewer_than_two_bars_fails_loudly(prices: list[dict[str, Any]]) -> None:
    with pytest.raises(ValueError, match="at least 2 price bars"):
        parse_market_data(_raw(prices))


@pytest.mark.parametrize("close", [float("nan"), float("inf")])
def test_non_finite_close_fails_loudly(close: float) -> None:
    with pytest.raises(ValueError, match="close"):
        parse_market_data(_raw([_price("2025-06-10", close), _price("2025-06-11", 1.0)]))


@pytest.mark.parametrize("amount", [float("nan"), float("inf"), -1.0])
def test_invalid_dividend_amount_fails_loudly(amount: float) -> None:
    with pytest.raises(ValueError, match="dividend amount"):
        parse_market_data(
            _raw(
                [_price("2025-06-10", 100.0), _price("2025-06-11", 100.0)],
                dividends=[_dividend("2025-06-11", amount)],
            )
        )


@pytest.mark.parametrize(("before", "after"), [(100.0, 0.0), (float("nan"), 50.0), (100.0, -1.0)])
def test_invalid_split_prices_fail_loudly(before: float, after: float) -> None:
    with pytest.raises(ValueError, match="split price"):
        parse_market_data(
            _raw(
                [_price("2025-06-10", 100.0), _price("2025-06-11", 50.0)],
                splits=[_split("2025-06-11", before, after)],
            )
        )


@pytest.mark.parametrize(
    ("before", "after", "kind", "expected"),
    [(188.65, 47.16, "分割", 4.0), (100.0, 300.0, "反分割", 1.0 / 3.0)],
)
def test_split_ratio_snaps_to_whole_share_exchange(
    before: float, after: float, kind: str, expected: float
) -> None:
    data = parse_market_data(
        _raw(
            [_price("2025-06-10", before), _price("2025-06-11", after)],
            splits=[_split("2025-06-11", before, after, kind=kind)],
        )
    )
    assert data.splits[1] == pytest.approx(expected, rel=1e-12)


def test_split_ratio_that_is_not_a_whole_exchange_fails_loudly() -> None:
    with pytest.raises(ValueError, match="split ratio"):
        parse_market_data(
            _raw(
                [_price("2025-06-10", 100.0), _price("2025-06-11", 40.0)],
                splits=[_split("2025-06-11", 100.0, 40.0)],
            )
        )


async def test_load_or_fetch_never_reuses_cache_for_today_or_later(tmp_path: Path) -> None:
    calls: list[int] = []

    async def fetcher() -> RawMarketRows:
        calls.append(1)
        return _raw([_price("2025-06-10", 100.0)])

    today = date(2025, 6, 30)
    await load_or_fetch(tmp_path, "0050", today, fetcher, today=today)
    await load_or_fetch(tmp_path, "0050", today, fetcher, today=today)
    assert len(calls) == 2
    await load_or_fetch(tmp_path, "0050", date(2025, 6, 27), fetcher, today=today)
    await load_or_fetch(tmp_path, "0050", date(2025, 6, 27), fetcher, today=today)
    assert len(calls) == 3


async def test_load_or_fetch_refetches_when_cache_is_corrupt(tmp_path: Path) -> None:
    (tmp_path / "0050_2025-06-30.json").write_text('{"prices": [', encoding="utf-8")
    raw = _raw([_price("2025-06-10", 100.0)])

    async def fetcher() -> RawMarketRows:
        return raw

    assert await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), fetcher, today=AFTER) == raw
    assert await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), fetcher, today=AFTER) == raw


async def test_failed_cache_write_keeps_previous_file_readable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old = _raw([_price("2025-06-10", 100.0)])

    async def old_fetcher() -> RawMarketRows:
        return old

    await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), old_fetcher, today=AFTER)

    async def new_fetcher() -> RawMarketRows:
        return _raw([_price("2025-06-11", 101.0)])

    import literati_stock.backtest.data as data_module

    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(data_module.os, "replace", boom)
    with pytest.raises(OSError, match="disk full"):
        await load_or_fetch(
            tmp_path, "0050", date(2025, 6, 30), new_fetcher, refresh=True, today=AFTER
        )
    monkeypatch.undo()

    async def unused() -> RawMarketRows:
        raise AssertionError("cache should be used")

    assert await load_or_fetch(tmp_path, "0050", date(2025, 6, 30), unused, today=AFTER) == old
    assert [p.name for p in tmp_path.iterdir()] == ["0050_2025-06-30.json"]


# --- review round 2 (F1/F2/F3) -----------------------------------------------

_CACHE_END = date(2025, 6, 30)
_CACHE_NAME = "0050_2025-06-30.json"


def _counting_fetcher(
    raw: RawMarketRows,
) -> tuple[list[int], Callable[[], Awaitable[RawMarketRows]]]:
    calls: list[int] = []

    async def fetcher() -> RawMarketRows:
        calls.append(1)
        return raw

    return calls, fetcher


async def test_load_or_fetch_requires_explicit_today(tmp_path: Path) -> None:
    _, fetcher = _counting_fetcher(_raw([_price("2025-06-10", 100.0)]))
    with pytest.raises(TypeError, match="today"):
        await load_or_fetch(tmp_path, "0050", _CACHE_END, fetcher)  # pyright: ignore[reportCallIssue]


async def test_legacy_cache_without_fetch_date_is_refetched_once(tmp_path: Path) -> None:
    # The round-1 code wrote bare rows with no fetch date, possibly mid-session.
    intraday = {"prices": [_price("2025-06-30", 99.0)], "dividends": [], "splits": []}
    (tmp_path / _CACHE_NAME).write_text(json.dumps(intraday), encoding="utf-8")
    complete = _raw([_price("2025-06-27", 98.0), _price("2025-06-30", 100.0)])
    calls, fetcher = _counting_fetcher(complete)

    assert await load_or_fetch(tmp_path, "0050", _CACHE_END, fetcher, today=AFTER) == complete
    assert await load_or_fetch(tmp_path, "0050", _CACHE_END, fetcher, today=AFTER) == complete
    assert len(calls) == 1


async def test_cache_fetched_on_or_before_end_is_never_trusted(tmp_path: Path) -> None:
    stale = {
        "format": 2,
        "fetched_on": "2025-06-30",
        "prices": [_price("2025-06-30", 99.0)],
        "dividends": [],
        "splits": [],
    }
    (tmp_path / _CACHE_NAME).write_text(json.dumps(stale), encoding="utf-8")
    complete = _raw([_price("2025-06-27", 98.0), _price("2025-06-30", 100.0)])
    calls, fetcher = _counting_fetcher(complete)

    assert await load_or_fetch(tmp_path, "0050", _CACHE_END, fetcher, today=AFTER) == complete
    assert len(calls) == 1


@pytest.mark.parametrize(
    "payload",
    [
        b'{"format": 2, "fetched_on": "2025-07-01", "prices": null, "dividends": [], "splits": []}',
        b'{"format": 2, "fetched_on": "2025-07-01", "prices": [1], "dividends": [], "splits": []}',
        b'{"format": 2, "fetched_on": "2025-07-01", "prices": [], "dividends": {}, "splits": []}',
        b'{"format": 2, "fetched_on": "not-a-date", "prices": [], "dividends": [], "splits": []}',
        b'{"format": 2, "fetched_on": "2025-07-01", "prices": []}',
        b"[]",
        b"\xff\xfe not utf-8",
    ],
)
async def test_malformed_cache_is_refetched_and_repaired(tmp_path: Path, payload: bytes) -> None:
    (tmp_path / _CACHE_NAME).write_bytes(payload)
    raw = _raw([_price("2025-06-10", 100.0)])
    calls, fetcher = _counting_fetcher(raw)

    assert await load_or_fetch(tmp_path, "0050", _CACHE_END, fetcher, today=AFTER) == raw
    assert await load_or_fetch(tmp_path, "0050", _CACHE_END, fetcher, today=AFTER) == raw
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("before", "after", "kind"),
    [(188.65, 47.16, "反分割"), (100.0, 300.0, "分割")],
)
def test_split_type_must_match_price_direction(before: float, after: float, kind: str) -> None:
    with pytest.raises(ValueError, match="direction"):
        parse_market_data(
            _raw(
                [_price("2025-06-10", before), _price("2025-06-11", after)],
                splits=[_split("2025-06-11", before, after, kind=kind)],
            )
        )
