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
