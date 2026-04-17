"""structlog bootstrap with JSON / console output modes."""

from __future__ import annotations

import logging
import sys

import structlog
from structlog.stdlib import BoundLogger
from structlog.types import Processor

from literati_stock.core.settings import Settings


def configure_logging(settings: Settings) -> None:
    """Configure structlog and the stdlib logging root according to settings.

    JSON mode emits one JSON object per line (production); console mode emits
    a colorised, human-readable line (local dev).
    """
    level = logging.getLevelNamesMapping()[settings.log_level]

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
        force=True,
    )

    # Quiet third-party request loggers that dump full URLs (including tokens
    # like the Discord webhook secret) at INFO level by default.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    shared_processors: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
    ]

    renderer: Processor = (
        structlog.processors.JSONRenderer()
        if settings.log_format == "json"
        else structlog.dev.ConsoleRenderer(colors=True)
    )

    structlog.configure(
        processors=[*shared_processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> BoundLogger:
    """Return a structlog BoundLogger; `name` becomes the `logger` field."""
    return structlog.get_logger(name)
