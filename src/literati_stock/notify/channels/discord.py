"""Discord webhook channel: POST one embed payload per signal dispatch."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from urllib.parse import urlparse

import httpx
import structlog
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from literati_stock.notify.base import SignalDispatch
from literati_stock.notify.templates import build_embeds

logger = structlog.get_logger(__name__)


class DiscordNotificationError(Exception):
    """Non-retryable Discord API error (4xx other than 429)."""


class _TransientDiscordError(Exception):
    """Internal marker for retryable conditions (429 / 5xx)."""


class DiscordWebhookChannel:
    """POST a single JSON payload with embeds to a Discord webhook URL."""

    def __init__(
        self,
        webhook_url: str,
        http_client: httpx.AsyncClient | None = None,
        *,
        max_attempts: int = 3,
        retry_wait_initial: float = 2.0,
        retry_wait_max: float = 30.0,
        timeout: float = 10.0,
    ) -> None:
        if not webhook_url:
            raise ValueError("webhook_url must be non-empty")
        self._webhook_url = webhook_url
        self._http = http_client or httpx.AsyncClient(timeout=timeout)
        self._own_client = http_client is None
        self._max_attempts = max_attempts
        self._retry_wait_initial = retry_wait_initial
        self._retry_wait_max = retry_wait_max

    @property
    def _webhook_host(self) -> str:
        """Host component only — safe to log."""
        return urlparse(self._webhook_url).hostname or "unknown"

    async def publish_daily(self, dispatches: Sequence[SignalDispatch], as_of: date) -> None:
        payload = build_embeds(dispatches, as_of)
        if payload is None:
            logger.debug("discord.publish.empty_noop", webhook_host=self._webhook_host)
            return

        @retry(
            retry=retry_if_exception_type(_TransientDiscordError),
            wait=wait_exponential_jitter(
                initial=self._retry_wait_initial, max=self._retry_wait_max
            ),
            stop=stop_after_attempt(self._max_attempts),
            reraise=True,
        )
        async def _attempt() -> None:
            log = logger.bind(
                webhook_host=self._webhook_host,
                embeds=len(payload["embeds"]),
                as_of=as_of.isoformat(),
            )
            log.debug("discord.publish.start")
            resp = await self._http.post(self._webhook_url, json=payload)
            log.debug("discord.publish.response", http_status=resp.status_code)
            if resp.status_code == 429 or 500 <= resp.status_code < 600:
                raise _TransientDiscordError(f"Discord HTTP {resp.status_code} (retryable)")
            if resp.status_code >= 400:
                raise DiscordNotificationError(
                    f"Discord HTTP {resp.status_code}: {resp.text[:200]}"
                )

        try:
            await _attempt()
        except _TransientDiscordError as exc:
            raise DiscordNotificationError(str(exc)) from exc

    async def aclose(self) -> None:
        if self._own_client:
            await self._http.aclose()
