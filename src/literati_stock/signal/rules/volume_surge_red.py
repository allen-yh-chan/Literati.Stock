"""`volume_surge_red` signal: 爆量長紅 — volume surge + meaningful red bar."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from literati_stock.signal.base import PriceRow, SignalEventOut


@dataclass(frozen=True, slots=True)
class VolumeSurgeRedSignal:
    """Fires when all of the following hold for a (stock, trade_date):

    1. ``close >= min_close_price`` — exclude penny stocks (仙股)
    2. ``(close - open) / open >= min_red_bar_pct`` — meaningful red bar
    3. ``ma_volume is not None`` — enough history
    4. ``volume >= volume_multiple * ma_volume`` — volume surge

    Severity is ``volume / ma_volume`` (higher = more extreme surge).
    """

    name: str = "volume_surge_red"
    window_days: int = 20
    volume_multiple: float = 2.0
    min_red_bar_pct: float = 0.015
    min_close_price: Decimal = Decimal("10")

    def evaluate(self, rows: Sequence[PriceRow], as_of: date) -> list[SignalEventOut]:
        events: list[SignalEventOut] = []
        for row in rows:
            if row.trade_date != as_of:
                continue
            if row.close < self.min_close_price:
                continue
            if row.open <= 0:
                continue  # guard against bad data
            red_bar_pct = (row.close - row.open) / row.open
            if red_bar_pct < Decimal(str(self.min_red_bar_pct)):
                continue
            if row.ma_volume is None or row.ma_volume == 0:
                continue
            vol_ratio = Decimal(row.volume) / row.ma_volume
            if vol_ratio < Decimal(str(self.volume_multiple)):
                continue
            events.append(
                SignalEventOut(
                    signal_name=self.name,
                    stock_id=row.stock_id,
                    trade_date=row.trade_date,
                    severity=vol_ratio.quantize(Decimal("0.0001")),
                    metadata={
                        "volume": row.volume,
                        "ma_volume": float(row.ma_volume),
                        "vol_ratio": float(vol_ratio),
                        "red_bar_pct": float(red_bar_pct),
                        "close": float(row.close),
                        "open": float(row.open),
                        "window_days": self.window_days,
                    },
                )
            )
        return events
