"""Panel research: one rule, every instrument, one verdict.

The per-instrument search asks "does rsi_rev with THESE parameters work on
ATOM?". Measured honestly, that question is close to unanswerable. Searching
~2,400 genomes over ATOM's 21,000 out-of-sample bars, selection alone reaches
an annualised Sharpe of 4.5, so a genuine per-instrument edge of Sharpe 1 or
2 cannot clear its own bar — and the search runs again on every instrument,
so the book fills with whichever names drew the luckiest noise. That is
precisely what the live registry looked like.

Asking "does rsi_rev with these parameters work ACROSS the universe?" is a
different question with much better statistics, and it is the question worth
asking anyway:

  * One grid for the whole universe instead of one search per name. Thirty
    instruments stop multiplying the trial count by thirty.
  * The scored series is a portfolio of thirty positions rather than one, so
    a per-instrument edge of Sharpe 1 shows up near sqrt(30) larger while
    the selection bar stays where it was.
  * An edge that survives on forty names at once is hard to explain as luck.
    An edge found on one name usually is luck, and this is the structural
    reason the deflated Sharpe kept saying so.

The rule is uniform: identical parameters everywhere, no per-instrument
tuning, positions sized by inverse realised volatility so no single name
dominates the book. The same gates apply — OOS Sharpe, DSR against the whole
grid, drawdown, purged fold consistency — on the pooled record.

One caveat worth stating plainly. Each gate in this system charges the
search that competed for its own selection: a per-instrument survivor is
charged that instrument's ~2,400 genomes, and a panel survivor is charged
this grid. A stricter reading would charge every survivor the whole pass,
since they all end up in one book and a person choosing between them saw
all of it. That would raise every bar again. The convention here is the
looser of the two, deliberately and visibly.
"""

from __future__ import annotations

import numpy as np

from ..backtest import metrics
from ..data.store import BARS_PER_YEAR, Candles
from ..strategy.genome import Genome
from ..strategy.signals import compute_position
from ..strategy.xs import align_universe, portfolio_backtest
from .validate import (ValidatedStrategy, near_miss,
                       window_supports_validation)

PANEL_INST = "PANEL"

# Realised-vol lookback for the inverse-vol weights, in bars.
VOL_LOOKBACK = 96


def _inverse_vol_weights(candles_map: dict[str, Candles],
                         idx: dict[str, np.ndarray], n: int
                         ) -> dict[str, np.ndarray]:
    """Causal inverse-realised-vol weight per instrument, normalised to sum
    to 1 across the book at every bar.

    Without this a 15% vol name and a 150% vol name enter the panel with the
    same notional and the book becomes a bet on the noisiest member. The
    weights use only volatility known at the bar being weighted.
    """
    inv: dict[str, np.ndarray] = {}
    for inst, c in candles_map.items():
        px = c.c[idx[inst]]
        ret = np.zeros(n)
        ret[1:] = px[1:] / px[:-1] - 1.0
        # causal rolling std: cumulative sums shifted by one bar
        sq = np.concatenate(([0.0], np.cumsum(ret * ret)))
        lo = np.maximum(np.arange(n) - VOL_LOOKBACK, 0)
        cnt = np.arange(n) - lo
        var = np.where(cnt > 0, (sq[np.arange(n)] - sq[lo]) / np.maximum(cnt, 1), 0.0)
        vol = np.sqrt(np.maximum(var, 0.0))
        inv[inst] = np.where(vol > 1e-9, 1.0 / np.maximum(vol, 1e-9), 0.0)
    total = np.zeros(n)
    for v in inv.values():
        total += v
    return {inst: np.where(total > 1e-12, v / np.maximum(total, 1e-12), 0.0)
            for inst, v in inv.items()}


