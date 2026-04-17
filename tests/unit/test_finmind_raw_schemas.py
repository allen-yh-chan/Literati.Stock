"""Tests for `literati_stock.ingest.schemas.finmind_raw`."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from pydantic import ValidationError

from literati_stock.ingest.schemas.finmind_raw import (
    EXPECTED_FIELDS,
    TaiwanStockInstitutionalInvestorsBuySellRow,
    TaiwanStockPriceRow,
)

SAMPLE_PRICE_ROW: dict[str, object] = {
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


def test_sample_payload_validates() -> None:
    row = TaiwanStockPriceRow.model_validate(SAMPLE_PRICE_ROW)
    assert row.stock_id == "2330"
    assert row.date == date(2025, 1, 2)
    assert row.close == Decimal("1082.00")
    assert row.Trading_Volume == 32_500_000


def test_missing_required_field_raises() -> None:
    payload = dict(SAMPLE_PRICE_ROW)
    del payload["stock_id"]
    with pytest.raises(ValidationError):
        TaiwanStockPriceRow.model_validate(payload)


def test_extra_field_preserved() -> None:
    payload = dict(SAMPLE_PRICE_ROW)
    payload["new_column"] = "from_future_finmind_release"
    row = TaiwanStockPriceRow.model_validate(payload)
    assert row.__pydantic_extra__ is not None
    assert row.__pydantic_extra__["new_column"] == "from_future_finmind_release"


def test_row_is_frozen() -> None:
    row = TaiwanStockPriceRow.model_validate(SAMPLE_PRICE_ROW)
    with pytest.raises(ValidationError):
        row.stock_id = "0050"  # type: ignore[misc]


def test_institutional_row_validates() -> None:
    row = TaiwanStockInstitutionalInvestorsBuySellRow.model_validate(
        {
            "date": "2025-01-02",
            "stock_id": "2330",
            "buy": 1_000_000,
            "sell": 500_000,
            "name": "Foreign_Investor",
        }
    )
    assert row.buy == 1_000_000
    assert row.sell == 500_000


def test_expected_fields_map_matches_models() -> None:
    """EXPECTED_FIELDS must list every non-extra field of each model."""
    for dataset, model_cls in (
        ("TaiwanStockPrice", TaiwanStockPriceRow),
        (
            "TaiwanStockInstitutionalInvestorsBuySell",
            TaiwanStockInstitutionalInvestorsBuySellRow,
        ),
    ):
        model_fields = frozenset(model_cls.model_fields.keys())
        assert EXPECTED_FIELDS[dataset] == model_fields, (
            f"EXPECTED_FIELDS[{dataset!r}] out of sync with {model_cls.__name__}"
        )
