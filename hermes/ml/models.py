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


# Bornes des entrées standardisées. Au-delà de huit écarts-types, une
# valeur n'apporte plus d'information exploitable — elle apporte du
# levier numérique.
CLIP_STD = 8.0


class MLPRegressor:
    """Small fully-connected net, numpy only, built for noisy finance data.

    Everything that usually makes a net lie on markets is closed off:

      * the validation split is TEMPORAL (the last `val_frac` of the rows,
        never shuffled) and early stopping restores the best-val weights —
        a net that memorises the past stops improving on the future and
        training halts there;
      * inputs are standardised on train statistics only;
      * capacity is tiny (default 32x16 ~ 1k weights) with L2, because at
        10^4 noisy labels variance kills expressiveness;
      * fixed seed, deterministic batches: the same data always yields the
        same model, so a refit is a decision, not a dice roll.
    """

    def __init__(self, hidden: tuple[int, ...] = (32, 16), l2: float = 1e-4,
                 lr: float = 3e-3, epochs: int = 150, batch: int = 1024,
                 patience: int = 12, val_frac: float = 0.15, seed: int = 7):
        self.hidden = tuple(int(h) for h in hidden)
        self.l2 = float(l2)
        self.lr = float(lr)
        self.epochs = int(epochs)
        self.batch = int(batch)
        self.patience = int(patience)
        self.val_frac = float(val_frac)
        self.seed = int(seed)
        self.Ws: list[np.ndarray] | None = None
        self.bs: list[np.ndarray] | None = None
        self._mu = None
        self._sd = None
        self._mort = None
        self._ymu = 0.0
        self._ysd = 1.0

    def _forward(self, X, keep=False):
        acts = [X]
        a = X
        for i, (W, b) in enumerate(zip(self.Ws, self.bs)):
            z = a @ W + b
            a = np.maximum(z, 0.0) if i < len(self.Ws) - 1 else z
            if keep:
                acts.append(a)
        return (a, acts) if keep else a

    def fit(self, X: np.ndarray, y: np.ndarray) -> "MLPRegressor":
        X = np.asarray(X, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        n, d = X.shape
        n_val = max(int(n * self.val_frac), 16)
        if n - n_val < 32:                      # trop petit pour un réseau
            n_val = max(n // 4, 1)
        tr, va = slice(0, n - n_val), slice(n - n_val, n)
        self._mu = X[tr].mean(axis=0)
        # Une colonne CONSTANTE dans le train mais non nulle plus tard —
        # typiquement une série dérivée qui commence en cours d'historique —
        # donne un écart-type nul. Diviser par 1e-9 envoyait alors une
        # entrée à 5e9 dans le réseau, dont les prédictions explosaient de
        # huit ordres de grandeur (constaté en production : des seuils à
        # 240771075 bps). Le plancher est relatif à l'échelle de la
        # colonne, et les entrées standardisées sont bornées : une valeur
        # jamais vue à l'entraînement ne peut plus faire dérailler le
        # réseau, elle est simplement extrême.
        ech = np.abs(X[tr]).mean(axis=0) + 1e-12
        brut = X[tr].std(axis=0)
        # Une colonne strictement CONSTANTE ne porte aucune information et
        # ne fait qu'ajouter des poids que le réseau doit apprendre à
        # ignorer. Elle arrive naturellement — une série croisée vaut zéro
        # partout quand l'actif de référence est absent, ou pour l'actif de
        # référence lui-même. Mesuré sur le marché à interaction plantée :
        # sept colonnes nulles de plus faisaient passer la famille retenue
        # de 5 succès sur 6 à 4. On les neutralise donc explicitement au
        # lieu de les laisser consommer de la capacité : centrées, elles
        # valent zéro pour toujours, et le plancher relatif ci-dessus ne
        # peut plus les transformer en entrée extrême.
        self._mort = brut <= 0.0
        self._sd = np.maximum(brut, 1e-6 * ech) + 1e-12
        self._ymu = float(y[tr].mean())
        self._ysd = float(y[tr].std() + 1e-12)
        Xs = np.clip((X - self._mu) / self._sd, -CLIP_STD, CLIP_STD)
        Xs[:, self._mort] = 0.0
        ys = (y - self._ymu) / self._ysd
        rng = np.random.default_rng(self.seed)
        sizes = [d, *self.hidden, 1]
        self.Ws = [rng.normal(0, math_sqrt(2.0 / sizes[i]),
                              (sizes[i], sizes[i + 1]))
                   for i in range(len(sizes) - 1)]
        self.bs = [np.zeros(sizes[i + 1]) for i in range(len(sizes) - 1)]
        mW = [np.zeros_like(W) for W in self.Ws]
        vW = [np.zeros_like(W) for W in self.Ws]
        mb = [np.zeros_like(b) for b in self.bs]
        vb = [np.zeros_like(b) for b in self.bs]
        b1, b2, eps = 0.9, 0.999, 1e-8
        t = 0
        best = float("inf")
        best_W, best_b = None, None
        since = 0
        n_tr = n - n_val
        order = np.arange(n_tr)
        for epoch in range(self.epochs):
            rng.shuffle(order)
            for s in range(0, n_tr, self.batch):
                idx = order[s:s + self.batch]
                xb, yb = Xs[idx], ys[idx]
                out, acts = self._forward(xb, keep=True)
                g = 2.0 * (out[:, 0] - yb)[:, None] / len(idx)
                t += 1
                for i in reversed(range(len(self.Ws))):
                    a_prev = acts[i]
                    gW = a_prev.T @ g + self.l2 * self.Ws[i]
                    gb = g.sum(axis=0)
                    if i > 0:
                        g = (g @ self.Ws[i].T) * (acts[i] > 0)
                    mW[i] = b1 * mW[i] + (1 - b1) * gW
                    vW[i] = b2 * vW[i] + (1 - b2) * gW * gW
                    mb[i] = b1 * mb[i] + (1 - b1) * gb
                    vb[i] = b2 * vb[i] + (1 - b2) * gb * gb
                    cW = mW[i] / (1 - b1 ** t) / (np.sqrt(vW[i] / (1 - b2 ** t)) + eps)
                    cb = mb[i] / (1 - b1 ** t) / (np.sqrt(vb[i] / (1 - b2 ** t)) + eps)
                    self.Ws[i] -= self.lr * cW
                    self.bs[i] -= self.lr * cb
            val = float(np.mean((self._forward(Xs[va])[:, 0] - ys[va]) ** 2))
            if val < best - 1e-6:
                best, since = val, 0
                best_W = [W.copy() for W in self.Ws]
                best_b = [b.copy() for b in self.bs]
            else:
                since += 1
                if since >= self.patience:
                    break
        if best_W is not None:
            self.Ws, self.bs = best_W, best_b
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self.Ws is None:
            return np.zeros(len(X))
        Xs = np.clip((np.asarray(X, dtype=np.float64) - self._mu) / self._sd,
                     -CLIP_STD, CLIP_STD)
        if getattr(self, "_mort", None) is not None:
            Xs[..., self._mort] = 0.0
        return self._forward(Xs)[:, 0] * self._ysd + self._ymu


def math_sqrt(x: float) -> float:
    return float(np.sqrt(x))
