"""0050 DCA + buy-only top-up backtest (pre-registered rules).

Run: ``uv run python -m literati_stock.backtest.dip_topup --end-date 2026-11-23``

PRE-REGISTRATION — every rule and parameter below was fixed and committed
*before* the first run on real data, and the number of times any trigger
fires on real 0050 data was not looked at before that commit. Do not tune
after seeing results (see INVESTMENT_DECISION.md "backtest pact").

Question
    Never selling, can extra buying at chosen moments beat plain DCA on
    XIRR? Two funding sources × four triggers, each against its own baseline.

Segments (money simulated from zero in each; signals use full history)
    設計段 2003-06-30 .. 2014-12-31;  驗證段 2015-01-01 .. end.
    Only month-end/daily bars inside a segment, excluding its last bar, can
    raise a signal; a signal on the bar before a segment does not carry in.
    A segment with fewer than 2 bars is an error.

Base DCA (every strategy)
    NT$10,000 at the close of the first bar of each calendar month (full-
    series flag, so 2015-01-02 contributes), bought into 0050.

Funding a — 預支 (baseline A = pure DCA)
    On the bar after a trigger, borrow 3 × 10,000 and buy. The next 3
    monthly contributions repay the loan instead of buying: 10,000, 10,000,
    then the whole remaining balance (principal + interest). The loan
    accrues 1.5% p.a., compounded per calendar day. While a loan is open,
    triggers are ignored. An open loan at segment end is netted from value.
    Control a-ALL: trigger at every month-end (no signal). Advancing money
    into a rising market has positive expected value on its own; a trigger's
    gain per advance vs a-ALL's is a hint about timing, not a clean
    attribution (it also mixes interest paid and holding-period length).

Funding b — 年終 (baseline B0 = buy the bonus on receipt)
    NT$30,000 arrives at the first bar of each February (in segment). It
    waits as cash at 1.5% p.a. (compounded per calendar day) and is fully
    invested on the bar after a trigger. Cash left at segment end counts.

Triggers (signals on the total-return index unless stated)
    ALL   every month-end (control for funding a only)
    T10   month-end TR <= 90% of its running all-time high since 2003-06-30
    T20   month-end TR <= 80% of that high
    T200  month-end TR < its 200-bar SMA (no signal before 200 bars exist)
    TVOL  any bar, 0050's own volume-surge red bar, using the parameters
          frozen in ``signal/rules/volume_surge_red.py``: raw close >= 10,
          (close - open) / open >= 1.5%, volume >= 2 × mean volume of the
          last 20 bars *including today* (fewer bars early on: mean of what
          exists), mirroring ``signal/service.py`` ``rows (-19, 0)``.
          Volume before a split is multiplied by the later split ratios.

Execution and order
    Every trigger executes at the close of the *next* bar. Same-day order:
    cash/loan interest → split → dividend reinvest → contribution, repayment
    and bonus → pending execution → signal → NAV. Fractional shares; buy fee
    0.1425% × 0.28; never sell; dividends reinvested at the ex-date close.

Metrics and verdict
    XIRR on the investor's own cash: each monthly 10,000 (buy or repay), the
    extra interest in the last repayment, each bonus; final net value.
    Max drawdown of a time-weighted unit NAV, NAV = (shares × price + cash −
    loan) / units. ΔXIRR = strategy − baseline. Verdict: 樣本不足 if either
    segment executed fewer than 5 top-ups; else 無法判定 if any XIRR is nan;
    else 勝 iff ΔXIRR > 0 in both segments, otherwise 負. For a-rows the
    gain per advance (net value − A's) / advances is also shown next to
    a-ALL's. This tests 0050's own volume surge, not the stock-level
    量先價行 thesis.
"""

from __future__ import annotations

import argparse
import asyncio
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Literal

from literati_stock.backtest.data import (
    Bar,
    MarketData,
    parse_market_data,
    parse_open_volume,
)
from literati_stock.backtest.dca_satellite import (
    DEFAULT_CACHE_DIR,
    STOCK_ID,
    buy_shares,
    contribution_flags,
    load_raw_rows,
    month_end_flags,
    today_taipei,
    total_return_index,
    xirr,
)

