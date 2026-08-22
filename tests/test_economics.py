"""Bracket economics: what a take/stop pair is worth before it is armed.

The shipped engine armed a 10bps take against a 15bps stop and a 7bps round
trip. These tests pin down what that costs, and that the chooser refuses it.
"""

import math

import numpy as np
import pytest

from hermes.scalp.economics import (bracket_ev, choose_bracket, viable_horizon,
                                    win_rate)


def test_zero_edge_loses_exactly_the_round_trip():
    """With no forecast, any bracket returns minus the cost. This is the
    theorem the shipped defaults were quietly failing."""
    for tp, sl in ((10, 15), (15, 10), (20, 20), (6, 30)):
        ev = bracket_ev(tp, sl, edge_bps=0.0, vol_bps=9.0, horizon=16,
                        cost_bps=7.0)
        assert ev == pytest.approx(-7.0, abs=0.4), (tp, sl, ev)


def test_the_shipped_bracket_is_rejected():
    """10bps take / 15bps stop on a forecast below the round trip."""
    assert choose_bracket(edge_bps=5.0, vol_bps=9.0, horizon=16,
                          cost_bps=7.0) is None


def test_a_take_below_the_round_trip_is_never_chosen():
    """The volatility floors could arm a 6bps take against a 7bps cost."""
    for edge in (8.0, 12.0, 20.0, 40.0):
        got = choose_bracket(edge, vol_bps=9.0, horizon=16, cost_bps=7.0)
        if got is not None:
            assert got[0] > 7.0, (edge, got)


def test_a_real_forecast_gets_a_positive_bracket():
    got = choose_bracket(edge_bps=30.0, vol_bps=9.0, horizon=16, cost_bps=7.0)
    assert got is not None
    tp, sl, ev = got
    assert tp > 7.0 and sl > 0 and ev > 0


def test_expected_value_rises_with_the_forecast():
    evs = []
    for edge in (10.0, 20.0, 40.0, 80.0):
        got = choose_bracket(edge, vol_bps=9.0, horizon=16, cost_bps=7.0)
        evs.append(0.0 if got is None else got[2])
    assert evs == sorted(evs), evs


def test_higher_costs_shrink_what_is_tradable():
    cheap = choose_bracket(12.0, vol_bps=9.0, horizon=16, cost_bps=2.0)
    dear = choose_bracket(12.0, vol_bps=9.0, horizon=16, cost_bps=11.0)
    assert cheap is not None
    assert dear is None or dear[2] < cheap[2]


def test_the_chooser_is_deterministic():
    """Same forecast, same bracket — paths are shared and seeded."""
    a = choose_bracket(25.0, 9.0, 16, 7.0)
    b = choose_bracket(25.0, 9.0, 16, 7.0)
    assert a == b


def test_ev_matches_an_independent_simulation():
    """The chooser's own path set could flatter it. Score the same bracket
    on freshly drawn paths and require agreement."""
    tp, sl, edge, vol, h, cost = 20.0, 18.0, 25.0, 9.0, 12, 7.0
    model = bracket_ev(tp, sl, edge, vol, h, cost)

    g = np.random.default_rng(99)
    sub = 16                       # finer than the module: an honest referee
    m = h * sub
    steps = (g.standard_normal((200_000, m)) * (vol / math.sqrt(sub))
             + edge / m).cumsum(axis=1)
    up, dn = steps >= tp, steps <= -sl
    t_up = np.where(up.any(axis=1), up.argmax(axis=1), m + 1)
    t_dn = np.where(dn.any(axis=1), dn.argmax(axis=1), m + 1)
    pnl = np.where(t_up < t_dn, tp, np.where(t_dn < t_up, -sl, steps[:, -1]))
    truth = float(pnl.mean() - cost)
    assert model == pytest.approx(truth, abs=0.7), (model, truth)


def test_win_rate_is_reported_after_costs():
    """A tight take flatters the raw hit rate; after costs it should not."""
    edge, vol, h, cost = 0.0, 9.0, 16, 7.0
    gross = win_rate(6.0, 30.0, edge, vol, h, cost_bps=0.0)
    net = win_rate(6.0, 30.0, edge, vol, h, cost_bps=cost)
    assert gross > net
    assert net < 0.5


def test_viable_horizon_matches_the_closed_form():
    assert viable_horizon(7.0, 0.05, 9.0) == math.ceil((7.0 / (0.05 * 9.0)) ** 2)


def test_one_minute_is_not_viable_at_realistic_skill():
    """9bps bar, 7bps round trip: a 1m book needs skill it cannot have."""
    for ic in (0.02, 0.05, 0.10):
        assert viable_horizon(7.0, ic, 9.0) > 1


def test_zero_skill_never_becomes_viable():
    assert viable_horizon(7.0, 0.0, 9.0) > 10 ** 6


def test_discrete_monitoring_is_corrected():
    """Without the continuity correction a 6/30 pair scored -9.9bps where the
    theorem says -7.0. Every geometry must now land on the theorem."""
    for tp, sl in ((10, 15), (6, 30), (30, 6), (20, 20), (8, 8)):
        ev = bracket_ev(tp, sl, 0.0, 9.0, 16, 7.0)
        assert abs(ev + 7.0) < 0.4, (tp, sl, ev)
