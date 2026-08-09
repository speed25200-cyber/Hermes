"""Predictive models implemented from scratch in numpy.

Two complementary learners:

  * RidgeRegressor       — closed-form L2 linear model; fast, stable, captures
                           the linear component of the signal.
  * GradientBoostedStumps— gradient boosting over depth-1 trees (stumps) with
                           feature subsampling; captures non-linearities and
                           interactions the linear model misses. The split
                           search is vectorised as a single matrix product per
                           boosting round (masks precomputed), so fitting is
                           BLAS-fast.

Both are deliberately small-capacity: with noisy financial targets, low
variance beats high expressiveness. They are always used inside a
walk-forward protocol (see predictor.py) — never fit on data they will be
asked to predict.
"""

from __future__ import annotations

import numpy as np


class RidgeRegressor:
    def __init__(self, l2: float = 1.0):
        self.l2 = float(l2)
        self.w: np.ndarray | None = None
        self.b: float = 0.0

    def fit(self, X: np.ndarray, y: np.ndarray) -> "RidgeRegressor":
        X = np.asarray(X, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        mu = X.mean(axis=0)
        Xc = X - mu
        yb = y.mean()
        yc = y - yb
        d = X.shape[1]
        A = Xc.T @ Xc + self.l2 * len(y) * np.eye(d) / max(d, 1)
        self.w = np.linalg.solve(A, Xc.T @ yc)
        self._mu = mu
        self.b = yb
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self.w is None:
            return np.zeros(len(X))
        return (np.asarray(X, dtype=np.float64) - self._mu) @ self.w + self.b


class GradientBoostedStumps:
    """Gradient boosting with depth-1 regression trees on quantile splits."""

    def __init__(self, n_estimators: int = 40, learning_rate: float = 0.1,
                 n_thresholds: int = 6, feature_frac: float = 0.7,
                 max_train: int = 3000, seed: int = 0):
        self.n_estimators = int(n_estimators)
        self.learning_rate = float(learning_rate)
        self.n_thresholds = int(n_thresholds)
        self.feature_frac = float(feature_frac)
        self.max_train = int(max_train)
        self.seed = seed
        self.stumps: list[tuple[int, float, float, float]] = []  # (feat, thr, left, right)
        self.base: float = 0.0

    def fit(self, X: np.ndarray, y: np.ndarray) -> "GradientBoostedStumps":
        X = np.asarray(X, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        if len(X) > self.max_train:            # trailing window: recent data
            X, y = X[-self.max_train:], y[-self.max_train:]
        rng = np.random.default_rng(self.seed)
        n, d = X.shape
        self.base = float(y.mean())
        resid = y - self.base
        self.stumps = []

        # precompute mask matrix: one column per (feature, threshold) combo
        qs = np.linspace(0.12, 0.88, self.n_thresholds)
        thr_mat = np.quantile(X, qs, axis=0)             # (T, d)
        combos = [(f, float(thr_mat[t, f]))
                  for f in range(d) for t in range(self.n_thresholds)]
        M = np.empty((n, len(combos)), dtype=np.float64)
        for j, (f, thr) in enumerate(combos):
            M[:, j] = X[:, f] <= thr
        counts_l = M.sum(axis=0)
        counts_r = n - counts_l
        valid = (counts_l >= 8) & (counts_r >= 8)
        combo_feat = np.array([f for f, _ in combos])

        k = max(1, int(d * self.feature_frac))
        for _ in range(self.n_estimators):
            feats = rng.choice(d, size=k, replace=False)
            active = valid & np.isin(combo_feat, feats)
            if not active.any():
                break
            s_l = resid @ M                               # (n_combos,)
            s_tot = resid.sum()
            with np.errstate(invalid="ignore", divide="ignore"):
                left = np.where(counts_l > 0, s_l / np.maximum(counts_l, 1), 0.0)
                right = np.where(counts_r > 0, (s_tot - s_l) / np.maximum(counts_r, 1), 0.0)
            gain = counts_l * left**2 + counts_r * right**2
            gain[~active] = -np.inf
            j = int(np.argmax(gain))
            f, thr = combos[j]
            pred = np.where(M[:, j] == 1.0, left[j], right[j])
            resid = resid - self.learning_rate * pred
            self.stumps.append((f, thr, float(left[j]), float(right[j])))
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, dtype=np.float64)
        out = np.full(len(X), self.base)
        for f, thr, left, right in self.stumps:
            out += self.learning_rate * np.where(X[:, f] <= thr, left, right)
        return out
