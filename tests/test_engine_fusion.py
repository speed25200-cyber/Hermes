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
    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0
    class _R:
        trading_allowed = True
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
        state = _E()
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


def test_sizing_is_kelly_under_ruin_caps(tmp_path):
    """La taille vient du bracket lui-même : nulle quand l'avantage ne paie
    pas sa friction, plafonnée par la règle de ruine quand Kelly s'emballe,
    jamais forcée au minimum d'échange sur un avantage trop mince."""
    eng = _moteur(tmp_path)
    faible = {"tp_bps": 12.0, "sl_bps": 15.0, "edge_bps": 4.0, "vol_bps": 9.0,
              "h_bars": 3, "cost_bps": 8.0}
    assert eng._pick_lev(faible) == 0.0
    fort = {"tp_bps": 14.0, "sl_bps": 18.0, "edge_bps": 26.0, "vol_bps": 9.0,
            "h_bars": 3, "cost_bps": 8.0}
    lev = eng._pick_lev(fort)
    assert 2.0 <= lev <= 20.0
    assert lev <= 0.025 / (18.0 * 1e-4) + 1e-9, "la règle de ruine plafonne Kelly"


def test_the_evidence_card_receives_what_it_displays():
    """L'écran juge sur holdout_sr / sel_bar / n_holdout ; une horloge qui
    les calcule sans les exporter ferait afficher des zéros."""
    rng = np.random.default_rng(4)
    desk = ScaleDesk()
    m = CandleModel("5m")
    m.fit(_marche(rng, 900))
    desk.models[("BTC-USDT-SWAP", "5m")] = m
    d = m.to_dict()
    for k in ("holdout_sr", "sel_bar", "n_holdout"):
        assert k in d, k
    assert d["n_holdout"] > 0 and d["sel_bar"] > 0


# --- sortie TP maker ---------------------------------------------------- #

def _moteur_papier(tmp_path):
    from hermes.exchange.broker import PaperBroker
    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0
    class _R:
        trading_allowed = True
        must_flatten = False
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
        state = _E()
    b = PaperBroker(cash=10_000.0)
    eng = ScalpEngine({"scalp": {}, "costs": {}}, b, None, _R(),
                      lambda m: None, str(tmp_path))
    return eng, b


def _ouvre_long(eng, b, entry=100.0, tp_bps=20.0, sl_bps=30.0):
    b.book["X"] = {"last": entry, "bid": entry, "ask": entry}
    b.pos["X"] = 1.0
    b.entry["X"] = entry
    b.prices["X"] = entry
    eng.brackets["X"] = {"side": "long", "entry": entry,
                         "tp": entry * (1 + tp_bps * 1e-4),
                         "sl": entry * (1 - sl_bps * 1e-4),
                         "tp_bps": tp_bps, "sl_bps": sl_bps}


def test_a_crossed_take_fills_maker_at_its_own_price(tmp_path):
    """Le prix traverse franchement le TP : le limite posé a rempli à SON
    prix, au tarif maker — pas au bid du moment, pas au tarif taker."""
    eng, b = _moteur_papier(tmp_path)
    _ouvre_long(eng, b)
    tp = eng.brackets["X"]["tp"]
    au_dela = tp * 1.0005
    eng.ticks["X"] = {"last": au_dela, "bid": au_dela, "ask": au_dela * 1.0001}
    b.book["X"] = {"last": au_dela, "bid": au_dela, "ask": au_dela * 1.0001}
    assert eng.check_exits() == ["X"]
    fill = b.fills[-1]
    assert fill.price == tp
    assert fill.fee == fill.qty * fill.price * b.maker_fee_bps * 1e-4
    assert "maker" in eng.trades[-1]["reason"]


def test_a_touched_take_still_exits_taker(tmp_path):
    """Simple contact (bid == tp) : la position dans la file est inconnue,
    la sortie reste taker au marché — jamais mieux que la réalité."""
    eng, b = _moteur_papier(tmp_path)
    _ouvre_long(eng, b)
    tp = eng.brackets["X"]["tp"]
    eng.ticks["X"] = {"last": tp, "bid": tp, "ask": tp * 1.0001}
    b.book["X"] = {"last": tp, "bid": tp, "ask": tp * 1.0001}
    assert eng.check_exits() == ["X"]
    fill = b.fills[-1]
    assert fill.fee == fill.qty * fill.price * b.fee_bps * 1e-4
    assert "maker" not in eng.trades[-1]["reason"]


def test_the_stop_never_pretends_to_be_maker(tmp_path):
    """Un stop se coupe en traversant le spread : toujours taker."""
    eng, b = _moteur_papier(tmp_path)
    _ouvre_long(eng, b)
    sl = eng.brackets["X"]["sl"]
    sous = sl * 0.999
    eng.ticks["X"] = {"last": sous, "bid": sous, "ask": sous * 1.0001}
    b.book["X"] = {"last": sous, "bid": sous, "ask": sous * 1.0001}
    assert eng.check_exits() == ["X"]
    fill = b.fills[-1]
    assert fill.fee == fill.qty * fill.price * b.fee_bps * 1e-4
    assert eng.trades[-1]["reason"].startswith("SL")


def test_predictions_carry_both_costs(tmp_path):
    """L'EV et Kelly jugent aux coûts asymétriques : la prédiction doit
    transporter le coût de la jambe TP, pas seulement le taker."""
    eng = _moteur(tmp_path)
    assert eng.cost_tp_bps == 4.0
    assert eng.cost_tp_bps < eng.round_trip_bps
