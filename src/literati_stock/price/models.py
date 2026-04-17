"""SQLAlchemy 2.0 ORM for the price domain table and the ELT cursor."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from literati_stock.ingest.models import Base


class StockPrice(Base):
    """Typed OHLCV row per (stock, trading day) derived from `ingest_raw`."""

    __tablename__ = "stock_price"

    stock_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    trade_date: Mapped[date] = mapped_column(Date, primary_key=True)
    open: Mapped[Decimal] = mapped_column(Numeric(16, 4), nullable=False)
    high: Mapped[Decimal] = mapped_column(Numeric(16, 4), nullable=False)
    low: Mapped[Decimal] = mapped_column(Numeric(16, 4), nullable=False)
    close: Mapped[Decimal] = mapped_column(Numeric(16, 4), nullable=False)
    spread: Mapped[Decimal] = mapped_column(Numeric(16, 4), nullable=False)
    volume: Mapped[int] = mapped_column(BigInteger, nullable=False)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    turnover: Mapped[int] = mapped_column(Integer, nullable=False)
    source_raw_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("ingest_raw.id"), nullable=False
    )
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class IngestCursor(Base):
    """Per-dataset high-water mark into ``ingest_raw`` for idempotent replay."""

    __tablename__ = "ingest_cursor"

    dataset: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_raw_id: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