Funding = Literal["a", "b"]
Trigger = Literal["never", "now", "ALL", "T10", "T20", "T200", "TVOL"]
SignalName = Literal["ALL", "T10", "T20", "T200", "TVOL"]


@dataclass(frozen=True)
class Spec:
    key: str
    label: str
    funding: Funding
    trigger: Trigger
    baseline: str


SPECS: tuple[Spec, ...] = (
    Spec("A", "純定期定額（預支基準）", "a", "never", "A"),
    Spec("a-ALL", "預支：每個月底（對照組）", "a", "ALL", "A"),
    Spec("a-T10", "預支：回檔 ≥10%", "a", "T10", "A"),
    Spec("a-T20", "預支：回檔 ≥20%", "a", "T20", "A"),
    Spec("a-T200", "預支：跌破 200 日均線", "a", "T200", "A"),
    Spec("a-TVOL", "預支：爆量紅 K", "a", "TVOL", "A"),
    Spec("B0", "年終入帳即買（年終基準）", "b", "now", "B0"),
    Spec("b-T10", "年終：回檔 ≥10%", "b", "T10", "B0"),
    Spec("b-T20", "年終：回檔 ≥20%", "b", "T20", "B0"),
    Spec("b-T200", "年終：跌破 200 日均線", "b", "T200", "B0"),
    Spec("b-TVOL", "年終：爆量紅 K", "b", "TVOL", "B0"),
)
SPEC_BY_KEY: dict[str, Spec] = {s.key: s for s in SPECS}


@dataclass(frozen=True)
class Segment:
    name: str
    start: date
    end: date | None


SEGMENTS: tuple[Segment, ...] = (
    Segment("設計段", date(2003, 6, 30), date(2014, 12, 31)),
    Segment("驗證段", date(2015, 1, 1), None),
)


@dataclass(frozen=True)
class Params:
    monthly_contribution: float
    advance_months: int
    loan_annual_rate: float
    bonus_amount: float
    bonus_month: int
    cash_annual_rate: float
    buy_fee_rate: float
    sma_window: int
    drawdown_small: float
    drawdown_large: float
    vol_window: int
    vol_multiple: float
    vol_min_red_bar: float
    vol_min_close: float
    min_topups: int


DEFAULT_PARAMS = Params(
    monthly_contribution=10_000.0,
    advance_months=3,
    loan_annual_rate=0.015,
    bonus_amount=30_000.0,
    bonus_month=2,
    cash_annual_rate=0.015,
    buy_fee_rate=0.001425 * 0.28,
    sma_window=200,
    drawdown_small=0.10,
    drawdown_large=0.20,
    vol_window=20,
    vol_multiple=2.0,
    vol_min_red_bar=0.015,
    vol_min_close=10.0,
    min_topups=5,
)


@dataclass(frozen=True)
class Result:
    key: str
    contributed: float
    final_value: float
    xirr: float
    max_drawdown: float
    topups: int
    total_costs: float
    loan_interest: float


SegmentResults = dict[str, dict[str, Result]]


# --- segments and signals -----------------------------------------------------


def segment_bounds(bars: Sequence[Bar], segment: Segment) -> tuple[int, int]:
    """Inclusive ``(start, end)`` bar indices of ``segment``; needs >= 2 bars."""
    idx = [
        i
        for i, b in enumerate(bars)
        if b.day >= segment.start and (segment.end is None or b.day <= segment.end)
    ]
    if len(idx) < 2:
        raise ValueError(f"segment {segment.name} has fewer than 2 bars ({len(idx)})")
    return idx[0], idx[-1]


def _split_adjusted_volumes(data: MarketData, volumes: Sequence[float]) -> list[float]:
    adjusted = list(volumes)
    factor = 1.0
    for k in range(len(adjusted) - 1, -1, -1):
        adjusted[k] *= factor
        factor *= data.splits.get(k, 1.0)
    return adjusted


