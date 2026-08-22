"""Integration tests for the research engine (small budgets for speed)."""

import numpy as np

from hermes.config import Config
from hermes.data.store import Candles
from hermes.data.synthetic import generate
from hermes.research.evolve import evolve
from hermes.research.validate import split_is_oos, validate_candidates


def test_split_is_oos_no_overlap():
    candles = generate(n=5000, seed=5)
    a, b = split_is_oos(candles, 0.7, 24)
    assert len(a) == 3500
    assert b.ts[0] - a.ts[-1] >= 24 * 3_600_000


def test_evolution_finds_trend_on_trending_market():
    """On a strongly trending synthetic market, evolution should find
    something with positive in-sample fitness."""
    rng = np.random.default_rng(0)
    n = 4000
    ts = np.arange(n, dtype=np.int64) * 3_600_000
    ret = 0.0015 + rng.normal(0, 0.008, n)
    c = 100 * np.cumprod(1 + ret)
    candles = Candles("UP-USDT-SWAP", "1H", ts, c, c * 1.001, c * 0.999, c, np.ones(n))
    pop, n_trials = evolve(candles, population=24, generations=4, seed=1)
    assert n_trials >= 24
    assert pop[0].fitness > 0


def test_validation_rejects_noise():
    """On pure random-walk data, (almost) nothing should pass the OOS gate.
    We accept at most 1 lucky survivor out of the whole population."""
    rng = np.random.default_rng(42)
    n = 8000
    ts = np.arange(n, dtype=np.int64) * 3_600_000
    c = 100 * np.cumprod(1 + rng.normal(0, 0.01, n))
    candles = Candles("RW-USDT-SWAP", "1H", ts, c, c * 1.001, c * 0.999, c, np.ones(n))
    pop, n_trials = evolve(candles, population=30, generations=5, seed=2)
    survivors = validate_candidates(pop, candles, n_trials=n_trials,
                                    min_oos_sharpe=1.0, min_dsr=0.5)
    assert len(survivors) <= 1
