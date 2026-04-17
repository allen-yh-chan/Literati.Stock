"""Async httpx-based client for the FinMind REST API.

FinMind's SDK (v1.9.7) mis-declares its ``tqdm`` dependency and pulls an
unnecessarily large import graph (backtest strategies, crawler). For the ingest
layer we only need GET requests against ``/api/v4/data``, so we call the REST
endpoint directly via ``httpx`` and layer rate limiting + retry on top.
"""

from __future__ import annotations

from types import TracebackType
from typing import Any, Self, cast

import httpx
import structlog
from aiolimiter import AsyncLimiter
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

logger = structlog.get_logger(__name__)

FINMIND_BASE_URL = "https://api.finmindtrade.com/api/v4/data"

# FinMind returns HTTP 200 even for rate-limit errors, signalling them inside
# the JSON body with ``status == 402``. We treat that identically to HTTP 429.
_FINMIND_RATE_LIMIT_STATUS = 402


class FinMindError(Exception):
    """Base error for FinMind client failures."""


class FinMindRateLimitError(FinMindError):
    """Raised when the FinMind rate limit persists after all retry attempts."""


class FinMindRequestError(FinMindError):
    """Non-retryable API failure (e.g. auth, bad dataset)."""


class _TransientError(Exception):
    """Internal marker for retryable conditions (HTTP 429 / 5xx / FinMind 402)."""


def _parse_response(resp: httpx.Response, dataset: str) -> list[dict[str, Any]]:
    """Map an HTTP response to a data list or raise a typed error."""
    status = resp.status_code
    if status == 429:
        raise _TransientError(f"HTTP 429 for {dataset}")
    if 500 <= status < 600:
        raise _TransientError(f"HTTP {status} for {dataset}")
    resp.raise_for_status()

    body_any: Any = resp.json()
    if not isinstance(body_any, dict):
        raise FinMindRequestError(f"unexpected body shape for {dataset}")
    body = cast(dict[str, Any], body_any)

    api_status = body.get("status")
    api_msg = body.get("msg", "")
    if api_status == _FINMIND_RATE_LIMIT_STATUS:
        raise _TransientError(f"FinMind rate limit for {dataset}: {api_msg}")
    if api_status != 200:
        raise FinMindRequestError(f"FinMind error for {dataset}: status={api_status} msg={api_msg}")

    data_any = body.get("data", [])
    if not isinstance(data_any, list):
        raise FinMindRequestError(
            f"FinMind data field is not a list for {dataset}: got {type(data_any).__name__}"
        )
    return cast(list[dict[str, Any]], data_any)


class FinMindClient:
    """Async client wrapping FinMind's ``/api/v4/data`` endpoint.

    - Client-side throttling via the injected ``AsyncLimiter`` (e.g. 8/min).
    - Retries HTTP 429, HTTP 5xx and FinMind's in-body status 402 with
      exponential-jittered backoff, up to ``max_attempts`` times.
    - Leaves owned ``httpx.AsyncClient`` instances to be closed via
      ``aclose()`` / ``async with`` usage; injected clients are not closed.
    """

    def __init__(
        self,
        token: str,
        limiter: AsyncLimiter,
        http_client: httpx.AsyncClient | None = None,
        *,
        base_url: str = FINMIND_BASE_URL,
        max_attempts: int = 5,
        retry_wait_initial: float = 2.0,
        retry_wait_max: float = 60.0,
        timeout: float = 30.0,
    ) -> None:
        self._token = token
        self._limiter = limiter
        self._http = http_client or httpx.AsyncClient(timeout=timeout)
        self._base_url = base_url
        self._max_attempts = max_attempts
        self._retry_wait_initial = retry_wait_initial
        self._retry_wait_max = retry_wait_max
        self._own_client = http_client is None

    @property
    def max_attempts(self) -> int:
        return self._max_attempts

    async def fetch(
        self,
        dataset: str,
        *,
        data_id: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch a dataset slice; returns the ``data`` array from the body.

        `data_id` and `start_date` are optional to accommodate datasets like
        `TaiwanStockInfo` that return the full snapshot without filters.
        """

        @retry(
            retry=retry_if_exception_type(_TransientError),
            wait=wait_exponential_jitter(
                initial=self._retry_wait_initial, max=self._retry_wait_max
            ),
            stop=stop_after_attempt(self._max_attempts),
            reraise=True,
        )
        async def _attempt() -> list[dict[str, Any]]:
            async with self._limiter:
                params: dict[str, str] = {"dataset": dataset}
                if data_id is not None:
                    params["data_id"] = data_id
                if start_date is not None:
                    params["start_date"] = start_date
                if end_date is not None:
                    params["end_date"] = end_date
                if self._token:
                    params["token"] = self._token

                log = logger.bind(dataset=dataset, data_id=data_id, start_date=start_date)
                log.debug("finmind.fetch.start")
                resp = await self._http.get(self._base_url, params=params)
                log.debug("finmind.fetch.response", http_status=resp.status_code)
                return _parse_response(resp, dataset)

        try:
            return await _attempt()
        except _TransientError as exc:
            raise FinMindRateLimitError(str(exc)) from exc

    async def aclose(self) -> None:
        if self._own_client:
            await self._http.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.aclose()
