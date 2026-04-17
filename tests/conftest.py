"""Top-level pytest fixtures and shared test configuration."""

from __future__ import annotations

import pytest
import structlog


@pytest.fixture(autouse=True)
def _reset_structlog() -> None:  # pyright: ignore[reportUnusedFunction]
    """Reset structlog global config between tests to prevent leakage."""
    structlog.reset_defaults()
