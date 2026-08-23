"""The flow model's gate has to survive its own refit cadence.

The deployed version sampled every poll against a 90 s horizon (labels
overlapping ~9 neighbours), gated at a fixed ic>0.04 that sits below the
noise floor, refit every 40 labels without charging the repeated looks,
and let a hand-written warm-up prior place orders. It day-halted at
-8.33%. Each rule that replaced that has a test here.
"""

import numpy as np
import pytest

from hermes.scalp.flow import HORIZON_S, FlowBrain


def _cerveau(tmp_path):
    return FlowBrain(str(tmp_path), fee_bps=7.0, log=lambda m: None)


def _nourrir(fb, rng, n, gain=0.0, bruit=12.0, t0=0.0, h=90.0):
    """Feed n non-overlapping labels into one head; y = gain*x0 + bruit.

    Directional capture is gain·E|x| ≈ 0.8·gain bps — the planted edge only
    beats the 7 bps fee when gain exceeds ~9. That is the honest economics
    of a 90 s horizon, and the first version of this helper learned it the
    hard way: an ic of 0.55 with gain 12·0.55 captures 6.3 bps and LOSES."""
    tete = fb.heads[h]
    for i in range(n):
        x = rng.normal(0.0, 1.0, 10)
        y = gain * x[0] + rng.normal(0.0, bruit)
        tete.X.append([float(v) for v in x])
        tete.y.append(float(y))
        tete.T.append(t0 + i * tete.h)
    return fb


def test_overlapping_labels_are_refused_at_the_door(tmp_path):
    fb = _cerveau(tmp_path)
    now = 1_000_000.0
    import time as _t
    vrai = _t.time
    try:
        _t.time = lambda: now
        for k in range(30):                       # un sondage toutes les 10 s
            fb.pending.append({"t": now - HORIZON_S - 300 + k * 10,
                               "inst": "BTC-USDT-SWAP", "x": [0.0] * 10,
                               "mid": 100.0})
        fb.settle({"BTC-USDT-SWAP": 100.1})
    finally:
        _t.time = vrai
    # 300 s de sondages ne valent que 300/90 ≈ 3 observations indépendantes
    n90 = len(fb.heads[90.0].y)
    assert n90 <= 4, f"{n90} étiquettes pour 300 s d'historique"
    # et une seule au mieux sur l'horizon 5 min
    assert len(fb.heads[300.0].y) <= 2


def test_noise_never_goes_live_even_after_many_refits(tmp_path):
    rng = np.random.default_rng(5)
    passes = 0
    for seed in range(6):
        fb = _cerveau(tmp_path / f"n{seed}")
        _nourrir(fb, np.random.default_rng(seed), 900)
        for _ in range(12):                       # douze refits successifs
            fb.fit()
            if fb.status == "live":
                passes += 1
                break
    assert passes == 0, f"{passes}/6 cerveaux vivants sur bruit pur"


def test_a_real_signal_still_goes_live(tmp_path):
    vivants = 0
    for seed in range(4):
        fb = _cerveau(tmp_path / f"s{seed}")
        _nourrir(fb, np.random.default_rng(100 + seed), 1400, gain=16.0, bruit=8.0)
        fb.fit()
        vivants += fb.status == "live"
    assert vivants >= 3, f"{vivants}/4 — le filtre est aveugle"


def test_the_bar_rises_with_every_refit(tmp_path):
    fb = _cerveau(tmp_path)
    _nourrir(fb, np.random.default_rng(9), 800, gain=16.0, bruit=8.0)
    fb.fit()
    tete = fb.heads[90.0]
    b1 = tete.sel_bar
    for _ in range(20):
        fb.fit()
    assert tete.sel_bar > b1 > 0


def test_the_warmup_prior_reports_but_never_trades(tmp_path):
    fb = _cerveau(tmp_path)
    assert fb.status == "warmup"
    micro = {"imb": 0.9, "book": 0.9, "depth": 0.9, "micro": 0.0018,
             "ofi": 2.5, "spread_bps": 1.0, "l2": True}
    x = fb.vec("ETH-USDT-SWAP", micro, {"flow": 0.9, "vwap_vs": 0.0},
               2400.0, 98000.0, 0.0)
    inf = fb.infer(x, micro)
    # la dislocation est extrême — l'ancien prior aurait tiré
    assert inf["veto"] is True
    assert inf["r_bps"] != 0.0, "le score doit rester visible à l'écran"


def test_the_purge_drops_train_labels_that_straddle_the_cut(tmp_path):
    fb = _cerveau(tmp_path)
    _nourrir(fb, np.random.default_rng(3), 600, gain=16.0, bruit=8.0)
    fb.fit()
    assert fb.status in ("live", "veto")
    # avec des temps espacés d'exactement un horizon, la purge retire
    # au plus une poignée d'étiquettes, jamais la moitié du train
    assert fb.n == 600


def test_each_horizon_has_its_own_gate_and_the_bar_pays_for_all_three(tmp_path):
    """Un signal planté sur 15 min seulement : la tête 15 min passe, la
    tête 90 s reste veto — et chaque barre est déflatée pour les trois
    horizons cherchés, pas pour un seul."""
    fb = _cerveau(tmp_path)
    _nourrir(fb, np.random.default_rng(21), 900, gain=0.0, bruit=12.0, h=90.0)
    _nourrir(fb, np.random.default_rng(22), 900, gain=16.0, bruit=8.0, h=900.0)
    fb.fit()
    assert fb.heads[90.0].status == "veto"
    assert fb.heads[900.0].status == "live"
    from hermes.backtest.metrics import expected_max_sharpe
    tete = fb.heads[900.0]
    seul = expected_max_sharpe(min(max(tete.fits, 2), 64), 225)
    assert tete.sel_bar > seul, "la barre doit payer les trois horizons"


def test_inference_speaks_at_the_horizon_of_the_live_head(tmp_path):
    fb = _cerveau(tmp_path)
    _nourrir(fb, np.random.default_rng(31), 1200, gain=16.0, bruit=8.0, h=900.0)
    fb.fit()
    assert fb.heads[900.0].status == "live"
    micro = {"imb": 0.4, "book": 0.4, "depth": 0.2, "micro": 0.0004,
             "ofi": 1.0, "spread_bps": 1.0, "l2": True}
    x = fb.vec("ETH-USDT-SWAP", micro, {"flow": 0.4, "vwap_vs": 0.0},
               2400.0, 98000.0, 0.0)
    inf = fb.infer(x, micro)
    assert inf["h_bars"] == 15, "l'horizon doit suivre la tête qui tire"
    assert inf["bar"] == "15m"
