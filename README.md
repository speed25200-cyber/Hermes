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

0. **Universe** (`hermes/data/universe.py`) — the 60 most-traded USDT
   perpetuals on OKX, re-ranked on every fetch. Breadth is the one lever that
   lifts the combined Sharpe without lifting cost per trade (independent
   edges add as sqrt(N); fees stay per-trade), and a hardcoded list decays as
   venues list and delist. The cross-asset leader stays at index 0 and an
   instrument still carrying a position is never dropped, so no refresh can
   strand a trade. The book itself is capped globally
   (`research.max_deployed_total`): capital is shared across everything
   deployed, so an unbounded book starves each strategy below the rebalance
   band and nothing reaches the market. Slots are filled instrument by
   instrument rather than by global Sharpe rank, so the breadth the wider
   universe bought is not handed straight back to whichever few names drew
   the luckiest estimates.

1. **Prediction engine** (`hermes/ml/`) — a genuine forecasting layer, all
   implemented from scratch in numpy:
   - a causal **feature matrix** per instrument: multi-horizon vol-scaled
     momentum, volatility structure, oscillators, channel position, candle
     shape, volume pressure, funding carry, intraday/weekly seasonality,
     **cross-asset lead-lag features** from the universe leader (BTC leads
     alts), and the full **derivatives microstructure** block — open
     interest, taker-flow imbalance, cumulative volume delta, crowd and
     top-trader positioning, spot basis and the self-recorded book
     imbalance. Both learners are additive (ridge is linear, the trees are
     depth-1 stumps), so the flow-vs-price cross terms are supplied
     explicitly. Instruments with no aux history contribute neutral columns
     rather than a narrower matrix, so coverage can grow over time;
   - two learners fit under a strict **walk-forward protocol** (train only on
     the past, horizon-length embargo before every refit, periodic
     re-training): closed-form **ridge regression** and **gradient-boosted
     stumps** whose split search is vectorised into BLAS matrix products;
   - predictions carry a causal **confidence score** (rolling hit rate) and a
     **conformal prediction interval** — the rolling quantile of realised
     |target − prediction| nonconformity, using only outcomes already
     observable. A position opens only when the prediction exceeds a multiple
     of its own typical error and its size scales with that ratio:
     distribution-free uncertainty quantification (empirical coverage is
     tested), not a Gaussian assumption;
   - the training label is the forward return **net of funding**, not the
     price move: on perpetuals a position held across a stamp pays it, and
     crypto funding routinely runs tens of percent annualised, so a model
     trained on price alone would buy a 5bp move while paying 15bp to hold
     it;
   - an incremental cache extends the walk-forward state bar by bar in live
     trading with bit-identical results to the batch computation (tested).

2. **Cross-sectional stat-arb books** (`hermes/strategy/xs.py`) — three
   hedge-fund-style market-neutral portfolios spanning the whole universe,
   sharing one construction (rank → z-score → inverse-vol → dollar-neutral
   → portfolio-vol target):
   - **funding carry** (`funding_xs`): short the richest funding, long the
     cheapest — harvests the structural funding spread (researched only on
     the window where funding history actually exists);
   - **momentum** (`xs_mom`): long the strongest multi-week vol-adjusted
     winners, short the losers, with a one-day skip against reversal;
   - **reversal** (`xs_rev`): long the short-horizon losers, short the
     winners — classic stat-arb mean reversion.
   Each family searches its own small grid, but the Deflated Sharpe is
   charged with the total number of configs searched across all families —
   selection bias is paid for the whole sweep. Survivors are executed as
   multi-asset books beside the per-instrument strategies.

3. **Maker-first execution** (`hermes/exchange/broker.py`) — live orders try
   a post-only limit at the touch first (OKX maker ~0.02%) with a timed
   fallback to market, handling partial fills exactly. Backtests use the
   matching expected-cost model (`effective_costs`): a ~40% cost reduction
   per trade that compounds into a real, mechanical edge. That model blends
   the maker and taker fee by an *assumed* miss rate, so live fills record
   the average price and the fee the exchange actually charged and
   `hermes execution` contrasts realised cost with the modelled one — if the
   real maker share is worse than assumed, every Sharpe in the registry is
   optimistic by the difference.

4. **Regime detection** (`hermes/ml/regime.py`) — a Gaussian-mixture EM
   (hand-written) classifies every bar as quiet / normal / turbulent from
   vol-normalised returns and volatility structure, refit on a trailing
   window and applied strictly causally. Strategies can gate themselves to
   the regimes where their edge exists.

5. **Alpha search** (`hermes/research/evolve.py`) — an evolutionary algorithm
   explores a parameterised space of strategy genomes: the two ML predictor
   families (horizon, threshold, regularisation, cross-asset on/off) plus
   time-series momentum, moving-average cross, z-score mean reversion,
   Donchian breakout, RSI reversal and funding-rate carry — each optionally
   gated by a volatility- or regime-filter and scaled by per-strategy
   volatility targeting. Fitness is measured **only on in-sample data**,
   averaged across sub-windows so a strategy must work in every sub-period.
   The families that need derivatives data (open-interest momentum, taker
   flow, crowd fade, top-trader follow, CVD divergence, book imbalance) are
   searched in their own pass, restricted to the window where that history
   actually exists — exchanges serve only a few months of it.

