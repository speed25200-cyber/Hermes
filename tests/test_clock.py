"""Next-bar labels are causal; conformal sits when the interval covers 0."""
import numpy as np
from hermes.data.synthetic import generate
from hermes.scalp.clock import (N_FEATURES, CandleModel, _targets,
                                croise, feat_matrix)


def test_next_bar_label_ignores_bar_after_next():
    c = generate(inst="BTC-USDT-SWAP", bar="1m", n=400, seed=3)
    y0, _, _ = _targets(c)
    v0 = y0[100]
    c.c[-1] *= 2
    c.h[-1] *= 2
    y1, _, _ = _targets(c)
    assert v0 == y1[100]


def test_feat_row_is_finite():
    c = generate(inst="BTC-USDT-SWAP", bar="5m", n=300, seed=1)
    X = feat_matrix(c)
    # 8 colonnes OHLCV + funding, taker, basis, delta-OI
    # + z-scores 20/60 barres, heure du jour (sin/cos), poussée du taker
    assert X.shape[1] == N_FEATURES
    assert np.isfinite(X[-1]).all()


def test_conformal_model_reports_status():
    c = generate(inst="BTC-USDT-SWAP", bar="15m", n=800, seed=9)
    m = CandleModel("15m", fee_bps=7.0)
    d = m.fit(c)
    assert d["status"] in ("live", "veto", "few-samples")
    x = croise(feat_matrix(c))[-1]
    p = m.predict_row(x)
    assert "veto" in p and "r_bps" in p


def test_the_clock_can_see_btc_leading_the_alts():
    """Le décalage BTC -> alts à l'échelle de la minute vit dans la barre
    PRÉCÉDENTE de BTC. L'horloge ne voyait que la barre contemporaine et
    était donc aveugle à l'effet le mieux documenté de ce marché : sur un
    panel où il est planté à 0,25 sigma, aucune horloge ne passait la
    porte. La contre-épreuve compte autant : sur du bruit pur, la colonne
    ne doit fabriquer aucun signal."""
    import numpy as np
    from hermes.data.store import Candles
    from hermes.scalp.clock import CandleModel, _br_serie

    def panel(seed, lead, n=3000, vol=0.004, k=5):
        rng = np.random.default_rng(seed)
        br = rng.normal(0, vol, n)
        def cand(px, nom):
            o = np.concatenate([[px[0]], px[:-1]])
            w = np.abs(rng.normal(0, vol / 3, n)) * px
            return Candles(nom, "1m", np.arange(n) * 60_000, o,
                           np.maximum(o, px) + w, np.minimum(o, px) - w, px,
                           np.abs(rng.normal(1000, 300, n)))
        btc = cand(100 * np.exp(np.cumsum(br)), "BTC-USDT-SWAP")
        out = []
        for _ in range(k):
            r = rng.normal(0, vol, n)
            if lead:
                r[1:] += lead * br[:-1]
            out.append((cand(100 * np.exp(np.cumsum(r)), "A"), btc))
        return out

    vivants = sum(1 for s in range(2)
                  if CandleModel("1m").fit_panel(panel(s, 0.25))["status"] == "live")
    assert vivants == 2, f"{vivants}/2 — le lead-lag planté n'est pas vu"

    bruit = sum(1 for s in range(2)
                if CandleModel("1m").fit_panel(panel(s, 0.0))["status"] == "live")
    assert bruit == 0, f"{bruit}/2 — une horloge passe sur du bruit pur"

    # la colonne doit être STRICTEMENT causale : la barre i de BTC est
    # close quand on prédit i+1, mais i+1 ne doit jamais fuiter
    s = panel(0, 0.25)
    c, btc = s[0]
    br = _br_serie(c, btc)
    assert br is not None and len(br) == len(c)
    assert br[0] == 0.0, "la première barre ne peut pas connaître de retour"


def test_volume_is_reachable_at_all():
    """Le volume n'entrait dans AUCUNE des colonnes : `c.v` n'apparaissait
    nulle part dans la matrice. Un mouvement d'un demi sigma sur gros
    volume et le même sur volume mort donnaient exactement les mêmes
    entrées — or l'un est une arrivée d'information et l'autre un accident
    de liquidité, et la barre suivante ne fait pas la même chose."""
    import numpy as np
    from hermes.data.store import Candles
    from hermes.scalp.clock import CandleModel, feat_matrix
    import hermes.scalp.clock as K

    def panel(seed, effet, n=3000, vol=0.004, k=4):
        rng = np.random.default_rng(seed)
        out = []
        for _ in range(k):
            lv = rng.normal(0, 1.0, n)
            r = rng.normal(0, vol, n)
            if effet:
                r[1:] += effet * vol * lv[:-1]
            px = 100 * np.exp(np.cumsum(r))
            o = np.concatenate([[100.0], px[:-1]])
            w = np.abs(rng.normal(0, vol / 3, n)) * px
            out.append((Candles("A", "1m", np.arange(n) * 60_000, o,
                                np.maximum(o, px) + w, np.minimum(o, px) - w,
                                px, 1000.0 * np.exp(lv)), None))
        return out

    # la colonne porte bien le volume, et rien d'autre ne le porte
    n = 2000
    rng = np.random.default_rng(3)
    lv = rng.normal(0, 1.0, n)
    plat = np.full(n, 100.0)
    X = feat_matrix(Candles("A", "1m", np.arange(n) * 60_000, plat, plat,
                            plat, plat, 1000.0 * np.exp(lv)))
    porteuses = [j for j in range(X.shape[1])
                 if abs(np.corrcoef(X[200:, j], lv[200:])[0, 1] or 0) > 0.5]
    assert len(porteuses) == 1, f"{len(porteuses)} colonnes portent le volume"

    # sans elle, l'effet planté est INVISIBLE ; avec elle, il passe la porte
    plein = K.feat_matrix
    j = porteuses[0]

    def aveugle(c):
        Y = plein(c)
        Y[:, j] = 0.0
        return Y
    try:
        K.feat_matrix = aveugle
        sourds = sum(1 for s in range(2)
                     if CandleModel("1m").fit_panel(panel(s, 0.30))["status"]
                     == "live")
    finally:
        K.feat_matrix = plein
    assert sourds == 0, f"{sourds}/2 — l'effet passe sans la colonne volume"

    vus = sum(1 for s in range(2)
              if CandleModel("1m").fit_panel(panel(s, 0.30))["status"] == "live")
    assert vus == 2, f"{vus}/2 — la colonne volume ne rend pas l'effet visible"

    # contre-épreuve : sur du bruit pur elle ne fabrique rien
    bruit = sum(1 for s in range(2)
                if CandleModel("1m").fit_panel(panel(s, 0.0))["status"] == "live")
    assert bruit == 0, f"{bruit}/2 — une horloge passe sur du bruit"


def test_the_market_factor_leaves_the_asset_out_and_aligns_on_time():
    """Deux proprietes sans lesquelles le facteur transversal est faux, et
    faux SILENCIEUSEMENT — rien ne planterait, les chiffres resteraient
    plausibles.

    Privee de soi : inclure l actif dans sa propre moyenne retrecit
    mecaniquement son residu d un facteur (N-1)/N et melange sa cible a
    son entree.

    Alignee sur les HORODATAGES : deux actifs d historiques differents
    n ont pas la meme longueur, et un alignement par la fin ferait lire a
    l un la barre de l autre. C est exactement le defaut que l ancien
    _br_serie evitait de justesse en refusant les series trop courtes.
    """
    import numpy as np
    from hermes.scalp.clock import _mkt_series

    t = np.arange(6, dtype=np.int64) * 60_000
    a = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    b = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    c = np.array([-1.0, -2.0, -3.0, -4.0, -5.0, -6.0])
    m = _mkt_series([(t, a), (t, b), (t, c)])
    assert np.allclose(m[0], (b + c) / 2.0), "la moyenne inclut lactif lui-meme"
    assert np.allclose(m[1], (a + c) / 2.0)
    assert np.allclose(m[2], (a + b) / 2.0)

    # Historiques rague : le troisieme actif ne couvre que la fin. Sur les
    # barres ou il est absent, les autres se moyennent entre eux ; la ou
    # il est present, il compte.
    court_t, court_u = t[3:], np.array([10.0, 10.0, 10.0])
    m = _mkt_series([(t, a), (t, b), (court_t, court_u)])
    assert np.allclose(m[0][:3], b[:3]), "un actif absent a quand meme compte"
    assert np.allclose(m[0][3:], (b[3:] + court_u) / 2.0)
    assert np.allclose(m[2], (a[3:] + b[3:]) / 2.0), "alignement par la fin"

    # Un seul actif : pas de panel, pas de moyenne — et surtout pas zero
    # confondu avec une mesure.
    assert _mkt_series([(t, a)]) == [None]


