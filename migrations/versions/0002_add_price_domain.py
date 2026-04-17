"""add stock_price and ingest_cursor tables

Revision ID: 0002_add_price_domain
Revises: 0001_add_ops_tables
Create Date: 2026-04-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_add_price_domain"
down_revision: str | None = "0001_add_ops_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "stock_price",
        sa.Column("stock_id", sa.String(length=16), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("open", sa.Numeric(16, 4), nullable=False),
        sa.Column("high", sa.Numeric(16, 4), nullable=False),
        sa.Column("low", sa.Numeric(16, 4), nullable=False),
        sa.Column("close", sa.Numeric(16, 4), nullable=False),
        sa.Column("spread", sa.Numeric(16, 4), nullable=False),
        sa.Column("volume", sa.BigInteger(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("turnover", sa.Integer(), nullable=False),
        sa.Column(
            "source_raw_id",
            sa.BigInteger(),
            sa.ForeignKey("ingest_raw.id"),
            nullable=False,
        ),
        sa.Column(
            "ingested_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("stock_id", "trade_date", name="pk_stock_price"),
    )
    op.create_index("ix_stock_price_trade_date", "stock_price", ["trade_date"])
    op.create_index("ix_stock_price_source_raw_id", "stock_price", ["source_raw_id"])

    op.create_table(
        "ingest_cursor",
        sa.Column("dataset", sa.String(length=64), nullable=False),
        sa.Column("last_raw_id", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("dataset", name="pk_ingest_cursor"),
    )


def downgrade() -> None:
    op.drop_table("ingest_cursor")
    op.drop_index("ix_stock_price_source_raw_id", table_name="stock_price")
    op.drop_index("ix_stock_price_trade_date", table_name="stock_price")
    op.drop_table("stock_price")
