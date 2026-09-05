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

All runs: `python -m hermes research --dry-run --seed 11`, costs as above,
3 worker processes. Sharpe figures are annualised, holdout only.

### Run A — 14 majors, 5 years (2021-09 → 2026-09), 1H

* Evolution: 1,086 rules in 11 min. **CSCV: PBO = 0.79**, median holdout
  Sharpe of the in-sample winner −0.06, P(loss) 0.52. Verdict: the search
  ranks noise on this universe → nothing from evolution is eligible.
* Cross-sectional momentum (best of 6 configs in-sample): holdout Sharpe
  0.47, DSR 0.09, 2/3 folds positive → reject. Hourly reversal and
  BTC-lead-lag books are deeply negative after costs (Sharpe −7 to −13).
* **Deployed: 0.** The large caps are efficiently arbitraged at these
  horizons with this rule space; the engine correctly stays flat.

### Run B — top-39 liquid perpetuals by 24h volume, 3 years, 1H
(membership = presence, i.e. survivorship-biased — see Run C)

* 38 names with ≥ 2,000 bars; panel of 26,300 bars (holdout ≈ 1.04 y).
* Evolution: 1,091 rules in 19 min. **CSCV: PBO = 0.45**, median holdout
  Sharpe of the in-sample winner 0.63, P(loss) 0.20 → the search is
  finding structure, not noise.
* Best holdout rules: walk-forward ridge (16–22 h horizon) gated to high
  volatility, Sharpe 1.41 / 1.14, PSR 0.92 / 0.87, 3/4 folds — but DSR
  0.45 / 0.34 (a one-year holdout cannot separate Sharpe 1.4 from the best
  of ten noise trials) and a mean gross exposure of only 2–3% of equity:
  a sparse-bet rule, now excluded by the gross-exposure floor.
* **Cross-sectional 2-week momentum**: holdout Sharpe **1.12**, 3/3 folds
  positive, max drawdown 17% — the documented crypto momentum premium
  appears once the universe is broad. DSR 0.18 with 28 grid configs
  charged and a one-year holdout → reject under this protocol.
* **Deployed: 0**, for the right reason: breadth creates the edge, the
  holdout is too short to certify it against the number of trials.

Consequences applied to the protocol: holdout trials cut to 6, the
momentum grid reduced to the three documented horizons (1/2/4 weeks) with
a single cap, a gross-exposure floor of 10%, and the broad-universe
snapshot extended to five years so the holdout reaches ~1.75 years.
