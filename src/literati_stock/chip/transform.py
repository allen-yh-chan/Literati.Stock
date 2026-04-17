"""ELT transforms for institutional + margin raw payloads."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.chip.models import InstitutionalBuysell, MarginTransaction
from literati_stock.ingest.models import IngestRaw
from literati_stock.ingest.schemas.finmind_raw import (
    TaiwanStockInstitutionalInvestorsBuySellRow,
    TaiwanStockMarginPurchaseShortSaleRow,
)
from literati_stock.price.models import IngestCursor

logger = structlog.get_logger(__name__)

_INSTITUTIONAL_DATASET = "TaiwanStockInstitutionalInvestorsBuySell"
_MARGIN_DATASET = "TaiwanStockMarginPurchaseShortSale"


class TransformResult(BaseModel):
    """Summary returned by a chip transform `process_new` call."""

    model_config = ConfigDict(frozen=True)

    dataset: str
    raw_rows_processed: int
    domain_upserts: int
    cursor_advanced_to: int


@dataclass
class _InstitutionalAgg:
    """Accumulator for one (stock_id, trade_date) across investor types."""

    foreign_net: int = 0
    trust_net: int = 0
    dealer_net: int = 0
    source_raw_id: int = 0
    unknown_types: list[str] = field(default_factory=list)


def _categorize(name: str) -> str:
    """Classify investor-type name into one of {foreign, trust, dealer}."""
    if name == "Foreign_Investor":
        return "foreign"
    if name == "Investment_Trust":
        return "trust"
    if name.startswith("Dealer") or name.startswith("Foreign_Dealer"):
        return "dealer"
    return "unknown"


class InstitutionalTransformService:
    """Aggregates per-investor-type rows into one row per (stock, date)."""

    DATASET: str = _INSTITUTIONAL_DATASET

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def process_new(self, batch_size: int = 500) -> TransformResult:
        async with self._sf() as session, session.begin():
            last_id = await _read_cursor(session, self.DATASET)
            raw_rows = await _fetch_new_raw(session, self.DATASET, last_id, batch_size)
            if not raw_rows:
                return TransformResult(
                    dataset=self.DATASET,
                    raw_rows_processed=0,
                    domain_upserts=0,
                    cursor_advanced_to=last_id,
                )

            aggs: dict[tuple[str, date], _InstitutionalAgg] = {}
            for raw in raw_rows:
                payload: Any = raw.payload
                if not isinstance(payload, list):
                    logger.warning(
                        "institutional.transform.skip_non_list",
                        raw_id=raw.id,
                    )
                    continue
                for row_any in payload:
                    if not isinstance(row_any, dict):
                        continue
                    parsed = TaiwanStockInstitutionalInvestorsBuySellRow.model_validate(row_any)
                    key = (parsed.stock_id, parsed.date)
                    agg = aggs.setdefault(key, _InstitutionalAgg(source_raw_id=raw.id))
                    # Keep the highest raw_id so cursor-driven replay lands on the latest.
                    if raw.id > agg.source_raw_id:
                        agg.source_raw_id = raw.id
                    net = parsed.buy - parsed.sell
                    bucket = _categorize(parsed.name)
                    if bucket == "foreign":
                        agg.foreign_net += net
                    elif bucket == "trust":
                        agg.trust_net += net
                    elif bucket == "dealer":
                        agg.dealer_net += net
                    else:
                        agg.unknown_types.append(parsed.name)

            if any(a.unknown_types for a in aggs.values()):
                logger.warning(
                    "institutional.transform.unknown_investor_types",
                    examples=list({t for a in aggs.values() for t in a.unknown_types})[:5],
                )

            upserts = 0
            for (stock_id, trade_date), agg in aggs.items():
                await self._upsert(session, stock_id, trade_date, agg)
                upserts += 1

            max_id = max(r.id for r in raw_rows)
            await _advance_cursor(session, self.DATASET, max_id)

            return TransformResult(
                dataset=self.DATASET,
                raw_rows_processed=len(raw_rows),
                domain_upserts=upserts,
                cursor_advanced_to=max_id,
            )

    @staticmethod
    async def _upsert(
        session: AsyncSession,
        stock_id: str,
        trade_date: date,
        agg: _InstitutionalAgg,
    ) -> None:
        total = agg.foreign_net + agg.trust_net + agg.dealer_net
        values = {
            "stock_id": stock_id,
            "trade_date": trade_date,
            "foreign_net": agg.foreign_net,
            "trust_net": agg.trust_net,
            "dealer_net": agg.dealer_net,
            "total_net": total,
            "source_raw_id": agg.source_raw_id,
        }
        stmt = (
            pg_insert(InstitutionalBuysell)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["stock_id", "trade_date"],
                set_={
                    "foreign_net": agg.foreign_net,
                    "trust_net": agg.trust_net,
                    "dealer_net": agg.dealer_net,
                    "total_net": total,
                    "source_raw_id": agg.source_raw_id,
                    "ingested_at": func.now(),
                },
            )
        )
        await session.execute(stmt)


class MarginTransformService:
    """1:1 upsert of margin payload rows into `margin_transaction`."""

    DATASET: str = _MARGIN_DATASET

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def process_new(self, batch_size: int = 500) -> TransformResult:
        async with self._sf() as session, session.begin():
            last_id = await _read_cursor(session, self.DATASET)
            raw_rows = await _fetch_new_raw(session, self.DATASET, last_id, batch_size)
            if not raw_rows:
                return TransformResult(
                    dataset=self.DATASET,
                    raw_rows_processed=0,
                    domain_upserts=0,
                    cursor_advanced_to=last_id,
                )

            upserts = 0
            for raw in raw_rows:
                upserts += await self._transform_one(session, raw)

            max_id = max(r.id for r in raw_rows)
            await _advance_cursor(session, self.DATASET, max_id)

            return TransformResult(
                dataset=self.DATASET,
                raw_rows_processed=len(raw_rows),
                domain_upserts=upserts,
                cursor_advanced_to=max_id,
            )

    async def _transform_one(self, session: AsyncSession, raw: IngestRaw) -> int:
        payload: Any = raw.payload
        if not isinstance(payload, list):
            return 0
        upserts = 0
        for row_any in payload:
            if not isinstance(row_any, dict):
                continue
            parsed = TaiwanStockMarginPurchaseShortSaleRow.model_validate(row_any)
            await self._upsert(session, parsed, source_raw_id=raw.id)
            upserts += 1
        return upserts

    @staticmethod
    async def _upsert(
        session: AsyncSession,
        row: TaiwanStockMarginPurchaseShortSaleRow,
        *,
        source_raw_id: int,
    ) -> None:
        values = {
            "stock_id": row.stock_id,
            "trade_date": row.date,
            "margin_purchase_buy": row.MarginPurchaseBuy,
            "margin_purchase_sell": row.MarginPurchaseSell,
            "margin_today_balance": row.MarginPurchaseTodayBalance,
            "margin_yesterday_balance": row.MarginPurchaseYesterdayBalance,
            "short_sale_buy": row.ShortSaleBuy,
            "short_sale_sell": row.ShortSaleSell,
            "short_today_balance": row.ShortSaleTodayBalance,
            "short_yesterday_balance": row.ShortSaleYesterdayBalance,
            "source_raw_id": source_raw_id,
        }
        # values is used verbatim in both insert and the update set (minus
        # source_raw_id override) so the on-conflict path matches the
        # insert shape exactly.
        update_set: dict[str, Any] = {
            k: v for k, v in values.items() if k not in ("stock_id", "trade_date")
        }
        update_set["ingested_at"] = func.now()
        stmt = (
            pg_insert(MarginTransaction)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["stock_id", "trade_date"],
                set_=update_set,
            )
        )
        await session.execute(stmt)


async def _read_cursor(session: AsyncSession, dataset: str) -> int:
    row = await session.scalar(select(IngestCursor).where(IngestCursor.dataset == dataset))
    return row.last_raw_id if row is not None else 0


async def _fetch_new_raw(
    session: AsyncSession, dataset: str, last_id: int, batch_size: int
) -> Sequence[IngestRaw]:
    stmt = (
        select(IngestRaw)
        .where(IngestRaw.dataset == dataset, IngestRaw.id > last_id)
        .order_by(IngestRaw.id)
        .limit(batch_size)
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def _advance_cursor(session: AsyncSession, dataset: str, max_id: int) -> None:
    stmt = (
        pg_insert(IngestCursor)
        .values(dataset=dataset, last_raw_id=max_id, updated_at=func.now())
        .on_conflict_do_update(
            index_elements=["dataset"],
            set_={"last_raw_id": max_id, "updated_at": func.now()},
        )
    )
    await session.execute(stmt)
