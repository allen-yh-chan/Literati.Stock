"""Integration test for FastAPI `/healthz` and lifespan."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from literati_stock.api.main import create_app
from literati_stock.core.settings import Settings

pytestmark = pytest.mark.integration


async def test_healthz_without_webhook_has_two_schedules(
    db_settings: Settings,
) -> None:
    """No DISCORD_WEBHOOK_URL → only price_transform + signal_evaluation."""
    app = create_app(settings=db_settings)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        async with app.router.lifespan_context(app):
            response = await client.get("/healthz")
            assert response.status_code == 200
            body = response.json()
            assert body["status"] == "ok"
            assert (
                body["schedules"] == 4
            )  # price_transform + signal + universe_sync + price_ingest_daily


async def test_healthz_with_webhook_has_three_schedules(
    db_settings: Settings,
) -> None:
    """DISCORD_WEBHOOK_URL present → notification_dispatch also registered."""
    settings_with_webhook = db_settings.model_copy(
        update={"discord_webhook_url": "https://discord.com/api/webhooks/0/stub"}
    )
    app = create_app(settings=settings_with_webhook)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        async with app.router.lifespan_context(app):
            response = await client.get("/healthz")
            assert response.status_code == 200
            body = response.json()
            assert body["schedules"] == 5  # adds notification_dispatch


async def test_lifespan_starts_and_stops_scheduler(db_settings: Settings) -> None:
    app = create_app(settings=db_settings)
    async with app.router.lifespan_context(app):
        assert app.state.scheduler.running is True
    assert app.state.scheduler.running is False
