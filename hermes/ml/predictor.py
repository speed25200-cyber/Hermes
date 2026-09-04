"""Walk-forward prediction engine with strict causality and caching.

Protocol
--------
The bar range is cut at refit points every `refit_every` bars. To predict
bars in [r_i, r_{i+1}) the model is trained ONLY on rows [0, r_i - horizon):
the `horizon`-bar gap is an embargo that prevents target leakage (the last
training targets need bars up to r_i - 1 and no further).

Predictions come with two causal uncertainty measures the signal layer uses
for sizing:

  * confidence — rolling agreement between past predictions and realised
    moves (hit rate);
  * conformal width — split-conformal prediction interval: the rolling
    quantile of realised nonconformity |target - prediction|, using only
    residuals whose outcome was already observable (horizon-lagged). A
    position is only taken when the prediction exceeds a multiple of its own
    typical error, and its size scales with that ratio —
    distribution-free uncertainty quantification, not a Gaussian assumption.

Caching
-------
Two layers, both essential for performance:

  * batch cache   — the evolutionary search evaluates hundreds of genomes
    that share few distinct model configs on the same frozen history; each
    config is computed once.
  * incremental   — live trading and bar-by-bar replay extend the history by
    one bar per cycle. Instead of refitting everything, the engine keeps the
    walk-forward state per config and only (a) retrains at refit boundaries,
    (b) predicts the newly appended bars. Results are bit-identical to the
    batch computation.
"""

from __future__ import annotations

import numpy as np

from ..data.store import Candles
from .feature_matrix import build_features, build_target
from .models import GradientBoostedStumps, RidgeRegressor

_BATCH_CACHE: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}
_BATCH_MAX = 96
_FEAT_CACHE: dict[tuple, np.ndarray] = {}
_FEAT_MAX = 16
_INCR_CACHE: dict[tuple, dict] = {}
_INCR_MAX = 64


def clear_cache() -> None:
    _BATCH_CACHE.clear()
    _FEAT_CACHE.clear()
    _INCR_CACHE.clear()


def _features_cached(candles: Candles, leader: Candles | None) -> np.ndarray:
    key = (candles.inst, candles.bar, len(candles),
           int(candles.ts[-1]) if len(candles) else 0,
           leader.inst if leader is not None else None,
           len(leader) if leader is not None else 0)
    X = _FEAT_CACHE.get(key)
    if X is None:
        X = build_features(candles, leader=leader)
        if len(_FEAT_CACHE) >= _FEAT_MAX:
            _FEAT_CACHE.pop(next(iter(_FEAT_CACHE)))
        _FEAT_CACHE[key] = X
    return X


def _model_for(cfg: dict):
    if cfg["model"] == "ridge":
        return RidgeRegressor(l2=cfg.get("l2", 1.0))
    if cfg["model"] == "boost":
        return GradientBoostedStumps(
            n_estimators=cfg.get("n_trees", 30), learning_rate=0.1, seed=17)
    raise ValueError(f"unknown model {cfg['model']!r}")


def _cfg_key(cfg: dict, leader_inst: str | None, min_train: int,
             refit_every: int) -> tuple:
    return (cfg["model"], int(cfg["horizon"]), bool(cfg.get("cross")),
            round(float(cfg.get("l2", 1.0)), 4), int(cfg.get("n_trees", 30)),
            leader_inst, min_train, refit_every)


CONFORMAL_WINDOW = 300
CONFORMAL_Q = 0.8


def _conformal_width(pred: np.ndarray, y: np.ndarray, horizon: int,
                     n_valid_targets: int, t0: int = 0,
                     prev: np.ndarray | None = None) -> np.ndarray:
    """Causal conformal interval width per bar.

    Nonconformity e[s] = |y[s] - pred[s]| becomes observable at bar s+horizon.
    width[t] = trailing-window quantile of the nonconformities observable at
    or before t. Rows before enough residuals exist fall back to the running
    expanding quantile; rows with no residuals get +inf (no trade).
    `t0`/`prev` support incremental extension (fill only [t0, n))."""
    n = len(pred)
    out = np.full(n, np.inf) if prev is None else prev.copy()
    if prev is not None and len(prev) < n:
        out = np.concatenate([prev, np.full(n - len(prev), np.inf)])
    # f[t] = nonconformity that became observable at t
    f = np.full(n, np.nan)
    valid_end = min(n_valid_targets, n - horizon)
    if valid_end > 0:
        e = np.abs(y[:valid_end] - pred[:valid_end])
        active = pred[:valid_end] != 0.0     # only score bars with a live model
        idx = np.arange(valid_end) + horizon
        f[idx[active]] = e[active]
    w, q = CONFORMAL_WINDOW, CONFORMAL_Q
    start = max(t0, horizon)
    if start >= n:
        return out
    # trailing-window quantile, vectorised: sort each window (NaN -> +inf so
    # missing residuals fall to the end), then read numpy's "linear" quantile
    # off the sorted row using the number of valid residuals in that row —
    # bit-identical to np.quantile on the valid values.
    lo0 = max(0, start - w + 1)
    padded = np.concatenate([np.full(max(0, w - 1 - start), np.nan), f[lo0:n]])
    view = np.lib.stride_tricks.sliding_window_view(padded, w)   # row i <-> t = start + i
    chunk = 8192
    for a in range(0, n - start, chunk):
        b = min(a + chunk, n - start)
        blk = view[a:b]
        counts = np.count_nonzero(~np.isnan(blk), axis=1)
        srt = np.sort(np.where(np.isnan(blk), np.inf, blk), axis=1)
        ok = counts >= 30
        if not ok.any():
            continue
        cnt = counts[ok]
        virt = (cnt - 1) * q
        lo_i = np.floor(virt).astype(np.int64)
        hi_i = np.minimum(lo_i + 1, cnt - 1)
        rows = srt[ok]
        r = np.arange(len(rows))
        a_v = rows[r, lo_i]
        b_v = rows[r, hi_i]
        tfrac = virt - lo_i
        # numpy's _lerp: a + (b-a)*t, with the t >= 0.5 branch b - (b-a)*(1-t)
        diff = b_v - a_v
        lerp = a_v + diff * tfrac
        lerp = np.where(tfrac >= 0.5, b_v - diff * (1.0 - tfrac), lerp)
        seg = out[start + a:start + b]
        seg[ok] = lerp
        out[start + a:start + b] = seg
    return out


