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
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any

from literati_stock.ingest.clients.finmind import FinMindClient

_CASH_DIVIDEND_KIND = "息"
_SPLIT_KINDS = frozenset({"分割", "反分割"})


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


def _parse_bars(rows: list[dict[str, Any]]) -> tuple[Bar, ...]:
    bars: list[Bar] = []
    for row in rows:
        close = row.get("close")
        if not isinstance(close, int | float) or close <= 0:
            raise ValueError(f"invalid close {close!r} on {row.get('date')}")
        bars.append(Bar(day=date.fromisoformat(str(row["date"])), close=float(close)))
    bars.sort(key=lambda b: b.day)
    for prev, cur in zip(bars, bars[1:], strict=False):
        if prev.day == cur.day:
            raise ValueError(f"duplicate bar date {cur.day}")
    return tuple(bars)


def parse_market_data(raw: RawMarketRows) -> MarketData:
    bars = _parse_bars(raw.prices)
    days = [b.day for b in bars]

    dividends: dict[int, float] = {}
    for row in raw.dividends:
        if row.get("stock_or_cache_dividend") != _CASH_DIVIDEND_KIND:
            raise ValueError(f"only cash dividends are supported, got {row!r}")
        day = date.fromisoformat(str(row["date"]))
        idx = _bar_index_on_or_after(days, day, "dividend")
        dividends[idx] = dividends.get(idx, 0.0) + float(row["stock_and_cache_dividend"])

    splits: dict[int, float] = {}
    for row in raw.splits:
        if row.get("type") not in _SPLIT_KINDS:
            raise ValueError(f"unsupported split type in {row!r}")
        day = date.fromisoformat(str(row["date"]))
        idx = _bar_index_on_or_after(days, day, "split")
        ratio = round(float(row["before_price"]) / float(row["after_price"]), 2)
        splits[idx] = splits.get(idx, 1.0) * ratio

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


async def load_or_fetch(
    cache_dir: Path,
    stock_id: str,
    end: date,
    fetcher: Callable[[], Awaitable[RawMarketRows]],
    *,
    refresh: bool = False,
) -> RawMarketRows:
    """Return cached raw rows for ``(stock_id, end)`` or fetch and cache them."""
    path = cache_dir / f"{stock_id}_{end.isoformat()}.json"
    if path.exists() and not refresh:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return RawMarketRows(**payload)
    raw = await fetcher()
    cache_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(raw), ensure_ascii=False), encoding="utf-8")
    return raw
