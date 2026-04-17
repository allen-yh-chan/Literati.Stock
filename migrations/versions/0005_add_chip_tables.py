"""add institutional_buysell and margin_transaction tables

Revision ID: 0005_add_chip_tables
Revises: 0004_add_stock_universe
Create Date: 2026-04-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_add_chip_tables"
down_revision: str | None = "0004_add_stock_universe"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "institutional_buysell",
        sa.Column("stock_id", sa.String(length=16), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("foreign_net", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("trust_net", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("dealer_net", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("total_net", sa.BigInteger(), server_default="0", nullable=False),
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
        sa.PrimaryKeyConstraint(
            "stock_id", "trade_date", name="pk_institutional_buysell"
        ),
    )
    op.create_index(
        "ix_institutional_buysell_trade_date",
        "institutional_buysell",
        ["trade_date"],
    )

    op.create_table(
        "margin_transaction",
        sa.Column("stock_id", sa.String(length=16), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("margin_purchase_buy", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("margin_purchase_sell", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("margin_today_balance", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("margin_yesterday_balance", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("short_sale_buy", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("short_sale_sell", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("short_today_balance", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("short_yesterday_balance", sa.BigInteger(), server_default="0", nullable=False),
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
        sa.PrimaryKeyConstraint(
            "stock_id", "trade_date", name="pk_margin_transaction"
        ),
    )
    op.create_index(
        "ix_margin_transaction_trade_date",
        "margin_transaction",
        ["trade_date"],
    )


def downgrade() -> None:
    op.drop_index("ix_margin_transaction_trade_date", table_name="margin_transaction")
    op.drop_table("margin_transaction")
    op.drop_index("ix_institutional_buysell_trade_date", table_name="institutional_buysell")
    op.drop_table("institutional_buysell")
