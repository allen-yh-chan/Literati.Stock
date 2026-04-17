"""Embed payload formatting for Discord notifications."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from decimal import Decimal
from typing import Any

from literati_stock.notify.base import SignalDispatch
from literati_stock.signal.base import SignalEventOut

# Discord field ceiling is 25; we cap at 10 to keep each embed compact.
MAX_FIELDS_PER_EMBED = 10
EMBED_COLOR_GREEN = 0x3BA55D

# Display labels for signal names (fallback to name if missing).
SIGNAL_LABELS_ZH: Mapping[str, str] = {
    "volume_surge_red": "爆量長紅",
}


def build_embeds(
    dispatches: Sequence[SignalDispatch],
    as_of: date,
    *,
    labels: Mapping[str, str] = SIGNAL_LABELS_ZH,
) -> dict[str, Any] | None:
    """Return a Discord-ready payload, or `None` when nothing to send.

    Returns `None` when every dispatch's `events` list is empty — caller
    MUST skip the HTTP call in that case.
    """
    embeds: list[dict[str, Any]] = []
    for dispatch in dispatches:
        if not dispatch.events:
            continue
        embeds.append(_build_one_embed(dispatch, as_of, labels))
    if not embeds:
        return None
    return {"embeds": embeds}


def _build_one_embed(
    dispatch: SignalDispatch,
    as_of: date,
    labels: Mapping[str, str],
) -> dict[str, Any]:
    label = labels.get(dispatch.signal_name, dispatch.signal_name)
    sorted_events = sorted(
        dispatch.events,
        key=lambda e: e.severity if e.severity is not None else Decimal("0"),
        reverse=True,
    )
    total = len(sorted_events)
    displayed = sorted_events[:MAX_FIELDS_PER_EMBED]

    description = f"{total} 檔命中"
    if total > len(displayed):
        description += f"(顯示前 {len(displayed)} 檔,+{total - len(displayed)} more)"

    fields = [
        {
            "name": ev.stock_id,
            "value": _format_event_value(ev),
            "inline": False,
        }
        for ev in displayed
    ]

    return {
        "title": f"📈 量先價行 — {label} | {as_of.isoformat()}",
        "color": EMBED_COLOR_GREEN,
        "description": description,
        "fields": fields,
        "footer": {"text": f"literati-stock · signal: {dispatch.signal_name}"},
    }


def _format_event_value(event: SignalEventOut) -> str:
    md = event.metadata or {}
    vol_ratio = md.get("vol_ratio")
    red_pct = md.get("red_bar_pct")
    close = md.get("close")

    parts: list[str] = []
    if isinstance(vol_ratio, (int, float)):
        parts.append(f"量比 {vol_ratio:.2f}x")
    if isinstance(red_pct, (int, float)):
        parts.append(f"漲 {red_pct * 100:.2f}%")
    if isinstance(close, (int, float)):
        parts.append(f"收 {close:g}")

    return " · ".join(parts) if parts else "(no metadata)"
