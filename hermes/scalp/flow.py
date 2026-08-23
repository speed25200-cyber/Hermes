"""Online order-flow predictor over several horizons at once.

Closed candles are almost a random walk after 7 bp. The information that
can still pay for a maker-in scalp is *current* book + tape + BTC lead,
observed before the move. We dump (x, mid) every poll, assign y only after
each horizon elapses, fit ridge + conformal per horizon on that delayed set.

Why several horizons: the cost of a trade is flat while the move a forecast
captures grows with sqrt(h). The measured live gate said it plainly — at
ic=0.27 a 90 s window captures ~3 bps against ~5 of cost, hopeless by
arithmetic; the same skill over 15 minutes captures ~8. One clock cannot
answer for the other, so each horizon gets its own labels, its own model
and its own gate, and inference speaks with the best *validated* head.

Three rules keep this honest, learned the hard way (the version without
them day-halted at -8.33%):

  * one label per instrument per horizon — sampling every poll against a
    90 s horizon made each label overlap ~9 neighbours, which shrank every
    standard error by ~3x and let an ic>0.04 gate pass pure noise;
  * the gate is deflated: the model refits every few dozen labels, and
    each refit is a fresh draw at the gate — and with three horizons
    searched in parallel, every head's bar is charged for all three;
  * the warm-up prior never trades. It reports a score for the screen,
    and that is all a hand rule that has never faced a holdout deserves.
"""

from __future__ import annotations

import json
import math
import os
import time

import numpy as np

from ..backtest.metrics import expected_max_sharpe
from ..ml.models import RidgeRegressor

HORIZON_S = 90.0                       # shortest head; kept for callers
HORIZONS_S = (90.0, 300.0, 900.0)      # 90 s, 5 min, 15 min
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


class _Head:
    """One horizon: its labels, its model, its gate. Nothing shared."""

    def __init__(self, horizon_s: float, fee_bps: float):
        self.h = float(horizon_s)
        self.fee = float(fee_bps)
        self.X: list[list[float]] = []
        self.y: list[float] = []        # bps
        self.T: list[float] = []        # label time (for the purged split)
        self.fits = 0                   # refits so far -> selection trials
        self.sel_bar = 0.0
        self.hold_sr = 0.0
        self._acc: dict[str, float] = {}  # inst -> time of last ACCEPTED label
        self.ridge = RidgeRegressor(l2=8.0)
        self.q = 8.0
        self.ic = 0.0
        self.shrink = 0.0
        self.status = "warmup"
        self.n = 0

    @property
    def nom(self) -> str:
        return f"{int(self.h)}s" if self.h < 600 else f"{int(self.h // 60)}m"

    def label(self, s: dict, mid_now: float, now: float) -> bool:
        """Try to label sample `s` for this horizon. True if consumed."""
        if now - s["t"] < self.h:
            return False
        if mid_now <= 0 or s["mid"] <= 0:
            return True                 # unlabelable, but done for this head
        # one label per instrument per horizon: overlapping labels are the
        # same observation counted several times
        if s["t"] - self._acc.get(s["inst"], -1e18) < self.h:
            return True
        y = (mid_now / s["mid"] - 1.0) * 1e4
        if abs(y) > 250 * math.sqrt(self.h / 90.0):  # bad print, scaled
            return True
        self._acc[s["inst"]] = s["t"]
        self.X.append(s["x"])
        self.y.append(y)
        self.T.append(s["t"])
        return True

    def trim(self) -> None:
        if len(self.y) > 8000:
            self.X, self.y = self.X[-5000:], self.y[-5000:]
            self.T = self.T[-5000:]

    def fit(self, log) -> None:
        if len(self.y) < 250:
            self.status, self.shrink, self.n = "warmup", 0.0, len(self.y)
            return
        X = np.asarray(self.X, dtype=np.float64)
        y = np.asarray(self.y, dtype=np.float64)
        T = np.asarray(self.T[:len(y)] if len(self.T) >= len(y)
                       else list(self.T) + [0.0] * (len(y) - len(self.T)),
                       dtype=np.float64)
        cut = int(0.75 * len(y))
        t_cut = T[cut] if cut < len(T) else 0.0
        # purge: a train label whose window may cross the boundary is dropped
        train = np.arange(cut)[T[:cut] < t_cut - self.h] if t_cut > 0 \
            else np.arange(cut)
        hold = np.arange(cut, len(y))
        if len(train) < 150 or len(hold) < 60:
            self.status, self.shrink = "warmup", 0.0
            self.n = len(y)
            return
        self.ridge = RidgeRegressor(l2=8.0)
        self.ridge.fit(X[train], y[train])
        pred = self.ridge.predict(X[hold])
        self.ic = _ic(pred, y[hold])
        self.q = float(np.quantile(np.abs(y[hold] - pred), 0.80))
        signed = np.sign(pred) * y[hold] - self.fee
        mu = float(np.mean(signed))
        sd = float(np.std(signed, ddof=1))
        self.hold_sr = mu / sd if sd > 1e-12 else 0.0
        self.n = len(y)
        # Every refit is one more draw at this gate, and the three horizons
        # are three parallel searches: each head's bar is charged for all of
        # them. Capped so a long-running desk is not punished forever for
        # its own uptime.
        self.fits += 1
        trials = min(max(self.fits, 2), 64) * len(HORIZONS_S)
        self.sel_bar = expected_max_sharpe(trials, len(hold))
        if mu > 0 and self.hold_sr > self.sel_bar:
            floor = 2.0 / math.sqrt(len(hold))
            self.shrink = float(min(0.7, 0.25 + 2.0 * self.ic)) \
                if self.ic > floor else 0.25
            self.status = "live"
        else:
            self.shrink, self.status = 0.0, "veto"
        log(f"flow {self.nom} {self.status} n={self.n} hold={len(hold)} "
            f"ic={self.ic:.3f} mean={mu:+.2f}bps sr={self.hold_sr:+.3f} "
            f"vs bar={self.sel_bar:.3f} (fit #{self.fits}) q={self.q:.1f}")

    def to_dict(self) -> dict:
        return {"status": self.status, "n": self.n, "ic": self.ic,
                "q_bps": self.q, "shrink": self.shrink,
                "fits": self.fits, "sel_bar": self.sel_bar,
                "hold_sr": self.hold_sr}


