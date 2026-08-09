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

# genome signal name -> scoring kind
XS_KINDS = {"funding_xs": "carry", "xs_mom": "mom", "xs_rev": "rev"}

# skip the most recent day when ranking momentum (dodges 1-day reversal)
MOM_SKIP_FRAC = 0.05


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


def _scores(kind: str, c: np.ndarray, funding: np.ndarray, rv: np.ndarray,
            lb: int) -> np.ndarray:
    """Causal per-instrument score series; higher score -> more attractive
    LONG for mom, more attractive SHORT for carry/rev (sign applied later)."""
    n = len(c)
    if kind == "carry":
        return F.ewma_funding(funding, lb)
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


def xs_positions(
    candles_map: dict[str, Candles],
    params: dict,
    kind: str = "carry",
    vol_target: float = 0.15,
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

    smat = np.zeros((len(insts), n))
    vmat = np.zeros((len(insts), n))
    for k, inst in enumerate(insts):
        c = candles_map[inst]
        rv = F.realized_vol(c.c, w=96, bars_per_year=bpy)
        rv = np.nan_to_num(rv, nan=0.0)
        smat[k] = _scores(kind, c.c, c.funding, rv, lb)[idx[inst]]
        vmat[k] = rv[idx[inst]]

    # cross-sectional z-score of the raw score at each bar (causal)
    mu = smat.mean(axis=0, keepdims=True)
    sd = smat.std(axis=0, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (smat - mu) / np.where(sd > 1e-12, sd, np.nan)
    z = np.nan_to_num(z, nan=0.0)

    # sign per family: carry & reversal fade the score, momentum follows it
    signed = z if kind == "mom" else -z

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

    # warm-up guard
    w[:, : max(lb, 200)] = 0.0
    return common, insts, {inst: w[k] for k, inst in enumerate(insts)}


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
