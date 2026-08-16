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


def _rsi_pair(low_a: float, low_b: float) -> tuple:
    """Two RSI genomes whose bands differ by a hair — the shape the live
    registry produced twice (PEPE cvd_div deployed with OOS Sharpe agreeing
    to fifteen decimal places)."""
    from hermes.research.evolve import Candidate
    from hermes.strategy.genome import Genome
    a = Genome(signal="rsi_rev",
               params={"lookback": 39, "low": low_a, "high_gap": 60.0},
               vol_target=0.44, max_lev=1.45)
    b = Genome(signal="rsi_rev",
               params={"lookback": 39, "low": low_b, "high_gap": 60.0},
               vol_target=0.44, max_lev=1.45)
    assert a.gid != b.gid, "the two genomes must be distinct on identity"
    return Candidate(genome=a, fitness=1.0), Candidate(genome=b, fitness=0.9)


def _mean_reverting_market(n: int = 6000, seed: int = 11) -> Candles:
    rng = np.random.default_rng(seed)
    x = np.zeros(n)
    for i in range(1, n):
        x[i] = 0.985 * x[i - 1] + rng.normal(0, 0.01)
    c = 100 * np.exp(x)
    ts = np.arange(n, dtype=np.int64) * 3_600_000
    return Candles("MR-USDT-SWAP", "1H", ts, c, c * 1.001, c * 0.999, c,
                   np.ones(n))


def test_clone_is_refused_the_book_slot():
    """A near-identical genome must not take a second slot: it is one bet
    held twice, not two bets."""
    candles = _mean_reverting_market()
    cands = list(_rsi_pair(40.0, 40.000003))
    survivors = validate_candidates(
        cands, candles, n_trials=10, min_oos_sharpe=-99.0, min_dsr=0.0,
        max_oos_drawdown=1.0, n_folds=1)
    assert len(survivors) == 1
    assert survivors[0].genome.params["low"] == 40.0
    assert survivors[0].oos_stats["max_corr_to_book"] == 0.0


def test_genuinely_different_strategies_both_deploy():
    """The distinctness gate must not become a cap of one per instrument."""
    from hermes.research.evolve import Candidate
    from hermes.strategy.genome import Genome
    candles = _mean_reverting_market()
    a = Candidate(genome=Genome(signal="rsi_rev",
                                params={"lookback": 39, "low": 40.0,
                                        "high_gap": 60.0},
                                vol_target=0.44, max_lev=1.45), fitness=1.0)
    b = Candidate(genome=Genome(signal="meanrev",
                                params={"lookback": 240, "entry_z": 1.0},
                                vol_target=0.44, max_lev=1.45), fitness=0.9)
    survivors = validate_candidates(
        [a, b], candles, n_trials=10, min_oos_sharpe=-99.0, min_dsr=0.0,
        max_oos_drawdown=1.0, n_folds=1)
    assert len(survivors) == 2
    assert survivors[1].oos_stats["max_corr_to_book"] < 0.9


def test_clone_threshold_is_configurable():
    candles = _mean_reverting_market()
    cands = list(_rsi_pair(40.0, 40.000003))
    survivors = validate_candidates(
        cands, candles, n_trials=10, min_oos_sharpe=-99.0, min_dsr=0.0,
        max_oos_drawdown=1.0, n_folds=1, max_corr=1.01)
    assert len(survivors) == 2
    assert survivors[1].oos_stats["max_corr_to_book"] > 0.99
