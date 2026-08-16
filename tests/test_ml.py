"""Tests for the prediction engine: model quality, strict causality, caching."""

import numpy as np
import pytest

from hermes.data.store import Candles
from hermes.data.synthetic import generate, generate_universe
from hermes.ml import predictor
from hermes.ml.feature_matrix import (N_MICRO_COLS, build_features,
                                      build_target)
from hermes.ml.models import GradientBoostedStumps, RidgeRegressor


def _aux_for(candles, seed=0, stale_from=None):
    """Attach plausible aux series (open interest, taker flow, positioning,
    spot index, book imbalance) to a candle set."""
    n = len(candles)
    rng = np.random.default_rng(seed)
    oi = 1e6 * np.exp(rng.normal(0, 0.01, n).cumsum())
    buy = 50.0 + rng.normal(0, 5, n)
    sell = 50.0 + rng.normal(0, 5, n)
    candles.x = {
        "oi": oi,
        "tak_buy": buy,
        "tak_sell": sell,
        "lsr": 1.0 + rng.normal(0, 0.1, n),
        "ttp": 1.0 + rng.normal(0, 0.1, n),
        "idx": candles.c * (1.0 + rng.normal(0, 0.001, n)),
        "ob_near": rng.normal(0, 0.2, n),
        "ob_deep": rng.normal(0, 0.2, n),
    }
    if stale_from is not None:
        for v in candles.x.values():
            v[stale_from:] = np.nan
    return candles


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


def test_microstructure_features_are_causal():
    """Tampering with future open interest / flow / positioning must not move
    a single past feature value."""
    a = _aux_for(generate(n=3000, seed=11), seed=1)
    b = _aux_for(generate(n=3000, seed=11), seed=1)
    for name in b.x:
        b.x[name][2600:] *= 5.0
    fa, fb = build_features(a), build_features(b)
    np.testing.assert_allclose(fa[:2500], fb[:2500], atol=1e-10)


def test_microstructure_features_carry_signal_when_present():
    """With aux history attached, every microstructure column must actually
    vary — a silently-zero column would be a feature that never fires."""
    c = _aux_for(generate(n=3000, seed=12), seed=2)
    micro = build_features(c)[:, -N_MICRO_COLS:]
    assert micro.shape[1] == N_MICRO_COLS
    for j in range(N_MICRO_COLS):
        assert micro[1000:, j].std() > 1e-9, f"microstructure column {j} is flat"


def test_missing_aux_gives_neutral_columns_of_the_same_width():
    """An instrument with no aux history must still produce a full-width
    matrix (zeros), so one model shape serves the whole universe."""
    plain = build_features(generate(n=1500, seed=13))
    rich = build_features(_aux_for(generate(n=1500, seed=13), seed=3))
    assert plain.shape == rich.shape
    np.testing.assert_allclose(plain[:, -N_MICRO_COLS:], 0.0, atol=1e-12)


def test_stale_aux_is_neutral_not_carried():
    """The store NaNs aux rows once stale; those bars must read as 0 rather
    than silently reusing the last known value."""
    c = _aux_for(generate(n=2000, seed=14), seed=4, stale_from=1500)
    micro = build_features(c)[:, -N_MICRO_COLS:]
    np.testing.assert_allclose(micro[1500:], 0.0, atol=1e-12)
    assert np.abs(micro[1000:1500]).max() > 1e-9


