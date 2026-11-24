"""Market data for offline backtests: FinMind fetch, local JSON cache, parsing.

Three anonymous-tier FinMind datasets are enough to reconstruct a total-return
holding path without the paid ``TaiwanStockPriceAdj`` dataset:

- ``TaiwanStockPrice``           raw daily close
- ``TaiwanStockDividendResult``  ex-dividend events (cash only)
- ``TaiwanStockSplitPrice``      share splits (e.g. 0050 1:4 on 2025-06-18)

Parsing fails loudly on anything the simulation cannot model faithfully
(stock dividends, unknown split types, non-positive closes, events after the
last bar) rather than silently producing a wrong result.
"""

from __future__ import annotations

import bisect
import json
import math
import os
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any, cast

from literati_stock.ingest.clients.finmind import FinMindClient

_CASH_DIVIDEND_KIND = "息"
_SPLIT_KINDS = frozenset({"分割", "反分割"})
# A whole-share exchange (n:1 split or 1:n reverse split) must be within 1%.
_SPLIT_SNAP_TOLERANCE = 0.01
# Cache files carry this format number and the date they were fetched on;
# anything else (including the unversioned round-1 format) is refetched.
_CACHE_FORMAT = 2
_RAW_FIELDS = ("prices", "dividends", "splits")


@dataclass(frozen=True)
class Bar:
    day: date
    close: float


@dataclass(frozen=True)
class MarketData:
    """Sorted daily bars; events keyed by the index of the bar they apply to."""

    bars: tuple[Bar, ...]
    dividends: dict[int, float]
    splits: dict[int, float]


@dataclass(frozen=True)
class RawMarketRows:
    prices: list[dict[str, Any]]
    dividends: list[dict[str, Any]]
    splits: list[dict[str, Any]]


def _bar_index_on_or_after(days: list[date], event_day: date, what: str) -> int:
    idx = bisect.bisect_left(days, event_day)
    if idx >= len(days):
        raise ValueError(f"{what} on {event_day} has no bar on or after it")
    return idx


def _row_date(row: dict[str, Any], what: str) -> date:
    value = row.get("date")
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise ValueError(f"missing or invalid {what} date in {row!r}")


def _parse_bars(rows: list[dict[str, Any]]) -> tuple[Bar, ...]:
    bars: list[Bar] = []
    for row in rows:
        close = row.get("close")
        if not isinstance(close, int | float) or not math.isfinite(close) or close <= 0:
            raise ValueError(f"invalid close {close!r} on {row.get('date')}")
        bars.append(Bar(day=_row_date(row, "price"), close=float(close)))
    bars.sort(key=lambda b: b.day)
    for prev, cur in zip(bars, bars[1:], strict=False):
        if prev.day == cur.day:
            raise ValueError(f"duplicate bar date {cur.day}")
    return tuple(bars)


def _finite_float(row: dict[str, Any], key: str, what: str) -> float:
    value = row.get(key)
    if not isinstance(value, int | float) or not math.isfinite(value):
        raise ValueError(f"invalid {what} {value!r} in {row!r}")
    return float(value)


def _split_ratio(before: float, after: float) -> float:
    """Snap a price ratio to an n:1 split or 1:n reverse split; reject anything else."""
    ratio = before / after
    if ratio >= 1.0:
        n = round(ratio)
        if abs(ratio / n - 1.0) <= _SPLIT_SNAP_TOLERANCE:
            return float(n)
    else:
        m = round(1.0 / ratio)
        if m >= 1 and abs((1.0 / ratio) / m - 1.0) <= _SPLIT_SNAP_TOLERANCE:
            return 1.0 / m
    raise ValueError(f"split ratio {ratio:.4f} is not a whole-share exchange")


