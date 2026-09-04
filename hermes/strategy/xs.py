"""Cross-sectional portfolio strategies — hedge-fund-style market-neutral
books spanning the whole universe, as opposed to the per-instrument genomes.

Three families, one construction. Each ranks the universe by a score,
longs the top of the ranking and shorts the bottom, dollar-neutral,
inverse-vol weighted, per-name capped and portfolio-vol targeted. Market
direction cancels out; only the cross-sectional spread is harvested.

  funding_xs (carry) — perpetual funding is paid by the crowded side.
      Short the richest-funding names, long the cheapest: collects the
      structural funding spread.
  xs_mom (momentum) — winners keep winning over multi-week horizons.
      Long the strongest vol-adjusted past returns, short the weakest,
      with a one-day gap to dodge short-term reversal.
  xs_rev (reversal) — idiosyncratic hourly/daily shocks mean-revert.
      Long the short-horizon losers, short the winners: classic
      stat-arb reversal.

Strictly causal: positions at bar t use information up to t only.
"""

from __future__ import annotations

import numpy as np

from .. import features as F
from ..data.store import BARS_PER_YEAR, Candles

# parameter grids searched by the XS research gate (small on purpose: few
# trials keep the deflated-Sharpe penalty low and the strategy honest).
# Lookbacks are defined in HOURS and converted to bars for the panel's bar,
# so the same economic horizons are searched whatever the data frequency.
_GRID_HOURS = {
    "carry": (24, 72, 168),        # funding EWMA: 1d / 3d / 1w
    "mom":   (168, 336, 672, 1344, 2016),   # 1 / 2 / 4 / 8 / 12 weeks
    "rev":   (4, 12, 24),          # 4h / 12h / 1d
    "lead":  (2, 4, 8),            # leader-move window
    "basis": (12, 24, 48),
    "flow":  (4, 12, 24),
    "crowd": (4, 12, 24),
}
_MAX_W = (0.15, 0.25)


def bars_per_hour(bar: str) -> float:
    from ..data.store import BAR_MS
    return 3_600_000.0 / BAR_MS[bar]


def hours_to_bars(hours: float, bar: str) -> int:
    return max(1, int(round(hours * bars_per_hour(bar))))


def xs_grid(kind: str, bar: str = "15m") -> list[dict]:
    return [{"lookback": hours_to_bars(h, bar), "max_w": mw}
            for h in _GRID_HOURS[kind] for mw in _MAX_W]


# legacy names (15m grids) kept for existing imports/tests
XS_GRID = xs_grid("carry", "15m")
XS_MOM_GRID = xs_grid("mom", "15m")
XS_REV_GRID = xs_grid("rev", "15m")
XS_LEAD_GRID = xs_grid("lead", "15m")
XS_BASIS_GRID = xs_grid("basis", "15m")
XS_FLOW_GRID = xs_grid("flow", "15m")
XS_CROWD_GRID = xs_grid("crowd", "15m")

# trailing window (hours) for estimating each name's lead-lag beta to the
# universe leader's previous-bar return (fixed a priori, not searched)
LEAD_BETA_HOURS = 500
LEAD_BETA_WINDOW = 2000   # legacy constant (15m bars)

# realised-vol / portfolio-vol estimation window, hours
VOL_WINDOW_HOURS = 24

# skip the most recent day when ranking momentum (dodges 1-day reversal)
MOM_SKIP_FRAC = 0.05

# no-trade band, as a fraction of the per-name cap: a position only moves
# when its target drifts at least this far from what is held. Chosen a
# priori (NOT searched) — it exists to tame turnover costs, identically for
# every family, and adds zero trials to the deflated-Sharpe penalty.
REBALANCE_BAND_FRAC = 0.25

# genome signal name -> scoring kind
XS_KINDS = {"funding_xs": "carry", "xs_mom": "mom", "xs_rev": "rev",
            "xs_lead": "lead", "xs_basis": "basis", "xs_flow": "flow",
            "xs_crowd": "crowd"}


