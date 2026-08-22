"""1m order-flow scalp: fade bounce, cost gate, no lookahead."""

import numpy as np

from hermes.data.synthetic import generate
from hermes.exchange.broker import PaperBroker
from hermes.risk import RiskEngine
from hermes.scalp import features as F
from hermes.scalp import model as M
from hermes.scalp.engine import ScalpEngine


def test_fade_last_bar():
    """A sharp 1m up-print with empty book should not be a long."""
    feat = {"r1": 0.004, "r3": 0.004, "r12": 0.0, "r60": 0.0,
            "vol": 0.0008, "imb": 0.0, "book": 0.0, "micro": 0.0, "px": 100.0}
    p = M.predict(feat, btc_r1=0.0, is_btc=True, horizon=3)
    assert p["p_up"] < 0.5
    assert p["edge_bps"] < 0


def test_book_imbalance_is_long_tilt():
    feat = {"r1": 0.0, "r3": 0.0, "r12": 0.0, "r60": 0.0,
            "vol": 0.0008, "imb": 0.0, "book": 0.8, "micro": 0.0003, "px": 100.0}
    p = M.predict(feat, btc_r1=0.0, is_btc=True, horizon=3)
    assert p["p_up"] > 0.5


def test_cost_gate_flattens_tiny_edge(tmp_path):
    class Quiet:
        def last_trades(self, *a, **k): return []
        def books(self, *a, **k): return {"bids": [["100", "1"]], "asks": [["100.1", "1"]]}

    cfg = {"scalp": {"instruments": ["BTC-USDT-SWAP"], "min_edge_bps": 50.0,
                     "horizon": 3, "max_hold_bars": 6, "max_name_lev": 0.3,
                     "gross_cap": 0.9},
           "costs": {"taker_fee_bps": 5, "maker_fee_bps": 2, "slippage_bps": 2}}
    broker = PaperBroker(cash=10_000, fee_bps=2, slippage_bps=1)
    risk = RiskEngine(daily_loss_limit_pct=50, max_drawdown_pct=90)
    eng = ScalpEngine(cfg, broker, Quiet(), risk, log=lambda m: None,
                      state_dir=str(tmp_path))
    c = generate(inst="BTC-USDT-SWAP", bar="1m", n=400, seed=3)
    broker.mark_prices({c.inst: float(c.c[-1])})
    rep = eng.tick({c.inst: c})
    assert all(p["dir"] == "flat" for p in rep["preds"])
    assert broker.positions() == {}


def test_candle_feats_causal():
    a = generate(inst="BTC-USDT-SWAP", bar="1m", n=300, seed=1)
    b = generate(inst="BTC-USDT-SWAP", bar="1m", n=300, seed=1)
    b.c[-1] *= 1.05
    fa, fb = F.candle_feats(a.slice(0, 250)), F.candle_feats(b.slice(0, 250))
    for k in ("r1", "r3", "r12", "vol"):
        assert abs(fa[k] - fb[k]) < 1e-12


def test_trade_imbalance():
    now = 1_000_000
    trades = [
        {"ts": now - 1000, "px": "10", "sz": "2", "side": "buy"},
        {"ts": now - 1000, "px": "10", "sz": "1", "side": "sell"},
        {"ts": now - 90_000, "px": "10", "sz": "99", "side": "sell"},  # too old
    ]
    assert abs(F.trade_imbalance(trades, now) - (20 - 10) / 30) < 1e-9


def test_universe_top_volume_drops_wide_spread():
    from hermes.scalp.universe import select_universe
    ticks = {
        "BTC-USDT-SWAP": {"vol_usd": 9e9, "spread_bps": 1.0},
        "ETH-USDT-SWAP": {"vol_usd": 4e9, "spread_bps": 1.2},
        "PEPE-USDT-SWAP": {"vol_usd": 8e8, "spread_bps": 25.0},
        "SOL-USDT-SWAP": {"vol_usd": 1e9, "spread_bps": 2.0},
        "APT-USDT-SWAP": {"vol_usd": 5e7, "spread_bps": 3.0},
        "BBB-USDT-SWAP": {"vol_usd": 1e6, "spread_bps": 2.0},
    }
    u = select_universe(ticks, n=50, max_spread_bps=8.0, min_vol_usd=20e6)
    assert u[0] == "BTC-USDT-SWAP"
    assert "SOL-USDT-SWAP" in u and "APT-USDT-SWAP" in u
    assert "PEPE-USDT-SWAP" not in u
    assert "BBB-USDT-SWAP" not in u


import pytest


def test_paper_buy_fills_at_ask_not_last():
    from hermes.exchange.broker import PaperBroker
    b = PaperBroker(cash=10_000, fee_bps=5.0, slippage_bps=2.0)
    b.mark_ticks({"X": {"last": 100.0, "bid": 99.9, "ask": 100.2}})
    fill = b.market_order("X", 1.0, 100.0, force_taker=True)
    assert fill is not None
    assert fill.price == pytest.approx(100.2)
    assert fill.fee == pytest.approx(100.2 * 5e-4)


