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
    from hermes.scalp.clock import N_FEATURES
    assert X.shape == (800, N_FEATURES)
    # colonnes 8..11 = funding, taker, basis, delta-OI ; colonne 16 = la
    # poussée du taker. Toutes muettes quand la série manque.
    assert np.allclose(X[:, 8:12], 0.0), "aux absentes doivent être muettes"
    assert np.allclose(X[:, 16], 0.0), "la poussée du taker aussi"
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


# --- du verdict à l'ordre : le chemin complet d'une horloge de panel ---- #

class _Horloge:
    """Une horloge de panel déjà validée, sans passer par un ajustement.

    Ce qui est testé ici n'est pas la porte — elle a ses propres tests —
    mais le CÂBLAGE : un seul objet modèle partagé par tous les actifs,
    le vote de tout le panel avant la moindre fusion, la neutralisation
    transversale, et enfin l'ordre. Une horloge qui passe la porte sans
    que rien ne s'ouvre derrière ne sert à rien.
    """

    def __init__(self, variant="abs", par_actif=None):
        self.status, self.variant = "live", variant
        self.shrink, self.thr_bps = 0.5, 5.0
        self.horizon_bars, self.ic, self.q = 3, 0.12, 0.0012
        self.bar = "1m"
        self._par_actif = par_actif or {}
        self._defaut = 60.0

    def predict_row(self, x, sig=None):
        # la valeur dépend de l'actif via un compteur d'appels ; le moteur
        # vote dans l'ordre de self.instruments
        raw = self._suivant()
        return {"r_bps": raw * self.shrink, "raw_bps": raw,
                "up_bps": 45.0, "dn_bps": 30.0, "q_bps": self.q * 1e4,
                "veto": abs(raw) < self.thr_bps, "bar": self.bar,
                "horizon_bars": self.horizon_bars, "variant": self.variant,
                "status": "live", "ic": self.ic}

    def to_dict(self):
        return {"bar": self.bar, "status": self.status, "ic": self.ic,
                "family": "ens", "variant": self.variant,
                "thr_bps": self.thr_bps, "n_trades": 0, "n_periods": 0,
                "holdout_bps": 0.0, "holdout_sr": 0.0, "sel_bar": 0.0,
                "n_holdout": 0, "n_train": 0, "q_bps": self.q * 1e4,
                "shrink": self.shrink, "horizon_bars": self.horizon_bars,
                "n_assets": 6, "n_trials": 432, "pente": 1.0}

    def _suivant(self):
        if not self._par_actif:
            return self._defaut
        return self._par_actif.pop(0) if self._par_actif else self._defaut


def _desk_partage(eng, horloge):
    for inst in eng.instruments:
        eng.horizons.models[(inst, "1m")] = horloge
    eng.horizons.fee = 7.0
    return eng


def test_one_shared_clock_speaks_for_the_whole_panel(tmp_path):
    """Une horloge validée parle pour tous les actifs au même instant :
    c'est exactement le portefeuille sur lequel elle a été jugée, et la
    raison pour laquelle le panel fait trader plus souvent."""
    eng = _moteur(tmp_path)
    _desk_partage(eng, _Horloge("abs"))
    preds = _preds(eng)
    directions = [p["dir"] for p in preds]
    assert len(preds) == len(eng.instruments)
    assert sum(d == "long" for d in directions) >= 2, (
        f"une horloge partagée n'a fait parler personne : {directions}")


def test_a_neutral_clock_produces_a_long_and_a_short_at_once(tmp_path):
    """En variante neutre le livre est long-short par construction : le
    premier actif dépasse la moyenne du panel, le dernier est dessous."""
    eng = _moteur(tmp_path)
    n = len(eng.instruments)
    # écarts francs de part et d'autre de la moyenne
    valeurs = [80.0] + [0.0] * (n - 2) + [-80.0]
    _desk_partage(eng, _Horloge("neu", par_actif=list(valeurs)))
    preds = _preds(eng)
    sens = {p["inst"]: p["dir"] for p in preds}
    assert "long" in sens.values() and "short" in sens.values(), sens


def test_every_asset_votes_before_anything_fuses(tmp_path):
    """La neutralisation a besoin de la moyenne du tour COURANT. Si le
    moteur fusionnait au fil de la boucle, le premier actif serait jugé
    sur la moyenne du tour précédent — une règle que personne n'a
    validée."""
    eng = _moteur(tmp_path)
    ordre = []
    vrai_vote = eng.horizons.vote_clock
    vraie_fusion = eng.horizons.fuse

    def vote(inst, bar, c, btc):
        ordre.append(("vote", inst))
        return vrai_vote(inst, bar, c, btc)

    def fuse(inst):
        ordre.append(("fuse", inst))
        return vraie_fusion(inst)

    eng.horizons.vote_clock, eng.horizons.fuse = vote, fuse
    _desk_partage(eng, _Horloge("abs"))
    _preds(eng)
    votes = [i for i, (k, _) in enumerate(ordre) if k == "vote"]
    fusions = [i for i, (k, _) in enumerate(ordre) if k == "fuse"]
    assert votes and fusions
    assert max(votes) < min(fusions), (
        "un vote arrive après une fusion : la moyenne du panel serait rance")