def test_the_residual_is_measured_against_the_panel_when_there_is_one():
    """xs remplace idio : meme colonne, meilleur estimateur.

    Contre BTC, le residu vaut e_i - e_btc, domine par l idio de BTC qui
    est souvent le plus gros du panel. Contre la moyenne des N-1 autres,
    il vaut e_i - bruit/racine(N-1). La colonne ne change pas de place,
    elle change de precision — et le nombre de colonnes croisees reste
    trois, ce qui compte : quatre colonnes de bruit avaient suffi a faire
    echouer une regle par ailleurs vraie.
    """
    import numpy as np
    from hermes.scalp.clock import CROISEES, N_CROISE, col, croise

    n = 40
    X = np.zeros((n, len(__import__("hermes.scalp.clock", fromlist=["COLONNES"]).COLONNES)))
    X[:, col("r1")] = 1.0
    br = np.full(n, 0.25)
    mkt = np.full(n, 0.75)

    sans = croise(X, br)
    avec = croise(X, br, mkt)
    assert sans.shape == avec.shape and N_CROISE == 3
    i_xs = X.shape[1] + CROISEES.index("xs")
    i_br = X.shape[1] + CROISEES.index("btc_r1")
    assert np.allclose(sans[:, i_xs], 0.75), "sans panel, le residu reste contre BTC"
    assert np.allclose(avec[:, i_xs], 0.25), "le residu ignore la moyenne du panel"
    # et le MENEUR reste BTC dans les deux cas : c est lui qui porte le
    # decalage BTC -> alts, que la moyenne du panel ne peut pas porter.
    assert np.allclose(sans[:, i_br], 0.25) and np.allclose(avec[:, i_br], 0.25)


def test_the_clock_can_see_a_cross_sectional_reversal():
    """« Ce que ce nom a fait de plus que le marche » revient en partie a
    court horizon : c est l effet transversal le mieux etabli de ce
    marche, et l horloge y etait a moitie aveugle.

    A moitie seulement, parce qu elle mesurait bien un residu — mais
    contre BTC, dont l idiosyncrasie est souvent la plus grosse du panel.
    Le residu valait alors e_i - e_btc : le bon signal plus le bruit du
    plus bruyant. Contre la moyenne des autres, il vaut e_i moins un bruit
    divise par racine(N-1).

    Mesure sur ce marche-la, huit actifs, BTC portant trois fois l idio
    des autres : ic +0,2242 contre BTC seul, +0,3047 avec le residu panel,
    a nombre de colonnes egal. La contre-epreuve compte autant — sur du
    bruit pur, aucune des deux ne passe.
    """
    import numpy as np
    from hermes.data.store import Candles
    from hermes.scalp.clock import CandleModel

    noms = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB"]

    def panel(seed, kappa, n=2400):
        rng = np.random.default_rng(seed)
        ts = np.arange(n, dtype=np.int64) * 300_000
        f = rng.normal(0, 6e-4, n)                       # facteur commun
        e = np.vstack([rng.normal(0, 12e-4 if i == 0 else 4e-4, n)
                       for i in range(len(noms))])       # BTC bouge seul
        r = f[None, :] + e
        r[:, 1:] -= kappa * e[:, :-1]                    # reversion du residu
        cs = []
        for i, nom in enumerate(noms):
            px = 100 * np.exp(np.cumsum(np.clip(r[i], -0.05, 0.05)))
            o = np.concatenate([[100.0], px[:-1]])
            w = np.abs(rng.normal(0, 3e-4, n)) * px
            cs.append(Candles(nom, "5m", ts, o, np.maximum(o, px) + w,
                              np.minimum(o, px) - w, px,
                              np.abs(rng.normal(1000, 100, n))))
        return [(cs[i], None if i == 0 else cs[0]) for i in range(len(noms))]

    vifs = sum(1 for s in range(2)
               if CandleModel("5m").fit_panel(panel(30 + s, 0.6))["status"] == "live")
    assert vifs == 2, f"{vifs}/2 — la reversion transversale nest pas vue"

    bruit = sum(1 for s in range(2)
                if CandleModel("5m").fit_panel(panel(30 + s, 0.0))["status"] == "live")
    assert bruit == 0, f"{bruit}/2 — une horloge passe sur du bruit pur"


def test_the_perp_pressure_lives_in_the_basis_CHANGE_not_its_level():
    """Le NIVEAU du basis dit qu un perpetuel est cher par rapport a son
    indice ; sa VARIATION dit que quelqu un vient de payer pour l acheter
    LA, tout de suite, sans passer par le comptant. C est la pression
    propre au perpetuel — le seul signal que ce marche possede et que le
    comptant n a pas.

    Mesure, meme protocole que pour le volume, sur une fixture ou le
    prochain retour vaut effet x d(basis) et ou le niveau ne dit rien :

      SANS la colonne   live 0/3   ic +0,0311
      AVEC la colonne   live 3/3   ic +0,8393
      bruit pur         live 0/3   ic -0,0118   (les deux)

    Cout ailleurs, sur la fixture d interaction ou d_basis vaut
    IDENTIQUEMENT ZERO — elle ne peut donc rien y apporter ni rien y
    coûter :

      un seul reseau    mlp/ens 11/12 sans, 8/12 avec
      trois reseaux     mlp/ens 11/12 sans, 12/12 avec

    Le « cout » du premier tableau n en etait pas un. Aucune information
    n avait bouge — seul le tirage d initialisation, que le nombre de
    colonnes decale. C est cette mesure-la qui a impose de moyenner
    plusieurs initialisations dans le reseau ; une fois la loterie
    retiree, la colonne est gratuite.
    """
    import numpy as np

    from hermes.data.store import Candles
    from hermes.scalp.clock import col, feat_matrix

    n = 1200
    rng = np.random.default_rng(3)
    bs = np.cumsum(rng.normal(0, 2e-4, n))
    bs = np.clip(bs - np.convolve(bs, np.ones(200) / 200, mode="same"),
                 -3e-3, 3e-3)
    px = 100 * np.exp(np.cumsum(rng.normal(0, 6e-4, n)))
    o = np.concatenate([[100.0], px[:-1]])
    c = Candles("X", "5m", np.arange(n) * 300_000, o, px * 1.001, px * 0.999,
                px, np.ones(n), mark=px, index=px / (1.0 + bs))

    X = feat_matrix(c)
    niveau = np.clip(np.nan_to_num(c.basis, nan=0.0) * 1e4, -50, 50)
    attendu = np.concatenate([[0.0], np.diff(niveau)])
    obtenu = X[:, col("d_basis")]
    assert np.corrcoef(obtenu, attendu)[0, 1] > 0.99, "la colonne ne porte pas d(basis)"
    # et elle est DISTINCTE du niveau, sinon elle n apporte rien
    assert abs(float(np.corrcoef(obtenu, X[:, col("basis")])[0, 1])) < 0.5

    # Une serie sans mark ni index laisse la colonne a zero : une
    # information absente ne doit pas se distinguer d une information
    # nulle. Mesure isolee : jusqu a onze colonnes mortes ne coutent rien
    # au reseau (ic +0,3605 a zero morte, +0,3677 a onze).
    muet = Candles("X", "5m", np.arange(n) * 300_000, o, px * 1.001,
                   px * 0.999, px, np.ones(n))
    assert not feat_matrix(muet)[:, col("d_basis")].any()


