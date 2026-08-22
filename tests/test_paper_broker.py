import pytest

from hermes.exchange.broker import PaperBroker


def test_buy_sell_roundtrip_costs_only():
    b = PaperBroker(cash=10000.0, fee_bps=5.0, slippage_bps=0.0)
    b.mark_prices({"X": 100.0})
    b.market_order("X", 10.0, 100.0, force_taker=True)
    assert b.positions()["X"] == pytest.approx(10.0)
    assert b.equity() == pytest.approx(10000.0 - 1000 * 0.0005)
    b.market_order("X", -10.0, 100.0, force_taker=True)
    assert b.positions() == {}
    assert b.equity() == pytest.approx(10000.0 - 2 * 1000 * 0.0005)


def test_mark_to_market():
    b = PaperBroker(cash=10000.0, fee_bps=0.0, slippage_bps=0.0)
    b.mark_prices({"X": 100.0})
    b.market_order("X", 10.0, 100.0, force_taker=True)
    b.mark_prices({"X": 110.0})
    assert b.equity() == pytest.approx(10100.0)


def test_short_position_pnl():
    b = PaperBroker(cash=10000.0, fee_bps=0.0, slippage_bps=0.0)
    b.mark_prices({"X": 100.0})
    b.market_order("X", -5.0, 100.0, force_taker=True)
    b.mark_prices({"X": 80.0})
    assert b.equity() == pytest.approx(10100.0)


def test_slippage_hurts_both_sides():
    b = PaperBroker(cash=10000.0, fee_bps=0.0, slippage_bps=10.0)
    b.mark_prices({"X": 100.0})
    b.market_order("X", 10.0, 100.0, force_taker=True)   # pays 100.1
    b.market_order("X", -10.0, 100.0, force_taker=True)  # receives 99.9
    assert b.equity() == pytest.approx(10000.0 - 10 * 0.2)


def test_funding_application():
    b = PaperBroker(cash=10000.0, fee_bps=0.0, slippage_bps=0.0)
    b.mark_prices({"X": 100.0})
    b.market_order("X", 10.0, 100.0, force_taker=True)
    b.apply_funding("X", 0.001)  # long pays
    assert b.equity() == pytest.approx(10000.0 - 1.0)
