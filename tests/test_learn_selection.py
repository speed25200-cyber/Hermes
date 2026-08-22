"""The learner's selection has to survive its own search.

The build these tests were written against picked the best of three policies
by holdout mean, over two bar sizes, and then asked only whether that maximum
was above zero. Fed pure random walks it put 11 of 30 desks live, with
holdouts up to +21 bps after a 7 bps round trip. Three things were wrong and
each has a test here: the split ran across instruments instead of across
time, the holdout labels overlapped so every standard error was too small,
and the winner of a six-way search was judged against a fixed bar of zero.
"""

import math

import numpy as np
import pytest

from hermes.data.store import Candles
from hermes.scalp.learn import ASSETS, BARS, HorizonBook, ScalpLearner

BAR_MS = {"15m": 900_000, "1H": 3_600_000}


def _series(rng, n, bar, kind="noise", k=0.45, vol=0.004, px0=100.0):
    """kind: 'noise' iid | 'revert' fading pays | 'trend' following pays."""
    e = rng.normal(0.0, vol, n)
    if kind == "noise":
        r = e
    else:
        r = np.zeros(n)
        sgn = -k if kind == "revert" else k
        for t in range(1, n):
            r[t] = sgn * r[t - 1] + e[t]
    c = px0 * np.exp(np.cumsum(r))
    o = np.concatenate([[px0], c[:-1]])
    wig = np.abs(rng.normal(0.0, vol * 0.25, n)) * c
    return Candles("X", bar, np.arange(n, dtype=np.int64) * BAR_MS[bar],
                   o, np.maximum(o, c) + wig, np.minimum(o, c) - wig, c,
                   np.abs(rng.normal(1000, 300, n)))


class _Store:
    def __init__(self, d):
        self.d = d

    def load(self, inst, bar):
        return self.d[(inst, bar)]


def _book(kind, seed, n=2400, fee=7.0):
    rng = np.random.default_rng(seed)
    d = {(i, b): _series(rng, n, b, kind) for i in ASSETS for b in BARS}
    hb = HorizonBook(fee_rt_bps=fee, log=lambda m: None)
    hb.fit_store(_Store(d))
    return hb


# --- the split ---------------------------------------------------------- #

def test_holdout_trades_never_overlap():
    """Two labels that share a bar are one observation counted twice."""
    lr = ScalpLearner(horizon=16)
    gi = np.repeat([0, 1], 200)
    gb = np.tile(np.arange(200) * 3, 2)          # samples 3 bars apart
    _, hold = lr._time_split(gi, gb)
    assert len(hold) > 0
    for inst_id in (0, 1):
        bars = sorted(int(gb[j]) for j in hold if gi[j] == inst_id)
        gaps = np.diff(bars)
        assert (gaps >= lr.horizon).all(), f"chevauchement : {gaps.min()} < {lr.horizon}"


def test_training_labels_do_not_reach_across_the_boundary():
    lr = ScalpLearner(horizon=16)
    gi = np.zeros(300, dtype=int)
    gb = np.arange(300) * 3
    train, hold = lr._time_split(gi, gb)
    boundary = min(int(gb[j]) for j in hold)
    assert train.size and hold.size
    assert max(int(gb[j]) + lr.horizon for j in train) < boundary


def test_the_split_is_by_time_not_by_array_position():
    """Concatenating instruments and cutting at 80% of the array put whole
    assets in the holdout instead of later time. Every instrument has to be
    represented on both sides."""
    lr = ScalpLearner(horizon=8)
    gi = np.repeat([0, 1, 2], 150)
    gb = np.tile(np.arange(150) * 3, 3)
    train, hold = lr._time_split(gi, gb)
    assert set(gi[train]) == {0, 1, 2}
    assert set(gi[hold]) == {0, 1, 2}


def test_a_thin_instrument_is_dropped_not_guessed():
    lr = ScalpLearner(horizon=16)
    gi = np.zeros(8, dtype=int)
    gb = np.arange(8) * 3
    train, hold = lr._time_split(gi, gb)
    assert train.size == 0 and hold.size == 0


# --- the bar ------------------------------------------------------------ #

def test_searching_more_arms_raises_the_bar():
    from hermes.backtest.metrics import expected_max_sharpe
    assert expected_max_sharpe(18, 63) > expected_max_sharpe(3, 63) > 0


def test_the_bar_is_recorded_with_the_verdict():
    """Whoever reads the state must be able to see what was cleared."""
    hb = _book("noise", 11)
    for _, lr in hb.best.values():
        d = lr.to_dict()
        assert {"sel_bar", "holdout_sr", "n_holdout", "n_trials"} <= set(d)
        assert d["n_trials"] >= len(BARS)


# --- size and power ----------------------------------------------------- #

@pytest.mark.parametrize("seed", [11, 12, 13])
def test_random_walks_put_nothing_live(seed):
    hb = _book("noise", seed)
    live = {i: lr.policy for i, (_, lr) in hb.best.items() if lr.status == "live"}
    assert not live, f"faux positif sur bruit pur : {live}"


def test_a_planted_mean_reversion_is_found_and_correctly_signed():
    """Size without power is a switch that is always off."""
    found = []
    for seed in (21, 22, 23, 24):
        hb = _book("revert", seed, n=4000)
        found += [lr.policy for _, lr in hb.best.values() if lr.status == "live"]
    assert found, "aucune arête plantée détectée — le filtre est aveugle"
    assert all(p == "fade" for p in found), found


def test_a_planted_trend_is_never_traded_backwards():
    found = []
    for seed in (31, 32, 33, 34):
        hb = _book("trend", seed, n=4000)
        found += [lr.policy for _, lr in hb.best.values() if lr.status == "live"]
    assert found, "aucune tendance plantée détectée"
    assert all(p in ("follow", "breakout") for p in found), found


# --- the ridge is a modulation, not a licence --------------------------- #

def test_an_uninformative_ridge_silences_itself_without_vetoing():
    """A policy that cleared the bar keeps trading; the ridge just gets no
    weight when its holdout IC sits inside its own noise floor."""
    lr = ScalpLearner(horizon=8)
    lr.ic_bar = 2.0 / math.sqrt(63)
    assert lr.ic_bar > 0.02, "le seuil de 0,02 était du bruit à n=63"


def test_the_ic_floor_shrinks_as_evidence_accumulates():
    assert 2.0 / math.sqrt(1000) < 2.0 / math.sqrt(63)