def test_a_column_the_store_cannot_fill_costs_the_net_nothing():
    """La matrice promet qu une information absente ne se distingue pas
    d une information nulle — funding, oi, taker et basis valent zero
    quand la serie manque. Si une colonne morte degradait quand meme le
    reseau, cette promesse serait fausse pour TOUT actif dont le magasin
    ne porte pas encore les series derivees, c est-a-dire chaque nom qui
    vient d entrer au panel.
    """
    import numpy as np

    from hermes.ml.models import MLPRegressor

    def ic(seed, mortes):
        rng = np.random.default_rng(seed)
        n = 4000
        X = rng.normal(size=(n, 20))
        y = 0.7 * X[:, 0] * np.sign(X[:, 1]) + rng.normal(0, 1.0, n)
        if mortes:
            X = np.column_stack([X, np.zeros((n, mortes))])
        p = MLPRegressor(hidden=(24, 12), epochs=120,
                         patience=10).fit(X[:3200], y[:3200]).predict(X[3200:])
        if p.std() < 1e-12:
            return 0.0
        return float(np.corrcoef(p, y[3200:])[0, 1])

    vif = float(np.mean([ic(s, 0) for s in range(4)]))
    mort = float(np.mean([ic(s, 11) for s in range(4)]))
    assert mort > 0.85 * vif, f"onze colonnes mortes coutent : {vif:.3f} -> {mort:.3f}"


def test_the_entry_price_is_one_the_engine_can_actually_get():
    """La porte simulait un remplissage AU PRIX DE CLOTURE de la barre qui
    decide. Ce prix existait deja quand l ordre est parti.

    Le moteur voit la cloture de la barre i, envoie un ordre, et le
    remplissage arrive 2,0 secondes plus tard — mesure en production,
    retard_s sur 458 ordres. Ce qu il obtient est l ouverture de la barre
    suivante, jamais la cloture de la precedente.

    L ecart porte exactement le rebond bid-ask, et c est pour cela qu il
    compte : chaque print tombe au bid ou a l ask, si bien que la serie
    des clotures herite d une autocorrelation negative qui ne doit rien a
    une prevision et que personne ne peut encaisser.
    """
    import numpy as np

    from hermes.data.store import Candles
    from hermes.scalp.clock import _targets

    n = 200
    px = 100 + np.arange(n) * 0.1
    o = px - 0.05                      # ouverture DIFFERENTE de la cloture
    c = Candles("X", "5m", np.arange(n) * 300_000, o, px + 0.2, px - 0.2,
                px, np.ones(n))
    y, _, _ = _targets(c, h=1)
    assert abs(y[0] - (px[1] / o[1] - 1.0)) < 1e-12, (
        "l entree n est pas l ouverture de la barre suivante")
    y3, _, _ = _targets(c, h=3)
    assert abs(y3[0] - (px[3] / o[1] - 1.0)) < 1e-12


def test_a_pure_bid_ask_bounce_is_not_a_forecast():
    """Un marche ou le prix efficient est une marche aleatoire PURE et ou
    seul le rebond existe. Il n y a rien a prevoir, et pourtant la serie
    des clotures est fortement auto-correlee.

    Mesure sur ce marche : autocorrelation des retours de cloture -0,131,
    contre -0,023 pour le retour ouverture -> cloture suivante. Avec une
    entree a la cloture, le modele voyait ic +0,12 a +0,13 ; avec
    l entree honnete il tombe a +0,02. La porte refusait deja ces
    cellules par l economie (net -2 a -3 bps) — mais un mirage qu on ne
    voit plus vaut mieux qu un mirage refuse de justesse.
    """
    import numpy as np

    from hermes.data.store import Candles
    from hermes.scalp.clock import CandleModel

    def marche(seed, n=2500, k=3, spread_bps=6.0, vol=6e-4):
        rng = np.random.default_rng(seed)
        commun = rng.normal(0, vol, n)
        demi = spread_bps * 1e-4 / 2.0
        out = []
        for i in range(k):
            r = 0.7 * commun + rng.normal(0, vol, n)
            p = 100 * np.exp(np.cumsum(r))
            c_obs = p * (1.0 + demi * rng.choice([-1.0, 1.0], n))
            o_obs = p * (1.0 + demi * rng.choice([-1.0, 1.0], n))
            w = np.abs(rng.normal(0, 1.0, n)) * vol * p
            out.append((Candles(f"A{i}", "5m", np.arange(n) * 300_000, o_obs,
                                np.maximum(o_obs, c_obs) + w,
                                np.minimum(o_obs, c_obs) - w, c_obs,
                                np.abs(rng.normal(1000, 300, n))), None))
        return out

    # le rebond est bien la, et il ne survit pas au changement de base
    s = marche(1)[0][0]
    r = np.diff(s.c) / s.c[:-1]
    assert np.corrcoef(r[:-1], r[1:])[0, 1] < -0.05, "pas de rebond dans la fixture"
    r_oc = (s.c[1:] - s.o[1:]) / s.o[1:]
    assert abs(np.corrcoef(r[:-1], r_oc[1:])[0, 1]) < 0.06

    for seed in range(3):
        d = CandleModel("5m").fit_panel(marche(10 + seed))
        assert d["status"] != "live", f"le rebond passe la porte : {d}"
        assert abs(d["ic"]) < 0.06, f"le modele voit encore le rebond : ic={d['ic']:+.3f}"


def test_the_bar_does_not_move_when_the_aggregation_changes():
    """Changer la série mesurée sans revérifier la barre, c'est abaisser
    la porte en silence.

    La barre vaut `expected_max_sharpe(n_cells, instants)` et elle a été
    calibrée comme le 95e centile du MAX de Sharpe sur n_cells cellules
    SOUS L'HYPOTHÈSE NULLE. Passer la sélection en unités de risque
    change la série ; si cela gonflait le max du hasard, le gain mesuré
    ailleurs serait du hasard réétiqueté.

    Nul DUR, celui qui fait mentir une barre trop optimiste : queues de
    Student à 3 degrés de liberté (variance finie, kurtosis infinie) et
    sigma qui respire par régimes — exactement la structure qui crée
    l'hétéroscédasticité que la nouvelle formule retire.
    """
    import math

    import numpy as np

    from hermes.scalp.clock import _en_risque, _portfolio, expected_max_sharpe

    rng = np.random.default_rng(2024)
    n_cellules, n_inst, n_actifs, df = 300, 1143, 8, 3.0

    b = np.exp(np.cumsum(rng.normal(0, 0.03, (n_cellules, n_inst)), axis=1))
    b = 10e-4 * b / b.mean(axis=1, keepdims=True)
    b = np.clip(b, 4e-4, 40e-4)
    sig = b[:, :, None] * np.exp(rng.normal(0, 0.25, (n_cellules, n_inst, n_actifs)))
    u = rng.standard_t(df, (n_cellules, n_inst, n_actifs)) / math.sqrt(df / (df - 2.0))
    net = sig * u * 1e4                       # AUCUN avantage

    ts = np.repeat(np.arange(n_inst), n_actifs)
    anciens, nouveaux = [], []
    for i in range(n_cellules):
        pl = net[i].ravel()
        sg = sig[i].ravel()
        a = _portfolio(pl, ts, 1.0 / np.maximum(sg, 1e-12))
        r = _en_risque(pl, ts, sg)
        anciens.append(float(np.mean(a)) / float(np.std(a, ddof=1)))
        nouveaux.append(float(np.mean(r)) / float(np.std(r, ddof=1)))

    # Le max sur n_cells cellules se déduit de l'écart-type des Sharpe
    # sous le nul : max ≈ z(n_cells) · sd. La fonction vaut
    # `sqrt(1/(n_obs-1)) · z`, donc z s'en extrait en remultipliant —
    # elle renvoie 0 pour n_obs < 3 et ne peut pas donner z directement.
    barre = expected_max_sharpe(4860, n_inst)
    z = barre * math.sqrt(n_inst - 1)
    max_a = z * float(np.std(anciens, ddof=1))
    max_r = z * float(np.std(nouveaux, ddof=1))

    for nom, m in (("ancienne", max_a), ("en risque", max_r)):
        assert abs(m / barre - 1.0) < 0.10, \
            f"agregation {nom} : max du hasard {m:.4f} contre barre {barre:.4f}"
    assert abs(max_r - max_a) / barre < 0.06, \
        f"les deux agregations ne voient pas le meme hasard : {max_a:.4f} vs {max_r:.4f}"


