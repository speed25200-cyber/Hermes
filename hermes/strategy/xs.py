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
# trials keep the deflated-Sharpe penalty low and the strategy honest)
XS_GRID = [  # carry (funding_xs)
    {"lookback": lb, "max_w": mw}
    for lb in (100, 200, 400)
    for mw in (0.15, 0.25)
]
XS_MOM_GRID = [  # ~3 weeks / 6 weeks / 12 weeks of 15m bars
    {"lookback": lb, "max_w": mw}
    for lb in (2000, 4000, 8000)
    for mw in (0.15, 0.25)
]
XS_REV_GRID = [  # 4h / 12h / 1 day of 15m bars
    {"lookback": lb, "max_w": mw}
    for lb in (16, 48, 96)
    for mw in (0.15, 0.25)
]
XS_LEAD_GRID = [  # leader-move window: 2h / 4h / 8h of 15m bars
    {"lookback": lb, "max_w": mw}
    for lb in (8, 16, 32)
    for mw in (0.15, 0.25)
]
XS_TAKER_GRID = [  # aggressive-flow window: 4h / 12h / 24h of 15m bars
    {"lookback": lb, "max_w": mw}
    for lb in (16, 48, 96)
    for mw in (0.15, 0.25)
]
XS_OI_GRID = [  # OI-confirmation window: 1 day / 4 days / 2 weeks
    {"lookback": lb, "max_w": mw}
    for lb in (96, 384, 1344)
    for mw in (0.15, 0.25)
]
XS_BASIS_GRID = [  # premium smoothing: 12h / 2 days / 1 week of 15m bars
    {"lookback": lb, "max_w": mw}
    for lb in (48, 192, 672)
    for mw in (0.15, 0.25)
]

# genome signal name -> scoring kind
XS_KINDS = {"funding_xs": "carry", "xs_mom": "mom", "xs_rev": "rev",
            "xs_lead": "lead", "xs_taker": "taker", "xs_oi": "oi",
            "xs_basis": "basis"}

# trailing window (bars) for estimating each name's lead-lag beta to the
# universe leader's previous-bar return (fixed a priori, not searched)
LEAD_BETA_WINDOW = 2000

# skip the most recent day when ranking momentum (dodges 1-day reversal)
MOM_SKIP_FRAC = 0.05

# no-trade band, as a fraction of the per-name cap: a position only moves
# when its target drifts at least this far from what is held. Chosen a
# priori (NOT searched) — it exists to tame turnover costs, identically for
# every family, and adds zero trials to the deflated-Sharpe penalty.
REBALANCE_BAND_FRAC = 0.25


