"""Integration test for FastAPI `/healthz` and lifespan."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from literati_stock.api.main import create_app
from literati_stock.core.settings import Settings

pytestmark = pytest.mark.integration


async def test_healthz_reports_zero_schedules(db_settings: Settings) -> None:
    app = create_app(settings=db_settings)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        async with app.router.lifespan_context(app):
            response = await client.get("/healthz")
            assert response.status_code == 200
            body = response.json()
            assert body == {"status": "ok", "schedules": 0}


async def test_lifespan_starts_and_stops_scheduler(db_settings: Settings) -> None:
    app = create_app(settings=db_settings)
    async with app.router.lifespan_context(app):
        assert app.state.scheduler.running is True
    assert app.state.scheduler.running is False
