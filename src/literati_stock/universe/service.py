"""Universe sync service: pulls TaiwanStockInfo, upserts stock_universe."""

from __future__ import annotations

from datetime import date
from typing import Any

import httpx
import structlog
from aiolimiter import AsyncLimiter
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import func, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.core.settings import Settings
from literati_stock.ingest.clients.finmind import FinMindClient
from literati_stock.ingest.schemas.finmind_raw import TaiwanStockInfoRow
from literati_stock.universe.models import StockUniverse

logger = structlog.get_logger(__name__)

_TAIWAN_STOCK_INFO = "TaiwanStockInfo"


class UniverseSyncResult(BaseModel):
    """Summary returned by `UniverseSyncService.sync`."""

    model_config = ConfigDict(frozen=True)

    raw_rows_fetched: int
    unique_stocks_upserted: int


class UniverseSyncService:
    """Fetches the full FinMind TaiwanStockInfo snapshot and upserts it into
    `stock_universe`. `in_watchlist` is preserved across syncs."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        settings: Settings,
    ) -> None:
        self._sf = session_factory
        self._settings = settings

    async def sync(self) -> UniverseSyncResult:
        raw_rows = await self._fetch_all()
        latest_by_stock = _dedup_latest(raw_rows)

        logger.info(
            "universe.sync.start",
            raw_rows=len(raw_rows),
            unique_stocks=len(latest_by_stock),
        )

        async with self._sf() as session, session.begin():
            # First mark everything inactive, then upsert the rows we saw;
            # delisted stocks retain their row but flip to is_active=false.
            await session.execute(update(StockUniverse).values(is_active=False))
            for row in latest_by_stock.values():
                await self._upsert_row(session, row)

        return UniverseSyncResult(
            raw_rows_fetched=len(raw_rows),
            unique_stocks_upserted=len(latest_by_stock),
        )

    async def _fetch_all(self) -> list[dict[str, Any]]:
        """Fetch the full snapshot. Uses a single FinMind request; no
        pagination is needed for TaiwanStockInfo at current volumes."""
        limiter = AsyncLimiter(max_rate=8, time_period=60.0)
        async with httpx.AsyncClient(timeout=60.0) as http:
            client = FinMindClient(
                token=self._settings.finmind_token,
                limiter=limiter,
                http_client=http,
            )
            return await client.fetch(_TAIWAN_STOCK_INFO)

    @staticmethod
    async def _upsert_row(session: AsyncSession, row: TaiwanStockInfoRow) -> None:
        industry = row.industry_category or None
        stmt = (
            pg_insert(StockUniverse)
            .values(
                stock_id=row.stock_id,
                name=row.stock_name,
                industry_category=industry,
                market=row.type,
                is_active=True,
                last_synced_at=func.now(),
            )
            .on_conflict_do_update(
                index_elements=["stock_id"],
                set_={
                    "name": row.stock_name,
                    "industry_category": industry,
                    "market": row.type,
                    "is_active": True,
                    "last_synced_at": func.now(),
                    # NOTE: in_watchlist deliberately omitted — preserved.
                },
            )
        )
        await session.execute(stmt)


def _dedup_latest(rows: list[dict[str, Any]]) -> dict[str, TaiwanStockInfoRow]:
    """Keep only the latest-dated row per stock_id.

    FinMind occasionally returns malformed rows (e.g. `date: "None"`); those
    are logged and skipped rather than aborting the whole sync.
    """
    latest: dict[str, TaiwanStockInfoRow] = {}
    latest_date: dict[str, date] = {}
    skipped = 0
    for raw in rows:
        try:
            parsed = TaiwanStockInfoRow.model_validate(raw)
        except ValidationError:
            skipped += 1
            continue
        prev_date = latest_date.get(parsed.stock_id)
        if prev_date is None or parsed.date > prev_date:
            latest[parsed.stock_id] = parsed
            latest_date[parsed.stock_id] = parsed.date
    if skipped:
        logger.warning("universe.sync.invalid_rows_skipped", count=skipped)
    return latest
