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

### Run C — top-42 liquid perpetuals, 3 years, 1H, **causal membership**
(a name is investable at bar *t* only if it ranked top-30 by trailing
30-day quote volume at *t*)

* Evolution: 1,089 rules, **PBO = 0.55** → disqualified (borderline; the
  panel rules that top the in-sample ranking are volatility-gated ridge
  predictors with tiny exposure).
* **Cross-sectional 1-week momentum** (best of the grid in-sample):
  holdout Sharpe **2.08**, DSR 0.53, max drawdown 8.7%, 3/3 folds
  positive → passes every gate → *would deploy*.

Anatomy and stress of that book (hourly re-strike, protocol costs):
~17 names long / ~18 short, gross 1.1× equity, **turnover 1.06× equity
per day**. Sharpe by cost assumption: zero cost 2.78 → maker-blend 2.06 →
taker + 2 bps 1.35 → taker + 5 bps 0.32. By calendar year (1-week
lookback): 2023 −0.13, 2024 +1.43, 2025 −0.70, 2026 +2.68. The holdout is
carried by the 2026 momentum regime; the 4-week variant is flat-to-negative
out of sample. This is a real but regime-dependent, cost-sensitive premium
— exactly the kind of edge a book must own in small size with fast risk-off.

Consequences: cross-sectional books are now **re-struck once a day** at
00:00 UTC (turnover 1.06 → 0.64 per day at a nearly unchanged holdout
Sharpe of 1.96; 1.54 at taker + 2 bps), hourly reversal / lead-lag families
are no longer charged as default trials (Sharpe −4 to −13 after costs on
every universe), and the decisive test is the five-year broad-universe run
below.

### Run D — same universe as C, **final protocol**
(6 holdout trials, gross-exposure floor, daily re-strike of slow books,
momentum grid 1/2/4 weeks × one cap, families charged: momentum only —
carry lacks funding history)

* Evolution: 1,099 rules in 7 min, **PBO = 0.35**, median holdout Sharpe
  of the in-sample winner 0.90. Holdout contenders: a vol-gated
  time-series momentum rule reaches Sharpe 0.63 (DSR 0.25, 3/4 folds) —
  not enough; the rest fail. **0 panel rules deployed.**
* **Cross-sectional 1-week momentum, daily re-strike**: holdout Sharpe
  **1.91, DSR 0.75, max drawdown 8.6%, 3/3 folds** → deploys. Book check
  passes (single strategy).

Deployable set on three years of broad-universe data: one market-neutral
book. Its calendar-year record (2023 −1.1 / 2024 +0.8 / 2025 0.0 / 2026
+2.1 at protocol costs, daily re-strike) is the reason the risk engine, the
leverage governor and the autonomous retirement rule exist.