def align_universe(candles_map: dict[str, Candles]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Common timestamp grid (intersection) and per-instrument row indices."""
    insts = list(candles_map)
    common = None
    for inst in insts:
        ts = candles_map[inst].ts
        common = ts if common is None else np.intersect1d(common, ts)
    idx = {}
    for inst in insts:
        ts = candles_map[inst].ts
        pos = np.searchsorted(ts, common)
        idx[inst] = pos
    return common, idx


def _scores(kind: str, candles: Candles, rv: np.ndarray,
            lb: int) -> np.ndarray:
    """Causal per-instrument score series; higher score -> more attractive
    LONG for mom/taker/oi, more attractive SHORT for carry/rev (sign applied
    later)."""
    c = candles.c
    n = len(c)
    if kind == "carry":
        return F.ewma_funding(candles.funding, lb)
    if kind == "taker":
        # persistent aggressive net buying continues cross-sectionally
        b = candles.x.get("tak_buy")
        s = candles.x.get("tak_sell")
        if b is None or s is None:
            return np.zeros(n)
        tot = b + s
        with np.errstate(invalid="ignore", divide="ignore"):
            imb = (b - s) / np.where(tot > 0, tot, np.nan)
        return F.ema(np.nan_to_num(imb, nan=0.0), lb)
    if kind == "basis":
        # smoothed perp premium to the spot index: the richest names carry
        # the most crowded longs (and pay the most funding) — fade them
        idx = candles.x.get("idx")
        if idx is None:
            return np.zeros(n)
        with np.errstate(invalid="ignore", divide="ignore"):
            prem = c / np.where(idx > 0, idx, np.nan) - 1.0
        return F.ema(np.nan_to_num(prem, nan=0.0), lb)
    if kind == "oi":
        # vol-adjusted momentum, counted only when open interest is rising
        # (a move carried by fresh positions, not by a squeeze/unwind)
        oi = candles.x.get("oi")
        if oi is None:
            return np.zeros(n)
        doi = np.nan_to_num(F.lookback_return(oi, lb))
        s = np.zeros(n)
        if lb >= n:
            return s
        s[lb:] = c[lb:] / c[:-lb] - 1.0
        with np.errstate(invalid="ignore", divide="ignore"):
            s = s / np.where(rv > 0.05, rv, np.nan)
        return np.nan_to_num(s, nan=0.0) * (doi > 0)
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
                 leader: str) -> np.ndarray | None:
    """Follow-the-leader continuation: each name's score is its causally
    estimated beta to the LEADER's previous-bar return, times the leader's
    recent move. High-beta laggards go long after the leader rallies (they
    tend to catch up), low-beta names fund the short side. Cross-sectional
    demeaning cannot wash this out because the betas differ per name."""
    if not leader or leader not in candles_map:
        return None
    lc = candles_map[leader].c[idx[leader]]
    lret = np.zeros(n)
    lret[1:] = lc[1:] / lc[:-1] - 1.0
    # leader's recent move over lb bars, scaled by its own typical move
    L = np.zeros(n)
    if lb >= n:
        return None
    L[lb:] = lc[lb:] / lc[:-lb] - 1.0
    lsd = F.rolling_std(lret, 96) * np.sqrt(lb)
    with np.errstate(invalid="ignore", divide="ignore"):
        L = L / np.where(lsd > 1e-9, lsd, np.nan)
    L = np.clip(np.nan_to_num(L, nan=0.0), -3.0, 3.0)

    x = np.concatenate(([0.0], lret[:-1]))          # leader ret, lagged 1 bar
    W = LEAD_BETA_WINDOW
    cs_xx = np.cumsum(x * x)
    smat = np.zeros((len(insts), n))
    for k, inst in enumerate(insts):
        c = candles_map[inst].c[idx[inst]]
        y = np.zeros(n)
        y[1:] = c[1:] / c[:-1] - 1.0
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

    vmat = np.zeros((len(insts), n))
    for k, inst in enumerate(insts):
        c = candles_map[inst]
        rv = F.realized_vol(c.c, w=96, bars_per_year=bpy)
        vmat[k] = np.nan_to_num(rv, nan=0.0)[idx[inst]]
    if kind == "lead":
        smat = _lead_scores(candles_map, insts, idx, n, lb, leader)
        if smat is None:
            return common, insts, {}
    else:
        smat = np.zeros((len(insts), n))
        for k, inst in enumerate(insts):
            c = candles_map[inst]
            rv = F.realized_vol(c.c, w=96, bars_per_year=bpy)
            rv = np.nan_to_num(rv, nan=0.0)
            smat[k] = _scores(kind, c, rv, lb)[idx[inst]]

    # cross-sectional z-score of the raw score at each bar (causal)
    mu = smat.mean(axis=0, keepdims=True)
    sd = smat.std(axis=0, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (smat - mu) / np.where(sd > 1e-12, sd, np.nan)
    z = np.nan_to_num(z, nan=0.0)

    # sign per family: carry & reversal fade the score; momentum, lead-lag,
    # taker-flow and OI-confirmed continuation follow it
    signed = z if kind in ("mom", "lead", "taker", "oi") else -z

    # inverse-vol tilt; demean so the book stays dollar-neutral after clipping
    with np.errstate(invalid="ignore", divide="ignore"):
        iv = 1.0 / np.where(vmat > 0.05, vmat, np.nan)
    iv = np.nan_to_num(iv, nan=0.0)
    iv_mean = iv.mean(axis=0, keepdims=True)
    iv = np.where(iv_mean > 0, iv / np.where(iv_mean > 0, iv_mean, 1.0), 0.0)

    raw = signed * iv
    raw = raw - raw.mean(axis=0, keepdims=True)
    gross = np.abs(raw).sum(axis=0, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        w = np.where(gross > 1e-9, raw / gross, 0.0)      # gross exposure 1
    w = np.clip(w, -max_w, max_w)

    # portfolio-level vol targeting on the common grid
    port_ret = np.zeros(n)
    rets = np.zeros((len(insts), n))
    for k, inst in enumerate(insts):
        c = candles_map[inst].c[idx[inst]]
        rets[k, 1:] = c[1:] / c[:-1] - 1.0
    port_ret[1:] = np.sum(w[:, :-1] * rets[:, 1:], axis=0)
    pvol = F.rolling_std(port_ret, 96) * np.sqrt(bpy)
    with np.errstate(invalid="ignore", divide="ignore"):
        scale = vol_target / np.where(pvol > 1e-3, pvol, np.nan)
    scale = np.clip(np.nan_to_num(scale, nan=1.0), 0.0, 3.0)
    w = w * scale[None, :]

    # warm-up guard (lead-lag also needs its beta-estimation window)
    warm = max(lb, 200, LEAD_BETA_WINDOW if kind == "lead" else 0)
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
        c = candles_map[inst].c[idx[inst]]
        fnd = candles_map[inst].funding[idx[inst]]
        ret = np.zeros(n)
        ret[1:] = c[1:] / c[:-1] - 1.0
        prev = np.concatenate(([0.0], pos[:-1]))
        total += prev * ret - np.abs(pos - prev) * cost_rate - prev * fnd
    return np.clip(total, -0.95, 10.0)
