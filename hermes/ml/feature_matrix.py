"""Causal feature matrix for the prediction engine.

Every feature at row t uses only information available at the close of bar t.
Features are normalised with trailing rolling statistics (never global stats,
which would leak the future). Cross-asset features come from a designated
leader instrument (e.g. BTC leads alts) aligned by timestamp.
"""

from __future__ import annotations

import numpy as np

from .. import features as F
from ..data.store import BARS_PER_YEAR, Candles

ROLL_NORM = 500  # trailing window for feature standardisation


def _roll_z(x: np.ndarray, w: int = ROLL_NORM) -> np.ndarray:
    """Causal rolling z-score (uses trailing w bars)."""
    n = len(x)
    out = np.zeros(n)
    if n < 30:
        return out
    m = F.sma(x, min(w, max(n // 2, 30)))
    s = F.rolling_std(x, min(w, max(n // 2, 30)))
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (x - m) / np.where(s > 0, s, np.nan)
    return np.clip(np.nan_to_num(z, nan=0.0), -5, 5)


def _vol_scaled_ret(c: np.ndarray, lb: int, vol: np.ndarray) -> np.ndarray:
    r = F.lookback_return(c, lb)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = r / np.where(vol > 1e-6, vol * np.sqrt(lb), np.nan)
    return np.clip(np.nan_to_num(out, nan=0.0), -5, 5)


def build_features(candles: Candles, leader: Candles | None = None) -> np.ndarray:
    """Returns (n, d) matrix. Rows before warm-up are zero-filled (harmless:
    the walk-forward protocol never trains on the first refit window anyway).
    """
    c, h, l, v = candles.c, candles.h, candles.l, candles.v
    n = len(c)
    bar_ret = F.returns(c)
    vol = F.rolling_std(bar_ret, 48)          # per-bar vol
    vol = np.nan_to_num(vol, nan=0.0)

    cols: list[np.ndarray] = []

    # multi-horizon vol-scaled momentum
    for lb in (1, 3, 8, 24, 72, 168):
        cols.append(_vol_scaled_ret(c, lb, vol))

    # volatility structure
    vol_s = F.rolling_std(bar_ret, 24)
    vol_l = F.rolling_std(bar_ret, 168)
    with np.errstate(invalid="ignore", divide="ignore"):
        vr = vol_s / np.where(vol_l > 1e-9, vol_l, np.nan)
    cols.append(np.clip(np.nan_to_num(vr, nan=1.0) - 1.0, -3, 3))
    cols.append(_roll_z(np.nan_to_num(np.log(np.where(vol > 1e-9, vol, np.nan)), nan=0.0)))

    # oscillators / channel position
    cols.append(np.nan_to_num(F.rsi(c, 14), nan=50.0) / 50.0 - 1.0)
    cols.append(np.nan_to_num(F.zscore(c, 48), nan=0.0).clip(-4, 4) / 2.0)
    hh, ll = F.rolling_max(h, 55), F.rolling_min(l, 55)
    with np.errstate(invalid="ignore", divide="ignore"):
        chan = (c - ll) / np.where(hh - ll > 1e-12, hh - ll, np.nan)
    cols.append(np.nan_to_num(chan, nan=0.5) * 2.0 - 1.0)

    # range/candle shape
    with np.errstate(invalid="ignore", divide="ignore"):
        body = (c - candles.o) / np.where(h - l > 1e-12, h - l, np.nan)
    cols.append(np.nan_to_num(body, nan=0.0).clip(-1, 1))

    # volume pressure
    cols.append(_roll_z(np.log1p(v), 168))

    # funding carry
    f_ew = F.ewma_funding(candles.funding, 100)
    cols.append(np.clip(f_ew * 2000.0, -3, 3))
    cols.append(np.clip(candles.funding * 2000.0, -3, 3))

    # perp microstructure: basis, OI change, taker imbalance
    cols.append(_roll_z(candles.basis * 500.0))
    oi = candles.oi
    dlog = np.zeros(n)
    if n > 1:
        with np.errstate(invalid="ignore", divide="ignore"):
            dlog[1:] = np.diff(np.log(np.where(oi > 1e-9, oi, np.nan)))
    cols.append(_roll_z(np.nan_to_num(dlog)))
    cols.append(np.clip(candles.taker_imb, -1, 1))

    # clock seasonality (crypto has strong intraday/weekly patterns)
    ts_h = (candles.ts // 3_600_000) % 24
    ts_d = (candles.ts // 86_400_000 + 4) % 7
    cols.append(np.sin(2 * np.pi * ts_h / 24))
    cols.append(np.cos(2 * np.pi * ts_h / 24))
    cols.append(np.sin(2 * np.pi * ts_d / 7))
    cols.append(np.cos(2 * np.pi * ts_d / 7))

    # cross-asset lead-lag from the leader instrument
    if leader is not None and leader.inst != candles.inst and len(leader):
        idx = np.searchsorted(leader.ts, candles.ts, side="right") - 2
        valid = idx >= 0
        idx = np.clip(idx, 0, len(leader.ts) - 1)
        lc = leader.c
        l_ret = F.returns(lc)
        l_vol = np.nan_to_num(F.rolling_std(l_ret, 48), nan=0.0)
        for lb in (1, 8, 24):
            src = _vol_scaled_ret(lc, lb, l_vol)
            al = src[idx]
            al[~valid] = 0.0
            cols.append(al)
    else:
        for _ in range(3):
            cols.append(np.zeros(n))

    X = np.column_stack(cols)
    return np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)


def build_target(candles: Candles, horizon: int) -> np.ndarray:
    """Forward `horizon`-bar return, vol-scaled. target[t] uses bars t+1..t+h
    (only valid for training rows with t + horizon < n)."""
    c = candles.c
    n = len(c)
    vol = np.nan_to_num(F.rolling_std(F.returns(c), 48), nan=0.0)
    y = np.zeros(n)
    if n > horizon:
        fwd = c[horizon:] / c[:-horizon] - 1.0
        with np.errstate(invalid="ignore", divide="ignore"):
            scaled = fwd / np.where(vol[:-horizon] * np.sqrt(horizon) > 1e-6,
                                    vol[:-horizon] * np.sqrt(horizon), np.nan)
        y[: n - horizon] = np.clip(np.nan_to_num(scaled, nan=0.0), -5, 5)
    return y
