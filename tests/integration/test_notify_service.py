"""Integration tests for `NotificationService` against real PostgreSQL."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.notify.service import NotificationService
from literati_stock.signal.models import SignalEvent

pytestmark = pytest.mark.integration

AS_OF = date(2026, 4, 17)


async def _add_event(
    session: AsyncSession,
    signal_name: str,
    stock_id: str,
    trade_date: date,
    severity: Decimal,
    metadata: dict[str, Any] | None = None,
) -> None:
    session.add(
        SignalEvent(
            signal_name=signal_name,
            stock_id=stock_id,
            trade_date=trade_date,
            severity=severity,
            event_metadata=metadata or {"vol_ratio": float(severity)},
        )
    )
    await session.flush()


async def test_publishes_only_today_events_for_registered_signals(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _add_event(session, "volume_surge_red", "2330", AS_OF, Decimal("2.5"))
    await _add_event(session, "volume_surge_red", "2454", AS_OF, Decimal("3.1"))
    await _add_event(session, "volume_surge_red", "2317", date(2026, 4, 16), Decimal("2.2"))
    await _add_event(session, "some_other_signal", "2330", AS_OF, Decimal("5.0"))
    await session.commit()

    channel = AsyncMock()
    service = NotificationService(session_factory, channel, signal_names=["volume_surge_red"])
    total = await service.publish_daily(AS_OF)

    assert total == 2
    channel.publish_daily.assert_awaited_once()
    dispatches, as_of_arg = channel.publish_daily.await_args.args
    assert as_of_arg == AS_OF
    assert len(dispatches) == 1
    assert dispatches[0].signal_name == "volume_surge_red"
    assert [e.stock_id for e in dispatches[0].events] == ["2330", "2454"] or [
        e.stock_id for e in dispatches[0].events
    ] == ["2454", "2330"]


async def test_no_events_skips_channel(
    session: AsyncSession,  # noqa: ARG001 — ensures truncation fixture ran
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    channel = AsyncMock()
    service = NotificationService(session_factory, channel, signal_names=["volume_surge_red"])
    total = await service.publish_daily(AS_OF)

    assert total == 0
    channel.publish_daily.assert_not_awaited()