def test_measuring_in_risk_units_never_overshoots_the_book_actually_held():
    """La preuve qu'il ne s'agit pas de fabriquer du Sharpe.

    Le moteur dimensionne chaque jambe à risque égal — le plafond de
    ruine donne une taille proportionnelle à 1/sigma. Le P&L en dollars
    d'un instant vaut donc `somme(r_i / sigma_i)`, et le Sharpe de CETTE
    série est la vérité terrain, calculée ici indépendamment des deux
    formules d'agrégation.

    Ce qu'on exige, dans les deux régimes d'avantage — proportionnel à
    sigma (ce que produit un seuil exprimé en sigma) ET constant en bps
    (le cas où la nouvelle formule pourrait tricher) :

      ancienne  <=  en risque  <=  vérité

    Autrement dit : la nouvelle mesure retire un biais VERS LE BAS sans
    jamais en créer un vers le haut. Si elle dépassait la vérité, elle
    fabriquerait de l'avantage et devrait être rejetée.
    """
    import numpy as np

    from hermes.scalp.clock import _en_risque, _portfolio

    def sharpe(x):
        sd = float(np.std(x, ddof=1))
        return float(np.mean(x)) / sd if sd > 1e-15 else 0.0

    def panel(rng, mode, n_inst=4000, n_actifs=8, edge=0.05):
        b = np.exp(np.cumsum(rng.normal(0, 0.03, n_inst)))
        b = 10e-4 * b / b.mean()
        b = np.clip(b, 4e-4, 40e-4)          # x3 entre calme et tempete
        sig = b[:, None] * np.exp(rng.normal(0, 0.25, (n_inst, n_actifs)))
        mu = sig * edge if mode == "sigma" else np.full_like(sig, 10e-4 * edge)
        net = (mu + sig * rng.normal(0, 1.0, sig.shape)) * 1e4
        ts = np.repeat(np.arange(n_inst), n_actifs)
        return net.ravel(), sig.ravel(), ts

    for mode in ("sigma", "bps"):
        rng = np.random.default_rng(11 if mode == "sigma" else 12)
        a = r = v = 0.0
        tours = 8
        for _ in range(tours):
            net, sig, ts = panel(rng, mode)
            a += sharpe(_portfolio(net, ts, 1.0 / sig))
            r += sharpe(_en_risque(net, ts, sig))
            # verite terrain, calculee sans passer par les agregations :
            # le P&L en dollars du livre a risque constant.
            _, inv = np.unique(ts, return_inverse=True)
            v += sharpe(np.bincount(inv, weights=net / sig))
        a, r, v = a / tours, r / tours, v / tours
        assert a <= r + 1e-9, \
            f"[{mode}] la mesure en risque est SOUS l ancienne : {r:.4f} < {a:.4f}"
        assert r <= v + 1e-9, \
            f"[{mode}] la mesure en risque DEPASSE le livre tenu : {r:.4f} > {v:.4f}"

    # Contre-épreuve : sans régimes de volatilité, il n'y a rien à
    # corriger et les deux formules doivent presque coïncider. Sinon le
    # gain viendrait d'autre chose que de l'hétéroscédasticité.
    rng = np.random.default_rng(13)
    n_inst, n_actifs = 4000, 8
    sig = np.full((n_inst, n_actifs), 10e-4) * np.exp(rng.normal(0, 0.25, (n_inst, n_actifs)))
    net = (sig * 0.05 + sig * rng.normal(0, 1.0, sig.shape)) * 1e4
    ts = np.repeat(np.arange(n_inst), n_actifs)
    a = sharpe(_portfolio(net.ravel(), ts, 1.0 / sig.ravel()))
    r = sharpe(_en_risque(net.ravel(), ts, sig.ravel()))
    assert abs(r - a) < 0.15 * max(abs(a), 1e-9), \
        f"sans regimes, les deux mesures divergent quand meme : {a:.4f} vs {r:.4f}"


def test_the_reported_ic_belongs_to_the_variant_that_was_selected():
    """« [ridge/h6/neu] ic=0.010 » décrivait la série `abs`.

    L'ic était calculé une seule fois, sur la prédiction brute, avant la
    boucle des variantes — puis journalisé tel quel même quand la
    cellule retenue était `neu`. Deux conséquences, toutes deux graves :

    - la porte teste `ic > 2/racine(n)` et le testait sur une autre série
      que celle qu'elle sélectionne ;
    - comparer l'ic entre deux ajustements dont la variante a changé
      comparait deux choses différentes — et c'est avec cet ic-là que je
      jugeais si les colonnes neuves payaient.

    Fixture construite pour que les deux séries soient franchement
    différentes : un facteur commun fort que `neu` retranche et que `abs`
    conserve. Si l'ic rapporté ne dépendait pas de la variante, les deux
    cellules montreraient le même chiffre.
    """
    import inspect

    from hermes.scalp import clock

    src = inspect.getsource(clock.CandleModel._chercher
                            if hasattr(clock.CandleModel, "_chercher")
                            else clock.CandleModel)

    # L'ic de la variante est calculé DANS la boucle des variantes.
    assert 'ic = _ic(pv, yho) if var != "abs" else ic_abs' in src, \
        "l ic n est plus calcule par variante"
    # Et le repli garde délibérément l'ic de la série brute : il répond à
    # une autre question, qui ne dépend pas de la variante.
    assert 'muet.update({"ic": ic_abs' in src, \
        "le repli lit un ic qui fuit de la boucle des variantes"


def test_a_cell_the_engine_cannot_size_says_so():
    """Une pente négative rend le shrink nul, et le silence est total.

    `shrink = max(0 ; 1 + (pente − 1)·crédit)`. Le verdict 1H du 27 août
    portait `pente=-0.70` sur 1 142 instants, donc un crédit de 1, donc
    un shrink de EXACTEMENT zéro. Une telle cellule, si elle franchissait
    la barre, serait déclarée `live`, bloquerait toutes les autres, et ne
    produirait jamais une prédiction tradable — sans que rien ne le dise.

    Ce test n'exige pas qu'on la rejette : on ne sait pas encore si c'est
    fréquent, et changer le classement sans mesure serait exactement
    l'erreur déjà commise sur le filtre 24/7. Il exige qu'on la VOIE.
    """
    import inspect

    from hermes.scalp import clock

    src = inspect.getsource(clock)
    assert "INERTE(shrink=0)" in src, \
        "une cellule live que le moteur ne peut pas dimensionner reste muette"

    # La formule qui produit le zéro, ancrée pour que le test parle du
    # même mécanisme si elle change.
    for pente, credit, attendu in ((-0.70, 1.0, 0.0), (0.0, 1.0, 0.0),
                                   (1.0, 1.0, 1.0), (2.0, 0.5, 1.5)):
        assert min(3.0, max(0.0, 1.0 + (pente - 1.0) * credit)) == attendu


