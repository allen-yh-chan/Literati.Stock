"""Daily scheduled price ingest: iterate watchlist, fetch FinMind, record."""

from __future__ import annotations

from datetime import date

import httpx
import structlog
from aiolimiter import AsyncLimiter
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.core.settings import Settings
from literati_stock.ingest.clients.finmind import FinMindClient, FinMindError
from literati_stock.ingest.storage import FailureRecorder, RawPayloadStore
from literati_stock.universe.models import StockUniverse

logger = structlog.get_logger(__name__)

_DATASET = "TaiwanStockPrice"


class DailyPriceIngestResult(BaseModel):
    """Summary returned by `DailyPriceIngestService.run`."""

    model_config = ConfigDict(frozen=True)

    trade_date: date
    stocks_attempted: int
    raw_rows_written: int
    failures_recorded: int


class DailyPriceIngestService:
    """Reads `stock_universe WHERE is_active AND in_watchlist`, fetches
    TaiwanStockPrice for the given date per stock, and records to
    `ingest_raw` / `ingest_failure`. One `AsyncLimiter` shared across the
    loop so the FinMind quota is respected."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        settings: Settings,
        *,
        retry_wait_initial: float = 2.0,
        retry_wait_max: float = 60.0,
        max_attempts: int = 5,
    ) -> None:
        self._sf = session_factory
        self._settings = settings
        self._retry_wait_initial = retry_wait_initial
        self._retry_wait_max = retry_wait_max
        self._max_attempts = max_attempts

    async def run(self, trade_date: date) -> DailyPriceIngestResult:
        watchlist = await self._load_watchlist()
        logger.info(
            "daily_ingest.start",
            trade_date=trade_date.isoformat(),
            watchlist_size=len(watchlist),
        )
        if not watchlist:
            return DailyPriceIngestResult(
                trade_date=trade_date,
                stocks_attempted=0,
                raw_rows_written=0,
                failures_recorded=0,
            )

        raw_written = 0
        failures = 0
        limiter = AsyncLimiter(max_rate=8, time_period=60.0)
        async with httpx.AsyncClient(timeout=30.0) as http:
            client = FinMindClient(
                token=self._settings.finmind_token,
                limiter=limiter,
                http_client=http,
                max_attempts=self._max_attempts,
                retry_wait_initial=self._retry_wait_initial,
                retry_wait_max=self._retry_wait_max,
            )
            for stock_id in watchlist:
                request_args: dict[str, object] = {
                    "data_id": stock_id,
                    "start_date": trade_date.isoformat(),
                    "end_date": trade_date.isoformat(),
                }
                try:
                    rows = await client.fetch(
                        _DATASET,
                        data_id=stock_id,
                        start_date=trade_date.isoformat(),
                        end_date=trade_date.isoformat(),
                    )
                except FinMindError as exc:
                    await self._record_failure(
                        request_args=request_args,
                        exc=exc,
                        attempts=client.max_attempts,
                    )
                    failures += 1
                    continue
                await self._record_raw(request_args=request_args, payload=rows)
                raw_written += 1

        result = DailyPriceIngestResult(
            trade_date=trade_date,
            stocks_attempted=len(watchlist),
            raw_rows_written=raw_written,
            failures_recorded=failures,
        )
        logger.info("daily_ingest.done", **result.model_dump(mode="json"))
        return result

    async def _load_watchlist(self) -> list[str]:
        async with self._sf() as session:
            result = await session.execute(
                select(StockUniverse.stock_id).where(
                    StockUniverse.is_active.is_(True),
                    StockUniverse.in_watchlist.is_(True),
                )
            )
            return [row[0] for row in result.all()]

    async def _record_raw(self, *, request_args: dict[str, object], payload: object) -> None:
        async with self._sf() as session, session.begin():
            store = RawPayloadStore(session)
            await store.record(dataset=_DATASET, request_args=request_args, payload=payload)

    async def _record_failure(
        self,
        *,
        request_args: dict[str, object],
        exc: BaseException,
        attempts: int,
    ) -> None:
        async with self._sf() as session, session.begin():
            recorder = FailureRecorder(session)
            await recorder.record(
                dataset=_DATASET,
                request_args=request_args,
                exc=exc,
                attempts=attempts,
            )
