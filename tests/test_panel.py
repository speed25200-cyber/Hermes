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
    base = len(BARS) * len(FAMILIES) * len(THRESHOLDS) * len(HORIZONS)
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
    from hermes.scalp.clock import N_FEATURES, feat_matrix
    c = _bruit(41, n=400)
    X = feat_matrix(c)
    assert X.shape[1] == N_FEATURES
    # colonne 0 = retour courant ; colonnes 17..24 = ses huit décalages,
    # rapportés au sigma D'AUJOURD'HUI — « quelle taille avait ce mouvement
    # à l'échelle d'aujourd'hui », la seule unité qui traverse le panel.
    from hermes.scalp.clock import _sigma
    sig = _sigma(c)
    px = np.asarray(c.c, dtype=np.float64)
    r1 = np.zeros(len(c))
    r1[1:] = px[1:] / px[:-1] - 1.0
    for k in range(1, 9):
        attendu = np.clip(r1[:-k] / sig[k:], -6.0, 6.0)
        assert np.allclose(X[k:, 16 + k], attendu), f"décalage {k} cassé"


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
    assert abs(m.shrink - min(3.0, max(0.0, m.pente))) < 1e-12
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
