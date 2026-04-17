"""Integration test for `literati-ingest transform-prices`."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from literati_stock.core.settings import Settings
from literati_stock.ingest.cli import _transform_prices
from literati_stock.ingest.models import IngestRaw
from literati_stock.price.models import StockPrice

pytestmark = pytest.mark.integration


_ROW: dict[str, Any] = {
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


async def test_transform_prices_cli_processes_all(
    session: AsyncSession, db_settings: Settings
) -> None:
    for sid in ("2330", "2454", "2303"):
        raw = IngestRaw(
            dataset="TaiwanStockPrice",
            request_args={"data_id": sid},
            payload=[dict(_ROW, stock_id=sid)],
        )
        session.add(raw)
    await session.commit()

    result = await _transform_prices(db_settings)

    assert result.raw_rows_processed == 3
    assert result.price_upserts == 3

    count = await session.scalar(select(func.count()).select_from(StockPrice))
    assert count == 3
