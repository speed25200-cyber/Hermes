"""Deux familles de modèles concourent sur chaque horloge, une gate juge.

Le ridge voit la composante linéaire ; le MLP voit les interactions —
« le momentum ne paie que quand le funding est tendu » est invisible à
une somme pondérée. Ce que ces tests pinnent : le MLP attrape ce genre
de structure, le bruit ne passe par AUCUNE famille (la barre est
facturée pour les deux), le choix est déterministe, et l'écran sait qui
a parlé.
"""

import numpy as np

from hermes.data.store import Candles
from hermes.ml.models import MLPRegressor, RidgeRegressor
from hermes.scalp.clock import FAMILIES, CandleModel


def _marche_interaction(seed, n=2400, k=0.9, bruit=8e-4):
    """Prochain retour = k · r1 · signe(funding) + bruit.

    corr(y, r1) ≈ 0 et corr(y, funding) ≈ 0 : aucune colonne seule ne
    porte le signal, seul leur PRODUIT le porte. Un modèle linéaire est
    aveugle par construction ; c'est le cas d'école qui justifie le
    challenger."""
    rng = np.random.default_rng(seed)
    f = rng.choice([-1.0, 1.0], size=n) * (2e-4 + rng.random(n) * 3e-4)
    r = np.zeros(n)
    r[0] = rng.normal(0, 3e-3)
    for t in range(1, n):
        r[t] = k * r[t - 1] * np.sign(f[t - 1]) + rng.normal(0, bruit)
        r[t] = float(np.clip(r[t], -0.02, 0.02))
    px = 100 * np.exp(np.cumsum(r))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, 4e-4, n)) * px
    return Candles("X", "5m", np.arange(n) * 300_000, o,
                   np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                   np.abs(rng.normal(1000, 300, n)), funding=f)


def test_the_mlp_catches_the_interaction_the_ridge_cannot():
    """La famille retenue doit CONTENIR le réseau — seul ou moyenné avec
    le ridge. Ce qui est interdit, c'est que le ridge nu gagne : par
    construction, il ne voit pas le produit qui porte le signal."""
    gagnes = 0
    for seed in range(3):
        m = CandleModel("5m")
        d = m.fit(_marche_interaction(30 + seed))
        if d["status"] == "live" and d["family"] in ("mlp", "ens"):
            gagnes += 1
    assert gagnes >= 2, f"{gagnes}/3 — le challenger n'attrape pas l'interaction"


def test_the_ridge_alone_is_blind_to_it():
    """Contre-épreuve : le même marché, jugé sur le score du ridge seul,
    ne franchit pas la barre — sinon le test précédent ne prouverait rien."""
    from hermes.scalp.clock import _ic, _targets, feat_matrix
    c = _marche_interaction(31)
    X = np.column_stack([feat_matrix(c), np.zeros(len(c)), np.zeros(len(c))])
    y, _, _ = _targets(c)
    idx = np.where(np.isfinite(y))[0]
    cut = idx[int(0.8 * len(idx))]
    train, hold = idx[idx < cut], idx[idx >= cut]
    rr = RidgeRegressor(l2=14.0).fit(X[train], y[train])
    ic = _ic(rr.predict(X[hold]), y[hold])
    assert abs(ic) < 0.1, f"ic linéaire {ic:.3f} — l'interaction fuit"


def test_noise_passes_neither_family(tmp_path):
    vivants = 0
    for seed in range(6):
        rng = np.random.default_rng(seed)
        n = 1500
        px = 100 * np.exp(np.cumsum(rng.normal(0, 0.004, n)))
        o = np.concatenate([[100.0], px[:-1]])
        w = np.abs(rng.normal(0, 0.0013, n)) * px
        c = Candles("X", "5m", np.arange(n) * 300_000, o,
                    np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                    np.abs(rng.normal(1000, 300, n)))
        m = CandleModel("5m")
        vivants += m.fit(c)["status"] == "live"
    assert vivants == 0, f"{vivants}/6 horloges vivantes sur bruit pur"


def test_the_bar_charges_every_family_searched():
    """Trois familles concourent — ridge, réseau, et leur moyenne. La
    troisième n'est pas gratuite : elle est cherchée, donc facturée."""
    from hermes.backtest.metrics import expected_max_sharpe
    m = CandleModel("5m")
    m.fit(_marche_interaction(32))
    seul = expected_max_sharpe(12, max(m.n_periods, 1))
    assert m.sel_bar > seul, "la barre doit payer 12 cellules x 3 familles"
    assert len(FAMILIES) == 3
    assert m.n_cells % len(FAMILIES) == 0


def test_the_choice_is_deterministic_and_visible():
    a = CandleModel("5m")
    b = CandleModel("5m")
    c = _marche_interaction(33)
    da, db = a.fit(c), b.fit(c)
    assert da["family"] == db["family"]
    assert abs(da["holdout_sr"] - db["holdout_sr"]) < 1e-12
    assert "family" in da


def test_mlp_early_stopping_survives_pure_noise():
    """Sur du bruit pur, l'arrêt anticipé doit rendre un réseau qui ne
    prétend rien : ic hors échantillon proche de zéro, pas un modèle qui
    a mémorisé son train."""
    rng = np.random.default_rng(9)
    X = rng.normal(size=(3000, 8))
    y = rng.normal(size=3000)
    m = MLPRegressor().fit(X[:2400], y[:2400])
    p = m.predict(X[2400:])
    ic = float(np.corrcoef(p, y[2400:])[0, 1]) if p.std() > 1e-12 else 0.0
    assert abs(ic) < 0.08


def test_a_feature_unseen_in_training_cannot_blow_up_the_net():
    """Une colonne constante dans le train mais non nulle plus tard —
    une série dérivée qui commence en cours d'historique — donnait un
    écart-type nul. Diviser par 1e-9 envoyait 5e9 dans le réseau, dont
    les prédictions explosaient de huit ordres de grandeur : en direct,
    des seuils de déclenchement à 240771075 bps."""
    rng = np.random.default_rng(0)
    n = 4000
    X = rng.normal(size=(n, 6))
    X[:, 3] = 0.0
    X[3300:, 3] = 5.0            # jamais vue à l'entraînement
    y = rng.normal(0, 3e-4, n)
    p = MLPRegressor().fit(X[:3200], y[:3200]).predict(X[3200:])
    assert np.isfinite(p).all()
    assert p.std() < 5.0 * y.std(), f"ratio {p.std() / y.std():.1f}"


def test_a_broken_scale_is_skipped_not_judged():
    """Deuxième filet, au niveau de la porte : un modèle dont les
    prédictions dépassent dix fois l'échelle de la cible est écarté,
    jamais retenu comme gagnant."""
    from hermes.scalp.clock import CandleModel
    rng = np.random.default_rng(3)
    n = 3000
    px = 100 * np.exp(np.cumsum(rng.normal(0, 0.004, n)))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, 0.0013, n)) * px
    c = Candles("X", "5m", np.arange(n) * 300_000, o,
                np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                np.abs(rng.normal(1000, 300, n)))
    d = CandleModel("5m").fit(c)
    assert d["thr_bps"] < 1e4, f"seuil aberrant : {d['thr_bps']}"
