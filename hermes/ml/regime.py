"""Market regime detection via Gaussian mixture EM, applied causally.

Each bar is described by (vol-scaled return, log volatility ratio). A K-state
Gaussian mixture is fit by EM on a trailing window at periodic refit points;
bars are then classified with the most recent model only — the regime label
at bar t never uses information beyond t.

States are relabelled by ascending volatility so they are stable across
refits: 0 = quiet, 1 = normal, 2 = turbulent.
"""

from __future__ import annotations

import numpy as np

from .. import features as F
from ..data.store import Candles

_CACHE: dict[tuple, np.ndarray] = {}
_CACHE_MAX = 64
_INCR_CACHE: dict[tuple, dict] = {}
_INCR_MAX = 32

REGIME_NAMES = ("quiet", "normal", "turbulent")


def _em_gmm(X: np.ndarray, k: int = 3, iters: int = 60, seed: int = 3
            ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Diagonal-covariance Gaussian mixture. Returns (means, vars, weights)."""
    rng = np.random.default_rng(seed)
    n, d = X.shape
    # init: split by vol quantiles (second feature) for stable convergence
    order = np.argsort(X[:, -1])
    means = np.array([X[order[int((i + 0.5) * n / k)]] for i in range(k)], dtype=float)
    means += rng.normal(0, 1e-3, means.shape)
    var = np.full((k, d), X.var(axis=0) + 1e-6)
    w = np.full(k, 1.0 / k)
    for _ in range(iters):
        # E-step (log-space for stability)
        log_p = np.zeros((n, k))
        for j in range(k):
            log_p[:, j] = (
                np.log(w[j] + 1e-12)
                - 0.5 * np.sum(np.log(2 * np.pi * var[j]))
                - 0.5 * np.sum((X - means[j]) ** 2 / var[j], axis=1)
            )
        m = log_p.max(axis=1, keepdims=True)
        p = np.exp(log_p - m)
        p /= p.sum(axis=1, keepdims=True)
        # M-step
        nk = p.sum(axis=0) + 1e-9
        new_means = (p.T @ X) / nk[:, None]
        if np.max(np.abs(new_means - means)) < 1e-7:
            means = new_means
            break
        means = new_means
        for j in range(k):
            diff = X - means[j]
            var[j] = (p[:, j] @ (diff**2)) / nk[j] + 1e-8
        w = nk / n
    return means, var, w


def _classify(X: np.ndarray, means: np.ndarray, var: np.ndarray,
              w: np.ndarray) -> np.ndarray:
    n, k = len(X), len(means)
    log_p = np.zeros((n, k))
    for j in range(k):
        log_p[:, j] = (
            np.log(w[j] + 1e-12)
            - 0.5 * np.sum(np.log(2 * np.pi * var[j]))
            - 0.5 * np.sum((X - means[j]) ** 2 / var[j], axis=1)
        )
    return np.argmax(log_p, axis=1)


def _regime_features(candles: Candles) -> np.ndarray:
    r = F.returns(candles.c)
    vol = np.nan_to_num(F.rolling_std(r, 48), nan=0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        rs = r / np.where(vol > 1e-9, vol, np.nan)
    rs = np.clip(np.nan_to_num(rs, nan=0.0), -6, 6)
    vol_l = np.nan_to_num(F.rolling_std(r, 336), nan=0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        lv = np.log(np.where(vol > 1e-9, vol, np.nan) /
                    np.where(vol_l > 1e-9, vol_l, np.nan))
    lv = np.clip(np.nan_to_num(lv, nan=0.0), -3, 3)
    # smooth the return feature a little (regimes are persistent)
    rs_s = F.ema(np.abs(rs), 24)
    return np.column_stack([rs_s, lv])


def _fill_range(out: np.ndarray, feats: np.ndarray, state: dict, t0: int,
                t1: int, k: int, refit_every: int, train_window: int,
                min_train: int) -> None:
    """Label out[t0:t1] causally; `state` carries the current EM model."""
    for t in range(max(t0, min_train), t1):
        boundary = min_train + ((t - min_train) // refit_every) * refit_every
        if state.get("trained_at") != boundary:
            a = max(0, boundary - train_window)
            Xtr = feats[a + 50:boundary]  # skip warm-up rows of the window
            if len(Xtr) >= 300:
                means, var, w = _em_gmm(Xtr, k=k)
                order = np.argsort(means[:, 1])   # relabel by ascending vol
                remap = np.empty(k, dtype=np.int64)
                remap[order] = np.arange(k)
                state["model"] = (means, var, w, remap)
            state["trained_at"] = boundary
        model = state.get("model")
        if model is not None:
            means, var, w, remap = model
            out[t] = remap[_classify(feats[t:t + 1], means, var, w)[0]]


def regime_series(candles: Candles, k: int = 3, refit_every: int = 500,
                  train_window: int = 3000, min_train: int = 750) -> np.ndarray:
    """Causal regime label per bar (int in [0, k)), 1 (=normal) during warm-up."""
    n = len(candles)
    last_ts = int(candles.ts[-1]) if n else 0
    ts0 = int(candles.ts[0]) if n else 0
    key = (candles.inst, candles.bar, n, last_ts, k, refit_every,
           train_window, min_train)
    hit = _CACHE.get(key)
    if hit is not None:
        return hit

    out = np.ones(n, dtype=np.int64)  # default: "normal"
    if n >= min_train + 100:
        feats = _regime_features(candles)
        incr_key = (candles.inst, candles.bar, ts0, k, refit_every,
                    train_window, min_train)
        st = _INCR_CACHE.get(incr_key)
        if (st is not None and st["n"] <= n
                and st["last_ts"] == int(candles.ts[st["n"] - 1])):
            out[: st["n"]] = st["out"]
            _fill_range(out, feats, st["em"], st["n"], n, k, refit_every,
                        train_window, min_train)
        else:
            st = {"em": {}}
            _fill_range(out, feats, st["em"], min_train, n, k, refit_every,
                        train_window, min_train)
        st.update({"n": n, "last_ts": last_ts, "out": out})
        if len(_INCR_CACHE) >= _INCR_MAX:
            _INCR_CACHE.pop(next(iter(_INCR_CACHE)))
        _INCR_CACHE[incr_key] = st

    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = out
    return out
