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
        # La salve dure DEUX barres. Un mouvement prévisible une seule
        # barre à l avance n est pas un avantage : le moteur voit la
        # clôture qui produit le signal, puis agit au tic suivant, et
        # cette barre-là est déjà passée. Une fixture qui plante son
        # signal dans la barre suivante teste une machine qui ne peut pas
        # exister.
        src = (t - 1 if actif[t - 1]
               else (t - 2 if t >= 2 and actif[t - 2] else None))
        if src is not None:
            r[t] = math.copysign(force, r[src]) + rng.normal(0, bruit)
    px = 100 * np.exp(np.cumsum(np.clip(r, -0.05, 0.05)))
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, 3e-4, n)) * px
    return Candles("X", "5m", np.arange(n) * 300_000, o,
                   np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                   np.abs(rng.normal(1000, 300, n)))


def _deux_lectures(c):
    """Les deux façons de lire LE MÊME modèle sur LE MÊME hors-échantillon.

    À gauche l'ancienne porte : frais pleins facturés sur chaque barre, y
    compris celles que le moteur ne trade pas. À droite la porte
    conditionnelle : la règle est « trader quand |prédiction| dépasse le
    seuil », et son économie ne se lit que sur les trades qu'elle produit,
    aux coûts réellement payés — maker sur la jambe posée, taker sur celle
    qui traverse.

    Une comparaison isolée du découpage : c'est le mécanisme qui est en
    cause, pas l'échantillonnage de la porte.
    """
    X = np.column_stack([feat_matrix(c), np.zeros(len(c)), np.zeros(len(c))])
    y, _, _ = _targets(c)
    idx = np.where(np.isfinite(y))[0]
    cut = idx[int(0.8 * len(idx))]
    train, hold = idx[idx < cut], idx[idx >= cut]
    p = RidgeRegressor(l2=14.0).fit(X[train], y[train]).predict(X[hold])
    p_bps, y_bps = p * 1e4, y[hold] * 1e4
    par_barre = float(np.mean(np.sign(p_bps) * y_bps - 7.0))
    sd = float(np.std(p_bps))
    grille = {}
    for k in THRESHOLDS:
        m = np.abs(p_bps) >= k * sd
        if int(m.sum()) < 40:
            continue
        gains = np.sign(p_bps[m]) * y_bps[m]
        grille[k] = float(np.mean(gains - np.where(gains > 0, 4.75, 7.0)))
    return grille, par_barre


def test_the_silences_no_longer_drag_the_measurement_down():
    """Le mécanisme, testé pour lui-même : sur un signal concentré, le net
    PAR TRADE dépasse la moyenne PAR BARRE du même modèle. Les barres
    muettes ne votent plus contre une règle qui ne les trade pas."""
    for seed in range(4):
        c = _marche_concentre(300 + seed)
        grille, par_barre = _deux_lectures(c)
        assert grille, "aucune cellule ne déclenche assez"
        # La cellule k=0 est la règle inconditionnelle elle-même, à ceci
        # près qu'elle paie les coûts RÉELS et asymétriques. Elle domine
        # déjà l'ancienne lecture : celle-ci était pessimiste par
        # construction, elle facturait le taker des deux côtés.
        assert grille[0.0] > par_barre
        # Et l'intérêt du seuil est ailleurs : sur un signal concentré,
        # une cellule STRICTEMENT au-dessus de zéro fait mieux que trader
        # chaque barre. Les barres muettes ne votent plus contre une règle
        # qui ne les trade pas.
        meilleur = max(grille.values())
        assert meilleur > grille[0.0], (
            f"graine {seed} : le seuil n'apporte rien ({grille})")
        # et la porte publie bien une économie par trade, pas par barre
        d = CandleModel("5m").fit(c)
        assert d["n_trades"] <= d["n_holdout"]


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
            # Le seuil peut valoir zéro : « trader chaque barre » est
            # une cellule de la grille comme une autre, et si elle paie
            # ses frais sur tout le holdout c'est le résultat le plus
            # solide de la grille, pas le plus laxiste. Ce qui est exigé
            # tient aux deux lignes au-dessus : net positif après coûts
            # réels, et Sharpe au-dessus de la barre déflatée.
            assert d["thr_bps"] >= 0
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


def _horloge_vive(bar, r_bps, ic=0.2, q=12.0, h=3):
    return {"r_bps": r_bps, "up_bps": abs(r_bps) * 1.2,
            "dn_bps": abs(r_bps) * 1.1, "q_bps": q, "veto": False,
            "bar": bar, "status": "live", "ic": ic, "horizon_bars": h}


