"""Research gate for cross-sectional portfolio strategies.

Same discipline as the per-instrument gate, applied to three market-neutral
families (funding carry, momentum, short-term reversal): a small parameter
grid is searched in-sample only, the single best config per family is then
scored once on embargoed out-of-sample data, and it deploys only if it
clears the OOS Sharpe floor, the Deflated Sharpe Ratio (n_trials = ALL xs
configs searched across families — selection bias is charged for the whole
sweep, not per family), the drawdown cap and purged multi-fold consistency.
"""

from __future__ import annotations

import numpy as np

from ..backtest import metrics
from ..data.store import BARS_PER_YEAR, Candles
from ..strategy.genome import Genome
from ..strategy.xs import (XS_BASIS_GRID, XS_GRID, XS_LEAD_GRID, XS_MOM_GRID,
                           XS_OI_GRID, XS_REV_GRID, XS_TAKER_GRID,
                           portfolio_backtest, xs_positions)
from .validate import ValidatedStrategy

XS_INST = "XS-PORTFOLIO"

# (genome signal name, scoring kind, grid, data coverage requirement)
# coverage: None = full candle history, "funding" = funding-rate history,
# "aux" = rubik series (open interest / taker flow) — both exist only for
# the recent months, so those families research on the covered window only.
XS_FAMILIES = [
    ("funding_xs", "carry", XS_GRID, "funding"),
    ("xs_mom", "mom", XS_MOM_GRID, None),
    ("xs_rev", "rev", XS_REV_GRID, None),
    ("xs_lead", "lead", XS_LEAD_GRID, None),
    ("xs_taker", "taker", XS_TAKER_GRID, "aux"),
    ("xs_oi", "oi", XS_OI_GRID, "aux"),
    ("xs_basis", "basis", XS_BASIS_GRID, "idx"),
]

XS_TOTAL_TRIALS = sum(len(grid) for _, _, grid, _ in XS_FAMILIES)


def _coverage_start(c: Candles, need: str) -> int | None:
    """First bar index where the required data series exist for `c`."""
    if need == "funding":
        nz = np.nonzero(c.funding)[0]
        return int(nz[0]) if len(nz) else None
    if need == "idx":
        if "idx" not in c.x:
            return None
        ok = np.nonzero(~np.isnan(c.x["idx"]))[0]
        return int(ok[0]) if len(ok) else None
    # "aux": every rubik series present and populated
    keys = ("oi", "tak_buy", "tak_sell", "lsr")
    if any(k not in c.x for k in keys):
        return None
    valid = np.ones(len(c), dtype=bool)
    for k in keys:
        valid &= ~np.isnan(c.x[k])
    idx = np.nonzero(valid)[0]
    return int(idx[0]) if len(idx) else None


def _trim_to_coverage(candles_map: dict[str, Candles], need: str, log=None
                      ) -> dict[str, Candles] | None:
    """Exchanges expose only a few months of funding / open-interest / flow
    history; earlier bars carry blanks that would silently kill these
    signals across most of the sample. Research them only where the data
    actually exists."""
    starts = []
    covered = {}
    for inst in sorted(candles_map):
        c = candles_map[inst]
        i0 = _coverage_start(c, need)
        if i0 is None:
            if log:
                log(f"xs research: {inst} has no {need} history, dropping")
            continue
        covered[inst] = c
        starts.append(c.ts[i0])
    if len(covered) < 4:
        if log:
            log(f"xs research: <4 instruments with {need} history, skipping")
        return None
    start_ts = max(starts)
    trimmed = {}
    for inst, c in covered.items():
        i0 = int(np.searchsorted(c.ts, start_ts))
        trimmed[inst] = c.slice(i0, len(c))
    min_len = min(len(c) for c in trimmed.values())
    if min_len < 3000:
        if log:
            log(f"xs research: only {min_len} {need}-covered bars "
                f"(need 3000+), rejecting")
        return None
    if log:
        log(f"xs research: {need} coverage window = {min_len} bars "
            f"x {len(trimmed)} instruments")
    return trimmed