def test_paper_sell_fills_at_bid():
    from hermes.exchange.broker import PaperBroker
    b = PaperBroker(cash=10_000, fee_bps=5.0)
    b.mark_ticks({"X": {"last": 100.0, "bid": 99.8, "ask": 100.1}})
    b.pos["X"] = 1.0
    b.prices["X"] = 100.0
    fill = b.market_order("X", -1.0, 100.0, force_taker=True)
    assert fill.price == pytest.approx(99.8)


def test_paper_maker_buy_joins_bid():
    from hermes.exchange.broker import PaperBroker
    b = PaperBroker(cash=10_000, fee_bps=5.0, maker_fee_bps=2.0)
    b.mark_ticks({"X": {"last": 100.0, "bid": 99.9, "ask": 100.1}})
    fill = b.market_order("X", 1.0, 100.0, force_taker=False)
    assert fill.price == pytest.approx(99.9 + 0.25 * 0.2)
    assert fill.fee == pytest.approx(fill.price * 2e-4)


def test_paper_lot_rounding():
    from hermes.exchange.broker import PaperBroker
    b = PaperBroker(cash=10_000, fee_bps=5.0)
    b.set_specs({"X": {"ctVal": 0.1, "lotSz": 1, "minSz": 1}})
    b.mark_ticks({"X": {"last": 100, "bid": 100, "ask": 100}})
    fill = b.market_order("X", 0.15, 100.0)
    assert fill is not None
    assert fill.qty == pytest.approx(0.1)


def test_sl_stops_long(tmp_path):
    from hermes.exchange.broker import PaperBroker, Fill
    from hermes.risk import RiskEngine
    from hermes.scalp.engine import ScalpEngine
    b = PaperBroker(cash=10_000, fee_bps=5.0)
    b.pos["BTC-USDT-SWAP"] = 0.01
    b.prices["BTC-USDT-SWAP"] = 100.0
    b.entry["BTC-USDT-SWAP"] = 100.0
    b.mark_ticks({"BTC-USDT-SWAP": {"last": 99.7, "bid": 99.6, "ask": 99.8}})
    risk = RiskEngine(daily_loss_limit_pct=50, max_drawdown_pct=90)
    eng = ScalpEngine({"scalp": {"instruments": ["BTC-USDT-SWAP"], "stop_bps": 15,
                                 "take_bps": 10}, "costs": {"taker_fee_bps": 5}},
                      b, None, risk, log=lambda m: None, state_dir=str(tmp_path))
    fill = Fill("BTC-USDT-SWAP", "buy", 0.01, 100.0, 0.0, 0.0)
    eng._arm("BTC-USDT-SWAP", 0.01, fill, vol_bps=5.0)
    hit = eng.check_exits()
    assert "BTC-USDT-SWAP" in hit
    assert "BTC-USDT-SWAP" not in b.positions()


def test_tp_takes_long(tmp_path):
    from hermes.exchange.broker import PaperBroker, Fill
    from hermes.risk import RiskEngine
    from hermes.scalp.engine import ScalpEngine
    b = PaperBroker(cash=10_000, fee_bps=5.0)
    b.pos["BTC-USDT-SWAP"] = 0.01
    b.prices["BTC-USDT-SWAP"] = 100.2
    b.mark_ticks({"BTC-USDT-SWAP": {"last": 100.2, "bid": 100.15, "ask": 100.25}})
    risk = RiskEngine(daily_loss_limit_pct=50, max_drawdown_pct=90)
    eng = ScalpEngine({"scalp": {"instruments": ["BTC-USDT-SWAP"], "stop_bps": 15,
                                 "take_bps": 10}, "costs": {"taker_fee_bps": 5}},
                      b, None, risk, log=lambda m: None, state_dir=str(tmp_path))
    fill = Fill("BTC-USDT-SWAP", "buy", 0.01, 100.0, 0.0, 0.0)
    eng._arm("BTC-USDT-SWAP", 0.01, fill, vol_bps=1.0)
    hit = eng.check_exits()
    assert "BTC-USDT-SWAP" in hit


def test_book_l2_bid_heavy():
    book = {
        "bids": [["100.0", "20"], ["99.95", "15"], ["99.9", "10"]],
        "asks": [["100.05", "2"], ["100.10", "3"], ["100.15", "4"]],
    }
    f = F.book_l2(book, 100.02)
    assert f["imb5"] > 0.4
    assert f["imb1"] > 0.5
    assert f["spread_bps"] > 0
    assert f["depth_imb"] > 0


