"""Out-of-sample validation gate.

Evolution proposes; this module disposes. A candidate is deployed only if,
on data it has never seen (separated from the in-sample period by an embargo
gap), it clears:

  1. OOS annualised Sharpe >= min_oos_sharpe
  2. Deflated Sharpe Ratio (accounting for the TOTAL number of genomes the
     search evaluated) >= min_dsr
  3. OOS max drawdown below a hard cap
  4. Purged multi-fold consistency: the OOS window is cut into sub-folds
     (embargo between them) and the strategy must be profitable in the
     majority — one lucky stretch is not an edge (CPCV spirit,
     Lopez de Prado).

This is the anti-overfitting core: the more strategies the search tries, the
higher the bar every survivor must clear.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..backtest import engine, metrics
from ..data.store import BARS_PER_YEAR, Candles
from ..strategy.genome import Genome
from ..strategy.signals import compute_position
from .evolve import Candidate


@dataclass
class ValidatedStrategy:
    genome: Genome
    inst: str
    bar: str
    is_stats: dict
    oos_stats: dict

    def to_dict(self) -> dict:
        return {
            "genome": self.genome.to_dict(),
            "inst": self.inst,
            "bar": self.bar,
            "is_stats": self.is_stats,
            "oos_stats": self.oos_stats,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ValidatedStrategy":
        return cls(
            genome=Genome.from_dict(d["genome"]), inst=d["inst"], bar=d["bar"],
            is_stats=d.get("is_stats", {}), oos_stats=d.get("oos_stats", {}),
        )


def split_is_oos(candles: Candles, is_fraction: float, embargo_bars: int
                 ) -> tuple[Candles, Candles]:
    n = len(candles)
    cut = int(n * is_fraction)
    oos_start = min(cut + embargo_bars, n)
    return candles.slice(0, cut), candles.slice(oos_start, n)


def validate_candidates(
    candidates: list[Candidate],
    candles: Candles,
    n_trials: int,
    is_fraction: float = 0.7,
    embargo_bars: int = 24,
    min_oos_sharpe: float = 0.5,
    min_dsr: float = 0.05,
    max_oos_drawdown: float = 0.35,
    fee_bps: float = 5.0,
    slip_bps: float = 2.0,
    top_k: int = 12,
    max_deployed: int = 6,
    n_folds: int = 3,
    fold_embargo: int = 12,
    ctx: dict | None = None,
    log=None,
) -> list[ValidatedStrategy]:
    """Evaluate the best IS candidates on OOS data; return survivors."""
    _, oos = split_is_oos(candles, is_fraction, embargo_bars)
    if len(oos) < 200:
        raise ValueError("not enough OOS data to validate (need >= 200 bars)")

    bpy = BARS_PER_YEAR[candles.bar]
    survivors: list[ValidatedStrategy] = []
    seen_signals: list[str] = []
    for cand in candidates[: top_k * 3]:
        if len(survivors) >= max_deployed:
            break
        g = cand.genome
        # keep the deployed set diverse: at most 2 per signal family
        family_count = sum(1 for s in seen_signals if s == g.signal)
        if family_count >= 2:
            continue
        # OOS positions computed on the full history then sliced, so the
        # strategy has proper warm-up (as it would live), but only OOS bars
        # are scored.
        pos_full = compute_position(candles, g, ctx)
        oos_start = len(candles) - len(oos)
        res = engine.run(oos, pos_full[oos_start:], fee_bps, slip_bps, n_trials=n_trials)
        st = res.stats

        # purged sub-fold consistency: majority of OOS folds must be positive
        edges = np.linspace(0, len(oos), n_folds + 1).astype(int)
        fold_sharpes = []
        for a, b in zip(edges[:-1], edges[1:]):
            a2 = a + (fold_embargo if a > 0 else 0)   # purge fold boundary
            if b - a2 > 50:
                fold_sharpes.append(metrics.sharpe(res.rets[a2:b], bpy))
        positive_folds = sum(1 for s in fold_sharpes if s > 0)
        consistent = positive_folds >= (len(fold_sharpes) // 2 + 1) if fold_sharpes else False
        st["oos_folds_positive"] = f"{positive_folds}/{len(fold_sharpes)}"

        verdict = (
            st["sharpe"] >= min_oos_sharpe
            and st["dsr"] >= min_dsr
            and st["max_drawdown"] <= max_oos_drawdown
            and consistent
        )
        if log:
            log(f"  OOS {g.gid} {g.describe()}: sharpe={st['sharpe']:.2f} "
                f"(iid {st.get('sharpe_iid', st['sharpe']):.2f}, "
                f"IF={st.get('autocorr_inflation', 1.0):.1f}) "
                f"dsr={st['dsr']:.3f} mdd={st['max_drawdown']:.1%} "
                f"folds+={st['oos_folds_positive']} "
                f"costs={st.get('cost_drag_annual', 0.0):.1%}/y "
                f"({st.get('cost_share_of_gross', 0.0):.0%} of gross) "
                f"-> {'DEPLOY' if verdict else 'reject'}")
        if verdict:
            survivors.append(ValidatedStrategy(
                genome=g, inst=candles.inst, bar=candles.bar,
                is_stats=cand.is_stats, oos_stats=st,
            ))
            seen_signals.append(g.signal)
    return survivors
