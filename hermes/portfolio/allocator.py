"""Adaptive capital allocation across deployed strategies.

Multiplicative-weights style: each strategy's weight is proportional to
exp(eta * ewma_perf), where ewma_perf is an exponentially-weighted estimate
of its recent per-bar risk-adjusted return computed from the positions it
recommended and the returns that actually followed. Capital flows toward
what is working NOW and drains from what has stopped working — the online
half of "finding the edge alone".

A portfolio-level volatility target then scales the combined book.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np


@dataclass
class StrategyTrack:
    ewma_ret: float = 0.0
    ewma_var: float = 0.0
    n_obs: int = 0

    def to_dict(self) -> dict:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, d: dict) -> "StrategyTrack":
        t = cls()
        t.__dict__.update(d)
        return t


@dataclass
class Allocator:
    ewma_halflife_bars: float = 168.0
    eta: float = 2.0
    max_weight: float = 0.5
    portfolio_vol_target: float = 0.20     # annualised
    bars_per_year: int = 8760
    tracks: dict[str, StrategyTrack] = field(default_factory=dict)
    ewma_port_var: float = 0.0

    @property
    def _alpha(self) -> float:
        return 1.0 - 0.5 ** (1.0 / self.ewma_halflife_bars)

    def observe(self, strat_returns: dict[str, float], port_return: float) -> None:
        """Feed one bar of realised per-strategy returns (shadow returns of the
        positions each strategy recommended) and the realised portfolio return."""
        a = self._alpha
        for sid, r in strat_returns.items():
            t = self.tracks.setdefault(sid, StrategyTrack())
            t.ewma_ret = (1 - a) * t.ewma_ret + a * r
            t.ewma_var = (1 - a) * t.ewma_var + a * r * r
            t.n_obs += 1
        self.ewma_port_var = (1 - a) * self.ewma_port_var + a * port_return * port_return

    def _score(self, t: StrategyTrack) -> float:
        """Per-bar Sharpe-like score, annualised."""
        sd = math.sqrt(max(t.ewma_var - t.ewma_ret**2, 1e-12))
        return t.ewma_ret / sd * math.sqrt(self.bars_per_year) if sd > 0 else 0.0

    def weights(self, sids: list[str]) -> dict[str, float]:
        if not sids:
            return {}
        scores = {}
        for sid in sids:
            t = self.tracks.get(sid, StrategyTrack())
            # young strategies get a neutral prior (score 0 -> equal-ish weight)
            scores[sid] = self._score(t) if t.n_obs >= 24 else 0.0
        m = max(scores.values())
        expw = {sid: math.exp(self.eta * min(s - m, 0.0)) for sid, s in scores.items()}
        z = sum(expw.values())
        w = {sid: v / z for sid, v in expw.items()}
        # cap and renormalise
        w = {sid: min(v, self.max_weight) for sid, v in w.items()}
        z = sum(w.values())
        return {sid: v / z for sid, v in w.items()} if z > 0 else w

    def portfolio_scale(self) -> float:
        """Scale factor to bring realised portfolio vol toward target."""
        realized = math.sqrt(max(self.ewma_port_var, 0.0) * self.bars_per_year)
        if realized < 1e-4:
            return 1.0
        return float(np.clip(self.portfolio_vol_target / realized, 0.25, 2.0))

    def combine(self, positions: dict[str, dict[str, float]]) -> dict[str, float]:
        """positions: sid -> {inst -> exposure}. Returns inst -> net exposure."""
        w = self.weights(list(positions))
        book: dict[str, float] = {}
        for sid, per_inst in positions.items():
            for inst, exp in per_inst.items():
                book[inst] = book.get(inst, 0.0) + w.get(sid, 0.0) * exp
        scale = self.portfolio_scale()
        return {inst: e * scale for inst, e in book.items()}

    # persistence ------------------------------------------------------- #

    def to_dict(self) -> dict:
        return {
            "tracks": {sid: t.to_dict() for sid, t in self.tracks.items()},
            "ewma_port_var": self.ewma_port_var,
        }

    def restore(self, d: dict) -> None:
        self.tracks = {
            sid: StrategyTrack.from_dict(td) for sid, td in d.get("tracks", {}).items()
        }
        self.ewma_port_var = d.get("ewma_port_var", 0.0)