def test_the_slope_reports_how_well_it_is_measured():
    """Une pente négative annule la cellule ; encore faut-il qu'elle soit vraie.

    `shrink = max(0 ; 1 + (pente − 1)·crédit)`. Le verdict 1H portait
    −0,70 puis −1,53 sur deux ajustements consécutifs, donc un shrink nul
    et une cellule inerte — alors que la porte venait de valider son net
    (+40,95 bps/trade) et son Sharpe SUR LES MÊMES LIGNES. Deux
    statistiques du même sous-ensemble se contredisent.

    La pente est mesurée sur le sous-ensemble DÉCLENCHÉ, `|pred| ≥ k·σ`.
    Conditionner sur la variable explicative atténue la pente vers zéro :
    en sélectionnant les prédictions extrêmes on sélectionne aussi les
    lignes où la part de BRUIT de la prédiction est extrême, et le réalisé
    ne suit pas ce bruit. Avec un ic de 0,010 la part de signal est
    minuscule, et l'atténuation peut faire passer la pente sous zéro sans
    la moindre anti-prédiction.

    Ce test n'arbitre pas — il exige que l'erreur type soit MESURÉE, pour
    que la question « cette pente est-elle établie ? » ait une réponse
    chiffrée au lieu d'un raisonnement.
    """
    import numpy as np

    from hermes.scalp.clock import _pente_et_erreur

    rng = np.random.default_rng(31)

    # 1) Une pente parfaitement connue : b proche de 2, erreur petite.
    x = rng.normal(0, 1, 4000)
    y = 2.0 * x + rng.normal(0, 0.1, 4000)
    b, se = _pente_et_erreur(x, y)
    assert abs(b - 2.0) < 0.02, b
    assert se < 0.01, se
    assert abs(b - 2.0) < 4 * se

    # 2) Le cas du 1H : une prédiction presque toute en bruit. La pente
    #    mesurée part n'importe où, et l'erreur type doit le DIRE.
    signal = rng.normal(0, 1, 4000)
    pred = signal + rng.normal(0, 30.0, 4000)      # ic minuscule
    reel = signal + rng.normal(0, 10.0, 4000)
    b2, se2 = _pente_et_erreur(pred, reel)
    assert se2 > 0.0 and np.isfinite(se2)
    # La vraie pente vaut var(signal)/var(pred) ~ 1/901, soit ~0. Ce qui
    # compte est que l ecart a 1 soit ENORME en erreurs types : la mesure
    # dit alors « le modele sur-annonce », pas « il se trompe de sens ».
    assert abs(b2 - 1.0) / se2 > 3.0

    # 3) Trop peu de points : aucune pente ne peut etre affirmee.
    b3, se3 = _pente_et_erreur(np.array([1.0, 2.0]), np.array([1.0, 2.0]))
    assert se3 == float("inf"), se3
    # Et une prediction constante non plus.
    b4, se4 = _pente_et_erreur(np.zeros(500), rng.normal(0, 1, 500))
    assert b4 == 0.0 and se4 == float("inf")


def test_the_verdict_line_carries_the_slope_uncertainty():
    """Le journal doit porter `pente=X+-Y`, sinon la question reste ouverte
    à chaque relevé et on retombe sur le raisonnement."""
    import inspect

    from hermes.scalp import clock

    src = inspect.getsource(clock)
    assert 'f"pente={d[\'pente\']:.2f}"' in src
    assert '+-{d[\'se_pente\']:.2f}' in src, \
        "lerreur type de la pente natteint pas le journal"


def test_the_slope_is_measured_on_what_the_strategy_actually_realises():
    """Le verdict 1H portait `net=+40.95bps` ET `pente=-1.53`, sur les
    mêmes lignes. Ce n'est pas une contradiction : ce sont deux
    rendements différents.

    `pente` régressait `yho` — la cible BRUTE du holdout, queues
    entières. `net` vient de `gains`, l'issue APRÈS simulation du stop.
    Une pente OLS sur des queues épaisses est dominée par une poignée de
    points extrêmes, et ce sont précisément ceux que le stop coupe. La
    stratégie ne réalise jamais `yho` ; calibrer contre lui la magnitude
    annoncée, puis s'en servir pour dimensionner une stratégie stoppée,
    est une erreur de catégorie — et elle coûtait `shrink = 0`, donc
    l'inertie totale.

    Trois mécanismes bénins avaient été essayés et aucun ne reproduisait
    −1,53 : atténuation de sélection sur vérité linéaire calibrée
    (+0,93), modèle qui sur-annonce (+0,31), sur-extrapolation avec
    signal mort au-delà de 2 σ (+0,06 — elle pousse vers ZÉRO, pas vers
    −1,5). Seules les queues épaisses non tronquées y parviennent.

    Mesure à l'échelle de la production, 60 tirages par ligne :

        queues   BRUTE  min     <0     RÉELLE  min     <0
        df=2,5   +0,96  -1,21   13 %   +1,50   -0,29   3 %
        df=3     +0,91  -0,21    7 %   +1,23   +0,02   0 %
        df=4     +0,91  -0,08    3 %   +1,07   +0,03   0 %
        df=8     +1,06  +0,13    0 %   +1,11   +0,16   0 %

    Ce qui est vrai et ce qui ne l'est pas : la pente réelle n'est PAS
    garantie positive — elle l'est simplement bien plus souvent, et son
    pire cas est bien moins extrême. L'écart se creuse avec l'épaisseur
    des queues et disparaît quand elles s'amincissent, ce qui est la
    signature du mécanisme invoqué. Avec une autre graine le minimum de
    la pente brute descendait à −5,56 : la statistique brute est
    elle-même instable, et c'est le reproche.
    """
    import numpy as np

    from hermes.scalp.clock import _pente_et_erreur

    def deux_pentes(df, tirages, n=100_000, part=0.0125, stop=3.0, graine=404):
        rng = np.random.default_rng(graine)
        brut, reel = [], []
        for _ in range(tirages):
            sig = rng.normal(0, 1.0, n)
            pred = sig + rng.normal(0, 9.0, n)
            y = sig * 0.6 + rng.standard_t(df, n) * 3.0
            b0 = float(np.cov(pred, y)[0, 1] / np.var(pred))
            if abs(b0) > 1e-12:
                pred = pred * b0                      # pente pleine = 1
            seuil = np.quantile(np.abs(pred), 1.0 - part)
            m = np.abs(pred) >= seuil
            sens = np.sign(pred[m])
            gains = np.maximum(sens * y[m], -stop * float(np.std(y)))
            brut.append(_pente_et_erreur(pred[m], y[m])[0])
            reel.append(_pente_et_erreur(pred[m], sens * gains)[0])
        return np.asarray(brut), np.asarray(reel)

    # Queues epaisses : la pente reelle domine, et son pire cas est bien
    # moins extreme. Ce sont les deux seules choses que la mesure permet
    # d affirmer — pas que la pente reelle soit toujours positive.
    b25, r25 = deux_pentes(2.5, 25)
    assert r25.mean() > b25.mean() + 0.15, \
        f"reelle {r25.mean():+.2f} contre brute {b25.mean():+.2f}"
    assert r25.min() > b25.min() + 0.30, \
        f"pire cas reel {r25.min():+.2f} contre brut {b25.min():+.2f}"

    # Queues fines : le stop ne tronque presque rien, les deux pentes se
    # rejoignent. Si l ecart subsistait la, il viendrait d autre chose
    # que du mecanisme invoque et l explication serait fausse.
    b8, r8 = deux_pentes(8.0, 25)
    assert abs(r8.mean() - b8.mean()) < abs(r25.mean() - b25.mean()), \
        "lecart ne depend pas de lepaisseur des queues : mecanisme faux"

    # Et le code mesure bien celle-la, avec la brute journalisee a cote.
    import inspect

    from hermes.scalp import clock

    src = inspect.getsource(clock)
    assert "_pente_et_erreur(pv[m], sens * gains)" in src, \
        "la pente est encore mesuree sur un rendement non realise"
    assert "_pente_et_erreur(pv[m], yho[m])" in src, \
        "la pente brute nest plus journalisee, la comparaison est perdue"
    assert "pente_brut" in src


