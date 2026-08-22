"""Causal learner: triple-barrier labels + ridge, scored on a deflated bar.

No deep RL. A PPO on a week of 1m bars memorizes noise. This module:

  * labels each bar by the *first* of TP / SL / time (Lopez de Prado)
  * trains ridge on OHLCV features only (L2 is live-only → kept as a prior)
  * splits train/holdout **by time within each instrument**, purging the
    labels whose path straddles the boundary
  * thins the holdout so no two labels share a bar — overlapping labels are
    the same observation counted five times, and they make every standard
    error a lie
  * compares the winning arm's per-trade Sharpe against the expected maximum
    of that many pure-noise arms (Bailey & Lopez de Prado). Searching more
    arms raises the bar the survivor must clear.

The last point is the one that matters. An earlier build picked the best of
three policies by holdout mean, then asked only whether that maximum was
above zero. On pure random walks it put 11 of 30 desks live, with holdouts
up to +21 bps *after* fees. The maximum of six noisy estimates is not
evidence; it has to beat what noise alone would have produced.

The live prior (book / fade) still proposes a side. The learner may shrink,
veto, or set barriers. It does not get to overfit a neural net.
"""

from __future__ import annotations

import math
import time

import numpy as np

from ..backtest.metrics import expected_max_sharpe
from ..data.store import Candles
from ..ml.models import RidgeRegressor
from . import features as F

