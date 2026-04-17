"""Command-line entry point for manual ingest invocations."""

from __future__ import annotations

import argparse
import asyncio
from typing import Any

import httpx
from aiolimiter import AsyncLimiter

from literati_stock.core.logging import configure_logging, get_logger
from literati_stock.core.settings import Settings
from literati_stock.ingest.clients.finmind import FinMindClient
from literati_stock.ingest.db import build_engine, build_session_factory
from literati_stock.ingest.storage import RawPayloadStore
from literati_stock.price.transform import PriceTransformService, TransformResult


async def _run_once(
    settings: Settings,
    dataset: str,
    data_id: str,
    start: str,
    end: str | None,
) -> int:
    log = get_logger("literati_stock.ingest.cli")
    log.info("run_once.start", dataset=dataset, data_id=data_id, start=start, end=end)

    engine = build_engine(settings)
    session_factory = build_session_factory(engine)
    limiter = AsyncLimiter(max_rate=8, time_period=60.0)

    try:
        async with httpx.AsyncClient(timeout=30.0) as http:
            client = FinMindClient(token=settings.finmind_token, limiter=limiter, http_client=http)
            rows: list[dict[str, Any]] = await client.fetch(
                dataset, data_id=data_id, start_date=start, end_date=end
            )

        async with session_factory() as session, session.begin():
            store = RawPayloadStore(session)
            row_id = await store.record(
                dataset=dataset,
                request_args={
                    "data_id": data_id,
                    "start_date": start,
                    "end_date": end,
                },
                payload=rows,
            )
    finally:
        await engine.dispose()

    log.info("run_once.done", rows=len(rows), ingest_raw_id=row_id)
    return row_id


async def _transform_prices(settings: Settings) -> TransformResult:
    engine = build_engine(settings)
    session_factory = build_session_factory(engine)
    try:
        service = PriceTransformService(session_factory)
        return await service.process_new()
    finally:
        await engine.dispose()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="literati-ingest")
    sub = parser.add_subparsers(dest="command", required=True)

    once = sub.add_parser("run-once", help="Fetch one dataset slice and record it to ingest_raw.")
    once.add_argument("dataset", help="FinMind dataset name (e.g. TaiwanStockPrice).")
    once.add_argument("--data-id", required=True, help="Stock id or dataset key (e.g. 2330).")
    once.add_argument("--start", required=True, help="Start date YYYY-MM-DD.")
    once.add_argument("--end", default=None, help="End date YYYY-MM-DD (optional).")

    sub.add_parser(
        "transform-prices",
        help="Transform pending TaiwanStockPrice ingest_raw rows into stock_price.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    settings = Settings()  # pyright: ignore[reportCallIssue]
    configure_logging(settings)

    if args.command == "run-once":
        asyncio.run(
            _run_once(
                settings,
                dataset=args.dataset,
                data_id=args.data_id,
                start=args.start,
                end=args.end,
            )
        )
        return 0

    if args.command == "transform-prices":
        result = asyncio.run(_transform_prices(settings))
        print(result.model_dump_json())
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
