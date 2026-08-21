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
        "AAA-USDT-SWAP": {"vol_usd": 5e7, "spread_bps": 3.0},
        "BBB-USDT-SWAP": {"vol_usd": 1e6, "spread_bps": 2.0},
    }
    u = select_universe(ticks, n=50, max_spread_bps=8.0, min_vol_usd=20e6)
    assert u[0] == "BTC-USDT-SWAP"
    assert "SOL-USDT-SWAP" in u and "AAA-USDT-SWAP" in u
    assert "PEPE-USDT-SWAP" not in u
    assert "BBB-USDT-SWAP" not in u
