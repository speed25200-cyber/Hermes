"""Research gate for cross-sectional portfolio strategies.

Same discipline as the per-instrument gate: a small parameter grid is
searched in-sample only, the single best config is then scored once on
embargoed out-of-sample data, and it deploys only if it clears the OOS
Sharpe floor, the Deflated Sharpe Ratio (n_trials = grid size), the
drawdown cap and purged multi-fold consistency.
"""

from __future__ import annotations

import numpy as np

from ..backtest import metrics
from ..data.store import BARS_PER_YEAR, Candles
from ..strategy.genome import Genome
from ..strategy.xs import XS_GRID, funding_xs_positions, portfolio_backtest
from .validate import ValidatedStrategy

XS_INST = "XS-PORTFOLIO"


def research_xs(
    candles_map: dict[str, Candles],
    fee_bps: float,
    slip_bps: float,
    is_fraction: float = 0.7,
    embargo_bars: int = 24,
    min_oos_sharpe: float = 0.5,
    min_dsr: float = 0.05,
    max_oos_drawdown: float = 0.35,
    n_folds: int = 3,
    log=None,
) -> list[ValidatedStrategy]:
    """Grid-search funding_xs in-sample, validate the winner out-of-sample."""
    insts = sorted(candles_map)
    if len(insts) < 4:
        if log:
            log("xs research: needs >= 4 instruments, skipping")
        return []
    bar = candles_map[insts[0]].bar
    bpy = BARS_PER_YEAR[bar]

    def slice_map(a: float, b: float) -> dict[str, Candles]:
        out = {}
        for inst, c in candles_map.items():
            n = len(c)
            out[inst] = c.slice(int(n * a), int(n * b))
        return out

    # ---- in-sample grid search ----------------------------------------
    is_map = slice_map(0.0, is_fraction)
    best = None
    for params in XS_GRID:
        common, _, pos = funding_xs_positions(is_map, params)
        if not pos:
            continue
        rets = portfolio_backtest(is_map, pos, common, fee_bps, slip_bps)
        sh = metrics.sharpe(rets, bpy)
        if log:
            log(f"xs IS: {params} sharpe={sh:.2f}")
        if best is None or sh > best[0]:
            best = (sh, params)
    if best is None or best[0] <= 0:
        if log:
            log("xs research: no config profitable in-sample, rejecting")
        return []

    # ---- out-of-sample validation (embargoed, warm-started) -----------
    _, params = best
    common_full, _, pos_full = funding_xs_positions(candles_map, params)
    if not pos_full:
        return []
    n = len(common_full)
    ref = candles_map[insts[0]]
    is_cut_ts = ref.ts[int(len(ref) * is_fraction)]
    oos_start = int(np.searchsorted(common_full, is_cut_ts)) + embargo_bars
    if n - oos_start < 300:
        if log:
            log("xs research: not enough OOS bars, rejecting")
        return []
    rets_full = portfolio_backtest(candles_map, pos_full, common_full,
                                   fee_bps, slip_bps)
    oos = rets_full[oos_start:]
    eq = np.cumprod(1.0 + oos)
    st = metrics.summarize(oos, eq, bpy, n_trials=len(XS_GRID))

    edges = np.linspace(0, len(oos), n_folds + 1).astype(int)
    fold_sh = [metrics.sharpe(oos[a + (12 if a else 0):b], bpy)
               for a, b in zip(edges[:-1], edges[1:]) if b - a > 50]
    positive = sum(1 for s in fold_sh if s > 0)
    consistent = positive >= (len(fold_sh) // 2 + 1) if fold_sh else False
    st["oos_folds_positive"] = f"{positive}/{len(fold_sh)}"

    verdict = (st["sharpe"] >= min_oos_sharpe and st["dsr"] >= min_dsr
               and st["max_drawdown"] <= max_oos_drawdown and consistent)
    if log:
        log(f"xs OOS: {params} sharpe={st['sharpe']:.2f} dsr={st['dsr']:.3f} "
            f"mdd={st['max_drawdown']:.1%} folds+={st['oos_folds_positive']} "
            f"-> {'DEPLOY' if verdict else 'reject'}")
    if not verdict:
        return []

    genome = Genome(signal="funding_xs", params=dict(params),
                    vol_target=0.15, max_lev=1.0)
    return [ValidatedStrategy(genome=genome, inst=XS_INST, bar=bar,
                              is_stats={"sharpe": best[0]}, oos_stats=st)]
