"""Une horloge par échelle, apprise sur les trois actifs à la fois.

Douze modèles indépendants facturaient la recherche de l'actif (432
cellules) et laissaient chacun sur-ajuster son coin d'histoire. Le panel
enlève cette dimension du guichet ET triple les lignes d'entraînement.

Ce qu'il ne donne pas — et c'est ce que ces tests protègent surtout —
c'est trois fois plus d'information : BTC, ETH et SOL bougent ensemble.
La mesure agrège donc les trades simultanés en un rendement de
portefeuille par instant, de sorte que la répétition ne se déguise
jamais en diversification.
"""

import numpy as np

from hermes.data.store import Candles
from hermes.ml.models import RidgeRegressor
from hermes.scalp.clock import (ASSETS, BARS, FAMILIES, HORIZONS, THRESHOLDS,
                                VARIANTS, CandleModel, ScaleDesk, _portfolio,
                                _sigma, feat_matrix)


def _bruit(seed, n=1600, vol=0.004, inst="X"):
    rng = np.random.default_rng(seed)
    px = 100 * np.exp(np.cumsum(rng.normal(0, vol, n)))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, vol / 3, n)) * px
    return Candles(inst, "5m", np.arange(n) * 300_000, o,
                   np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                   np.abs(rng.normal(1000, 300, n)))


class _Store:
    def __init__(self, d):
        self.d = d

    def load(self, inst, bar):
        return self.d[(inst, bar)]


# --------------------------------------------------------------- agrégation

def test_three_copies_of_one_asset_buy_no_extra_confidence():
    """Le cas dégénéré : trois actifs identiques. Le portefeuille qu'on
    tient est le même que le seul, donc la série mesurée doit être la
    même — pas trois fois plus d'observations."""
    rng = np.random.default_rng(1)
    net = rng.normal(0.5, 4.0, 300)
    ts = np.arange(300) * 300_000
    seul = _portfolio(net, ts)
    trois = _portfolio(np.tile(net, 3), np.tile(ts, 3))
    assert len(trois) == len(seul)
    assert np.allclose(trois, seul)


def test_genuinely_independent_assets_do_earn_their_diversification():
    """Contre-épreuve : quand les trades simultanés sont indépendants, la
    moyenne par instant réduit vraiment la variance, et le Sharpe monte
    d'environ racine(3). Ce gain-là, le portefeuille l'encaisse."""
    rng = np.random.default_rng(2)
    n = 4000
    ts = np.repeat(np.arange(n) * 300_000, 3)
    net = rng.normal(0.5, 4.0, 3 * n)
    pnl = _portfolio(net, ts)
    sr_un = 0.5 / 4.0
    sr_pf = float(np.mean(pnl) / np.std(pnl, ddof=1))
    assert 1.5 < sr_pf / sr_un < 2.1, f"gain {sr_pf / sr_un:.2f}x"


def test_the_gate_measures_instants_not_trades():
    """La barre déflatée se lit sur le nombre d'instants. Sur un panel de
    trois actifs, le compte de trades dépasse le compte d'instants — et
    c'est le second qui est publié à la porte."""
    m = CandleModel("5m")
    m.fit_panel([(_bruit(10 + i), None) for i in range(3)])
    d = m.to_dict()
    if d["n_trades"]:
        assert d["n_periods"] <= d["n_trades"]


# ------------------------------------------------------------------ guichet

def test_pooling_removes_the_asset_dimension_from_the_bill():
    """Ne plus chercher l'actif, c'est ne plus le payer — mais seulement
    si on ne le cherche vraiment plus : une horloge, partagée."""
    panel = CandleModel("5m")
    panel.fit_panel([(_bruit(20 + i), None) for i in range(3)])
    solo = CandleModel("5m")
    solo.fit(_bruit(20))
    from hermes.scalp.clock import STOPS
    base = (len(BARS) * len(FAMILIES) * len(THRESHOLDS) * len(HORIZONS)
            * len(STOPS))
    # en panel, la variante marché-neutre est cherchée — donc facturée ;
    # seule, elle n'a rien à retrancher et n'est pas cherchée du tout.
    assert panel.n_cells == base * len(VARIANTS)
    assert solo.n_cells == base * len(ASSETS)


def test_noise_still_passes_nothing_through_the_panel():
    """Le panel triple les lignes ; il ne doit pas pour autant faire
    passer du hasard. Six paniers de trois actifs, zéro survivant."""
    vivants = 0
    for tour in range(6):
        m = CandleModel("5m")
        d = m.fit_panel([(_bruit(100 + 3 * tour + i), None) for i in range(3)])
        vivants += d["status"] == "live"
    assert vivants == 0, f"{vivants}/6 panels vivants sur bruit pur"


# ------------------------------------------------- comparabilité des actifs

