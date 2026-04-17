"""Tests for `TaiwanStockInfoRow` schema + EXPECTED_FIELDS entry."""

from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from literati_stock.ingest.schemas.finmind_raw import (
    EXPECTED_FIELDS,
    TaiwanStockInfoRow,
)

SAMPLE: dict[str, object] = {
    "date": "2026-04-17",
    "stock_id": "2330",
    "stock_name": "台積電",
    "industry_category": "半導體業",
    "type": "twse",
}


def test_sample_validates() -> None:
    row = TaiwanStockInfoRow.model_validate(SAMPLE)
    assert row.stock_id == "2330"
    assert row.stock_name == "台積電"
    assert row.industry_category == "半導體業"
    assert row.type == "twse"
    assert row.date == date(2026, 4, 17)


def test_missing_required_field_raises() -> None:
    bad = dict(SAMPLE)
    del bad["type"]
    with pytest.raises(ValidationError):
        TaiwanStockInfoRow.model_validate(bad)


def test_empty_industry_preserved() -> None:
    row = TaiwanStockInfoRow.model_validate({**SAMPLE, "industry_category": ""})
    assert row.industry_category == ""


def test_expected_fields_contains_taiwan_stock_info() -> None:
    fields = EXPECTED_FIELDS["TaiwanStockInfo"]
    assert fields == frozenset({"date", "stock_id", "stock_name", "industry_category", "type"})
