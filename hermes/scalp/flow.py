"""Online order-flow predictor: label the *next 90s mid*, not the next candle.

Closed candles are almost a random walk after 7 bp. The information that
can still pay for a maker-in/taker-out scalp is *current* book + tape +
BTC lead, observed before the move. We dump (x, mid) every poll, assign y
only after `horizon_s`, fit ridge + conformal on that delayed set.

Until enough labels exist, a tiny prior fires only on extreme dislocation
(L2 + BTC lead), never on candle color.
"""

from __future__ import annotations

import json
import math
import os
import time

import numpy as np

from ..ml.models import RidgeRegressor

HORIZON_S = 90.0
KEYS = ("imb1", "imb5", "depth", "micro_bps", "ofi", "flow",
        "spread", "tape", "btc_lead", "lag")


def _ic(a, b) -> float:
    m = np.isfinite(a) & np.isfinite(b)
    a, b = np.asarray(a)[m], np.asarray(b)[m]
    if len(a) < 40:
        return 0.0
    a, b = a - a.mean(), b - b.mean()
    da, db = float(np.dot(a, a)), float(np.dot(b, b))
    if da <= 0 or db <= 0:
        return 0.0
    return float(np.dot(a, b) / math.sqrt(da * db))


class FlowBrain:
    def __init__(self, state_dir: str, fee_bps: float = 7.0, log=None):
        self.path = os.path.join(state_dir, "flow.jsonl")
        self.model_path = os.path.join(state_dir, "flow_model.json")
        self.fee = float(fee_bps)
        self.log = log or (lambda m: None)
        self.pending: list[dict] = []   # unlabeled
        self.X: list[list[float]] = []
        self.y: list[float] = []        # bps
        self.ridge = RidgeRegressor(l2=8.0)
        self.q = 8.0
        self.ic = 0.0
        self.shrink = 0.0
        self.status = "warmup"
        self.n = 0
        self._last = {}                 # inst -> last
        self._btc_px = 0.0
        self._btc_t = 0.0
        self._load()

    def to_dict(self) -> dict:
        return {"status": self.status, "n": self.n, "ic": self.ic,
                "q_bps": self.q, "shrink": self.shrink}

    def vec(self, inst: str, micro: dict, tape: dict, last: float,
            btc_last: float, own_ret_bps: float) -> np.ndarray:
        now = time.time()
        btc_lead = 0.0
        if btc_last > 0 and self._btc_px > 0 and now - self._btc_t < 120:
            btc_lead = (btc_last / self._btc_px - 1.0) * 1e4
        if btc_last > 0:
            self._btc_px, self._btc_t = btc_last, now
        lag = btc_lead - own_ret_bps  # + = BTC already moved, alt hasn't
        if inst.startswith("BTC-"):
            lag = 0.0
        return np.array([
            float(micro.get("imb") or 0.0),
            float(micro.get("book") or 0.0),
            float(micro.get("depth") or 0.0),
            float(micro.get("micro") or 0.0) * 1e4,
            float(micro.get("ofi") or 0.0),
            float(tape.get("flow") or 0.0) if tape else 0.0,
            float(micro.get("spread_bps") or 0.0),
            float((tape or {}).get("vwap_vs") or 0.0) * 1e4,
            btc_lead,
            lag,
        ], dtype=np.float64)

    def push(self, inst: str, x: np.ndarray, mid: float) -> None:
        if mid <= 0:
            return
        self.pending.append({
            "t": time.time(), "inst": inst,
            "x": [float(v) for v in x], "mid": float(mid),
        })
        if len(self.pending) > 4000:
            self.pending = self.pending[-2000:]

    def settle(self, mids: dict[str, float]) -> int:
        now = time.time()
        kept, n = [], 0
        for s in self.pending:
            if now - s["t"] < HORIZON_S:
                kept.append(s)
                continue
            mid1 = float(mids.get(s["inst"]) or 0.0)
            if mid1 <= 0 or s["mid"] <= 0:
                continue
            y = (mid1 / s["mid"] - 1.0) * 1e4
            if abs(y) > 250:  # skip prints / bad ticks
                continue
            self.X.append(s["x"])
            self.y.append(y)
            n += 1
        self.pending = kept
        if len(self.y) > 8000:
            self.X, self.y = self.X[-5000:], self.y[-5000:]
        if n and (len(self.y) % 40 < n or self.status == "warmup" and len(self.y) >= 250):
            self.fit()
            self._save()
        return n

    def fit(self) -> dict:
        if len(self.y) < 250:
            self.status, self.shrink, self.n = "warmup", 0.0, len(self.y)
            return self.to_dict()
        X = np.asarray(self.X, dtype=np.float64)
        y = np.asarray(self.y, dtype=np.float64)
        cut = int(0.75 * len(y))
        self.ridge = RidgeRegressor(l2=8.0)
        self.ridge.fit(X[:cut], y[:cut])
        pred = self.ridge.predict(X[cut:])
        self.ic = _ic(pred, y[cut:])
        self.q = float(np.quantile(np.abs(y[cut:] - pred), 0.80))
        signed = np.sign(pred) * y[cut:] - self.fee
        hold = float(np.mean(signed))
        self.n = len(y)
        if self.ic > 0.04 and hold > 0:
            self.shrink = float(min(0.7, 0.25 + 2.0 * self.ic))
            self.status = "live"
        else:
            self.shrink, self.status = 0.0, "veto"
        self.log(f"flow {self.status} n={self.n} ic={self.ic:.3f} "
                 f"holdout={hold:+.2f}bps q={self.q:.1f}")
        return self.to_dict()

    def infer(self, x: np.ndarray, micro: dict) -> dict:
        """Predicted 90s bps. Model if live, else extreme-dislocation prior."""
        spread = max(float(micro.get("spread_bps") or 0.0), 0.6)
        imb = float(micro.get("imb") or 0.0)
        ofi = float(micro.get("ofi") or 0.0)
        micro_bps = float(micro.get("micro") or 0.0) * 1e4
        lag = float(x[9]) if len(x) > 9 else 0.0
        btc_lead = float(x[8]) if len(x) > 8 else 0.0
        pred = 0.0
        src = "prior"
        if self.status == "live" and self.ridge.w is not None:
            pred = float(self.ridge.predict(x.reshape(1, -1))[0]) * self.shrink
            src = "flow"
            veto = abs(pred) < (0.7 * self.q + self.fee)
        else:
            # prior: fair is microprice; alts follow BTC; only extremes
            pred = 0.6 * micro_bps + 6.0 * imb + 3.0 * ofi + 0.55 * lag
            same = (np.sign(micro_bps) == np.sign(imb) or abs(micro_bps) < 0.2
                    or abs(imb) < 0.15)
            strong_l2 = abs(imb) >= 0.40 and spread <= 3.0 and micro.get("l2")
            strong_lead = abs(lag) >= 10.0 and spread <= 4.0
            veto = not same or not (strong_l2 or strong_lead)
            if abs(pred) < spread + self.fee:
                veto = True
        tp = max(8.0, 1.15 * abs(pred), 1.2 * spread + 4.0)
        sl = max(12.0, 1.6 * abs(pred), tp * 1.2)
        return {
            "r_bps": pred, "ml_bps": pred, "tp_bps": tp, "sl_bps": sl,
            "veto": bool(veto), "score": pred / 8.0, "status": src if not veto else "wait",
            "policy": src, "bar": "90s", "q_bps": self.q, "ic": self.ic,
            "clocks": {"flow": src if not veto else "veto", "n": str(self.n)},
        }

    def _save(self) -> None:
        try:
            with open(self.model_path, "w") as f:
                json.dump({"n": self.n, "ic": self.ic, "q": self.q,
                           "status": self.status, "shrink": self.shrink,
                           "y_tail": self.y[-20:]}, f)
            # persist last 3k labels for restart
            lab = os.path.join(os.path.dirname(self.model_path), "flow_xy.npz")
            np.savez(lab, X=np.asarray(self.X[-4000:], dtype=np.float32),
                     y=np.asarray(self.y[-4000:], dtype=np.float32))
        except OSError:
            pass

    def _load(self) -> None:
        lab = os.path.join(os.path.dirname(self.model_path), "flow_xy.npz")
        try:
            z = np.load(lab)
            self.X = z["X"].astype(np.float64).tolist()
            self.y = z["y"].astype(np.float64).tolist()
            if len(self.y) >= 250:
                self.fit()
        except Exception:
            pass