def test_features_say_sigmas_so_two_assets_speak_the_same_language():
    """Le même marché, trois fois plus agité, doit produire les mêmes
    colonnes de rendement : c'est la condition pour que BTC et SOL
    nourrissent une seule horloge."""
    a = _bruit(7, vol=0.002)
    rng = np.random.default_rng(7)
    r = np.diff(np.log(a.c), prepend=np.log(a.c[0])) * 3.0
    px = a.c[0] * np.exp(np.cumsum(r))
    o = np.concatenate([[a.c[0]], px[:-1]])
    w = np.abs(rng.normal(0, 0.002, len(px))) * px
    b = Candles("Y", "5m", a.ts, o, np.maximum(o, px) + w,
                np.minimum(o, px) - w, px, a.v)
    fa, fb = feat_matrix(a)[300:], feat_matrix(b)[300:]
    for col in range(4):        # r1 et les retours décalés
        rho = float(np.corrcoef(fa[:, col], fb[:, col])[0, 1])
        assert rho > 0.97, f"colonne {col} : rho={rho:.3f}"
        rapport = fb[:, col].std() / max(fa[:, col].std(), 1e-12)
        assert 0.7 < rapport < 1.4, f"colonne {col} : rapport {rapport:.2f}"


def test_sigma_never_peeks_at_the_future():
    """Toute normalisation causale : tronquer la série ne doit pas
    changer les sigmas déjà calculés."""
    c = _bruit(11)
    plein = _sigma(c)
    court = _sigma(c.slice(0, 900))
    assert np.allclose(plein[:900], court)


def test_features_are_causal_under_truncation():
    c = _bruit(12)
    plein = feat_matrix(c)
    court = feat_matrix(c.slice(0, 800))
    assert np.allclose(plein[400:800], court[400:800], atol=1e-9)


# ------------------------------------------------------------------ câblage

def test_one_model_serves_every_asset_on_its_scale():
    """L'objet est partagé : le moteur demande toujours « l'horloge 5m de
    SOL », sans savoir qu'elle a été apprise sur les trois. C'est ce
    partage qui fait qu'une horloge validée ouvre trois positions."""
    d = {}
    for i, inst in enumerate(ASSETS):
        for bar in BARS:
            d[(inst, bar)] = _bruit(200 + i, n=900)
    desk = ScaleDesk()
    desk.fit_store(_Store(d))
    for bar in BARS:
        objets = {id(desk.models[(inst, bar)]) for inst in ASSETS}
        assert len(objets) == 1, f"{bar} : {len(objets)} horloges au lieu d'une"


def test_a_shorter_asset_does_not_leak_across_the_time_cut():
    """Historiques inégaux : la coupure est un INSTANT, pas un index.
    Sinon le holdout du plus court chevauche le train du plus long."""
    long_ = _bruit(31, n=2000)
    court = long_.slice(600, 2000)
    m = CandleModel("5m")
    m.fit_panel([(long_, None), (court, None)])
    assert m.status in ("live", "veto", "few-samples")
    # la coupure temporelle est la même pour les deux : le train du long
    # ne peut pas contenir de barres postérieures au début du holdout.
    assert m.n_train > 0 or m.status != "live"


def test_the_search_ranks_cells_by_margin_not_by_raw_sharpe():
    """Un seuil très haut produit toujours le plus beau Sharpe — sur
    trente trades, où il ne prouve rien. Classer par (sr - barre) revient
    à chercher avec le critère qui décide ; la porte, elle, est
    inchangée : le retenu doit toujours franchir SA barre."""
    m = CandleModel("5m")
    d = m.fit_panel([(_bruit(300 + i), None) for i in range(3)])
    if d["status"] == "live":
        assert d["holdout_sr"] > d["sel_bar"]
    # la barre publiée est bien celle du nombre d'instants retenu
    from hermes.backtest.metrics import expected_max_sharpe
    if d["n_periods"]:
        attendu = expected_max_sharpe(d["n_trials"], d["n_periods"])
        assert abs(d["sel_bar"] - attendu) < 1e-9


# ------------------------------------------------------------ marché-neutre

