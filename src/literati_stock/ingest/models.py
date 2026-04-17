"""SQLAlchemy 2.0 ORM models for ingest operational tables."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Declarative base for all ingest ORM models."""


class IngestRaw(Base):
    """Raw payload of every successful ingest call (audit / replay)."""

    __tablename__ = "ingest_raw"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dataset: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    request_args: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    payload: Mapped[Any] = mapped_column(JSONB, nullable=False)


class IngestFailure(Base):
    """DLQ record for ingest calls that exhausted retries."""

    __tablename__ = "ingest_failure"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dataset: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    request_args: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    error_class: Mapped[str] = mapped_column(String(255), nullable=False)
    error_message: Mapped[str] = mapped_column(Text, nullable=False)
    traceback: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
