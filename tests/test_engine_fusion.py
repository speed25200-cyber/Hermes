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
    vrai_vote = eng.horizons.vote_panel
    vraie_fusion = eng.horizons.fuse

    def vote(bar, candles, btc):
        # Le panel vote d un bloc depuis que le facteur de marche de
        # chaque jambe est la moyenne des AUTRES : elle n existe qu une
        # fois tout le monde rassemble.
        for inst in candles:
            ordre.append(("vote", inst))
        return vrai_vote(bar, candles, btc)

    def fuse(inst):
        ordre.append(("fuse", inst))
        return vraie_fusion(inst)

    eng.horizons.vote_panel, eng.horizons.fuse = vote, fuse
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
    eng, _ = _moteur_pos(tmp_path, {inst: 1.0})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 99.0,
                          "tp": 101.0, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = 1_700_000_000_000
    eng.hold_ms[inst] = 360_000
    eng.opened_h[inst] = "1m"
    eng._snapshot({"equity": 10_000.0})

    repris, _ = _moteur_pos(tmp_path, {inst: 1.0})
    assert repris.brackets[inst]["entry"] == 100.0
    assert repris.brackets[inst]["sortie_temps"] is True
    assert repris.opened_bar[inst] == 1_700_000_000_000
    assert repris.hold_ms[inst] == 360_000
    assert repris.opened_h[inst] == "1m"


def test_a_restarted_position_still_answers_to_its_stop(tmp_path):
    """Le test qui compte : après reprise, le stop doit encore sortir."""
    inst = "BTC-USDT-SWAP"
    eng, _ = _moteur_pos(tmp_path, {inst: 1.0})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 99.0,
                          "tp": 101.0, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 360_000
    eng._snapshot({"equity": 10_000.0})

    repris, b = _moteur_pos(tmp_path, {inst: 1.0})
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
    eng, b = _moteur_pos(tmp_path, {inst: 1.0})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 1.0,
                          "tp": 1e9, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 360_000
    eng.ticks[inst] = {"last": 100.0, "bid": 100.0, "ask": 100.1,
                       "spread_bps": 2.0}
    eng._orphelines({})           # lecture tronquée
    eng._orphelines({inst: 1.0})  # l'échange répond de nouveau
    assert eng.brackets.get(inst), "le bracket a été effacé sur un hoquet"
    assert eng.check_exits() == []
    assert b.pos[inst] == 1.0


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


def test_the_real_entry_delay_gets_measured(tmp_path):
    """La porte mesure une entrée AU PRIX DE CLÔTURE de la barre. Tant que
    le retard réel entre la cible et l'ordre qui la joue n'est pas au
    relevé, l'écart entre la règle mesurée et la règle jouée reste une
    supposition — et c'est exactement le genre d'hypothèse qui fait perdre
    de l'argent à une règle mesurée gagnante."""
    inst = "BTC-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path)
    eng.ticks[inst] = {"last": 100.0, "bid": 99.9, "ask": 100.1,
                       "spread_bps": 2.0}
    eng.last_preds = [{"inst": inst, "policy": "candle", "bar": "1m",
                       "dir": "long", "ml": "live", "conf": 1.0,
                       "h_bars": 6, "edge_bps": 12.0, "lev": 1.0,
                       "vol_bps": 25.0, "tp_bps": 30.0, "sl_bps": 40.0,
                       "sortie_temps": True}]
    eng._vol = {inst: 25.0}
    eng.pending = {inst: 1.0}
    eng._pending_ts = time.time() - 41.0
    eng.execute_pending()
    assert eng.exec_stats["n_entrees"] == 1
    assert 40.0 <= eng.exec_stats["retard_s"] <= 45.0, eng.exec_stats

    # et la mesure survit au redémarrage, comme les autres compteurs
    eng._snapshot({"equity": 10_000.0})
    repris, _ = _moteur_pos(tmp_path, dict(b.pos))
    assert repris.exec_stats["n_entrees"] == 1
    assert 40.0 <= repris.exec_stats["retard_s"] <= 45.0


def test_the_size_the_edge_alone_would_justify_is_published(tmp_path):
    """« La règle est faible » et « la règle est bridée » sont deux
    problèmes opposés, et rien au relevé ne les distinguait. Le calculer
    par division serait faux : le plafond de ruine borne le levier AVANT
    le frein, donc quand il mord, retirer le frein ne change rien."""
    eng, _ = _moteur_pos(tmp_path)
    eng._risk_scale = lambda: 0.25
    eng.live_stats = {"n": 0, "bps": 0.0}
    p = {"inst": "XRP-USDT-SWAP", "dir": "short", "policy": "candle",
         "bar": "1m", "ml": "live", "conf": 1.0, "h_bars": 6,
         "edge_bps": -6.7,
         "vol_bps": 30.0, "tp_bps": 40.0, "sl_bps": 353.0,
         "cost_bps": 9.0, "cost_tp_bps": 4.0,
         "net_bps": 16.3, "net_sd": 72.9, "net_n": 337,
         "sortie_temps": True}
    w = abs(eng._targets([p])["XRP-USDT-SWAP"])
    plein = float(p["poids_plein"])
    assert plein > w > 0
    # le rodage seul explique l'écart : le plafond de ruine mord, donc le
    # frein de 0,25 ne retire rien de plus
    assert abs(plein * eng._confiance() - w) < 1e-9, (plein, w)

    # sans plafond mordant, le frein compte bien dans l'écart
    q = dict(p, sl_bps=8.0)
    wq = abs(eng._targets([q])["XRP-USDT-SWAP"])
    assert float(q["poids_plein"]) > wq / eng._confiance() + 1e-9, \
        "plafond non mordant : le frein doit compter en plus du rodage"


def test_dust_is_not_a_position(tmp_path):
    """Un reliquat de 1,2e-10 DOGE — un dix-milliardième de cent — passait
    le seuil de QUANTITÉ, se faisait déclarer orpheline à chaque cycle, et
    recevait un ordre de sortie que l'arrondi de l'échange ramenait à zéro.
    Le reliquat restait, le journal se remplissait, la sortie ne sortait
    rien. Le seuil doit être en argent, pas en quantité."""
    inst = "DOGE-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: 1.1641532182693481e-10})
    dits = []
    eng.log = dits.append
    eng.ticks[inst] = {"last": 0.0916, "bid": 0.0915, "ask": 0.0917,
                       "spread_bps": 2.0}
    for _ in range(3):
        assert eng.check_exits() == []
    assert not any("orpheline" in m for m in dits), dits
    assert not b.ordres, "un ordre a été envoyé pour de la poussière"

    # une vraie position, elle, reste vue
    b.pos[inst] = -3320.0
    assert eng.check_exits() == []          # premier constat
    assert inst in eng.check_exits()        # second : sortie
    assert any("orpheline" in m for m in dits), dits


