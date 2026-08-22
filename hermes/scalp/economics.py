"""What a bracket is worth before it is armed.

A take-profit/stop-loss pair is not a preference, it is a bet with a
computable expectation. The shipped defaults took profit at 10bps and
stopped at 15bps against a 7bps round trip, which asks the predictor for an
88% win rate — and the volatility floors could arm a 6bps take against that
same 7bps cost, a "winning" trade that books a loss.

The textbook barrier formula is not good enough to fix that. It answers
"which barrier is hit first, ever", and a scalp has a time-stop. Measured
against simulation at a 3-bar horizon it overstates the expected value four
to sixfold, and at wide barriers it is not merely optimistic but backwards:
it reports a 97.9% win rate where the truth is 4.3%, because the barrier is
almost never reached before the clock runs out.

So the bracket is chosen against the payoff that actually occurs — barriers,
time-stop and costs — evaluated on simulated paths drawn from the forecast.
The paths are standard normals generated once per horizon and reused for
every candidate and every instrument, which makes the comparison between
candidates exact rather than noisy, and the whole search a few milliseconds.

Simulated paths are watched at discrete points while the live engine checks
its brackets on every tick, so a simulated path misses crossings that a real
one would catch. Left uncorrected that is not a rounding error: at zero edge
every bracket must be worth exactly minus the round trip, and a 6/30 pair
scored -9.9bps instead of -7.0. The Broadie-Glasserman-Kou continuity
correction — pull the tested barrier in by 0.5826·σ·√Δt — brings every
geometry within 0.1bps of the theorem at four sub-steps per bar.
"""

from __future__ import annotations

import math

import numpy as np

# Paths are shared across candidates so that differences in expected value
# reflect the barriers rather than the draw. Fixed seed: the same forecast
# must always produce the same bracket.
N_PATHS = 16_384
_SEED = 12345
_UNIT: dict[tuple[int, int], np.ndarray] = {}

# Sub-steps per bar, and the continuity correction that makes discrete
# monitoring behave like the tick-by-tick monitoring the engine performs.
SUBSTEPS = 4
BETA = 0.5826   # -zeta(1/2)/sqrt(2*pi)

# Grids are in units of the move the forecast predicts. Fixed and coarse on
# purpose: these are not parameters fitted to data, so they cannot be
# overfitted to it.
TP_GRID = (0.4, 0.6, 0.8, 1.0, 1.3, 1.7, 2.2)
SL_GRID = (0.4, 0.6, 0.8, 1.0, 1.4, 2.0, 2.6)


def _unit_paths(horizon: int, n_paths: int = N_PATHS) -> np.ndarray:
    """Cumulative standard normals in sub-step units: (n_paths, horizon*SUBSTEPS)."""
    key = (int(horizon), int(n_paths))
    cached = _UNIT.get(key)
    if cached is None:
        rng = np.random.default_rng(_SEED)
        m = int(horizon) * SUBSTEPS
        cached = rng.standard_normal((n_paths, m)).cumsum(axis=1)
        _UNIT[key] = cached
    return cached


def _simulate(tp: float, sl: float, edge_bps: float, vol_bps: float,
              horizon: int, n_paths: int) -> np.ndarray:
    """Realised PnL per path, in bps, before costs."""
    h = max(int(horizon), 1)
    m = h * SUBSTEPS
    step_sigma = max(float(vol_bps), 1e-9) / math.sqrt(SUBSTEPS)
    paths = _unit_paths(h, n_paths) * step_sigma
    paths = paths + np.arange(1, m + 1, dtype=np.float64) * (float(edge_bps) / m)
    shift = BETA * step_sigma
    tp_e, sl_e = max(tp - shift, 1e-9), max(sl - shift, 1e-9)
    up, dn = paths >= tp_e, paths <= -sl_e
    t_up = np.where(up.any(axis=1), up.argmax(axis=1), m + 1)
    t_dn = np.where(dn.any(axis=1), dn.argmax(axis=1), m + 1)
    return np.where(t_up < t_dn, tp, np.where(t_dn < t_up, -sl, paths[:, -1]))


def bracket_ev(tp_bps: float, sl_bps: float, edge_bps: float, vol_bps: float,
               horizon: int, cost_bps: float, n_paths: int = N_PATHS) -> float:
    """Expected value in bps of notional, net of the round trip.

    The trade ends at whichever comes first: the take, the stop, or the
    horizon. A path that ends on the clock is marked out at wherever it
    happens to be — which is what a time-stop does, and what the closed-form
    barrier probability cannot express.
    """
    tp, sl = float(tp_bps), float(sl_bps)
    if tp <= 0 or sl <= 0:
        return -float("inf")
    pnl = _simulate(tp, sl, float(edge_bps), vol_bps, horizon, n_paths)
    return float(pnl.mean() - float(cost_bps))