class FlowBrain:
    def __init__(self, state_dir: str, fee_bps: float = 7.0, log=None):
        self.path = os.path.join(state_dir, "flow.jsonl")
        self.model_path = os.path.join(state_dir, "flow_model.json")
        self.fee = float(fee_bps)
        self.log = log or (lambda m: None)
        self.pending: list[dict] = []   # unlabeled, shared by every head
        self.heads: dict[float, _Head] = {
            h: _Head(h, self.fee) for h in HORIZONS_S}
        self._last = {}                 # inst -> last
        self._btc_px = 0.0
        self._btc_t = 0.0
        self._load()

    # --- aggregate view: the best validated head speaks for the brain --- #
    def _best(self) -> _Head:
        vivants = [h for h in self.heads.values() if h.status == "live"]
        if vivants:
            return max(vivants, key=lambda h: h.hold_sr - h.sel_bar)
        return self.heads[HORIZONS_S[0]]

    @property
    def status(self) -> str:
        return self._best().status

    @property
    def n(self) -> int:
        return max(h.n for h in self.heads.values())

    @property
    def ic(self) -> float:
        return self._best().ic

    @property
    def q(self) -> float:
        return self._best().q

    @property
    def shrink(self) -> float:
        return self._best().shrink

    def to_dict(self) -> dict:
        b = self._best()
        d = b.to_dict()
        d["horizon_s"] = b.h
        d["heads"] = {h.nom: h.to_dict() for h in self.heads.values()}
        return d

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
            "done": set(),
        })
        if len(self.pending) > 12000:
            self.pending = self.pending[-8000:]

    def settle(self, mids: dict[str, float]) -> int:
        now = time.time()
        max_h = max(HORIZONS_S)
        kept, n_new = [], {h: 0 for h in HORIZONS_S}
        for s in self.pending:
            s.setdefault("done", set())
            mid1 = float(mids.get(s["inst"]) or 0.0)
            for h, head in self.heads.items():
                if h in s["done"]:
                    continue
                before = len(head.y)
                if head.label(s, mid1, now):
                    s["done"].add(h)
                    n_new[h] += len(head.y) - before
            if len(s["done"]) < len(HORIZONS_S) and now - s["t"] < max_h + 120:
                kept.append(s)
        self.pending = kept
        total = 0
        refit = False
        for h, head in self.heads.items():
            head.trim()
            n = n_new[h]
            total += n
            if n and (len(head.y) % 40 < n
                      or (head.status == "warmup" and len(head.y) >= 250)):
                head.fit(self.log)
                refit = True
        if refit:
            self._save()
        return total

    def fit(self) -> dict:
        for head in self.heads.values():
            head.fit(self.log)
        return self.to_dict()

    def infer(self, x: np.ndarray, micro: dict) -> dict:
        """Predicted move in bps at the best validated horizon.

        Model if any head is live, else the extreme-dislocation prior —
        which reports a score for the screen and NEVER trades.
        """
        spread = max(float(micro.get("spread_bps") or 0.0), 0.6)
        imb = float(micro.get("imb") or 0.0)
        ofi = float(micro.get("ofi") or 0.0)
        micro_bps = float(micro.get("micro") or 0.0) * 1e4
        lag = float(x[9]) if len(x) > 9 else 0.0
        best = self._best()
        pred = 0.0
        src = "prior"
        h_bars = max(1, round(best.h / 60.0))
        if best.status == "live" and best.ridge.w is not None:
            pred = float(best.ridge.predict(x.reshape(1, -1))[0]) * best.shrink
            src = f"flow-{best.nom}"
            veto = abs(pred) < (0.7 * best.q + self.fee)
        else:
            # Warm-up prior: it estimates a score for the screen and NEVER
            # trades. A hand rule that has never faced a holdout has no
            # claim on capital — the version that let "extreme dislocation"
            # fire unvalidated is the one that day-halted at -8.33%.
            pred = 0.6 * micro_bps + 6.0 * imb + 3.0 * ofi + 0.55 * lag
            veto = True
        tp = max(8.0, 1.15 * abs(pred), 1.2 * spread + 4.0)
        sl = max(12.0, 1.6 * abs(pred), tp * 1.2)
        return {
            "r_bps": pred, "ml_bps": pred, "tp_bps": tp, "sl_bps": sl,
            "veto": bool(veto), "score": pred / 8.0,
            "status": src if not veto else "wait",
            "policy": src, "bar": best.nom, "q_bps": best.q, "ic": best.ic,
            "h_bars": h_bars,
            "clocks": {h.nom: h.status for h in self.heads.values()},
        }

    def _save(self) -> None:
        try:
            with open(self.model_path, "w") as f:
                json.dump({h.nom: {"n": h.n, "ic": h.ic, "q": h.q,
                                   "status": h.status, "shrink": h.shrink,
                                   "fits": h.fits}
                           for h in self.heads.values()}, f)
            lab = os.path.join(os.path.dirname(self.model_path), "flow_xy.npz")
            arrs = {}
            for h in self.heads.values():
                k = str(int(h.h))
                arrs["X" + k] = np.asarray(h.X[-4000:], dtype=np.float32)
                arrs["y" + k] = np.asarray(h.y[-4000:], dtype=np.float32)
                arrs["T" + k] = np.asarray(h.T[-4000:], dtype=np.float64)
            np.savez(lab, **arrs)
        except OSError:
            pass

    def _load(self) -> None:
        lab = os.path.join(os.path.dirname(self.model_path), "flow_xy.npz")
        try:
            z = np.load(lab)
            if "X" in z:
                # legacy single-horizon file: those labels are 90 s labels
                head = self.heads[90.0]
                head.X = z["X"].astype(np.float64).tolist()
                head.y = z["y"].astype(np.float64).tolist()
                head.T = z["T"].astype(np.float64).tolist() if "T" in z \
                    else [0.0] * len(head.y)
            else:
                for h, head in self.heads.items():
                    k = str(int(h))
                    if "X" + k in z:
                        head.X = z["X" + k].astype(np.float64).tolist()
                        head.y = z["y" + k].astype(np.float64).tolist()
                        head.T = z["T" + k].astype(np.float64).tolist()
            try:
                meta = json.load(open(self.model_path))
                for h in self.heads.values():
                    if h.nom in meta:
                        h.fits = int(meta[h.nom].get("fits", 0))
                    elif "fits" in meta:      # legacy aggregate
                        h.fits = int(meta.get("fits", 0)) if h.h == 90.0 else 0
            except (OSError, ValueError):
                pass
            for head in self.heads.values():
                if len(head.y) >= 250:
                    head.fit(self.log)
        except Exception:
            pass