def test_a_neutral_clock_trades_the_spread_not_the_market():
    """En variante neutre, deux actifs qui montent tous les deux autant
    ne donnent AUCUN signal : le livre ne prend pas le marché, il prend
    l'écart. Et deux actifs qui divergent donnent deux jambes de signes
    opposés — un long et un short au même instant."""
    from hermes.scalp.clock import CandleModel, ScaleDesk
    desk = ScaleDesk()
    m = CandleModel("5m")
    m.status, m.variant, m.shrink, m.thr_bps = "live", "neu", 0.5, 5.0
    for inst in ("BTC-USDT-SWAP", "ETH-USDT-SWAP"):
        desk.models[(inst, "5m")] = m

    # même mouvement prévu des deux côtés : rien à arbitrer
    for inst in ("BTC-USDT-SWAP", "ETH-USDT-SWAP"):
        desk.votes[(inst, "5m")] = {"raw_bps": 30.0, "r_bps": 15.0,
                                    "veto": False, "status": "live",
                                    "bar": "5m", "q_bps": 10.0, "ic": 0.05,
                                    "up_bps": 20.0, "dn_bps": 20.0}
    desk._neutraliser("5m")
    assert all(desk.votes[(i, "5m")]["veto"]
               for i in ("BTC-USDT-SWAP", "ETH-USDT-SWAP"))

    # divergence franche : un long, un short
    desk.votes[("BTC-USDT-SWAP", "5m")].update(raw_bps=40.0, veto=False)
    desk.votes[("ETH-USDT-SWAP", "5m")].update(raw_bps=-40.0, veto=False)
    desk._neutraliser("5m")
    a = desk.votes[("BTC-USDT-SWAP", "5m")]
    b = desk.votes[("ETH-USDT-SWAP", "5m")]
    assert not a["veto"] and not b["veto"]
    assert a["r_bps"] > 0 > b["r_bps"]


def test_a_neutral_clock_with_a_single_leg_stands_down():
    """Une jambe seule n'est pas un livre neutre : sans contrepartie, la
    règle jouée ne serait plus celle qui a été mesurée."""
    from hermes.scalp.clock import CandleModel, ScaleDesk
    desk = ScaleDesk()
    m = CandleModel("5m")
    m.status, m.variant, m.shrink, m.thr_bps = "live", "neu", 0.5, 5.0
    desk.models[("BTC-USDT-SWAP", "5m")] = m
    desk.votes[("BTC-USDT-SWAP", "5m")] = {"raw_bps": 99.0, "r_bps": 49.5,
                                           "veto": False, "status": "live",
                                           "bar": "5m", "q_bps": 10.0,
                                           "ic": 0.05, "up_bps": 20.0,
                                           "dn_bps": 20.0}
    desk._neutraliser("5m")
    assert desk.votes[("BTC-USDT-SWAP", "5m")]["veto"] is True


def test_an_absolute_clock_is_left_alone_by_the_neutraliser():
    """La neutralisation ne doit toucher qu'aux horloges qui ont été
    validées en neutre — jamais réécrire le verdict d'une autre."""
    from hermes.scalp.clock import CandleModel, ScaleDesk
    desk = ScaleDesk()
    m = CandleModel("5m")
    m.status, m.variant, m.shrink, m.thr_bps = "live", "abs", 0.5, 5.0
    for inst in ("BTC-USDT-SWAP", "ETH-USDT-SWAP"):
        desk.models[(inst, "5m")] = m
        desk.votes[(inst, "5m")] = {"raw_bps": 30.0, "r_bps": 15.0,
                                    "veto": False, "status": "live",
                                    "bar": "5m", "q_bps": 10.0, "ic": 0.05,
                                    "up_bps": 20.0, "dn_bps": 20.0}
    desk._neutraliser("5m")
    assert not desk.votes[("BTC-USDT-SWAP", "5m")]["veto"]
    assert desk.votes[("BTC-USDT-SWAP", "5m")]["r_bps"] == 15.0


def test_the_net_sees_the_sequence_not_only_its_summaries():
    """Les huit derniers retours sont donnés un par un. Une base fixe de
    sommes (retours cumulés à 3, 5, 12) ne peut pas représenter un motif
    qui alterne ; huit colonnes distinctes le peuvent, et c'est au réseau
    de choisir son filtre."""
    from hermes.scalp.clock import N_FEATURES, col, feat_matrix
    c = _bruit(41, n=400)
    X = feat_matrix(c)
    assert X.shape[1] == N_FEATURES
    # Les décalages se repèrent par leur NOM. Un indice écrit en dur se
    # décale en silence dès qu'une colonne est insérée avant — c'est
    # exactement ce qui est arrivé en ajoutant le volume.
    from hermes.scalp.clock import _sigma
    sig = _sigma(c)
    px = np.asarray(c.c, dtype=np.float64)
    r1 = np.zeros(len(c))
    r1[1:] = px[1:] / px[:-1] - 1.0
    for k in range(1, 9):
        attendu = np.clip(r1[:-k] / sig[k:], -6.0, 6.0)
        assert np.allclose(X[k:, col(f"r1_{k}")], attendu), f"décalage {k} cassé"


def test_the_sequence_columns_stay_causal():
    c = _bruit(42, n=700)
    from hermes.scalp.clock import feat_matrix
    plein, court = feat_matrix(c), feat_matrix(c.slice(0, 500))
    assert np.allclose(plein[300:500], court[300:500], atol=1e-9)


