"""Integration tests for universe sync + daily ingest services."""

from __future__ import annotations

from datetime import date
from typing import Any

import httpx
import pytest
import respx
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.core.settings import Settings
from literati_stock.ingest.clients.finmind import FINMIND_BASE_URL
from literati_stock.ingest.models import IngestFailure, IngestRaw
from literati_stock.universe.daily_ingest import DailyPriceIngestService
from literati_stock.universe.models import StockUniverse
from literati_stock.universe.service import UniverseSyncService

pytestmark = pytest.mark.integration


_INFO_ROWS = [
    {
        "date": "2026-04-17",
        "stock_id": "2330",
        "stock_name": "台積電",
        "industry_category": "半導體業",
        "type": "twse",
    },
    {
        "date": "2026-04-17",
        "stock_id": "9999",
        "stock_name": "新公司",
        "industry_category": "其他",
        "type": "tpex",
    },
    # Older snapshot for 2330 — dedup must pick the newer one.
    {
        "date": "2024-01-01",
        "stock_id": "2330",
        "stock_name": "台積電",
        "industry_category": "舊類別",
        "type": "twse",
    },
]


def _info_response(rows: list[dict[str, Any]]) -> httpx.Response:
    return httpx.Response(200, json={"status": 200, "msg": "success", "data": rows})


@respx.mock
async def test_seed_watchlist_applied_by_migration(
    session: AsyncSession,
) -> None:
    """Migration seeded 5 watchlist rows."""
    result = await session.execute(
        select(func.count()).select_from(StockUniverse).where(StockUniverse.in_watchlist.is_(True))
    )
    assert result.scalar_one() == 5


@respx.mock
async def test_sync_preserves_watchlist_flag(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    db_settings: Settings,
) -> None:
    respx.get(FINMIND_BASE_URL).mock(return_value=_info_response(_INFO_ROWS))

    svc = UniverseSyncService(session_factory, db_settings)
    result = await svc.sync()
    assert result.unique_stocks_upserted == 2

    # Flush the truncation context before reading: use a fresh session to see committed state.
    await session.commit()
    rows = (
        (
            await session.execute(
                select(StockUniverse).where(StockUniverse.stock_id.in_(["2330", "9999"]))
            )
        )
        .scalars()
        .all()
    )
    by_id = {r.stock_id: r for r in rows}
    assert by_id["2330"].in_watchlist is True  # seeded watchlist preserved
    # 2330's industry_category updated to the latest-dated row's value.
    assert by_id["2330"].industry_category == "半導體業"
    assert by_id["9999"].in_watchlist is False  # new stock defaults to false
    assert by_id["9999"].industry_category == "其他"


@respx.mock
async def test_sync_marks_missing_stock_inactive(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    db_settings: Settings,
) -> None:
    """A seeded stock not present in the new sync should be flipped inactive."""
    # Sync only returns 2330 and 9999; 2454 is seeded but absent from FinMind.
    respx.get(FINMIND_BASE_URL).mock(return_value=_info_response(_INFO_ROWS))

    svc = UniverseSyncService(session_factory, db_settings)
    await svc.sync()
    await session.commit()

    result = await session.execute(select(StockUniverse).where(StockUniverse.stock_id == "2454"))
    row = result.scalar_one()
    assert row.is_active is False


_PRICE_ROW = {
    "date": "2026-04-17",
    "stock_id": "2330",
    "Trading_Volume": 32_500_000,
    "Trading_money": 35_125_000_000,
    "open": "1080.00",
    "max": "1085.00",
    "min": "1075.00",
    "close": "1082.00",
    "spread": "3.00",
    "Trading_turnover": 12_345,
}


@respx.mock
async def test_daily_ingest_writes_per_watchlist_stock(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    db_settings: Settings,
) -> None:
    # Trim watchlist to two stocks so the test is deterministic.
    await session.execute(update(StockUniverse).values(in_watchlist=False))
    await session.execute(
        update(StockUniverse)
        .where(StockUniverse.stock_id.in_(["2330", "2454"]))
        .values(in_watchlist=True, is_active=True)
    )
    await session.commit()

    respx.get(FINMIND_BASE_URL).mock(
        return_value=httpx.Response(
            200, json={"status": 200, "msg": "success", "data": [_PRICE_ROW]}
        )
    )

    svc = DailyPriceIngestService(session_factory, db_settings)
    result = await svc.run(date(2026, 4, 17))

    assert result.stocks_attempted == 2
    assert result.raw_rows_written == 2
    assert result.failures_recorded == 0

    raw_count = await session.scalar(select(func.count()).select_from(IngestRaw))
    failure_count = await session.scalar(select(func.count()).select_from(IngestFailure))
    assert raw_count == 2
    assert failure_count == 0


@respx.mock
async def test_daily_ingest_continues_on_failure(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    db_settings: Settings,
) -> None:
    # One watchlist stock; FinMind permanently 5xx → failure recorded.
    await session.execute(update(StockUniverse).values(in_watchlist=False))
    await session.execute(
        update(StockUniverse)
        .where(StockUniverse.stock_id == "2330")
        .values(in_watchlist=True, is_active=True)
    )
    await session.commit()

    respx.get(FINMIND_BASE_URL).mock(return_value=httpx.Response(503, text="down"))

    svc = DailyPriceIngestService(
        session_factory,
        db_settings,
        retry_wait_initial=0.01,
        retry_wait_max=0.05,
        max_attempts=2,
    )
    result = await svc.run(date(2026, 4, 17))

    assert result.stocks_attempted == 1
    assert result.raw_rows_written == 0
    assert result.failures_recorded == 1