KEYS = ("r1", "r3", "r5", "r12", "loc", "vshock", "persist", "vol", "btc_r1", "idio")
TP_GRID = (1.2, 2.0)
SL_GRID = (2.0, 3.2)
SAMPLE_STRIDE = 3      # bars between training samples
IS_FRACTION = 0.8      # per-instrument, by time
MIN_HOLDOUT = 30       # non-overlapping trades needed to judge an arm


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
        self.n_holdout = 0
        self.holdout_sr = 0.0     # per-trade Sharpe of the winning arm
        self.sel_bar = 0.0        # what pure noise would have produced
        self.ic_bar = 0.0         # IC noise floor; below it the ridge is mute
        self.n_trials = 0         # arms searched, including the barrier grid
        self.status = "unfitted"
        self.policy = "flat"  # fade | follow | flat

    def to_dict(self) -> dict:
        return {
            "alpha": self.alpha, "ic": self.ic, "holdout_mean": self.holdout_mean,
            "tp_mult": self.tp_mult, "sl_mult": self.sl_mult, "fitted": self.fitted,
            "n_train": self.n_train, "status": self.status, "policy": self.policy,
            "n_holdout": self.n_holdout, "holdout_sr": self.holdout_sr,
            "sel_bar": self.sel_bar, "n_trials": self.n_trials,
            "ic_bar": self.ic_bar,
        }

    def fit(self, candles: dict[str, Candles], max_names: int = 6,
            only: str | None = None, n_trials_prior: int = 1) -> dict:
        """Walk-forward fit. Picks fade vs follow vs breakout vs sit-out.

        `n_trials_prior` is the number of times this same fit is being run
        elsewhere in the search (other bars, other desks). It multiplies the
        arm count when the selection bar is computed, so a caller that tries
        six variants cannot launder the best one through six separate
        one-in-three gates.
        """
        if only:
            names = [only] if only in candles and len(candles[only]) > 200 else []
        else:
            names = [k for k in ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP")
                     if k in candles and len(candles[k]) > 200]
            extra = [k for k, c in candles.items() if k not in names and len(c) > 200]
            names += extra[: max(0, max_names - len(names))]
        if not names:
            self.status, self.policy = "no-data", "flat"
            return self.to_dict()
        btc = candles.get("BTC-USDT-SWAP")
        n_grid = 1
        if btc is not None and len(btc) > 400:
            (self.tp_mult, self.sl_mult), _, n_grid = self._grid_barriers(btc)
        arms = []
        for policy, side_of in (
            ("fade", lambda r1: -1.0 if r1 > 0 else 1.0 if r1 < 0 else 0.0),
            ("follow", lambda r1: 1.0 if r1 > 0 else -1.0 if r1 < 0 else 0.0),
            ("breakout", "breakout"),
        ):
            packed = self._collect(candles, names, btc, side_of)
            if packed is None:
                continue
            X, y, gi, gb = packed
            tr, ho = self._time_split(gi, gb)
            if len(tr) < 200 or len(ho) < MIN_HOLDOUT:
                self.log(f"learner arm {policy}: too thin "
                         f"(train={len(tr)} holdout={len(ho)})")
                continue
            ridge = RidgeRegressor(l2=12.0)
            ridge.fit(X[tr], y[tr])
            pnl = y[ho]
            ic = _ic(ridge.predict(X[ho]), pnl)
            mu = float(np.mean(pnl))
            sd = float(np.std(pnl, ddof=1))
            sr = mu / sd if sd > 1e-12 else 0.0
            arms.append((sr, mu, ic, policy, ridge, len(tr), len(ho)))
            self.log(f"learner arm {policy}: train={len(tr)} holdout={len(ho)} "
                     f"ic={ic:.3f} mean={mu:+.2f}bps sr={sr:+.3f}")
        if not arms:
            self.status, self.policy, self.alpha, self.fitted = "few-samples", "flat", 0.0, False
            return self.to_dict()

        # Rank by the risk-adjusted holdout, not the raw mean: one lucky
        # +80 bps trade should not out-rank a steady +2.
        arms.sort(key=lambda t: t[0], reverse=True)
        sr, mu, ic, policy, ridge, n_train, n_hold = arms[0]
        self.ridge, self.ic, self.holdout_mean = ridge, ic, mu
        self.n_train, self.n_holdout, self.holdout_sr = n_train, n_hold, sr

        # The bar rises with everything the search looked at: the arms here,
        # the barrier grid that shaped their labels, and whatever the caller
        # is running in parallel.
        self.n_trials = max(2, len(arms) * n_grid * max(1, int(n_trials_prior)))
        self.sel_bar = expected_max_sharpe(self.n_trials, n_hold)

        # Two independent questions, answered separately.
        #
        # "Does this policy make money?" is settled by the holdout mean and
        # the selection bar. "Does the ridge rank trades within it?" is
        # settled by the holdout IC against its own noise floor, ~2/sqrt(n).
        # An earlier build asked only the first and then let a positive IC of
        # 0.02 — pure noise at n=63 — veto arms that had cleared the bar with
        # sr=+0.41. The ridge is a modulation, not a licence: when it carries
        # no information the answer is to give it no weight, not to sit out a
        # policy that paid.
        self.ic_bar = 2.0 / math.sqrt(max(n_hold, 1))
        if mu > 0 and sr > self.sel_bar:
            self.policy, self.status = policy, "live"
            self.alpha = float(min(0.5, 0.15 + 1.5 * ic)) if ic > self.ic_bar else 0.0
            self.fitted = True
        else:
            self.policy, self.status, self.alpha, self.fitted = "flat", "veto", 0.0, True
        self.fit_at = time.time()
        self.log(f"learner {self.status} policy={self.policy} n={self.n_train} "
                 f"holdout={self.n_holdout} ic={self.ic:.3f} "
                 f"mean={self.holdout_mean:+.2f}bps sr={sr:+.3f} "
                 f"vs bar={self.sel_bar:.3f} ({self.n_trials} essais) "
                 f"ic_bar={self.ic_bar:.3f} "
                 f"tp={self.tp_mult:.2f}x sl={self.sl_mult:.2f}x α={self.alpha:.2f}")
        return self.to_dict()

    def _time_split(self, gi: np.ndarray, gb: np.ndarray,
                    is_fraction: float = IS_FRACTION) -> tuple[np.ndarray, np.ndarray]:
        """Split by time *within each instrument*, purge, and de-overlap.

        Three things the naive `cut = int(0.8 * len(y))` got wrong when the
        samples of several instruments are concatenated:

          * the cut landed inside whichever instrument happened to sit at the
            80% mark, so the "holdout" was largely *other assets* rather than
            *later time*;
          * labels whose barrier path crossed the cut were trained on and
            scored on the same bars;
          * consecutive samples sit `SAMPLE_STRIDE` bars apart while a label
            looks `horizon` bars ahead, so each holdout trade overlapped its
            four or five neighbours. Averaging those is not an average over
            n observations, and every standard error computed from them is
            too small by roughly the square root of the overlap.
        """
        train: list[int] = []
        hold: list[int] = []
        for inst_id in np.unique(gi):
            idx = np.flatnonzero(gi == inst_id)
            idx = idx[np.argsort(gb[idx])]
            cut = int(is_fraction * len(idx))
            if cut < 20 or len(idx) - cut < 5:
                continue
            boundary = int(gb[idx[cut]])
            train.extend(int(j) for j in idx[:cut]
                         if int(gb[j]) + self.horizon < boundary)
            last = -(10 ** 9)
            for j in idx[cut:]:
                if int(gb[j]) - last >= self.horizon:
                    hold.append(int(j))
                    last = int(gb[j])
        return np.asarray(train, dtype=int), np.asarray(hold, dtype=int)

    def _collect(self, candles, names, btc, side_of):
        """Returns (X, y, inst_id, bar_index). The last two let the split be
        made by time within an instrument instead of by array position."""
        xs, ys, gi, gb = [], [], [], []
        for inst_id, inst in enumerate(names):
            c = candles[inst]
            n = len(c)
            is_btc = inst.startswith("BTC-")
            for i in range(80, n - self.horizon - 2, SAMPLE_STRIDE):
                btc_r1 = 0.0
                if btc is not None and 0 < i < len(btc) and btc.c[i - 1] > 0:
                    btc_r1 = float(btc.c[i] / btc.c[i - 1] - 1.0)
                f = F.candle_feats(c.slice(0, i + 1))
                vol_bps = max(float(f.get("vol", 0.0)) * 1e4, 4.0)
                r1 = float(f.get("r1", 0.0))
                if side_of == "breakout":
                    if i < 24:
                        continue
                    hh, ll = float(np.max(c.h[i - 20:i])), float(np.min(c.l[i - 20:i]))
                    if c.c[i] > hh:
                        side = 1.0
                    elif c.c[i] < ll:
                        side = -1.0
                    else:
                        continue
                else:
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
                gi.append(inst_id)
                gb.append(i)
        if len(ys) < 400:
            return None
        return (np.asarray(xs, dtype=np.float64), np.asarray(ys, dtype=np.float64),
                np.asarray(gi, dtype=int), np.asarray(gb, dtype=int))

    def _grid_barriers(self, c: Candles) -> tuple[tuple[float, float], float, int]:
        """Pick TP/SL multipliers. Also returns how many combos were scored —
        each one is a trial, and the caller owes the bar for all of them."""
        best, best_mu, tried = (1.2, 2.5), -1e9, 0
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
                tried += 1
                if mu > best_mu:
                    best_mu, best = mu, (tm, sm)
        return best, best_mu, max(tried, 1)

    def infer(self, feat: dict, btc_r1: float, is_btc: bool,
              prior_score: float, vol_bps: float) -> dict:
        """Blend prior with ML. Returns ml_bps, score, tp_bps, sl_bps, veto."""
        vol_bps = max(float(vol_bps), 4.0)
        tp = max(8.0, self.tp_mult * vol_bps)
        sl = max(12.0, self.sl_mult * vol_bps)
        veto = False
        ml_bps = 0.0
        score = float(prior_score)
        if self.policy in ("follow", "breakout"):
            score = -score  # continuation: flip the fade prior
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