def test_the_two_series_share_one_sort_and_agree_with_the_separate_ones():
    """Ajouter la mesure en risque avait DOUBLÉ les tris du balayage.

    `_portfolio` et `_en_risque` mesurent le même portefeuille dans deux
    unités, et chacune faisait son propre `np.unique` sur les mêmes
    horodatages. Le balayage en appelle une par cellule — 4 860 par
    échelle — donc la seconde mesure a doublé le coût de la boucle la
    plus interne.

    Mesure du 27 août, et elle est sévère : après le déploiement, AUCUN
    verdict d'horloge n'est sorti en deux fenêtres de trente-sept
    minutes, là où un moteur sain en produit quatre. Le cycle complet
    était passé d'environ cinquante minutes à environ cent, et chaque
    déploiement l'interrompait avant le premier verdict. Le défaut ne
    s'est pas vu en test : une suite qui passe ne dit rien du temps de
    calcul en production.

    Ce test exige les deux choses qui comptent : un seul tri, et des
    résultats identiques à ceux des deux fonctions séparées — celles par
    lesquelles la barre a été vérifiée sous nul dur.
    """
    import numpy as np

    from hermes.scalp import clock

    rng = np.random.default_rng(505)
    n = 4000
    ts = np.sort(rng.integers(0, 900, n)).astype(np.int64)
    net = rng.normal(0, 12.0, n)
    sig = np.exp(rng.normal(-7.0, 0.4, n))

    bps, risque = clock._agreger(net, ts, sig)
    bps_ref = clock._portfolio(net, ts, 1.0 / np.maximum(sig, 1e-12))
    risque_ref = clock._en_risque(net, ts, sig)

    assert np.allclose(bps, bps_ref), "la serie en bps a change de valeur"
    assert np.allclose(risque, risque_ref), "la serie en risque a change de valeur"
    assert len(bps) == len(risque) == len(np.unique(ts))

    # Un seul tri : on compte les appels reellement passes.
    appels = {"n": 0}
    vrai = np.unique

    def compte(*a, **k):
        appels["n"] += 1
        return vrai(*a, **k)

    np.unique = compte
    try:
        clock._agreger(net, ts, sig)
    finally:
        np.unique = vrai
    assert appels["n"] == 1, f"{appels['n']} tris au lieu dun seul"

    # Serie vide : pas de division par zero, deux tableaux vides.
    v1, v2 = clock._agreger(np.zeros(0), np.zeros(0), np.zeros(0))
    assert len(v1) == 0 and len(v2) == 0

    # Et le balayage n appelle plus les deux fonctions separement.
    import inspect

    src = inspect.getsource(clock)
    assert "_en_risque(net, tso" not in src, \
        "le balayage refait un tri separe pour la serie en risque"
    assert src.count("_agreger(net, tso[m], sgo[m])") == 2


