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
    "r1": -0.55,       # fade the last print
    "r3": -0.22,
    "r5": -0.10,
    "r12": 0.08,       # weak continuation at 12m
    "imb": 0.15,
    "book": 0.40,
    "depth": 0.30,
    "micro": 0.35,
    "btc": 0.55,       # alts follow BTC's last minute
    "flow": 0.22,      # aggressive tape
    "ofi": 0.32,       # L1 book delta (Cont)
    "loc": -0.28,      # close at high/low tends to fade
    "persist": 0.16,   # 3 same-sign bars: less fade / more follow
    "idio": -0.30,     # fade alt-specific jump vs BTC
    "vwap": -0.18,     # last stretched vs tape VWAP → fade
}


def _clip(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def score(feat: dict[str, float], btc_r1: float, is_btc: bool) -> float:
    """Unitless signed score. Positive -> long."""
    vol = max(feat.get("vol", 0.0), 4e-4)
    z1 = _clip(feat.get("r1", 0.0) / vol, -3, 3)
    z3 = _clip(feat.get("r3", 0.0) / max(vol * 1.7, 6e-4), -3, 3)
    z5 = _clip(feat.get("r5", 0.0) / max(vol * 2.2, 8e-4), -3, 3)
    z12 = _clip(feat.get("r12", 0.0) / max(vol * 3.5, 1e-3), -3, 3)
    zb = _clip(btc_r1 / vol, -3, 3)
    # don't fade a 12m trend as if it were bounce
    fade_r1 = PRIOR["r1"] * (0.35 if abs(z12) > 2.0 else 1.0)
    vshock = _clip(feat.get("vshock", 0.0), -2, 4)
    # volume spike on the print: stronger bounce (exhaustion)
    fade_r1 *= (1.0 + 0.25 * max(vshock, 0.0))
    s = (
        fade_r1 * z1
        + PRIOR["r3"] * z3
        + PRIOR["r5"] * z5
        + PRIOR["r12"] * z12
        + PRIOR["imb"] * _clip(feat.get("imb", 0.0), -1, 1)
        + PRIOR["book"] * _clip(feat.get("book", 0.0), -1, 1)
        + PRIOR["depth"] * _clip(feat.get("depth", 0.0), -1, 1)
        + PRIOR["micro"] * _clip(feat.get("micro", 0.0) / 0.0004, -3, 3)
        + PRIOR["flow"] * _clip(feat.get("flow", 0.0), -1, 1)
        + PRIOR["ofi"] * _clip(feat.get("ofi", 0.0), -3, 3) / 3.0
        + PRIOR["loc"] * _clip(feat.get("loc", 0.0) / 0.5, -1, 1)
        + PRIOR["persist"] * _clip(feat.get("persist", 0.0), -1, 1)
        + PRIOR["vwap"] * _clip(feat.get("vwap_vs", 0.0) / 0.0004, -3, 3)
    )
    if not is_btc:
        s += PRIOR["btc"] * zb
        idio = feat.get("r1", 0.0) - btc_r1
        s += PRIOR["idio"] * _clip(idio / vol, -3, 3)
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
