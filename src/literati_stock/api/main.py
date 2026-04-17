"""FastAPI application with lifespan-managed scheduler and DB resources."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from literati_stock.chip.jobs import register_chip_jobs
from literati_stock.core.logging import configure_logging, get_logger
from literati_stock.core.settings import Settings
from literati_stock.ingest.db import build_engine, build_session_factory
from literati_stock.ingest.scheduler import IngestScheduler
from literati_stock.notify.channels.discord import DiscordWebhookChannel
from literati_stock.notify.jobs import register_notification_jobs
from literati_stock.price.jobs import register_price_jobs
from literati_stock.signal.jobs import register_signal_jobs
from literati_stock.signal.rules.institutional_chase import (
    InstitutionalChaseWarningSignal,
)
from literati_stock.signal.rules.volume_surge_red import VolumeSurgeRedSignal
from literati_stock.universe.jobs import register_universe_jobs


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

        notification_channel: DiscordWebhookChannel | None = None

        app.state.settings = s
        app.state.engine = engine
        app.state.session_factory = session_factory
        app.state.scheduler = scheduler

        register_price_jobs(scheduler, session_factory)
        register_signal_jobs(
            scheduler,
            session_factory,
            signals=[VolumeSurgeRedSignal(), InstitutionalChaseWarningSignal()],
        )
        register_universe_jobs(scheduler, session_factory, s)
        register_chip_jobs(scheduler, session_factory, s)
        if s.discord_webhook_url:
            notification_channel = DiscordWebhookChannel(s.discord_webhook_url)
            register_notification_jobs(
                scheduler,
                session_factory,
                notification_channel,
                signal_names=[VolumeSurgeRedSignal().name],
            )

        scheduler.start()
        logger.info("app.startup", jobs=len(scheduler.jobs))
        try:
            yield
        finally:
            await scheduler.shutdown(wait=True)
            if notification_channel is not None:
                await notification_channel.aclose()
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
