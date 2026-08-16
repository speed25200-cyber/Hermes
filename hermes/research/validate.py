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
  5. Distinctness: its OOS return series must not be a near-copy of a
     survivor already accepted for the same instrument.

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


def _max_abs_corr(rets: np.ndarray, accepted: list[np.ndarray]) -> float:
    """Highest absolute correlation between `rets` and any accepted series.

    A grid search returns whole neighbourhoods of the same optimum: two
    genomes with different parameters can compute the identical position
    series (an RSI band of 23.4/85.9 and one of 23.5/85.8 rarely cross a
    different bar). Each of those clones takes a book slot, and the book has
    few. Worse, they are not a diversified pair — they are one bet held
    twice, which the allocator can only discover slowly through its crowding
    penalty, after it has already staked capital on both.
    """
    if not len(accepted):
        return 0.0
    sd = float(np.std(rets))
    if sd <= 1e-12:            # a flat series correlates with nothing
        return 0.0
    best = 0.0
    for prev in accepted:
        if len(prev) != len(rets) or float(np.std(prev)) <= 1e-12:
            continue
        c = float(np.corrcoef(rets, prev)[0, 1])
        if np.isfinite(c):
            best = max(best, abs(c))
    return best


def window_supports_validation(n_oos: int, n_trials: int, bars_per_year: int,
                               max_bar: float) -> tuple[bool, int]:
    """Can a survivor on this window be anything but an overfit?

    Selection over `n_trials` genomes produces a Sharpe on noise alone that
    depends on how long the scored window is. When that bar sits above what
    any real strategy achieves, nothing that clears it is real — so the
    search can only manufacture candidates that look spectacular and are not.

    Returns (searchable, bars_needed).
    """
    need = metrics.bars_for_selection_bar(n_trials, bars_per_year, max_bar)
    return n_oos >= need, need


def _cost_share(stats: dict) -> str:
    """How much of the gross return the frictions took.

    engine.run stores -1 when there was no gross profit to share (a funding
    carry book can be net-positive on a negative price return). Printing that
    as "-100% of gross" reads like a measurement rather than the absence of
    one, so it is spelled out.
    """
    share = stats.get("cost_share_of_gross", 0.0)
    if share < 0:
        return "no gross profit to share"
    return f"{share:.0%} of gross"


def validate_candidates(
    candidates: list[Candidate],
    candles: Candles,
    n_trials: int,
    is_fraction: float = 0.7,
    embargo_bars: int = 24,
    min_oos_sharpe: float = 0.5,
    min_dsr: float = 0.5,
    max_oos_drawdown: float = 0.35,
    fee_bps: float = 5.0,
    slip_bps: float = 2.0,
    top_k: int = 12,
    max_deployed: int = 6,
    n_folds: int = 3,
    fold_embargo: int = 12,
    max_corr: float = 0.9,
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
    accepted_rets: list[np.ndarray] = []
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
        clone_r = _max_abs_corr(res.rets, accepted_rets) if verdict else 0.0
        st["max_corr_to_book"] = clone_r
        distinct = clone_r < max_corr
        outcome = "DEPLOY" if verdict and distinct else "reject"
        if verdict and not distinct:
            outcome = f"reject (clone, r={clone_r:.2f})"
        if log:
            log(f"  OOS {g.gid} {g.describe()}: sharpe={st['sharpe']:.2f} "
                f"(iid {st.get('sharpe_iid', st['sharpe']):.2f}, "
                f"IF={st.get('autocorr_inflation', 1.0):.1f}) "
                f"vs selection bar {st.get('selection_bar', 0.0):.2f} "
                f"({st.get('n_trials', n_trials):,} trials) "
                f"dsr={st['dsr']:.3f} mdd={st['max_drawdown']:.1%} "
                f"folds+={st['oos_folds_positive']} "
                f"costs={st.get('cost_drag_annual', 0.0):.1%}/y "
                f"({_cost_share(st)}) "
                f"-> {outcome}")
        if verdict and distinct:
            survivors.append(ValidatedStrategy(
                genome=g, inst=candles.inst, bar=candles.bar,
                is_stats=cand.is_stats, oos_stats=st,
            ))
            seen_signals.append(g.signal)
            accepted_rets.append(res.rets)
    return survivors