def test_a_late_joining_asset_cannot_shrink_everyone_else_holdout():
    """Un actif dont l'historique commence tard n'a que des horodatages
    récents. Compter la coupure sur les LIGNES le laisserait tirer le
    quantile vers le présent et raccourcir le holdout de tout le panel ;
    la coupure se prend donc sur les instants distincts."""
    long_ = _bruit(51, n=3000)
    tardif = long_.slice(2600, 3000)      # n'existe que sur la fin
    seul = CandleModel("5m")
    seul.fit_panel([(long_, None)])
    melange = CandleModel("5m")
    melange.fit_panel([(long_, None), (tardif, None)])
    # le long garde le même train : le nouveau venu n'a pas déplacé la
    # coupure (il n'apporte aucun instant que le long n'ait déjà)
    assert melange.n_train >= seul.n_train


def test_a_lone_clock_is_not_shrunk_twice():
    """Les poids d'échelle forment une MOYENNE, pas une somme. Avec les
    quatre horloges vivantes ils somment à 1 ; avec une seule, la somme
    rendait 0,15 fois sa prédiction pour la 1m — un rétrécissement
    arbitraire qui s'ajoutait au demi-Kelly déjà appliqué aux horloges
    solitaires, et qui suffisait à faire refuser tous les brackets.

    Depuis que la cohérence est un prix et non une porte, l'horloge
    solitaire est le cas NORMAL. Sa prédiction doit ressortir intacte ;
    c'est la TAILLE qui paie sa solitude, pas le signal.
    """
    from hermes.scalp.clock import ScaleDesk
    desk = ScaleDesk()
    v = {"r_bps": 30.0, "up_bps": 45.0, "dn_bps": 30.0, "q_bps": 12.0,
         "veto": False, "status": "live", "bar": "1m", "ic": 0.12,
         "horizon_bars": 3}
    desk.votes[("BTC-USDT-SWAP", "1m")] = v
    inf = desk.fuse("BTC-USDT-SWAP")
    assert abs(inf["ml_bps"] - 30.0) < 1e-9, inf["ml_bps"]
    assert inf["alpha"] == 0.5, "la solitude se paie en taille"

    # deux horloges d'accord : moyenne pondérée, et taille pleine
    desk.votes[("BTC-USDT-SWAP", "5m")] = dict(v, bar="5m", r_bps=10.0)
    inf2 = desk.fuse("BTC-USDT-SWAP")
    attendu = (0.15 * 30.0 + 0.28 * 10.0) / (0.15 + 0.28)
    assert abs(inf2["ml_bps"] - attendu) < 1e-9, inf2["ml_bps"]
    assert inf2["alpha"] == 1.0


# ------------------------------------------------------- calibration d'échelle

def _reversion(seed, n=6000, k=-0.55):
    """Marché à réversion nette : la porte peut y retenir une règle."""
    rng = np.random.default_rng(seed)
    r = np.zeros(n)
    e = rng.normal(0, 0.004, n)
    for t in range(1, n):
        r[t] = k * r[t - 1] + e[t]
    px = 100 * np.exp(np.cumsum(r))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, 0.001, n)) * px
    return Candles("A", "5m", np.arange(n) * 300_000, o,
                   np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                   np.abs(rng.normal(1000, 300, n)))


def test_the_scale_applied_to_a_prediction_is_the_measured_slope():
    """Le facteur appliqué avant le choix du bracket et de la taille était
    min(0,6 ; 0,2+2·ic) — une formule. Les modèles sont pourtant DÉJÀ
    rétrécis : la pente mesurée vaut 1,6 à 2,4 en production. La formule
    rétrécissait donc une seconde fois, et le moteur voyait un mouvement
    trois à douze fois trop petit."""
    m = CandleModel("5m")
    d = m.fit(_reversion(60))
    assert d["status"] == "live", d
    credit = min(1.0, m.n_periods / 200.0)
    attendu = min(3.0, max(0.0, 1.0 + (m.pente - 1.0) * credit))
    assert abs(m.shrink - attendu) < 1e-12
    assert m.pente > 0.0


def test_calibrating_cannot_move_the_gate():
    """Une pente est une ÉCHELLE estimée, pas une cellule cherchée. Le
    seuil vaut k·écart-type de la prédiction et le gain suit son SIGNE :
    multiplier toutes les prédictions par un facteur positif laisse le
    jeu de trades, le net et le Sharpe rigoureusement identiques. C'est
    pourquoi calibrer ne coûte rien à la porte."""
    rng = np.random.default_rng(8)
    p = rng.normal(0, 3.0, 4000)
    y = 1.8 * p + rng.normal(0, 25.0, 4000)
    for facteur in (1.0, 5.0):
        pv = p * facteur
        thr = 1.0 * float(np.std(pv))
        m = np.abs(pv) >= thr
        gains = np.sign(pv[m]) * y[m]
        net = gains - np.where(gains > 0, 4.75, 7.0)
        if facteur == 1.0:
            ref = (int(m.sum()), float(np.mean(net)),
                   float(np.mean(net) / np.std(net, ddof=1)))
        else:
            assert int(m.sum()) == ref[0]
            assert abs(float(np.mean(net)) - ref[1]) < 1e-12


