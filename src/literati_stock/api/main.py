"""FastAPI application with lifespan-managed scheduler and DB resources."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from literati_stock.core.logging import configure_logging, get_logger
from literati_stock.core.settings import Settings
from literati_stock.ingest.db import build_engine, build_session_factory
from literati_stock.ingest.scheduler import IngestScheduler


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build a FastAPI app wired to DB + scheduler via lifespan."""
    s = settings if settings is not None else Settings()  # pyright: ignore[reportCallIssue]
    configure_logging(s)
    logger = get_logger("literati_stock.api")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = build_engine(s)
        session_factory = build_session_factory(engine)
        scheduler = IngestScheduler(timezone=s.scheduler_timezone)

        app.state.settings = s
        app.state.engine = engine
        app.state.session_factory = session_factory
        app.state.scheduler = scheduler

        scheduler.start()
        logger.info("app.startup", jobs=len(scheduler.jobs))
        try:
            yield
        finally:
            await scheduler.shutdown(wait=True)
            await engine.dispose()
            logger.info("app.shutdown")

    app = FastAPI(lifespan=lifespan, title="Literati.Stock", version="0.1.0")

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        scheduler: IngestScheduler = app.state.scheduler
        return {"status": "ok", "schedules": len(scheduler.jobs)}

    return app


def run() -> None:
    """Entry point for the ``literati-api`` CLI script."""
    import uvicorn

    uvicorn.run(
        "literati_stock.api.main:create_app",
        factory=True,
        host="0.0.0.0",  # noqa: S104 - container listens on all interfaces
        port=8000,
        reload=False,
    )