def parse_market_data(raw: RawMarketRows) -> MarketData:
    bars = _parse_bars(raw.prices)
    days = [b.day for b in bars]

    dividends: dict[int, float] = {}
    for row in raw.dividends:
        if row.get("stock_or_cache_dividend") != _CASH_DIVIDEND_KIND:
            raise ValueError(f"only cash dividends are supported, got {row!r}")
        day = _row_date(row, "dividend")
        idx = _bar_index_on_or_after(days, day, "dividend")
        amount = _finite_float(row, "stock_and_cache_dividend", "dividend amount")
        if amount < 0:
            raise ValueError(f"invalid dividend amount {amount!r} in {row!r}")
        dividends[idx] = dividends.get(idx, 0.0) + amount

    splits: dict[int, float] = {}
    for row in raw.splits:
        if row.get("type") not in _SPLIT_KINDS:
            raise ValueError(f"unsupported split type in {row!r}")
        day = _row_date(row, "split")
        idx = _bar_index_on_or_after(days, day, "split")
        before = _finite_float(row, "before_price", "split price")
        after = _finite_float(row, "after_price", "split price")
        if before <= 0 or after <= 0:
            raise ValueError(f"invalid split price in {row!r}")
        ratio = _split_ratio(before, after)
        if (row["type"] == "分割") != (ratio > 1.0):
            raise ValueError(f"split type does not match price direction in {row!r}")
        splits[idx] = splits.get(idx, 1.0) * ratio

    if len(bars) < 2:
        raise ValueError(f"need at least 2 price bars to backtest, got {len(bars)}")
    return MarketData(bars=bars, dividends=dividends, splits=splits)


async def fetch_raw_rows(
    client: FinMindClient, stock_id: str, start: date, end: date
) -> RawMarketRows:
    kwargs = {"data_id": stock_id, "start_date": start.isoformat(), "end_date": end.isoformat()}
    return RawMarketRows(
        prices=await client.fetch("TaiwanStockPrice", **kwargs),
        dividends=await client.fetch("TaiwanStockDividendResult", **kwargs),
        splits=await client.fetch("TaiwanStockSplitPrice", **kwargs),
    )


def _read_cache(path: Path, end: date) -> RawMarketRows | None:
    """Return the cached rows, or ``None`` if the file is missing or untrustworthy.

    Trusted means: current format, valid UTF-8 JSON object, each field a list
    of row objects that ``parse_market_data`` accepts, and fetched strictly
    after ``end`` (so the range was already closed when it was fetched and
    cannot be an intraday snapshot).
    """
    try:
        loaded: Any = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except ValueError:  # JSONDecodeError and UnicodeDecodeError
        return None
    if not isinstance(loaded, dict):
        return None
    payload = cast("dict[str, Any]", loaded)
    if payload.get("format") != _CACHE_FORMAT:
        return None
    try:
        fetched_on = date.fromisoformat(str(payload.get("fetched_on")))
    except ValueError:
        return None
    if fetched_on <= end:
        return None
    fields: dict[str, list[dict[str, Any]]] = {}
    for name in _RAW_FIELDS:
        value: Any = payload.get(name)
        if not isinstance(value, list):
            return None
        rows = cast("list[Any]", value)
        if not all(isinstance(row, dict) for row in rows):
            return None
        fields[name] = cast("list[dict[str, Any]]", rows)
    raw = RawMarketRows(**fields)
    try:
        parse_market_data(raw)
    except ValueError:
        return None
    return raw


async def load_or_fetch(
    cache_dir: Path,
    stock_id: str,
    end: date,
    fetcher: Callable[[], Awaitable[RawMarketRows]],
    *,
    today: date,
    refresh: bool = False,
) -> RawMarketRows:
    """Return cached raw rows for ``(stock_id, end)`` or fetch and cache them.

    ``today`` is required (the caller's market-local date): a range ending on
    or after it may still gain bars, so it is always fetched and never cached.
    A cache file that is malformed, from an older format, rejected by
    ``parse_market_data``, or fetched on or before ``end`` is refetched and
    overwritten; fetched rows the parser rejects are returned but never
    cached, so a bad response is not pinned on disk. Writes go to a temp file in
    the same directory and are published with an atomic ``os.replace`` so
    readers never see half a file.
    """
    path = cache_dir / f"{stock_id}_{end.isoformat()}.json"
    still_open = end >= today
    if not refresh and not still_open:
        cached = _read_cache(path, end)
        if cached is not None:
            return cached
    raw = await fetcher()
    if still_open:
        return raw
    try:
        parse_market_data(raw)
    except ValueError:
        return raw
    cache_dir.mkdir(parents=True, exist_ok=True)
    payload = {"format": _CACHE_FORMAT, "fetched_on": today.isoformat(), **asdict(raw)}
    fd, tmp_name = tempfile.mkstemp(dir=cache_dir, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            json.dump(payload, tmp, ensure_ascii=False)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    return raw
