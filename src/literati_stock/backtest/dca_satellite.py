"""0050 DCA vs DCA + 20% satellite backtest (pre-registered rules).

Run: ``uv run python -m literati_stock.backtest.dca_satellite``

PRE-REGISTRATION — every rule and parameter below was fixed and committed
*before* the first run on real data. Do not tune them after seeing results
(see INVESTMENT_DECISION.md "backtest pact").

Strategies
    A  100% pure DCA into 0050.
    B  Each contribution split 80% core / 20% satellite. On the last trading
       day of each month the satellite holds 0050 iff the total-return close
       is strictly above its 200-day SMA, otherwise it sells everything into
       cash. Until 200 bars exist the satellite stays invested. Monthly
       satellite contributions buy shares or accrue as cash per the current
       state.
    C  Each contribution split 80% core / 20% satellite. Satellite money accrues
       as cash; on the last trading day of each month, if the total-return
       close is <= 80% of its running all-time high, all satellite cash is
       invested and held forever. Later contributions accrue as cash again and
       redeploy at any later qualifying month-end.

Mechanics (shared)
    - Contribution: NT$10,000 at the close of the first bar of every calendar
      month after the first bar's month.
    - Month-end: a bar whose *next* bar is in a different month. The very
      first bar and a final bar without a successor are never month-ends.
    - Same-day order: cash interest → split → dividend → contribution →
      month-end signal → record NAV.
    - Fractional shares. Buy: shares = X / (P × (1 + fee)). Sell: proceeds =
      shares × P × (1 − fee − tax). Fee = 0.1425% × 0.28 (online discount)
      both sides; ETF transaction tax 0.1% on sells. Minimum fees and
      dividend health-insurance surcharge are ignored.
    - Dividends are reinvested at the ex-date close into the sleeve that
      holds the shares (buy fee applies). Splits multiply share counts.
    - Satellite cash earns 1.5% p.a., compounded per calendar day.
    - Signals use a total-return index (split- and dividend-adjusted,
      multiplicative only); trades execute at the raw same-day close. This
      is an idealisation (the close is not known when the order is placed);
      the report states it, and results must be read with it in mind.

Metrics
    XIRR on contributions (negative) and final value (positive); max drawdown
    of a time-weighted unit NAV (contributions buy units, so they cannot mask
    losses); signal-driven trade count; total fees + tax; final value.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from aiolimiter import AsyncLimiter

from literati_stock.backtest.data import (
    Bar,
    MarketData,
    RawMarketRows,
    fetch_raw_rows,
    load_or_fetch,
    parse_market_data,
)
from literati_stock.ingest.clients.finmind import FinMindClient

Strategy = Literal["A", "B", "C"]
STRATEGIES: tuple[Strategy, ...] = ("A", "B", "C")
STRATEGY_LABELS: dict[Strategy, str] = {
    "A": "純定期定額",
    "B": "DCA + 20% 衛星（200 日均線進出）",
    "C": "DCA + 20% 衛星（跌深 20% 加碼）",
}

STOCK_ID = "0050"
DATA_START = date(2003, 6, 30)
DEFAULT_CACHE_DIR = Path(".cache/backtest")


@dataclass(frozen=True)
class Params:
    monthly_contribution: float
    satellite_weight: float
    sma_window: int
    drawdown_trigger: float
    buy_fee_rate: float
    sell_fee_rate: float
    sell_tax_rate: float
    cash_annual_rate: float


_ONLINE_FEE_RATE = 0.001425 * 0.28

DEFAULT_PARAMS = Params(
    monthly_contribution=10_000.0,
    satellite_weight=0.20,
    sma_window=200,
    drawdown_trigger=0.20,
    buy_fee_rate=_ONLINE_FEE_RATE,
    sell_fee_rate=_ONLINE_FEE_RATE,
    sell_tax_rate=0.001,
    cash_annual_rate=0.015,
)


@dataclass(frozen=True)
class Result:
    strategy: Strategy
    contributed: float
    final_value: float
    xirr: float
    max_drawdown: float
    signal_trades: int
    total_costs: float
    core_shares: float
    satellite_shares: float
    cash: float


# --- primitives -------------------------------------------------------------


def buy_shares(amount: float, price: float, *, fee_rate: float) -> tuple[float, float]:
    """Return ``(shares, cost)`` for spending ``amount`` including the fee."""
    shares = amount / (price * (1.0 + fee_rate))
    return shares, amount - shares * price


def sell_proceeds(
    shares: float, price: float, *, fee_rate: float, tax_rate: float
) -> tuple[float, float]:
    """Return ``(proceeds, cost)`` for selling ``shares`` at ``price``."""
    gross = shares * price
    proceeds = gross * (1.0 - fee_rate - tax_rate)
    return proceeds, gross - proceeds


def contribution_flags(bars: Sequence[Bar]) -> list[bool]:
    flags = [False] * len(bars)
    for i in range(1, len(bars)):
        prev, cur = bars[i - 1].day, bars[i].day
        flags[i] = (cur.year, cur.month) != (prev.year, prev.month)
    return flags


def month_end_flags(bars: Sequence[Bar]) -> list[bool]:
    flags = [False] * len(bars)
    for i in range(1, len(bars) - 1):
        cur, nxt = bars[i].day, bars[i + 1].day
        flags[i] = (cur.year, cur.month) != (nxt.year, nxt.month)
    return flags


def total_return_index(data: MarketData) -> list[float]:
    """Forward total-return index: ``tr[k] = tr[k-1] * r_k * (P_k + D_k) / P_{k-1}``."""
    bars = data.bars
    index = [bars[0].close]
    for k in range(1, len(bars)):
        ratio = data.splits.get(k, 1.0)
        growth = ratio * (bars[k].close + data.dividends.get(k, 0.0)) / bars[k - 1].close
        index.append(index[-1] * growth)
    return index


def xirr(cashflows: Sequence[tuple[date, float]]) -> float:
    """Annualised internal rate of return via bisection on (-99%, 1000%).

    Returns ``nan`` when the rate is undefined: no flows, all flows on one day, no
    flow of each sign, or no root bracketed (e.g. horizons of a few days,
    where annualisation explodes). The report shows it as-is.
    """
    if not cashflows:
        return math.nan
    t0 = cashflows[0][0]
    if all(d == t0 for d, _ in cashflows):
        return math.nan
    if not any(cf < 0 for _, cf in cashflows) or not any(cf > 0 for _, cf in cashflows):
        return math.nan

    def npv(rate: float) -> float:
        return sum(cf / (1.0 + rate) ** ((d - t0).days / 365.0) for d, cf in cashflows)

    lo, hi = -0.99, 10.0
    if npv(lo) * npv(hi) > 0:
        return math.nan
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if npv(lo) * npv(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2.0


# --- simulation -------------------------------------------------------------


def simulate(data: MarketData, strategy: Strategy, params: Params) -> Result:
    bars = data.bars
    contributes = contribution_flags(bars)
    month_ends = month_end_flags(bars)
    tr = total_return_index(data)
    sat_weight = 0.0 if strategy == "A" else params.satellite_weight

    core = sat = cash = costs = 0.0
    contributed = 0.0
    trades = 0
    sat_invested = strategy == "B"
    peak = tr[0]
    units = 0.0
    nav_peak = 0.0
    max_dd = 0.0
    cashflows: list[tuple[date, float]] = []

    def buy(amount: float, price: float) -> float:
        nonlocal costs
        shares, cost = buy_shares(amount, price, fee_rate=params.buy_fee_rate)
        costs += cost
        return shares

    for i, bar in enumerate(bars):
        price = bar.close
        if i > 0 and cash > 0:
            days = (bar.day - bars[i - 1].day).days
            cash *= (1.0 + params.cash_annual_rate) ** (days / 365.0)
        if i in data.splits:
            core *= data.splits[i]
            sat *= data.splits[i]
        if i in data.dividends:
            per_share = data.dividends[i]
            if core > 0:
                core += buy(core * per_share, price)
            if sat > 0:
                sat += buy(sat * per_share, price)
        if contributes[i]:
            amount = params.monthly_contribution
            value_before = (core + sat) * price + cash
            units += amount if units == 0 else amount / (value_before / units)
            contributed += amount
            cashflows.append((bar.day, -amount))
            sat_amount = amount * sat_weight
            core += buy(amount - sat_amount, price)
            if sat_amount > 0:
                if strategy == "B" and sat_invested:
                    sat += buy(sat_amount, price)
                else:
                    cash += sat_amount
        peak = max(peak, tr[i])
        if month_ends[i] and strategy == "B":
            want = True
            if i + 1 >= params.sma_window:
                window = tr[i + 1 - params.sma_window : i + 1]
                want = tr[i] > sum(window) / len(window)
            if want and not sat_invested:
                sat_invested = True
                if cash > 0:
                    sat += buy(cash, price)
                    cash = 0.0
                    trades += 1
            elif not want and sat_invested:
                sat_invested = False
                if sat > 0:
                    proceeds, cost = sell_proceeds(
                        sat,
                        price,
                        fee_rate=params.sell_fee_rate,
                        tax_rate=params.sell_tax_rate,
                    )
                    costs += cost
                    cash += proceeds
                    sat = 0.0
                    trades += 1
        elif month_ends[i] and strategy == "C":
            if tr[i] <= (1.0 - params.drawdown_trigger) * peak and cash > 0:
                sat += buy(cash, price)
                cash = 0.0
                trades += 1
        if units > 0:
            nav = ((core + sat) * price + cash) / units
            nav_peak = max(nav_peak, nav)
            max_dd = max(max_dd, 1.0 - nav / nav_peak)

    final_value = (core + sat) * bars[-1].close + cash
    cashflows.append((bars[-1].day, final_value))
    return Result(
        strategy=strategy,
        contributed=contributed,
        final_value=final_value,
        xirr=xirr(cashflows),
        max_drawdown=max_dd,
        signal_trades=trades,
        total_costs=costs,
        core_shares=core,
        satellite_shares=sat,
        cash=cash,
    )


def run_backtest(data: MarketData, params: Params) -> dict[Strategy, Result]:
    return {s: simulate(data, s, params) for s in STRATEGIES}


# --- report -----------------------------------------------------------------


def render_report(results: dict[Strategy, Result], params: Params, data: MarketData) -> str:
    bars = data.bars
    tr = total_return_index(data)
    years = (bars[-1].day - bars[0].day).days / 365.0
    lump_cagr = (tr[-1] / tr[0]) ** (1.0 / years) - 1.0
    lines = [
        f"# {STOCK_ID} DCA 衛星回測（{bars[0].day} ~ {bars[-1].day}，{len(bars)} 個交易日）",
        "",
        "Pre-registered 參數："
        f"每月 NT${params.monthly_contribution:,.0f}；衛星 {params.satellite_weight:.0%}；"
        f"均線 {params.sma_window} 日；跌深門檻 {params.drawdown_trigger:.0%}；"
        f"手續費 {params.buy_fee_rate:.4%}／證交稅 {params.sell_tax_rate:.1%}；"
        f"現金利率 {params.cash_annual_rate:.1%}",
        f"對照：0050 單筆含息持有 {tr[-1] / tr[0]:.2f} 倍，年化 {lump_cagr:.2%}",
        "成交假設：B／C 以訊號當日同日收盤成交（理想化；實際下單時尚不知收盤價）",
        "",
        "| 策略 | 說明 | XIRR 年化 | 最大回檔 | 訊號交易 | 總交易成本 | 總投入 | 期末市值 |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for s in STRATEGIES:
        r = results[s]
        lines.append(
            f"| {s} | {STRATEGY_LABELS[s]} | {r.xirr:.2%} | {r.max_drawdown:.2%} | "
            f"{r.signal_trades} | {r.total_costs:,.0f} | {r.contributed:,.0f} | "
            f"{r.final_value:,.0f} |"
        )
    return "\n".join(lines)


# --- CLI --------------------------------------------------------------------


def today_taipei() -> date:
    return datetime.now(ZoneInfo("Asia/Taipei")).date()


async def load_raw_rows(end: date, cache_dir: Path, refresh: bool) -> RawMarketRows:
    """Cached 0050 raw rows from ``DATA_START`` to ``end`` (shared by all backtests)."""
    # Anonymous FinMind quota suffices (3 requests); no DB settings required.
    token = os.environ.get("FINMIND_TOKEN", "")

    async def fetcher() -> RawMarketRows:
        async with FinMindClient(token, AsyncLimiter(8, 60)) as client:
            return await fetch_raw_rows(client, STOCK_ID, DATA_START, end)

    return await load_or_fetch(
        cache_dir, STOCK_ID, end, fetcher, refresh=refresh, today=today_taipei()
    )


async def load_market_data(end: date, cache_dir: Path, refresh: bool) -> MarketData:
    return parse_market_data(await load_raw_rows(end, cache_dir, refresh))


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--end-date", type=date.fromisoformat, default=today_taipei())
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--refresh", action="store_true", help="ignore cached data")
    args = parser.parse_args(argv)
    try:
        data = asyncio.run(load_market_data(args.end_date, args.cache_dir, args.refresh))
    except ValueError as exc:
        raise SystemExit(f"cannot backtest {STOCK_ID} up to {args.end_date}: {exc}") from exc
    print(render_report(run_backtest(data, DEFAULT_PARAMS), DEFAULT_PARAMS, data))


if __name__ == "__main__":
    main()
