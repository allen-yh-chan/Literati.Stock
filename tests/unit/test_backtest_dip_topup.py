"""Unit tests for the dip top-up backtest (synthetic data only)."""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from literati_stock.backtest import dca_satellite
from literati_stock.backtest.data import Bar, MarketData, RawMarketRows
from literati_stock.backtest.dip_topup import (
    DEFAULT_PARAMS,
    SEGMENTS,
    SPEC_BY_KEY,
    SPECS,
    Params,
    Result,
    Segment,
    compute_signals,
    render_report,
    run_all,
    segment_bounds,
    simulate,
    verdict,
)

FREE = Params(
    monthly_contribution=1000.0,
    advance_months=3,
    loan_annual_rate=0.0,
    bonus_amount=3000.0,
    bonus_month=2,
    cash_annual_rate=0.0,
    buy_fee_rate=0.0,
    sma_window=3,
    drawdown_small=0.10,
    drawdown_large=0.20,
    vol_window=3,
    vol_multiple=2.0,
    vol_min_red_bar=0.015,
    vol_min_close=10.0,
    min_topups=1,
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


def _months(prices: list[float], year: int = 2024) -> list[tuple[str, float]]:
    """Two bars per month starting January: day 2 (index 2m) and day 28 (2m+1)."""
    bars: list[tuple[str, float]] = []
    for m, price in enumerate(prices):
        bars.append((f"{year}-{m + 1:02d}-02", price))
        bars.append((f"{year}-{m + 1:02d}-28", price))
    return bars


def _flat(n_months: int = 6, price: float = 100.0) -> MarketData:
    return _data(_months([price] * n_months))


def _signal(n: int, *on: int) -> list[bool]:
    return [i in on for i in range(n)]


def _run(
    data: MarketData,
    key: str,
    signal: list[bool],
    params: Params = FREE,
    start: int = 0,
    end: int | None = None,
) -> Result:
    last = len(data.bars) - 1 if end is None else end
    return simulate(data, SPEC_BY_KEY[key], signal, start, last, params)


# --- anchors to the reviewed engine and invariants ----------------------------


def test_baseline_a_matches_reviewed_dca_engine() -> None:
    data = _data(
        _months([100.0, 90.0, 110.0, 25.0, 30.0, 28.0]), dividends={4: 2.0}, splits={6: 4.0}
    )
    params = replace(FREE, buy_fee_rate=0.001)
    mine = _run(data, "A", _signal(len(data.bars)), params)
    reviewed = dca_satellite.simulate(
        data,
        "A",
        replace(dca_satellite.DEFAULT_PARAMS, monthly_contribution=1000.0, buy_fee_rate=0.001),
    )
    assert mine.final_value == pytest.approx(reviewed.final_value, rel=1e-12)
    assert mine.contributed == pytest.approx(reviewed.contributed)
    assert mine.xirr == pytest.approx(reviewed.xirr, abs=1e-9)
    assert mine.max_drawdown == pytest.approx(reviewed.max_drawdown, abs=1e-12)
    assert mine.total_costs == pytest.approx(reviewed.total_costs)


@pytest.mark.parametrize("key", ["a-ALL", "a-T10", "a-T20", "a-T200", "a-TVOL"])
def test_advance_without_any_signal_equals_pure_dca(key: str) -> None:
    data = _data(_months([100.0, 90.0, 110.0, 95.0, 120.0, 130.0]))
    none = _signal(len(data.bars))
    assert _run(data, key, none) == replace(_run(data, "A", none), key=key)


def test_bonus_strategies_with_zero_bonus_equal_pure_dca() -> None:
    data = _data(_months([100.0, 90.0, 110.0, 95.0, 120.0, 130.0]))
    params = replace(FREE, bonus_amount=0.0)
    signal = _signal(len(data.bars), 1, 3, 5)
    result = _run(data, "b-T10", signal, params)
    pure = _run(data, "A", _signal(len(data.bars)), params)
    assert result.final_value == pytest.approx(pure.final_value)
    assert result.contributed == pytest.approx(pure.contributed)
    assert result.topups == 0


def test_advance_on_flat_price_with_free_loan_matches_pure_dca() -> None:
    data = _flat()
    result = _run(data, "a-T10", _signal(len(data.bars), 1))
    pure = _run(data, "A", _signal(len(data.bars)))
    assert result.final_value == pytest.approx(pure.final_value)
    assert result.contributed == pytest.approx(pure.contributed)


# --- funding a: advance and repay ---------------------------------------------


def test_advance_executes_next_bar_and_repays_over_three_contributions() -> None:
    data = _flat()
    # Signals at Jan/Feb/Mar month-ends; only the first is free of an open loan.
    result = _run(data, "a-T10", _signal(len(data.bars), 1, 3, 5))
    # Feb: 10 sh contribution + 30 sh advance; Mar/Apr/May repay; Jun: 10 sh.
    assert result.topups == 1
    assert result.final_value == pytest.approx(5000.0)
    assert result.contributed == pytest.approx(5000.0)
    assert result.loan_interest == pytest.approx(0.0)


def test_new_advance_allowed_after_repayment_and_open_loan_is_netted() -> None:
    data = _flat()
    # Jan month-end advance (repaid Mar/Apr/May firsts); May month-end advance
    # executes at Jun first and is still fully outstanding at the end.
    result = _run(data, "a-T10", _signal(len(data.bars), 1, 9))
    assert result.topups == 2
    # shares: 10 + 30 (Feb) + 10 + 30 (Jun) = 80 -> 8000 - 3000 loan.
    assert result.final_value == pytest.approx(5000.0)


def test_loan_interest_is_paid_with_the_third_repayment() -> None:
    data = _flat()
    params = replace(FREE, loan_annual_rate=0.10)
    result = _run(data, "a-T10", _signal(len(data.bars), 1), params)

    def grow(amount: float, start: str, end: str) -> float:
        days = (date.fromisoformat(end) - date.fromisoformat(start)).days
        return amount * 1.10 ** (days / 365)

    balance = grow(3000.0, "2024-02-02", "2024-03-02") - 1000.0
    balance = grow(balance, "2024-03-02", "2024-04-02") - 1000.0
    third = grow(balance, "2024-04-02", "2024-05-02")
    assert result.loan_interest == pytest.approx(third - 1000.0)
    assert result.contributed == pytest.approx(4000.0 + third)
    assert result.final_value == pytest.approx(5000.0)


# --- funding b: annual bonus ----------------------------------------------------


def test_bonus_waits_in_cash_with_interest_until_next_bar_after_signal() -> None:
    data = _flat()
    params = replace(FREE, cash_annual_rate=0.10)
    result = _run(data, "b-T10", _signal(len(data.bars), 5), params)
    days = (date(2024, 4, 2) - date(2024, 2, 2)).days
    bonus_at_buy = 3000.0 * 1.10 ** (days / 365)
    assert result.topups == 1
    assert result.contributed == pytest.approx(5000.0 + 3000.0)
    assert result.final_value == pytest.approx(5000.0 + bonus_at_buy)


def test_baseline_b0_buys_bonus_on_receipt() -> None:
    data = _data(_months([100.0, 50.0, 100.0, 100.0, 100.0, 100.0]))
    result = _run(data, "B0", _signal(len(data.bars)))
    # 3000 bonus bought at the Feb-first close of 50 -> 60 sh worth 6000.
    assert result.topups == 1
    assert result.final_value == pytest.approx(_run(data, "A", _signal(12)).final_value + 6000.0)


def test_signal_with_no_cash_is_not_a_topup() -> None:
    data = _flat()
    # Jan month-end signal executes on Feb first after the bonus arrives;
    # the Feb month-end signal finds no cash.
    result = _run(data, "b-T10", _signal(len(data.bars), 1, 3))
    assert result.topups == 1


def test_bonus_cash_left_at_segment_end_counts_in_value() -> None:
    data = _flat()
    params = replace(FREE, cash_annual_rate=0.0)
    result = _run(data, "b-T10", _signal(len(data.bars)), params)
    assert result.topups == 0
    assert result.final_value == pytest.approx(5000.0 + 3000.0)


# --- segment edges ----------------------------------------------------------------


def test_signal_before_segment_start_does_not_carry_in() -> None:
    data = _flat()
    result = _run(data, "a-T10", _signal(len(data.bars), 1), start=2)
    assert result.topups == 0


def test_signal_on_segment_last_bar_is_ignored() -> None:
    data = _flat()
    # Bar 7 (Apr 28) is a month-end in the full series but the segment's last bar.
    result = _run(data, "a-T10", _signal(len(data.bars), 7), end=7)
    assert result.topups == 0
    assert result.final_value == pytest.approx(3000.0)


def test_segment_bounds_select_bars_by_date() -> None:
    data = _flat()
    seg = Segment("x", date(2024, 2, 1), date(2024, 4, 30))
    assert segment_bounds(data.bars, seg) == (2, 7)
    assert segment_bounds(data.bars, Segment("y", date(2024, 5, 1), None)) == (8, 11)


@pytest.mark.parametrize(
    "seg",
    [Segment("short", date(2024, 6, 28), None), Segment("empty", date(2025, 1, 1), None)],
)
def test_segment_with_fewer_than_two_bars_fails_loudly(seg: Segment) -> None:
    with pytest.raises(ValueError, match="fewer than 2 bars"):
        segment_bounds(_flat().bars, seg)


# --- signals ------------------------------------------------------------------------


def _volume_inputs(n: int) -> tuple[list[float], list[float]]:
    return [100.0] * n, [10.0] * n


def test_drawdown_triggers_fire_only_at_month_end_and_are_inclusive() -> None:
    data = _data(
        [
            ("2024-01-02", 100.0),
            ("2024-01-28", 91.0),  # 9% down: none
            ("2024-02-02", 70.0),  # not a month-end
            ("2024-02-28", 90.0),  # exactly 10%: T10 only
            ("2024-03-02", 90.0),
            ("2024-03-28", 80.0),  # exactly 20%: T10 + T20
            ("2024-04-02", 80.0),
        ]
    )
    opens, volumes = _volume_inputs(7)
    signals = compute_signals(data, opens, volumes, FREE)
    assert signals["T10"] == _signal(7, 3, 5)
    assert signals["T20"] == _signal(7, 5)
    assert signals["ALL"] == _signal(7, 1, 3, 5)


def test_sma_trigger_needs_full_window_and_is_strict() -> None:
    data = _data(
        [
            ("2024-01-02", 100.0),
            ("2024-01-28", 50.0),  # only 2 bars: no SMA yet
            ("2024-02-02", 100.0),
            ("2024-02-28", 100.0),  # SMA(50,100,100)~83: not below
            ("2024-03-02", 100.0),
            ("2024-03-28", 70.0),  # SMA(100,100,70)=90 -> below
            ("2024-04-02", 70.0),
        ]
    )
    opens, volumes = _volume_inputs(7)
    assert compute_signals(data, opens, volumes, FREE)["T200"] == _signal(7, 5)


def _vol_data(closes: list[float], splits: dict[int, float] | None = None) -> MarketData:
    days = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"]
    return _data(list(zip(days, closes, strict=False)), splits=splits)


def test_volume_surge_red_matches_frozen_rule_with_window_including_today() -> None:
    data = _vol_data([100.0, 102.0, 100.0, 100.0, 102.0])
    opens = [100.0, 100.0, 100.0, 100.0, 100.0]
    # Bar 1: partial window (0+40)/2=20 -> 40 >= 40 fires (a full-window rule would not).
    # Bar 4: window (10+10+40)/3=20 -> 40 >= 40 fires. Bars 2-3 are not red.
    volumes = [0.0, 40.0, 10.0, 10.0, 40.0]
    assert compute_signals(data, opens, volumes, FREE)["TVOL"] == _signal(5, 1, 4)


@pytest.mark.parametrize(
    ("close", "open_"),
    [(101.0, 100.0), (9.5, 9.0)],
    ids=["red-bar-below-1.5pct", "close-below-10"],
)
def test_volume_surge_red_requires_red_bar_and_min_close(close: float, open_: float) -> None:
    data = _vol_data([100.0, 100.0, 100.0, close, 100.0])
    opens = [100.0, 100.0, 100.0, open_, 100.0]
    volumes = [10.0, 10.0, 10.0, 40.0, 10.0]
    assert compute_signals(data, opens, volumes, FREE)["TVOL"] == _signal(5)


def test_volume_before_a_split_is_scaled_by_the_split_ratio() -> None:
    data = _vol_data([400.0, 400.0, 400.0, 102.0, 102.0], splits={3: 4.0})
    opens = [400.0, 400.0, 400.0, 100.0, 100.0]
    # Raw 10,10,10 then 40 would look like a surge; adjusted it is 40,40,40,40.
    volumes = [10.0, 10.0, 10.0, 40.0, 40.0]
    assert compute_signals(data, opens, volumes, FREE)["TVOL"] == _signal(5)


# --- verdict, report, defaults -------------------------------------------------------


def _result(xirr: float, topups: int = 5) -> Result:
    return Result(
        key="x",
        contributed=1.0,
        final_value=1.0,
        xirr=xirr,
        max_drawdown=0.0,
        topups=topups,
        total_costs=0.0,
        loan_interest=0.0,
    )


@pytest.mark.parametrize(
    ("design", "validation", "expected"),
    [
        (_result(0.11), _result(0.11), "勝"),
        (_result(0.11), _result(0.09), "負"),
        (_result(0.09), _result(0.11), "負"),
        (_result(math.nan), _result(0.11), "無法判定"),
        (_result(0.11, topups=4), _result(0.11), "樣本不足"),
        (_result(0.11), _result(0.11, topups=0), "樣本不足"),
    ],
)
def test_verdict_rule(design: Result, validation: Result, expected: str) -> None:
    base = _result(0.10)
    assert verdict((design, validation), (base, base), min_topups=5) == expected


def test_default_params_are_the_pre_registered_values() -> None:
    p = DEFAULT_PARAMS
    assert (p.monthly_contribution, p.advance_months, p.loan_annual_rate) == (10_000.0, 3, 0.015)
    assert (p.bonus_amount, p.bonus_month, p.cash_annual_rate) == (30_000.0, 2, 0.015)
    assert p.buy_fee_rate == pytest.approx(0.001425 * 0.28)
    assert (p.sma_window, p.drawdown_small, p.drawdown_large) == (200, 0.10, 0.20)
    assert (p.vol_window, p.vol_multiple, p.vol_min_red_bar, p.vol_min_close) == (
        20,
        2.0,
        0.015,
        10.0,
    )
    assert p.min_topups == 5
    assert [s.key for s in SPECS] == [
        "A",
        "a-ALL",
        "a-T10",
        "a-T20",
        "a-T200",
        "a-TVOL",
        "B0",
        "b-T10",
        "b-T20",
        "b-T200",
        "b-TVOL",
    ]
    assert [(s.start, s.end) for s in SEGMENTS] == [
        (date(2003, 6, 30), date(2014, 12, 31)),
        (date(2015, 1, 1), None),
    ]


def test_report_covers_every_strategy_segment_and_assumption() -> None:
    data = _data(_months([100.0, 90.0, 110.0, 95.0, 120.0, 130.0]))
    opens, volumes = _volume_inputs(len(data.bars))
    segments = (
        Segment("設計段", date(2024, 1, 1), date(2024, 3, 31)),
        Segment("驗證段", date(2024, 4, 1), None),
    )
    results = run_all(data, opens, volumes, FREE, segments)
    report = render_report(results, FREE, data, segments)
    for token in [s.key for s in SPECS] + ["設計段", "驗證段", "隔天收盤", "樣本不足", "a-ALL"]:
        assert token in report
    assert "0050 本身" in report


# --- loader and CLI -------------------------------------------------------------------


def _raw(open_: object) -> RawMarketRows:
    prices = [
        {"date": "2024-01-02", "close": 100.0, "open": open_, "Trading_Volume": 1},
        {"date": "2024-01-03", "close": 101.0, "open": 100.0, "Trading_Volume": 1},
    ]
    return RawMarketRows(prices=prices, dividends=[], splits=[])


async def test_loader_refetches_once_when_cached_rows_lack_open_or_volume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import literati_stock.backtest.dip_topup as module

    calls: list[bool] = []

    async def fake_load(_end: date, _cache: Path, refresh: bool) -> RawMarketRows:
        calls.append(refresh)
        return _raw(100.0 if refresh else None)

    monkeypatch.setattr(module, "load_raw_rows", fake_load)
    data, opens, volumes = await module.load_inputs(date(2024, 1, 3), tmp_path, refresh=False)
    assert calls == [False, True]
    assert len(data.bars) == len(opens) == len(volumes) == 2


async def test_loader_does_not_loop_when_fresh_rows_are_bad(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import literati_stock.backtest.dip_topup as module

    calls: list[bool] = []

    async def fake_load(_end: date, _cache: Path, refresh: bool) -> RawMarketRows:
        calls.append(refresh)
        return _raw(None)

    monkeypatch.setattr(module, "load_raw_rows", fake_load)
    with pytest.raises(ValueError, match="open"):
        await module.load_inputs(date(2024, 1, 3), tmp_path, refresh=False)
    assert calls == [False, True]


def test_cli_turns_data_errors_into_clean_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    import literati_stock.backtest.dip_topup as module

    def fake_run(coro: object) -> None:
        coro.close()  # type: ignore[attr-defined]
        raise ValueError("segment 驗證段 has fewer than 2 bars")

    monkeypatch.setattr(module.asyncio, "run", fake_run)
    with pytest.raises(SystemExit, match="cannot backtest 0050 up to 2014-12-31"):
        module.main(["--end-date", "2014-12-31"])
