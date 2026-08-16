import pytest

from hermes.portfolio.allocator import Allocator


def test_weights_shift_toward_winner():
    a = Allocator(ewma_halflife_bars=20, eta=2.0, max_weight=0.9, bars_per_year=8760)
    for _ in range(200):
        a.observe({"win": 0.002, "lose": -0.002}, 0.0)
    w = a.weights(["win", "lose"])
    assert w["win"] > 0.7
    assert w["win"] + w["lose"] == pytest.approx(1.0)


def test_young_strategy_gets_neutral_weight():
    a = Allocator(bars_per_year=8760)
    w = a.weights(["new1", "new2"])
    assert w["new1"] == pytest.approx(0.5)


def test_vol_scaling_reduces_hot_portfolio():
    a = Allocator(ewma_halflife_bars=50, portfolio_vol_target=0.2, bars_per_year=8760)
    for _ in range(500):
        a.observe({}, 0.02)  # wildly volatile portfolio
    assert a.portfolio_scale() < 0.5


def test_combine_respects_weights():
    a = Allocator(bars_per_year=8760)
    book = a.combine({"s1": {"BTC": 1.0}, "s2": {"BTC": -1.0}})
    assert book["BTC"] == pytest.approx(0.0)


def test_crowding_penalty_downweights_clones():
    """Two perfectly correlated strategies should each get less weight than
    an equally-performing but uncorrelated third one."""
    import math
    import random
    rng = random.Random(0)
    a = Allocator(ewma_halflife_bars=100, eta=0.0, corr_penalty=2.0,
                  max_weight=0.9, bars_per_year=8760)
    for _ in range(600):
        r = rng.gauss(0.0005, 0.01)
        r_ind = rng.gauss(0.0005, 0.01)
        a.observe({"clone1": r, "clone2": r, "indep": r_ind}, 0.0)
    assert a.crowding("clone1", ["clone1", "clone2", "indep"]) > \
           a.crowding("indep", ["clone1", "clone2", "indep"]) + 0.3
    w = a.weights(["clone1", "clone2", "indep"])
    assert w["indep"] > w["clone1"]
    assert w["indep"] > 0.4


def test_pair_cov_persistence_roundtrip():
    a = Allocator(bars_per_year=8760)
    a.observe({"x": 0.01, "y": 0.01}, 0.0)
    d = a.to_dict()
    b = Allocator(bars_per_year=8760)
    b.restore(d)
    assert b.pair_cov == a.pair_cov
    assert b.tracks["x"].n_obs == 1


def _combined_sharpe(seed, mus, vols, raw_gap_tilt=False, n=4000, bpy=8760):
    """Run a book of independent strategies through the allocator and score
    the stream it actually produces."""
    import math

    import numpy as np

    rng = np.random.default_rng(seed)
    rets = {f"s{i}": rng.normal(mus[i] * vols[i], vols[i], n)
            for i in range(len(vols))}
    a = Allocator(bars_per_year=bpy)
    if raw_gap_tilt:                       # the behaviour before this guard
        a._score_se = lambda t: 1.0
    for t in range(n):
        step = {k: r[t] for k, r in rets.items()}
        a.observe(step, sum(step.values()) / len(rets))
    w = a.weights(list(rets))
    comb = sum(w[k] * rets[k] for k in rets)
    return comb.mean() / comb.std() * math.sqrt(bpy), w


def test_tilt_does_not_chase_estimation_noise():
    """Strategies with identical true edges differ by several Sharpe units of
    pure sampling noise. Tilting on the raw gap concentrates the book on the
    luckiest one and forfeits the diversification it exists to collect."""
    vols = [0.0005, 0.001, 0.002, 0.004, 0.008]
    equal = [0.05] * 5
    before = [_combined_sharpe(s, equal, vols, raw_gap_tilt=True)[0]
              for s in range(6)]
    after = [_combined_sharpe(s, equal, vols)[0] for s in range(6)]
    assert sum(after) / len(after) > sum(before) / len(before) * 1.1


def test_tilt_still_backs_a_genuinely_better_strategy():
    """The noise guard must not make the allocator inert: a real edge still
    has to earn a weight well above equal-weighting."""
    vols = [0.0005, 0.001, 0.002, 0.004, 0.008]
    mus = [0.12, 0.02, 0.02, 0.02, 0.02]        # s0 has 6x the true Sharpe
    got = [_combined_sharpe(seed, mus, vols)[1]["s0"] for seed in range(4)]
    assert min(got) > 2.0 / len(vols), f"real edge under-weighted: {got}"
    assert sum(got) / len(got) > 0.5, f"real edge not backed on average: {got}"
