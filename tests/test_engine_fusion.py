"""Two validated sources co-decide; neither the dead code nor the hand
prior places orders.

The audit found three parallel brains: the clocks voted and were ignored,
the fixed learner was not imported by the engine at all, and every order
followed the flow model alone — whose warm-up prior could trade
unvalidated. These tests pin the repaired wiring.
"""

import numpy as np

from hermes.data.store import Candles
from hermes.scalp.clock import ASSETS, BARS, CandleModel, ScaleDesk
from hermes.scalp.engine import ScalpEngine


def _marche(rng, n=1500, vol=0.004):
    px = 100 * np.exp(np.cumsum(rng.normal(0, vol, n)))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, vol / 3, n)) * px
    return Candles("X", "1m", np.arange(n) * 60_000, o,
                   np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                   np.abs(rng.normal(1000, 300, n)))


def test_clock_gate_holds_on_noise_and_fires_on_signal():
    rng = np.random.default_rng(2)
    vivants_bruit = 0
    for seed in range(8):
        m = CandleModel("5m")
        m.fit(_marche(np.random.default_rng(seed)))
        vivants_bruit += m.status == "live"
    assert vivants_bruit == 0, f"{vivants_bruit}/8 horloges vivantes sur bruit"

    # série au retour suivant fortement prévisible (AR négatif marqué) :
    # la porte doit rester capable de la retenir
    vivants = 0
    for seed in range(4):
        rng = np.random.default_rng(50 + seed)
        n, vol = 2000, 0.004
        r = np.zeros(n); e = rng.normal(0, vol, n)
        for t in range(1, n):
            r[t] = -0.62 * r[t - 1] + e[t]
        px = 100 * np.exp(np.cumsum(r))
        o = np.concatenate([[100.0], px[:-1]])
        w = np.abs(rng.normal(0, vol / 4, n)) * px
        c = Candles("X", "1m", np.arange(n) * 60_000, o,
                    np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                    np.abs(rng.normal(1000, 300, n)))
        m = CandleModel("5m")
        m.fit(c)
        vivants += m.status == "live"
    assert vivants >= 2, f"{vivants}/4 — porte aveugle sur AR(1) fort"


def _moteur(tmp_path):
    class _B:
        def positions(self): return {}
        def equity(self): return 10_000.0
    class _R:
        trading_allowed = True
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
    return ScalpEngine({"scalp": {}, "costs": {}}, _B(), None, _R(),
                       lambda m: None, str(tmp_path))


def _preds(eng, seed=1):
    rng = np.random.default_rng(seed)
    candles = {i: _marche(np.random.default_rng(seed + k))
               for k, i in enumerate(eng.instruments)}
    return eng.predict_all(candles, bar="1m")


def test_an_unvalidated_engine_never_emits_a_direction(tmp_path):
    eng = _moteur(tmp_path)
    for p in _preds(eng):
        assert p["dir"] == "flat", p
        assert p["reason"], "un plat doit dire pourquoi"


def test_the_horizon_travels_with_the_prediction(tmp_path):
    eng = _moteur(tmp_path)
    for p in _preds(eng):
        assert p.get("h_bars", 0) >= 1


def test_disagreeing_validated_sources_sit_out(tmp_path):
    eng = _moteur(tmp_path)
    inst = eng.instruments[0]
    # forcer deux sources vivantes de signes opposés
    eng.brain.status = "live"
    eng.brain.ridge.w = np.zeros(11)
    eng.brain.infer = lambda x, m: {"r_bps": +14.0, "ml_bps": 14.0, "q_bps": 6.0,
                                    "tp_bps": 12, "sl_bps": 18, "veto": False,
                                    "score": 1.75, "status": "flow", "policy": "flow",
                                    "bar": "90s", "ic": 0.2, "clocks": {}}
    eng.horizons.fuse = lambda i: {"r_bps": -15.0, "q_bps": 8.0, "veto": False,
                                   "bar": "5m", "tp_bps": 12, "sl_bps": 18,
                                   "ml_bps": -15.0, "score": -1.9, "status": "live",
                                   "policy": "candle", "ic": 0.2, "clocks": {}}
    preds = _preds(eng)
    p = next(q for q in preds if q["inst"] == inst)
    assert p["dir"] == "flat" and p["reason"] == "disagree"


