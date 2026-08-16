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


def _causal_ffill(x: np.ndarray) -> np.ndarray:
    """Carry the last observed value forward. Never looks ahead; positions
    before the first observation stay NaN."""
    seen = np.isfinite(x)
    if not seen.any():
        return np.full(len(x), np.nan)
    idx = np.where(seen, np.arange(len(x)), 0)
    np.maximum.accumulate(idx, out=idx)
    out = x[idx].astype(np.float64)
    out[: int(seen.argmax())] = np.nan
    return out


def _aux(candles: Candles, name: str) -> tuple[np.ndarray, np.ndarray] | tuple[None, None]:
    """Aux series aligned to bars as (carried values, availability mask).

    The store stamps every aux row at the close of the period it describes
    and NaNs it once stale, so both the read and the carry stay causal. The
    mask keeps that staleness visible: values are carried only so rolling
    statistics stay defined, never to resurrect stale data into a feature.
    """
    raw = candles.x.get(name)
    n = len(candles.c)
    if raw is None or len(raw) != n:
        return None, None
    a = np.asarray(raw, dtype=np.float64)
    avail = np.isfinite(a)
    if int(avail.sum()) < 30:
        return None, None
    return _causal_ffill(a), avail


def _z_masked(v: np.ndarray, avail: np.ndarray, w: int = ROLL_NORM,
              min_obs: int = 100) -> np.ndarray:
    """Trailing z-score, neutral (0) wherever the source was unavailable.

    The gap before the first observation is filled with that first value so
    standardisation runs over the whole array on the same window as every
    other feature. Standardising only the observed tail instead would size
    the window from the tail's length, so a past bar's feature would shift as
    history accumulated and live results would drift from the backtest.

    The fill stays causal: it copies a value into bars that are masked to 0
    anyway, and only reaches later bars through a window that already sits at
    or after the observation it copies.

    A series also stays neutral until it has accumulated `min_obs` of its own
    observations: standardising against a window still dominated by the fill
    would emit a large spurious reading exactly when a new source comes
    online. The count is cumulative, so this stays causal and length-stable.
    """
    filled = np.array(v, dtype=np.float64, copy=True)
    first = int(avail.argmax())
    if first > 0:
        filled[:first] = filled[first]
    z = _roll_z(np.nan_to_num(filled, nan=0.0), w)
    warm = np.cumsum(avail) >= min_obs
    return np.where(avail & warm, z, 0.0)


