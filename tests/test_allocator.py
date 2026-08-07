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
