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


def test_autocorr_inflation_detects_held_positions():
    """Returns that repeat in blocks — an hourly signal driving 15m bars, or a
    position held for hours — carry far fewer independent observations than
    their bar count suggests."""
    rng = np.random.default_rng(11)
    iid = rng.normal(0.0002, 0.002, 4000)
    blocked = np.repeat(rng.normal(0.0002, 0.002, 1000), 4)
    assert metrics.autocorr_inflation(iid) < 1.3
    assert metrics.autocorr_inflation(blocked) > 2.0
    assert metrics.effective_obs(blocked) < 0.6 * len(blocked)


def test_autocorr_inflation_never_flatters():
    """Negative autocorrelation must not be paid out as a bonus: the gate may
    only ever be made stricter by this correction."""
    rng = np.random.default_rng(12)
    e = rng.normal(0.0, 0.002, 3001)
    mean_reverting = e[1:] - 0.8 * e[:-1] + 0.0002   # MA(1), rho_1 ~ -0.49
    assert metrics.autocorr_inflation(mean_reverting) == 1.0
    # and the haircut is then a no-op rather than a bonus
    assert metrics.sharpe_hac(mean_reverting, 8760) == pytest.approx(
        metrics.sharpe(mean_reverting, 8760))


def test_hac_sharpe_haircuts_serial_correlation():
    rng = np.random.default_rng(13)
    blocked = np.repeat(rng.normal(0.0004, 0.002, 500), 4)
    raw = metrics.sharpe(blocked, 8760)
    adj = metrics.sharpe_hac(blocked, 8760)
    assert 0 < adj < raw * 0.8


def test_dsr_is_harsher_under_serial_correlation():
    """Two series with the same iid Sharpe: the serially correlated one rests
    on a smaller effective sample and must clear a higher selection bar."""
    rng = np.random.default_rng(14)
    blocked = np.repeat(rng.normal(0.0004, 0.002, 500), 4)
    iid = rng.normal(0.0, 1.0, len(blocked))
    iid = (iid - iid.mean()) / iid.std()
    iid = iid * blocked.std() + blocked.mean()      # matched mean and sd
    assert metrics.sharpe(iid, 8760) == pytest.approx(
        metrics.sharpe(blocked, 8760), rel=0.05)
    assert metrics.deflated_sharpe(blocked, 500, 8760) < \
        metrics.deflated_sharpe(iid, 500, 8760)


def test_norm_ppf_roundtrip():
    for p in (0.01, 0.1, 0.5, 0.9, 0.99):
        assert metrics.norm_cdf(metrics.norm_ppf(p)) == pytest.approx(p, abs=1e-6)


def test_backtest_reports_what_frictions_took():
    """Net Sharpe alone cannot tell a weak model from an over-traded one. The
    gross figure and the cost drag have to be visible, because a strategy
    whose edge is real but whose turnover eats it is a frequency problem that
    no better predictor fixes."""
    candles = make_candles(list(100.0 + np.arange(400) * 0.05))
    pos = np.where(np.arange(400) % 2 == 0, 1.0, -1.0)   # deliberately churny
    res = engine.run(candles, pos, fee_bps=5.0, slippage_bps=2.0)
    s = res.stats
    assert s["gross_sharpe"] > s["sharpe"]               # costs only subtract
    assert s["cost_drag_annual"] > 0
    assert s["cost_share_of_gross"] > 0
    # flipping every bar must show a far heavier drag than holding through
    calm = engine.run(candles, np.ones(400), fee_bps=5.0, slippage_bps=2.0)
    assert s["cost_drag_annual"] > 10 * calm.stats["cost_drag_annual"]


def test_dsr_is_a_confidence_level_that_grows_with_the_sample():
    """The deflated Sharpe is a probability, and its job is to stay low until
    the sample can support the claim. Holding the edge fixed and lengthening
    the record must raise it, while the Sharpe itself barely moves — that is
    the whole difference between "this looks good" and "this is established".

    The gate was set to 0.05, which admits anything 95% likely to be the
    luckiest draw of its own search. This is what the number does when it is
    read as intended.
    """
    from hermes.backtest.metrics import deflated_sharpe

    bpy = 8760
    got = []
    for n in (1500, 6000, 24000):
        rng = np.random.default_rng(7)
        # identical per-bar edge at every length: ~4.7 annualised Sharpe,
        # the size of edge these families actually produce
        r = rng.normal(0.00005, 0.001, n)
        got.append(deflated_sharpe(r, n_trials=2400, bars_per_year=bpy))
    assert got[0] < got[1] < got[2], got
    assert got[0] < 0.5 < got[2], got


def test_selection_bar_rises_with_the_number_of_trials():
    """Searching harder raises the Sharpe that selection alone produces. The
    bar is reported in Sharpe units so the gap is readable without decoding a
    probability."""
    from hermes.backtest.metrics import selection_bar

    rng = np.random.default_rng(3)
    r = rng.normal(0.0002, 0.001, 8000)
    bars = [selection_bar(r, n, 8760) for n in (100, 2400, 83793)]
    assert bars[0] < bars[1] < bars[2], bars
    assert bars[0] > 0.0


def test_more_search_raises_the_bar_it_must_then_clear():
    """The reason a bigger hunt is not more power. Selection over n trials
    lifts the Sharpe reachable on noise alone, so every extra genome the
    search evaluates is charged back to whatever it finds."""
    import math

    from hermes.backtest.metrics import expected_max_sharpe

    bpy, n_oos = 35040, 21000
    bars = {n: expected_max_sharpe(n, n_oos) * math.sqrt(bpy)
            for n in (26, 624, 2400, 10000)}
    assert bars[26] < bars[624] < bars[2400] < bars[10000]
    # the panel grid's bar sits below the pooled edge measured in test_panel,
    # while a per-instrument hunt's sits above any single-name edge
    assert bars[26] < 3.0 < bars[624]
    # and quadrupling the budget buys well under a Sharpe point of bar
    assert bars[2400] - bars[624] < 1.0
