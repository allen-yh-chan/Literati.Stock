"""add ingest_raw and ingest_failure tables

Revision ID: 0001_add_ops_tables
Revises:
Create Date: 2026-04-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_add_ops_tables"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingest_raw",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("dataset", sa.String(length=64), nullable=False),
        sa.Column(
            "fetched_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("request_args", postgresql.JSONB(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_ingest_raw_dataset", "ingest_raw", ["dataset"])

    op.create_table(
        "ingest_failure",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("dataset", sa.String(length=64), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("request_args", postgresql.JSONB(), nullable=False),
        sa.Column("error_class", sa.String(length=255), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=False),
        sa.Column("traceback", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
    )
    op.create_index("ix_ingest_failure_dataset", "ingest_failure", ["dataset"])


def downgrade() -> None:
    op.drop_index("ix_ingest_failure_dataset", table_name="ingest_failure")
    op.drop_table("ingest_failure")
    op.drop_index("ix_ingest_raw_dataset", table_name="ingest_raw")
    op.drop_table("ingest_raw")
