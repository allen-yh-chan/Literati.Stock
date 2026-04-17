"""Daily notification dispatch service."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from literati_stock.notify.base import NotificationChannel, SignalDispatch
from literati_stock.signal.base import SignalEventOut
from literati_stock.signal.models import SignalEvent

logger = structlog.get_logger(__name__)


class NotificationService:
    """Reads `signal_event` for `as_of` grouped by signal name, and hands a
    list of non-empty `SignalDispatch` to the injected channel. Skips the
    channel call entirely when no dispatch has events (no-spam contract)."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        channel: NotificationChannel,
        signal_names: Sequence[str],
    ) -> None:
        self._sf = session_factory
        self._channel = channel
        self._signal_names = tuple(signal_names)

    async def publish_daily(self, as_of: date) -> int:
        """Collect today's events per signal and send to channel. Returns
        total events dispatched (0 when nothing to send)."""
        dispatches: list[SignalDispatch] = []
        async with self._sf() as session:
            for name in self._signal_names:
                events = await self._load_events(session, name, as_of)
                if events:
                    dispatches.append(SignalDispatch(signal_name=name, events=events))

        total = sum(len(d.events) for d in dispatches)
        if not dispatches:
            logger.info(
                "notify.publish.skipped_empty",
                as_of=as_of.isoformat(),
                signal_names=list(self._signal_names),
            )
            return 0

        await self._channel.publish_daily(dispatches, as_of)
        logger.info(
            "notify.publish.sent",
            as_of=as_of.isoformat(),
            dispatches=len(dispatches),
            events=total,
        )
        return total

    async def _load_events(
        self, session: AsyncSession, signal_name: str, as_of: date
    ) -> list[SignalEventOut]:
        stmt = select(SignalEvent).where(
            SignalEvent.signal_name == signal_name,
            SignalEvent.trade_date == as_of,
        )
        result = await session.execute(stmt)
        rows = result.scalars().all()
        return [
            SignalEventOut(
                signal_name=r.signal_name,
                stock_id=r.stock_id,
                trade_date=r.trade_date,
                severity=r.severity,
                metadata=r.event_metadata,
            )
            for r in rows
        ]