def _validate_family(
    name: str,
    kind: str,
    grid: list[dict],
    candles_map: dict[str, Candles],
    fee_bps: float,
    slip_bps: float,
    is_fraction: float,
    embargo_bars: int,
    min_oos_sharpe: float,
    min_dsr: float,
    max_oos_drawdown: float,
    n_folds: int,
    log,
    leader: str | None = None,
) -> ValidatedStrategy | None:
    insts = sorted(candles_map)
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
    # `dir` only flips the sign of every leg, and every transform downstream
    # of it is odd-symmetric, so the inverted book is the exact negation of
    # the plain one. Building it costs a full universe alignment, two
    # realized-vol passes per name and a per-bar hysteresis loop — several
    # seconds on a 60-instrument universe — so it is negated rather than
    # recomputed.
    cache: dict[tuple, tuple] = {}
    for params in grid:
        key = tuple(sorted((k, v) for k, v in params.items() if k != "dir"))
        if key in cache:
            common, pos = cache[key]
        else:
            common, _, pos = xs_positions(
                is_map, {**params, "dir": 0}, kind=kind, leader=leader)
            cache[key] = (common, pos)
        if not pos:
            continue
        if int(params.get("dir", 0)) == 1:
            pos = {inst: -arr for inst, arr in pos.items()}
        rets = portfolio_backtest(is_map, pos, common, fee_bps, slip_bps)
        sh = metrics.sharpe(rets, bpy)
        if log:
            log(f"xs IS [{name}]: {params} sharpe={sh:.2f}")
        if best is None or sh > best[0]:
            best = (sh, params)
    if best is None or best[0] <= 0:
        if log:
            log(f"xs research [{name}]: no config profitable in-sample, "
                f"rejecting")
        return None

    # ---- out-of-sample validation (embargoed, warm-started) -----------
    _, params = best
    common_full, _, pos_full = xs_positions(candles_map, params, kind=kind,
                                            leader=leader)
    if not pos_full:
        return None
    n = len(common_full)
    ref = candles_map[insts[0]]
    is_cut_ts = ref.ts[int(len(ref) * is_fraction)]
    oos_start = int(np.searchsorted(common_full, is_cut_ts)) + embargo_bars
    if n - oos_start < 300:
        if log:
            log(f"xs research [{name}]: not enough OOS bars, rejecting")
        return None
    rets_full = portfolio_backtest(candles_map, pos_full, common_full,
                                   fee_bps, slip_bps)
    oos = rets_full[oos_start:]
    eq = np.cumprod(1.0 + oos)
    st = metrics.summarize(oos, eq, bpy, n_trials=XS_TOTAL_TRIALS)

    edges = np.linspace(0, len(oos), n_folds + 1).astype(int)
    fold_sh = [metrics.sharpe(oos[a + (12 if a else 0):b], bpy)
               for a, b in zip(edges[:-1], edges[1:]) if b - a > 50]
    positive = sum(1 for s in fold_sh if s > 0)
    consistent = positive >= (len(fold_sh) // 2 + 1) if fold_sh else False
    st["oos_folds_positive"] = f"{positive}/{len(fold_sh)}"

    verdict = (st["sharpe"] >= min_oos_sharpe and st["dsr"] >= min_dsr
               and st["max_drawdown"] <= max_oos_drawdown and consistent)
    if log:
        log(f"xs OOS [{name}]: {params} sharpe={st['sharpe']:.2f} "
            f"dsr={st['dsr']:.3f} mdd={st['max_drawdown']:.1%} "
            f"folds+={st['oos_folds_positive']} "
            f"-> {'DEPLOY' if verdict else 'reject'}")
    if not verdict:
        return None

    genome = Genome(signal=name, params=dict(params),
                    vol_target=0.15, max_lev=1.0)
    return ValidatedStrategy(genome=genome, inst=XS_INST, bar=bar,
                             is_stats={"sharpe": best[0]}, oos_stats=st)


def research_xs(
    candles_map: dict[str, Candles],
    fee_bps: float,
    slip_bps: float,
    is_fraction: float = 0.7,
    embargo_bars: int = 24,
    min_oos_sharpe: float = 0.5,
    min_dsr: float = 0.5,
    max_oos_drawdown: float = 0.35,
    n_folds: int = 3,
    log=None,
    leader: str | None = None,
) -> list[ValidatedStrategy]:
    """Run every XS family through the gate; return the survivors."""
    if len(candles_map) < 4:
        if log:
            log("xs research: needs >= 4 instruments, skipping")
        return []
    out: list[ValidatedStrategy] = []
    for name, kind, grid, needs in XS_FAMILIES:
        data = _trim_to_coverage(candles_map, needs, log) if needs else candles_map
        if data is None:
            continue
        if kind == "lead" and (not leader or leader not in candles_map):
            if log:
                log("xs research [xs_lead]: leader unavailable, skipping")
            continue
        s = _validate_family(name, kind, grid, data, fee_bps, slip_bps,
                             is_fraction, embargo_bars, min_oos_sharpe,
                             min_dsr, max_oos_drawdown, n_folds, log,
                             leader=leader)
        if s is not None:
            out.append(s)
    return out
