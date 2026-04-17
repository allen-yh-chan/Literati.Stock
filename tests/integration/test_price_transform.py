"""Integration tests for `PriceTransformService` against real PostgreSQL."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.ingest.models import IngestRaw
from literati_stock.price.models import IngestCursor, StockPrice
from literati_stock.price.transform import PriceTransformService

pytestmark = pytest.mark.integration


_SAMPLE_ROW: dict[str, Any] = {
    "date": "2025-01-02",
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


def _row(**overrides: Any) -> dict[str, Any]:
    row = dict(_SAMPLE_ROW)
    row.update(overrides)
    return row


async def _insert_raw(session: AsyncSession, payload: list[dict[str, Any]]) -> int:
    raw = IngestRaw(
        dataset="TaiwanStockPrice",
        request_args={"data_id": "2330"},
        payload=payload,
    )
    session.add(raw)
    await session.flush()
    return raw.id


async def test_cold_start_processes_all(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    raw_id = await _insert_raw(session, [_row()])
    await session.commit()

    service = PriceTransformService(session_factory)
    result = await service.process_new()

    assert result.raw_rows_processed == 1
    assert result.price_upserts == 1
    assert result.cursor_advanced_to == raw_id

    count = await session.scalar(select(func.count()).select_from(StockPrice))
    assert count == 1

    price = (await session.execute(select(StockPrice))).scalar_one()
    assert price.stock_id == "2330"
    assert price.high == Decimal("1085.00")
    assert price.low == Decimal("1075.00")
    assert price.volume == 32_500_000
    assert price.amount == 35_125_000_000
    assert price.turnover == 12_345
    assert price.source_raw_id == raw_id


async def test_rerun_is_noop(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _insert_raw(session, [_row()])
    await session.commit()

    service = PriceTransformService(session_factory)
    await service.process_new()
    second = await service.process_new()

    assert second.raw_rows_processed == 0
    assert second.price_upserts == 0

    count = await session.scalar(select(func.count()).select_from(StockPrice))
    assert count == 1


async def test_new_raw_only_processes_diff(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    first_raw = await _insert_raw(session, [_row()])
    await session.commit()

    service = PriceTransformService(session_factory)
    await service.process_new()

    second_raw = await _insert_raw(session, [_row(stock_id="2454", date="2025-01-02")])
    await session.commit()

    result = await service.process_new()
    assert result.raw_rows_processed == 1
    assert result.price_upserts == 1
    assert result.cursor_advanced_to == second_raw
    assert second_raw > first_raw

    count = await session.scalar(select(func.count()).select_from(StockPrice))
    assert count == 2


async def test_upsert_overwrites_on_conflict(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _insert_raw(session, [_row(close="1082.00")])
    await session.commit()

    service = PriceTransformService(session_factory)
    await service.process_new()

    await _insert_raw(session, [_row(close="1090.00")])
    await session.commit()

    await service.process_new()

    count = await session.scalar(select(func.count()).select_from(StockPrice))
    assert count == 1
    price = (await session.execute(select(StockPrice))).scalar_one()
    assert price.close == Decimal("1090.00")


async def test_cursor_row_upserted(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    raw_id = await _insert_raw(session, [_row()])
    await session.commit()

    service = PriceTransformService(session_factory)
    await service.process_new()

    cursor = await session.scalar(
        select(IngestCursor).where(IngestCursor.dataset == "TaiwanStockPrice")
    )
    assert cursor is not None
    assert cursor.last_raw_id == raw_id


async def test_transform_failure_rolls_back_cursor_and_prices(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """If parsing fails mid-batch, cursor advance and all upserts must rollback."""
    # First raw row is valid; second has corrupted stock_id that fails min_length=4
    raw_id_good = await _insert_raw(session, [_row(stock_id="2330")])
    await _insert_raw(session, [_row(stock_id="X")])  # will fail validation
    await session.commit()

    service = PriceTransformService(session_factory)

    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        await service.process_new()

    # Rollback verified: no prices landed, cursor still at 0
    count = await session.scalar(select(func.count()).select_from(StockPrice))
    assert count == 0
    cursor = await session.scalar(
        select(IngestCursor).where(IngestCursor.dataset == "TaiwanStockPrice")
    )
    assert cursor is None  # never committed
    # and the first good raw still exists so we can retry after fixing source
    existing = await session.scalar(select(IngestRaw).where(IngestRaw.id == raw_id_good))
    assert existing is not None
