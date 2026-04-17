"""`institutional_chase_warning` signal: 散戶追價警訊."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from literati_stock.signal.base import (
    InstitutionalRow,
    MarginRow,
    PriceRow,
    SignalEventOut,
    SignalFeatures,
)


@dataclass(frozen=True, slots=True)
class InstitutionalChaseWarningSignal:
    """Fires when institutional (法人) keeps buying while retail margin
    (融資) balance grows AND price is rising — classic 散戶追價 pattern.

    Conditions (all must hold at `as_of`):
    1. `institutional.total_net > 0` on `as_of` and the two prior trading
       days available in `features` (three consecutive days of net buying).
    2. `margin.margin_today_balance` grows vs the balance `window_days // 2`
       trading days earlier by at least `min_margin_growth_pct`.
    3. `prices.close` on `as_of` is higher than `prices.close` from
       `window_days // 2` trading days earlier (up-trend confirmation).

    Severity = ratio of today's margin balance to the earlier one
    (>1.0 = retail leveraging up into a rally).
    """

    name: str = "institutional_chase_warning"
    window_days: int = 5
    min_margin_growth_pct: float = 0.05
    min_institutional_days: int = 3  # consecutive days of positive total_net

    def evaluate(self, features: SignalFeatures, as_of: date) -> list[SignalEventOut]:
        lookback_days = self.window_days // 2 or 1

        inst_by_stock = _group_by_stock(features.institutional)
        margin_by_stock = _group_margin_by_stock(features.margin)
        price_by_stock = _group_price_by_stock(features.prices)

        events: list[SignalEventOut] = []
        for stock_id, inst_rows in inst_by_stock.items():
            if not self._institutional_buying_streak(inst_rows, as_of):
                continue
            margin_growth = self._margin_growth_ratio(
                margin_by_stock.get(stock_id, []), as_of, lookback_days
            )
            if margin_growth is None:
                continue
            if margin_growth < Decimal("1") + Decimal(str(self.min_margin_growth_pct)):
                continue
            price_change = self._price_change_pct(
                price_by_stock.get(stock_id, []), as_of, lookback_days
            )
            if price_change is None or price_change <= 0:
                continue

            events.append(
                SignalEventOut(
                    signal_name=self.name,
                    stock_id=stock_id,
                    trade_date=as_of,
                    severity=margin_growth.quantize(Decimal("0.0001")),
                    metadata={
                        "margin_growth_ratio": float(margin_growth),
                        "price_change_pct": float(price_change),
                        "institutional_streak_days": self.min_institutional_days,
                        "window_days": self.window_days,
                    },
                )
            )
        return events

    def _institutional_buying_streak(self, rows: list[InstitutionalRow], as_of: date) -> bool:
        by_date: dict[date, InstitutionalRow] = {r.trade_date: r for r in rows}
        if as_of not in by_date:
            return False
        required: list[date] = []
        # Walk back up to window_days to find `min_institutional_days` trading
        # days on or before `as_of`.
        offset = 0
        while len(required) < self.min_institutional_days and offset < self.window_days * 2:
            candidate = as_of - timedelta(days=offset)
            if candidate in by_date:
                required.append(candidate)
            offset += 1
        if len(required) < self.min_institutional_days:
            return False
        return all(by_date[d].total_net > 0 for d in required)

    @staticmethod
    def _margin_growth_ratio(
        rows: list[MarginRow], as_of: date, lookback_days: int
    ) -> Decimal | None:
        by_date = {r.trade_date: r for r in rows}
        today = by_date.get(as_of)
        if today is None or today.margin_today_balance <= 0:
            return None

        earlier: MarginRow | None = None
        # Find the first-available margin row at or before as_of - lookback trading days.
        offset = lookback_days
        while offset < lookback_days * 4:
            candidate = as_of - timedelta(days=offset)
            if candidate in by_date:
                earlier = by_date[candidate]
                break
            offset += 1
        if earlier is None or earlier.margin_today_balance <= 0:
            return None
        return Decimal(today.margin_today_balance) / Decimal(earlier.margin_today_balance)

    @staticmethod
    def _price_change_pct(rows: list[PriceRow], as_of: date, lookback_days: int) -> Decimal | None:
        by_date = {r.trade_date: r for r in rows}
        today = by_date.get(as_of)
        if today is None or today.close <= 0:
            return None
        earlier: PriceRow | None = None
        offset = lookback_days
        while offset < lookback_days * 4:
            candidate = as_of - timedelta(days=offset)
            if candidate in by_date:
                earlier = by_date[candidate]
                break
            offset += 1
        if earlier is None or earlier.close <= 0:
            return None
        return (today.close - earlier.close) / earlier.close


def _group_by_stock(
    rows: Sequence[InstitutionalRow],
) -> dict[str, list[InstitutionalRow]]:
    out: dict[str, list[InstitutionalRow]] = {}
    for r in rows:
        out.setdefault(r.stock_id, []).append(r)
    return out


def _group_margin_by_stock(rows: Sequence[MarginRow]) -> dict[str, list[MarginRow]]:
    out: dict[str, list[MarginRow]] = {}
    for r in rows:
        out.setdefault(r.stock_id, []).append(r)
    return out


def _group_price_by_stock(rows: Sequence[PriceRow]) -> dict[str, list[PriceRow]]:
    out: dict[str, list[PriceRow]] = {}
    for r in rows:
        out.setdefault(r.stock_id, []).append(r)
    return out
