# Hermes

**Autonomous perpetual-futures trading system for OKX.**

Hermes discovers its own trading edge, validates it against rigorous
anti-overfitting statistics, allocates capital adaptively across the
strategies that are currently working, enforces hard risk limits, and
executes long/short on OKX USDT-margined perpetual swaps — with no human in
the loop.

```
data  ->  features  ->  evolutionary alpha search  ->  OOS validation gate
                                                            |
   OKX / paper broker  <-  risk engine  <-  adaptive allocator
```

## How it "finds the edge alone"

Hermes is built around one principle: **a strategy is a rule, not a curve
fitted to one coin**, and a rule earns capital only by surviving evidence
that would kill noise. Everything below is implemented from scratch in
numpy and runs identically in research, paper and live trading.

1. **Panel research** (`hermes/research/panel.py`) — every candidate rule
   is applied to the *whole universe* (14 liquid USDT perpetuals, hourly
   bars, five years) and scored as one equal-split, vol-targeted book. This
   is how systematic managers test signals: the sample is universe × time,
   cross-instrument diversification lifts the achievable Sharpe, and a rule
   that only "works" on one lucky coin is exposed for what it is. Newer
   listings contribute the history they have; missing bars are absent, not
   zero.

2. **Rule space** (`hermes/strategy/`) — time-series momentum with a
   deadband, z-score mean reversion, funding carry, basis / taker-flow /
   open-interest fades, and two walk-forward ML predictors (closed-form
   ridge, gradient-boosted stumps) over a causal feature matrix with
   cross-asset lead-lag from BTC. Each rule can be gated by a volatility
   percentile or by a **Gaussian-mixture regime** label (`hermes/ml/`), is
   vol-targeted per instrument, and passes through a fixed **no-trade band**
   so continuously re-scaled positions do not churn fees. ML predictions
   carry a causal hit-rate confidence and a **split-conformal interval**:
   a position opens only when the prediction exceeds a multiple of its own
   realised error and is sized by that ratio.

3. **Evolutionary search** (`hermes/research/evolve.py`) — a genetic
   algorithm explores the rule space **in-sample only** (the first 65% of
   history). Fitness is the mean Sharpe across sub-windows plus the worst
   sub-window, minus drawdown and turnover: a rule must work in every
   sub-period. Evaluation is parallel across CPU cores; every rule ever
   evaluated keeps its in-sample return series for the audit below.

4. **Backtest-overfitting audit** (`hermes/research/pbo.py`) —
   Combinatorially Symmetric Cross-Validation (Bailey, Borwein, López de
   Prado & Zhu): the in-sample history is cut into 10 blocks; for each of
   the 252 ways of picking 5 as "train", the best rule by train Sharpe is
   selected and ranked on the other 5. **PBO** is how often that winner
   lands in the worse half out-of-sample. A search whose winners are noise
   gives PBO ≳ 0.5 and **nothing from that search is eligible**, whatever
   the holdout says next.

5. **Holdout gate** (`hermes/research/validate.py`) — the best ten rules
   face the last 35% of history, separated by a 3-day embargo, exactly
   once. A rule deploys only if it clears the OOS Sharpe floor, the
   **Deflated Sharpe Ratio** (charged for the ten rules that actually
   competed on the holdout — the multiple-testing that matters), the
   drawdown cap, and **purged fold consistency** (four embargoed sub-folds,
   majority individually profitable).

6. **Cross-sectional books** (`hermes/strategy/xs.py`) — market-neutral
   portfolios spanning the universe (rank → z-score → inverse-vol →
   dollar-neutral → vol target): **funding carry**, multi-week **momentum**,
   short-horizon **reversal**, and **BTC lead-lag** continuation. Each
   family searches a six-config grid in-sample and its single best config
   faces the holdout with the DSR charged for every config of every family.

7. **Book check** — the survivors are a portfolio, so their equal-weight
   holdout return must itself clear the Sharpe floor; the weakest members
   are dropped until it does.

8. **Online adaptation** (`hermes/portfolio/allocator.py`) — deployed rules
   are tracked bar by bar. Capital flows multiplicatively toward what is
   working *now*, an EWMA correlation matrix down-weights crowded rules,
   and a portfolio vol target scales the whole book. A **leverage
   governor** de-risks fast in drawdown and lets exposure above 1× be
   earned only by live results.