def _confidence(pred: np.ndarray, close: np.ndarray, horizon: int) -> np.ndarray:
    """Causal rolling hit-rate of sign(pred[t-h]) vs the realised move."""
    n = len(pred)
    conf = np.full(n, 0.5)
    if n <= horizon + 100:
        return conf
    realized = np.zeros(n)
    realized[horizon:] = np.sign(close[horizon:] - close[:-horizon])
    agree = np.zeros(n)
    agree[horizon:] = (np.sign(pred[:-horizon]) == realized[horizon:]) & \
                      (np.sign(pred[:-horizon]) != 0)
    active = np.zeros(n)
    active[horizon:] = np.sign(pred[:-horizon]) != 0
    w = 200
    ca, cn = np.cumsum(agree), np.cumsum(active)
    hits, acts = ca.copy(), cn.copy()
    hits[w:] = ca[w:] - ca[:-w]
    acts[w:] = cn[w:] - cn[:-w]
    with np.errstate(invalid="ignore", divide="ignore"):
        hr = np.where(acts > 20, hits / np.where(acts > 0, acts, 1), 0.5)
    return np.clip(hr, 0.0, 1.0)


def _walk_forward_range(pred: np.ndarray, X: np.ndarray, y: np.ndarray,
                        cfg: dict, state: dict, t0: int, t1: int,
                        min_train: int, refit_every: int) -> None:
    """Fill pred[t0:t1] using walk-forward refits; mutates `state` (holds the
    current model and the refit point it was trained at). Predictions are
    produced one refit block at a time (identical results, no per-bar
    Python loop)."""
    horizon = int(cfg["horizon"])
    t = max(t0, min_train)
    while t < t1:
        boundary = min_train + ((t - min_train) // refit_every) * refit_every
        block_end = min(boundary + refit_every, t1)
        if state.get("trained_at") != boundary:
            train_end = boundary - horizon
            if train_end >= 200:
                w0 = min(200, train_end // 4)
                model = _model_for(cfg)
                model.fit(X[w0:train_end], y[w0:train_end])
                state["model"] = model
            state["trained_at"] = boundary
        model = state.get("model")
        if model is not None:
            pred[t:block_end] = np.clip(model.predict(X[t:block_end]), -5, 5)
        t = block_end


def predict_series(
    candles: Candles,
    cfg: dict,
    leader: Candles | None = None,
    min_train: int = 750,
    refit_every: int = 500,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (pred, conf, width), arrays of length n. pred[t] is the
    vol-scaled expected forward return decided at the close of bar t; conf[t]
    the causal rolling hit rate; width[t] the causal conformal interval width
    (+inf where uncalibrated). cfg keys: model ("ridge"|"boost"), horizon,
    cross, l2 / n_trees."""
    n = len(candles)
    horizon = int(cfg["horizon"])
    use_leader = leader if cfg.get("cross") else None
    leader_inst = use_leader.inst if use_leader is not None else None
    ck = _cfg_key(cfg, leader_inst, min_train, refit_every)
    ts0 = int(candles.ts[0]) if n else 0
    last_ts = int(candles.ts[-1]) if n else 0

    batch_key = (candles.inst, candles.bar, n, last_ts, ck)
    hit = _BATCH_CACHE.get(batch_key)
    if hit is not None:
        return hit

    if n < min_train + horizon + 50:
        return (np.zeros(n), np.full(n, 0.5), np.full(n, np.inf))

    incr_key = (candles.inst, candles.bar, ts0, ck)
    st = _INCR_CACHE.get(incr_key)
    X = _features_cached(candles, use_leader)
    y = build_target(candles, horizon)

    if (st is not None and st["n"] <= n
            and st["last_ts"] == int(candles.ts[st["n"] - 1])):
        # extend the existing walk-forward state over the new bars only
        pred = np.zeros(n)
        pred[: st["n"]] = st["pred"]
        _walk_forward_range(pred, X, y, cfg, st["wf"], st["n"], n,
                            min_train, refit_every)
        width = _conformal_width(pred, y, horizon, n - horizon,
                                 t0=st["n"], prev=st.get("width"))
    else:
        pred = np.zeros(n)
        st = {"wf": {}}
        _walk_forward_range(pred, X, y, cfg, st["wf"], min_train, n,
                            min_train, refit_every)
        width = _conformal_width(pred, y, horizon, n - horizon)

    st.update({"n": n, "last_ts": last_ts, "pred": pred, "width": width})
    if len(_INCR_CACHE) >= _INCR_MAX:
        _INCR_CACHE.pop(next(iter(_INCR_CACHE)))
    _INCR_CACHE[incr_key] = st

    conf = _confidence(pred, candles.c, horizon)
    if len(_BATCH_CACHE) >= _BATCH_MAX:
        _BATCH_CACHE.pop(next(iter(_BATCH_CACHE)))
    result = (pred, conf, width)
    _BATCH_CACHE[batch_key] = result
    return result