def _volume_surge_red(
    close: float, open_: float, volume: float, window_sum: float, count: int, params: Params
) -> bool:
    """Frozen ``volume_surge_red`` test, exact like its Decimal original.

    Prices go through ``Decimal(str(x))`` (the quoted value), so a bar exactly
    at the 1.5% threshold fires; ``volume >= k × mean`` is checked as
    ``volume × count >= k × sum`` to avoid dividing.
    """
    close_d, open_d = Decimal(str(close)), Decimal(str(open_))
    if close_d < Decimal(str(params.vol_min_close)) or open_d <= 0:
        return False
    if (close_d - open_d) / open_d < Decimal(str(params.vol_min_red_bar)):
        return False
    return window_sum > 0 and volume * count >= params.vol_multiple * window_sum


def compute_signals(
    data: MarketData, opens: Sequence[float], volumes: Sequence[float], params: Params
) -> dict[SignalName, list[bool]]:
    """Per-bar signals over the full history (no look-ahead)."""
    bars = data.bars
    n = len(bars)
    if len(opens) != n or len(volumes) != n:
        raise ValueError(f"open/volume length {len(opens)}/{len(volumes)} != {n} bars")
    month_ends = month_end_flags(bars)
    tr = total_return_index(data)
    vol = _split_adjusted_volumes(data, volumes)

    signals: dict[SignalName, list[bool]] = {
        name: [False] * n for name in ("ALL", "T10", "T20", "T200", "TVOL")
    }
    peak = tr[0]
    vol_sum = 0.0
    for i in range(n):
        peak = max(peak, tr[i])
        vol_sum += vol[i]
        if i >= params.vol_window:
            vol_sum -= vol[i - params.vol_window]
        if month_ends[i]:
            signals["ALL"][i] = True
            signals["T10"][i] = tr[i] <= (1.0 - params.drawdown_small) * peak
            signals["T20"][i] = tr[i] <= (1.0 - params.drawdown_large) * peak
            if i + 1 >= params.sma_window:
                window = tr[i + 1 - params.sma_window : i + 1]
                signals["T200"][i] = tr[i] < sum(window) / len(window)
        signals["TVOL"][i] = _volume_surge_red(
            bars[i].close, opens[i], vol[i], vol_sum, min(i + 1, params.vol_window), params
        )
    return signals


def signal_for(spec: Spec, signals: dict[SignalName, list[bool]], n: int) -> list[bool]:
    if spec.trigger in ("never", "now"):
        return [False] * n
    return signals[spec.trigger]


# --- simulation -----------------------------------------------------------------


