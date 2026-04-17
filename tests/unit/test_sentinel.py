"""Tests for `literati_stock.ingest.sentinel`."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from literati_stock.ingest.sentinel import (
    SchemaDriftError,
    SchemaSentinel,
    SentinelEmptyResponseError,
)

_EXPECTED_PRICE_KEYS: list[str] = [
    "date",
    "stock_id",
    "Trading_Volume",
    "Trading_money",
    "open",
    "max",
    "min",
    "close",
    "spread",
    "Trading_turnover",
]


def _make_row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {k: None for k in _EXPECTED_PRICE_KEYS}
    row.update(overrides)
    return row


async def test_fields_match_returns_none() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[_make_row()])
    sentinel = SchemaSentinel(client)
    result = await sentinel.check("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    assert result is None


async def test_missing_field_raises_drift() -> None:
    row = _make_row()
    del row["spread"]
    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[row])
    sentinel = SchemaSentinel(client)
    with pytest.raises(SchemaDriftError) as exc_info:
        await sentinel.check("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    assert exc_info.value.removed == frozenset({"spread"})
    assert exc_info.value.added == frozenset()


async def test_extra_field_raises_drift() -> None:
    row = _make_row(unexpected_field=42)
    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[row])
    sentinel = SchemaSentinel(client)
    with pytest.raises(SchemaDriftError) as exc_info:
        await sentinel.check("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    assert exc_info.value.added == frozenset({"unexpected_field"})
    assert exc_info.value.removed == frozenset()


async def test_empty_response_raises_empty_error() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[])
    sentinel = SchemaSentinel(client)
    with pytest.raises(SentinelEmptyResponseError):
        await sentinel.check("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")


async def test_unknown_dataset_raises_key_error() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[{}])
    sentinel = SchemaSentinel(client)
    with pytest.raises(KeyError):
        await sentinel.check("NonExistentDataset", data_id="2330", start_date="2025-01-02")