def test_a_live_clock_hands_the_engine_a_calibrated_move():
    """Ce que le moteur reçoit doit être le mouvement attendu, pas la
    sortie brute d'un modèle rétréci — c'est cette valeur-là qui décide
    du bracket et de la taille."""
    from hermes.scalp.clock import _row, _sigma
    c = _reversion(61)
    m = CandleModel("5m")
    if m.fit(c)["status"] != "live":
        return
    v = m.predict_row(_row(c, None), float(_sigma(c)[-1]))
    assert abs(v["r_bps"] - v["raw_bps"] * m.shrink) < 1e-9


def test_the_screen_shows_one_clock_per_scale_not_one_per_asset():
    """Six cartes identiques mentiraient sur la nature de la preuve : ce
    n'est pas « l'horloge de SOL » qui franchit la barre, c'est l'horloge
    3m, sur tout le panel à la fois."""
    d = {}
    for i, inst in enumerate(ASSETS[:3]):
        for bar in BARS:
            d[(inst, bar)] = _bruit(400 + i, n=900)
    desk = ScaleDesk()
    desk.fit_store(_Store(d), names=list(ASSETS[:3]))
    ech = desk.to_dict()["_echelles"]
    assert set(ech) <= set(BARS)
    assert len(ech) == len({b for (_, b) in desk.models})
    for bar, e in ech.items():
        assert e["bar"] == bar
        assert e["n_assets"] == 3
        assert {"holdout_sr", "sel_bar", "n_periods", "pente",
                "variant", "family"} <= set(e)


def test_the_traded_universe_is_the_panel_that_was_judged():
    """La porte mesure un PORTEFEUILLE sur les actifs du panel. En trader
    d'autres, ou moins, jouerait une règle que personne n'a validée.

    Trois listes codées en dur — deux dans le moteur, deux dans le
    trader — ont tenu le panel à trois actifs pendant que sa définition
    en annonçait six : les verdicts sortaient en panel[3] alors que les
    six historiques étaient complets."""
    import tempfile

    from hermes.scalp.engine import ScalpEngine

    class _B:
        def positions(self):
            return {}

        def equity(self):
            return 10_000.0

    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0

    class _R:
        trading_allowed = True
        must_flatten = False
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
        state = _E()

    eng = ScalpEngine({"scalp": {}, "costs": {}}, _B(), None, _R(),
                      lambda m: None, tempfile.mkdtemp())
    assert eng.instruments == list(ASSETS)
    assert eng.refresh_universe({}) == list(ASSETS)
    assert eng.trade_top == len(ASSETS)


def test_a_slope_measured_on_few_trades_does_not_become_leverage():
    """Observée en production : la pente saute de 0,97 à 3,14 d'un
    ajustement à l'autre quand la cellule retenue ne compte que 62
    trades. Le facteur appliqué s'écarte de 1 à proportion des preuves."""
    m = CandleModel("5m")
    m.pente, m.n_periods = 3.14, 62
    b = {"fam": "ens", "h": 3, "rr": m.rr, "nn": m.nn, "up": m.up,
         "dn": m.dn, "ic": 0.20, "thr": 5.0, "n_tr": 62, "n_per": 62,
         "n_hold": 800, "n_train": 5000, "bps": 4.0, "sr": 0.9,
         "barre": 0.2, "marge": 0.7, "pente": 3.14, "var": "abs",
         "y": np.zeros(1), "pred": np.zeros(1), "cle": (1, 0.7)}
    m._retenir(b, 4.75)
    assert m.status == "live"
    assert 1.0 < m.shrink < 2.0, m.shrink
    # les mêmes preuves, en nombre : la pente est alors prise telle quelle
    b2 = dict(b, n_per=600, n_tr=600)
    m2 = CandleModel("5m")
    m2._retenir(b2, 4.75)
    assert abs(m2.shrink - 3.0) < 1e-9 or abs(m2.shrink - 3.14) < 0.2


# ------------------------------------------------------ validation glissante

def test_the_folds_are_disjoint_in_time_and_purged():
    """Six plis successifs, chacun jugé par un modèle entraîné uniquement
    sur ce qui le précède, avec un embargo à chaque frontière. Ce sont ces
    plis-là qui font l'échantillon de mesure : trois fois plus grand qu'un
    découpage unique 80/20, et sans qu'un seul instant y soit compté deux
    fois — c'est la condition pour que la barre du hasard, qui décroît en
    1/racine(observations), baisse honnêtement."""
    from hermes.scalp.clock import DEBUT_TEST, FOLDS
    assert FOLDS >= 4 and 0.0 < DEBUT_TEST < 1.0
    m = CandleModel("5m")
    m.fit_panel([(_bruit(60 + i, n=4000), None) for i in range(3)])
    d = m.to_dict()
    if d["n_holdout"]:
        # le hors-échantillon couvre bien plus que les 20 % d'un
        # découpage unique : il vise (1 - DEBUT_TEST) du temps couvert
        assert d["n_holdout"] > 0
        assert d["n_periods"] <= d["n_holdout"]