def test_ingest_l2_overrides_ticker(tmp_path):
    class Quiet:
        def last_trades(self, *a, **k): return []
        def books(self, *a, **k): return {"bids": [], "asks": []}
    b = PaperBroker(cash=10_000)
    risk = RiskEngine(daily_loss_limit_pct=50, max_drawdown_pct=90)
    eng = ScalpEngine({"scalp": {"instruments": ["BTC-USDT-SWAP"]},
                       "costs": {"taker_fee_bps": 5}},
                      b, Quiet(), risk, log=lambda m: None, state_dir=str(tmp_path))
    eng.ticks = {"BTC-USDT-SWAP": {"last": 100.0, "bid": 99.9, "ask": 100.1,
                                   "bid_sz": 1, "ask_sz": 1}}
    eng.ingest_book("BTC-USDT-SWAP", {
        "bids": [["99.98", "50"], ["99.97", "40"]],
        "asks": [["100.02", "1"], ["100.03", "1"]],
    })
    m = eng._micro("BTC-USDT-SWAP", 100.0)
    assert m["l2"] == 1.0
    assert m["book"] > 0.5


def test_no_l2_means_flat(tmp_path):
    class Quiet:
        def last_trades(self, *a, **k): return []
        def books(self, *a, **k): return {"bids": [], "asks": []}
    b = PaperBroker(cash=10_000)
    risk = RiskEngine(daily_loss_limit_pct=50, max_drawdown_pct=90)
    eng = ScalpEngine({"scalp": {"instruments": ["BTC-USDT-SWAP"], "require_l2": True,
                                 "min_edge_bps": 1.0},
                       "costs": {"taker_fee_bps": 5}},
                      b, Quiet(), risk, log=lambda m: None, state_dir=str(tmp_path))
    c = generate(inst="BTC-USDT-SWAP", bar="1m", n=400, seed=3)
    b.mark_prices({c.inst: float(c.c[-1])})
    rep = eng.tick({c.inst: c})
    assert all(p["dir"] == "flat" for p in rep["preds"])
    ok = ("no L2", "ml-veto", "cost", "incoherent", "veto", "unfitted",
          "disagree", "few-samples", "wait")
    assert all(p.get("reason") in ok for p in rep["preds"]), [p.get("reason") for p in rep["preds"]]


def test_trade_top_caps_book(tmp_path):
    b = PaperBroker(cash=10_000)
    risk = RiskEngine(daily_loss_limit_pct=50, max_drawdown_pct=90)
    eng = ScalpEngine({"scalp": {"trade_top": 8, "max_name_lev": 0.2, "gross_cap": 1.0},
                       "costs": {"taker_fee_bps": 5}},
                      b, None, risk, log=lambda m: None, state_dir=str(tmp_path))
    preds = [{"inst": f"C{i}-USDT-SWAP", "dir": "long", "edge_bps": 40 - i}
             for i in range(20)]
    t = eng._targets(preds)
    live = [k for k, v in t.items() if abs(v) > 1e-9]
    assert len(live) == 8


def test_close_at_high_fades():
    """Close glued to the high of the bar → short tilt (exhaustion)."""
    base = {"r1": 0.0, "r3": 0.0, "r12": 0.0, "vol": 0.0008, "px": 100.0,
            "imb": 0.0, "book": 0.0, "micro": 0.0}
    up = dict(base, loc=0.5)
    dn = dict(base, loc=-0.5)
    assert M.predict(up, 0.0, True)["p_up"] < M.predict(dn, 0.0, True)["p_up"]


def test_ofi_bid_improve_is_long():
    prev = {"bids": [["100.0", "5"]], "asks": [["100.1", "5"]]}
    now = {"bids": [["100.0", "20"]], "asks": [["100.1", "5"]]}
    assert F.ofi_l1(prev, now) > 0


def test_idio_fade_vs_btc():
    feat = {"r1": 0.006, "r3": 0.0, "r12": 0.0, "vol": 0.0008, "px": 10.0,
            "imb": 0.0, "book": 0.0, "micro": 0.0}
    p = M.predict(feat, btc_r1=0.0, is_btc=False, horizon=3)
    assert p["edge_bps"] < 0  # alt jumped alone → fade


def test_leverage_tapers_into_drawdown(tmp_path):
    b = PaperBroker(cash=10_000)
    risk = RiskEngine(daily_loss_limit_pct=8, max_drawdown_pct=25)
    risk.update_equity(10_000, 0)
    eng = ScalpEngine({"scalp": {"max_name_lev": 20, "gross_cap": 20},
                       "costs": {"taker_fee_bps": 5}},
                      b, None, risk, log=lambda m: None, state_dir=str(tmp_path))
    p = {"dir": "long", "edge_bps": 20, "sl_bps": 15, "inst": "BTC-USDT-SWAP"}
    full = eng._pick_lev(p)
    assert 10 <= full <= 20
    risk.update_equity(7_800, 10)  # -22% of peak, near 25% kill
    cut = eng._pick_lev(p)
    assert cut <= full
    assert cut >= 2

