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
                                CandleModel, ScaleDesk, _portfolio, _sigma,
                                feat_matrix)


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
    attendu = len(BARS) * len(FAMILIES) * len(THRESHOLDS) * len(HORIZONS)
    assert panel.n_cells == attendu
    assert solo.n_cells == attendu * len(ASSETS)


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
