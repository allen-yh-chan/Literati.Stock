"""Tests for `DiscordWebhookChannel` (respx-mocked)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import httpx
import pytest
import respx

from literati_stock.notify.base import SignalDispatch
from literati_stock.notify.channels.discord import (
    DiscordNotificationError,
    DiscordWebhookChannel,
)
from literati_stock.signal.base import SignalEventOut

WEBHOOK_URL = "https://discord.com/api/webhooks/000/aaa-token"
AS_OF = date(2026, 4, 17)


def _hit(stock_id: str) -> SignalEventOut:
    return SignalEventOut(
        signal_name="volume_surge_red",
        stock_id=stock_id,
        trade_date=AS_OF,
        severity=Decimal("3.0"),
        metadata={
            "vol_ratio": 3.0,
            "red_bar_pct": 0.05,
            "close": 100.0,
        },
    )


def _dispatches() -> list[SignalDispatch]:
    return [SignalDispatch(signal_name="volume_surge_red", events=[_hit("2303")])]


def test_empty_webhook_url_rejected() -> None:
    with pytest.raises(ValueError):
        DiscordWebhookChannel("")


@respx.mock
async def test_successful_publish_posts_json() -> None:
    route = respx.post(WEBHOOK_URL).mock(return_value=httpx.Response(204))
    channel = DiscordWebhookChannel(
        WEBHOOK_URL, max_attempts=1, retry_wait_initial=0.01, retry_wait_max=0.05
    )
    try:
        await channel.publish_daily(_dispatches(), AS_OF)
    finally:
        await channel.aclose()

    assert route.called
    sent = route.calls.last.request
    body = sent.content.decode()
    assert "embeds" in body
    assert "2303" in body


@respx.mock
async def test_empty_dispatches_no_op() -> None:
    route = respx.post(WEBHOOK_URL).mock(return_value=httpx.Response(204))
    channel = DiscordWebhookChannel(
        WEBHOOK_URL, max_attempts=1, retry_wait_initial=0.01, retry_wait_max=0.05
    )
    try:
        await channel.publish_daily([], AS_OF)
    finally:
        await channel.aclose()

    assert not route.called


@respx.mock
async def test_http_429_retries_then_succeeds() -> None:
    route = respx.post(WEBHOOK_URL).mock(
        side_effect=[
            httpx.Response(429, text="rate limited"),
            httpx.Response(204),
        ]
    )
    channel = DiscordWebhookChannel(
        WEBHOOK_URL, max_attempts=3, retry_wait_initial=0.01, retry_wait_max=0.05
    )
    try:
        await channel.publish_daily(_dispatches(), AS_OF)
    finally:
        await channel.aclose()

    assert route.call_count == 2


@respx.mock
async def test_http_5xx_exhausts() -> None:
    respx.post(WEBHOOK_URL).mock(return_value=httpx.Response(503, text="down"))
    channel = DiscordWebhookChannel(
        WEBHOOK_URL, max_attempts=2, retry_wait_initial=0.01, retry_wait_max=0.05
    )
    try:
        with pytest.raises(DiscordNotificationError):
            await channel.publish_daily(_dispatches(), AS_OF)
    finally:
        await channel.aclose()


@respx.mock
async def test_http_400_does_not_retry() -> None:
    route = respx.post(WEBHOOK_URL).mock(return_value=httpx.Response(400, text="bad embed"))
    channel = DiscordWebhookChannel(
        WEBHOOK_URL, max_attempts=5, retry_wait_initial=0.01, retry_wait_max=0.05
    )
    try:
        with pytest.raises(DiscordNotificationError):
            await channel.publish_daily(_dispatches(), AS_OF)
    finally:
        await channel.aclose()

    assert route.call_count == 1


def test_webhook_host_property_is_host_only() -> None:
    channel = DiscordWebhookChannel(WEBHOOK_URL)
    assert channel._webhook_host == "discord.com"
    # The host property must never expose the path/token portion.
    assert "aaa-token" not in channel._webhook_host
    assert "/api/webhooks" not in channel._webhook_host
