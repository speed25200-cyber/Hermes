"""Causal 1m learner: triple-barrier labels + ridge, walk-forward embargo.

No deep RL. A PPO on a week of 1m bars memorizes noise. This module:

  * labels each bar by the *first* of TP / SL / time (Lopez de Prado)
  * trains ridge on OHLCV features only (L2 is live-only → kept as a prior)
  * embargoes `horizon` bars so the target path never leaks into X
  * holds out the last day; if holdout IC ≤ 0 the learner **vetoes** trades
  * picks TP/SL multipliers on train, confirms on holdout

The live prior (book / fade) still proposes a side. The learner may shrink,
veto, or set barriers. It does not get to overfit a neural net.
"""

from __future__ import annotations

import math
import time

import numpy as np

from ..data.store import Candles
from ..ml.models import RidgeRegressor
from . import features as F

KEYS = ("r1", "r3", "r5", "r12", "loc", "vshock", "persist", "vol", "btc_r1", "idio")
TP_GRID = (1.2, 2.0)
SL_GRID = (2.0, 3.2)


def _feat_row(c: Candles, i: int, btc_r1: float, is_btc: bool) -> np.ndarray:
    sl = c.slice(0, i + 1)
    f = F.candle_feats(sl)
    idio = 0.0 if is_btc else float(f.get("r1", 0.0) - btc_r1)
    return np.array([
        f.get("r1", 0.0), f.get("r3", 0.0), f.get("r5", 0.0), f.get("r12", 0.0),
        f.get("loc", 0.0), f.get("vshock", 0.0), f.get("persist", 0.0),
        f.get("vol", 0.0), btc_r1, idio,
    ], dtype=np.float64)


def barrier_pnl(c: Candles, i: int, side: float, tp_bps: float, sl_bps: float,
                horizon: int, fee_rt: float) -> float:
    """Net bps of `side` (+1 long / -1 short) entered at close[i].
    Path is bars i+1 .. i+horizon — bar i is known, not future."""
    n = len(c)
    if i + 1 >= n or c.c[i] <= 0:
        return float("nan")
    entry = float(c.c[i])
    H = min(horizon, n - i - 1)
    if H < 1:
        return float("nan")
    if side >= 0:
        up, dn = entry * (1.0 + tp_bps * 1e-4), entry * (1.0 - sl_bps * 1e-4)
        for k in range(1, H + 1):
            if c.h[i + k] >= up:
                return tp_bps - fee_rt
            if c.l[i + k] <= dn:
                return -sl_bps - fee_rt
        return (float(c.c[i + H]) / entry - 1.0) * 1e4 - fee_rt
    up, dn = entry * (1.0 + sl_bps * 1e-4), entry * (1.0 - tp_bps * 1e-4)
    for k in range(1, H + 1):
        if c.l[i + k] <= dn:
            return tp_bps - fee_rt
        if c.h[i + k] >= up:
            return -sl_bps - fee_rt
    return (entry / float(c.c[i + H]) - 1.0) * 1e4 - fee_rt


