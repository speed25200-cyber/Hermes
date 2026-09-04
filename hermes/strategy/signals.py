"""Turn a Genome into a target-exposure series for a candle history.

`compute_position(candles, genome, ctx)` returns pos[i] = exposure decided at
the close of bar i (fraction of equity, signed). Strictly causal: only data
up to bar i is used for pos[i]. The backtest engine applies the 1-bar
execution lag.

`ctx` (optional dict) provides cross-asset context:
    {"leader": Candles}  — the universe leader (e.g. BTC) whose lagged
    returns feed the ML models' lead-lag features.
"""

from __future__ import annotations

import numpy as np

from .. import features as F
from ..data.store import BARS_PER_YEAR, Candles
from ..ml.predictor import predict_series
from ..ml.regime import regime_series
from .genome import Genome


ML_HORIZONS = (2, 4, 8, 16, 32, 48)

# no-trade band on the final exposure (fraction of equity). Chosen a priori,
# identical for every genome, never searched: it exists purely to keep
# transaction costs from eating continuously re-scaled positions alive.
POSITION_BAND = 0.05


def _ml_position(candles: Candles, g: Genome, ctx: dict | None) -> np.ndarray:
    p = g.params
    leader = (ctx or {}).get("leader")
    # snap horizon to a coarse grid: prediction caches are shared across the
    # evolutionary search, and horizon resolution beyond this is noise anyway
    horizon = min(ML_HORIZONS, key=lambda h: abs(h - int(p["horizon"])))
    cfg: dict = {"horizon": horizon, "cross": bool(int(p["cross"]))}
    if g.signal == "ml_ridge":
        cfg["model"] = "ridge"
        cfg["l2"] = float(10.0 ** int(p["l2_exp"]))
    else:
        cfg["model"] = "boost"
        cfg["n_trees"] = 10 * int(p["n_trees"])
    pred, conf, width = predict_series(candles, cfg, leader=leader)

    # conformal sizing: trade only when the prediction exceeds a multiple of
    # its own typical realised error (distribution-free interval width), and
    # size with the prediction/uncertainty ratio
    with np.errstate(invalid="ignore", divide="ignore"):
        ratio = pred / np.where(np.isfinite(width) & (width > 1e-9), width, np.inf)
    ratio = np.nan_to_num(ratio, nan=0.0, posinf=0.0, neginf=0.0)

    thr = p["thresh"]
    raw = np.where(np.abs(ratio) > thr,
                   np.clip(ratio / (2.0 * max(thr, 1e-6)), -1, 1), 0.0)
    # confidence tilt: scale toward 0 when recent hit rate is poor
    edge = np.clip((conf - 0.45) / 0.15, 0.0, 1.5)
    return raw * edge


def _raw_signal(candles: Candles, g: Genome, ctx: dict | None = None) -> np.ndarray:
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

    if g.signal == "basis_fade":
        lb = int(p["lookback"])
        b = F.ema(candles.basis, lb)
        out = np.where(np.abs(b) > p["threshold"], -np.sign(b), 0.0)
        return np.nan_to_num(out)

    if g.signal == "flow_fade":
        lb = int(p["lookback"])
        imb = F.ema(candles.taker_imb, lb)
        out = np.where(np.abs(imb) > p["threshold"], -np.sign(imb), 0.0)
        return np.nan_to_num(out)

    if g.signal == "crowd_fade":
        lb = int(p["lookback"])
        oi = candles.oi
        n = len(oi)
        dlog = np.zeros(n)
        if n > 1:
            with np.errstate(invalid="ignore", divide="ignore"):
                dlog[1:] = np.diff(oi) / np.where(oi[:-1] > 1e-9, oi[:-1], np.nan)
        ret = F.lookback_return(c, lb)
        crowd = np.nan_to_num(dlog * np.sign(ret))
        out = -np.sign(crowd)
        out[np.abs(crowd) < 1e-6] = 0.0
        return out

    if g.signal in ("ml_ridge", "ml_boost"):
        return _ml_position(candles, g, ctx)

    raise ValueError(f"unknown signal {g.signal!r}")


def _apply_filter(candles: Candles, g: Genome, pos: np.ndarray) -> np.ndarray:
    if g.filter == "none":
        return pos
    if g.filter == "regime":
        mask_bits = int(g.filter_params["mask"])
        reg = regime_series(candles)
        allowed = (mask_bits >> reg) & 1     # bit r of mask == regime r allowed
        return np.where(allowed.astype(bool), pos, 0.0)
    pct = F.vol_percentile(candles.c, w=48, rank_w=480)
    if g.filter == "vol_below":
        mask = pct <= g.filter_params["pct"]
    elif g.filter == "vol_above":
        mask = pct >= g.filter_params["pct"]
    else:
        raise ValueError(f"unknown filter {g.filter!r}")
    return np.where(np.nan_to_num(mask, nan=0.0).astype(bool), pos, 0.0)


def compute_position(candles: Candles, g: Genome, ctx: dict | None = None) -> np.ndarray:
    pos = _raw_signal(candles, g, ctx)
    pos = _apply_filter(candles, g, pos)

    # per-strategy volatility targeting: scale so the position's annualised
    # vol approximates g.vol_target, capped at max leverage
    bpy = BARS_PER_YEAR[candles.bar]
    rv = F.realized_vol(candles.c, w=48, bars_per_year=bpy)
    with np.errstate(invalid="ignore", divide="ignore"):
        scale = g.vol_target / np.where(rv > 1e-4, rv, np.nan)
    scale = np.clip(np.nan_to_num(scale, nan=0.0), 0.0, g.max_lev)
    out = np.clip(pos * scale, -g.max_lev, g.max_lev)
    return F.hysteresis(out, POSITION_BAND)