def test_one_validated_clock_may_trade_at_half_size():
    """« Deux horloges d'accord, ou rien » datait d'une porte fixe à
    ic>0,03. Chaque horloge franchit maintenant une porte facturée pour
    toutes les cellules cherchées : en exiger deux compte la prudence deux
    fois et interdit de trader ce qui est prouvé. La cohérence devient un
    prix — demi-taille en solo, taille pleine à deux."""
    from hermes.scalp.clock import ScaleDesk
    d = ScaleDesk()
    d.votes[("BTC-USDT-SWAP", "5m")] = _horloge_vive("5m", 14.0)
    seule = d.fuse("BTC-USDT-SWAP")
    assert seule["veto"] is False
    assert seule["alpha"] == 0.5
    assert seule["policy"] == "candle-solo"

    d.votes[("BTC-USDT-SWAP", "15m")] = _horloge_vive("15m", 11.0)
    ensemble = d.fuse("BTC-USDT-SWAP")
    assert ensemble["veto"] is False and ensemble["alpha"] == 1.0
    assert ensemble["policy"] == "candle"


def test_no_validated_clock_still_means_no_trade():
    from hermes.scalp.clock import ScaleDesk
    d = ScaleDesk()
    muette = _horloge_vive("5m", 14.0)
    muette.update({"veto": True, "status": "veto"})
    d.votes[("BTC-USDT-SWAP", "5m")] = muette
    assert d.fuse("BTC-USDT-SWAP")["veto"] is True


def test_the_size_multiplier_reaches_kelly(tmp_path):
    """Le prix de la solitude doit atteindre la TAILLE, pas seulement le
    rapport : sans cela le rabais serait décoratif."""
    from hermes.exchange.broker import PaperBroker
    from hermes.scalp.engine import ScalpEngine

    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0

    class _R:
        trading_allowed = True
        must_flatten = False
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
        state = _E()

    eng = ScalpEngine({"scalp": {}, "costs": {}}, PaperBroker(cash=10_000.0),
                      None, _R(), lambda m: None, str(tmp_path))
    # avantage choisi pour que Kelly morde AVANT le plafond de ruine :
    # sinon les deux tailles buteraient sur le même plafond et le test
    # ne prouverait rien.
    plein = {"tp_bps": 14.0, "sl_bps": 40.0, "edge_bps": 12.0, "vol_bps": 14.0,
             "h_bars": 3, "cost_bps": 8.0, "size_mult": 1.0}
    demi = dict(plein, size_mult=0.5)
    lev_plein, lev_demi = eng._pick_lev(plein), eng._pick_lev(demi)
    assert 0 < lev_demi < lev_plein, f"{lev_demi} devrait être sous {lev_plein}"


def test_mean_reversion_is_now_expressible():
    """Les retours décalés disent le MOUVEMENT récent, jamais la POSITION
    dans la fourchette récente. Un marché de pure réversion — le prix
    revient vers sa moyenne — était donc invisible aux anciennes colonnes.
    Ce test plante exactement ce marché et vérifie que la porte peut le
    voir ; le bruit, lui, reste refusé (test voisin)."""
    from hermes.scalp.clock import feat_matrix
    rng = np.random.default_rng(77)
    n = 6000
    r = np.zeros(n)
    niveau = np.zeros(n)
    for t in range(1, n):
        # Ornstein-Uhlenbeck : le prix est rappelé vers zéro
        niveau[t] = 0.97 * niveau[t - 1] + rng.normal(0, 0.004)
        r[t] = niveau[t] - niveau[t - 1]
    px = 100 * np.exp(niveau)
    o = np.concatenate([[100.0], px[:-1]])
    w = np.abs(rng.normal(0, 3e-4, n)) * px
    c = Candles("X", "5m", np.arange(n) * 300_000, o,
                np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                np.abs(rng.normal(1000, 300, n)))
    X = feat_matrix(c)
    y, _, _ = _targets(c, 1)
    ok = np.isfinite(y)
    z = X[ok, 12]                      # z-score 20 barres
    # le rappel vers la moyenne DOIT être lisible dans cette colonne
    corr = float(np.corrcoef(z, y[ok])[0, 1])
    assert corr < -0.05, f"la colonne de réversion ne voit rien ({corr:+.3f})"
    # et elle est bornée, comme toutes les autres
    assert np.abs(X[:, 12]).max() <= 4.0 + 1e-9
    assert np.isfinite(X).all()


def test_the_hour_of_day_wraps_around_midnight():
    """Une seule colonne d'heure ferait de 23 h et 0 h les deux extrêmes
    opposés d'une échelle. Deux colonnes les rendent voisines."""
    from hermes.scalp.clock import feat_matrix
    n = 300
    ts = (np.arange(n) * 300_000).astype(np.int64)
    px = np.full(n, 100.0)
    c = Candles("X", "5m", ts, px, px, px, px, np.ones(n))
    X = feat_matrix(c)
    s, k = X[:, 14], X[:, 15]
    assert np.allclose(s ** 2 + k ** 2, 1.0, atol=1e-9)
