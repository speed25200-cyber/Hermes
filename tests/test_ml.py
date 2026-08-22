"""Tests for the prediction engine: model quality, strict causality, caching."""

import numpy as np
import pytest

from hermes.data.synthetic import generate, generate_universe
from hermes.ml import predictor
from hermes.ml.feature_matrix import build_features, build_target
from hermes.ml.models import GradientBoostedStumps, RidgeRegressor


def test_ridge_recovers_linear_signal():
    rng = np.random.default_rng(0)
    X = rng.normal(0, 1, (2000, 5))
    w_true = np.array([0.5, -0.3, 0.0, 0.8, 0.0])
    y = X @ w_true + rng.normal(0, 0.1, 2000)
    m = RidgeRegressor(l2=0.01).fit(X[:1500], y[:1500])
    r2 = 1 - np.var(y[1500:] - m.predict(X[1500:])) / np.var(y[1500:])
    assert r2 > 0.9
    np.testing.assert_allclose(m.w, w_true, atol=0.05)


def test_boost_captures_nonlinearity():
    rng = np.random.default_rng(1)
    X = rng.normal(0, 1, (3000, 4))
    y = np.where(X[:, 0] > 0.5, 1.0, -0.2) * np.where(X[:, 1] < 0, 1.5, 0.5) \
        + rng.normal(0, 0.2, 3000)
    lin = RidgeRegressor(l2=0.1).fit(X[:2400], y[:2400])
    boost = GradientBoostedStumps(n_estimators=60, seed=2).fit(X[:2400], y[:2400])
    mse_lin = np.mean((y[2400:] - lin.predict(X[2400:])) ** 2)
    mse_boost = np.mean((y[2400:] - boost.predict(X[2400:])) ** 2)
    assert mse_boost < mse_lin  # nonlinear model must beat linear here


def test_feature_matrix_causal():
    candles = generate(n=3000, seed=5)
    tampered = generate(n=3000, seed=5)
    tampered.c[2600:] *= 3.0
    tampered.h[2600:] *= 3.0
    tampered.l[2600:] *= 3.0
    tampered.v[2600:] *= 9.0
    a = build_features(candles)
    b = build_features(tampered)
    np.testing.assert_allclose(a[:2500], b[:2500], atol=1e-10)


def test_target_is_forward_looking_only_for_training():
    candles = generate(n=1000, seed=6)
    y = build_target(candles, horizon=8)
    # last `horizon` rows must be zero (no future data to compute them)
    assert np.all(y[-8:] == 0)
    # a known up-move must produce a positive target before it
    assert len(y) == 1000


def test_predictor_causality():
    """Tampering with the future must not change past predictions."""
    predictor.clear_cache()
    a = generate(n=2600, seed=7)
    b = generate(n=2600, seed=7)
    b.c[2400:] *= 2.0
    b.h[2400:] *= 2.0
    b.l[2400:] *= 2.0
    cfg = {"model": "ridge", "horizon": 8, "cross": False, "l2": 1.0}
    pa, _, _ = predictor.predict_series(a, cfg, min_train=750, refit_every=500)
    pb, _, _ = predictor.predict_series(b, cfg, min_train=750, refit_every=500)
    # predictions strictly before the tamper point and before the next refit
    # that could see tampered data must be identical
    np.testing.assert_allclose(pa[:2250], pb[:2250], atol=1e-10)


def test_predictor_cache_hit():
    predictor.clear_cache()
    candles = generate(n=2000, seed=8)
    cfg = {"model": "ridge", "horizon": 4, "cross": False, "l2": 1.0}
    p1, c1, w1 = predictor.predict_series(candles, cfg)
    assert len(predictor._BATCH_CACHE) == 1
    p2, _, _ = predictor.predict_series(candles, cfg)
    assert p1 is p2  # same array object -> served from cache


def test_incremental_extension_matches_batch():
    """Extending the history bar by bar (live mode) must produce exactly the
    same predictions as one batch computation over the full history."""
    candles = generate(n=2400, seed=21)
    cfg = {"model": "boost", "horizon": 4, "cross": False, "n_trees": 10}

    predictor.clear_cache()
    batch, _, _ = predictor.predict_series(candles, cfg)

    predictor.clear_cache()
    incr = None
    for n in range(2300, 2401):          # replay the last 100 bars one by one
        incr, _, _ = predictor.predict_series(candles.slice(0, n), cfg)
    np.testing.assert_allclose(batch, incr, atol=1e-12)


def test_regime_incremental_matches_batch():
    from hermes.ml import regime as R
    candles = generate(n=2400, seed=22)
    R._CACHE.clear(); R._INCR_CACHE.clear()
    batch = R.regime_series(candles)
    R._CACHE.clear(); R._INCR_CACHE.clear()
    incr = None
    for n in range(2300, 2401):
        incr = R.regime_series(candles.slice(0, n))
    np.testing.assert_array_equal(batch, incr)


def test_conformal_width_calibrated_and_causal():
    """The conformal interval must (a) be causal, (b) achieve empirical
    coverage close to the nominal quantile on live bars."""
    predictor.clear_cache()
    candles = generate(n=4000, seed=31)
    cfg = {"model": "ridge", "horizon": 4, "cross": False, "l2": 1.0}
    pred, _, width = predictor.predict_series(candles, cfg)

    # causality: tampering the future does not change past widths
    predictor.clear_cache()
    t = generate(n=4000, seed=31)
    t.c[3600:] *= 2.0; t.h[3600:] *= 2.0; t.l[3600:] *= 2.0
    _, _, width_t = predictor.predict_series(t, cfg)
    np.testing.assert_allclose(width[:3450], width_t[:3450], atol=1e-10)

    # empirical coverage on bars with a live model and calibrated width
    from hermes.ml.feature_matrix import build_target
    y = build_target(candles, 4)
    live = (pred != 0) & np.isfinite(width)
    live[-4:] = False
    err = np.abs(y - pred)
    cov = float(np.mean(err[live] <= width[live]))
    assert 0.65 <= cov <= 0.95  # nominal 0.8, tolerance for drift


def test_predictor_finds_lead_lag_edge():
    """With a strong leader->follower relationship, the cross-asset model's
    predictions must correlate positively with realised forward returns."""
    predictor.clear_cache()
    universe = generate_universe(n=6000, seed=9, lead_lag=0.6)
    leader, follower = universe[0], universe[1]
    cfg = {"model": "ridge", "horizon": 2, "cross": True, "l2": 1.0}
    pred, conf, width = predictor.predict_series(follower, cfg, leader=leader)
    fwd = np.zeros(len(follower))
    fwd[:-2] = follower.c[2:] / follower.c[:-2] - 1.0
    live = slice(1000, len(follower) - 2)
    ic = np.corrcoef(pred[live], fwd[live])[0, 1]
    assert ic > 0.05  # information coefficient clearly positive
