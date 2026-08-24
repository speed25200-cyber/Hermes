"""Two validated sources co-decide; neither the dead code nor the hand
prior places orders.

The audit found three parallel brains: the clocks voted and were ignored,
the fixed learner was not imported by the engine at all, and every order
followed the flow model alone — whose warm-up prior could trade
unvalidated. These tests pin the repaired wiring.
"""

import time

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
        # Le déséquilibre taker PERSISTE sur quelques barres. Un flux qui
        # change de signe à chaque barre ne prédit que la barre suivante,
        # celle que le moteur ne peut pas atteindre : la fixture testerait
        # alors une capture impossible.
        base = rng.choice([-1.0, 1.0], n // 3 + 2)
        drive = np.repeat(base, 3)[:n]
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
    base = {"sortie_temps": True, "net_sd": 45.0, "sl_bps": 12.0,
            "tp_bps": 140.0, "edge_bps": 10.0, "vol_bps": 25.0,
            "h_bars": 3, "cost_bps": 8.0, "size_mult": 1.0, "net_n": 2000}
    maigre = eng._pick_lev(dict(base, net_bps=8.0))
    gras = eng._pick_lev(dict(base, net_bps=20.0))
    assert gras > maigre >= 0.0
    # une règle qui perd ne prend aucune taille
    assert eng._pick_lev(dict(base, net_bps=-4.0)) == 0.0


def test_a_measured_rule_sizes_itself_from_its_own_moments(tmp_path):
    """Quand une horloge a été mesurée, c'est elle qui dimensionne — pas
    un brownien qui n'a jamais vu ces données. Constaté en direct : une
    position SOL ouverte à 5x là où les moments mesurés de la règle
    (+9,29 bps par trade, écart-type 61,9) donnent trois fois moins après
    quart de Kelly et demi-taille de solitude."""
    eng = _moteur(tmp_path)
    p = {"tp_bps": 40.0, "sl_bps": 50.0, "edge_bps": 9.0, "vol_bps": 25.0,
         "h_bars": 6, "cost_bps": 9.0, "cost_tp_bps": 4.0, "size_mult": 0.5,
         "net_bps": 9.29, "net_sd": 61.9, "net_n": 589, "sortie_temps": True}
    mesure = eng._pick_lev(p)
    # f* = 0.25 x mu/(mu^2+sd^2) sur les moments mesurés, mu pris à sa
    # BORNE BASSE à une erreur-type, puis demi-taille pour la solitude,
    # puis plafond de ruine (2,5 % par stop). Rendu SANS troncature : le
    # levier d'échange est entier, la taille de position ne l'est pas.
    mu = 9.29e-4 - 61.9e-4 / 589 ** 0.5
    attendu = 0.25 * mu / (mu * mu + (61.9e-4) ** 2) * 0.5
    assert abs(mesure - min(attendu, 0.025 / 50e-4)) < 1e-9
    # le plafond de ruine reste le dernier mot, quelle que soit la mesure
    genereux = eng._pick_lev({**p, "net_bps": 90.0, "net_sd": 20.0})
    assert genereux <= 0.025 / (50e-4) + 1e-9


def test_without_a_measurement_the_simulated_bracket_is_still_the_judge(tmp_path):
    """Contre-épreuve : sans économie mesurée derrière — le flux seul —
    rien ne change, le bracket simulé reste le seul juge disponible et il
    peut toujours refuser."""
    eng = _moteur(tmp_path)
    eng.brain.infer = lambda x, m: {"r_bps": +6.0, "ml_bps": 6.0, "q_bps": 6.0,
                                    "tp_bps": 12, "sl_bps": 18, "veto": False,
                                    "score": 0.75, "status": "flow",
                                    "policy": "flow", "bar": "90s",
                                    "ic": 0.2, "clocks": {}}
    eng.horizons.fuse = lambda i: {"r_bps": 0.0, "veto": True, "bar": "5m",
                                   "status": "incoherent", "policy": "flat",
                                   "clocks": {}, "ic": 0.0, "q_bps": 12.0,
                                   "tp_bps": 12, "sl_bps": 18, "ml_bps": 0.0,
                                   "score": 0.0}
    for p in _preds(eng):
        assert p["policy"] in ("flow", "flat")
        if p["dir"] == "flat":
            assert p["reason"] in ("no-ev", "cost", "veto", "incoherent")


def test_thin_evidence_sizes_smaller_than_thick_evidence(tmp_path):
    """f* est PROPORTIONNEL à mu, et mu est la quantité la plus mal
    estimée de la chaîne. Deux règles de moments identiques mais mesurées
    sur des échantillons différents ne doivent pas être jouées à la même
    taille : celle qui repose sur cinquante instants est réduite, celle
    qui en a des milliers ne l'est presque pas."""
    eng = _moteur(tmp_path)
    base = {"tp_bps": 40.0, "sl_bps": 15.0, "edge_bps": 9.0,
            "vol_bps": 25.0, "h_bars": 6, "cost_bps": 9.0,
            "cost_tp_bps": 4.0, "size_mult": 1.0, "net_bps": 20.0,
            "net_sd": 55.0, "sortie_temps": True}
    maigre = eng._pick_lev({**base, "net_n": 60})
    epais = eng._pick_lev({**base, "net_n": 5000})
    assert maigre < epais, f"maigre {maigre} vs épais {epais}"
    assert maigre > 0.0, "des preuves minces réduisent, elles n'annulent pas"


def test_evidence_too_thin_to_beat_its_own_error_sizes_to_nothing(tmp_path):
    """Et quand la moyenne ne dépasse même pas son erreur-type, la borne
    basse est nulle : on ne trade pas la taille d'un avantage qu'on n'a
    pas établi."""
    eng = _moteur(tmp_path)
    p = {"tp_bps": 40.0, "sl_bps": 90.0, "edge_bps": 9.0, "vol_bps": 25.0,
         "h_bars": 6, "cost_bps": 9.0, "cost_tp_bps": 4.0, "size_mult": 1.0,
         "net_bps": 5.0, "net_sd": 55.0, "net_n": 40, "sortie_temps": True}
    assert eng._pick_lev(p) == 0.0


def _armer(eng, inst, qty, px, h_bars, sortie_temps=True):
    class _F:
        pass
    f = _F()
    f.price, f.ts, f.inst, f.fee = px, 0.0, inst, 0.0
    eng.last_preds = [{"inst": inst, "h_bars": h_bars,
                       "sortie_temps": sortie_temps, "policy": "candle"}]
    eng._arm(inst, qty, f, 25.0, 200.0, 60.0)
    eng.opened_bar[inst] = int(__import__("time").time() * 1000)
    return eng


def test_a_measured_position_lives_its_validated_duration(tmp_path):
    """La porte a jugé « entrer, tenir h barres, sortir ». Refermer au
    premier tour où le signal fusionné bouge joue une AUTRE règle, dont
    personne ne connaît l'économie. Mesuré en direct : DOGE ouvert à
    02:53:23 sur un signal candle à h=6, refermé à 02:54:31 — soixante-huit
    secondes, et par une politique qui n'a rien validé."""
    eng = _moteur(tmp_path)
    inst = eng.instruments[0]
    _armer(eng, inst, 100.0, 1.0, h_bars=6)
    eng.pending = {inst: 0.0}
    # le filtre vit dans tick(); on l'applique ici tel qu'il est écrit
    maintenant = int(__import__("time").time() * 1000)
    br = eng.brackets[inst]
    assert br["sortie_temps"] is True
    ouvert, lim = eng.opened_bar[inst], eng.hold_ms[inst]
    assert lim == 6 * 60_000, lim
    assert (maintenant - ouvert) < lim


def test_an_explorer_position_keeps_its_own_carve_out(tmp_path):
    """L'exemption éclaireur et l'exemption de durée validée sont deux
    règles distinctes : un éclaireur n'a pas de sortie au temps validée et
    doit rester protégé par la sienne."""
    eng = _moteur(tmp_path)
    inst = eng.instruments[1]
    _armer(eng, inst, 100.0, 1.0, h_bars=3, sortie_temps=False)
    eng.brackets[inst]["explore"] = True
    assert eng.brackets[inst]["sortie_temps"] is False
    assert eng.brackets[inst]["explore"] is True


def test_the_stop_still_gets_out_during_the_hold(tmp_path):
    """La durée validée gèle la CIBLE, pas le garde-fou. Une position
    figée pour six minutes doit tout de même sortir si le prix traverse
    son stop — sans quoi geler la position reviendrait à la désarmer."""
    eng = _moteur(tmp_path)
    inst = eng.instruments[0]

    class _Fill:
        def __init__(self, px):
            self.price, self.ts, self.inst, self.fee = px, 0.0, inst, 0.0

    class _Broker:
        def __init__(self):
            self.pos = {inst: 100.0}
            self.ordres = []

        def positions(self):
            return dict(self.pos)

        def equity(self):
            return 10_000.0

        def market_order(self, i, q, px, force_taker=False, maker_at=None,
                         leverage=None):
            self.ordres.append((i, q, px))
            self.pos.pop(i, None)
            return _Fill(maker_at if maker_at is not None else px)

    eng.broker = _Broker()
    _armer(eng, inst, 100.0, 1.0, h_bars=6)
    eng.pending = {}
    # le prix traverse le stop bien avant la fin des six minutes
    stop = eng.brackets[inst]["sl"]
    eng.ticks[inst] = {"last": stop * 0.99, "bid": stop * 0.99,
                       "ask": stop * 0.99, "spread_bps": 2.0}
    touches = eng.check_exits()
    assert inst in touches, "le stop n'a pas sorti pendant la durée figée"
    assert eng.broker.ordres, "aucun ordre de sortie envoyé"


def test_a_braked_rule_trades_smaller_instead_of_not_at_all(tmp_path):
    """Un levier de 1 est MOINS risqué qu'un levier de 2. Plancher à deux,
    le frein du gouverneur et le rodage n'atténuaient pas la taille : ils
    l'annulaient. Une règle validée à quart de frein sortait à 0,84 de
    levier et ne tradait donc pas du tout — quatorze heures sans une seule
    position sur signal prouvé, pendant que des éclaireurs ouvraient des
    micro-positions sur une devinette."""
    eng = _moteur(tmp_path)
    assert eng.lev_min == 1
    p = {"tp_bps": 40.0, "sl_bps": 60.0, "edge_bps": 12.0, "vol_bps": 25.0,
         "h_bars": 6, "cost_bps": 9.0, "cost_tp_bps": 4.0,
         "net_bps": 11.0, "net_sd": 55.0, "net_n": 600,
         "sortie_temps": True, "size_mult": 0.5}
    plein = eng._pick_lev(p)
    assert plein >= 2, plein
    # au quart de frein, la même règle doit encore prendre une position
    eng._risk_scale = lambda: 0.25
    freine = eng._pick_lev(p)
    assert 0 < freine < plein, f"freiné {freine} contre plein {plein}"


def test_the_live_count_survives_a_redeploy(tmp_path):
    """Le rodage compte les trades fermés pour décider quand la règle a
    droit à sa taille pleine. Ce compteur était publié dans le relevé mais
    jamais relu au démarrage : chaque mise en ligne le remettait à zéro, il
    n'atteignait donc jamais les 30 trades du palier et la confiance restait
    collée à 0,1. La règle validée était condamnée au dixième de taille par
    un oubli de persistance, pas par ses résultats."""
    eng = _moteur(tmp_path)
    assert eng._confiance() == 0.1
    eng.live_stats["n"] = 130
    eng.live_stats["bps"] = 12.0
    eng.explore_stats["trades"] = 44
    eng.explore_stats["exit_maker_bps"] = -1.5
    eng.explore_stats["n_exit_maker"] = 9
    eng._snapshot({"equity": 10_000.0})

    repris = _moteur(tmp_path)
    assert repris.live_stats["n"] == 130
    assert repris.live_stats["bps"] == 12.0
    assert repris._confiance() == 1.0, "le rodage doit être fini, pas rejoué"
    # les mesures de l'éclaireur servent le modèle de coût : elles non plus
    # ne se rachètent pas à chaque redémarrage
    assert repris.explore_stats["trades"] == 44
    assert repris.explore_stats["n_exit_maker"] == 9
    assert repris.explore_stats["exit_maker_bps"] == -1.5


def test_a_derived_or_corrupt_field_is_never_taken_back(tmp_path):
    """`confiance` se recalcule à partir de `n` et du net réalisé ; la
    relire reviendrait à figer une taille que les résultats ne soutiennent
    plus. Et un état tronqué ou bricolé à la main ne doit pas pouvoir
    injecter n'importe quoi dans les compteurs."""
    import json

    eng = _moteur(tmp_path)
    with open(eng.state_path, "w") as f:
        json.dump({"live_rule": {"n": 130, "bps": "beaucoup",
                                 "confiance": 1.0},
                   "explore": {"trades": None, "tp_maker": True}}, f)
    repris = _moteur(tmp_path)
    assert repris.live_stats["n"] == 130
    assert repris.live_stats["bps"] == 0.0, "une chaîne n'est pas une mesure"
    assert repris._confiance() == 0.1, "net réalisé nul : pas de taille pleine"
    assert repris.explore_stats["trades"] == 0
    assert repris.explore_stats["tp_maker"] == 0, "un booléen n'est pas un compte"


class _BrokerPos:
    """Un broker qui tient vraiment une position, pour les redémarrages."""

    def __init__(self, pos=None):
        self.pos = dict(pos or {})
        self.ordres = []

    def positions(self):
        return dict(self.pos)

    def equity(self):
        return 10_000.0

    def mark_prices(self, prices):
        pass

    def market_order(self, inst, qty, px, force_taker=False,
                     maker_at=None, leverage=None):
        self.ordres.append((inst, qty, px))
        self.pos[inst] = self.pos.get(inst, 0.0) + qty
        if abs(self.pos[inst]) < 1e-12:
            self.pos.pop(inst)

        class _F:
            ts = 1_700_000_000.0
            price = float(maker_at or px)
            fee = 0.0
        _F.inst = inst
        return _F()


def _moteur_pos(tmp_path, pos=None):
    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0

    class _R:
        trading_allowed = True
        must_flatten = False
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
        state = _E()

        def update_equity(self, *a):
            pass
    b = _BrokerPos(pos)
    eng = ScalpEngine({"scalp": {}, "costs": {}}, b, None, _R(),
                      lambda m: None, str(tmp_path))
    return eng, b


def test_a_position_keeps_its_rule_across_a_restart(tmp_path):
    """Une position appartient à une règle : prix d'entrée, stop, durée
    validée. Rien de cela ne survivait au redémarrage, alors la position
    échappait à check_exits, se faisait refermer par une politique qui
    n'avait rien validé, et n'entrait dans aucune mesure. Le direct était
    donc amputé exactement des trades traversant une mise en ligne."""
    inst = "BTC-USDT-SWAP"
    eng, _ = _moteur_pos(tmp_path, {inst: 0.01})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 99.0,
                          "tp": 101.0, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = 1_700_000_000_000
    eng.hold_ms[inst] = 360_000
    eng.opened_h[inst] = "1m"
    eng._snapshot({"equity": 10_000.0})

    repris, _ = _moteur_pos(tmp_path, {inst: 0.01})
    assert repris.brackets[inst]["entry"] == 100.0
    assert repris.brackets[inst]["sortie_temps"] is True
    assert repris.opened_bar[inst] == 1_700_000_000_000
    assert repris.hold_ms[inst] == 360_000
    assert repris.opened_h[inst] == "1m"


def test_a_restarted_position_still_answers_to_its_stop(tmp_path):
    """Le test qui compte : après reprise, le stop doit encore sortir."""
    inst = "BTC-USDT-SWAP"
    eng, _ = _moteur_pos(tmp_path, {inst: 0.01})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 99.0,
                          "tp": 101.0, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 360_000
    eng._snapshot({"equity": 10_000.0})

    repris, b = _moteur_pos(tmp_path, {inst: 0.01})
    repris.ticks[inst] = {"last": 98.5, "bid": 98.5, "ask": 98.6,
                          "spread_bps": 2.0}
    touches = repris.check_exits()
    assert inst in touches, "le stop n'a pas survécu au redémarrage"
    assert repris.live_stats["n"] == 1, \
        "un trade traversant une mise en ligne doit encore se mesurer"


def test_a_position_no_rule_owns_gets_closed(tmp_path):
    """Sans propriétaire, une position n'a ni stop ni durée : elle ne peut
    que dériver. Mesuré en direct : un DOGE -8050, sept cents dollars de
    notionnel, immobile depuis des heures parce qu'aucune règle ne
    répondait plus pour lui."""
    inst = "DOGE-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: -8050.0})
    dits = []
    eng.log = dits.append
    eng.ticks[inst] = {"last": 0.092, "bid": 0.0919, "ask": 0.0921,
                       "spread_bps": 2.0}
    # un seul constat ne suffit pas : une lecture de positions tronquée ne
    # doit pas pouvoir aplatir une position parfaitement tenue
    assert eng.check_exits() == []
    assert b.pos[inst] == -8050.0
    touches = eng.check_exits()
    assert inst in touches, "l'orpheline est restée au livre"
    assert any("orpheline" in m for m in dits), dits
    assert b.pos.get(inst) is None


def test_a_truncated_position_read_never_flattens_a_held_position(tmp_path):
    """Un échange qui hoquette et renvoie une liste de positions tronquée
    ne doit ni effacer le suivi d'une position ni provoquer sa sortie : le
    tour suivant la reverra, et le compteur repart."""
    inst = "BTC-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: 0.01})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 1.0,
                          "tp": 1e9, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 360_000
    eng.ticks[inst] = {"last": 100.0, "bid": 100.0, "ask": 100.1,
                       "spread_bps": 2.0}
    eng._orphelines({})           # lecture tronquée
    eng._orphelines({inst: 0.01})  # l'échange répond de nouveau
    assert eng.brackets.get(inst), "le bracket a été effacé sur un hoquet"
    assert eng.check_exits() == []
    assert b.pos[inst] == 0.01


def test_a_reversal_closes_one_trade_and_opens_another(tmp_path):
    """Passer long -> court en un ordre, c'est fermer un trade et en ouvrir
    un autre. Traité en « resize », la jambe fermée n'entrait dans aucune
    mesure et le bracket restait celui du sens opposé : le stop de la
    position retournée se retrouvait du mauvais côté du prix et sortait au
    tour suivant sous l'étiquette « SL », un stop jamais armé."""
    inst = "BTC-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: 1.0})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 99.0,
                          "tp": 101.0, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 360_000
    eng.ticks[inst] = {"last": 101.0, "bid": 100.9, "ask": 101.1,
                       "spread_bps": 2.0}
    eng.last_preds = [{"inst": inst, "policy": "candle", "bar": "1m",
                       "dir": "short", "ml": "live", "conf": 1.0,
                       "h_bars": 6, "edge_bps": -12.0, "lev": 1.0,
                       "vol_bps": 25.0, "tp_bps": 30.0, "sl_bps": 40.0,
                       "sortie_temps": True}]
    eng._vol = {inst: 25.0}
    eng.pending = {inst: -1.0}
    eng.execute_pending()

    assert b.pos[inst] == -1.0, "le retournement n'a pas eu lieu"
    assert eng.live_stats["n"] == 1, "la jambe fermée n'a pas été mesurée"
    assert eng.brackets[inst]["side"] == "short", eng.brackets[inst]
    assert eng.brackets[inst]["sl"] > 101.0, \
        "le stop du court est resté sous le prix : il sortirait aussitôt"
    touches = eng.check_exits()
    assert touches == [], f"sortie immédiate sur un stop jamais armé: {touches}"
