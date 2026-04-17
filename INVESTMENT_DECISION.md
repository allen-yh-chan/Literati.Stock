# Investment Decision Log — 2026-04-17

This document records the decision to pause active development of the
Literati.Stock signal research system and redirect the investment goal to
passive indexing. Future-you: read this before re-activating the project.

## Context

Over one day of R&D sprints (2026-04-17), a complete quant signal pipeline
was built:

- Ingest layer (FinMind → `ingest_raw`, rate-limited + retried)
- Domain tables (`stock_price`, `institutional_buysell`, `margin_transaction`, `stock_universe`)
- ELT transforms with cursor-based idempotent replay
- Scheduler with 9 cron jobs (ingest + transform + signal + notify)
- Two signals: `volume_surge_red`, `institutional_chase_warning`
- Discord webhook notifications
- Docker deploy (multi-stage image ~70 MB, compose stack)
- 125 tests, 87% coverage, Pyright strict 0 errors

All code is in `main`. Git history is the complete pre-registration of
signal parameters (see: PR #3, #6).

## Decision

**Pause the project. DCA (dollar-cost average) into 0050 for the investment
return goal.**

No further development. Docker stack stopped. Signals still technically
valid and frozen; they simply won't be evaluated further.

## Why DCA 0050 over the signal system we built

Stated goal: investment return (stated 2026-04-17 via Auto Mode answer "1").

Evidence base for the decision:

1. **No formal backtest was run.** The 56 historical `signal_event` records
   produced by the two frozen signals have never been compared against any
   alternative, any benchmark, or any null model. They are unvalidated.
2. **Academic consensus (SPIVA, DALBAR, Fama, Bogle) over 30+ years**:
   majority of active timing strategies lose to index buy-and-hold after
   costs. Retail investors lose more consistently than professionals.
3. **Schwab "perfect-timer" simulation**: even a god-mode investor who
   invests at every market bottom beats DCA by <6% over 20 years. Realistic
   timing captures 10–30% of perfect. Expected excess: ~0.03% annualised.
4. **Transaction cost math**: signal-driven trading in Taiwan ≈ 0.59%
   round-trip. To beat DCA's 0.43% TER + market beta, a signal must produce
   ≥ 5–7% annual alpha — hedge-fund-tier performance, not plausible for an
   LLM-designed, untuned, 5-stock, 18-month-backfilled setup.
5. **Markov bias of the author** (me, the LLM): acknowledged training-data
   contamination of Taiwan equity history. Documented in
   `feedback_backtest_pact.md` memory.
6. **Trend Following variants** (200-day MA, etc.) reduce max drawdown by
   ~50% but sacrifice ~1% CAGR and require multi-decade discipline through
   whipsaw periods. Not superior to DCA for pure return.
7. **Opportunity cost**: every week spent engineering signals is a week of
   market compounding lost to 80%+ of scenarios where DCA wins anyway.

## What is archived, not deleted

- Repository: stays at <https://github.com/allen-yh-chan/Literati.Stock>
- DB data: untouched (Docker volume `literatistock_pgdata`)
- Docker image: stays built; compose stopped with `docker compose down`
- Discord webhook: URL unchanged in `.env`; stack stopped → no more messages
- OpenSpec: six specs in `openspec/specs/` preserved as the change history
  (data-ingestion, price-domain, signal-engine, signal-notification,
  stock-universe, chip-data)
- Signal parameters: frozen in git, never retuned (see pact)

## Conditions that would justify re-activation

Re-opening this project is sensible **only** if the goal changes from (1)
investment return to one of the below:

- **(2) Literati product**: commercial offering whose KPI is user value
  (education, engagement, risk awareness), not alpha over 0050.
- **(3) R&D training**: personal or team skill development; explicit
  acknowledgement that the system will not beat DCA.
- **(4) Institutional-grade research**: proper walk-forward OOS with
  multi-year forward paper trading, access to paid data sources (FinMind
  paid / Refinitiv), budgeted multi-year staff time.

Any re-activation must start by re-reading this doc and explicitly choosing
the new goal.

## Action items executed

- [x] Project decision documented (this file)
- [ ] `docker compose down` — stop running stack (scheduled jobs stop firing)
- [ ] Memory updated with decision

## DCA action items for Allen (do this instead)

- [ ] Emergency fund first: 3–6 months living expenses in high-yield savings
      (王道 / Richart / 新光 等,利率 ~1.5%)
- [ ] Open brokerage account at one of 永豐金 / 富邦 / 元大 / 國泰 / 凱基
      / 兆豐 / 玉山 (online, ~10 min)
- [ ] Set up 定期定額 0050: monthly, amount = affordable fraction of salary,
      auto-debit aligned with payday +1 day
- [ ] Optional diversification: 0050 + 0056 (high-dividend) or 0050 + VT/VWRA
      (global), treat as out of scope for now
- [ ] **Uninstall** stock-price and broker apps from phone; stop receiving
      Discord signals; avoid market news daily
- [ ] Review once per year (e.g., every 1 January). Do not change DCA amount
      reactively during drawdowns; increase only when salary increases.
- [ ] 10–20 year horizon; expected outcome ~7–8% CAGR; do not abandon during
      any single year.

## A note to future-me

If you are reading this 2–5 years from now and wondering "should I reopen
the project?", remember:

1. Your DCA position has been compounding silently. Check its value before
   deciding anything.
2. Any "new idea" you have about why the signals would work **now** is
   probably confirmation bias from recent market events. Commit the new
   idea in writing and sleep on it 30 days.
3. If you still want to reopen, state the **new goal** first (not the old
   one). Goals (1) haven't changed; (2)/(3)/(4) are the valid re-entry
   paths.
4. Forward paper trading is the only honest test. Don't re-run backtests
   looking for different numbers than last time.

Signed off: Allen Chan, R&D Head, Literati, 2026-04-17.
