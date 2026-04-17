"""Integration tests for chip transforms against real PostgreSQL."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.chip.models import InstitutionalBuysell, MarginTransaction
from literati_stock.chip.transform import (
    InstitutionalTransformService,
    MarginTransformService,
)
from literati_stock.ingest.models import IngestRaw

pytestmark = pytest.mark.integration


_INSTITUTIONAL_PAYLOAD: list[dict[str, Any]] = [
    {
        "date": "2026-04-15",
        "stock_id": "2330",
        "buy": 1_000_000,
        "sell": 400_000,
        "name": "Foreign_Investor",
    },
    {
        "date": "2026-04-15",
        "stock_id": "2330",
        "buy": 200_000,
        "sell": 150_000,
        "name": "Investment_Trust",
    },
    {
        "date": "2026-04-15",
        "stock_id": "2330",
        "buy": 100_000,
        "sell": 80_000,
        "name": "Dealer_self",
    },
    {
        "date": "2026-04-15",
        "stock_id": "2330",
        "buy": 50_000,
        "sell": 30_000,
        "name": "Dealer_Hedging",
    },
    {"date": "2026-04-15", "stock_id": "2330", "buy": 0, "sell": 0, "name": "Foreign_Dealer_Self"},
]


_MARGIN_PAYLOAD: list[dict[str, Any]] = [
    {
        "date": "2026-04-15",
        "stock_id": "2330",
        "MarginPurchaseBuy": 851,
        "MarginPurchaseSell": 1259,
        "MarginPurchaseTodayBalance": 26878,
        "MarginPurchaseYesterdayBalance": 27298,
        "ShortSaleBuy": 4,
        "ShortSaleSell": 29,
        "ShortSaleTodayBalance": 96,
        "ShortSaleYesterdayBalance": 71,
    }
]


async def test_institutional_transform_aggregates_investor_types(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    raw = IngestRaw(
        dataset="TaiwanStockInstitutionalInvestorsBuySell",
        request_args={"data_id": "2330"},
        payload=_INSTITUTIONAL_PAYLOAD,
    )
    session.add(raw)
    await session.commit()

    svc = InstitutionalTransformService(session_factory)
    result = await svc.process_new()
    assert result.raw_rows_processed == 1
    assert result.domain_upserts == 1

    row = (await session.execute(select(InstitutionalBuysell))).scalar_one()
    assert row.stock_id == "2330"
    # Foreign = 1_000_000 - 400_000 = 600_000
    assert row.foreign_net == 600_000
    # Trust = 200_000 - 150_000 = 50_000
    assert row.trust_net == 50_000
    # Dealer = (100_000 - 80_000) + (50_000 - 30_000) + 0 = 40_000
    assert row.dealer_net == 40_000
    assert row.total_net == 690_000


async def test_institutional_transform_rerun_is_noop(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    session.add(
        IngestRaw(
            dataset="TaiwanStockInstitutionalInvestorsBuySell",
            request_args={"data_id": "2330"},
            payload=_INSTITUTIONAL_PAYLOAD,
        )
    )
    await session.commit()

    svc = InstitutionalTransformService(session_factory)
    await svc.process_new()
    second = await svc.process_new()
    assert second.raw_rows_processed == 0

    count = await session.scalar(select(func.count()).select_from(InstitutionalBuysell))
    assert count == 1


async def test_margin_transform_one_to_one(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    session.add(
        IngestRaw(
            dataset="TaiwanStockMarginPurchaseShortSale",
            request_args={"data_id": "2330"},
            payload=_MARGIN_PAYLOAD,
        )
    )
    await session.commit()

    svc = MarginTransformService(session_factory)
    result = await svc.process_new()
    assert result.raw_rows_processed == 1
    assert result.domain_upserts == 1

    row = (await session.execute(select(MarginTransaction))).scalar_one()
    assert row.stock_id == "2330"
    assert row.margin_today_balance == 26878
    assert row.short_today_balance == 96