def simulate(
    data: MarketData,
    spec: Spec,
    signal: Sequence[bool],
    start: int,
    end: int,
    params: Params,
) -> Result:
    bars = data.bars
    contributes = contribution_flags(bars)
    shares = cash = loan = costs = contributed = borrowed = repaid = 0.0
    repayments_left = 0
    topups = 0
    pending = False
    units = nav_peak = max_dd = 0.0
    wiped = False  # leveraged net value hit <= 0: drawdown is 100% from then on
    cashflows: list[tuple[date, float]] = []

    def buy(amount: float, price: float) -> float:
        nonlocal costs
        bought, cost = buy_shares(amount, price, fee_rate=params.buy_fee_rate)
        costs += cost
        return bought

    for i in range(start, end + 1):
        bar = bars[i]
        price = bar.close
        if i > start:
            years = (bar.day - bars[i - 1].day).days / 365.0
            cash *= (1.0 + params.cash_annual_rate) ** years
            loan *= (1.0 + params.loan_annual_rate) ** years
        if i in data.splits:
            shares *= data.splits[i]
        if i in data.dividends and shares > 0:
            shares += buy(shares * data.dividends[i], price)

        value_before = shares * price + cash - loan
        inflow = 0.0
        if contributes[i]:
            amount = params.monthly_contribution
            if repayments_left > 0:
                pay = loan if repayments_left == 1 else amount
                repaid += pay
                loan = 0.0 if repayments_left == 1 else loan - pay
                repayments_left -= 1
                inflow += pay
            else:
                shares += buy(amount, price)
                inflow += amount
            if spec.funding == "b" and bar.day.month == params.bonus_month:
                inflow += params.bonus_amount
                if spec.trigger == "now":
                    if params.bonus_amount > 0:
                        shares += buy(params.bonus_amount, price)
                        topups += 1
                else:
                    cash += params.bonus_amount
        if inflow > 0:
            if units == 0:
                units = inflow
            elif value_before <= 0:
                wiped = True
            elif not wiped:
                units += inflow / (value_before / units)
            contributed += inflow
            cashflows.append((bar.day, -inflow))

        if pending:
            pending = False
            if spec.funding == "a":
                loan = params.advance_months * params.monthly_contribution
                borrowed += loan
                shares += buy(loan, price)
                repayments_left = params.advance_months
                topups += 1
            elif cash > 0:
                shares += buy(cash, price)
                cash = 0.0
                topups += 1

        if i < end and signal[i] and not (spec.funding == "a" and repayments_left > 0):
            pending = True

        if units > 0 and not wiped:
            nav = (shares * price + cash - loan) / units
            nav_peak = max(nav_peak, nav)
            wiped = nav <= 0
            max_dd = max(max_dd, min(1.0, 1.0 - nav / nav_peak))
        if wiped:
            max_dd = 1.0

    final_value = shares * bars[end].close + cash - loan
    cashflows.append((bars[end].day, final_value))
    return Result(
        key=spec.key,
        contributed=contributed,
        final_value=final_value,
        xirr=xirr(cashflows),
        max_drawdown=max_dd,
        topups=topups,
        total_costs=costs,
        loan_interest=repaid + loan - borrowed,
    )


def run_all(
    data: MarketData,
    opens: Sequence[float],
    volumes: Sequence[float],
    params: Params,
    segments: Sequence[Segment] = SEGMENTS,
) -> SegmentResults:
    signals = compute_signals(data, opens, volumes, params)
    n = len(data.bars)
    results: SegmentResults = {}
    for seg in segments:
        start, end = segment_bounds(data.bars, seg)
        results[seg.name] = {
            s.key: simulate(data, s, signal_for(s, signals, n), start, end, params) for s in SPECS
        }
    return results


# --- verdict and report -------------------------------------------------------------


def verdict(
    strategy: tuple[Result, Result], baseline: tuple[Result, Result], *, min_topups: int
) -> str:
    if any(r.topups < min_topups for r in strategy):
        return "樣本不足"
    rates = [r.xirr for r in (*strategy, *baseline)]
    if any(math.isnan(x) for x in rates):
        return "無法判定"
    wins = [s.xirr > b.xirr for s, b in zip(strategy, baseline, strict=True)]
    return "勝" if all(wins) else "負"


def _per_advance(result: Result, baseline: Result) -> float:
    if result.topups == 0:
        return math.nan
    return (result.final_value - baseline.final_value) / result.topups


def _fmt(x: float, spec: str) -> str:
    return "—" if math.isnan(x) else format(x, spec)