def test_a_close_carries_its_own_result(tmp_path):
    """« Il fait n'importe quoi » est une accusation sur la façon dont les
    positions se ferment, et le journal ne portait que des prix : il
    fallait réapparier à la main entrées et sorties, et une sortie par
    stop ne se distinguait pas d'une sortie à l'horizon mesuré."""
    inst = "BTC-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: 1.0})
    eng.brackets[inst] = {"side": "long", "entry": 100.0, "sl": 99.0,
                          "tp": 1e9, "sl_bps": 100.0, "tp_bps": 100.0,
                          "sortie_temps": True, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 360_000
    eng.ticks[inst] = {"last": 98.5, "bid": 98.5, "ask": 98.6,
                       "spread_bps": 2.0}
    assert inst in eng.check_exits()

    ferm = [t for t in eng.trades if t.get("net_bps") is not None]
    assert len(ferm) == 1, eng.trades
    assert ferm[0]["reason"].startswith("SL")
    assert ferm[0]["net_bps"] == eng.live_stats["bps"]
    assert ferm[0]["net_bps"] < 0

    # une ouverture n'a pas de résultat : la colonne doit rester vide
    eng._record(b.market_order(inst, 1.0, 100.0), 1.0, "open", 1.0)
    assert eng.trades[-1]["net_bps"] is None


def test_sizing_uses_the_deflated_net_not_the_raw_winner(tmp_path):
    """Le net publié est le maximum d'une recherche sur ~1300 cellules, et
    Kelly est proportionnel à mu. La porte déduisait la prime de sélection
    pour DÉCIDER (sr > barre) et jamais pour DIMENSIONNER. Mesuré sur douze
    ajustements de l'horloge 1m : brut +14,66 bps/trade, déflaté +2,97, et
    le direct sur 22 trades +3,74 — le déflaté prédit le direct à moins
    d'un bps, le brut le surestime d'un facteur cinq."""
    eng, _ = _moteur_pos(tmp_path)
    eng._risk_scale = lambda: 1.0
    base = {"inst": "XRP-USDT-SWAP", "dir": "short", "policy": "candle",
            "bar": "1m", "ml": "live", "conf": 1.0, "h_bars": 6,
            "edge_bps": -12.0, "vol_bps": 30.0, "tp_bps": 40.0,
            "sl_bps": 8.0, "cost_bps": 9.0, "cost_tp_bps": 4.0,
            "net_bps": 20.54, "net_sd": 82.5, "net_n": 309,
            "sortie_temps": True}
    brut = eng._pick_lev(dict(base))
    defl = eng._pick_lev(dict(base, net_defl=4.87))
    assert 0 < defl < brut
    assert brut / defl > 3.0, f"brut {brut:.3f} vs deflate {defl:.3f}"

    # sans champ déflaté — une porte d'une version antérieure — on retombe
    # sur l'ancienne borne basse, jamais sur le brut nu
    mu = (20.54 - 82.5 / 309 ** 0.5) * 1e-4
    sd = 82.5e-4
    attendu = 0.25 * mu / (mu * mu + sd * sd)
    assert abs(brut - attendu) < 1e-6, (brut, attendu)

    # un déflaté plus GÉNÉREUX que le brut ne peut pas agrandir la position
    assert eng._pick_lev(dict(base, net_defl=99.0)) <= brut + 1e-9


def test_the_gate_publishes_its_deflated_net(tmp_path):
    """La déflation doit voyager depuis la cellule retenue jusquau moteur."""
    rng = np.random.default_rng(5)
    m = CandleModel("5m")
    series = [(_marche(np.random.default_rng(100 + k)), None) for k in range(3)]
    d = m.fit_panel(series)
    assert "net_defl" in d
    assert d["net_defl"] >= 0.0
    if d["status"] == "live":
        assert 0.0 < d["net_defl"] <= d["holdout_bps"] + 1e-9
        v = m.predict_row(np.zeros(m.n_features) if hasattr(m, "n_features")
                          else np.zeros(27), 1e-3)
        assert "net_defl" in v


def test_the_panel_is_the_most_traded_names_not_a_hardcoded_list(tmp_path):
    """`refresh_universe` recevait les tickers et les jetait : elle recopiait
    six noms écrits en dur. Or l'horloge est un PANEL jugé sur le rendement
    de portefeuille à chaque instant — chaque jambe de plus moyenne une
    variance idiosyncratique de plus, et la dimension « actif » ne coûte
    aucune barre dès que le panel en compte au moins deux."""
    eng, _ = _moteur_pos(tmp_path)
    eng.universe_n = 4
    eng.min_vol = 1_000_000.0
    eng.max_spread = 6.0
    t = {
        "AAA-USDT-SWAP":  {"vol_usd": 9e9, "spread_bps": 1.0, "last": 1.0},
        "BBB-USDT-SWAP":  {"vol_usd": 8e9, "spread_bps": 1.0, "last": 1.0},
        "CCC-USDT-SWAP":  {"vol_usd": 7e9, "spread_bps": 1.0, "last": 1.0},
        "DDD-USDT-SWAP":  {"vol_usd": 6e9, "spread_bps": 1.0, "last": 1.0},
        "EEE-USDT-SWAP":  {"vol_usd": 5e9, "spread_bps": 1.0, "last": 1.0},
        # écarté : fourchette trop large malgré un gros volume
        "LARGE-USDT-SWAP": {"vol_usd": 9.5e9, "spread_bps": 40.0, "last": 1.0},
        # écarté : trop peu échangé
        "PETIT-USDT-SWAP": {"vol_usd": 1e5, "spread_bps": 1.0, "last": 1.0},
        # écarté : pas un perpétuel USDT
        "AAA-USD-SWAP":    {"vol_usd": 9e9, "spread_bps": 1.0, "last": 1.0},
    }
    uni = eng.refresh_universe(t)
    assert len(uni) == 4
    assert "LARGE-USDT-SWAP" not in uni, "une fourchette de 40 bps mange l'avantage"
    assert "PETIT-USDT-SWAP" not in uni
    assert "AAA-USD-SWAP" not in uni
    # classés par volume réel, sans place réservée : BTC n'est pas forcé
    # dans le panel, il est ramassé comme SOURCE de la colonne de décalage
    assert uni == ["AAA-USDT-SWAP", "BBB-USDT-SWAP",
                   "CCC-USDT-SWAP", "DDD-USDT-SWAP"]


def test_the_panel_does_not_change_identity_every_quarter_hour(tmp_path):
    """Le classement par volume bouge en permanence au voisinage du rang N.
    Sans hystérésis le panel changerait d'identité toutes les quinze
    minutes — exactement le défaut mesuré sur la cellule de la porte."""
    eng, _ = _moteur_pos(tmp_path)
    eng.universe_n = 3
    eng.min_vol = 1_000.0
    base = {f"{c}-USDT-SWAP": {"vol_usd": v, "spread_bps": 1.0, "last": 1.0}
            for c, v in (("AAA", 9e9), ("BBB", 8e9), ("CCC", 7e9),
                         ("DDD", 6.9e9), ("EEE", 6e9), ("FFF", 5e9))}
    eng.refresh_universe(base)
    avant = list(eng.instruments)
    assert avant == ["AAA-USDT-SWAP", "BBB-USDT-SWAP", "CCC-USDT-SWAP"]

    # CCC et DDD permutent d'un cheveu : le panel ne doit pas bouger
    base["DDD-USDT-SWAP"]["vol_usd"] = 7.05e9
    assert eng.refresh_universe(base) == avant

    # en revanche un vrai effondrement le fait sortir du filet (1,5 x N)
    base["CCC-USDT-SWAP"]["vol_usd"] = 1e6
    apres = eng.refresh_universe(base)
    assert "CCC-USDT-SWAP" not in apres, apres
    assert "DDD-USDT-SWAP" in apres


def test_a_validated_trailing_stop_is_actually_played(tmp_path):
    """Un suiveur mesuré par la porte puis joué en stop fixe serait une
    AUTRE règle que celle qui a été prouvée — exactement le défaut corrigé
    ce matin sur la LARGEUR du stop, ici sur son MODE."""
    inst = "BTC-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: 1.0})
    eng.brackets[inst] = {"side": "long", "entry": 100.0,
                          "sl": 90.0, "tp": 1e9,
                          "sl_bps": 200.0, "tp_bps": 400.0,
                          "sortie_temps": True, "stop_mode": "suiv",
                          "sommet": 100.0, "trail": 98.0, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 3_600_000

    # le prix monte : le sommet suit, le niveau monte avec lui
    eng.ticks[inst] = {"last": 110.0, "bid": 110.0, "ask": 110.1,
                       "spread_bps": 2.0}
    assert eng.check_exits() == []
    assert eng.brackets[inst]["sommet"] == 110.0
    assert abs(eng.brackets[inst]["trail"] - 107.8) < 1e-9

    # il redescend de 2 % sous le sommet : le suiveur sort, et le stop
    # FIXE à 90 n'aurait rien fait
    eng.ticks[inst] = {"last": 107.0, "bid": 107.0, "ask": 107.1,
                       "spread_bps": 2.0}
    touches = eng.check_exits()
    assert inst in touches
    assert eng.trades[-1]["reason"].startswith("TRAIL")
    assert eng.live_stats["n"] == 1
    assert eng.live_stats["bps"] > 0, "le suiveur doit verrouiller le gain"


def test_the_trailing_summit_never_falls_back(tmp_path):
    """Le sommet ne redescend jamais : un suiveur qui se relâcherait quand
    le prix recule ne serait plus un suiveur."""
    inst = "BTC-USDT-SWAP"
    eng, _ = _moteur_pos(tmp_path, {inst: -1.0})
    eng.brackets[inst] = {"side": "short", "entry": 100.0,
                          "sl": 110.0, "tp": 0.0,
                          "sl_bps": 300.0, "tp_bps": 400.0,
                          "sortie_temps": True, "stop_mode": "suiv",
                          "sommet": 100.0, "trail": 103.0, "t0": 1}
    eng.opened_bar[inst] = int(time.time() * 1000)
    eng.hold_ms[inst] = 3_600_000
    for px in (95.0, 92.0, 94.0):
        eng.ticks[inst] = {"last": px, "bid": px - 0.05, "ask": px,
                           "spread_bps": 2.0}
        eng.check_exits()
    assert eng.brackets[inst]["sommet"] == 92.0, "le sommet a reculé"
    assert abs(eng.brackets[inst]["trail"] - 92.0 * 1.03) < 1e-9


def test_dust_does_not_turn_the_next_entry_into_a_resize(tmp_path):
    """Un reliquat de poussière faisait passer la vraie entrée suivante
    pour un redimensionnement. Or seul un redimensionnement n'arme AUCUN
    bracket : la position naissait sans propriétaire, le balayage la
    déclarait orpheline au tour suivant et la refermait, le desk la
    rouvrait. Mesuré : DOGE ouvert et déclaré orphelin quatre fois en huit
    minutes, en payant l'aller-retour à chaque tour."""
    inst = "DOGE-USDT-SWAP"
    # 10 DOGE a 0,092 = 92 centimes : de la poussiere, pas une position
    eng, b = _moteur_pos(tmp_path, {inst: -10.0})
    eng.ticks[inst] = {"last": 0.092, "bid": 0.0919, "ask": 0.0921,
                       "spread_bps": 2.0}
    eng.last_preds = [{"inst": inst, "policy": "candle", "bar": "1m",
                       "dir": "short", "ml": "live", "conf": 1.0,
                       "edge_bps": -12.0, "h_bars": 6, "lev": 1.0,
                       "vol_bps": 25.0, "tp_bps": 400.0, "sl_bps": 300.0,
                       "sortie_temps": True}]
    eng._vol = {inst: 25.0}
    eng.pending = {inst: -3200.0}
    eng.execute_pending()

    assert eng.brackets.get(inst), "l'entrée n'a armé aucun bracket"
    assert eng.opened_bar.get(inst), "aucune horloge de tenue"
    # et donc le balayage ne la prend pas pour une orpheline
    dits = []
    eng.log = dits.append
    eng.check_exits(); eng.check_exits()
    assert not any("orpheline" in m for m in dits), dits


def test_a_tokenised_stock_never_enters_the_crypto_panel(tmp_path):
    """Le classement par volume seul ramène des ACTIONS et des matières
    premières tokenisées — SanDisk, SK Hynix, SpaceX, l'or — qui figurent
    parmi les perpétuels USDT les plus échangés d'OKX. Le panel divise les
    actifs par leur sigma en supposant qu'ils partagent la MÊME horloge :
    un instrument qui s'arrête le week-end n'en partage aucune, et la
    colonne de décalage BTC n'a aucun sens pour lui."""
    import numpy as np
    from hermes.data.store import Candles

    def serie(nom, couverture):
        """couverture = fraction des barres d'une minute réellement là."""
        n = 6000
        pas = int(round(60_000 / couverture))
        ts = np.arange(n, dtype=np.int64) * pas
        px = 100 + np.zeros(n)
        return Candles(nom, "1m", ts, px, px, px, px, np.ones(n))

    class _Magasin:
        def load(self, inst, bar, **kw):
            return serie(inst, 0.995 if inst.startswith("SOL") else 5 / 7)

    eng, _ = _moteur_pos(tmp_path)
    eng.store = _Magasin()
    assert eng._assez_dhistoire("SOL-USDT-SWAP") is True
    assert eng._assez_dhistoire("XAU-USDT-SWAP") is False, \
        "un instrument qui s'arrête le week-end est entré au panel"
    assert eng._assez_dhistoire("SKHYNIX-USDT-SWAP") is False

    # et un nom sans histoire du tout reste dehors
    class _Vide:
        def load(self, inst, bar, **kw):
            return serie(inst, 0.99)._replace(ts=np.arange(10, dtype=np.int64)) \
                if hasattr(serie(inst, 0.99), "_replace") else None
    eng.store = type("V", (), {"load": lambda self, i, b, **k: None})()
    assert eng._assez_dhistoire("NEUF-USDT-SWAP") is False


def test_a_rejected_name_is_never_chased_again(tmp_path):
    """Un nom écarté par la continuité restait « réclamé par le volume,
    pas encore prêt » et se faisait rattraper à chaque tour — un puits
    sans fond pour le quota d'appels, sur un actif qui n'entrera jamais."""
    import numpy as np
    from hermes.data.store import Candles

    def serie(nom, couv):
        n = 6000
        ts = np.arange(n, dtype=np.int64) * int(round(60_000 / couv))
        px = 100 + np.zeros(n)
        return Candles(nom, "1m", ts, px, px, px, px, np.ones(n))

    eng, _ = _moteur_pos(tmp_path)
    eng.universe_n = 3
    eng.min_vol = 1_000.0
    eng.store = type("M", (), {
        "load": lambda self, i, b, **k: serie(i, 5 / 7 if i.startswith("XAU")
                                              else 0.995)})()
    t = {f"{c}-USDT-SWAP": {"vol_usd": v, "spread_bps": 1.0, "last": 1.0}
         for c, v in (("XAU", 9e9), ("AAA", 8e9), ("BBB", 7e9), ("CCC", 6e9))}
    uni = eng.refresh_universe(t)
    assert "XAU-USDT-SWAP" not in uni
    assert "XAU-USDT-SWAP" in eng.recales, "le verdict n'est pas retenu"
    # ...et il ne revient plus au classement, malgré le plus gros volume
    assert "XAU-USDT-SWAP" not in eng.classement(t)
    assert "XAU-USDT-SWAP" not in eng.attendus, \
        "l'actif recalé serait rattrapé à chaque tour"


def test_the_ledger_explains_every_dollar_of_the_equity_curve():
    """« Il fait n importe quoi » est une accusation qu on ne peut ni
    confirmer ni refuter avec l equite seule.

    Le compte etait a -6,4 % pendant que la regle mesuree affichait
    -0,22 bps sur 53 trades : ces deux chiffres ne peuvent pas etre vrais
    ensemble sans une troisieme colonne. -0,22 bps sur un notionnel de
    quelques centaines de dollars, ce sont des cents ; le recul, lui, se
    compte en centaines de dollars. La difference est ailleurs — frais des
    trades NON mesures, financement, liquidation — et le journal des fills
    est plafonne a deux cents lignes, donc incapable de repondre pour une
    semaine.

    Le livre repond, et il doit repondre EXACTEMENT : capital de depart
    plus brut realise, moins frais, moins financement, egale l equite au
    centime — sinon il manque un poste et le diagnostic ment.
    """
    from hermes.exchange.broker import PaperBroker

    b = PaperBroker(cash=10_000.0)
    b.mark_prices({"A-USDT-SWAP": 100.0, "B-USDT-SWAP": 50.0})
    b.market_order("A-USDT-SWAP", 2.0, 100.0)
    b.market_order("B-USDT-SWAP", -3.0, 50.0)
    b.apply_funding("A-USDT-SWAP", 1e-4)          # long paie
    b.apply_funding("B-USDT-SWAP", 1e-4)          # short encaisse
    b.mark_prices({"A-USDT-SWAP": 101.0, "B-USDT-SWAP": 49.0})
    b.market_order("A-USDT-SWAP", -2.0, 101.0)    # ferme, realise
    b.mark_prices({"B-USDT-SWAP": 48.0})          # l autre reste ouverte

    upnl = b.equity() - b.cash
    recon = (b.depart + b.livre["brut"] - b.livre["frais"]
             - b.livre["funding"] + upnl)
    assert abs(recon - b.equity()) < 1e-9, (
        f"le livre laisse {b.equity() - recon:+.6f} USD inexplique")
    assert b.livre["n"] == 3 and b.livre["notionnel"] > 0
    # Le financement n est pas nul et il a un SENS : le long paie, le
    # short encaisse. Les deux notionnels sont DELIBEREMENT differents —
    # 200 contre 150 — car a notionnels egaux la somme vaut exactement
    # zero et le test passerait sans rien prouver.
    assert b.livre["funding"] > 0.0, "le long paie plus que le short n encaisse"


def test_the_ledger_survives_a_restart():
    """Un compteur de vie entiere qui repart a zero a chaque mise en ligne
    ne mesure plus rien. Il traverse la persistance, comme la mesure de la
    regle — et un fichier tronque le laisse simplement en place."""
    from hermes.exchange.broker import PaperBroker

    b = PaperBroker(cash=10_000.0)
    b.mark_prices({"A-USDT-SWAP": 100.0})
    b.market_order("A-USDT-SWAP", 1.0, 100.0)
    b.market_order("A-USDT-SWAP", -1.0, 99.0)
    d = b.to_dict()

    c = PaperBroker(cash=10_000.0)
    c.restore(d)
    assert c.livre == b.livre and c.depart == b.depart

    e = PaperBroker(cash=10_000.0)
    e.restore({"cash": 9_000.0, "livre": {"frais": "beaucoup", "n": None}})
    assert e.livre["frais"] == 0.0 and e.livre["n"] == 0


def test_the_ledger_names_the_past_it_did_not_see():
    """Le livre arrive sur un compte qui trade deja depuis une semaine.

    Tout ce passe-la — des milliers de fills payes par une version
    anterieure — n est PAS dans ses compteurs. Le laisser tomber dans le
    latent produirait un releve qui accuse le marche d un recul cause par
    les frais. On le nomme : une ligne « avant le livre », non decomposee,
    honnete sur ce qu elle ignore, et l identite continue de boucler au
    centime.
    """
    from hermes.exchange.broker import PaperBroker

    b = PaperBroker(cash=10_000.0)
    b.restore({"cash": 9_338.97, "pos": {}, "prices": {},
               "entry": {}, "margin_mode": True})
    assert abs(b.livre["avant"] - (9_338.97 - 10_000.0)) < 1e-9
    recon = (b.depart + b.livre["avant"] + b.livre["brut"]
             - b.livre["frais"] - b.livre["funding"])
    assert abs(b.equity() - recon) < 1e-9

    # Et une fois que le livre existe, il ne se re-attribue plus le passe
    # a chaque redemarrage — sinon la ligne doublerait a chaque mise en
    # ligne et le total exploserait.
    b.mark_prices({"A-USDT-SWAP": 100.0})
    b.market_order("A-USDT-SWAP", 1.0, 100.0)
    b.market_order("A-USDT-SWAP", -1.0, 99.0)
    c = PaperBroker(cash=10_000.0)
    c.restore(b.to_dict())
    assert abs(c.livre["avant"] - b.livre["avant"]) < 1e-9
    d = PaperBroker(cash=10_000.0)
    d.restore(c.to_dict())
    assert abs(d.livre["avant"] - b.livre["avant"]) < 1e-9


def test_a_stock_that_prints_flat_candles_is_still_not_a_crypto(tmp_path):
    """Le premier critere comptait les BARRES PRESENTES, et il a laisse
    passer SNDK, XAU et SKHYNIX — mesure en production, journal du
    24 aout : « scalp universe 20: BTC,ETH,SOL,XRP,DOGE,BNB,SNDK,ZEC,
    TRUMP,HYPE,XAU,SKHYNIX… ».

    Ces perpetuels publient bien une bougie d une minute la nuit et le
    week-end ; elle est simplement PLATE. Un compte de barres ne
    distingue pas une bougie vide d une bougie vivante. L amplitude du
    week-end rapportee a celle des jours ouvres, elle, les separe de
    deux ordres de grandeur.
    """
    import numpy as np
    from hermes.data.store import Candles

    def serie(nom, vivant_le_weekend):
        n = 20_000                      # ~14 jours : deux week-ends
        ts = np.arange(n, dtype=np.int64) * 60_000
        jour = ((ts // 86_400_000) + 4) % 7      # 1970-01-01 = jeudi
        we = jour >= 5
        rng = np.random.default_rng(4)
        r = rng.normal(0, 4e-4, n)
        if not vivant_le_weekend:
            r[we] = 0.0                 # la bougie existe, le prix dort
        px = 100 * np.exp(np.cumsum(r))
        return Candles(nom, "1m", ts, px, px, px, px, np.ones(n))

    eng, _ = _moteur_pos(tmp_path)
    eng.store = type("M", (), {
        "load": lambda self, i, b, **k: serie(i, not i.startswith("SNDK"))})()
    assert eng._assez_dhistoire("SOL-USDT-SWAP") is True
    assert eng._assez_dhistoire("SNDK-USDT-SWAP") is False, \
        "une action tokenisee aux bougies plates est entree au panel"
    assert "SNDK-USDT-SWAP" in eng.recales

    # Contre-epreuve : le critere ne doit pas se declencher sur un
    # week-end simplement plus CALME, ce qui est le cas de toutes les
    # cryptos. A 70 % de l amplitude des jours ouvres, le nom passe.
    def calme(nom):
        n = 20_000
        ts = np.arange(n, dtype=np.int64) * 60_000
        jour = ((ts // 86_400_000) + 4) % 7
        rng = np.random.default_rng(5)
        r = rng.normal(0, 4e-4, n)
        r[jour >= 5] *= 0.7
        px = 100 * np.exp(np.cumsum(r))
        return Candles(nom, "1m", ts, px, px, px, px, np.ones(n))

    eng.store = type("M", (), {"load": lambda self, i, b, **k: calme(i)})()
    assert eng._assez_dhistoire("DOGE-USDT-SWAP") is True, \
        "un week-end plus calme n est pas un week-end mort"


def test_the_backfill_queue_goes_as_deep_as_the_ranking_needs(tmp_path):
    """Les vingt premiers ELIGIBLES, pas les eligibles parmi les vingt
    premiers.

    La boucle de remplissage parcourt tout le classement ; la file de
    rattrapage s arretait au rang N. Quand les premiers rangs sont pris
    par des noms recales, les eligibles suivants n etaient donc jamais
    rattrapes, donc jamais eligibles — mesure en production, le panel
    restait a six pendant que le journal affichait « desk panel vise 1 ».
    """
    import numpy as np
    from hermes.data.store import Candles

    def serie(nom, couv):
        n = 6000
        ts = np.arange(n, dtype=np.int64) * int(round(60_000 / couv))
        px = 100 + np.zeros(n)
        return Candles(nom, "1m", ts, px, px, px, px, np.ones(n))

    eng, _ = _moteur_pos(tmp_path)
    eng.universe_n = 4
    eng.min_vol = 1_000.0
    eng.instruments = []
    # Les quatre premiers par volume sont des actions tokenisees ; les
    # quatre suivants sont de vraies cryptos, sans histoire stockee.
    faux = {"SNDK", "XAU", "SKHYNIX", "SPACEX"}
    eng.store = type("M", (), {
        "load": lambda self, i, b, **k: (
            serie(i, 5 / 7) if i.split("-")[0] in faux else None)})()
    vols = (("SNDK", 9e9), ("XAU", 8e9), ("SKHYNIX", 7e9), ("SPACEX", 6e9),
            ("AAA", 5e9), ("BBB", 4e9), ("CCC", 3e9), ("DDD", 2e9))
    t = {f"{c}-USDT-SWAP": {"vol_usd": v, "spread_bps": 1.0, "last": 1.0}
         for c, v in vols}

    uni = eng.refresh_universe(t)
    assert uni == [], "aucun nom n a encore d histoire"
    attendus = [i.split("-")[0] for i in eng.attendus]
    assert attendus == ["AAA", "BBB", "CCC", "DDD"], attendus
    assert not (set(attendus) & faux), "un nom recale serait rattrape"


def test_an_incumbent_is_judged_too_not_kept_on_volume_alone(tmp_path):
    """Un nom deja au panel y restait tant que son volume le tenait dans
    les 1,5 N premiers — sans repasser une seule fois par la continuite.

    Les six noms ecrits dans la configuration entraient donc au panel
    sans examen, et un nom admis avant que le critere existe n aurait
    jamais ete rejuge. On juge tout le monde une fois ; le verdict est
    ensuite en cache, parce que la nature d un actif ne change pas.
    """
    import numpy as np
    from hermes.data.store import Candles

    def serie(nom, couv):
        n = 6000
        ts = np.arange(n, dtype=np.int64) * int(round(60_000 / couv))
        px = 100 + np.zeros(n)
        return Candles(nom, "1m", ts, px, px, px, px, np.ones(n))

    eng, _ = _moteur_pos(tmp_path)
    eng.universe_n = 3
    eng.min_vol = 1_000.0
    # XAU siege deja au panel, comme en production
    eng.instruments = ["XAU-USDT-SWAP", "AAA-USDT-SWAP"]
    lectures = []

    def load(self, i, b, **k):
        lectures.append(i)
        return serie(i, 5 / 7 if i.startswith("XAU") else 0.995)

    eng.store = type("M", (), {"load": load})()
    t = {f"{c}-USDT-SWAP": {"vol_usd": v, "spread_bps": 1.0, "last": 1.0}
         for c, v in (("XAU", 9e9), ("AAA", 8e9), ("BBB", 7e9))}

    uni = eng.refresh_universe(t)
    assert "XAU-USDT-SWAP" not in uni, "un incumbent echappe a l examen"
    assert "AAA-USDT-SWAP" in uni

    # Deuxieme tour : le verdict est en cache, on ne relit pas la base
    # pour un nom deja admis.
    lectures.clear()
    eng.refresh_universe(t)
    assert "AAA-USDT-SWAP" not in lectures, \
        "l incumbent admis est relu a chaque tour"


def test_the_measured_entry_slippage_is_charged_never_credited(tmp_path):
    """Le retard d entree etait mesure — 1,3 s sur 252 ordres — et la
    porte continuait de supposer zero.

    Ce que ce retard coute ne se deduit pas d une formule : entre la
    cloture de la barre qui decide et le remplissage, le prix bouge, et
    il bouge dans le sens du signal assez souvent pour manger l avantage.
    On mesure donc le prix paye contre le prix du signal, signe par le
    sens, et on le facture au cout.

    Asymetrique et delibere : un glissement defavorable monte le cout, un
    glissement favorable est ignore. Une mesure bruitee ne doit jamais
    pouvoir ABAISSER la barre.
    """
    eng, _ = _moteur_pos(tmp_path)
    assert eng._glissement() == 0.0, "rien n est facture sans mesure"

    # Vingt-neuf ouvertures defavorables : sous le seuil, rien n est
    # facture — une moyenne sur si peu ne merite pas de decider.
    eng.exec_stats["glissement_bps"] = 3.0
    eng.exec_stats["n_gliss"] = 29
    assert eng._glissement() == 0.0
    eng.exec_stats["n_gliss"] = 30
    assert eng._glissement() == 3.0, "le cout mesure n est pas facture"

    # Et un glissement FAVORABLE, aussi bien mesure soit-il, ne rend rien.
    eng.exec_stats["glissement_bps"] = -4.0
    eng.exec_stats["n_gliss"] = 500
    assert eng._glissement() == 0.0, "une mesure favorable abaisse la barre"


def test_the_slippage_measured_is_the_signal_price_against_the_fill(tmp_path):
    """Ce qui est mesure doit etre la bonne quantite : le prix paye contre
    le prix SUR LEQUEL LA DECISION A ETE PRISE, pas contre le mid courant.

    Un long rempli au-dessus du prix du signal paie ; un court rempli
    au-dessus encaisse. Le signe compte, et il se trompe facilement.
    """
    inst = "BTC-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path)
    # Le signal a ete calcule a 100 ; le carnet est deja monte a 100,10.
    eng.ticks[inst] = {"last": 100.1, "bid": 100.0, "ask": 100.2,
                       "spread_bps": 2.0}
    eng.last_preds = [{"inst": inst, "policy": "candle", "bar": "1m",
                       "dir": "long", "ml": "live", "conf": 1.0, "px": 100.0,
                       "h_bars": 6, "edge_bps": 12.0, "lev": 1.0,
                       "vol_bps": 25.0, "tp_bps": 30.0, "sl_bps": 40.0,
                       "sortie_temps": True}]
    eng._vol = {inst: 25.0}
    eng.pending = {inst: 1.0}
    eng.execute_pending()
    assert eng.exec_stats["n_gliss"] == 1
    assert eng.exec_stats["glissement_bps"] > 0.0, \
        "un long rempli au-dessus du prix du signal a PAYE"

    # Meme ecart de prix, sens oppose : le court a encaisse. Repertoire
    # d etat separe : execute_pending ecrit un instantane, et un second
    # moteur sur le meme repertoire reprendrait le compteur du premier.
    autre = tmp_path / "second"
    autre.mkdir()
    eng2, _ = _moteur_pos(autre)
    eng2.ticks[inst] = {"last": 100.1, "bid": 100.0, "ask": 100.2,
                        "spread_bps": 2.0}
    eng2.last_preds = [dict(eng.last_preds[0], dir="short", edge_bps=-12.0)]
    eng2._vol = {inst: 25.0}
    eng2.pending = {inst: -1.0}
    eng2.execute_pending()
    assert eng2.exec_stats["n_gliss"] == 1
    assert eng2.exec_stats["glissement_bps"] < 0.0, \
        "le signe du glissement suit le sens de la position"


def test_a_dust_position_can_still_be_closed(tmp_path):
    """Le plancher d ordre economisait les frais d un ajustement qui ne
    valait pas son aller-retour — et il s appliquait aussi aux
    FERMETURES. Une position tombee sous le plancher ne pouvait donc plus
    jamais etre refermee.

    Mesure en production : un reliquat de -10 DOGE, 89 centimes, laisse
    par l arrondi de lot, affiche a l ecran comme une position ouverte
    des heures durant. Exactement la « micro position » qu on reproche au
    moteur, et elle etait immortelle.
    """
    inst = "DOGE-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: -10.0})
    eng.ticks[inst] = {"last": 0.0888, "bid": 0.0887, "ask": 0.0889,
                       "spread_bps": 2.0}
    eng.last_preds = []
    eng.pending = {inst: 0.0}
    eng.execute_pending()
    assert abs(b.pos.get(inst, 0.0)) < 1e-9, \
        f"la poussiere survit : {b.pos.get(inst)}"

    # Et le plancher tient toujours pour ce a quoi il sert : un
    # AJUSTEMENT minuscule ne paie pas son aller-retour.
    autre = tmp_path / "b"
    autre.mkdir()
    eng2, b2 = _moteur_pos(autre, {inst: -10_000.0})
    eng2.ticks[inst] = dict(eng.ticks[inst])
    eng2.last_preds = []
    eng2.pending = {inst: -9_990.0}
    eng2.execute_pending()
    assert abs(b2.pos[inst] + 10_000.0) < 1e-6, "l ajustement de 89 cents est passe"


def test_ownerless_dust_gets_swept_even_without_a_target(tmp_path):
    """Le plancher d ordre laisse desormais passer une FERMETURE — encore
    faut-il qu une cible zero soit emise, et un nom sans signal n en
    recoit aucune.

    Mesure en direct, deux heures apres le correctif precedent : -10 DOGE,
    89 centimes, toujours au livre, affiches a l ecran comme une position
    ouverte. Le balayage ferme ce qui est sous le plancher ET sans
    proprietaire ; ce qui porte encore un bracket est un vrai trade en
    cours, meme petit, et n est pas touche.
    """
    inst = "DOGE-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path, {inst: -10.0})
    eng.ticks[inst] = {"last": 0.0888, "bid": 0.0887, "ask": 0.0889,
                       "spread_bps": 2.0}
    dits = []
    eng.log = dits.append
    eng._balayer_poussiere()
    assert abs(b.pos.get(inst, 0.0)) < 1e-9, f"reste {b.pos.get(inst)}"
    assert any("poussiere" in m for m in dits), dits

    # Un vrai trade sous le plancher — rare mais possible — garde son
    # bracket et n est pas balaye : c est check_exits qui le pilote.
    autre = tmp_path / "b"
    autre.mkdir()
    eng2, b2 = _moteur_pos(autre, {inst: -10.0})
    eng2.ticks[inst] = dict(eng.ticks[inst])
    eng2.brackets[inst] = {"side": "short", "entry": 0.0888, "sl": 0.09,
                           "tp": 0.087, "sl_bps": 100.0, "tp_bps": 100.0,
                           "sortie_temps": True, "t0": 1}
    eng2._balayer_poussiere()
    assert abs(b2.pos[inst] + 10.0) < 1e-9, "un trade en cours a ete balaye"


def test_a_rounding_residue_cannot_survive_a_close():
    """Fermer -9,999999999883585 DOGE par +10 laisse 1,16e-10. Le seuil de
    disparition etait a 1e-12 : le residu passait, restait au livre, et
    reapparaissait a l ecran comme une position. Rien de legitime ne pese
    un milliardieme d unite — un milliardieme de DOGE vaut 1e-10 dollar."""
    from hermes.exchange.broker import PaperBroker

    b = PaperBroker(cash=10_000.0)
    b.mark_prices({"DOGE-USDT-SWAP": 0.0888})
    b.pos["DOGE-USDT-SWAP"] = -9.999999999883585
    b.entry["DOGE-USDT-SWAP"] = 0.0888
    b.market_order("DOGE-USDT-SWAP", 10.0, 0.0888, force_taker=True)
    assert "DOGE-USDT-SWAP" not in b.pos, b.pos


def test_the_legs_carry_equal_RISK_not_equal_notional(tmp_path):
    """La porte ne mesure pas un livre equipondere.

    _portfolio agrege les trades simultanes en ponderant chaque jambe par
    l inverse de sa volatilite : c est ce livre-la dont le Sharpe a
    franchi la barre. Le moteur envoyait pourtant le MEME notionnel a
    toutes les jambes — visible a l ecran, cinq positions a 191, 192, 193
    USDT. DOGE, trois fois plus agite que BTC, dominait alors la variance
    du livre reellement tenu sans apporter plus d avantage : on jouait un
    portefeuille que personne n avait mesure.

    Une seule horloge parle pour tout le panel au meme instant, donc tous
    les moments — net, ecart-type, nombre — sont IDENTIQUES d une jambe a
    l autre. Ce qui les distingue est leur volatilite propre, et elle
    arrive par le garde-fou mesure : stop_bps = stop_sig x sigma x
    racine(h).
    """
    eng, _ = _moteur_pos(tmp_path)
    commun = {"policy": "candle", "bar": "1m", "ml": "live", "h_bars": 6,
              "sortie_temps": True, "net_bps": 13.0, "net_sd": 60.0,
              "net_defl": 1.9, "net_n": 300, "tp_bps": 200.0,
              "vol_bps": 10.0, "cost_bps": 7.0}
    preds = [
        dict(commun, inst="BTC-USDT-SWAP", dir="long", edge_bps=12.0,
             sl_bps=40.0, px=79_000.0),      # calme
        dict(commun, inst="DOGE-USDT-SWAP", dir="long", edge_bps=12.0,
             sl_bps=120.0, px=0.0888),       # trois fois plus agite
    ]
    tg = eng._targets(preds)
    w_btc = abs(tg["BTC-USDT-SWAP"])
    w_doge = abs(tg["DOGE-USDT-SWAP"])
    assert w_btc > 0 and w_doge > 0, tg
    # Trois fois moins volatile, trois fois plus de notionnel — a moins
    # que le plafond de ruine ne morde avant, ce qu il ne fait pas ici.
    r = w_btc / w_doge
    assert 2.5 < r < 3.5, f"rapport de notionnel {r:.2f}, attendu ~3"
    # ...et le RISQUE, lui, est egal : notionnel x volatilite constant.
    assert abs(w_btc * 40.0 - w_doge * 120.0) < 1e-9

    # Le garde-fou de ruine reste per-jambe et borne encore la plus
    # agrandie : 2,5 % de fonds propres par stop touche, quoi qu il arrive.
    for p in preds:
        assert p["lev"] <= 0.025 / (p["sl_bps"] * 1e-4) + 1.0


def test_risk_parity_does_not_change_the_total_size(tmp_path):
    """La parite REPARTIT, elle n agrandit pas. Le facteur vaut 1 en
    moyenne : deux jambes de meme volatilite doivent recevoir exactement
    ce qu elles recevaient avant, sinon la correction aurait change la
    taille du livre en plus de sa forme — et on ne saurait plus laquelle
    des deux a produit l effet mesure ensuite."""
    eng, _ = _moteur_pos(tmp_path)
    commun = {"policy": "candle", "bar": "1m", "ml": "live", "h_bars": 6,
              "sortie_temps": True, "net_bps": 13.0, "net_sd": 60.0,
              "net_defl": 1.9, "net_n": 300, "tp_bps": 200.0,
              "vol_bps": 10.0, "cost_bps": 7.0, "sl_bps": 60.0}
    a = eng._targets([dict(commun, inst="BTC-USDT-SWAP", dir="long",
                           edge_bps=12.0, px=79_000.0),
                      dict(commun, inst="ETH-USDT-SWAP", dir="long",
                           edge_bps=12.0, px=2_500.0)])
    assert abs(abs(a["BTC-USDT-SWAP"]) - abs(a["ETH-USDT-SWAP"])) < 1e-12


def test_a_residue_smaller_than_one_lot_cannot_be_born():
    """Le reliquat immortel, trouve en direct et impossible a fermer.

    -9,999999999883585 DOGE, 89 centimes, affiche a l ecran comme une
    position ouverte pendant des heures. DOGE-USDT-SWAP vaut 1000 DOGE le
    contrat : fermer dix DOGE demande 0,01 contrat, que _round_qty ramene
    a zero et que market_order refuse. Aucun ordre, jamais, n aurait pu
    l en sortir — ni le balayage de poussiere, ni une cible a zero.

    Un vrai echange ne laisse pas cet etat exister. Le courtier papier ne
    doit pas l inventer : le reliquat se solde au prix du remplissage qui
    vient de le creer.
    """
    from hermes.exchange.broker import PaperBroker

    b = PaperBroker(cash=10_000.0)
    b.mark_prices({"DOGE-USDT-SWAP": 0.0900})
    # Sans specs, _round_qty laisse passer n importe quelle quantite :
    # c est ainsi que le reliquat nait en vrai — des ordres passes avant
    # que les specs de l echange soient chargees, ou un etat repris.
    b.market_order("DOGE-USDT-SWAP", -2010.0, 0.0900)
    assert b.pos["DOGE-USDT-SWAP"] == -2010.0

    # Les specs arrivent : le pas minimal est 0,1 contrat, soit 100 DOGE.
    b.set_specs({"DOGE-USDT-SWAP": {"ctVal": 1000.0, "lotSz": 0.1,
                                    "minSz": 0.1}})
    b.mark_prices({"DOGE-USDT-SWAP": 0.0888})
    # Le prochain ordre valide doit emporter le reliquat non aligne avec
    # lui, au lieu de le laisser derriere pour toujours.
    b.market_order("DOGE-USDT-SWAP", 2000.0, 0.0888)
    assert "DOGE-USDT-SWAP" not in b.pos, \
        f"un reliquat intradable survit : {b.pos.get('DOGE-USDT-SWAP')}"

    # Et une position alignee n est evidemment pas touchee.
    b.market_order("DOGE-USDT-SWAP", -1000.0, 0.0888)
    assert b.pos["DOGE-USDT-SWAP"] == -1000.0


def test_an_inherited_residue_gets_written_off(tmp_path):
    """Le garde-fou empeche d en creer ; il reste ceux qu un etat
    anterieur porte deja. Le balayage doit pouvoir les solder, sinon le
    -10 DOGE d hier survit a tous les deploiements de demain."""
    from hermes.exchange.broker import PaperBroker

    b = PaperBroker(cash=10_000.0)
    b.set_specs({"DOGE-USDT-SWAP": {"ctVal": 1000.0, "lotSz": 0.1,
                                    "minSz": 0.1}})
    b.pos["DOGE-USDT-SWAP"] = -10.0
    b.entry["DOGE-USDT-SWAP"] = 0.0888
    b.mark_prices({"DOGE-USDT-SWAP": 0.0890})

    assert b.market_order("DOGE-USDT-SWAP", 10.0, 0.0890) is None, \
        "l echange accepterait un ordre de 0,01 contrat"
    avant = b.livre["brut"]
    assert b.solder("DOGE-USDT-SWAP", 0.0890) is True
    assert "DOGE-USDT-SWAP" not in b.pos
    # le solde passe par le livre, il ne disparait pas en silence
    assert abs((b.livre["brut"] - avant) - (-10.0 * (0.0890 - 0.0888))) < 1e-12
    # et une VRAIE position ne se solde jamais
    b.pos["DOGE-USDT-SWAP"] = -1000.0
    assert b.solder("DOGE-USDT-SWAP", 0.0890) is False


def test_the_exchange_leverage_is_a_margin_decision_not_a_size_one(tmp_path):
    """« Pourquoi il y a des leviers ridicules de 1 ? »

    Parce que la ligne qui decidait du levier comparait un POIDS a un
    levier : `plan["lev"]` est une fraction des fonds propres, de l ordre
    de 0,02, et la condition `lev >= 2` n etait donc JAMAIS vraie. Aucun
    levier n etait transmis, l echange retombait a x1 sur chaque position.
    Mesure a l ecran : « LEVIER x1,0 MARGE 153,51 » pour un notionnel de
    153,15 — la marge egale le notionnel, c est la definition de x1.

    Ce que le levier change, et ce qu il ne change pas : il ne touche ni a
    la taille de la position, ni a la distance du stop, ni au risque de
    marche. Il decide de la MARGE immobilisee, donc du nombre de jambes
    que le compte peut tenir a la fois. A x1, vingt jambes ne tiennent pas
    dans les fonds propres — un plafond sans raison economique, qui
    annulait en silence le plafond brut de x20 de la configuration.
    """
    eng, _ = _moteur_pos(tmp_path)
    assert eng.lev_ech_min == 5, "le plancher demande est de cinq"
    # et il ne se confond PAS avec `lev_min`, qui est le plancher de la
    # TAILLE (Kelly non tronquee) et vaut toujours un.
    assert eng.lev_min == 1

    # Une petite jambe prend le plancher, une grosse monte, le plafond tient.
    eq = 9338.0
    assert eng._levier_echange(153.0, eq) == 5
    assert eng._levier_echange(900.0, eq) == 5
    assert eng._levier_echange(9000.0, eq) == 10
    assert eng._levier_echange(30_000.0, eq) == 20, "le plafond x20 doit tenir"
    assert eng._levier_echange(1e9, eq) == 20

    # La marge suit mecaniquement : a x5 une jambe de 153 USDT en
    # immobilise 31, contre 153 a x1.
    lev = eng._levier_echange(153.0, eq)
    assert abs(153.0 / lev - 30.6) < 0.1

    # Et sans fonds propres connus, on ne descend jamais sous le plancher.
    assert eng._levier_echange(153.0, 0.0) == 5


def test_the_leverage_actually_reaches_the_broker(tmp_path):
    """Le defaut n etait pas dans le calcul du levier, il etait dans son
    TRANSPORT : la valeur n arrivait jamais au courtier. Ce test suit le
    chemin complet, de la cible jusqu au levier enregistre sur la
    position."""
    inst = "BTC-USDT-SWAP"
    eng, b = _moteur_pos(tmp_path)
    eng.ticks[inst] = {"last": 100.0, "bid": 99.9, "ask": 100.1,
                       "spread_bps": 2.0}
    eng.last_preds = [{"inst": inst, "policy": "candle", "bar": "1m",
                       "dir": "long", "ml": "live", "conf": 1.0, "px": 100.0,
                       "h_bars": 6, "edge_bps": 12.0, "lev": 0.02,
                       "vol_bps": 25.0, "tp_bps": 30.0, "sl_bps": 40.0,
                       "sortie_temps": True}]
    eng._vol = {inst: 25.0}
    eng.pending = {inst: 2.0}
    eng.execute_pending()
    assert eng.trades, "aucun ordre passe"
    assert eng.trades[-1]["lev"] >= 5.0, (
        f"le levier n arrive pas au journal : {eng.trades[-1]['lev']}")


def test_a_name_the_exchange_cannot_fill_stops_being_chased(tmp_path):
    """Un nom qui manque d histoire etait remis en file de rattrapage,
    rattrape, reteste, remis en file — pour toujours.

    Si l echange n a tout simplement pas plus d historique a donner — un
    perpetuel liste il y a trois jours n atteindra jamais cinq mille
    barres d une minute — ce cycle ne s arrete jamais, et il consomme a
    chaque tour le quota d appels que les noms REELLEMENT admissibles
    attendent pour entrer au panel.

    Le critere n est pas un compteur d essais : c est le PROGRES. On
    poursuit tant que le rattrapage fait grandir le compte de barres ; des
    qu un rattrapage n apporte plus rien, l echange a donne tout ce qu il
    a et le nom sort.
    """
    import numpy as np

    from hermes.data.store import Candles

    eng, _ = _moteur_pos(tmp_path)
    dits = []
    eng.log = dits.append
    n = [1000]

    def serie(i, b, **k):
        ts = np.arange(n[0], dtype=np.int64) * 60_000
        px = 100 + np.zeros(n[0])
        return Candles(i, "1m", ts, px, px, px, px, np.ones(n[0]))

    eng.store = type("M", (), {"load": lambda self, i, b, **k: serie(i, b)})()

    # Premier passage : trop court, mais on ne juge pas encore.
    assert eng._assez_dhistoire("NEUF-USDT-SWAP") is False
    assert "NEUF-USDT-SWAP" not in eng.recales

    # Le rattrapage APPORTE des barres : on continue de le poursuivre.
    n[0] = 3000
    assert eng._assez_dhistoire("NEUF-USDT-SWAP") is False
    assert "NEUF-USDT-SWAP" not in eng.recales, "un nom qui progresse est abandonne"

    # Le rattrapage n apporte plus rien : l echange est a sec.
    assert eng._assez_dhistoire("NEUF-USDT-SWAP") is False
    assert "NEUF-USDT-SWAP" in eng.recales, "le nom est poursuivi sans fin"
    assert any("rattrapage n en ajoute plus" in m for m in dits), dits
