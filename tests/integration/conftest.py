"""Integration-test fixtures: testcontainers PostgreSQL + Alembic upgrade."""

from __future__ import annotations

import os
import subprocess
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession
from testcontainers.postgres import PostgresContainer

from literati_stock.core.settings import Settings
from literati_stock.ingest.db import build_engine, build_session_factory

PROJECT_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def postgres_container() -> Iterator[PostgresContainer]:
    """Spin up a single PostgreSQL container for the test session."""
    with PostgresContainer("postgres:16-alpine", driver="asyncpg") as pg:
        yield pg


@pytest.fixture(scope="session")
def db_settings(postgres_container: PostgresContainer) -> Settings:
    """Build Settings whose DATABASE_URL targets the test container."""
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        database_url=postgres_container.get_connection_url(),
        finmind_token="",
        log_level="INFO",
        log_format="console",
        scheduler_timezone="Asia/Taipei",
    )


@pytest.fixture(scope="session")
def alembic_upgraded(db_settings: Settings) -> None:
    """Run `alembic upgrade head` against the test container once per session."""
    env = os.environ.copy()
    env["DATABASE_URL"] = db_settings.database_url
    subprocess.run(
        ["uv", "run", "alembic", "upgrade", "head"],
        check=True,
        env=env,
        cwd=str(PROJECT_ROOT),
    )


@pytest_asyncio.fixture
async def session(db_settings: Settings, alembic_upgraded: None) -> AsyncIterator[AsyncSession]:
    """Per-test async session bound to the migrated test database."""
    engine = build_engine(db_settings)
    factory = build_session_factory(engine)
    async with factory() as s:
        yield s
        await s.rollback()
    await engine.dispose()
