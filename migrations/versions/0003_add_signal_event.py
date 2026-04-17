"""add signal_event table

Revision ID: 0003_add_signal_event
Revises: 0002_add_price_domain
Create Date: 2026-04-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_add_signal_event"
down_revision: str | None = "0002_add_price_domain"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "signal_event",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("signal_name", sa.String(length=64), nullable=False),
        sa.Column("stock_id", sa.String(length=16), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("severity", sa.Numeric(10, 4), nullable=True),
        sa.Column("event_metadata", postgresql.JSONB(), nullable=True),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "signal_name",
            "stock_id",
            "trade_date",
            name="uq_signal_event_name_stock_date",
        ),
    )
    op.create_index(
        "ix_signal_event_trade_date",
        "signal_event",
        [sa.text("trade_date DESC")],
    )
    op.create_index(
        "ix_signal_event_stock_trade_date",
        "signal_event",
        ["stock_id", sa.text("trade_date DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_signal_event_stock_trade_date", table_name="signal_event")
    op.drop_index("ix_signal_event_trade_date", table_name="signal_event")
    op.drop_table("signal_event")
