import pytest

from hermes.risk import RiskEngine

DAY = 86400.0


def make_engine(**kw):
    defaults = dict(max_gross_leverage=2.0, max_instrument_leverage=1.0,
                    daily_loss_limit_pct=3.0, max_drawdown_pct=15.0,
                    min_trade_notional=10.0, max_order_notional=1000.0)
    defaults.update(kw)
    return RiskEngine(**defaults)


def test_clamp_per_instrument_and_gross():
    e = make_engine()
    out = e.clamp_targets({"A": 3.0, "B": -2.0, "C": 0.5})
    # per-instrument cap applied first (|exp| <= 1), then gross scaled to <= 2
    assert all(abs(v) <= 1.0 + 1e-9 for v in out.values())
    gross = sum(abs(v) for v in out.values())
    assert gross == pytest.approx(2.0)
    # proportions preserved by the gross rescale: A and B both capped at 1
    assert out["A"] == pytest.approx(-out["B"])
    assert out["C"] == pytest.approx(0.5 * out["A"])


def test_daily_loss_halt_resets_next_day():
    e = make_engine()
    e.update_equity(1000.0, 0.0)
    assert e.trading_allowed
    e.update_equity(960.0, 1000.0)  # -4% same day
    assert not e.trading_allowed and e.must_flatten
    assert not e.state.killed
    e.update_equity(960.0, DAY + 1000.0)  # next UTC day
    assert e.trading_allowed


def test_kill_switch_on_drawdown_persists():
    e = make_engine()
    e.update_equity(1000.0, 0.0)
    e.update_equity(1100.0, DAY * 1)
    e.update_equity(920.0, DAY * 2)  # -16.4% from peak
    assert e.state.killed and not e.trading_allowed
    # next day does NOT clear a kill
    e.update_equity(1500.0, DAY * 3)
    assert e.state.killed
    e.reset_kill()
    assert e.trading_allowed


def test_order_notional_checks():
    e = make_engine()
    assert e.check_order(5.0)[0] is False
    assert e.check_order(100.0)[0] is True
    assert e.check_order(5000.0)[0] is False


def test_state_roundtrip(tmp_path):
    path = str(tmp_path / "risk.json")
    e = make_engine(state_path=path)
    e.update_equity(1000.0, 0.0)
    e.update_equity(800.0, DAY)  # kill
    assert e.state.killed
    e2 = make_engine(state_path=path)
    e2.load()
    assert e2.state.killed  # restart must not reset the kill switch


# ---------------- leverage governor ----------------

from hermes.risk import LeverageGovernor


def test_governor_boost_must_be_earned_slowly():
    """Above-1x exposure only after a real track record: steady gains with
    high live Sharpe ramp the multiplier up slowly, capped at max_boost."""
    g = LeverageGovernor(min_track=50, window=200)
    eq = 10000.0
    mult = 1.0
    for i in range(49):
        eq *= 1.0003
        mult = g.update(eq, eq)
    assert mult == 1.0                     # not earned yet (short track)
    for i in range(60):
        eq *= 1.0003
        mult = g.update(eq, eq)
    assert 1.0 < mult <= g.max_boost       # earned, ramping
    for i in range(300):
        eq *= 1.0003
        mult = g.update(eq, eq)
    assert mult == g.max_boost             # capped


def test_governor_derisks_fast_in_drawdown():
    """Drawdown cuts exposure regardless of any earned boost, down to the
    floor before the kill switch would trigger."""
    g = LeverageGovernor()
    peak = 10000.0
    m_small = g.update(peak * 0.97, peak)   # 3% dd: inside tolerance
    assert m_small == 1.0
    m_mid = g.update(peak * 0.92, peak)     # 8% dd: partially de-risked
    assert g.floor < m_mid < 1.0
    m_deep = g.update(peak * 0.86, peak)    # 14% dd: at the floor
    assert m_deep == g.floor


def test_governor_boost_decays_faster_than_it_builds():
    g = LeverageGovernor(min_track=10, window=100)
    eq = 10000.0
    for _ in range(120):
        eq *= 1.0004
        g.update(eq, eq)
    assert g.boost > 1.1
    built = g.boost
    ups = round((built - 1.0) / g.step_up)
    downs = 0
    while g.boost > 1.0 and downs < 10000:
        g.update(eq, eq * 1.05)             # 5%+ dd: conditions fail
        downs += 1
    assert downs < ups / 2                  # decay at least 2x faster


def test_governor_state_roundtrip():
    g = LeverageGovernor()
    eq = 10000.0
    for _ in range(30):
        eq *= 1.0002
        g.update(eq, eq)
    d = g.to_dict()
    g2 = LeverageGovernor()
    g2.from_dict(d)
    assert g2.boost == g.boost
    assert g2.equity_hist == g.equity_hist
    assert g2.last_mult == g.last_mult


def test_an_exit_is_exempt_from_the_minimum_notional_floor():
    """The floor stops the book churning on rebalances too small to be worth
    their fees. Applied to an exit it does the opposite: a position below the
    floor can never be closed, because every order that would close it is
    smaller than the floor."""
    from hermes.risk import RiskEngine

    r = RiskEngine(max_gross_leverage=2.0, max_instrument_leverage=1.0,
                   daily_loss_limit_pct=3.0, max_drawdown_pct=15.0,
                   min_trade_notional=10.0, max_order_notional=25_000.0)
    assert r.check_order(4.15)[0] is False          # entering: still noise
    assert r.check_order(4.15, closing=True)[0] is True
    # the upper cap still binds either way
    assert r.check_order(30_000.0, closing=True)[0] is False
