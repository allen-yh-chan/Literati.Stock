"""Signal evaluation service: fetch prices with MA, run rule, upsert events."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, timedelta
from decimal import Decimal

import structlog
from sqlalchemy import Row, distinct, func, over, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.price.models import StockPrice
from literati_stock.signal.base import PriceRow, Signal, SignalEventOut
from literati_stock.signal.models import SignalEvent

logger = structlog.get_logger(__name__)


class SignalEvaluationService:
    """Reads `stock_price` with pre-computed MA, runs `Signal.evaluate`, and
    upserts produced events into `signal_event`."""

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
        # Pull a slightly larger slice so that PG's window fn has enough prior
        # days to compute meaningful averages near the lower bound.
        lower = as_of - timedelta(days=window_days * 3)

        # SQLAlchemy's `rows=(start, end)` treats negative as PRECEDING,
        # positive as FOLLOWING; we want (window_days-1) preceding to current.
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
            return [_row_to_price_row(r, window_days) for r in result.all()]

    async def evaluate(self, signal: Signal, as_of: date) -> list[SignalEventOut]:
        """Run a signal for a single `as_of` date and upsert its events."""
        rows = await self.fetch_prices(as_of, window_days=signal.window_days)
        if rows and max(r.trade_date for r in rows) > as_of:
            raise RuntimeError(f"look-ahead guard: fetch_prices returned row > {as_of}")
        events = signal.evaluate(rows, as_of)
        if events:
            await self._upsert_events(events)
        logger.info(
            "signal.evaluate",
            signal=signal.name,
            as_of=as_of.isoformat(),
            rows_considered=len(rows),
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


def _row_to_price_row(r: Row[_PriceRowTuple], window_days: int) -> PriceRow:
    del window_days  # reserved for future signal-specific projection
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
