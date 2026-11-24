"""Unit tests for the DCA + satellite backtest engine (synthetic data only)."""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path

import pytest

from literati_stock.backtest.data import Bar, MarketData
from literati_stock.backtest.dca_satellite import (
    DEFAULT_PARAMS,
    Params,
    buy_shares,
    contribution_flags,
    month_end_flags,
    render_report,
    run_backtest,
    sell_proceeds,
    simulate,
    total_return_index,
    xirr,
)

FREE = Params(
    monthly_contribution=1000.0,
    satellite_weight=0.2,
    sma_window=3,
    drawdown_trigger=0.2,
    buy_fee_rate=0.0,
    sell_fee_rate=0.0,
    sell_tax_rate=0.0,
    cash_annual_rate=0.0,
)


def _data(
    bars: list[tuple[str, float]],
    dividends: dict[int, float] | None = None,
    splits: dict[int, float] | None = None,
) -> MarketData:
    return MarketData(
        bars=tuple(Bar(day=date.fromisoformat(d), close=c) for d, c in bars),
        dividends=dividends or {},
        splits=splits or {},
    )


# --- calendar flags ---------------------------------------------------------


def test_contribution_and_month_end_flags_skip_first_month_and_open_last_month() -> None:
    data = _data(
        [
            ("2003-06-30", 37.0),  # first bar: neither contribution nor month-end
            ("2003-07-01", 38.0),  # first bar of July: contribution
            ("2003-07-31", 39.0),  # last bar of July: month-end
            ("2003-08-01", 40.0),  # contribution
            ("2003-08-15", 41.0),  # last bar but mid-month: NOT month-end
        ]
    )
    assert contribution_flags(data.bars) == [False, True, False, True, False]
    assert month_end_flags(data.bars) == [False, False, True, False, False]


# --- trade primitives -------------------------------------------------------


def test_buy_shares_charges_fee_on_top_of_price() -> None:
    shares, cost = buy_shares(1001.0, 100.0, fee_rate=0.001)
    assert shares == pytest.approx(10.0)
    assert cost == pytest.approx(1.0)


def test_sell_proceeds_deduct_fee_and_tax() -> None:
    proceeds, cost = sell_proceeds(2.0, 90.0, fee_rate=0.001, tax_rate=0.001)
    assert proceeds == pytest.approx(180.0 * 0.998)
    assert cost == pytest.approx(0.36)


# --- total return index -----------------------------------------------------


def test_total_return_index_is_multiplicative_over_dividends_and_splits() -> None:
    data = _data(
        [("2024-01-02", 100.0), ("2024-01-03", 100.0), ("2024-01-04", 50.0), ("2024-01-05", 25.0)],
        dividends={2: 5.0},
        splits={3: 2.0},
    )
    assert total_return_index(data) == pytest.approx([100.0, 100.0, 55.0, 55.0])


# --- strategy A (pure DCA) --------------------------------------------------


def test_pure_dca_flat_price_without_costs_returns_contributions() -> None:
    data = _data(
        [("2024-01-31", 100.0), ("2024-02-01", 100.0), ("2024-03-01", 100.0), ("2024-03-15", 100.0)]
    )
    result = simulate(data, "A", FREE)
    assert result.contributed == pytest.approx(2000.0)
    assert result.final_value == pytest.approx(2000.0)
    assert result.max_drawdown == pytest.approx(0.0)
    assert result.signal_trades == 0
    assert result.xirr == pytest.approx(0.0, abs=1e-6)


def test_dividend_is_reinvested_on_ex_date_close() -> None:
    data = _data(
        [("2024-01-31", 100.0), ("2024-02-01", 100.0), ("2024-02-05", 50.0)], dividends={2: 5.0}
    )
    result = simulate(data, "A", FREE)
    assert result.core_shares == pytest.approx(11.0)
    assert result.final_value == pytest.approx(550.0)