def align_universe(candles_map: dict[str, Candles]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Master timestamp grid (UNION of every instrument's bars) and, per
    instrument, the master-grid index of each of its own bars. A name that
    listed late is simply absent before its first bar — the book is built
    from whoever is present, instead of throwing away every bar before the
    newest listing."""
    insts = list(candles_map)
    common = np.unique(np.concatenate([candles_map[i].ts for i in insts]))
    idx = {inst: np.searchsorted(common, candles_map[inst].ts) for inst in insts}
    return common, idx


def _place(series: np.ndarray, ix: np.ndarray, n: int, fill: float = np.nan) -> np.ndarray:
    out = np.full(n, fill)
    out[ix] = series
    return out


def _scores(kind: str, candles: Candles, rv: np.ndarray, lb: int) -> np.ndarray:
    """Causal per-instrument score series; higher score -> more attractive
    LONG for mom, more attractive SHORT for carry/rev/basis/flow/crowd
    (sign applied later)."""
    c, funding = candles.c, candles.funding
    n = len(c)
    if kind == "carry":
        return F.ewma_funding(funding, lb)
    if kind == "basis":
        return F.ema(candles.basis, lb)
    if kind == "flow":
        return F.ema(candles.taker_imb, lb)
    if kind == "crowd":
        oi = candles.oi
        dlog = np.zeros(n)
        if n > 1:
            with np.errstate(invalid="ignore", divide="ignore"):
                dlog[1:] = np.diff(oi) / np.where(oi[:-1] > 1e-9, oi[:-1], np.nan)
        ret = F.lookback_return(c, max(int(lb), 1))
        return np.nan_to_num(dlog * np.sign(ret), nan=0.0)
    if kind == "mom":
        skip = max(1, int(lb * MOM_SKIP_FRAC))
        s = np.zeros(n)
        if lb >= n:
            return s          # window longer than history: no signal
        s[lb:] = c[lb - skip:n - skip] / c[:n - lb] - 1.0
        # vol-adjust so one crazy name doesn't own the ranking
        with np.errstate(invalid="ignore", divide="ignore"):
            s = s / np.where(rv > 0.05, rv, np.nan)
        return np.nan_to_num(s, nan=0.0)
    if kind == "rev":
        s = np.zeros(n)
        if lb >= n:
            return s
        s[lb:] = c[lb:] / c[:-lb] - 1.0
        with np.errstate(invalid="ignore", divide="ignore"):
            s = s / np.where(rv > 0.05, rv, np.nan)
        return np.nan_to_num(s, nan=0.0)
    raise ValueError(f"unknown xs kind: {kind}")


def _lead_scores(candles_map: dict[str, Candles], insts: list[str],
                 idx: dict[str, np.ndarray], n: int, lb: int,
                 leader: str, bar: str = "15m") -> np.ndarray | None:
    """Follow-the-leader continuation: each name's score is its causally
    estimated beta to the LEADER's previous-bar return, times the leader's
    recent move. High-beta laggards go long after the leader rallies (they
    tend to catch up), low-beta names fund the short side. Cross-sectional
    demeaning cannot wash this out because the betas differ per name."""
    if not leader or leader not in candles_map:
        return None
    lc = _place(candles_map[leader].c, idx[leader], n, np.nan)
    lc = np.where(np.isnan(lc), np.nanmean(lc), lc)   # leader is the longest history anyway
    lret = np.zeros(n)
    lret[1:] = lc[1:] / lc[:-1] - 1.0
    # leader's recent move over lb bars, scaled by its own typical move
    L = np.zeros(n)
    if lb >= n:
        return None
    L[lb:] = lc[lb:] / lc[:-lb] - 1.0
    lsd = F.rolling_std(lret, hours_to_bars(VOL_WINDOW_HOURS, bar)) * np.sqrt(lb)
    with np.errstate(invalid="ignore", divide="ignore"):
        L = L / np.where(lsd > 1e-9, lsd, np.nan)
    L = np.clip(np.nan_to_num(L, nan=0.0), -3.0, 3.0)

    x = np.concatenate(([0.0], lret[:-1]))          # leader ret, lagged 1 bar
    W = hours_to_bars(LEAD_BETA_HOURS, bar)
    cs_xx = np.cumsum(x * x)
    smat = np.zeros((len(insts), n))
    for k, inst in enumerate(insts):
        y = _place(candles_map[inst].returns, idx[inst], n, 0.0)
        cs_xy = np.cumsum(x * y)
        sxy = cs_xy.copy()
        sxx = cs_xx.copy()
        sxy[W:] = cs_xy[W:] - cs_xy[:-W]
        sxx[W:] = cs_xx[W:] - cs_xx[:-W]
        with np.errstate(invalid="ignore", divide="ignore"):
            beta = sxy / np.where(sxx > 1e-12, sxx, np.nan)
        beta = np.clip(np.nan_to_num(beta, nan=0.0), -3.0, 3.0)
        smat[k] = beta * L
    return smat


def xs_positions(
    candles_map: dict[str, Candles],
    params: dict,
    kind: str = "carry",
    vol_target: float = 0.15,
    leader: str | None = None,
) -> tuple[np.ndarray, list[str], dict[str, np.ndarray]]:
    """Returns (common_ts, insts, {inst: pos array on the common grid}).

    pos[i] is the exposure decided at the close of common bar i. The book is
    dollar-neutral (weights sum to ~0) and inverse-vol scaled, with per-name
    weights capped at params["max_w"].
    """
    insts = sorted(candles_map)
    if len(insts) < 4:
        return np.array([], dtype=np.int64), insts, {}
    common, idx = align_universe(candles_map)
    n = len(common)
    if n < 500:
        return common, insts, {}

    lb = int(params["lookback"])
    max_w = float(params["max_w"])
    bar = candles_map[insts[0]].bar
    bpy = BARS_PER_YEAR[bar]

    vw = hours_to_bars(VOL_WINDOW_HOURS, bar)
    vmat = np.zeros((len(insts), n))
    present = np.zeros((len(insts), n), dtype=bool)
    for k, inst in enumerate(insts):
        c = candles_map[inst]
        rv = F.realized_vol(c.c, w=vw, bars_per_year=bpy)
        vmat[k] = _place(np.nan_to_num(rv, nan=0.0), idx[inst], n, 0.0)
        present[k, idx[inst]] = True
        # a name needs its own warm-up before it can be ranked
        present[k, idx[inst][:min(len(idx[inst]), max(lb, 200))]] = False
    if kind == "lead":
        smat = _lead_scores(candles_map, insts, idx, n, lb, leader, bar)
        if smat is None:
            return common, insts, {}
    else:
        smat = np.zeros((len(insts), n))
        for k, inst in enumerate(insts):
            c = candles_map[inst]
            rv = F.realized_vol(c.c, w=vw, bars_per_year=bpy)
            rv = np.nan_to_num(rv, nan=0.0)
            smat[k] = _place(_scores(kind, c, rv, lb), idx[inst], n, 0.0)
    smat = np.where(present, smat, np.nan)

    # cross-sectional z-score of the raw score at each bar (causal), over
    # the names present at that bar only; fewer than 4 names -> no book
    n_here = present.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mu = np.nanmean(smat, axis=0, keepdims=True)
        sd = np.nanstd(smat, axis=0, keepdims=True)
        z = (smat - mu) / np.where(sd > 1e-12, sd, np.nan)
    z = np.nan_to_num(z, nan=0.0)
    z[:, n_here < 4] = 0.0

    # sign per family: carry & reversal fade the score, momentum and
    # lead-lag continuation follow it
    signed = z if kind in ("mom", "lead") else -z

    # inverse-vol tilt; demean over present names so the book stays
    # dollar-neutral after clipping
    with np.errstate(invalid="ignore", divide="ignore"):
        iv = 1.0 / np.where(vmat > 0.05, vmat, np.nan)
    iv = np.where(present, np.nan_to_num(iv, nan=0.0), 0.0)
    iv_sum = iv.sum(axis=0, keepdims=True)
    iv_mean = np.where(n_here > 0, iv_sum / np.maximum(n_here, 1), 0.0)
    iv = np.where(iv_mean > 0, iv / np.where(iv_mean > 0, iv_mean, 1.0), 0.0)

    raw = signed * iv
    with np.errstate(invalid="ignore", divide="ignore"):
        raw_mean = np.where(n_here > 0, raw.sum(axis=0, keepdims=True) / np.maximum(n_here, 1), 0.0)
    raw = np.where(present, raw - raw_mean, 0.0)
    gross = np.abs(raw).sum(axis=0, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        w = np.where(gross > 1e-9, raw / gross, 0.0)      # gross exposure 1
    w = np.clip(w, -max_w, max_w)

    # portfolio-level vol targeting on the common grid
    port_ret = np.zeros(n)
    rets = np.zeros((len(insts), n))
    for k, inst in enumerate(insts):
        rets[k] = _place(candles_map[inst].returns, idx[inst], n, 0.0)
    port_ret[1:] = np.sum(w[:, :-1] * rets[:, 1:], axis=0)
    pvol = F.rolling_std(port_ret, vw) * np.sqrt(bpy)
    with np.errstate(invalid="ignore", divide="ignore"):
        scale = vol_target / np.where(pvol > 1e-3, pvol, np.nan)
    scale = np.clip(np.nan_to_num(scale, nan=1.0), 0.0, 3.0)
    w = w * scale[None, :]

    # warm-up guard (lead-lag also needs its beta-estimation window)
    warm = max(lb, 200, hours_to_bars(LEAD_BETA_HOURS, bar) if kind == "lead" else 0)
    w[:, :warm] = 0.0

    # no-trade band (hysteresis): hold the current position until the target
    # drifts at least band away — kills the per-bar churn that lets costs
    # eat high-frequency families alive, without touching the signal itself
    band = REBALANCE_BAND_FRAC * max_w
    held = np.zeros(len(insts))
    out = np.empty_like(w)
    for t in range(n):
        tgt = w[:, t]
        move = np.abs(tgt - held) >= band
        held = np.where(move, tgt, held)
        out[:, t] = held
    return common, insts, {inst: out[k] for k, inst in enumerate(insts)}


def funding_xs_positions(
    candles_map: dict[str, Candles],
    params: dict,
    vol_target: float = 0.15,
) -> tuple[np.ndarray, list[str], dict[str, np.ndarray]]:
    """Backward-compatible wrapper: the carry book."""
    return xs_positions(candles_map, params, kind="carry", vol_target=vol_target)


def portfolio_backtest(
    candles_map: dict[str, Candles],
    pos_map: dict[str, np.ndarray],
    common: np.ndarray,
    fee_bps: float,
    slip_bps: float,
) -> np.ndarray:
    """Per-bar portfolio returns on the common grid (fees + funding included)."""
    insts = sorted(candles_map)
    _, idx = align_universe(candles_map)
    n = len(common)
    cost_rate = (fee_bps + slip_bps) * 1e-4
    total = np.zeros(n)
    for inst in insts:
        pos = pos_map.get(inst)
        if pos is None or not len(pos):
            continue
        ret = _place(candles_map[inst].returns, idx[inst], n, 0.0)
        fnd = _place(candles_map[inst].funding, idx[inst], n, 0.0)
        prev = np.concatenate(([0.0], pos[:-1]))
        total += prev * ret - np.abs(pos - prev) * cost_rate - prev * fnd
    return np.clip(total, -0.95, 10.0)
