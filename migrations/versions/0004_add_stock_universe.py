"""add stock_universe table + seed initial watchlist

Revision ID: 0004_add_stock_universe
Revises: 0003_add_signal_event
Create Date: 2026-04-17

"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_add_stock_universe"
down_revision: str | None = "0003_add_signal_event"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_MVP_WATCHLIST: tuple[tuple[str, str, str], ...] = (
    ("2330", "台積電", "twse"),
    ("2454", "聯發科", "twse"),
    ("2317", "鴻海", "twse"),
    ("2412", "中華電", "twse"),
    ("2303", "聯電", "twse"),
)


def upgrade() -> None:
    op.create_table(
        "stock_universe",
        sa.Column("stock_id", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("industry_category", sa.String(length=64), nullable=True),
        sa.Column("market", sa.String(length=16), nullable=False),
        sa.Column(
            "is_active",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "in_watchlist",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "last_synced_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("stock_id", name="pk_stock_universe"),
    )
    op.create_index(
        "ix_stock_universe_watchlist",
        "stock_universe",
        ["in_watchlist"],
        postgresql_where=sa.text("in_watchlist"),
    )

    # Seed the MVP watchlist. `industry_category` is left NULL so first sync
    # can fill it from FinMind. `in_watchlist=true` marks these for the daily
    # scheduled ingest job.
    table = sa.table(
        "stock_universe",
        sa.column("stock_id", sa.String),
        sa.column("name", sa.String),
        sa.column("market", sa.String),
        sa.column("is_active", sa.Boolean),
        sa.column("in_watchlist", sa.Boolean),
    )
    op.bulk_insert(
        table,
        [
            {
                "stock_id": sid,
                "name": name,
                "market": market,
                "is_active": True,
                "in_watchlist": True,
            }
            for sid, name, market in _MVP_WATCHLIST
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_stock_universe_watchlist", table_name="stock_universe")
    op.drop_table("stock_universe")
