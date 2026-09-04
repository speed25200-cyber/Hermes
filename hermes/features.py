"""Vectorized feature/indicator library.

All functions take numpy arrays and return arrays of the same length with
NaN during the warm-up window. No look-ahead: every value at index i uses
data up to and including index i.
"""

from __future__ import annotations

import numpy as np


def _rolling_view(x: np.ndarray, w: int) -> np.ndarray:
    return np.lib.stride_tricks.sliding_window_view(x, w)


def sma(x: np.ndarray, w: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) >= w:
        out[w - 1:] = np.convolve(x, np.ones(w) / w, mode="valid")
    return out


def ema(x: np.ndarray, w: int) -> np.ndarray:
    alpha = 2.0 / (w + 1.0)
    out = np.empty(len(x))
    if len(x) == 0:
        return out
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = alpha * x[i] + (1 - alpha) * out[i - 1]
    return out


def rolling_std(x: np.ndarray, w: int) -> np.ndarray:
    """Sample std (ddof=1) over trailing windows, O(n) via cumulative sums
    of the globally-centred series (centring keeps the cancellation error
    far below anything a strategy can see)."""
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    out = np.full(n, np.nan)
    if n < w or w < 2:
        return out
    if not np.all(np.isfinite(x)):
        v = _rolling_view(x, w)
        out[w - 1:] = v.std(axis=1, ddof=1)
        return out
    xc = x - x.mean()
    c1 = np.concatenate(([0.0], np.cumsum(xc)))
    c2 = np.concatenate(([0.0], np.cumsum(xc * xc)))
    s1 = c1[w:] - c1[:-w]
    s2 = c2[w:] - c2[:-w]
    var = (s2 - s1 * s1 / w) / (w - 1)
    # round-off can leave a hair of negative / spurious variance on constant
    # windows: anything below 1e-12 of the series' own scale is zero
    scale = float(np.mean(xc * xc)) + 1e-300
    var = np.where(var > 1e-12 * scale, var, 0.0)
    out[w - 1:] = np.sqrt(var)
    return out


def rolling_max(x: np.ndarray, w: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) >= w:
        out[w - 1:] = _rolling_view(x, w).max(axis=1)
    return out


def rolling_min(x: np.ndarray, w: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) >= w:
        out[w - 1:] = _rolling_view(x, w).min(axis=1)
    return out


def returns(close: np.ndarray) -> np.ndarray:
    r = np.zeros(len(close))
    if len(close) > 1:
        r[1:] = close[1:] / close[:-1] - 1.0
    return r


def lookback_return(close: np.ndarray, w: int) -> np.ndarray:
    out = np.full(len(close), np.nan)
    if len(close) > w:
        out[w:] = close[w:] / close[:-w] - 1.0
    return out


def zscore(close: np.ndarray, w: int) -> np.ndarray:
    m = sma(close, w)
    s = rolling_std(close, w)
    with np.errstate(invalid="ignore", divide="ignore"):
        return (close - m) / np.where(s > 0, s, np.nan)


def rsi(close: np.ndarray, w: int) -> np.ndarray:
    delta = np.diff(close, prepend=close[:1])
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    ag, al = ema(gain, w), ema(loss, w)
    with np.errstate(invalid="ignore", divide="ignore"):
        rs = np.where(al > 0, ag / np.where(al > 0, al, 1.0), np.inf)
    out = 100.0 - 100.0 / (1.0 + rs)
    out[: w] = np.nan
    return out


def realized_vol(close: np.ndarray, w: int, bars_per_year: int) -> np.ndarray:
    """Annualised realized volatility of bar returns."""
    r = returns(close)
    return rolling_std(r, w) * np.sqrt(bars_per_year)


def vol_percentile(close: np.ndarray, w: int, rank_w: int) -> np.ndarray:
    """Percentile (0..1) of current realized vol within its own history."""
    rv = rolling_std(returns(close), w)
    out = np.full(len(close), np.nan)
    if len(close) >= w + rank_w:
        views = _rolling_view(rv, rank_w)  # aligned so views[i] ends at i+rank_w-1
        cur = rv[rank_w - 1:]
        with np.errstate(invalid="ignore"):
            out[rank_w - 1:] = np.nanmean(views <= cur[:, None], axis=1)
        out[: w + rank_w - 1] = np.nan
    return out


def ewma_funding(funding: np.ndarray, w: int) -> np.ndarray:
    """EWMA of the funding series (per-bar amounts, mostly zeros between
    payments), rescaled to a per-payment estimate.

    Density is a *causal* trailing EWMA of payment-bar indicators. Using the
    full-sample nonzero fraction would leak future payment frequency into
    every historical feature value (and make live features drift as new
    bars arrive).
    """
    paid = ema(funding, w)
    nz = (np.asarray(funding, dtype=np.float64) != 0.0).astype(np.float64)
    density = np.maximum(ema(nz, w), 1.0 / max(int(w), 1))
    return paid / density


def hysteresis(target: np.ndarray, band: float) -> np.ndarray:
    """No-trade band: hold the current exposure until the target drifts at
    least `band` (equity units) away from it, then jump to the target. Kills
    the per-bar churn of continuously re-scaled positions without touching
    the signal itself; identical in backtest and live because it is applied
    inside the position function. A target of exactly zero always flattens
    (a signal that switched off must not leave dust behind)."""
    t = np.nan_to_num(np.asarray(target, dtype=np.float64), nan=0.0)
    if band <= 0:
        return t.copy()
    vals = t.tolist()
    out = [0.0] * len(vals)
    held = 0.0
    for i, x in enumerate(vals):
        d = x - held
        if d >= band or d <= -band or (x == 0.0 and held != 0.0):
            held = x
        out[i] = held
    return np.asarray(out, dtype=np.float64)