def _ic(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 30:
        return 0.0
    a = a - a.mean()
    b = b - b.mean()
    da, db = float(np.dot(a, a)), float(np.dot(b, b))
    if da <= 0 or db <= 0:
        return 0.0
    return float(np.dot(a, b) / math.sqrt(da * db))


class ScalpLearner:
    def __init__(self, fee_rt_bps: float = 10.0, horizon: int = 6, log=None):
        self.fee_rt = float(fee_rt_bps)
        self.horizon = int(horizon)
        self.log = log or (lambda m: None)
        self.ridge = RidgeRegressor(l2=12.0)  # heavy L2 — 10 features, noisy y
        self.alpha = 0.0
        self.ic = 0.0
        self.holdout_mean = 0.0
        self.tp_mult = 1.2
        self.sl_mult = 2.5
        self.fitted = False
        self.fit_at = 0.0
        self.n_train = 0
        self.status = "unfitted"
        self.policy = "flat"  # fade | follow | flat

    def to_dict(self) -> dict:
        return {
            "alpha": self.alpha, "ic": self.ic, "holdout_mean": self.holdout_mean,
            "tp_mult": self.tp_mult, "sl_mult": self.sl_mult, "fitted": self.fitted,
            "n_train": self.n_train, "status": self.status, "policy": self.policy,
        }

    def fit(self, candles: dict[str, Candles], max_names: int = 6) -> dict:
        """Pooled walk-forward fit. Picks fade vs follow vs sit-out on holdout."""
        names = [k for k in ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP")
                 if k in candles and len(candles[k]) > 200]
        extra = [k for k, c in candles.items() if k not in names and len(c) > 200]
        names += extra[: max(0, max_names - len(names))]
        if not names:
            self.status, self.policy = "no-data", "flat"
            return self.to_dict()
        btc = candles.get("BTC-USDT-SWAP")
        if btc is not None and len(btc) > 400:
            self.tp_mult, self.sl_mult = self._grid_barriers(btc)[0]
        arms = []
        for policy, side_of in (
            ("fade", lambda r1: -1.0 if r1 > 0 else 1.0 if r1 < 0 else 0.0),
            ("follow", lambda r1: 1.0 if r1 > 0 else -1.0 if r1 < 0 else 0.0),
        ):
            packed = self._collect(candles, names, btc, side_of)
            if packed is None:
                continue
            X, y = packed
            cut2 = int(0.8 * len(y))
            ridge = RidgeRegressor(l2=12.0)
            ridge.fit(X[:cut2], y[:cut2])
            ic = _ic(ridge.predict(X[cut2:]), y[cut2:])
            mu = float(np.mean(y[cut2:]))
            arms.append((mu, ic, policy, ridge, cut2))
            self.log(f"learner arm {policy}: n={cut2} ic={ic:.3f} holdout={mu:+.2f}bps")
        if not arms:
            self.status, self.policy, self.alpha, self.fitted = "few-samples", "flat", 0.0, False
            return self.to_dict()
        arms.sort(key=lambda t: t[0], reverse=True)
        mu, ic, policy, ridge, n_train = arms[0]
        self.ridge, self.ic, self.holdout_mean, self.n_train = ridge, ic, mu, n_train
        if mu > 0 and ic > 0.02:
            self.policy, self.status = policy, "live"
            self.alpha = float(min(0.5, 0.15 + 1.5 * ic))
            self.fitted = True
        else:
            self.policy, self.status, self.alpha, self.fitted = "flat", "veto", 0.0, True
        self.fit_at = time.time()
        self.log(f"learner {self.status} policy={self.policy} n={self.n_train} "
                 f"ic={self.ic:.3f} holdout={self.holdout_mean:+.2f}bps "
                 f"tp={self.tp_mult:.2f}x sl={self.sl_mult:.2f}x α={self.alpha:.2f}")
        return self.to_dict()

    def _collect(self, candles, names, btc, side_of):
        xs, ys = [], []
        for inst in names:
            c = candles[inst]
            n = len(c)
            is_btc = inst.startswith("BTC-")
            for i in range(80, n - self.horizon - 2, 3):
                btc_r1 = 0.0
                if btc is not None and 0 < i < len(btc) and btc.c[i - 1] > 0:
                    btc_r1 = float(btc.c[i] / btc.c[i - 1] - 1.0)
                f = F.candle_feats(c.slice(0, i + 1))
                vol_bps = max(float(f.get("vol", 0.0)) * 1e4, 4.0)
                r1 = float(f.get("r1", 0.0))
                side = side_of(r1)
                if side == 0.0:
                    continue
                y = barrier_pnl(c, i, side, self.tp_mult * vol_bps,
                                self.sl_mult * vol_bps, self.horizon, self.fee_rt)
                if not math.isfinite(y):
                    continue
                idio = 0.0 if is_btc else r1 - btc_r1
                xs.append([
                    f.get("r1", 0.0), f.get("r3", 0.0), f.get("r5", 0.0), f.get("r12", 0.0),
                    f.get("loc", 0.0), f.get("vshock", 0.0), f.get("persist", 0.0),
                    f.get("vol", 0.0), btc_r1, idio,
                ])
                ys.append(y)
        if len(ys) < 400:
            return None
        return np.asarray(xs, dtype=np.float64), np.asarray(ys, dtype=np.float64)

    def _grid_barriers(self, c: Candles) -> tuple[tuple[float, float], float]:
        best, best_mu = (1.2, 2.5), -1e9
        n = len(c)
        for tm in TP_GRID:
            for sm in SL_GRID:
                if sm < tm:
                    continue
                ys = []
                for i in range(80, n - self.horizon - 2, 12):
                    f = F.candle_feats(c.slice(0, i + 1))
                    vol = max(float(f.get("vol", 0.0)) * 1e4, 4.0)
                    r1 = float(f.get("r1", 0.0))
                    side = -1.0 if r1 > 0 else 1.0 if r1 < 0 else 0.0
                    if side == 0:
                        continue
                    ys.append(barrier_pnl(c, i, side, tm * vol, sm * vol,
                                          self.horizon, self.fee_rt))
                if len(ys) < 80:
                    continue
                arr = np.asarray(ys)
                hold = arr[int(0.8 * len(arr)):]
                mu = float(np.mean(hold))
                if mu > best_mu:
                    best_mu, best = mu, (tm, sm)
        return best, best_mu

    def infer(self, feat: dict, btc_r1: float, is_btc: bool,
              prior_score: float, vol_bps: float) -> dict:
        """Blend prior with ML. Returns ml_bps, score, tp_bps, sl_bps, veto."""
        vol_bps = max(float(vol_bps), 4.0)
        tp = max(8.0, self.tp_mult * vol_bps)
        sl = max(12.0, self.sl_mult * vol_bps)
        veto = False
        ml_bps = 0.0
        score = float(prior_score)
        if self.policy == "follow":
            score = -score  # momentum: flip the fade prior
        if self.policy == "flat" or self.status in ("veto", "unfitted", "no-data", "few-samples"):
            veto = True
        ml_bps = 0.0
        if self.fitted and self.ridge.w is not None and not veto:
            idio = 0.0 if is_btc else float(feat.get("r1", 0.0) - btc_r1)
            x = np.array([[
                feat.get("r1", 0.0), feat.get("r3", 0.0), feat.get("r5", 0.0),
                feat.get("r12", 0.0), feat.get("loc", 0.0), feat.get("vshock", 0.0),
                feat.get("persist", 0.0), feat.get("vol", 0.0), btc_r1, idio,
            ]], dtype=np.float64)
            ml_bps = float(self.ridge.predict(x)[0])
            ml_z = max(-4.0, min(4.0, ml_bps / 8.0))
            score = (1.0 - self.alpha) * score + self.alpha * ml_z
            if self.alpha > 0 and ml_bps < -self.fee_rt:
                veto = True
        return {
            "score": score, "ml_bps": ml_bps, "tp_bps": tp, "sl_bps": sl,
            "veto": veto, "alpha": self.alpha, "ic": self.ic, "status": self.status,
            "policy": self.policy,
        }


BARS = ("1m", "5m", "15m", "1H")
HOLD = {"1m": 6, "5m": 8, "15m": 8, "1H": 6}
DAYS = {"1m": 7, "5m": 14, "15m": 30, "1H": 90}


class HorizonBook:
    """One learner per bar. Only bars with holdout_mean>0 after fees go live."""

    def __init__(self, fee_rt_bps: float, log=None):
        self.log = log or (lambda m: None)
        self.learners = {
            bar: ScalpLearner(fee_rt_bps=fee_rt_bps, horizon=HOLD[bar], log=log)
            for bar in BARS
        }

    def fit_store(self, store, names: list[str]) -> dict:
        out = {}
        for bar, lr in self.learners.items():
            candles: dict = {}
            for inst in names:
                try:
                    c = store.load(inst, bar)
                except Exception:
                    continue
                if len(c) > 80:
                    candles[inst] = c
            self.log(f"learner fit {bar} names={len(candles)}")
            out[bar] = lr.fit(candles)
        self.log(f"horizons live={self.live_bars() or ['none']}")
        return out

    def live_bars(self) -> list[str]:
        return [b for b, l in self.learners.items() if l.status == "live"]

    def to_dict(self) -> dict:
        return {b: l.to_dict() for b, l in self.learners.items()}