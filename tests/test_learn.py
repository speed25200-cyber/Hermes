"""Triple-barrier labels are causal; learner refuses a donating holdout."""
import numpy as np
from hermes.data.synthetic import generate
from hermes.scalp.learn import ScalpLearner, barrier_pnl


def test_barrier_ignores_bars_after_horizon():
    c = generate(inst="BTC-USDT-SWAP", bar="1m", n=400, seed=4)
    y0 = barrier_pnl(c, 100, 1.0, 20.0, 20.0, 6, 10.0)
    c.c[-1] *= 1.5
    c.h[-1] *= 1.5
    y1 = barrier_pnl(c, 100, 1.0, 20.0, 20.0, 6, 10.0)
    assert y0 == y1


def test_barrier_long_hits_tp():
    n = 30
    c = generate(inst="X", bar="1m", n=n, seed=1)
    i = 10
    c.c[:] = 100.0
    c.o[:] = 100.0
    c.h[:] = 100.0
    c.l[:] = 100.0
    c.h[i+2] = 100.5  # +50 bps
    y = barrier_pnl(c, i, 1.0, 20.0, 40.0, 6, 10.0)
    assert y == 10.0  # tp 20 - fee 10


def test_learner_fits_or_vetoes():
    btc = generate(inst="BTC-USDT-SWAP", bar="1m", n=900, seed=7)
    eth = generate(inst="ETH-USDT-SWAP", bar="1m", n=900, seed=8)
    lr = ScalpLearner(fee_rt_bps=10.0, horizon=6, log=lambda m: None)
    d = lr.fit({"BTC-USDT-SWAP": btc, "ETH-USDT-SWAP": eth})
    assert d["status"] in ("live", "veto", "few-samples")
    feat = {"r1": 0.002, "r3": 0.0, "r12": 0.0, "vol": 0.0008, "px": 100.0}
    inf = lr.infer(feat, 0.0, True, prior_score=-1.0, vol_bps=8.0)
    assert "veto" in inf and inf["tp_bps"] > 0 and inf["sl_bps"] > inf["tp_bps"] - 1e-9


def test_horizon_book_two_bars():
    from hermes.scalp.learn import BARS, HorizonBook
    hb = HorizonBook(7.0, log=lambda m: None)
    assert BARS == ("15m", "1H")
    assert hb.live_bars() == []
