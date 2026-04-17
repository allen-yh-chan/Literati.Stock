"""Integration test for `literati-ingest run-once` end-to-end."""

from __future__ import annotations

import httpx
import pytest
import respx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from literati_stock.core.settings import Settings
from literati_stock.ingest.cli import _run_once
from literati_stock.ingest.clients.finmind import FINMIND_BASE_URL
from literati_stock.ingest.models import IngestRaw

pytestmark = pytest.mark.integration


@respx.mock
async def test_run_once_writes_ingest_raw(db_settings: Settings, session: AsyncSession) -> None:
    sample_payload = [
        {
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
    ]
    respx.get(FINMIND_BASE_URL).mock(
        return_value=httpx.Response(
            200, json={"status": 200, "msg": "success", "data": sample_payload}
        )
    )

    row_id = await _run_once(
        settings=db_settings,
        dataset="TaiwanStockPrice",
        data_id="2330",
        start="2025-01-02",
        end=None,
    )
    assert row_id > 0

    total = await session.execute(select(func.count()).select_from(IngestRaw))
    assert total.scalar_one() >= 1

    persisted = await session.execute(select(IngestRaw).where(IngestRaw.id == row_id))
    row = persisted.scalar_one()
    assert row.dataset == "TaiwanStockPrice"
    assert row.request_args == {
        "data_id": "2330",
        "start_date": "2025-01-02",
        "end_date": None,
    }
    assert row.payload == sample_payload
