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
from ..strategy.xs import portfolio_backtest, xs_grid, xs_positions
from .validate import ValidatedStrategy

XS_INST = "XS-PORTFOLIO"

# (genome signal name, scoring kind, required extra series or None)
XS_FAMILIES = [
    ("funding_xs", "carry", "funding"),
    ("xs_mom", "mom", None),
    ("xs_rev", "rev", None),
    ("xs_lead", "lead", None),
    ("xs_basis", "basis", "basis"),
    ("xs_flow", "flow", "flow"),
    ("xs_crowd", "crowd", "oi"),
]

# families searched by default: the ones whose input series cover the whole
# candle history. Basis / taker-flow / open-interest only exist for the last
# ~180 days on OKX, far too short to validate anything; they can be enabled
# in config once enough history has accumulated.
DEFAULT_XS_FAMILIES = ("funding_xs", "xs_mom", "xs_rev", "xs_lead")

XS_TOTAL_TRIALS = sum(len(xs_grid(k, "15m")) for _, k, _ in XS_FAMILIES)


def xs_total_trials(families, bar: str) -> int:
    fam = set(families)
    return sum(len(xs_grid(k, bar)) for name, k, _ in XS_FAMILIES if name in fam)


def _trim_to_need(candles_map: dict[str, Candles], need: str, log=None
                  ) -> dict[str, Candles] | None:
    """Keep the window where `need` actually has data (funding, basis, flow, oi)."""
    attr = {"funding": "funding", "basis": "basis", "flow": "taker_imb",
            "oi": "oi"}[need]
    starts, covered = [], {}
    for inst in sorted(candles_map):
        c = candles_map[inst]
        series = np.asarray(getattr(c, attr))
        nz = np.nonzero(np.abs(series) > 1e-12)[0]
        if not len(nz):
            if log:
                log(f"xs research: {inst} has no {need} history, dropping")
            continue
        covered[inst] = c
        starts.append(c.ts[nz[0]])
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
    n_trials: int = XS_TOTAL_TRIALS,
    top_n: int | None = None,
    membership_bars: int = 720,
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
    for params in grid:
        common, _, pos = xs_positions(is_map, params, kind=kind, leader=leader,
                                      top_n=top_n, membership_bars=membership_bars)
        if not pos:
            continue
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
                                            leader=leader, top_n=top_n,
                                            membership_bars=membership_bars)
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
    st = metrics.summarize(oos, eq, bpy, n_trials=n_trials)
    st["n_trials_charged"] = n_trials

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
    st["top_n"] = top_n
    return ValidatedStrategy(genome=genome, inst=XS_INST, bar=bar,
                             is_stats={"sharpe": best[0]}, oos_stats=st,
                             oos_rets=oos)


def research_xs(
    candles_map: dict[str, Candles],
    fee_bps: float,
    slip_bps: float,
    is_fraction: float = 0.7,
    embargo_bars: int = 192,
    min_oos_sharpe: float = 0.5,
    min_dsr: float = 0.05,
    max_oos_drawdown: float = 0.35,
    n_folds: int = 3,
    log=None,
    leader: str | None = None,
    families=DEFAULT_XS_FAMILIES,
    top_n: int | None = None,
    membership_bars: int = 720,
) -> list[ValidatedStrategy]:
    """Run the selected XS families through the gate; return the survivors.
    The Deflated Sharpe is charged for every config of every family run."""
    if len(candles_map) < 4:
        if log:
            log("xs research: needs >= 4 instruments, skipping")
        return []
    bar = next(iter(candles_map.values())).bar
    fam = set(families)
    n_trials = max(xs_total_trials(fam, bar), 1)
    out: list[ValidatedStrategy] = []
    for name, kind, need in XS_FAMILIES:
        if name not in fam:
            continue
        grid = xs_grid(kind, bar)
        data = _trim_to_need(candles_map, need, log) if need else candles_map
        if data is None:
            continue
        if kind == "lead" and (not leader or leader not in candles_map):
            if log:
                log("xs research [xs_lead]: leader unavailable, skipping")
            continue
        s = _validate_family(name, kind, grid, data, fee_bps, slip_bps,
                             is_fraction, embargo_bars, min_oos_sharpe,
                             min_dsr, max_oos_drawdown, n_folds, log,
                             leader=leader, n_trials=n_trials, top_n=top_n,
                             membership_bars=membership_bars)
        if s is not None:
            out.append(s)
    return out
