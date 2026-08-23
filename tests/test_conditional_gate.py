"""La porte juge la RÈGLE, pas le modèle.

L'ancienne version facturait l'aller-retour sur chaque barre du holdout,
y compris les barres où le moteur ne trade jamais. Un signal concentré —
muet la plupart du temps, fort de temps en temps — était condamné par ses
propres silences : c'est exactement le profil qu'un scalpeur cherche.
L'évaluation se fait maintenant au déclenchement réel (|prédiction| au
dessus d'un seuil), aux coûts que le moteur paie vraiment, et le seuil
est facturé au guichet du hasard comme tout autre paramètre choisi.
"""

import math

import numpy as np

from hermes.data.store import Candles
from hermes.ml.models import RidgeRegressor
from hermes.scalp.clock import (FAMILIES, MIN_TRADES, THRESHOLDS, CandleModel,
                                _targets, feat_matrix)
from hermes.scalp.flow import FlowBrain, HORIZONS_S


def _marche_concentre(seed, n=4000, part=0.10, force=120e-4, bruit=9e-4):
    """Marché où le prochain retour n'est prévisible que par salves.

    Une barre sur dix prolonge fortement son mouvement ; les autres sont
    du bruit. Le modèle apprend à reconnaître les salves, donc sa
    prédiction est petite la plupart du temps et grande parfois — le
    profil exact d'un scalpeur, et celui que l'ancienne porte étouffait.
    """
    rng = np.random.default_rng(seed)
    r = rng.normal(0, bruit, n)
    actif = rng.random(n) < part
    for t in range(1, n):
        if actif[t - 1]:
            r[t] = math.copysign(force, r[t - 1]) + rng.normal(0, bruit)
    px = 100 * np.exp(np.cumsum(np.clip(r, -0.05, 0.05)))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, 3e-4, n)) * px
    return Candles("X", "5m", np.arange(n) * 300_000, o,
                   np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                   np.abs(rng.normal(1000, 300, n)))


def _sans_condition(c):
    """Ce que l'ancienne porte mesurait : frais pleins sur chaque barre."""
    X = np.column_stack([feat_matrix(c), np.zeros(len(c)), np.zeros(len(c))])
    y, _, _ = _targets(c)
    idx = np.where(np.isfinite(y))[0]
    cut = idx[int(0.8 * len(idx))]
    train, hold = idx[idx < cut], idx[idx >= cut]
    p = RidgeRegressor(l2=14.0).fit(X[train], y[train]).predict(X[hold])
    return float(np.mean(np.sign(p) * y[hold] * 1e4 - 7.0))


def test_the_silences_no_longer_drag_the_measurement_down():
    """Le mécanisme, testé pour lui-même : sur un signal concentré, le net
    PAR TRADE dépasse toujours l'ancienne moyenne par barre. Les barres
    muettes ne votent plus contre une règle qui ne les trade pas."""
    for seed in range(4):
        c = _marche_concentre(300 + seed)
        m = CandleModel("5m")
        d = m.fit(c)
        ancien = _sans_condition(c)
        assert d["holdout_bps"] > ancien, (
            f"graine {seed} : conditionnel {d['holdout_bps']:+.2f} "
            f"vs inconditionnel {ancien:+.2f}")


def test_a_concentrated_signal_now_reaches_the_book():
    """Et le résultat compte : sur ces marchés la porte trouve une règle
    économiquement positive à chaque fois, et en adopte au moins une.

    Elle n'en adopte pas quatre, et c'est le comportement juste : quand la
    règle gagnante ne déclenche que cinquante fois, sa moyenne reste
    indistinguable de la chance parmi les cellules cherchées. La porte
    préfère systématiquement beaucoup de petits trades à quelques gros —
    ce qui est à la fois plus sûr statistiquement et ce qu'on demande d'un
    scalpeur.
    """
    vivants, nets = 0, []
    for seed in range(4):
        m = CandleModel("5m")
        d = m.fit(_marche_concentre(300 + seed, n=8000))
        nets.append(d["holdout_bps"])
        assert d["holdout_bps"] > 0, "la règle trouvée doit payer ses frais"
        assert d["horizon_bars"] in (1, 3, 6)
        if d["status"] == "live":
            vivants += 1
            assert d["n_trades"] >= MIN_TRADES
            assert d["holdout_sr"] > d["sel_bar"]
            assert d["thr_bps"] > 0
    assert vivants >= 1, f"0/4 vivant alors que le net vaut {nets}"


def test_noise_still_passes_nothing_despite_the_threshold_grid():
    """Six seuils x deux familles, c'est douze occasions d'avoir l'air bon
    par hasard. La barre les facture toutes."""
    vivants = 0
    for seed in range(8):
        rng = np.random.default_rng(seed)
        n = 2000
        px = 100 * np.exp(np.cumsum(rng.normal(0, 0.004, n)))
        o = np.concatenate([[100.0], px[:-1]])
        w = np.abs(rng.normal(0, 0.0013, n)) * px
        c = Candles("X", "5m", np.arange(n) * 300_000, o,
                    np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                    np.abs(rng.normal(1000, 300, n)))
        vivants += CandleModel("5m").fit(c)["status"] == "live"
    assert vivants == 0, f"{vivants}/8 horloges vivantes sur bruit pur"


