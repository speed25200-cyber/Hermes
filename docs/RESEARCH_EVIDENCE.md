# Research evidence — real OKX data

This file records what the v2 research protocol actually finds on real
exchange data, so that every deployment decision can be traced to
evidence rather than to a story. It is regenerated whenever the protocol
or the data coverage changes.

## Data (snapshot of 2026-09-04, `.github/workflows/data-snapshot.yml`)

| Series | Coverage | Source limit |
|---|---|---|
| 1H candles, 14 USDT perpetuals | 2021-09-01 → 2026-09-04 (43,899 bars; BNB from 2022-12-23) | full |
| Funding rates | last ~3 months only (281 payments) | OKX `funding-rate-history` serves ~3 months |
| Open interest | last 15 days (1,440 × 15m rows) | OKX `rubik` history cap |
| Mark / index price | last 180 days at 15m | OKX history endpoints |

Consequences enforced by the engine, not by hand:

* the **funding-carry** book needs ≥ 3,000 funding-covered bars — it is
  skipped until the store has accumulated ~4 months of live funding
  history (the fetcher upserts every payment as they happen);
* basis / taker-flow / open-interest families are off by default
  (`research.xs_families`) for the same reason;
* everything else is validated on the full five years.

## Protocol under test

Panel evolution (population 64 × 18 generations, in-sample = first 65%),
CSCV/PBO audit over every rule evaluated, holdout = last 35% after a
3-day embargo, top-10 rules tested once (DSR charged for 10), Sharpe ≥ 0.7,
DSR ≥ 0.5, drawdown ≤ 30%, 4 purged folds majority positive, then the
survivors must clear the Sharpe floor as an equal-weight book. Costs:
maker-first blended 2.9 bps + 0.6 bps slippage per unit turnover.

## Results

_(filled in below from the research logs)_
