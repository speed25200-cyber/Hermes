import numpy as np
import pytest

from hermes.backtest import engine, metrics
from hermes.data.store import Candles


def make_candles(closes, bar="1H", funding=None):
    n = len(closes)
    ts = np.arange(n, dtype=np.int64) * 3_600_000
    c = np.asarray(closes, dtype=float)
    return Candles("T-USDT-SWAP", bar, ts, c, c * 1.001, c * 0.999, c, np.ones(n),
                   funding)


def test_long_gains_on_rising_market():
    c = make_candles(np.linspace(100, 200, 500))
    res = engine.run(c, np.ones(500), fee_bps=0, slippage_bps=0)
    assert res.equity[-1] == pytest.approx(2.0, rel=1e-9)


def test_short_gains_on_falling_market():
    c = make_candles(np.linspace(100, 50, 500))
    res = engine.run(c, -np.ones(500), fee_bps=0, slippage_bps=0)
    assert res.equity[-1] > 1.9


def test_costs_reduce_equity():
    closes = 100 * np.cumprod(1 + np.random.default_rng(0).normal(0, 0.01, 1000))
    c = make_candles(closes)
    pos = np.tile([1.0, -1.0], 500)  # churn every bar
    free = engine.run(c, pos, fee_bps=0, slippage_bps=0)
    costly = engine.run(c, pos, fee_bps=5, slippage_bps=2)
    assert costly.equity[-1] < free.equity[-1]
    # 2 units traded per bar at 7 bps
    assert costly.turnover == pytest.approx(2.0, rel=0.01)


def test_no_lookahead():
    """Position at bar i earns the return of bar i+1, not bar i."""
    closes = [100.0, 100.0, 110.0, 110.0]
    c = make_candles(closes)
    pos = np.array([0.0, 1.0, 0.0, 0.0])  # long decided at close of bar 1
    res = engine.run(c, pos, fee_bps=0, slippage_bps=0)
    assert res.equity[-1] == pytest.approx(1.10, rel=1e-9)


def test_funding_charged_to_longs():
    funding = np.zeros(100)
    funding[50] = 0.001
    c = make_candles(np.full(100, 100.0), funding=funding)
    res = engine.run(c, np.ones(100), fee_bps=0, slippage_bps=0)
    assert res.equity[-1] == pytest.approx(0.999, rel=1e-9)
    res_short = engine.run(c, -np.ones(100), fee_bps=0, slippage_bps=0)
    assert res_short.equity[-1] == pytest.approx(1.001, rel=1e-9)


def test_sharpe_of_known_series():
    rng = np.random.default_rng(1)
    r = rng.normal(0.001, 0.01, 10000)
    sh = metrics.sharpe(r, 8760)
    assert 8 < sh < 11  # 0.1 per-bar SR * sqrt(8760) ~ 9.4


def test_max_drawdown():
    eq = np.array([1.0, 1.2, 0.9, 1.1, 1.5, 1.2])
    assert metrics.max_drawdown(eq) == pytest.approx(0.25)


def test_dsr_penalises_many_trials():
    rng = np.random.default_rng(2)
    r = rng.normal(0.0005, 0.01, 2000)  # modest edge
    dsr_few = metrics.deflated_sharpe(r, n_trials=2, bars_per_year=8760)
    dsr_many = metrics.deflated_sharpe(r, n_trials=5000, bars_per_year=8760)
    assert dsr_many < dsr_few


def test_norm_ppf_roundtrip():
    for p in (0.01, 0.1, 0.5, 0.9, 0.99):
        assert metrics.norm_cdf(metrics.norm_ppf(p)) == pytest.approx(p, abs=1e-6)
