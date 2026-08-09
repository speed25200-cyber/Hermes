import numpy as np

from hermes.data.store import Candles
from hermes.data.synthetic import generate
from hermes.ml.regime import _em_gmm, regime_series


def test_em_separates_known_mixture():
    rng = np.random.default_rng(0)
    a = rng.normal([-2, -2], 0.4, (600, 2))
    b = rng.normal([2, 2], 0.4, (600, 2))
    X = np.vstack([a, b])
    means, var, w = _em_gmm(X, k=2, iters=80)
    centers = sorted(means[:, 0])
    assert abs(centers[0] + 2) < 0.3 and abs(centers[1] - 2) < 0.3
    assert 0.3 < w[0] < 0.7


def test_regime_series_shape_and_labels():
    candles = generate(n=4000, seed=11)
    reg = regime_series(candles)
    assert len(reg) == 4000
    assert set(np.unique(reg)).issubset({0, 1, 2})
    # warm-up defaults to "normal"
    assert np.all(reg[:750] == 1)


def test_regime_series_causal():
    a = generate(n=4000, seed=12)
    b = generate(n=4000, seed=12)
    b.c[3500:] *= 4.0
    b.h[3500:] *= 4.0
    b.l[3500:] *= 4.0
    ra = regime_series(a)
    rb = regime_series(b)
    np.testing.assert_array_equal(ra[:3400], rb[:3400])


def test_turbulent_regime_tracks_volatility():
    """Bars classified turbulent should have materially higher realised vol."""
    candles = generate(n=6000, seed=13)
    reg = regime_series(candles)
    r = np.abs(np.diff(candles.c) / candles.c[:-1])
    live = slice(1000, len(r))
    reg_live = reg[1:][live]
    r_live = r[live]
    if (reg_live == 2).sum() > 50 and (reg_live == 0).sum() > 50:
        assert r_live[reg_live == 2].mean() > r_live[reg_live == 0].mean()