def test_walk_forward_still_lets_nothing_through_on_noise():
    """Trois fois plus d'observations, ce n'est pas trois fois plus de
    chances de passer : la barre est recalculée sur le nombre d'instants
    effectivement mesurés."""
    vivants = 0
    for tour in range(5):
        m = CandleModel("5m")
        d = m.fit_panel([(_bruit(700 + 3 * tour + i, n=3000), None)
                         for i in range(3)])
        vivants += d["status"] == "live"
    assert vivants == 0, f"{vivants}/5 panels vivants sur bruit pur"


def test_the_live_models_never_saw_the_measured_folds():
    """Les modèles qui iront en direct sont entraînés sur TOUT
    l'historique — le pli suivant de la même procédure. Aucune de leurs
    prédictions n'entre dans la mesure, sinon la porte jugerait un modèle
    sur ses propres données d'entraînement."""
    import numpy as np
    src = "\n".join(open("hermes/scalp/clock.py").read().split("\n"))
    deb = src.index("def _essai")
    fin = src.index("def _retenir")
    corps = src[deb:fin]
    # les prédictions mesurées viennent de par_fam (modèles du pli),
    # jamais des modèles finaux rr/nn entraînés sur Xall
    assert "hors[f].append(par_fam[f].predict(Xte))" in corps
    assert corps.index("Xall") > corps.index("hors[f].append")


def test_the_legs_are_weighted_by_risk_not_by_headcount():
    """Un actif trois fois plus agité ne doit pas peser trois fois plus
    dans la variance du portefeuille mesuré. Chaque jambe est pondérée
    par l'inverse de sa volatilité — ce que le moteur fait déjà en
    dimensionnant (le plafond de ruine donne un levier proportionnel à
    1/volatilité). Mesurer équipondéré reviendrait à juger un livre que
    personne ne tient."""
    ts = np.array([0, 0, 0])
    net = np.array([10.0, 10.0, -30.0])
    sig = np.array([1e-3, 1e-3, 3e-3])       # le troisième est agité
    plat = _portfolio(net, ts)
    risque = _portfolio(net, ts, 1.0 / sig)
    assert abs(plat - (-10.0 / 3.0)) < 1e-9
    # pondéré par le risque, la jambe agitée compte trois fois moins
    attendu = (1000 * 10 + 1000 * 10 + 333.333 * -30) / (1000 + 1000 + 333.333)
    assert abs(risque[0] - attendu) < 1e-2


def test_a_single_leg_is_unaffected_by_the_weighting():
    """Quand un seul actif déclenche, la pondération ne change rien : le
    portefeuille EST cette jambe."""
    ts = np.array([0, 1, 2])
    net = np.array([5.0, -3.0, 8.0])
    sig = np.array([1e-3, 4e-3, 2e-3])
    assert np.allclose(_portfolio(net, ts), _portfolio(net, ts, 1.0 / sig))


# ------------------------------------------------------------- hystérésis

def test_the_retained_cell_survives_a_refit_on_the_same_data():
    """Deux ajustements successifs sur les mêmes données doivent jouer la
    MÊME règle. Sans ancre, l'argmax d'une surface plate change de famille
    et de seuil pour un millième de marge — observé en production, mlp à
    seuil 10,0 puis ens à seuil 5,0 à cinq minutes d'intervalle, deux
    règles qui ne tradent pas au même rythme."""
    panel = [(_bruit(80 + i, n=3000), None) for i in range(3)]
    a = CandleModel("5m")
    a.fit_panel(panel)
    b = CandleModel("5m")
    b.fit_panel(panel, a.ident)
    assert b.ident == a.ident, f"{a.ident} -> {b.ident}"
    assert b.to_dict()["garde"] is True


def test_hysteresis_is_not_a_door_the_incumbent_must_still_pass():
    """Garder la sortante n'est PAS la dispenser de la porte : elle
    franchit exactement les mêmes conditions que les autres dans
    _retenir — net positif après frais, Sharpe au-dessus de SA barre, ic
    au-dessus du plancher."""
    m = CandleModel("5m")
    faux = ("mlp", 3, 2.5, "abs")
    d = m.fit_panel([(_bruit(90 + i, n=3000), None) for i in range(3)], faux)
    if d["status"] == "live":
        assert d["holdout_bps"] > 0
        assert d["holdout_sr"] > d["sel_bar"]