def test_a_live_clock_actually_puts_positions_on_the_book(tmp_path):
    """Le bout du chemin. Les tests précédents s'arrêtent à la direction
    publiée ; celui-ci va jusqu'au carnet. Une horloge validée doit
    produire des positions RÉELLES sur plusieurs actifs — c'est la seule
    chose que l'utilisateur peut constater, et c'est ce qui manquait
    quand fuse() rétrécissait une horloge seule par son poids d'échelle.
    """
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

        def update_equity(self, *a, **k):
            pass

    eng = ScalpEngine({"scalp": {"explore": {"enabled": False}}, "costs": {}},
                      PaperBroker(cash=10_000.0), None, _R(),
                      lambda m: None, str(tmp_path))
    _desk_partage(eng, _Horloge("abs"))
    candles = {i: _marche(np.random.default_rng(9 + k))
               for k, i in enumerate(eng.instruments)}
    eng.tick(candles, bar="1m")
    eng.execute_pending()
    pos = {i: q for i, q in eng.broker.positions().items() if abs(q) > 1e-12}
    assert len(pos) >= 2, (
        f"une horloge validée n'a rien mis au carnet : {pos} ; "
        f"{[(p['inst'], p['dir'], p['reason']) for p in eng.last_preds]}")
    assert all(q > 0 for q in pos.values()), pos


def test_a_measured_rule_is_not_refused_by_a_model_that_never_saw_it(tmp_path):
    """choose_bracket demande si un couple objectif/stop bat sa friction
    SOUS UN BROWNIEN. Aux amplitudes réelles d'un scalp — dix points de
    base prévus contre vingt-cinq de volatilité — il refuse à peu près
    tout : mesuré, il rend None pour edge<=10 dès que la volatilité passe
    vingt. Il aurait donc refusé en bloc les trades d'une horloge dûment
    mesurée à +5,4 bps nets par trade sur 553 trades.

    Quand la mesure existe, c'est elle qui tranche : on joue exactement la
    règle validée — sortie au temps — avec un stop large qui est un
    garde-fou de ruine, pas un instrument de rendement.
    """
    from hermes.scalp import economics as ECON
    assert ECON.choose_bracket(edge_bps=10.0, vol_bps=25.0, horizon=3,
                               cost_bps=7.0, cost_tp_bps=4.0) is None

    eng = _moteur(tmp_path)
    eng.horizons.fuse = lambda i: {
        "r_bps": +10.0, "q_bps": 8.0, "veto": False, "bar": "3m",
        "tp_bps": 12, "sl_bps": 18, "ml_bps": 10.0, "score": 1.25,
        "status": "live", "policy": "candle-solo", "ic": 0.18,
        "clocks": {}, "alpha": 0.5, "horizon_bars": 3,
        "net_bps": 5.39, "net_sd": 45.0}
    preds = _preds(eng)
    p = preds[0]
    assert p["dir"] == "long", p["reason"]
    assert p["sortie_temps"] is True
    assert p["ev_bps"] == 5.39
    # le stop est un garde-fou, largement au-delà du mouvement prévu
    assert p["sl_bps"] >= 3.0 * abs(p["edge_bps"])


def test_without_a_measurement_the_refusal_stands(tmp_path):
    """Contre-épreuve : sans économie mesurée derrière, un signal que le
    modèle refuse reste refusé. La sortie au temps n'est pas une porte
    dérobée, c'est le droit de jouer ce qui a été prouvé."""
    eng = _moteur(tmp_path)
    eng.horizons.fuse = lambda i: {
        "r_bps": +10.0, "q_bps": 8.0, "veto": False, "bar": "3m",
        "tp_bps": 12, "sl_bps": 18, "ml_bps": 10.0, "score": 1.25,
        "status": "live", "policy": "candle-solo", "ic": 0.18,
        "clocks": {}, "alpha": 0.5, "horizon_bars": 3,
        "net_bps": 0.0, "net_sd": 0.0}
    p = _preds(eng)[0]
    assert p["dir"] == "flat" and p["reason"] == "no-ev"


def test_a_time_exit_is_sized_from_its_own_measured_moments(tmp_path):
    """f* = E[R]/E[R²] sur les moments MESURÉS, pas re-dérivé d'un
    brownien. Une règle deux fois plus rentable à dispersion égale doit
    prendre plus de taille."""
    eng = _moteur(tmp_path)
    base = {"sortie_temps": True, "net_sd": 45.0, "sl_bps": 40.0,
            "tp_bps": 140.0, "edge_bps": 10.0, "vol_bps": 25.0,
            "h_bars": 3, "cost_bps": 8.0, "size_mult": 1.0}
    maigre = eng._pick_lev(dict(base, net_bps=3.0))
    gras = eng._pick_lev(dict(base, net_bps=9.0))
    assert gras > maigre >= 0.0
    # une règle qui perd ne prend aucune taille
    assert eng._pick_lev(dict(base, net_bps=-4.0)) == 0.0
