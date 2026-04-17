"""ELT transform service: ingest_raw (TaiwanStockPrice) -> stock_price."""

from __future__ import annotations

from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.ingest.models import IngestRaw
from literati_stock.ingest.schemas.finmind_raw import TaiwanStockPriceRow
from literati_stock.price.models import IngestCursor, StockPrice

logger = structlog.get_logger(__name__)


class TransformResult(BaseModel):
    """Summary returned by a single `PriceTransformService.process_new` call."""

    model_config = ConfigDict(frozen=True)

    dataset: str
    raw_rows_processed: int
    price_upserts: int
    cursor_advanced_to: int


class PriceTransformService:
    """Reads new ``ingest_raw`` rows for TaiwanStockPrice, parses each row via
    ``TaiwanStockPriceRow``, upserts into ``stock_price``, and advances the
    per-dataset cursor. Cursor advance and price upserts share one transaction
    so a failure rolls both back."""

    DATASET: str = "TaiwanStockPrice"

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def process_new(self, batch_size: int = 500) -> TransformResult:
        async with self._sf() as session, session.begin():
            last_id = await self._read_cursor(session)

            raw_rows = await self._fetch_new_raw(session, last_id, batch_size)
            if not raw_rows:
                return TransformResult(
                    dataset=self.DATASET,
                    raw_rows_processed=0,
                    price_upserts=0,
                    cursor_advanced_to=last_id,
                )

            upserts = 0
            for raw in raw_rows:
                upserts += await self._transform_one(session, raw)

            max_id = max(r.id for r in raw_rows)
            await self._advance_cursor(session, max_id)

            return TransformResult(
                dataset=self.DATASET,
                raw_rows_processed=len(raw_rows),
                price_upserts=upserts,
                cursor_advanced_to=max_id,
            )

    async def _read_cursor(self, session: AsyncSession) -> int:
        row = await session.scalar(select(IngestCursor).where(IngestCursor.dataset == self.DATASET))
        return row.last_raw_id if row is not None else 0

    async def _fetch_new_raw(
        self, session: AsyncSession, last_id: int, batch_size: int
    ) -> list[IngestRaw]:
        stmt = (
            select(IngestRaw)
            .where(IngestRaw.dataset == self.DATASET, IngestRaw.id > last_id)
            .order_by(IngestRaw.id)
            .limit(batch_size)
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def _transform_one(self, session: AsyncSession, raw: IngestRaw) -> int:
        payload: Any = raw.payload
        if not isinstance(payload, list):
            logger.warning(
                "price.transform.skip_non_list_payload",
                raw_id=raw.id,
                payload_type=type(payload).__name__,
            )
            return 0

        upserts = 0
        for row_any in payload:
            if not isinstance(row_any, dict):
                logger.warning(
                    "price.transform.skip_non_dict_row",
                    raw_id=raw.id,
                    row_type=type(row_any).__name__,
                )
                continue
            parsed = TaiwanStockPriceRow.model_validate(row_any)
            await self._upsert_price(session, parsed, source_raw_id=raw.id)
            upserts += 1
        return upserts

    @staticmethod
    async def _upsert_price(
        session: AsyncSession, row: TaiwanStockPriceRow, *, source_raw_id: int
    ) -> None:
        values: dict[str, object] = {
            "stock_id": row.stock_id,
            "trade_date": row.date,
            "open": row.open,
            "high": row.max,
            "low": row.min,
            "close": row.close,
            "spread": row.spread,
            "volume": row.Trading_Volume,
            "amount": row.Trading_money,
            "turnover": row.Trading_turnover,
            "source_raw_id": source_raw_id,
        }
        stmt = (
            pg_insert(StockPrice)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["stock_id", "trade_date"],
                set_={
                    "open": values["open"],
                    "high": values["high"],
                    "low": values["low"],
                    "close": values["close"],
                    "spread": values["spread"],
                    "volume": values["volume"],
                    "amount": values["amount"],
                    "turnover": values["turnover"],
                    "source_raw_id": source_raw_id,
                    "ingested_at": func.now(),
                },
            )
        )
        await session.execute(stmt)

    async def _advance_cursor(self, session: AsyncSession, max_id: int) -> None:
        stmt = (
            pg_insert(IngestCursor)
            .values(dataset=self.DATASET, last_raw_id=max_id, updated_at=func.now())
            .on_conflict_do_update(
                index_elements=["dataset"],
                set_={"last_raw_id": max_id, "updated_at": func.now()},
            )
        )
        await session.execute(stmt)