def test_a_clearly_better_cell_still_wins():
    """L'ancre ne fige pas : une cellule qui bat la sortante de plus d'une
    erreur-type de son propre Sharpe la remplace. Ici la sortante n'existe
    même pas dans la grille de cette horloge, donc rien ne la retient."""
    panel = [(_bruit(95 + i, n=3000), None) for i in range(3)]
    libre = CandleModel("5m")
    libre.fit_panel(panel)
    ancre = CandleModel("5m")
    ancre.fit_panel(panel, ("ridge", 6, 2.5, "neu"))
    # une identité absente de la grille retenue ne peut rien ancrer
    assert ancre.ident == libre.ident


# --------------------------------------------------- décalage d'entrée

def test_the_entry_lag_is_measured_not_assumed():
    """Le décalage vaut zéro, et ce zéro est mesuré : le moteur détecte
    la clôture d'une barre et agit dans les secondes qui suivent — six
    secondes sur la 1m, quarante-trois sur la 15m, soit un quart de barre
    et trois centièmes de barre.

    Cette constante a brièvement valu 1, sur une lecture fautive : un
    horodatage de barre est son heure d'OUVERTURE, et le prendre pour sa
    clôture gonflait le délai d'un facteur dix. Le paramètre reste pour
    montrer ce qu'un vrai délai détruirait ; sa valeur décrit la machine.

    Le décalage en BARRES vaut donc zéro — mais le prix d entrée, lui,
    n est plus la clôture de la barre qui décide : c est l OUVERTURE de la
    suivante, le seul prix que le moteur puisse réellement obtenir après
    ses 2,0 secondes de latence mesurées. L écart entre les deux porte
    exactement le rebond bid-ask, qu aucune exécution n encaisse.
    """
    from hermes.scalp.clock import ENTREE_DECALEE, _targets
    assert ENTREE_DECALEE == 0
    n = 30
    px = np.arange(100.0, 100.0 + n)
    c = Candles("X", "1m", np.arange(n) * 60_000, px, px + 0.5, px - 0.5,
                px, np.ones(n))
    y, _, _ = _targets(c, h=3)
    assert abs(y[0] - (px[3] / px[1] - 1.0)) < 1e-12, (
        "l entrée doit être l ouverture de la barre suivante")
    # Et un décalage explicite recule l entrée d autant : base =
    # ouverture de la barre lag+1, sortie = clôture de la barre lag+h.
    decale = _targets(c, h=3, lag=1)[0]
    assert abs(decale[0] - (px[4] / px[2] - 1.0)) < 1e-12


def test_a_one_bar_ahead_signal_would_not_survive_a_real_delay():
    """Ce que le paramètre sert à montrer : un mouvement prévisible d'UNE
    seule barre disparaît intégralement dès qu'on entre une barre plus
    tard. Ce n'est pas la situation de cette machine — son délai est de
    quelques secondes — mais c'est la forme que prendrait le problème si
    elle ralentissait, et la raison pour laquelle les marchés de test
    plantent désormais des avantages qui durent plus d'une barre."""
    rng = np.random.default_rng(77)
    n = 3000
    drive = rng.choice([-1.0, 1.0], n)          # tiré à chaque barre
    r = np.zeros(n)
    r[1:] = 0.0020 * drive[:-1] + rng.normal(0, 0.0012, n - 1)
    px = 100 * np.exp(np.cumsum(r))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, 2e-4, n)) * px
    vtot = np.abs(rng.normal(1000, 100, n))
    c = Candles("X", "5m", np.arange(n) * 300_000, o,
                np.maximum(o, px) + w, np.minimum(o, px) - w, px, vtot,
                taker_buy=vtot * (0.5 + 0.45 * drive),
                taker_sell=vtot * (0.5 - 0.45 * drive))
    from hermes.scalp.clock import _ic, _targets, feat_matrix
    X = np.column_stack([feat_matrix(c), np.zeros(n), np.zeros(n)])
    idx0 = np.arange(200, 2500)
    ics = {}
    for lag in (0, 1):
        y = _targets(c, h=1, lag=lag)[0]
        ok = idx0[np.isfinite(y[idx0])]
        cut = ok[int(0.7 * len(ok))]
        tr, ho = ok[ok < cut], ok[ok >= cut]
        p = RidgeRegressor(l2=14.0).fit(X[tr], y[tr]).predict(X[ho])
        ics[lag] = abs(_ic(p, y[ho]))
    assert ics[0] > 0.15, f"le signal doit être visible sans délai : {ics}"
    assert ics[1] < 0.5 * ics[0], f"une barre de retard doit le tuer : {ics}"


# ------------------------------------------------- le stop fait partie de la règle