def win_rate(tp_bps: float, sl_bps: float, edge_bps: float, vol_bps: float,
             horizon: int, cost_bps: float = 0.0,
             n_paths: int = N_PATHS) -> float:
    """Share of paths that end profitable after costs — the honest win rate."""
    pnl = _simulate(float(tp_bps), float(sl_bps), float(edge_bps), vol_bps,
                    horizon, n_paths)
    return float((pnl > float(cost_bps)).mean())


def kelly_fraction(tp_bps: float, sl_bps: float, edge_bps: float,
                   vol_bps: float, horizon: int, cost_bps: float,
                   n_paths: int = N_PATHS) -> float:
    """Growth-optimal notional/equity for this bracket — quarter-Kelly.

    The same simulation that priced the bracket carries its whole net PnL
    distribution, so the Kelly fraction needs no binomial approximation:
    f* = E[R] / E[R^2] maximises expected log growth for the small, bounded
    returns a bracket produces (exact to O(f^3), and R is capped by the
    stop). A quarter of f* is kept — the classic haircut for the fact that
    E[R] is an estimate, and estimated edges are biased upward by the very
    selection that surfaced them. Zero when the bracket loses money.
    """
    pnl = _simulate(float(tp_bps), float(sl_bps), float(edge_bps),
                    float(vol_bps), horizon, n_paths)
    r = (pnl - float(cost_bps)) * 1e-4
    mu = float(r.mean())
    m2 = float((r * r).mean())
    if mu <= 0.0 or m2 <= 0.0:
        return 0.0
    return 0.25 * mu / m2


def choose_bracket(edge_bps: float, vol_bps: float, horizon: int,
                   cost_bps: float, min_ev_bps: float | None = None
                   ) -> tuple[float, float, float] | None:
    """Best (take, stop, expected value) for this forecast, or None.

    None is the honest answer far more often than the shipped code allowed:
    a forecast smaller than the round trip has no bracket that pays, and no
    choice of barriers can rescue it.

    `min_ev_bps` defaults to a quarter of the round trip — a bracket has to
    beat its own friction by a visible margin, not tie with it.
    """
    cost = float(cost_bps)
    floor = cost * 0.25 if min_ev_bps is None else float(min_ev_bps)
    mag = abs(float(edge_bps))
    if mag <= 0.0:
        return None

    best: tuple[float, float, float] | None = None
    for tm in TP_GRID:
        tp = mag * tm
        # A take that does not clear the round trip cannot pay, however
        # often it is reached.
        if tp <= cost:
            continue
        for sm in SL_GRID:
            sl = mag * sm
            ev = bracket_ev(tp, sl, mag, vol_bps, horizon, cost)
            if best is None or ev > best[2]:
                best = (tp, sl, ev)
    if best is None or best[2] <= floor:
        return None
    return best


def viable_horizon(cost_bps: float, ic: float, vol_bps_per_bar: float) -> int:
    """Shortest horizon whose captured move can outrun the round trip.

    The move available over h bars grows as vol·√h while the cost stays
    flat, and a forecast with information coefficient `ic` captures roughly
    that fraction of it. Setting ic·vol·√h = cost gives the horizon below
    which trading is arithmetic rather than skill:

        h = (cost / (ic · vol))²

    At one minute, with a 9bps bar and a 7bps round trip, this asks a
    forecast to capture 78% of the entire bar — which is why a 1m book that
    respects its own cost gate never fires.
    """
    ic = abs(float(ic))
    vol = abs(float(vol_bps_per_bar))
    if ic <= 1e-9 or vol <= 1e-9:
        return 10 ** 9
    return max(1, math.ceil((float(cost_bps) / (ic * vol)) ** 2))


def required_ic(cost_bps: float, horizon: int, vol_bps_per_bar: float) -> float:
    """Forecast skill this horizon needs before trading it can pay.

    The inverse of `viable_horizon`, and the more useful direction in a live
    report: the horizon is given, so the question is what skill it demands.
    A book sitting flat is answering this — it is not broken, it is refusing
    a bet whose odds it can state.
    """
    vol = abs(float(vol_bps_per_bar))
    h = max(int(horizon), 1)
    if vol <= 1e-9:
        return float("inf")
    return float(cost_bps) / (vol * math.sqrt(h))