def _diff_z(v: np.ndarray, avail: np.ndarray, lb: int) -> np.ndarray:
    """Trailing z-score of the `lb`-bar change in a carried aux series.

    A change is only defined where BOTH endpoints were observed; requiring
    that keeps the first `lb` bars after coverage begins from differencing
    against an unobserved value, which would otherwise fire a large spurious
    spike exactly when a new series comes online.
    """
    n = len(v)
    d = np.zeros(n)
    ok = np.zeros(n, dtype=bool)
    if lb < n:
        d[lb:] = np.nan_to_num(v[lb:] - v[:-lb], nan=0.0)
        ok[lb:] = avail[lb:] & avail[:-lb]
    return _z_masked(d, ok)


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

    # clock seasonality (crypto has strong intraday/weekly patterns)
    ts_h = (candles.ts // 3_600_000) % 24
    ts_d = (candles.ts // 86_400_000 + 4) % 7
    cols.append(np.sin(2 * np.pi * ts_h / 24))
    cols.append(np.cos(2 * np.pi * ts_h / 24))
    cols.append(np.sin(2 * np.pi * ts_d / 7))
    cols.append(np.cos(2 * np.pi * ts_d / 7))

    # cross-asset lead-lag from the leader instrument
    if leader is not None and leader.inst != candles.inst and len(leader):
        idx = np.searchsorted(leader.ts, candles.ts, side="right") - 1
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

    cols.extend(_microstructure_cols(candles, c, vol, n))

    X = np.column_stack(cols)
    return np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)


N_MICRO_COLS = 11


def _microstructure_cols(candles: Candles, c: np.ndarray, vol: np.ndarray,
                         n: int) -> list[np.ndarray]:
    """Derivatives-microstructure features: open interest, taker flow,
    cumulative volume delta, crowd and top-trader positioning, spot basis
    and self-recorded book imbalance.

    Always returns N_MICRO_COLS columns — an instrument with no aux history
    contributes zeros rather than a narrower matrix, so one model shape
    serves the whole universe and coverage can grow over time.

    Both learners are additive (ridge is linear, the trees are depth-1
    stumps), so the flow-vs-price cross terms are supplied explicitly:
    neither model can form an interaction on its own.
    """
    out: list[np.ndarray] = []
    direction = np.sign(_vol_scaled_ret(c, 8, vol))

    # open interest: crowding level, position building/unwinding, and whether
    # the recent move is backed by new positions or by an unwind
    oi, oi_ok = _aux(candles, "oi")
    if oi is None:
        out.extend([np.zeros(n)] * 3)
    else:
        log_oi = np.log(np.where(oi > 1e-12, oi, np.nan))
        out.append(_z_masked(np.nan_to_num(log_oi, nan=0.0), oi_ok))
        d_oi = _diff_z(np.nan_to_num(log_oi, nan=0.0), oi_ok, 24)
        out.append(d_oi)
        out.append(np.clip(d_oi * direction, -5, 5))

    # taker flow: aggressor imbalance, cumulative delta drift, and whether
    # that flow confirms or contradicts the move
    buy, buy_ok = _aux(candles, "tak_buy")
    sell, sell_ok = _aux(candles, "tak_sell")
    if buy is None or sell is None:
        out.extend([np.zeros(n)] * 3)
    else:
        flow_ok = buy_ok & sell_ok
        tot = buy + sell
        with np.errstate(invalid="ignore", divide="ignore"):
            imb = (buy - sell) / np.where(tot > 0, tot, np.nan)
        out.append(_z_masked(np.nan_to_num(imb, nan=0.0), flow_ok))
        delta = np.where(flow_ok, np.nan_to_num(buy - sell, nan=0.0), 0.0)
        cvd_z = _diff_z(np.cumsum(delta), flow_ok, 24)
        out.append(cvd_z)
        out.append(np.clip(cvd_z * direction, -5, 5))

    # positioning: the crowd (fade) and the top traders (follow)
    for name in ("lsr", "ttp"):
        v, ok = _aux(candles, name)
        out.append(np.zeros(n) if v is None else _z_masked(v, ok))

    # perp premium to the spot index
    idx, idx_ok = _aux(candles, "idx")
    if idx is None:
        out.append(np.zeros(n))
    else:
        with np.errstate(invalid="ignore", divide="ignore"):
            prem = c / np.where(idx > 0, idx, np.nan) - 1.0
        out.append(_z_masked(np.nan_to_num(prem, nan=0.0), idx_ok))

    # self-recorded order-book depth imbalance (near and deep)
    for name in ("ob_near", "ob_deep"):
        v, ok = _aux(candles, name)
        out.append(np.zeros(n) if v is None else _z_masked(v, ok))

    return out


def build_target(candles: Candles, horizon: int) -> np.ndarray:
    """Forward `horizon`-bar return NET OF FUNDING, vol-scaled. target[t] uses
    bars t+1..t+h (only valid for training rows with t + horizon < n).

    These are perpetual futures: a position held across a funding stamp pays
    (or receives) it, and the backtest charges exactly that. Training on the
    price move alone would teach the model to predict something the strategy
    does not earn — it would happily buy a move worth 5bp while paying 15bp
    of funding to hold it. Funding on crypto perps routinely runs tens of
    percent annualised, so over a short horizon it can dominate the entire
    price edge. The label is therefore what a long actually collects.
    """
    c = candles.c
    n = len(c)
    vol = np.nan_to_num(F.rolling_std(F.returns(c), 48), nan=0.0)
    y = np.zeros(n)
    if n > horizon:
        fwd = c[horizon:] / c[:-horizon] - 1.0
        # funding charged on bars t+1..t+h, i.e. what a long pays to hold
        cum = np.concatenate(([0.0], np.cumsum(candles.funding)))
        paid = cum[horizon + 1: n + 1] - cum[1: n - horizon + 1]
        net = fwd - paid
        with np.errstate(invalid="ignore", divide="ignore"):
            scaled = net / np.where(vol[:-horizon] * np.sqrt(horizon) > 1e-6,
                                    vol[:-horizon] * np.sqrt(horizon), np.nan)
        y[: n - horizon] = np.clip(np.nan_to_num(scaled, nan=0.0), -5, 5)
    return y