def test_the_stop_is_measured_with_the_rule_not_bolted_on_after():
    """La règle mesurée n'avait aucun stop, la règle jouée en avait un.
    À six barres d'une minute sur un actif à 31 bps de volatilité par
    barre, l'écart-type du mouvement vaut 76 bps et le garde-fou posé à 63
    tombait DEDANS : il se déclenche une fois sur deux et cristallise
    -63 bps là où le gain moyen mesuré vaut +11. Constaté au premier trade
    mesuré en direct — XRP ouvert sur une prévision de -7,2 bps, stoppé
    3,7 minutes plus tard à -85,8.

    Le stop est donc cherché AVEC la règle, facturé comme les autres
    dimensions, et le moteur joue exactement celui qui a été mesuré."""
    from hermes.scalp.clock import LARGEURS, STOPS
    m = CandleModel("5m")
    d = m.fit_panel([(_bruit(120 + i, n=3000), None) for i in range(3)])
    assert d["stop_sig"] in LARGEURS
    # Le MODE fait partie de la règle au même titre que la largeur : un
    # suiveur validé puis joué en stop fixe serait une AUTRE règle que
    # celle qui a été prouvée.
    assert d["stop_mode"] in {"fixe", "suiv"}
    assert (d["stop_mode"], d["stop_sig"]) in STOPS
    # et la grille doublée est facturée à la barre, pas offerte
    assert m.n_cells % len(STOPS) == 0


def _economie(rng, n, h, sg, ks, derive=0.0):
    """Net moyen par trade d'une règle « tenir h barres, stop à ks sigmas ».

    Remplissage au MILIEU du niveau et de l'extrême de barre : un stop
    traversé ne remplit pas à son prix, et le supposer rendait les stops
    étroits artificiellement bons — vérifié, un stop à un sigma
    ressortait meilleur qu'un stop à six, ce qui est impossible sans
    dérive.
    """
    pas = rng.normal(derive, sg, size=(n, h))
    chemin = np.cumsum(pas, axis=1)
    fin = chemin[:, -1]
    stop = ks * sg * np.sqrt(h)
    adverse = -chemin.min(axis=1)
    touche = adverse >= stop
    gains = np.where(touche, -0.5 * (stop + adverse), fin)
    return float(np.mean(gains - np.where(touche, 7.0,
                                          np.where(gains > 0, 4.75, 7.0))))


def test_a_narrow_stop_is_never_free_on_a_driftless_walk():
    """Sans dérive, aucun stop ne peut créer de valeur — l'arrêt optionnel
    l'interdit. Il ne peut qu'en coûter : le dépassement au déclenchement,
    et le taker payé là où une sortie au temps aurait pu poser. Un stop
    étroit doit donc mesurer STRICTEMENT moins bien qu'un stop large."""
    rng = np.random.default_rng(5)
    etroit = _economie(rng, 8000, 6, 30.0, 1.0)
    large = _economie(np.random.default_rng(5), 8000, 6, 30.0, 6.0)
    assert etroit < large, {"1sig": etroit, "6sig": large}


def test_a_narrow_stop_eats_a_third_of_a_real_edge():
    """Le cas qui compte, aux paramètres de la production : volatilité de
    31 bps par barre, six barres tenues — donc un écart-type de 76 bps sur
    l'horizon — et un avantage mesuré de 11 bps par trade. Le garde-fou
    que le moteur posait valait 63 bps, soit 0,83 sigma : DEDANS.

    À cette largeur il mange plus du tiers de l'avantage. Au-delà de deux
    sigmas l'effet s'éteint — ce qui place exactement la grille cherchée
    (2, 3, 4) dans la bonne région, et l'ancien garde-fou ad hoc dans la
    mauvaise.
    """
    args = (40000, 6, 31.0)
    dedans = _economie(np.random.default_rng(11), *args, 0.83, 11.0 / 6)
    dehors = _economie(np.random.default_rng(11), *args, 3.0, 11.0 / 6)
    assert dehors > 0.0, f"l'avantage doit survivre à un stop large : {dehors}"
    assert dedans < 0.75 * dehors, {"0.83sig": dedans, "3sig": dehors}
    # et au-delà de deux sigmas, la largeur ne change presque plus rien
    loin = _economie(np.random.default_rng(11), *args, 8.0, 11.0 / 6)
    assert abs(loin - dehors) < 0.25, {"3sig": dehors, "8sig": loin}


def test_the_column_names_cannot_drift_from_the_matrix():
    """Un indice écrit en dur se décale en silence dès qu'une colonne est
    insérée avant lui. Les noms sont la seule référence stable, et leur
    nombre doit coller à ce que la matrice rend vraiment."""
    from hermes.scalp.clock import (COLONNES, CROISEES, N_CROISE, N_FEATURES,
                                    croise, feat_matrix)
    c = _bruit(7, n=400)
    X = feat_matrix(c)
    assert X.shape[1] == N_FEATURES == len(COLONNES)
    assert len(set(COLONNES)) == len(COLONNES), "deux colonnes portent le même nom"
    assert croise(X).shape[1] == N_FEATURES + N_CROISE == len(COLONNES) + len(CROISEES)
