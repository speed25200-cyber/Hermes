"""Turn a Genome into a target-exposure series for a candle history.

`compute_position(candles, genome)` returns pos[i] = exposure decided at the
close of bar i (fraction of equity, signed). Strictly causal: only data up to
bar i is used for pos[i]. The backtest engine applies the 1-bar execution lag.
"""

from __future__ import annotations

import numpy as np

from .. import features as F
from ..data.store import BARS_PER_YEAR, Candles
from .genome import Genome


def _raw_signal(candles: Candles, g: Genome) -> np.ndarray:
    c = candles.c
    n = len(c)
    p = g.params

    if g.signal == "tsmom":
        lb = int(p["lookback"])
        ret = F.lookback_return(c, lb)
        scale = F.rolling_std(F.returns(c), max(lb, 10)) * np.sqrt(lb)
        with np.errstate(invalid="ignore", divide="ignore"):
            z = ret / np.where(scale > 0, scale, np.nan)
        out = np.where(np.abs(z) > p["deadband"], np.sign(z), 0.0)
        return np.nan_to_num(out)

    if g.signal == "ma_cross":
        fast = int(p["fast"])
        slow = max(fast + 2, int(round(fast * p["ratio"])))
        mf, ms = F.sma(c, fast), F.sma(c, slow)
        out = np.where(mf > ms, 1.0, -1.0)
        out[np.isnan(mf) | np.isnan(ms)] = 0.0
        return out

    if g.signal == "meanrev":
        z = F.zscore(c, int(p["lookback"]))
        out = -np.clip(z / p["entry_z"], -1.0, 1.0)
        return np.nan_to_num(out)

    if g.signal == "breakout":
        lb = int(p["lookback"])
        hh = F.rolling_max(candles.h, lb)
        ll = F.rolling_min(candles.l, lb)
        prior_hh = np.concatenate(([np.nan], hh[:-1]))
        prior_ll = np.concatenate(([np.nan], ll[:-1]))
        events = np.zeros(n)
        events[c >= prior_hh] = 1.0
        events[c <= prior_ll] = -1.0
        # hold last breakout direction (forward-fill of nonzero events)
        idx = np.where(events != 0, np.arange(n), 0)
        np.maximum.accumulate(idx, out=idx)
        out = events[idx]
        out[: lb + 1] = 0.0
        return out

    if g.signal == "rsi_rev":
        lb = int(p["lookback"])
        low = p["low"]
        high = max(low + 10.0, p["high_gap"])
        r = F.rsi(c, lb)
        out = np.zeros(n)
        out[r <= low] = 1.0
        out[r >= high] = -1.0
        return np.nan_to_num(out)

    if g.signal == "funding_carry":
        lb = int(p["lookback"])
        f = F.ewma_funding(candles.funding, lb)
        out = np.where(np.abs(f) > p["threshold"], -np.sign(f), 0.0)
        return np.nan_to_num(out)

    raise ValueError(f"unknown signal {g.signal!r}")


def _apply_filter(candles: Candles, g: Genome, pos: np.ndarray) -> np.ndarray:
    if g.filter == "none":
        return pos
    pct = F.vol_percentile(candles.c, w=48, rank_w=480)
    if g.filter == "vol_below":
        mask = pct <= g.filter_params["pct"]
    elif g.filter == "vol_above":
        mask = pct >= g.filter_params["pct"]
    else:
        raise ValueError(f"unknown filter {g.filter!r}")
    return np.where(np.nan_to_num(mask, nan=0.0).astype(bool), pos, 0.0)


def compute_position(candles: Candles, g: Genome) -> np.ndarray:
    pos = _raw_signal(candles, g)
    pos = _apply_filter(candles, g, pos)

    # per-strategy volatility targeting: scale so the position's annualised
    # vol approximates g.vol_target, capped at max leverage
    bpy = BARS_PER_YEAR[candles.bar]
    rv = F.realized_vol(candles.c, w=48, bars_per_year=bpy)
    with np.errstate(invalid="ignore", divide="ignore"):
        scale = g.vol_target / np.where(rv > 1e-4, rv, np.nan)
    scale = np.clip(np.nan_to_num(scale, nan=0.0), 0.0, g.max_lev)
    out = np.clip(pos * scale, -g.max_lev, g.max_lev)
    return out
