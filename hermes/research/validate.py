"""Out-of-sample validation gate.

Evolution proposes; this module disposes. A candidate is deployed only if,
on data it has never seen (separated from the in-sample period by an embargo
gap), it clears:

  1. OOS annualised Sharpe >= min_oos_sharpe
  2. Deflated Sharpe Ratio (accounting for the TOTAL number of genomes the
     search evaluated) >= min_dsr
  3. OOS max drawdown below a hard cap

This is the anti-overfitting core: the more strategies the search tries, the
higher the bar every survivor must clear.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..backtest import engine
from ..data.store import Candles
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
    log=None,
) -> list[ValidatedStrategy]:
    """Evaluate the best IS candidates on OOS data; return survivors."""
    _, oos = split_is_oos(candles, is_fraction, embargo_bars)
    if len(oos) < 200:
        raise ValueError("not enough OOS data to validate (need >= 200 bars)")

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
        pos_full = compute_position(candles, g)
        oos_start = len(candles) - len(oos)
        res = engine.run(oos, pos_full[oos_start:], fee_bps, slip_bps, n_trials=n_trials)
        st = res.stats
        verdict = (
            st["sharpe"] >= min_oos_sharpe
            and st["dsr"] >= min_dsr
            and st["max_drawdown"] <= max_oos_drawdown
        )
        if log:
            log(f"  OOS {g.gid} {g.describe()}: sharpe={st['sharpe']:.2f} "
                f"dsr={st['dsr']:.3f} mdd={st['max_drawdown']:.1%} "
                f"-> {'DEPLOY' if verdict else 'reject'}")
        if verdict:
            survivors.append(ValidatedStrategy(
                genome=g, inst=candles.inst, bar=candles.bar,
                is_stats=cand.is_stats, oos_stats=st,
            ))
            seen_signals.append(g.signal)
    return survivors
