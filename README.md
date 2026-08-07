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

1. **Alpha search** (`hermes/research/evolve.py`) — an evolutionary algorithm
   explores a parameterised space of strategy genomes: time-series momentum,
   moving-average cross, z-score mean reversion, Donchian breakout, RSI
   reversal, funding-rate carry — each optionally gated by a volatility-regime
   filter and scaled by per-strategy volatility targeting. Fitness is measured
   **only on in-sample data**, and averaged across sub-windows so a strategy
   must work in every sub-period, not one lucky stretch.

2. **Validation gate** (`hermes/research/validate.py`) — survivors are scored
   once on out-of-sample data separated by an embargo gap. A strategy deploys
   only if its OOS Sharpe, **Deflated Sharpe Ratio** (Bailey & López de Prado
   — the bar rises with every genome the search evaluated, killing
   selection-bias artifacts), and OOS drawdown all clear thresholds.

3. **Online adaptation** (`hermes/portfolio/allocator.py`) — deployed
   strategies are tracked bar by bar. Capital flows multiplicatively toward
   what is working *now* and drains from what has stopped working. A
   portfolio-level volatility target scales the whole book.

4. **Re-research** — the live loop automatically re-runs the whole research
   pass when the deployed set is stale (weekly by default) or empty, on fresh
   data. The edge is re-derived continuously, not fitted once.

5. **Risk engine** (`hermes/risk.py`) — hard caps on per-instrument and gross
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

# 2. Real data: backfill OKX candles + funding history (public API, no keys)
python -m hermes fetch

# 3. Research on real data
python -m hermes research

# 4. Paper-trade the deployed strategies against live OKX prices
python -m hermes run --mode paper

# 5. Live trading (only after you are satisfied with paper results)
export OKX_API_KEY=...       OKX_API_SECRET=...     OKX_API_PASSPHRASE=...
# optional: export OKX_SIMULATED=1   # OKX demo-trading environment first!
python -m hermes run --mode live
```

Configuration lives in `config.json` (see `config.example.json`; defaults in
`hermes/config.py`). API keys are **environment variables only** — never
stored on disk.

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

## Layout

```
hermes/
  config.py              defaults + env credentials
  features.py            vectorized, strictly causal indicator library
  risk.py                risk engine (limits, halts, kill switch)
  data/    store.py      SQLite candle/funding store
           fetcher.py    OKX history backfill (public endpoints)
           synthetic.py  regime-switching market generator (offline tests)
  strategy/genome.py     strategy search space (mutate/crossover)
           signals.py    genome -> target exposure series
  backtest/engine.py     vectorized backtester (fees, slippage, funding)
           metrics.py    Sharpe, Sortino, PSR, Deflated Sharpe, drawdown
  research/evolve.py     evolutionary alpha search (in-sample only)
           validate.py   OOS validation gate (DSR threshold)
  portfolio/allocator.py multiplicative-weights capital allocation
  exchange/okx_client.py OKX v5 REST (signed), retries, demo-trading support
           broker.py     Broker interface: PaperBroker + OKXBroker
  live/trader.py         decision cycle + autonomous runner (auto re-research)
  cli.py                 demo / fetch / research / run / status
tests/                   39 tests: no-lookahead, costs, risk, e2e replay
```

## Tests

```bash
python -m pytest tests/ -q
```

Covers: backtest accounting (including a no-lookahead test), causality of
every signal family (future data cannot change past positions), risk halts
and kill-switch persistence, paper-broker PnL, allocator behaviour, OOS gate
rejecting pure noise, and full trader-cycle integration.