def test_split_multiplies_shares_and_keeps_value_continuous() -> None:
    data = _data(
        [("2024-01-31", 100.0), ("2024-02-01", 100.0), ("2024-02-05", 25.0)], splits={2: 4.0}
    )
    result = simulate(data, "A", FREE)
    assert result.core_shares == pytest.approx(40.0)
    assert result.final_value == pytest.approx(1000.0)


def test_same_day_split_is_applied_before_dividend() -> None:
    data = _data(
        [("2024-01-31", 100.0), ("2024-02-01", 100.0), ("2024-02-05", 25.0)],
        dividends={2: 1.0},
        splits={2: 4.0},
    )
    result = simulate(data, "A", FREE)
    assert result.core_shares == pytest.approx(40.0 + 40.0 * 1.0 / 25.0)


def test_max_drawdown_uses_unit_nav_so_contributions_do_not_mask_losses() -> None:
    data = _data(
        [
            ("2024-01-31", 100.0),
            ("2024-02-01", 100.0),
            ("2024-02-15", 50.0),
            ("2024-03-01", 50.0),
            ("2024-03-15", 100.0),
        ]
    )
    result = simulate(data, "A", FREE)
    assert result.max_drawdown == pytest.approx(0.5)
    assert result.final_value == pytest.approx(3000.0)


def test_buy_costs_accumulate_in_total_costs() -> None:
    data = _data([("2024-01-31", 100.0), ("2024-02-01", 100.0)])
    params = replace(FREE, monthly_contribution=1001.0, buy_fee_rate=0.001)
    result = simulate(data, "A", params)
    assert result.core_shares == pytest.approx(10.0)
    assert result.total_costs == pytest.approx(1.0)


# --- strategy B (200MA satellite) -------------------------------------------


def _b_path() -> MarketData:
    return _data(
        [
            ("2024-01-31", 100.0),  # first bar
            ("2024-02-01", 100.0),  # contribution; SMA unavailable -> satellite buys
            ("2024-02-29", 90.0),  # month-end: 90 < SMA(100,100,90) -> sell satellite
            ("2024-03-01", 90.0),  # contribution; satellite in cash -> cash
            ("2024-03-29", 120.0),  # month-end: 120 > SMA(90,90,120) -> buy back
            ("2024-04-15", 60.0),  # contribution; last bar mid-month -> no signal
        ]
    )


def test_strategy_b_switches_satellite_only_at_month_end() -> None:
    result = simulate(_b_path(), "B", FREE)
    assert result.signal_trades == 2
    assert result.cash == pytest.approx(0.0)
    # 200/100 sold at 90 -> 180, + 200 cash -> 380 bought at 120, + 200 bought at 60.
    assert result.satellite_shares == pytest.approx(380.0 / 120.0 + 200.0 / 60.0)
    assert result.core_shares == pytest.approx(8.0 + 800.0 / 90.0 + 800.0 / 60.0)
    assert result.contributed == pytest.approx(3000.0)


def test_strategy_b_sell_pays_fee_and_tax() -> None:
    params = replace(FREE, sell_fee_rate=0.001, sell_tax_rate=0.001)
    result = simulate(_b_path(), "B", params)
    assert result.total_costs == pytest.approx(180.0 * 0.002)


# --- strategy C (dip-buy satellite) -----------------------------------------


def _c_path(last_close: float = 100.0) -> MarketData:
    return _data(
        [
            ("2024-01-31", 100.0),
            ("2024-02-01", 100.0),  # contribution: satellite cash 200
            ("2024-02-29", 81.0),  # month-end: 19% drawdown -> hold cash
            ("2024-03-01", 81.0),  # contribution: cash 400
            ("2024-03-29", 80.0),  # month-end: 20% drawdown -> deploy 400 @ 80
            ("2024-04-30", last_close),  # contribution: cash 200; last bar -> no signal
        ]
    )


def test_strategy_c_deploys_only_at_twenty_percent_drawdown() -> None:
    result = simulate(_c_path(), "C", FREE)
    assert result.signal_trades == 1
    assert result.satellite_shares == pytest.approx(5.0)
    assert result.cash == pytest.approx(200.0)


