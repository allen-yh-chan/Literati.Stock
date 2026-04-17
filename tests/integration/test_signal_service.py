"""Integration tests for `SignalEvaluationService`."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.ingest.models import IngestRaw
from literati_stock.price.models import StockPrice
from literati_stock.signal.models import SignalEvent
from literati_stock.signal.rules.volume_surge_red import VolumeSurgeRedSignal
from literati_stock.signal.service import SignalEvaluationService

pytestmark = pytest.mark.integration

START_DATE = date(2026, 3, 1)


async def _seed_prices(
    session: AsyncSession,
    stock_id: str,
    days: int,
    *,
    base_volume: int,
    surge_on_last_day: bool = False,
) -> None:
    """Insert `days` consecutive trading days of price data for one stock.

    Generates a parent `ingest_raw` row first (to satisfy the FK) and sets
    `source_raw_id` on each `stock_price` row.
    """
    raw = IngestRaw(
        dataset="TaiwanStockPrice",
        request_args={"data_id": stock_id},
        payload=[],
    )
    session.add(raw)
    await session.flush()
    raw_id = raw.id

    for i in range(days):
        d = START_DATE + timedelta(days=i)
        is_last = i == days - 1
        volume = base_volume * 5 if (is_last and surge_on_last_day) else base_volume
        open_price = Decimal("100")
        close_price = Decimal("115") if (is_last and surge_on_last_day) else Decimal("101")
        session.add(
            StockPrice(
                stock_id=stock_id,
                trade_date=d,
                open=open_price,
                high=close_price + Decimal("1"),
                low=open_price - Decimal("1"),
                close=close_price,
                spread=close_price - open_price,
                volume=volume,
                amount=volume * 100,
                turnover=1000,
                source_raw_id=raw_id,
            )
        )
    await session.flush()


async def test_fetch_prices_computes_ma_volume(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_prices(session, "2330", days=25, base_volume=10_000_000)
    await session.commit()

    as_of = START_DATE + timedelta(days=24)
    svc = SignalEvaluationService(session_factory)
    rows = await svc.fetch_prices(as_of, window_days=20)

    on_last_day = [r for r in rows if r.trade_date == as_of]
    assert len(on_last_day) == 1
    row = on_last_day[0]
    # All base_volume → MA should be equal to base_volume once window is full.
    assert row.ma_volume is not None
    assert row.ma_volume == Decimal("10000000.0000000000000000")


async def test_fetch_prices_is_look_ahead_safe(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_prices(session, "2454", days=30, base_volume=5_000_000)
    await session.commit()

    as_of = START_DATE + timedelta(days=15)
    svc = SignalEvaluationService(session_factory)
    rows = await svc.fetch_prices(as_of, window_days=20)

    assert all(r.trade_date <= as_of for r in rows)
    assert max(r.trade_date for r in rows) == as_of


async def test_evaluate_emits_and_upserts(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_prices(session, "2317", days=25, base_volume=8_000_000, surge_on_last_day=True)
    await session.commit()

    as_of = START_DATE + timedelta(days=24)
    svc = SignalEvaluationService(session_factory)
    signal = VolumeSurgeRedSignal()

    events = await svc.evaluate(signal, as_of)
    assert len(events) == 1
    assert events[0].stock_id == "2317"

    count_first = await session.scalar(select(func.count()).select_from(SignalEvent))
    assert count_first == 1

    # Re-running with same data should upsert (not duplicate)
    await svc.evaluate(signal, as_of)
    count_second = await session.scalar(select(func.count()).select_from(SignalEvent))
    assert count_second == 1


async def test_backfill_processes_trading_days(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_prices(session, "2412", days=25, base_volume=8_000_000, surge_on_last_day=True)
    await session.commit()

    svc = SignalEvaluationService(session_factory)
    signal = VolumeSurgeRedSignal()

    start = START_DATE
    end = START_DATE + timedelta(days=24)
    days_processed, events_emitted = await svc.backfill(signal, start, end)

    assert days_processed == 25  # one row per day seeded
    assert events_emitted == 1  # only the last day triggers surge


async def test_backfill_rejects_inverted_range(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = SignalEvaluationService(session_factory)
    signal = VolumeSurgeRedSignal()

    with pytest.raises(ValueError):
        await svc.backfill(signal, date(2026, 4, 2), date(2026, 4, 1))