BARS = ("15m", "1H")
HOLD = {"15m": 16, "1H": 12}
DAYS = {"15m": 60, "1H": 180}
ASSETS = ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP")


class HorizonBook:
    """Per-asset, per-bar learners.

    Each desk searches every bar in ``BARS``, and each of those fits searches
    three policies over a barrier grid. Only the best cell is kept — so the
    selection bar every cell is judged against is computed for the *whole*
    search, not for one fit at a time. A desk goes live only when its winner
    beats what that many pure-noise arms would have produced.
    """

    def __init__(self, fee_rt_bps: float, log=None):
        self.log = log or (lambda m: None)
        self.fee_rt = float(fee_rt_bps)
        self.learners: dict[tuple[str, str], ScalpLearner] = {}
        self.best: dict[str, tuple[str, ScalpLearner]] = {}

    def fit_store(self, store, names: list[str] | None = None) -> dict:
        names = list(names or ASSETS)
        out: dict = {}
        self.learners = {}
        self.best = {}
        for inst in names:
            ranked = []
            for bar in BARS:
                try:
                    c = store.load(inst, bar)
                except Exception:
                    continue
                if len(c) < 200:
                    continue
                pack = {inst: c}
                if inst != "BTC-USDT-SWAP":
                    try:
                        btc = store.load("BTC-USDT-SWAP", bar)
                        if len(btc) > 80:
                            pack["BTC-USDT-SWAP"] = btc
                    except Exception:
                        pass
                lr = ScalpLearner(fee_rt_bps=self.fee_rt, horizon=HOLD[bar], log=self.log)
                d = lr.fit(pack, only=inst, n_trials_prior=len(BARS))
                self.learners[(inst, bar)] = lr
                out[f"{inst.split('-')[0]}:{bar}"] = d
                ranked.append((d.get("holdout_sr") or -1e9, bar, lr))
            if ranked:
                # rank on the risk-adjusted holdout, and only among cells that
                # already cleared their own bar — otherwise "best" just means
                # "luckiest".
                ranked.sort(key=lambda t: t[0], reverse=True)
                live = [r for r in ranked if r[2].status == "live"]
                _, bar, lr = (live or ranked)[0]
                self.best[inst] = (bar, lr)
                self.log(f"desk {inst.split('-')[0]} best={bar}/{lr.policy} "
                         f"status={lr.status} mean={lr.holdout_mean:+.2f}bps "
                         f"sr={lr.holdout_sr:+.3f} vs bar={lr.sel_bar:.3f}")
        live = self.live_bars()
        self.log(f"desk live={live or ['none']}")
        return out

    def live_bars(self) -> list[str]:
        return sorted({bar for inst, (bar, lr) in self.best.items() if lr.status == "live"})

    def infer_asset(self, inst: str, feat, btc_r1, is_btc, prior, vol_bps) -> dict:
        pair = self.best.get(inst)
        if not pair:
            return {"score": 0.0, "ml_bps": 0.0, "tp_bps": 20.0, "sl_bps": 30.0,
                    "veto": True, "alpha": 0.0, "ic": 0.0, "status": "unfitted",
                    "policy": "flat", "bar": "15m"}
        bar, lr = pair
        inf = lr.infer(feat, btc_r1, is_btc, prior, vol_bps)
        inf["bar"] = bar
        return inf

    def to_dict(self) -> dict:
        d = {f"{inst.split('-')[0]}:{bar}": lr.to_dict()
             for (inst, bar), lr in self.learners.items()}
        d["_best"] = {inst.split("-")[0]: {"bar": bar, **lr.to_dict()}
                      for inst, (bar, lr) in self.best.items()}
        return d