def test_strategy_c_cash_accrues_interest_by_calendar_day() -> None:
    data = _data([("2024-01-31", 100.0), ("2024-02-01", 100.0), ("2024-03-01", 100.0)])
    params = replace(FREE, cash_annual_rate=0.10)
    result = simulate(data, "C", params)
    days = (date(2024, 3, 1) - date(2024, 2, 1)).days
    assert result.cash == pytest.approx(200.0 * 1.10 ** (days / 365) + 200.0)


# --- metrics & report -------------------------------------------------------


def test_xirr_matches_simple_annual_return() -> None:
    start = date(2024, 1, 1)
    assert xirr([(start, -100.0), (start + timedelta(days=365), 110.0)]) == pytest.approx(
        0.10, abs=1e-6
    )


def test_run_backtest_and_report_cover_all_strategies_and_params() -> None:
    results = run_backtest(_c_path(), FREE)
    assert set(results) == {"A", "B", "C"}
    report = render_report(results, FREE, _c_path())
    for token in ("A", "B", "C", "XIRR", "200" if FREE.sma_window == 200 else "3"):
        assert token in report


def test_default_params_are_the_pre_registered_values() -> None:
    assert DEFAULT_PARAMS.monthly_contribution == 10_000.0
    assert DEFAULT_PARAMS.satellite_weight == 0.20
    assert DEFAULT_PARAMS.sma_window == 200
    assert DEFAULT_PARAMS.drawdown_trigger == 0.20
    assert DEFAULT_PARAMS.buy_fee_rate == pytest.approx(0.001425 * 0.28)
    assert DEFAULT_PARAMS.sell_fee_rate == pytest.approx(0.001425 * 0.28)
    assert DEFAULT_PARAMS.sell_tax_rate == 0.001
    assert DEFAULT_PARAMS.cash_annual_rate == 0.015


def test_xirr_returns_nan_when_no_root_is_bracketed() -> None:
    day = date(2024, 1, 1)
    assert math.isnan(xirr([(day, -100.0), (day, 50.0)]))


# --- review round 1 (F1/F3) ---------------------------------------------------


@pytest.mark.parametrize(
    "flows",
    [
        [(date(2024, 1, 1), -100.0), (date(2024, 1, 1), 100.0)],
        [(date(2024, 1, 1), 0.0)],
        [(date(2024, 1, 1), -100.0), (date(2025, 1, 1), 0.0)],
        [],
    ],
)
def test_xirr_is_undefined_for_degenerate_cashflows(flows: list[tuple[date, float]]) -> None:
    assert math.isnan(xirr(flows))


def test_report_discloses_same_close_execution_assumption() -> None:
    report = render_report(run_backtest(_c_path(), FREE), FREE, _c_path())
    assert "同日收盤成交" in report


@pytest.mark.parametrize("closes", [[], [100.0]])
async def test_loader_rejects_insufficient_data_with_clear_message(
    closes: list[float], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import literati_stock.backtest.dca_satellite as module
    from literati_stock.backtest.data import RawMarketRows

    async def fake_fetch(*_args: object, **_kwargs: object) -> RawMarketRows:
        prices = [{"date": "2003-06-30", "close": c} for c in closes]
        return RawMarketRows(prices=prices, dividends=[], splits=[])

    monkeypatch.setattr(module, "fetch_raw_rows", fake_fetch)
    with pytest.raises(ValueError, match="at least 2 price bars"):
        await module.load_market_data(date(2003, 6, 30), tmp_path, refresh=False)


def test_cli_turns_data_errors_into_clean_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    import literati_stock.backtest.dca_satellite as module

    def fake_run(coro: object) -> None:
        coro.close()  # type: ignore[attr-defined]
        raise ValueError("need at least 2 price bars to backtest, got 0")

    monkeypatch.setattr(module.asyncio, "run", fake_run)
    with pytest.raises(SystemExit, match="cannot backtest 0050 up to 2003-06-30"):
        module.main(["--end-date", "2003-06-30"])