def test_every_bar_has_a_duration_and_the_holdout_is_really_subsampled():
    """« 1H » manquait à `BAR_MS` pendant que `BARS` le contenait.

    `BAR_MS.get(bar, 300_000)` retombait donc sur CINQ MINUTES pour
    l'échelle horaire, et ce n'était pas un défaut d'affichage :

    - l'EMBARGO valait `h × 5 min` au lieu de `h × 60 min`, soit trente
      minutes là où les étiquettes couvrent six heures — de la fuite ;
    - le sous-échantillonnage du holdout, `(ts // pas) % h == 0`,
      devenait TOUJOURS VRAI. Les horodatages horaires sont des multiples
      de 3 600 000 ; divisés par 300 000 ils donnent 12k, et `12k % 6`
      vaut toujours zéro. Le 1H gardait ses six étiquettes chevauchantes
      au lieu d'une sur six.

    Conséquence mesurée : `instants` gonflé d'un facteur six, donc une
    barre déflatée de 0,102 au lieu de 0,251. C'est ce qui faisait croire
    que le 1H était « à 0,007 de la porte » alors qu'il en est à un
    facteur 2,5.
    """
    import math

    import numpy as np

    from hermes.scalp.clock import BAR_MS, BARS

    # 1) Aucune barre ne peut plus tomber dans le défaut silencieux.
    manquants = [b for b in BARS if b not in BAR_MS]
    assert not manquants, f"BAR_MS ne couvre pas {manquants}"

    # 2) Le sous-échantillonnage garde bien une barre sur h, à CHAQUE
    #    échelle. C'est la propriété qui rend les étiquettes disjointes.
    for bar in BARS:
        pas = BAR_MS[bar]
        ts = np.arange(600, dtype=np.int64) * pas
        for h in (1, 3, 6):
            garde = ts[(ts // pas) % h == 0]
            assert len(garde) == 600 // h, \
                f"{bar} h={h} : {len(garde)} gardes au lieu de {600 // h}"

    # 3) Contre-épreuve : avec l'ancien pas par défaut, le filtre horaire
    #    ne gardait RIEN du tout — il laissait tout passer. Sans cette
    #    vérification, le test ci-dessus passerait aussi sur le bug.
    ts_h = np.arange(600, dtype=np.int64) * 3_600_000
    for h in (3, 6):
        garde_faux = ts_h[(ts_h // 300_000) % h == 0]
        assert len(garde_faux) == 600, \
            "le defaut ne se reproduit pas : le test ne prouve rien"

    # 4) Et la barre déflatée que cela produisait.
    from hermes.scalp.clock import expected_max_sharpe
    gonflee = expected_max_sharpe(4860, 1257)
    juste = expected_max_sharpe(4860, 1257 // 6)
    assert gonflee < 0.11 and juste > 0.24, (gonflee, juste)
    assert juste / gonflee > 2.3


def test_the_embargo_is_exactly_tight_and_must_not_be_loosened_or_tightened():
    """J'ai voulu « corriger » cet embargo, et je me trompais.

    Avec `lag = 0`, l'étiquette de l'indice *i* va de l'OUVERTURE de la
    barre i+1 à la CLÔTURE de la barre i+h — arithmétique de `_targets` :
    `base = c.o[1:1+m]`, `fut = px[h:h+m]`. Elle se termine donc à
    `ts[i] + (h+1)·pas`, ce qui donne envie d'exiger
    `ts[i] ≤ t0 − (h+1)·pas`.

    C'est déjà le cas. L'inégalité est STRICTE et les horodatages sont
    sur une grille de pas constant : `ts[i] < t0 − h·pas` admet au plus
    `ts[i] = t0 − (h+1)·pas`, dont l'étiquette se termine à `t0` pile —
    à l'ouverture de la première barre de test, sans jamais la traverser.

    Durcir à `(h+1)` retire une barre d'entraînement de plus sans retirer
    la moindre fuite. Assouplir à `(h−1)` laisse déborder. Ce test ancre
    l'ajustement dans les DEUX sens, pour que personne — moi compris — ne
    le « répare » à nouveau.
    """
    import inspect

    import numpy as np

    from hermes.scalp import clock

    pas, h, t0 = 60_000, 6, 1_000_000_000
    ts = np.arange(t0 - 30 * pas, t0, pas, dtype=np.int64)
    fin = lambda x: x + (h + 1) * pas          # noqa: E731 - fin d etiquette

    juste = ts[ts < t0 - h * pas]
    assert (fin(juste) <= t0).all(), "lembargo actuel laisse deborder"
    assert fin(juste[-1]) == t0, \
        "lembargo actuel nest pas AJUSTE : il laisse une marge inutile"

    trop_serre = ts[ts < t0 - (h + 1) * pas]
    assert len(trop_serre) == len(juste) - 1
    assert fin(trop_serre[-1]) == t0 - pas, \
        "le durcissement retire une barre sans retirer de fuite"

    trop_large = ts[ts < t0 - (h - 1) * pas]
    assert fin(trop_large[-1]) > t0, \
        "lassouplissement ne fait pas fuir : le test ne prouve rien"

    # Et le code porte bien la forme juste.
    src = inspect.getsource(clock)
    assert "ts[idx] < t0 - h * pas" in src
    assert "(h + 1) * pas" not in src.split("def _essai")[1].split("def ")[0], \
        "un durcissement inutile a ete reintroduit dans _essai"


def test_the_daily_rate_survives_its_own_arithmetic_ceiling():
    """`par_jour` était faux de deux facteurs, et il a fallu deux passes.

    Le PANEL : `n_hold` compte les lignes du holdout de tout le panel.
    Vingt actifs partageant une horloge donnent vingt lignes par barre,
    pas vingt barres.

    L'AMINCISSEMENT : le holdout ne garde qu'une barre sur `h` — les
    lignes gardées ne sont pas les barres écoulées.

    La première correction seule donnait 348 déclenchements par jour au
    1m. C'est **impossible** : à six minutes d'écart il n'en tient que
    240 dans une journée. Ce plafond arithmétique a révélé le second
    facteur, et ce test le garde — une formule qui le franchit est fausse
    quoi qu'elle rende par ailleurs.
    """
    from hermes.scalp.clock import BAR_MS

    def par_jour(n_hold, n_per, n_assets, bar, h):
        pas_min = BAR_MS[bar] / 60_000.0
        gardees = float(n_hold) / max(int(n_assets), 1)
        barres = gardees * max(int(h), 1)
        return n_per / max(barres * pas_min / 1440.0, 1e-9)

    # Le plafond : on ne peut pas declencher plus souvent qu il n y a
    # d instants distincts dans une journee.
    for n_hold, n_per, n_assets, bar, h in (
            (178_942, 2156, 20, "1m", 6),
            (122_041, 708, 20, "3m", 3),
            (142_352, 1217, 20, "5m", 3),
            (198_318, 6650, 20, "15m", 3),
            (154_991, 1326, 20, "1H", 6)):
        v = par_jour(n_hold, n_per, n_assets, bar, h)
        plafond = 1440.0 / (BAR_MS[bar] / 60_000.0 * h)
        assert v <= plafond + 1e-9, \
            f"{bar} h={h} : {v:.1f}/jour pour un plafond de {plafond:.1f}"

    # Le cas du 1m, chiffre : 2 156 instants sur 37,3 jours.
    v = par_jour(178_942, 2156, 20, "1m", 6)
    assert 55.0 < v < 60.0, v

    # Et les deux formules fausses le franchissent ou s en ecartent — sans
    # cette contre-epreuve le test passerait aussi sur les bugs.
    ancien = 2156 / (178_942 * 1.0 / 1440.0)          # ni panel ni amincissement
    demi = 2156 / (178_942 / 20 * 1.0 / 1440.0)       # panel seul
    assert ancien < 20.0, ancien
    assert demi > 1440.0 / 6.0, "la correction intermediaire ne franchit plus le plafond"


def test_the_holdout_duration_cross_checks_against_the_stored_history():
    """La seule façon de savoir qu'une formule de durée est juste.

    `DEBUT_TEST = 0,40` : le test couvre 60 % de la période chargée. La
    durée du holdout doit donc valoir 0,6 × l'histoire. Mesuré :

        1m   37,3 j de holdout  ->  62,1 j impliqués  (62 stockés)
        3m   38,1 j             ->  63,6 j            (60 chargés)
        15m  309,9 j            ->  516,5 j           (365 chargés)

    Les deux premiers tombent au dixième près. Le troisième NON, et la
    raison n'est pas établie. Ce test verrouille les deux qui recoupent
    et laisse le troisième visible plutôt que d'ajuster la formule pour
    qu'elle tombe bien — c'est un écart connu, pas un écart caché.
    """
    from hermes.scalp.clock import BAR_MS, DEBUT_TEST

    def histoire_impliquee(n_hold, n_assets, bar, h):
        pas_min = BAR_MS[bar] / 60_000.0
        jours = n_hold / n_assets * h * pas_min / 1440.0
        return jours / (1.0 - DEBUT_TEST)

    assert abs(histoire_impliquee(178_942, 20, "1m", 6) - 62.0) < 1.0
    assert abs(histoire_impliquee(122_041, 20, "3m", 3) - 60.0) < 4.0
    # L ecart connu du 15m, ancre tel quel pour qu il ne se perde pas.
    ecart = histoire_impliquee(198_318, 20, "15m", 3) / 365.0
    assert 1.3 < ecart < 1.5, \
        f"lecart du 15m a change ({ecart:.2f}) : le comprendre avant de toucher"


def test_the_journal_says_how_far_behind_the_incumbent_cell_was():
    """La bande d'hystérésis n'était pas décidable sur les données publiées.

    Le journal publiait la marge de la cellule GAGNANTE et jamais celle
    de la SORTANTE. Or c'est l'écart entre les deux qui dit si la bande
    `1/√n_per` est à la bonne largeur.

    La question est loin d'être théorique. Compté le 27 août : sur douze
    verdicts 1m consécutifs, `gardee` n'apparaît que QUATRE fois — la
    cellule change d'identité deux fois sur trois, vit 1,5 ajustement,
    et le rodage exige trente fermetures, soit une quinzaine de
    changements de règle avant d'avoir de quoi juger. `live_rule` ne
    mesure donc jamais UNE règle, et c'est pourtant lui qui commande
    `confiance`.

    La bande vaut l'erreur type d'un Sharpe AU SEIN d'un ajustement. Ce
    qu'il faudrait lui comparer, c'est la dispersion des marges ENTRE
    ajustements — une autre quantité, qui inclut le bruit de sélection
    du maximum sur 4 860 cellules. Ce test exige que l'écart soit
    journalisé À CÔTÉ de la bande, pour que la comparaison devienne
    possible ; il n'exige aucun changement de la bande.
    """
    import inspect

    from hermes.scalp import clock

    src = inspect.getsource(clock)
    assert "self.ecart_sortant" in src, "lecart au sortant nest pas mesure"
    assert "meilleur[\"marge\"] - sortant[\"marge\"]" in src, \
        "lecart nest pas la difference des marges"
    assert "ecart={d['ecart_sortant']" in src, "lecart natteint pas le journal"
    assert "bande=" in src, \
        "la bande nest pas journalisee a cote : la comparaison reste impossible"

    # La bande reste exactement ce qu elle etait — on mesure, on ne regle pas.
    assert "bruit = 1.0 / math.sqrt(max(sortant[\"n_per\"], 1))" in src, \
        "la bande dhysteresis a ete modifiee sans mesure"


def test_the_journal_says_how_much_of_the_book_went_short():
    """« Il doit trader les mouvements long ET short », et rien ne
    permettait de le vérifier.

    Un relevé du 27 août montrait dix-huit jambes toutes longues. Sans
    autre chiffre, impossible de savoir si c'est un moment ou un biais.

    Ce n'est PAS du bêta déguisé, et il faut le dire pour ne pas
    s'alarmer à tort : la cellule retenue déclenche sur 1 364 instants
    pour environ 53 000 barres de holdout, soit 2,6 % du temps. Elle
    choisit ses moments ; elle n'est pas « toujours longue ». Mais une
    règle qui ne prendrait JAMAIS le sens court ne répondrait qu'à la
    moitié de ce qu'on lui demande, et c'est une chose qui se compte.

    Le verdict porte donc `court=NN%`. Ce test exige la mesure, pas une
    valeur : imposer un équilibre long/court serait poser une contrainte
    sur la recherche sans l'avoir mesurée.
    """
    import inspect

    import numpy as np

    from hermes.scalp import clock

    src = inspect.getsource(clock)
    assert "part_courte = (float(np.mean(sens < 0))" in src, \
        "la part de trades courts nest pas mesuree"
    assert "court={100.0 * d.get('part_courte', 0.0):.0f}%" in src, \
        "la part de trades courts natteint pas le journal"

    # Larithmetique elle-meme, ancree : la part compte les sens negatifs.
    for sens, attendu in ((np.array([1.0, 1.0, 1.0, 1.0]), 0.0),
                          (np.array([-1.0, 1.0, -1.0, 1.0]), 0.5),
                          (np.array([-1.0, -1.0]), 1.0)):
        assert float(np.mean(sens < 0)) == attendu

    # Et AUCUNE contrainte nest imposee : la recherche reste libre de
    # choisir une cellule a 100 % longue si cest elle qui a la marge.
    assert "part_courte >" not in src and "part_courte <" not in src, \
        "une contrainte a ete posee sur lequilibre long/court sans mesure"


def test_the_duration_of_a_bar_has_one_single_source():
    """« 1H » manquait a `BAR_MS` de lhorloge pendant que le magasin le
    connaissait depuis toujours : deux tables ecrites a la main, dont une
    seule etait juste. Le test de couverture attrapait le symptome ; il
    ne pouvait pas empecher la prochaine divergence.

    La table de lhorloge est desormais DERIVEE de celle du magasin,
    restreinte aux echelles cherchees. Un nom de BARS sans duree leve a
    limport — bien plus fort quun `.get(bar, 300_000)` silencieux.
    """
    from hermes.data.store import BAR_MS as MAGASIN
    from hermes.scalp.clock import BAR_MS, BARS

    assert BAR_MS == {b: MAGASIN[b] for b in BARS}, \
        "la table des durees a re-diverge de celle du magasin"
    # Et elle ne porte QUE les echelles cherchees : une duree en trop
    # laisserait croire quune echelle est cherchee alors quelle ne lest
    # pas.
    assert set(BAR_MS) == set(BARS)


def test_a_trigger_that_extends_the_previous_one_is_counted():
    """Le moteur solde au temps a h barres puis rouvre si le signal tient.
    Mesure EN DIRECT, trois lectures du 27-28 aout : 39 % des ouvertures
    (7/18), puis 54 % (51/95), puis 51 % (63/124) reprennent une jambe que
    le time-stop vient de solder, du meme sens, dans la barre. A 07h22 cela
    faisait 4,28 USD dallers-retours sur 6,44 de frais.

    La question est de savoir si la PORTE voit la meme chose. Le holdout
    est aminci a `(ts // pas) % h == 0`, donc deux instants de test
    consecutifs dun meme nom sont exactement h barres lun de lautre —
    EXACTEMENT le motif « solder puis rouvrir ». La comparaison est licite.
    """
    import numpy as np

    from hermes.scalp.clock import _part_prolongee

    pas, h = 60_000.0, 6
    pas_h = pas * h
    # Trois declenchements du meme nom, espaces de h barres, meme sens :
    # deux prolongent le precedent.
    ts = np.array([0.0, pas_h, 2 * pas_h])
    ins = np.array([0, 0, 0])
    sg = np.array([1.0, 1.0, 1.0])
    assert abs(_part_prolongee(ts, ins, sg, pas, h) - 2.0 / 3.0) < 1e-9

    # CONTRE-EPREUVE 1 : le sens OPPOSE nest pas une reprise, cest un
    # retournement — une decision neuve, qui a le droit de couter.
    assert _part_prolongee(ts, ins, np.array([1.0, -1.0, 1.0]), pas, h) == 0.0

    # CONTRE-EPREUVE 2 : deux NOMS differents qui se suivent dans le temps
    # ne sont pas une reprise. Sans letiquette dinstrument, ils passeraient
    # pour telle — cest la raison detre de `insto`.
    assert _part_prolongee(ts, np.array([0, 1, 2]), sg, pas, h) == 0.0

    # CONTRE-EPREUVE 3 : un ecart qui nest PAS exactement h barres nest
    # pas le motif « solder au temps puis rouvrir ».
    assert _part_prolongee(np.array([0.0, pas_h + pas, 2 * pas_h]),
                           ins, sg, pas, h) == 0.0

    # Un seul declenchement ne prolonge rien.
    assert _part_prolongee(np.array([0.0]), np.array([0]),
                           np.array([1.0]), pas, h) == 0.0

    # Et une cellule construite sans ces series — un test en fabrique une a
    # la main — doit rendre zero, PAS lever : une sonde ne peut jamais
    # avoir le pouvoir darreter la porte.
    assert _part_prolongee(None, None, None, pas, h) == 0.0


def test_the_verdict_says_how_often_a_trigger_extends_the_previous():
    """Sans ce chiffre au journal, « le moteur rouvre tout le temps » et
    « la porte a mesure cela » se ressemblent exactement — et cest la
    difference entre un defaut et une regle qui fait ce quon a valide.
    """
    import inspect

    from hermes.scalp import clock as C

    src = inspect.getsource(C)
    assert "suite=" in src, "le verdict ne publie pas la part prolongee"
    assert "part_suite" in src
    # Et elle est calculee POUR LA SEULE CELLULE RETENUE : la porter sur
    # les 4 860 cellules couterait le balayage. Un seul appel dans tout le
    # module, hors la definition elle-meme.
    assert src.count("_part_prolongee(") == 2, \
        "la sonde est appelee ailleurs que sur la cellule retenue"
    # Le modele qui la calcule doit avoir recu les trois series : sans
    # letiquette dinstrument, deux noms qui se suivent passeraient pour
    # une reprise.
    for champ in ('"ts_tr"', '"inst_tr"', '"sens_tr"'):
        assert champ in src, f"{champ} nest pas porte jusqua la cellule"


def _cwin(m):
    """Le meme melange que la porte : c_win decote par le risque de file."""
    from hermes.scalp.economics import QUEUE_MISS
    return (1.0 - QUEUE_MISS) * m.cost_win + QUEUE_MISS * m.fee


def test_a_trailing_cell_is_charged_the_exit_it_can_actually_take():
    """`cost_win` est defini comme « entree postee + take pose au carnet ».
    Une cellule a stop SUIVEUR n a pas de take : `_suiveur` n en simule
    aucun, et le moteur garde tout son bloc SL/TP derriere
    `stop_mode != "suiv"`. Elle sort au suiveur ou au temps, toujours en
    traversant, et le courtier facture alors 2,0 bps a l entree postee
    plus 5,0 a la sortie. Lui facturer le prix d un take pose, c est lui
    facturer une modalite que l execution ne peut pas prendre — et une
    porte trop genereuse laisse passer des cellules qui perdent."""
    m = CandleModel("1m")
    gains = np.array([+50.0, -50.0, +1.0])       # gagnante, perdante, gagnante
    touche = np.array([False, False, False])     # aucune n a touche le suiveur
    cout = m._cout_sortie("suiv", touche, gains, _cwin(m))
    assert np.allclose(cout, m.fee), cout
    # et la jambe touchee paie la meme chose : elle traverse aussi
    cout2 = m._cout_sortie("suiv", np.array([True, True, True]), gains, _cwin(m))
    assert np.allclose(cout2, m.fee), cout2


def test_the_fixed_stop_keeps_the_posted_take_price():
    """Le mode fixe, lui, consulte bien son take : le moteur peut sortir
    maker quand le prix traverse le niveau. Le prix moyen y reste une
    approximation, mais d une sortie qui EXISTE. Durcir les deux modes
    d un seul geste serait aussi faux que de n en durcir aucun."""
    m = CandleModel("1m")
    c_win = _cwin(m)
    gains = np.array([+50.0, -50.0])
    cout = m._cout_sortie("fixe", np.array([False, False]), gains, c_win)
    assert abs(cout[0] - c_win) < 1e-12, cout      # gagnante : take pose
    assert abs(cout[1] - m.fee) < 1e-12, cout      # perdante : traversee
    # un stop touche traverse, dans les deux modes
    cout2 = m._cout_sortie("fixe", np.array([True, True]), gains, c_win)
    assert np.allclose(cout2, m.fee), cout2


def test_the_correction_is_worth_the_measured_two_and_a_quarter_bps():
    """Le chiffre annonce au journal daudit doit etre celui que le code
    applique, sinon la lecture est une histoire. 7,0 = 2,0 maker a
    l entree + 5,0 taker a la sortie, ce que le courtier facture ;
    c_win = 0,75 x 4,0 + 0,25 x 7,0 = 4,75."""
    m = CandleModel("1m")
    c_win = _cwin(m)
    assert abs(c_win - 4.75) < 1e-12, c_win
    gains = np.array([+50.0])
    faux = m._cout_sortie("fixe", np.array([False]), gains, c_win)
    vrai = m._cout_sortie("suiv", np.array([False]), gains, c_win)
    assert abs((vrai - faux)[0] - 2.25) < 1e-12, (vrai, faux)


def test_hardening_the_gate_never_makes_a_cell_look_better():
    """Un durcissement qui, sur un seul chemin, rendrait une cellule plus
    belle ne serait pas un durcissement. Le cout suiveur doit etre
    superieur ou egal a l ancien, chemin par chemin, quel que soit le
    signe du gain."""
    m = CandleModel("1m")
    c_win = _cwin(m)
    rng = np.random.default_rng(7)
    gains = rng.normal(0.0, 40.0, 500)
    touche = rng.random(500) < 0.3
    ancien = np.where(touche, m.fee, np.where(gains > 0, c_win, m.fee))
    nouveau = m._cout_sortie("suiv", touche, gains, c_win)
    assert np.all(nouveau >= ancien - 1e-12), "un chemin est devenu moins cher"
    assert np.any(nouveau > ancien), "le durcissement n a rien change du tout"
