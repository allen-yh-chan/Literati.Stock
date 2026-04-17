"""Integration tests for `literati_stock.ingest.storage`."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from literati_stock.ingest.models import IngestFailure, IngestRaw
from literati_stock.ingest.storage import FailureRecorder, RawPayloadStore

pytestmark = pytest.mark.integration


async def _count(session: AsyncSession, model: type) -> int:
    result = await session.execute(select(func.count()).select_from(model))
    return result.scalar_one()


async def test_raw_payload_store_persists_payload(session: AsyncSession) -> None:
    store = RawPayloadStore(session)
    row_id = await store.record(
        dataset="TaiwanStockPrice",
        request_args={"data_id": "2330", "start_date": "2025-01-02"},
        payload=[{"stock_id": "2330", "close": "1082.00"}],
    )
    assert row_id > 0
    assert await _count(session, IngestRaw) == 1
    assert await _count(session, IngestFailure) == 0

    result = await session.execute(select(IngestRaw).where(IngestRaw.id == row_id))
    persisted = result.scalar_one()
    assert persisted.dataset == "TaiwanStockPrice"
    assert persisted.request_args == {"data_id": "2330", "start_date": "2025-01-02"}
    assert persisted.payload == [{"stock_id": "2330", "close": "1082.00"}]
    assert persisted.fetched_at is not None


async def test_failure_recorder_captures_exception(session: AsyncSession) -> None:
    recorder = FailureRecorder(session)
    try:
        raise RuntimeError("5 attempts exhausted")
    except RuntimeError as exc:
        row_id = await recorder.record(
            dataset="TaiwanStockPrice",
            request_args={"data_id": "2330", "start_date": "2025-01-02"},
            exc=exc,
            attempts=5,
        )

    assert row_id > 0
    assert await _count(session, IngestFailure) == 1
    assert await _count(session, IngestRaw) == 0

    result = await session.execute(select(IngestFailure).where(IngestFailure.id == row_id))
    persisted = result.scalar_one()
    assert persisted.dataset == "TaiwanStockPrice"
    assert persisted.error_class == "RuntimeError"
    assert persisted.error_message == "5 attempts exhausted"
    assert persisted.attempts == 5
    assert "RuntimeError: 5 attempts exhausted" in persisted.traceback
    assert persisted.traceback.strip().startswith("Traceback")