6. **Validation gate** (`hermes/research/validate.py`) — survivors are scored
   once on out-of-sample data separated by an embargo gap. A strategy deploys
   only if it clears the OOS Sharpe floor, the **Deflated Sharpe Ratio**
   (Bailey & López de Prado — the bar rises with every genome the search
   evaluated, killing selection-bias artifacts), the OOS drawdown cap, AND
   **purged multi-fold consistency**: the OOS window is cut into embargoed
   sub-folds and the majority must be individually profitable (CPCV spirit).
   Every Sharpe-based statistic is charged for **serial correlation** first:
   a position held across many bars — or an hourly aux series carried onto
   15m bars — means consecutive returns are not independent, so a
   Newey-West variance inflation factor haircuts the reported Sharpe (Lo
   2002) and shrinks the effective sample the PSR and DSR rest on. Fewer
   independent observations also raise the selection bar, so a correlated
   strategy must clear more, not the same. The factor is floored at 1: the
   correction may only ever make a strategy look worse.

7. **Online adaptation** (`hermes/portfolio/allocator.py`) — deployed
   strategies are tracked bar by bar. Capital flows multiplicatively toward
   what is working *now*, an EWMA **correlation matrix downweights crowded
   strategies** so the book spreads across genuinely independent edges, and
   a portfolio-level volatility target scales the whole book.

   Two things keep that from collapsing onto one name. The performance tilt
   is applied to the gap **in standard errors**, not in raw Sharpe units:
   over an EWMA window that error is several units wide, so tilting on the
   raw gap concentrates capital on whichever strategy was luckiest — on five
   strategies with identical true edges, measuring in standard errors lifts
   the combined Sharpe from 6.8 to 8.5 across seeds. And capital is shared
   only among the strategies **actually asking for exposure**: one sitting
   flat contributes nothing to the book, so letting it hold weight would only
   shrink the others.

8. **The adaptive hunt** — the live loop re-runs the whole research pass on
   fresh data when the deployed set goes stale (weekly by default). While
   the book is **empty**, the hunt does not sleep: it re-runs **daily**, and
   every consecutive empty pass widens the evolutionary search budget
   (population and generations ×1.5, then ×2). Validation thresholds never
   move — the system digs deeper, it does not lower the bar. Conversely, a
   deployed strategy whose **live** shadow returns turn clearly negative
   (annualised Sharpe below −0.5 over 1000+ live bars) is **retired
   autonomously** and the hunt resumes. The full loop — hunt → validate →
   trade → monitor → retire → hunt again — closes with no human in it.

9. **Risk engine** (`hermes/risk.py`) — hard caps on per-instrument and gross
   leverage, a daily loss limit (flatten + halt until next UTC day), and a max
   drawdown **kill switch** (flatten + halt until manual reset; survives
   restarts). This is the last line of defence and cannot be overridden by
   any strategy.

Identical genome → signal → position code runs in backtest, paper and live
trading, eliminating backtest/live drift.

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

# 3. Research on real data
python -m hermes research

# 4. Paper-trade the deployed strategies against live OKX prices
python -m hermes run --mode paper

# History held per data source (incl. the self-recorded order book)
python -m hermes coverage

# Did the gate's OOS estimate survive contact with live trading?
python -m hermes calibration

# Is trading actually costing what every backtest assumed?
python -m hermes execution

# Export the market history that cannot be re-fetched (the order book from
# day one, and every aux row aged past the exchange's retention window)
python -m hermes backup --out hermes-aux.jsonl

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
           universe.py   venue-ranked instrument selection (leader pinned)
           fetcher.py    OKX history backfill (public endpoints)
           synthetic.py  regime-switching market generator (offline tests)
  ml/      models.py     ridge + gradient-boosted stumps (pure numpy)
           feature_matrix.py  causal features incl. cross-asset lead-lag
           predictor.py  walk-forward engine, confidence, incremental cache
           regime.py     Gaussian-mixture EM regime detection (causal)
  strategy/genome.py     strategy search space (mutate/crossover)
           signals.py    genome -> target exposure series
  backtest/engine.py     vectorized backtester (fees, slippage, funding)
           metrics.py    Sharpe (serial-correlation adjusted), Sortino,
                         PSR, Deflated Sharpe, Newey-West inflation, drawdown,
                         gross-vs-net and the cost drag frictions took
  research/evolve.py     evolutionary alpha search (in-sample only)
           validate.py   OOS validation gate (DSR threshold)
  portfolio/allocator.py multiplicative-weights capital allocation
  exchange/okx_client.py OKX v5 REST (signed), retries, demo-trading support
           broker.py     Broker interface: PaperBroker + OKXBroker
  live/trader.py         decision cycle + autonomous runner (auto re-research)
  dashboard/server.py    zero-dependency local web console (stdlib http)
           index.html    single-file UI: SVG charts, animated console
  cli.py                 demo / fetch / research / run / status /
                         coverage / calibration / execution / backup /
                         dashboard
tests/                   144 tests: no-lookahead, ML causality, microstructure
                         features, metric autocorrelation, regimes, e2e
```

## Tests

```bash
python -m pytest tests/ -q
```

Covers: backtest accounting (including a no-lookahead test), causality of
every signal family (future data cannot change past positions), risk halts
and kill-switch persistence, paper-broker PnL, allocator behaviour, OOS gate
rejecting pure noise, and full trader-cycle integration.
