"""Next-bar labels are causal; conformal sits when the interval covers 0."""
import numpy as np
from hermes.data.synthetic import generate
from hermes.scalp.clock import CandleModel, _targets, feat_matrix


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
    assert X.shape[1] == 17
    assert np.isfinite(X[-1]).all()


def test_conformal_model_reports_status():
    c = generate(inst="BTC-USDT-SWAP", bar="15m", n=800, seed=9)
    m = CandleModel("15m", fee_bps=7.0)
    d = m.fit(c)
    assert d["status"] in ("live", "veto", "few-samples")
    x = np.append(feat_matrix(c)[-1], [0.0, 0.0])
    p = m.predict_row(x)
    assert "veto" in p and "r_bps" in p
