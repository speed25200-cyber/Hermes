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
    out = np.full(len(x), np.nan)
    if len(x) >= w:
        v = _rolling_view(x, w)
        out[w - 1:] = v.std(axis=1, ddof=1)
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
    payments), rescaled to a per-payment estimate."""
    paid = ema(funding, w)
    # Scale back up: payments are sparse, so divide by the share of paying
    # bars seen SO FAR. Counting over the whole series instead would leak the
    # future into every past bar and shift those bars as history grew, which
    # is exactly the backtest/live drift the walk-forward protocol exists to
    # prevent. Before the first payment `paid` is 0, so the floor cannot blow
    # the ratio up.
    n = len(funding)
    seen = np.cumsum(funding != 0.0).astype(np.float64)
    density = np.maximum(seen / np.arange(1, n + 1, dtype=np.float64), 1e-9)
    return paid / density