9. **The hunt never sleeps** — the research pass re-runs weekly on fresh
   data, daily while the book is empty (with an escalating search budget —
   thresholds never move), and a deployed rule whose *live* shadow Sharpe
   collapses is retired autonomously. Hunt → audit → validate → trade →
   monitor → retire → hunt again, with no human in the loop.

10. **Risk engine** (`hermes/risk.py`) — hard caps on per-instrument (1×)
    and gross (3×) leverage, a daily loss limit (4%: flatten + halt until
    next UTC day), and a max-drawdown **kill switch** (20%: flatten + halt
    until manual reset; survives restarts). Nothing overrides it.

11. **Maker-first execution** (`hermes/exchange/broker.py`) — live orders
    rest post-only at the touch with a timed taker fallback; backtests and
    the paper broker charge the same blended cost, with the same miss rate.

State written by an earlier engine version (rules validated under another
protocol, paper books from another risk regime) is archived automatically
on start-up, never reused.

## Quickstart

```bash
pip install -r requirements.txt

# 1. Offline proof (no network, no keys): synthetic market -> research ->
#    out-of-sample paper replay through the full trading stack
python -m hermes demo --fast

# 1b. Research + OOS replay on REAL bundled candles (EURUSD 1H, GOOG 1D),
#     including the naive-optimiser comparison the validation gate protects
#     against. Deploying nothing is the correct outcome when no edge holds.
python -m hermes realtest

# 2. Real data: backfill OKX candles + funding history (public API, no keys)
python -m hermes fetch
#    ...or, where the exchange is unreachable, import a snapshot produced by
#    .github/workflows/data-snapshot.yml (orphan branch okx-data-snapshot)
python -m hermes import-snapshot path/to/snapshot

# 3. Research on real data (--dry-run leaves the registry untouched)
python -m hermes research

# 4. Paper-trade the deployed strategies against live OKX prices
python -m hermes run --mode paper

# Dashboard — local web console (equity curve, book, allocation, risk, logs)
python -m hermes dashboard            # opens http://127.0.0.1:8899
python -m hermes dashboard --demo     # inspect the offline demo run
# Windows: double-click hermes-dashboard.bat

# 5. Live trading (only after you are satisfied with paper results)
export OKX_API_KEY=...       OKX_API_SECRET=...     OKX_API_PASSPHRASE=...
# optional: export OKX_SIMULATED=1   # OKX demo-trading environment first!
python -m hermes run --mode live
```

Configuration lives in `config.json` (see `config.example.json`; defaults in
`hermes/config.py`). API keys are **environment variables only** — never
stored on disk.

## Running on GitHub Actions (no server needed)

Hermes trades 1H bars, so one decision per hour matches the Actions
execution model: wake, decide, persist, exit. Two workflows are included:

- `.github/workflows/trade.yml` — hourly trading cycle (`hermes cycle`).
  Market data lives in the Actions cache; registry/risk/journal state is
  committed back to the repo so each run resumes exactly where the last
  ended.
- `.github/workflows/research.yml` — weekly alpha research; commits the
  deployed-strategy registry the hourly cycle trades.

Setup: use a **private repo**, add `OKX_API_KEY` / `OKX_API_SECRET` /
`OKX_API_PASSPHRASE` as Actions secrets (trade-only permission, never
withdrawal), then run the research workflow once. Defaults are safe: paper
mode and OKX demo-trading until you set the `HERMES_MODE=live` and
`OKX_SIMULATED=0` repository variables. Scheduled workflows run from the
default branch.

Honest limits vs an always-on VPS: cron fires with minutes of jitter and
occasionally skips; nobody watches positions *between* hourly runs (the
kill switch evaluates only when a cycle runs, vs every 20 s on a VPS); and
runner IPs rotate, so the OKX key cannot be IP-allowlisted. Fine for paper
and cautious small live sizes — prefer a VPS beyond that.

## Recommended path to live capital

1. `demo` — verify the pipeline end to end.
2. `fetch` + `research` — inspect what the search deploys (`hermes status`).
3. `run --mode paper` for **several weeks minimum**.
4. `OKX_SIMULATED=1` live run against OKX's demo-trading environment.
5. Real keys, small capital, `max_gross_leverage` low. Scale only with
   sustained evidence.

