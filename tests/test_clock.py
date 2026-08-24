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
