"""Tests for `literati_stock.ingest.clients.finmind`."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest
import respx
from aiolimiter import AsyncLimiter

from literati_stock.ingest.clients.finmind import (
    FINMIND_BASE_URL,
    FinMindClient,
    FinMindRateLimitError,
    FinMindRequestError,
)

# Fast-retry defaults for unit tests; keeps total wall time < 500ms per test.
_MAX_ATTEMPTS = 3
_WAIT_INIT = 0.01
_WAIT_MAX = 0.05


def _unbounded_limiter() -> AsyncLimiter:
    return AsyncLimiter(max_rate=10_000, time_period=60.0)


@respx.mock
async def test_successful_fetch_returns_data() -> None:
    respx.get(FINMIND_BASE_URL).mock(
        return_value=httpx.Response(
            200, json={"status": 200, "msg": "success", "data": [{"x": 1}, {"x": 2}]}
        )
    )
    client = FinMindClient(token="", limiter=_unbounded_limiter(), max_attempts=1)
    try:
        rows = await client.fetch("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    finally:
        await client.aclose()
    assert rows == [{"x": 1}, {"x": 2}]


@respx.mock
async def test_http_429_retries_then_succeeds() -> None:
    route = respx.get(FINMIND_BASE_URL).mock(
        side_effect=[
            httpx.Response(429, text="rate limited"),
            httpx.Response(200, json={"status": 200, "msg": "success", "data": [{"x": 1}]}),
        ]
    )
    client = FinMindClient(
        token="",
        limiter=_unbounded_limiter(),
        max_attempts=_MAX_ATTEMPTS,
        retry_wait_initial=_WAIT_INIT,
        retry_wait_max=_WAIT_MAX,
    )
    try:
        rows = await client.fetch("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    finally:
        await client.aclose()
    assert rows == [{"x": 1}]
    assert route.call_count == 2


@respx.mock
async def test_finmind_402_in_body_is_retryable() -> None:
    respx.get(FINMIND_BASE_URL).mock(
        return_value=httpx.Response(200, json={"status": 402, "msg": "rate limit"})
    )
    client = FinMindClient(
        token="",
        limiter=_unbounded_limiter(),
        max_attempts=_MAX_ATTEMPTS,
        retry_wait_initial=_WAIT_INIT,
        retry_wait_max=_WAIT_MAX,
    )
    try:
        with pytest.raises(FinMindRateLimitError):
            await client.fetch("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    finally:
        await client.aclose()


@respx.mock
async def test_http_5xx_retries_and_exhausts() -> None:
    route = respx.get(FINMIND_BASE_URL).mock(return_value=httpx.Response(500, text="server error"))
    client = FinMindClient(
        token="",
        limiter=_unbounded_limiter(),
        max_attempts=2,
        retry_wait_initial=_WAIT_INIT,
        retry_wait_max=_WAIT_MAX,
    )
    try:
        with pytest.raises(FinMindRateLimitError):
            await client.fetch("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    finally:
        await client.aclose()
    assert route.call_count == 2


@respx.mock
async def test_non_retryable_status_raises_immediately() -> None:
    route = respx.get(FINMIND_BASE_URL).mock(
        return_value=httpx.Response(200, json={"status": 401, "msg": "unauthorized"})
    )
    client = FinMindClient(token="", limiter=_unbounded_limiter(), max_attempts=5)
    try:
        with pytest.raises(FinMindRequestError):
            await client.fetch("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    finally:
        await client.aclose()
    assert route.call_count == 1


@respx.mock
async def test_token_is_propagated_in_params() -> None:
    route = respx.get(FINMIND_BASE_URL).mock(
        return_value=httpx.Response(200, json={"status": 200, "msg": "success", "data": []})
    )
    client = FinMindClient(token="secret-abc", limiter=_unbounded_limiter(), max_attempts=1)
    try:
        await client.fetch("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
    finally:
        await client.aclose()
    assert route.called
    sent_request = route.calls.last.request
    assert sent_request.url.params["token"] == "secret-abc"


@respx.mock
async def test_limiter_throttles_burst_calls() -> None:
    """With max_rate=4/1s, 8 concurrent calls should take ≥ ~1s (bucket refill)."""
    respx.get(FINMIND_BASE_URL).mock(
        return_value=httpx.Response(200, json={"status": 200, "msg": "success", "data": []})
    )
    limiter = AsyncLimiter(max_rate=4, time_period=1.0)
    client = FinMindClient(token="", limiter=limiter, max_attempts=1)
    start = time.monotonic()
    try:
        await asyncio.gather(
            *[
                client.fetch("TaiwanStockPrice", data_id="2330", start_date="2025-01-02")
                for _ in range(8)
            ]
        )
    finally:
        await client.aclose()
    elapsed = time.monotonic() - start
    assert elapsed >= 0.9, f"expected throttle delay ≥ 0.9s, got {elapsed:.3f}s"
