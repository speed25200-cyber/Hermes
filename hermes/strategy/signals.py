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

    if g.signal in ("ml_ridge", "ml_boost"):
        return _ml_position(candles, g, ctx)

    if g.signal == "basis_rev":
        idx = candles.x.get("idx")
        if idx is None:
            return np.zeros(n)
        with np.errstate(invalid="ignore", divide="ignore"):
            prem = c / np.where(idx > 0, idx, np.nan) - 1.0
        z = F.zscore(prem, int(p["lookback"]))
        sgn = -1.0 if int(p["dir"]) == 0 else 1.0
        return np.nan_to_num(sgn * np.clip(z / p["entry_z"], -1.0, 1.0))

    if g.signal == "oi_mom":
        oi = candles.x.get("oi")
        if oi is None:
            return np.zeros(n)
        lb = int(p["lookback"])
        doi = F.lookback_return(oi, lb)
        scale = F.rolling_std(F.returns(oi), max(lb, 10)) * np.sqrt(lb)
        with np.errstate(invalid="ignore", divide="ignore"):
            z = doi / np.where(scale > 0, scale, np.nan)
        ret = np.nan_to_num(F.lookback_return(c, lb))
        z = np.nan_to_num(z)
        if int(p["mode"]) == 0:
            # rising OI = new positions carrying the move: follow it
            out = np.sign(ret) * (z > p["conf_z"])
        else:
            # collapsing OI = squeeze/unwind against the move: fade it
            out = -np.sign(ret) * (z < -p["conf_z"])
        return out.astype(float)

    if g.signal == "taker_flow":
        b = candles.x.get("tak_buy")
        s = candles.x.get("tak_sell")
        if b is None or s is None:
            return np.zeros(n)
        tot = b + s
        with np.errstate(invalid="ignore", divide="ignore"):
            imb = (b - s) / np.where(tot > 0, tot, np.nan)
        z = F.zscore(imb, int(p["lookback"]))
        sgn = 1.0 if int(p["dir"]) == 0 else -1.0
        return np.nan_to_num(sgn * np.clip(z / p["entry_z"], -1.0, 1.0))

    if g.signal == "lsr_fade":
        lsr = candles.x.get("lsr")
        if lsr is None:
            return np.zeros(n)
        z = F.zscore(lsr, int(p["lookback"]))
        sgn = -1.0 if int(p["dir"]) == 0 else 1.0
        return np.nan_to_num(sgn * np.clip(z / p["entry_z"], -1.0, 1.0))

    if g.signal == "ttp_follow":
        ttp = candles.x.get("ttp")
        if ttp is None:
            return np.zeros(n)
        z = F.zscore(ttp, int(p["lookback"]))
        sgn = 1.0 if int(p["dir"]) == 0 else -1.0
        return np.nan_to_num(sgn * np.clip(z / p["entry_z"], -1.0, 1.0))

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
    return out