def test_agreeing_sources_fuse_and_can_trade(tmp_path):
    eng = _moteur(tmp_path)
    eng.brain.status = "live"
    eng.brain.ridge.w = np.zeros(11)
    eng.brain.infer = lambda x, m: {"r_bps": +16.0, "ml_bps": 16.0, "q_bps": 6.0,
                                    "tp_bps": 12, "sl_bps": 18, "veto": False,
                                    "score": 2.0, "status": "flow", "policy": "flow",
                                    "bar": "90s", "ic": 0.2, "clocks": {}}
    eng.horizons.fuse = lambda i: {"r_bps": +20.0, "q_bps": 8.0, "veto": False,
                                   "bar": "15m", "tp_bps": 14, "sl_bps": 20,
                                   "ml_bps": 20.0, "score": 2.5, "status": "live",
                                   "policy": "candle", "ic": 0.25, "clocks": {}}
    preds = _preds(eng)
    p = preds[0]
    assert p["policy"] == "flow+candle"
    assert p["h_bars"] == 45, "l'horizon suit la source la plus lente (15m x 3)"
    assert p["dir"] in ("long", "flat")  # flat seulement si l'EV du bracket le refuse
    if p["dir"] == "long":
        assert p["ev_bps"] > 0


# --- les séries dérivées nourrissent les horloges ----------------------- #

def test_missing_aux_series_change_nothing():
    """Une série absente vaut zéro partout : mêmes prédictions qu'avant,
    aucune barre de plus à franchir."""
    from hermes.scalp.clock import feat_matrix
    rng = np.random.default_rng(7)
    c = _marche(rng, 800)
    X = feat_matrix(c)
    assert X.shape == (800, 12)
    assert np.allclose(X[:, 8:], 0.0), "aux absentes doivent être muettes"
    assert np.isfinite(X).all()


def test_an_aux_only_signal_is_now_catchable():
    """Un marché dont la direction du prochain bar est portée par le flux
    taker — invisible à l'OHLCV seul — doit désormais pouvoir passer."""
    vivants = 0
    for seed in range(4):
        rng = np.random.default_rng(300 + seed)
        n, vol = 2000, 0.004
        drive = rng.choice([-1.0, 1.0], n)
        r = np.zeros(n)
        for t in range(1, n):
            r[t] = 0.0016 * drive[t - 1] + rng.normal(0, vol * 0.35)
        px = 100 * np.exp(np.cumsum(r))
        o = np.concatenate([[100.0], px[:-1]])
        w = np.abs(rng.normal(0, vol / 5, n)) * px
        vtot = np.abs(rng.normal(1000, 100, n))
        buy = vtot * (0.5 + 0.45 * drive)
        c = Candles("X", "1m", np.arange(n) * 60_000, o,
                    np.maximum(o, px) + w, np.minimum(o, px) - w, px, vtot,
                    taker_buy=buy, taker_sell=vtot - buy)
        m = CandleModel("5m")
        m.fit(c)
        vivants += m.status == "live"
    assert vivants >= 3, f"{vivants}/4 — le flux taker reste invisible"


def test_aux_features_stay_bounded_on_garbage():
    from hermes.scalp.clock import feat_matrix
    rng = np.random.default_rng(11)
    c = _marche(rng, 400)
    c.funding = rng.normal(0, 1.0, 400)          # funding absurde
    c.oi = np.abs(rng.normal(1e9, 5e8, 400))
    c.oi[::7] = 0.0                               # trous
    X = feat_matrix(c)
    assert np.isfinite(X).all()
    assert np.abs(X[:, 8]).max() <= 10.0
    assert np.abs(X[:, 11]).max() <= 0.2
