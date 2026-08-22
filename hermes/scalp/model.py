"""Directional 1m model: economic prior, not a lottery fit.

The 1-minute perp is ~bid-ask bounce plus queue imbalance. A neural net on
OHLCV will overfit the bounce and pay taker fees. This prior is signed the
way the microstructure actually pays:

  * fade the last 1–3 minutes (bounce)
  * follow the book (pending size predicts the next tick)
  * alts follow BTC's previous minute
  * recent taker flow is already in the print — small weight
"""

from __future__ import annotations

import math

PRIOR = {
    "r1": -0.55,
    "r3": -0.22,
    "r12": 0.08,
    "imb": 0.15,      # L1 size imbalance
    "book": 0.40,     # L5 notional imbalance
    "depth": 0.30,    # size within 5 bps of mid
    "micro": 0.35,    # microprice vs last
    "btc": 0.55,
}


def _clip(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def score(feat: dict[str, float], btc_r1: float, is_btc: bool) -> float:
    """Unitless signed score. Positive -> long."""
    z1 = _clip(feat.get("r1", 0.0) / max(feat.get("vol", 0.0), 4e-4), -3, 3)
    z3 = _clip(feat.get("r3", 0.0) / max(feat.get("vol", 0.0) * 1.7, 6e-4), -3, 3)
    z12 = _clip(feat.get("r12", 0.0) / max(feat.get("vol", 0.0) * 3.5, 1e-3), -3, 3)
    zb = _clip(btc_r1 / max(feat.get("vol", 0.0), 4e-4), -3, 3)
    s = (
        PRIOR["r1"] * z1
        + PRIOR["r3"] * z3
        + PRIOR["r12"] * z12
        + PRIOR["imb"] * _clip(feat.get("imb", 0.0), -1, 1)
        + PRIOR["book"] * _clip(feat.get("book", 0.0), -1, 1)
        + PRIOR["depth"] * _clip(feat.get("depth", 0.0), -1, 1)
        + PRIOR["micro"] * _clip(feat.get("micro", 0.0) / 0.0004, -3, 3)
    )
    if not is_btc:
        s += PRIOR["btc"] * zb
    return float(_clip(s, -4, 4))


def predict(feat: dict[str, float], btc_r1: float, is_btc: bool,
            horizon: int = 3) -> dict:
    s = score(feat, btc_r1, is_btc)
    vol = max(float(feat.get("vol", 0.0)), 1e-6)
    # expected move over `horizon` 1m bars, in bps
    edge_bps = s * vol * math.sqrt(max(horizon, 1)) * 1e4
    p_up = 1.0 / (1.0 + math.exp(-s * 1.4))
    return {
        "score": s,
        "p_up": p_up,
        "edge_bps": edge_bps,
        "vol_bps": vol * 1e4,
    }