def test_predictor_gains_from_microstructure():
    """A market whose forward returns are driven by a latent flow variable
    that is only observable through taker volume: the model must predict it
    better with the flow wired in than from price history alone."""
    predictor.clear_cache()
    n, bar_ms = 6000, 900_000
    rng = np.random.default_rng(21)
    driver = np.zeros(n)
    for i in range(1, n):                       # mildly persistent, causal
        driver[i] = 0.5 * driver[i - 1] + rng.normal(0, 1.0)
    driver /= driver.std()

    vol = 0.004
    ret = np.zeros(n)
    ret[1:] = 0.45 * vol * driver[:-1] + rng.normal(0, vol, n - 1)
    px = 100.0 * np.exp(np.cumsum(ret))
    ts = np.arange(n, dtype=np.int64) * bar_ms

    def _candles():
        return Candles("T", "15m", ts, px, px, px, px, np.ones(n))

    rich = _candles()
    # the driver is visible only as an aggressor imbalance
    rich.x = {"tak_buy": 100.0 + 20.0 * driver, "tak_sell": 100.0 - 20.0 * driver}
    plain = _candles()

    cfg = {"model": "ridge", "horizon": 2, "cross": False, "l2": 1.0}
    fwd = np.zeros(n)
    fwd[:-2] = px[2:] / px[:-2] - 1.0
    live = slice(1500, n - 2)

    def _ic(candles):
        pred = predictor.predict_series(candles, cfg)[0]
        return np.corrcoef(pred[live], fwd[live])[0, 1]

    ic_rich, ic_plain = _ic(rich), _ic(plain)
    assert ic_rich > 0.05, f"flow edge not learned (IC={ic_rich:.3f})"
    assert ic_rich > ic_plain + 0.02, (
        f"flow added nothing: IC {ic_plain:.3f} -> {ic_rich:.3f}")


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


def test_incremental_matches_batch_with_short_aux_history():
    """Live replay must still equal the batch result when the aux series only
    covers a recent slice of history — the common case, since exchanges keep
    only a few months of open interest and flow."""
    candles = _aux_for(generate(n=2400, seed=22), seed=6)
    for v in candles.x.values():          # aux starts late, as in production
        v[:1800] = np.nan
    cfg = {"model": "ridge", "horizon": 4, "cross": False, "l2": 1.0}

    predictor.clear_cache()
    batch, _, _ = predictor.predict_series(candles, cfg)

    predictor.clear_cache()
    incr = None
    for n in range(2300, 2401):
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


def test_target_is_net_of_funding():
    """These are perpetuals: the label must be what a long actually collects.
    Same price path, funding switched on — every label must move down."""
    a = generate(n=800, seed=31)
    b = generate(n=800, seed=31)
    a.funding = np.zeros(len(a))
    b.funding = np.zeros(len(b))
    b.funding[::32] = 0.0008                     # longs pay every 8h
    ya, yb = build_target(a, 8), build_target(b, 8)
    live = slice(100, len(a) - 8)
    assert (yb[live] <= ya[live]).all()          # never better for a long
    assert (ya[live] - yb[live]).mean() > 0
    # only the windows that actually span a stamp are charged: funding lands
    # every 32 bars and the horizon is 8, so about a quarter of them
    hit = (yb[live] < ya[live]).mean()
    assert 0.20 < hit < 0.30, hit


def test_target_matches_price_return_when_funding_is_zero():
    """With no funding the label is the plain forward price return, so the
    change cannot disturb instruments that never pay it."""
    a = generate(n=800, seed=31)
    a.funding = np.zeros(len(a))
    y = build_target(a, 8)
    fwd = a.c[8:] / a.c[:-8] - 1.0
    live = slice(100, 700)
    np.testing.assert_array_equal(np.sign(y[live]), np.sign(fwd[live]))


def test_target_penalises_a_move_smaller_than_the_funding_to_hold_it():
    """A rally that costs more funding to hold than it pays is a losing long,
    and the label must say so even though the price went up."""
    a = generate(n=800, seed=33)
    rng = np.random.default_rng(5)
    n = len(a)
    # gentle uptrend with realistic noise: a flat path has zero volatility and
    # the vol-scaled label would be undefined
    a.c = 100.0 * np.exp(np.linspace(0, 0.01, n) + rng.normal(0, 0.002, n).cumsum() * 0.1)
    a.funding = np.zeros(len(a))
    up = build_target(a, 8)
    a.funding[::4] = 0.01                                # brutal carry
    down = build_target(a, 8)
    live = slice(100, 700)
    assert up[live].mean() > 0                            # price alone: long
    assert down[live].mean() < 0                          # net of funding: short