def test_the_bar_is_charged_for_every_threshold_searched():
    from hermes.backtest.metrics import expected_max_sharpe
    m = CandleModel("5m")
    d = m.fit(_marche_concentre(302))
    sans_seuils = expected_max_sharpe(len(FAMILIES) * 12, d["n_trades"])
    assert m.sel_bar > sans_seuils, "la grille de seuils doit se payer"
    assert d["n_trades"] >= MIN_TRADES
    assert len(THRESHOLDS) >= 4


def test_a_live_clock_stays_silent_below_its_own_threshold():
    """Le seuil validé gouverne l'inférence : sous lui, l'horloge se tait,
    au-dessus elle parle. Sans cela le moteur traderait en direct des
    barres sur lesquelles il n'a jamais été validé."""
    m = CandleModel("5m")
    d = m.fit(_marche_concentre(303))
    if d["status"] != "live":
        return                      # le marché n'a pas produit de porte vive
    c = _marche_concentre(303)
    X = np.column_stack([feat_matrix(c), np.zeros(len(c)), np.zeros(len(c))])
    p = m._model().predict(X)
    faible = X[int(np.argmin(np.abs(p)))]
    fort = X[int(np.argmax(np.abs(p)))]
    assert m.predict_row(faible)["veto"] is True
    assert m.predict_row(fort)["veto"] is False


def test_the_flow_head_gate_is_conditional_too(tmp_path):
    """Même correction sur les têtes de flux : un signal qui ne paie que
    dans sa queue passe, le bruit ne passe pas."""
    fb = FlowBrain(str(tmp_path), fee_bps=7.0, log=lambda m: None)
    tete = fb.heads[HORIZONS_S[0]]
    rng = np.random.default_rng(7)
    n = 1600
    for i in range(n):
        x = rng.normal(0.0, 1.0, 10)
        # payant seulement quand x0 est extrême
        y = (28.0 * x[0] if abs(x[0]) > 1.6 else 0.0) + rng.normal(0.0, 9.0)
        tete.X.append([float(v) for v in x])
        tete.y.append(float(y))
        tete.T.append(i * tete.h)
    tete.fit(lambda m: None)
    assert tete.status == "live", "la queue payante doit passer"
    assert tete.thr_bps > 0 and tete.n_trades >= MIN_TRADES

    fb2 = FlowBrain(str(tmp_path / "bruit"), fee_bps=7.0, log=lambda m: None)
    t2 = fb2.heads[HORIZONS_S[0]]
    rng2 = np.random.default_rng(11)
    for i in range(1600):
        x = rng2.normal(0.0, 1.0, 10)
        t2.X.append([float(v) for v in x])
        t2.y.append(float(rng2.normal(0.0, 12.0)))
        t2.T.append(i * t2.h)
    t2.fit(lambda m: None)
    assert t2.status == "veto", "le bruit ne passe pas la porte conditionnelle"


def test_more_evidence_lowers_the_bar_without_softening_it():
    """La barre du hasard décroît en 1/racine(trades) : c'est pour cela
    que la profondeur d'historique compte. Ce test pinne la relation — et
    qu'aucune profondeur ne rend la porte franchissable par du bruit."""
    from hermes.backtest.metrics import expected_max_sharpe
    from hermes.scalp.clock import DAYS
    n_cells = 3 * 4 * len(FAMILIES) * len(THRESHOLDS)
    peu = expected_max_sharpe(n_cells, 50)
    beaucoup = expected_max_sharpe(n_cells, 500)
    assert peu > 2 * beaucoup, "plus de trades doit abaisser la barre"
    assert beaucoup > 0, "elle ne tombe jamais à zéro"
    # les horloges rapides doivent voir assez de jours pour y arriver
    assert DAYS["5m"] >= 90 and DAYS["1m"] >= 21 and DAYS["15m"] >= 180


def test_overlapping_labels_are_thinned_before_measuring():
    """Sur h barres, deux étiquettes consécutives partagent h-1 barres :
    mesurer sur toutes écrase les erreurs standard d'un facteur racine(h)
    et laisse passer du bruit — constaté, trois horloges vives sur du
    hasard pur avant l'amincissement. Le pas est aussi la vérité
    opérationnelle : une position qui vit h barres interdit d'en rouvrir
    une à chaque barre."""
    from hermes.scalp.clock import HORIZONS
    assert max(HORIZONS) > 1
    vivants = 0
    for seed in range(6):
        rng = np.random.default_rng(500 + seed)
        n = 6000
        px = 100 * np.exp(np.cumsum(rng.normal(0, 0.004, n)))
        o = np.concatenate([[100.0], px[:-1]])
        w = np.abs(rng.normal(0, 0.0013, n)) * px
        c = Candles("X", "5m", np.arange(n) * 300_000, o,
                    np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                    np.abs(rng.normal(1000, 300, n)))
        vivants += CandleModel("5m").fit(c)["status"] == "live"
    assert vivants == 0, f"{vivants}/6 vives sur bruit avec horizons longs"


def test_the_holding_horizon_is_searched_and_charged():
    from hermes.backtest.metrics import expected_max_sharpe
    from hermes.scalp.clock import HORIZONS
    m = CandleModel("5m")
    d = m.fit(_marche_concentre(302, n=8000))
    sans_horizons = expected_max_sharpe(
        3 * 4 * len(FAMILIES) * len(THRESHOLDS), d["n_trades"])
    assert m.sel_bar > sans_horizons, "chercher l'horizon doit se payer"
    assert len(HORIZONS) >= 2
