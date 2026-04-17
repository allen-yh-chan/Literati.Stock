"""Signal evaluation service: fetch features, run rule, upsert events."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, timedelta
from decimal import Decimal

import structlog
from sqlalchemy import Row, distinct, func, over, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.chip.models import InstitutionalBuysell, MarginTransaction
from literati_stock.price.models import StockPrice
from literati_stock.signal.base import (
    InstitutionalRow,
    MarginRow,
    PriceRow,
    Signal,
    SignalEventOut,
    SignalFeatures,
)
from literati_stock.signal.models import SignalEvent

logger = structlog.get_logger(__name__)


class SignalEvaluationService:
    """Reads price + chip features and runs `Signal.evaluate`, then upserts
    produced events into `signal_event`."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sf = session_factory

    async def fetch_prices(
        self,
        as_of: date,
        window_days: int,
        end_date: date | None = None,
    ) -> list[PriceRow]:
        """Return rows with `ma_volume = avg(volume) OVER (rows N-1 preceding)`.

        SQL computes the moving average at the DB; we only hydrate `PriceRow`
        tuples. `trade_date` is strictly `<= as_of` (look-ahead defence).
        """
        upper = end_date if end_date is not None else as_of
        lower = as_of - timedelta(days=window_days * 3)

        ma_volume = over(
            func.avg(StockPrice.volume),
            partition_by=StockPrice.stock_id,
            order_by=StockPrice.trade_date,
            rows=(-(window_days - 1), 0),
        ).label("ma_volume")

        stmt = (
            select(
                StockPrice.stock_id,
                StockPrice.trade_date,
                StockPrice.open,
                StockPrice.high,
                StockPrice.low,
                StockPrice.close,
                StockPrice.volume,
                ma_volume,
            )
            .where(StockPrice.trade_date <= upper)
            .where(StockPrice.trade_date >= lower)
            .order_by(StockPrice.stock_id, StockPrice.trade_date)
        )

        async with self._sf() as session:
            result = await session.execute(stmt)
            return [_row_to_price_row(r) for r in result.all()]

    async def fetch_institutional(self, as_of: date, window_days: int) -> list[InstitutionalRow]:
        lower = as_of - timedelta(days=window_days * 3)
        stmt = (
            select(
                InstitutionalBuysell.stock_id,
                InstitutionalBuysell.trade_date,
                InstitutionalBuysell.foreign_net,
                InstitutionalBuysell.trust_net,
                InstitutionalBuysell.dealer_net,
                InstitutionalBuysell.total_net,
            )
            .where(InstitutionalBuysell.trade_date <= as_of)
            .where(InstitutionalBuysell.trade_date >= lower)
            .order_by(InstitutionalBuysell.stock_id, InstitutionalBuysell.trade_date)
        )
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [
                InstitutionalRow(
                    stock_id=r[0],
                    trade_date=r[1],
                    foreign_net=r[2],
                    trust_net=r[3],
                    dealer_net=r[4],
                    total_net=r[5],
                )
                for r in result.all()
            ]

    async def fetch_margin(self, as_of: date, window_days: int) -> list[MarginRow]:
        lower = as_of - timedelta(days=window_days * 3)
        stmt = (
            select(
                MarginTransaction.stock_id,
                MarginTransaction.trade_date,
                MarginTransaction.margin_today_balance,
                MarginTransaction.margin_yesterday_balance,
                MarginTransaction.short_today_balance,
                MarginTransaction.short_yesterday_balance,
            )
            .where(MarginTransaction.trade_date <= as_of)
            .where(MarginTransaction.trade_date >= lower)
            .order_by(MarginTransaction.stock_id, MarginTransaction.trade_date)
        )
        async with self._sf() as session:
            result = await session.execute(stmt)
            return [
                MarginRow(
                    stock_id=r[0],
                    trade_date=r[1],
                    margin_today_balance=r[2],
                    margin_yesterday_balance=r[3],
                    short_today_balance=r[4],
                    short_yesterday_balance=r[5],
                )
                for r in result.all()
            ]

    async def evaluate(self, signal: Signal, as_of: date) -> list[SignalEventOut]:
        """Run a signal for a single `as_of` date and upsert its events."""
        prices = await self.fetch_prices(as_of, window_days=signal.window_days)
        institutional = await self.fetch_institutional(as_of, window_days=signal.window_days)
        margin = await self.fetch_margin(as_of, window_days=signal.window_days)

        for rows, name in (
            (prices, "prices"),
            (institutional, "institutional"),
            (margin, "margin"),
        ):
            if rows and max(r.trade_date for r in rows) > as_of:
                raise RuntimeError(f"look-ahead guard: fetch_{name} returned row > {as_of}")

        features = SignalFeatures(prices=prices, institutional=institutional, margin=margin)
        events = signal.evaluate(features, as_of)
        if events:
            await self._upsert_events(events)
        logger.info(
            "signal.evaluate",
            signal=signal.name,
            as_of=as_of.isoformat(),
            prices=len(prices),
            institutional=len(institutional),
            margin=len(margin),
            events_emitted=len(events),
        )
        return events

    async def backfill(self, signal: Signal, start: date, end: date) -> tuple[int, int]:
        """Run `evaluate` for every distinct trade_date in `[start, end]` that
        has data in `stock_price`. Returns `(days_processed, events_emitted)`."""
        if start > end:
            raise ValueError(f"start ({start}) must be <= end ({end})")

        async with self._sf() as session:
            date_stmt = (
                select(distinct(StockPrice.trade_date))
                .where(StockPrice.trade_date >= start)
                .where(StockPrice.trade_date <= end)
                .order_by(StockPrice.trade_date)
            )
            result = await session.execute(date_stmt)
            trading_days = [row[0] for row in result.all()]

        total_events = 0
        for d in trading_days:
            events = await self.evaluate(signal, d)
            total_events += len(events)
        return len(trading_days), total_events

    async def _upsert_events(self, events: Iterable[SignalEventOut]) -> None:
        rows = [
            {
                "signal_name": e.signal_name,
                "stock_id": e.stock_id,
                "trade_date": e.trade_date,
                "severity": e.severity,
                "event_metadata": e.metadata,
            }
            for e in events
        ]
        if not rows:
            return
        stmt = pg_insert(SignalEvent).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_signal_event_name_stock_date",
            set_={
                "severity": stmt.excluded.severity,
                "event_metadata": stmt.excluded.event_metadata,
                "computed_at": func.now(),
            },
        )
        async with self._sf() as session, session.begin():
            await session.execute(stmt)


_PriceRowTuple = tuple[str, date, Decimal, Decimal, Decimal, Decimal, int, Decimal | None]


def _row_to_price_row(r: Row[_PriceRowTuple]) -> PriceRow:
    stock_id, trade_date, open_, high, low, close, volume, ma_volume = r
    return PriceRow(
        stock_id=stock_id,
        trade_date=trade_date,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
        ma_volume=ma_volume,
    )
