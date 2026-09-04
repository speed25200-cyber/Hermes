"""Panel (universe-wide) strategy evaluation.

A strategy is a RULE, not a curve fitted to one coin. The same genome is
applied to every instrument of the universe and the book is the equal-split
sum of the per-instrument (vol-targeted) exposures. Validating the rule on
the whole panel is how systematic managers test signals: the sample is the
universe x time, cross-instrument diversification raises the achievable
Sharpe, and a rule that only "works" on one lucky coin is exposed for what
it is.

Every instrument keeps its own bar sequence (new listings contribute the
history they have); the panel aligns them on the union of timestamps and
treats missing bars as absent (not zero). All positions are computed by the
same `compute_position` that runs live.
"""

from __future__ import annotations

import numpy as np

from ..data.store import BARS_PER_YEAR, Candles
from ..strategy.genome import Genome
from ..strategy.signals import compute_position
from ..universe import membership_mask

PANEL_INST = "PANEL"


class Panel:
    def __init__(self, candles_map: dict[str, Candles], leader: str | None = None,
                 min_bars: int = 600, top_n: int | None = None,
                 membership_bars: int = 720):
        self.candles: dict[str, Candles] = {
            i: c for i, c in candles_map.items() if len(c) >= min_bars}
        if not self.candles:
            raise ValueError("panel needs at least one instrument with data")
        self.insts = sorted(self.candles)
        self.leader = leader if leader in self.candles else None
        first = self.candles[self.insts[0]]
        self.bar = first.bar
        self.bpy = BARS_PER_YEAR[self.bar]
        self.ts = np.unique(np.concatenate([c.ts for c in self.candles.values()]))
        self.n = len(self.ts)
        self.k = len(self.insts)
        self.idx: dict[str, np.ndarray] = {}
        self.ret = np.full((self.k, self.n), np.nan)
        self.fund = np.zeros((self.k, self.n))
        for j, inst in enumerate(self.insts):
            c = self.candles[inst]
            ix = np.searchsorted(self.ts, c.ts)
            self.idx[inst] = ix
            self.ret[j, ix] = c.returns
            self.fund[j, ix] = c.funding
        self.top_n = top_n
        self.membership_bars = membership_bars
        # investable[j, t]: present AND (when a volume rank is requested)
        # among the top_n names by trailing quote volume at bar t
        self.investable = membership_mask(self.candles, self.insts, self.idx,
                                          self.n, top_n, membership_bars,
                                          min_bars=0)
        self.present = ~np.isnan(self.ret)
        self.investable &= self.present
        self.n_present = self.investable.sum(axis=0)

    # ------------------------------------------------------------------ #

    def ctx(self, inst: str) -> dict:
        if self.leader and self.leader != inst:
            return {"leader": self.candles[self.leader]}
        return {}

    def cut_index(self, fraction: float) -> int:
        return int(self.n * fraction)

    def slice_to(self, cut: int) -> "Panel":
        """Panel restricted to master bars [0, cut) — every instrument is
        sliced by timestamp, so nothing after the cut is visible."""
        cut_ts = self.ts[min(cut, self.n - 1)] if cut < self.n else np.iinfo(np.int64).max
        out = {}
        for inst, c in self.candles.items():
            m = int(np.searchsorted(c.ts, cut_ts, side="left"))
            if m > 0:
                out[inst] = c.slice(0, m)
        return Panel(out, leader=self.leader, min_bars=1, top_n=self.top_n,
                     membership_bars=self.membership_bars)

    def positions(self, g: Genome) -> np.ndarray:
        """(k, n) exposure matrix on the master grid, NaN where absent."""
        P = np.full((self.k, self.n), np.nan)
        for j, inst in enumerate(self.insts):
            c = self.candles[inst]
            P[j, self.idx[inst]] = compute_position(c, g, self.ctx(inst))
        # outside the investable set a name holds nothing
        P[self.present & ~self.investable] = 0.0
        return P

    def book(self, P: np.ndarray) -> np.ndarray:
        """Equal split among instruments present at each bar: the exposure
        of instrument j is P[j] / n_present — exactly what the live trader
        sends for a panel strategy."""
        with np.errstate(invalid="ignore", divide="ignore"):
            w = P / np.where(self.n_present > 0, self.n_present, np.nan)[None, :]
        return w

    def book_returns(self, P: np.ndarray, fee_bps: float, slip_bps: float
                     ) -> tuple[np.ndarray, float, float]:
        """Per-bar book return on the master grid, mean |trade| per bar
        (turnover, in equity units) and mean gross exposure."""
        cost = (fee_bps + slip_bps) * 1e-4
        W = self.book(P)
        pnl = np.full((self.k, self.n), np.nan)
        tr = np.full((self.k, self.n), np.nan)
        for j, inst in enumerate(self.insts):
            ix = self.idx[inst]
            w = np.nan_to_num(W[j, ix], nan=0.0)
            prev = np.concatenate(([0.0], w[:-1]))
            r = self.ret[j, ix]
            f = self.fund[j, ix]
            trade = np.abs(w - prev)
            pnl[j, ix] = prev * r - trade * cost - prev * f
            tr[j, ix] = trade
        with np.errstate(invalid="ignore"):
            rets = np.nansum(pnl, axis=0)
            turnover = float(np.nansum(tr)) / max(self.n, 1)
            gross = float(np.nanmean(np.nansum(np.abs(np.nan_to_num(W)), axis=0)))
        rets = np.clip(np.nan_to_num(rets, nan=0.0), -0.95, 10.0)
        return rets, turnover, gross

    def live_book(self, g: Genome, min_bars: int = 600) -> dict[str, float]:
        """Latest per-instrument exposure of the rule, equal-split among the
        names investable at the last bar — the target book the trader
        reconciles."""
        raw: dict[str, float] = {}
        for j, inst in enumerate(self.insts):
            c = self.candles[inst]
            if len(c) < min_bars or not self.investable[j, -1]:
                continue
            pos = compute_position(c, g, self.ctx(inst))
            raw[inst] = float(pos[-1])
        if not raw:
            return {}
        n = len(raw)
        return {inst: v / n for inst, v in raw.items()}

    def members_now(self) -> list[str]:
        return [inst for j, inst in enumerate(self.insts) if self.investable[j, -1]]
