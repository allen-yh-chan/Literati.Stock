"""SQLAlchemy 2.0 ORM for the stock_universe table."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from literati_stock.ingest.models import Base


class StockUniverse(Base):
    """One row per listed / OTC / emerging-board security known to FinMind.

    `in_watchlist` is preserved across universe syncs; only the descriptive
    fields (`name`, `industry_category`, `market`, `is_active`,
    `last_synced_at`) are refreshed from TaiwanStockInfo.
    """

    __tablename__ = "stock_universe"

    stock_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    industry_category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    market: Mapped[str] = mapped_column(String(16), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    in_watchlist: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    last_synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
