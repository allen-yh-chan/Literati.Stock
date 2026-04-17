"""Tests for `literati_stock.notify.templates.build_embeds`."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from literati_stock.notify.base import SignalDispatch
from literati_stock.notify.templates import EMBED_COLOR_GREEN, build_embeds
from literati_stock.signal.base import SignalEventOut

AS_OF = date(2026, 4, 17)


def _event(stock_id: str, severity: float, vol_ratio: float = 2.0) -> SignalEventOut:
    return SignalEventOut(
        signal_name="volume_surge_red",
        stock_id=stock_id,
        trade_date=AS_OF,
        severity=Decimal(str(severity)),
        metadata={
            "vol_ratio": vol_ratio,
            "red_bar_pct": 0.05,
            "close": 100.0,
            "volume": 30_000_000,
            "ma_volume": 10_000_000.0,
        },
    )


def test_empty_dispatches_returns_none() -> None:
    assert build_embeds([], AS_OF) is None


def test_all_empty_events_returns_none() -> None:
    dispatches = [SignalDispatch(signal_name="volume_surge_red", events=[])]
    assert build_embeds(dispatches, AS_OF) is None


def test_single_event_embeds_structure() -> None:
    dispatches = [
        SignalDispatch(
            signal_name="volume_surge_red",
            events=[_event("2303", severity=4.11)],
        )
    ]
    payload = build_embeds(dispatches, AS_OF)
    assert payload is not None
    assert len(payload["embeds"]) == 1
    embed = payload["embeds"][0]
    assert embed["color"] == EMBED_COLOR_GREEN
    assert "爆量長紅" in embed["title"]
    assert "2026-04-17" in embed["title"]
    assert len(embed["fields"]) == 1
    assert embed["fields"][0]["name"] == "2303"
    assert "literati-stock" in embed["footer"]["text"]


def test_fields_sorted_by_severity_desc() -> None:
    dispatches = [
        SignalDispatch(
            signal_name="volume_surge_red",
            events=[
                _event("A", severity=2.0),
                _event("B", severity=4.1),
                _event("C", severity=3.2),
            ],
        )
    ]
    payload = build_embeds(dispatches, AS_OF)
    assert payload is not None
    fields = payload["embeds"][0]["fields"]
    assert [f["name"] for f in fields] == ["B", "C", "A"]


def test_more_than_10_events_truncated() -> None:
    events = [_event(f"{i:04d}", severity=float(i)) for i in range(15)]
    dispatches = [SignalDispatch(signal_name="volume_surge_red", events=events)]
    payload = build_embeds(dispatches, AS_OF)
    assert payload is not None
    embed = payload["embeds"][0]
    assert len(embed["fields"]) == 10
    # Highest severity retained
    assert embed["fields"][0]["name"] == "0014"
    assert "more" in embed["description"]


def test_value_format() -> None:
    dispatches = [
        SignalDispatch(
            signal_name="volume_surge_red",
            events=[_event("2303", severity=4.11, vol_ratio=4.11)],
        )
    ]
    payload = build_embeds(dispatches, AS_OF)
    assert payload is not None
    value = payload["embeds"][0]["fields"][0]["value"]
    assert "量比 4.11x" in value
    assert "漲 5.00%" in value
    assert "收 100" in value