## Honest expectations — read this

- **No system can guarantee profits.** Renaissance-grade returns took
  hundreds of researchers, decades, and data/infrastructure advantages no
  retail system has. What Hermes reproduces is the *method*: systematic
  search, ruthless out-of-sample validation, adaptive allocation, and risk
  control that keeps you solvent while the edge is uncertain.
- The demo's synthetic market contains deliberately strong regimes, so its
  Sharpe is unrealistically high. On real crypto perps, an OOS Sharpe of
  0.5–1.5 after costs is a good outcome; many research passes will correctly
  deploy **nothing** — that is the validation gate protecting you from noise.
- Perpetual futures are leveraged instruments. You can lose your entire
  margin. Never trade money you cannot afford to lose. This software is
  provided as-is, without warranty; nothing here is financial advice.

## Dashboard

`python -m hermes dashboard` starts a zero-dependency local web console
(Python stdlib only) and opens it in your browser. On Windows, double-click
`hermes-dashboard.bat`. It reads the state directory and refreshes live:

- animated equity curve with crosshair inspection and session P&L
- risk envelope: drawdown gauge against the kill-switch limit, daily loss
- allocation constellation: deployed strategies orbiting by capital weight
- book (positions vs targets), deployed-strategy table with OOS Sharpe/DSR
- order flow and activity log feeds

Use `--demo` to inspect the offline demo run, `--port` to change the port,
and `--host 0.0.0.0` to expose it to your LAN (trusted networks only).
The UI is a single HTML file (SVG + vanilla JS, no CDN) and every asset —
including the bundled Inter and JetBrains Mono typefaces (both SIL OFL
licensed) — is served locally, so it works fully offline.

**iPhone / iPad**: the console installs as a home-screen app (PWA) with its
own icon and a mobile-optimised layout — Safari → Share → Add to Home
Screen. The trading engine itself cannot run on iOS (the OS suspends
background apps), so the phone is the cockpit and the engine stays on an
always-on machine. Full guide, secure remote-access options and an optional
native SwiftUI shell: [`ios/README.md`](ios/README.md).

## Layout

```
hermes/
  config.py              defaults + env credentials
  features.py            vectorized, strictly causal indicator library
  risk.py                risk engine (limits, halts, kill switch)
  data/    store.py      SQLite candle/funding store
           fetcher.py    OKX history backfill (public endpoints)
           synthetic.py  regime-switching market generator (offline tests)
  ml/      models.py     ridge + gradient-boosted stumps (pure numpy)
           feature_matrix.py  causal features incl. cross-asset lead-lag
           predictor.py  walk-forward engine, confidence, incremental cache
           regime.py     Gaussian-mixture EM regime detection (causal)
  strategy/genome.py     strategy search space (mutate/crossover)
           signals.py    genome -> target exposure series
  backtest/engine.py     vectorized backtester (fees, slippage, funding)
           metrics.py    Sharpe, Sortino, PSR, Deflated Sharpe, drawdown
  research/panel.py      universe-wide rule evaluation (aligned book returns)
           evolve.py     evolutionary alpha search (in-sample only, parallel)
           pbo.py        CSCV probability of backtest overfitting
           validate.py   holdout gate (Sharpe, DSR, drawdown, purged folds) + book check
           xs.py         cross-sectional family research gate
  portfolio/allocator.py multiplicative-weights capital allocation
  exchange/okx_client.py OKX v5 REST (signed), retries, demo-trading support
           broker.py     Broker interface: PaperBroker + OKXBroker
  live/trader.py         decision cycle + autonomous runner (auto re-research)
  dashboard/server.py    zero-dependency local web console (stdlib http)
           index.html    single-file UI: SVG charts, animated console
  cli.py                 demo / fetch / research / run / status / dashboard
tests/                   130+ tests: no-lookahead, ML causality, regimes, PBO, panel, e2e
```

## Tests

```bash
python -m pytest tests/ -q
```

Covers: backtest accounting (including a no-lookahead test), causality of
every signal family (future data cannot change past positions), risk halts
and kill-switch persistence, paper-broker PnL, allocator behaviour, OOS gate
rejecting pure noise, and full trader-cycle integration.
