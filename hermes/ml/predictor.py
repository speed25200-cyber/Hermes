"""Walk-forward prediction engine with strict causality and caching.

Protocol
--------
The bar range is cut at refit points every `refit_every` bars. To predict
bars in [r_i, r_{i+1}) the model is trained ONLY on rows [0, r_i - horizon):
the `horizon`-bar gap is an embargo that prevents target leakage (the last
training targets need bars up to r_i - 1 and no further).

Predictions come with a confidence proxy: the rolling agreement between past
predictions and realised moves (hit rate), computed causally; the signal
layer uses it to size positions.

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
_BATCH_MAX = 256
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
    current model and the refit point it was trained at)."""
    horizon = int(cfg["horizon"])
    for t in range(max(t0, min_train), t1):
        boundary = min_train + ((t - min_train) // refit_every) * refit_every
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
            pred[t] = float(np.clip(model.predict(X[t:t + 1])[0], -5, 5))


def predict_series(
    candles: Candles,
    cfg: dict,
    leader: Candles | None = None,
    min_train: int = 750,
    refit_every: int = 500,
) -> tuple[np.ndarray, np.ndarray]:
    """Returns (pred, conf), arrays of length n. pred[t] is the vol-scaled
    expected forward return decided at the close of bar t; conf[t] the causal
    rolling hit rate. cfg keys: model ("ridge"|"boost"), horizon, cross,
    l2 / n_trees."""
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
        out = (np.zeros(n), np.full(n, 0.5))
        return out

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
    else:
        pred = np.zeros(n)
        st = {"wf": {}}
        _walk_forward_range(pred, X, y, cfg, st["wf"], min_train, n,
                            min_train, refit_every)

    st.update({"n": n, "last_ts": last_ts, "pred": pred})
    if len(_INCR_CACHE) >= _INCR_MAX:
        _INCR_CACHE.pop(next(iter(_INCR_CACHE)))
    _INCR_CACHE[incr_key] = st

    conf = _confidence(pred, candles.c, horizon)
    if len(_BATCH_CACHE) >= _BATCH_MAX:
        _BATCH_CACHE.pop(next(iter(_BATCH_CACHE)))
    result = (pred, conf)
    _BATCH_CACHE[batch_key] = result
    return result
