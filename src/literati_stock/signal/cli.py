"""Command-line entry point for signal evaluation."""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import date, datetime
from zoneinfo import ZoneInfo

from literati_stock.core.logging import configure_logging
from literati_stock.core.settings import Settings
from literati_stock.ingest.db import build_engine, build_session_factory
from literati_stock.notify.channels.discord import DiscordWebhookChannel
from literati_stock.notify.service import NotificationService
from literati_stock.signal.base import Signal
from literati_stock.signal.rules.institutional_chase import (
    InstitutionalChaseWarningSignal,
)
from literati_stock.signal.rules.volume_surge_red import VolumeSurgeRedSignal
from literati_stock.signal.service import SignalEvaluationService

_SIGNAL_REGISTRY: dict[str, Signal] = {
    "volume_surge_red": VolumeSurgeRedSignal(),
    "institutional_chase_warning": InstitutionalChaseWarningSignal(),
}


def _resolve_signal(name: str) -> Signal:
    if name not in _SIGNAL_REGISTRY:
        raise SystemExit(f"unknown signal {name!r}. known: {sorted(_SIGNAL_REGISTRY)}")
    return _SIGNAL_REGISTRY[name]


def _today_taipei() -> date:
    return datetime.now(ZoneInfo("Asia/Taipei")).date()


async def _evaluate(settings: Settings, signal_name: str, as_of: date) -> int:
    engine = build_engine(settings)
    factory = build_session_factory(engine)
    try:
        service = SignalEvaluationService(factory)
        events = await service.evaluate(_resolve_signal(signal_name), as_of)
    finally:
        await engine.dispose()
    print(
        json.dumps(
            {
                "signal": signal_name,
                "as_of": as_of.isoformat(),
                "events_emitted": len(events),
            }
        )
    )
    return len(events)


async def _backfill(settings: Settings, signal_name: str, start: date, end: date) -> None:
    engine = build_engine(settings)
    factory = build_session_factory(engine)
    try:
        service = SignalEvaluationService(factory)
        days, total_events = await service.backfill(_resolve_signal(signal_name), start, end)
    finally:
        await engine.dispose()
    print(
        json.dumps(
            {
                "signal": signal_name,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "days_processed": days,
                "events_emitted": total_events,
            }
        )
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="literati-signal")
    sub = parser.add_subparsers(dest="command", required=True)

    ev = sub.add_parser("evaluate", help="Evaluate one signal for a single trading day.")
    ev.add_argument("name", help="Signal name (e.g. volume_surge_red).")
    ev.add_argument(
        "--as-of",
        default=None,
        help="Date (YYYY-MM-DD). Defaults to today in Asia/Taipei.",
    )

    bf = sub.add_parser(
        "backfill",
        help="Evaluate one signal over every trading day in [start, end].",
    )
    bf.add_argument("name", help="Signal name (e.g. volume_surge_red).")
    bf.add_argument("--start", required=True, help="Start date YYYY-MM-DD.")
    bf.add_argument(
        "--end",
        default=None,
        help="End date YYYY-MM-DD (defaults to today in Asia/Taipei).",
    )

    nt = sub.add_parser(
        "notify",
        help="Post today's (or --as-of) events to the configured channel.",
    )
    nt.add_argument(
        "--as-of",
        default=None,
        help="Date (YYYY-MM-DD). Defaults to today in Asia/Taipei.",
    )

    return parser


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    settings = Settings()  # pyright: ignore[reportCallIssue]
    configure_logging(settings)

    if args.command == "evaluate":
        as_of = _parse_date(args.as_of) if args.as_of else _today_taipei()
        asyncio.run(_evaluate(settings, args.name, as_of))
        return 0

    if args.command == "backfill":
        start = _parse_date(args.start)
        end = _parse_date(args.end) if args.end else _today_taipei()
        asyncio.run(_backfill(settings, args.name, start, end))
        return 0

    if args.command == "notify":
        as_of = _parse_date(args.as_of) if args.as_of else _today_taipei()
        asyncio.run(_notify(settings, as_of))
        return 0

    parser.print_help()
    return 2


async def _notify(settings: Settings, as_of: date) -> None:
    if not settings.discord_webhook_url:
        print(json.dumps({"error": "DISCORD_WEBHOOK_URL not set; nothing to do."}))
        return

    engine = build_engine(settings)
    factory = build_session_factory(engine)
    channel = DiscordWebhookChannel(settings.discord_webhook_url)
    signal_names = list(_SIGNAL_REGISTRY.keys())
    try:
        service = NotificationService(factory, channel, signal_names)
        total = await service.publish_daily(as_of)
    finally:
        await channel.aclose()
        await engine.dispose()
    print(
        json.dumps(
            {
                "as_of": as_of.isoformat(),
                "signals_checked": signal_names,
                "events_dispatched": total,
            }
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
