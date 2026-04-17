"""SQLAlchemy 2.0 ORM for the signal engine output table."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import BigInteger, Date, DateTime, Numeric, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from literati_stock.ingest.models import Base


class SignalEvent(Base):
    """One emitted event per (signal_name, stock_id, trade_date)."""

    __tablename__ = "signal_event"
    __table_args__ = (
        UniqueConstraint(
            "signal_name",
            "stock_id",
            "trade_date",
            name="uq_signal_event_name_stock_date",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    signal_name: Mapped[str] = mapped_column(String(64), nullable=False)
    stock_id: Mapped[str] = mapped_column(String(16), nullable=False)
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    severity: Mapped[Decimal | None] = mapped_column(Numeric(10, 4), nullable=True)
    event_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
