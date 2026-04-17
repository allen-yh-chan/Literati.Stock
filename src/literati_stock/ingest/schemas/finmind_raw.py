"""Pydantic models for raw FinMind API payloads.

Field names mirror FinMind's response verbatim (e.g. ``Trading_Volume``,
``max``, ``min``). Conversion to cleaner domain models happens outside this
module. ``extra='allow'`` preserves unknown fields under
``__pydantic_extra__`` so new fields propagated by FinMind do not get silently
dropped; missing required fields still raise ``ValidationError``.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class _FinMindRow(BaseModel):
    """Base for FinMind raw rows: frozen + preserve extras."""

    model_config = ConfigDict(extra="allow", frozen=True, str_strip_whitespace=True)


class TaiwanStockPriceRow(_FinMindRow):
    """Row shape for dataset ``TaiwanStockPrice``."""

    date: date
    stock_id: str = Field(min_length=4)
    Trading_Volume: int
    Trading_money: int
    open: Decimal
    max: Decimal
    min: Decimal
    close: Decimal
    spread: Decimal
    Trading_turnover: int


class TaiwanStockInstitutionalInvestorsBuySellRow(_FinMindRow):
    """Row shape for dataset ``TaiwanStockInstitutionalInvestorsBuySell``."""

    date: date
    stock_id: str = Field(min_length=4)
    buy: int
    sell: int
    name: str


# Dataset → expected top-level field set. Consumed by `SchemaSentinel`.
EXPECTED_FIELDS: dict[str, frozenset[str]] = {
    "TaiwanStockPrice": frozenset(
        {
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
        }
    ),
    "TaiwanStockInstitutionalInvestorsBuySell": frozenset(
        {"date", "stock_id", "buy", "sell", "name"}
    ),
}
