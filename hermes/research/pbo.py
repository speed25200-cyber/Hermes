"""Probability of Backtest Overfitting — Combinatorially Symmetric
Cross-Validation (Bailey, Borwein, López de Prado & Zhu, 2017).

Given the return matrix of EVERY configuration a search evaluated
(T bars x N trials), the history is cut into S contiguous blocks. For each
of the C(S, S/2) ways of choosing half the blocks as "in-sample":

  * the best trial by in-sample Sharpe is selected,
  * its Sharpe on the complementary blocks (out-of-sample) is ranked
    among all N trials.

PBO is the fraction of combinations in which the in-sample winner ends up
in the worse half out-of-sample: a search whose winners are noise gives
PBO ~ 0.5 or above, a search finding real structure gives PBO near 0.
The distribution of the winner's OOS Sharpe across combinations (median,
probability of loss) is reported too — it is a far more honest estimate
of what the selection process delivers than a single split.

Everything is computed from per-block first/second moments, so the whole
combinatorial sweep is a handful of matrix products.
"""

from __future__ import annotations

import math
from itertools import combinations

import numpy as np


def _sharpe_from_moments(s1: np.ndarray, s2: np.ndarray, n: float,
                         bars_per_year: int) -> np.ndarray:
    mean = s1 / n
    var = np.maximum(s2 / n - mean * mean, 0.0) * (n / max(n - 1.0, 1.0))
    sd = np.sqrt(var)
    with np.errstate(invalid="ignore", divide="ignore"):
        sr = np.where(sd > 1e-15, mean / sd, 0.0)
    return sr * math.sqrt(bars_per_year)


def cscv(returns: np.ndarray, bars_per_year: int, n_blocks: int = 10
         ) -> dict:
    """returns: (T, N) per-bar returns of N trials. Returns a dict with
    pbo, the winner's OOS Sharpe distribution and the IS->OOS degradation
    regression (slope < 1 = performance does not carry over)."""
    R = np.asarray(returns, dtype=np.float64)
    if R.ndim != 2 or R.shape[0] < 2 * n_blocks or R.shape[1] < 2:
        return {"pbo": 1.0, "n_trials": int(R.shape[1]) if R.ndim == 2 else 0,
                "n_combos": 0, "oos_sharpe_median": 0.0,
                "oos_sharpe_mean": 0.0, "p_oos_loss": 1.0,
                "slope": 0.0, "n_blocks": n_blocks}
    T, N = R.shape
    n_blocks = max(2, n_blocks - (n_blocks % 2))
    edges = np.linspace(0, T, n_blocks + 1).astype(int)
    s1 = np.zeros((n_blocks, N))
    s2 = np.zeros((n_blocks, N))
    cnt = np.zeros(n_blocks)
    for b, (a, z) in enumerate(zip(edges[:-1], edges[1:])):
        blk = R[a:z]
        s1[b] = blk.sum(axis=0)
        s2[b] = (blk * blk).sum(axis=0)
        cnt[b] = z - a

    logits: list[float] = []
    oos_best: list[float] = []
    is_best: list[float] = []
    all_idx = np.arange(n_blocks)
    for train in combinations(all_idx, n_blocks // 2):
        tr = np.array(train)
        te = np.setdiff1d(all_idx, tr)
        sr_is = _sharpe_from_moments(s1[tr].sum(axis=0), s2[tr].sum(axis=0),
                                     cnt[tr].sum(), bars_per_year)
        sr_oos = _sharpe_from_moments(s1[te].sum(axis=0), s2[te].sum(axis=0),
                                      cnt[te].sum(), bars_per_year)
        j = int(np.argmax(sr_is))
        # relative rank of the IS winner among OOS Sharpes (0..1)
        rank = float((sr_oos < sr_oos[j]).sum() + 0.5 * (sr_oos == sr_oos[j]).sum())
        w = (rank + 0.5) / (N + 1.0)
        w = min(max(w, 1e-6), 1 - 1e-6)
        logits.append(math.log(w / (1.0 - w)))
        oos_best.append(float(sr_oos[j]))
        is_best.append(float(sr_is[j]))

    lam = np.asarray(logits)
    oos = np.asarray(oos_best)
    isb = np.asarray(is_best)
    slope = 0.0
    if len(isb) > 2 and isb.std() > 1e-12:
        slope = float(np.cov(isb, oos, ddof=0)[0, 1] / isb.var())
    return {
        "pbo": float(np.mean(lam <= 0.0)),
        "n_trials": int(N),
        "n_combos": int(len(lam)),
        "n_blocks": int(n_blocks),
        "oos_sharpe_median": float(np.median(oos)),
        "oos_sharpe_mean": float(oos.mean()),
        "p_oos_loss": float(np.mean(oos < 0.0)),
        "slope": slope,
    }