def panel_positions(candles_map: dict[str, Candles], genome: Genome
                    ) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Apply one genome to every instrument; return (common grid, positions).

    Positions are computed on each instrument's own full history so warm-up
    matches live behaviour, then sampled onto the shared grid.
    """
    if len(candles_map) < 2:
        return np.array([]), {}
    common, idx = align_universe(candles_map)
    n = len(common)
    if n < 2:
        return np.array([]), {}
    raw: dict[str, np.ndarray] = {}
    for inst, c in candles_map.items():
        try:
            pos = compute_position(c, genome, None)
        except Exception:
            continue
        if pos is None or len(pos) != len(c):
            continue
        raw[inst] = pos[idx[inst]]
    if len(raw) < 2:
        return np.array([]), {}
    w = _inverse_vol_weights({i: candles_map[i] for i in raw}, idx, n)
    return common, {inst: p * w[inst] for inst, p in raw.items()}


def panel_grid(seed: int | None = None) -> list[Genome]:
    """A fixed, small grid of universe-wide rules.

    Deliberately not an evolutionary search. The selection bar is set by the
    number of rules tried, so a 2,400-genome hunt would raise it past what a
    pooled edge can clear and undo the reason for pooling in the first
    place. Coarse, well-separated parameters across the families whose
    inputs exist over the full history: enough to find a shared effect if
    one is there, few enough that finding it means something.

    `seed` is accepted for interface symmetry with the evolutionary search
    and deliberately unused — a fixed grid is the point.
    """
    del seed
    out: list[Genome] = []
    for lb in (24, 96, 384):
        for db in (0.0, 0.5):
            out.append(Genome(signal="tsmom",
                              params={"lookback": lb, "deadband": db},
                              vol_target=0.20, max_lev=1.0))
    for lb in (24, 96, 384):
        for z in (1.0, 2.0):
            out.append(Genome(signal="meanrev",
                              params={"lookback": lb, "entry_z": z},
                              vol_target=0.20, max_lev=1.0))
    for lb in (20, 80, 300):
        out.append(Genome(signal="breakout", params={"lookback": lb},
                          vol_target=0.20, max_lev=1.0))
    for lb in (14, 48):
        for low in (20.0, 30.0):
            out.append(Genome(signal="rsi_rev",
                              params={"lookback": lb, "low": low,
                                      "high_gap": 100.0 - low},
                              vol_target=0.20, max_lev=1.0))
    for lb in (48, 192):
        for th in (0.0001, 0.0003):
            out.append(Genome(signal="funding_carry",
                              params={"lookback": lb, "threshold": th},
                              vol_target=0.20, max_lev=1.0))
    return out


def choose_panel_universe(candles_map: dict[str, Candles], min_insts: int = 4
                          ) -> dict[str, Candles]:
    """Pick the subset that maximises pooled observations.

    The common grid is the intersection of every member's timestamps, so one
    instrument listed last month truncates the panel to last month. With a
    universe refreshed by traded value that is not a corner case — new
    perpetuals list constantly and rank well on volume.

    Both terms matter and they trade against each other: more instruments
    lift a shared edge by sqrt(N), more bars lower the selection bar. Their
    product is the pooled observation count, so instruments are added
    youngest-last and the cut is taken where instruments x common bars peaks.
    Dropping a name that halves the window is then automatic rather than a
    threshold someone has to guess.
    """
    if len(candles_map) <= min_insts:
        return dict(candles_map)
    by_start = sorted(candles_map.items(),
                      key=lambda kv: int(kv[1].ts[0]) if len(kv[1].ts) else 0)
    end = min(int(c.ts[-1]) for _, c in by_start if len(c.ts))
    best, best_score = None, -1.0
    for k in range(min_insts, len(by_start) + 1):
        start = int(by_start[k - 1][1].ts[0])
        bars = max(0, end - start)
        score = k * bars
        if score > best_score:
            best_score, best = score, k
    keep = dict(by_start[:best or len(by_start)])
    return keep


def research_panel(
    candles_map: dict[str, Candles],
    grid: list[Genome],
    fee_bps: float,
    slip_bps: float,
    is_fraction: float = 0.7,
    embargo_bars: int = 24,
    min_oos_sharpe: float = 0.5,
    min_dsr: float = 0.5,
    max_oos_drawdown: float = 0.35,
    n_folds: int = 3,
    max_deployed: int = 4,
    max_corr: float = 0.9,
    max_selection_bar: float = 10.0,
    misses: list | None = None,
    log=None,
) -> list[ValidatedStrategy]:
    """Search `grid` in-sample on the panel, validate the best per family."""
    if len(candles_map) < 4 or not grid:
        if log:
            log("panel research: needs >= 4 instruments and a grid, skipping")
        return []
    dropped = len(candles_map)
    candles_map = choose_panel_universe(candles_map)
    dropped -= len(candles_map)
    insts = sorted(candles_map)
    bar = candles_map[insts[0]].bar
    bpy = BARS_PER_YEAR[bar]
    ref = candles_map[insts[0]]

    # the scored window is the shared grid, not the longest member's history
    common_all, _ = align_universe(candles_map)
    n_common = len(common_all)
    if log:
        log(f"panel research: {len(insts)} instruments over {n_common} shared "
            f"bars" + (f" ({dropped} dropped as too recent)" if dropped else ""))

    ok, need = window_supports_validation(
        n_oos=int(n_common * (1.0 - is_fraction)), n_trials=len(grid),
        bars_per_year=bpy, max_bar=max_selection_bar)
    if not ok:
        if log:
            log(f"panel research: {int(n_common * (1 - is_fraction))} scored "
                f"bars against the {need} a {len(grid)}-rule grid needs — "
                f"skipping")
        return []

    def slice_map(a: float, b: float) -> dict[str, Candles]:
        return {i: c.slice(int(len(c) * a), int(len(c) * b))
                for i, c in candles_map.items()}

    # ---- in-sample: best rule per signal family -------------------------
    is_map = slice_map(0.0, is_fraction)
    best: dict[str, tuple[float, Genome]] = {}
    for g in grid:
        common, pos = panel_positions(is_map, g)
        if not pos:
            continue
        rets = portfolio_backtest(is_map, pos, common, fee_bps, slip_bps)
        sh = metrics.sharpe(rets, bpy)
        if log:
            log(f"panel IS [{g.signal}]: {g.describe()} sharpe={sh:.2f}")
        if g.signal not in best or sh > best[g.signal][0]:
            best[g.signal] = (sh, g)

    # ---- out-of-sample, embargoed, warm-started -------------------------
    out: list[ValidatedStrategy] = []
    accepted: list[np.ndarray] = []
    for signal, (is_sh, g) in sorted(best.items(), key=lambda kv: -kv[1][0]):
        if len(out) >= max_deployed:
            break
        if is_sh <= 0:
            if log:
                log(f"panel research [{signal}]: nothing profitable in-sample")
            continue
        common, pos = panel_positions(candles_map, g)
        if not pos:
            continue
        is_cut_ts = common_all[int(n_common * is_fraction)]
        start = int(np.searchsorted(common, is_cut_ts)) + embargo_bars
        if len(common) - start < 300:
            if log:
                log(f"panel research [{signal}]: not enough OOS bars")
            continue
        rets = portfolio_backtest(candles_map, pos, common, fee_bps, slip_bps)
        oos = rets[start:]
        eq = np.cumprod(1.0 + oos)
        # the whole grid is charged, not this family's slice of it: the best
        # rule was picked after seeing every rule's in-sample score
        st = metrics.summarize(oos, eq, bpy, n_trials=len(grid))

        edges = np.linspace(0, len(oos), n_folds + 1).astype(int)
        fold_sh = [metrics.sharpe(oos[a + (12 if a else 0):b], bpy)
                   for a, b in zip(edges[:-1], edges[1:]) if b - a > 50]
        positive = sum(1 for s in fold_sh if s > 0)
        consistent = positive >= (len(fold_sh) // 2 + 1) if fold_sh else False
        st["oos_folds_positive"] = f"{positive}/{len(fold_sh)}"
        st["panel_instruments"] = len(pos)

        verdict = (st["sharpe"] >= min_oos_sharpe and st["dsr"] >= min_dsr
                   and st["max_drawdown"] <= max_oos_drawdown and consistent)
        clone_r = 0.0
        for prev in accepted:
            if len(prev) == len(oos) and float(np.std(prev)) > 1e-12 \
                    and float(np.std(oos)) > 1e-12:
                clone_r = max(clone_r, abs(float(np.corrcoef(oos, prev)[0, 1])))
        st["max_corr_to_book"] = clone_r
        distinct = clone_r < max_corr
        if log:
            log(f"panel OOS [{signal}]: {g.describe()} "
                f"sharpe={st['sharpe']:.2f} vs bar "
                f"{st.get('selection_bar', 0.0):.2f} dsr={st['dsr']:.3f} "
                f"mdd={st['max_drawdown']:.1%} "
                f"folds+={st['oos_folds_positive']} "
                f"on {len(pos)} instruments -> "
                f"{'DEPLOY' if verdict and distinct else 'reject'}")
        if verdict and distinct:
            out.append(ValidatedStrategy(genome=g, inst=PANEL_INST, bar=bar,
                                         is_stats={"sharpe": is_sh},
                                         oos_stats=st))
            accepted.append(oos)
        elif misses is not None:
            misses.append(near_miss(f"panel {signal}", st, min_oos_sharpe,
                                    min_dsr, max_oos_drawdown, consistent,
                                    clone_r, max_corr))
    return out