def render_report(
    results: SegmentResults,
    params: Params,
    data: MarketData,
    segments: Sequence[Segment] = SEGMENTS,
) -> str:
    bars = data.bars
    lines = [
        f"# {STOCK_ID} 只買不賣加碼回測（資料 {bars[0].day} ~ {bars[-1].day}）",
        "",
        "Pre-registered 參數："
        f"每月 NT${params.monthly_contribution:,.0f}；預支 {params.advance_months} 個月"
        f"（借款 {params.loan_annual_rate:.1%}）；年終 NT${params.bonus_amount:,.0f}"
        f"（{params.bonus_month} 月入帳，現金 {params.cash_annual_rate:.1%}）；"
        f"回檔 {params.drawdown_small:.0%}／{params.drawdown_large:.0%}；"
        f"均線 {params.sma_window} 日；爆量 {params.vol_multiple:g} 倍 {params.vol_window} 日均量"
        f"、紅 K ≥{params.vol_min_red_bar:.1%}；手續費 {params.buy_fee_rate:.4%}",
        "成交假設：所有觸發一律於訊號隔天收盤成交；訊號使用全歷史資料，資金各段從零開始。",
        f"判定：任一段加碼 < {params.min_topups} 次為「樣本不足」；兩段 ΔXIRR 皆 > 0 才「勝」。"
        "預支（a）提早投入本身有正期望值；「每次預支淨值差」＝(期末淨值 − A) ÷ 預支次數，"
        "含利息與持有期間差異，與 a-ALL 比較只是時點效果的參考，不是純時點歸因。",
        "提醒：TVOL 只測 0050 本身的爆量紅 K，不能證明或否定個股層面的「量先價行」。",
    ]
    for seg in segments:
        seg_results = results[seg.name]
        lines += [
            "",
            f"## {seg.name}（{seg.start} ~ {seg.end or bars[-1].day}）",
            "",
            "| 策略 | 說明 | XIRR | ΔXIRR (bp) | Δ期末淨值 | 最大回檔 | 加碼次數 "
            "| 每次預支淨值差 | 借款利息（含應計） | 總投入 | 期末淨值 |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for spec in SPECS:
            r = seg_results[spec.key]
            base = seg_results[spec.baseline]
            delta_bp = (r.xirr - base.xirr) * 10_000
            per_adv = _per_advance(r, base) if spec.funding == "a" and spec.key != "A" else math.nan
            lines.append(
                f"| {spec.key} | {spec.label} | {_fmt(r.xirr, '.2%')} | {_fmt(delta_bp, '+.1f')} "
                f"| {r.final_value - base.final_value:+,.0f} | {r.max_drawdown:.2%} | {r.topups} "
                f"| {_fmt(per_adv, '+,.0f')} | {r.loan_interest:,.0f} | {r.contributed:,.0f} "
                f"| {r.final_value:,.0f} |"
            )
    lines += [
        "",
        "## 判定",
        "",
        "| 策略 | 基準 | " + " | ".join(f"{s.name} ΔXIRR (bp)" for s in segments) + " | 判定 |",
        "|---|---|" + "---:|" * len(segments) + "---|",
    ]
    for spec in SPECS:
        if spec.key in ("A", "B0"):
            continue
        pair = tuple(results[s.name][spec.key] for s in segments)
        base = tuple(results[s.name][spec.baseline] for s in segments)
        deltas = " | ".join(
            _fmt((r.xirr - b.xirr) * 10_000, "+.1f") for r, b in zip(pair, base, strict=True)
        )
        outcome = (
            verdict((pair[0], pair[1]), (base[0], base[1]), min_topups=params.min_topups)
            if len(segments) == 2
            else "—"
        )
        lines.append(f"| {spec.key} | {spec.baseline} | {deltas} | {outcome} |")
    return "\n".join(lines)


# --- CLI ------------------------------------------------------------------------------


async def load_inputs(
    end: date, cache_dir: Path, refresh: bool
) -> tuple[MarketData, tuple[float, ...], tuple[float, ...]]:
    """Load 0050 rows; refetch once only if the closes parse but open/volume do not.

    The close-only cache trust rule cannot see open/volume, so a cached file
    may lack them. Any other data error (e.g. too few bars) is not retried.
    """
    raw = await load_raw_rows(end, cache_dir, refresh)
    data = parse_market_data(raw)
    try:
        return data, *parse_open_volume(raw)
    except ValueError:
        if refresh:
            raise
    raw = await load_raw_rows(end, cache_dir, True)
    return parse_market_data(raw), *parse_open_volume(raw)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--end-date", type=date.fromisoformat, default=today_taipei())
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--refresh", action="store_true", help="ignore cached data")
    args = parser.parse_args(argv)
    try:
        data, opens, volumes = asyncio.run(load_inputs(args.end_date, args.cache_dir, args.refresh))
        results = run_all(data, opens, volumes, DEFAULT_PARAMS)
    except ValueError as exc:
        raise SystemExit(f"cannot backtest {STOCK_ID} up to {args.end_date}: {exc}") from exc
    print(render_report(results, DEFAULT_PARAMS, data))


if __name__ == "__main__":
    main()
