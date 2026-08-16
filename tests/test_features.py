import numpy as np
import pytest

from hermes import features as F


def test_sma():
    x = np.array([1.0, 2, 3, 4, 5])
    out = F.sma(x, 3)
    assert np.isnan(out[1])
    assert out[2] == pytest.approx(2.0)
    assert out[4] == pytest.approx(4.0)


def test_zscore_centered():
    rng = np.random.default_rng(0)
    x = rng.normal(100, 5, 5000)
    z = F.zscore(x, 100)
    assert abs(np.nanmean(z)) < 0.05
    assert 0.8 < np.nanstd(z) < 1.2


def test_rsi_bounds():
    rng = np.random.default_rng(1)
    x = 100 * np.cumprod(1 + rng.normal(0, 0.01, 2000))
    r = F.rsi(x, 14)
    valid = r[~np.isnan(r)]
    assert np.all(valid >= 0) and np.all(valid <= 100)
    up = F.rsi(np.linspace(100, 200, 200), 14)
    assert up[-1] > 90


def test_lookback_return():
    x = np.array([100.0, 110, 121])
    out = F.lookback_return(x, 1)
    assert out[1] == pytest.approx(0.10)
    assert out[2] == pytest.approx(0.10)


def test_ewma_funding_has_no_lookahead():
    """The sparse-payment rescaling must be estimated from bars already seen:
    a future payment cannot move a past value."""
    n = 600
    a = np.zeros(n)
    a[::32] = 0.0001                      # a payment every 8h on 15m bars
    b = a.copy()
    b[400:] = 0.0                         # payments stop later on
    fa, fb = F.ewma_funding(a, 100), F.ewma_funding(b, 100)
    np.testing.assert_allclose(fa[:400], fb[:400], atol=1e-12)


def test_ewma_funding_is_stable_as_history_grows():
    """A past bar's value must not shift when new bars arrive, or the live
    engine would disagree with the backtest that deployed the strategy."""
    n = 600
    x = np.zeros(n)
    x[::32] = 0.0001
    full = F.ewma_funding(x, 100)
    prefix = F.ewma_funding(x[:500], 100)
    np.testing.assert_allclose(full[:500], prefix, atol=1e-12)


def test_no_lookahead_in_rolling():
    """Rolling stats at index i must not change if future values change."""
    rng = np.random.default_rng(2)
    x = rng.normal(100, 5, 500)
    y = x.copy()
    y[400:] += 1000.0
    for fn in (lambda a: F.sma(a, 20), lambda a: F.rolling_std(a, 20),
               lambda a: F.zscore(a, 20), lambda a: F.rsi(a, 14)):
        a, b = fn(x), fn(y)
        np.testing.assert_allclose(a[:399], b[:399], equal_nan=True)
