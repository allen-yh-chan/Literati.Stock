"""Integration tests for DB engine, session factory, and Alembic migration."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


async def test_can_select_one(session: AsyncSession) -> None:
    """Verifies build_engine + session factory connect successfully."""
    result = await session.execute(text("select 1"))
    assert result.scalar_one() == 1


async def test_ingest_raw_columns(session: AsyncSession) -> None:
    """Verifies migration created ingest_raw with expected columns in order."""
    result = await session.execute(
        text(
            "select column_name from information_schema.columns "
            "where table_name = 'ingest_raw' order by ordinal_position"
        )
    )
    cols = [row[0] for row in result.all()]
    assert cols == ["id", "dataset", "fetched_at", "request_args", "payload"]


async def test_ingest_failure_columns(session: AsyncSession) -> None:
    """Verifies migration created ingest_failure with expected columns in order."""
    result = await session.execute(
        text(
            "select column_name from information_schema.columns "
            "where table_name = 'ingest_failure' order by ordinal_position"
        )
    )
    cols = [row[0] for row in result.all()]
    assert cols == [
        "id",
        "dataset",
        "occurred_at",
        "request_args",
        "error_class",
        "error_message",
        "traceback",
        "attempts",
    ]


async def test_indexes_exist(session: AsyncSession) -> None:
    """Verifies dataset indexes were created on both tables."""
    result = await session.execute(
        text(
            "select indexname from pg_indexes "
            "where tablename in ('ingest_raw', 'ingest_failure') "
            "and indexname like 'ix_%' order by indexname"
        )
    )
    indexes = [row[0] for row in result.all()]
    assert indexes == ["ix_ingest_failure_dataset", "ix_ingest_raw_dataset"]
