"""SQLAlchemy 2.0 ORM for institutional + margin domain tables."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from literati_stock.ingest.models import Base


class InstitutionalBuysell(Base):
    """Aggregated institutional net buy-sell per (stock, trade_date).

    Source rows come as one per investor type (Foreign_Investor,
    Investment_Trust, Dealer_self, Dealer_Hedging, Foreign_Dealer_Self, ...);
    the transform service merges them into a single row with three category
    buckets.
    """

    __tablename__ = "institutional_buysell"

    stock_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    trade_date: Mapped[date] = mapped_column(Date, primary_key=True)
    foreign_net: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    trust_net: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    dealer_net: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    total_net: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    source_raw_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("ingest_raw.id"), nullable=False
    )
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MarginTransaction(Base):
    """Daily margin (融資) and short-sale (融券) snapshot per stock."""

    __tablename__ = "margin_transaction"

    stock_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    trade_date: Mapped[date] = mapped_column(Date, primary_key=True)
    margin_purchase_buy: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    margin_purchase_sell: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    margin_today_balance: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    margin_yesterday_balance: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    short_sale_buy: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    short_sale_sell: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    short_today_balance: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    short_yesterday_balance: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    source_raw_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("ingest_raw.id"), nullable=False
    )
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
