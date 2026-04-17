"""Tests for TaiwanStockMarginPurchaseShortSaleRow + EXPECTED_FIELDS."""

from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from literati_stock.ingest.schemas.finmind_raw import (
    EXPECTED_FIELDS,
    TaiwanStockMarginPurchaseShortSaleRow,
)

SAMPLE: dict[str, object] = {
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


def test_sample_validates() -> None:
    row = TaiwanStockMarginPurchaseShortSaleRow.model_validate(SAMPLE)
    assert row.stock_id == "2330"
    assert row.date == date(2026, 4, 15)
    assert row.MarginPurchaseTodayBalance == 26878


def test_missing_required_raises() -> None:
    bad = dict(SAMPLE)
    del bad["MarginPurchaseTodayBalance"]
    with pytest.raises(ValidationError):
        TaiwanStockMarginPurchaseShortSaleRow.model_validate(bad)


def test_expected_fields_registered() -> None:
    fields = EXPECTED_FIELDS["TaiwanStockMarginPurchaseShortSale"]
    assert "MarginPurchaseTodayBalance" in fields
    assert "ShortSaleYesterdayBalance" in fields
