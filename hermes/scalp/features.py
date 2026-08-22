"""Causal 1-minute features from candles + last trades + L2 book."""

from __future__ import annotations

import numpy as np

from ..data.store import Candles


def candle_feats(c: Candles) -> dict[str, float]:
    """Last-bar features only. Empty history -> zeros. All causal (no future bars)."""
    keys = ("r1", "r3", "r5", "r12", "r60", "vol", "px",
            "loc", "rng", "vshock", "persist")
    n = len(c)
    if n < 5:
        return {k: 0.0 for k in keys}
    px = float(c.c[-1])
    def ret(k: int) -> float:
        if n <= k or c.c[-1 - k] <= 0:
            return 0.0
        return float(c.c[-1] / c.c[-1 - k] - 1.0)
    r = np.zeros(min(n - 1, 60))
    r[:] = c.c[-len(r):] / np.where(c.c[-len(r) - 1:-1] > 0, c.c[-len(r) - 1:-1], np.nan) - 1.0
    vol = float(np.nanstd(r)) if len(r) > 5 else 0.0
    h, l = float(c.h[-1]), float(c.l[-1])
    rng = ((h - l) / px) if px > 0 and h >= l else 0.0
    loc = ((px - l) / (h - l) - 0.5) if h > l else 0.0  # + = close at high
    med_v = float(np.median(c.v[-20:])) if n >= 8 else 0.0
    vshock = (float(c.v[-1]) / med_v - 1.0) if med_v > 0 else 0.0
    signs = np.sign(r[-3:]) if len(r) >= 3 else np.zeros(1)
    persist = float(np.sum(signs)) / max(len(signs), 1)  # +1 = 3 up bars
    return {
        "r1": ret(1), "r3": ret(3), "r5": ret(5), "r12": ret(12), "r60": ret(60),
        "vol": vol, "px": px, "loc": float(np.clip(loc, -0.5, 0.5)),
        "rng": float(max(rng, 0.0)), "vshock": float(np.clip(vshock, -3, 5)),
        "persist": float(np.clip(persist, -1, 1)),
    }


def trade_imbalance(trades: list[dict], now_ms: int, window_ms: int = 60_000) -> float:
    return trade_tape(trades, now_ms, last=0.0, window_ms=window_ms)["flow"]


def trade_tape(trades: list[dict], now_ms: int, last: float,
               window_ms: int = 60_000) -> dict[str, float]:
    """Taker imbalance, intensity, VWAP vs last. Causal (only ts <= now)."""
    buy = sell = 0.0
    n_tr = 0
    qty = 0.0
    pxqty = 0.0
    for t in trades or []:
        try:
            ts = int(t["ts"])
            if ts > now_ms or now_ms - ts > window_ms:
                continue
            px, sz = float(t["px"]), float(t["sz"])
        except (KeyError, TypeError, ValueError):
            continue
        n_tr += 1
        qty += sz
        pxqty += px * sz
        n = px * sz
        if str(t.get("side", "")).lower() == "buy":
            buy += n
        else:
            sell += n
    tot = buy + sell
    vwap = (pxqty / qty) if qty > 0 else last
    vs = (last / vwap - 1.0) if vwap > 0 and last > 0 else 0.0
    return {
        "flow": (buy - sell) / tot if tot > 0 else 0.0,
        "n_tr": float(n_tr),
        "vwap_vs": float(np.clip(vs, -0.003, 0.003)),
    }


def ofi_l1(prev: dict | None, book: dict | None) -> float:
    """Cont-style L1 order-flow imbalance between two snapshots."""
    if not prev or not book:
        return 0.0
    pb, pa = _levels(prev.get("bids") or [], 1), _levels(prev.get("asks") or [], 1)
    b, a = _levels(book.get("bids") or [], 1), _levels(book.get("asks") or [], 1)
    if not pb or not pa or not b or not a:
        return 0.0
    pbid, pbsz = pb[0]
    pask, pasz = pa[0]
    bid, bsz = b[0]
    ask, asz = a[0]
    if bid > pbid:
        d_bid = bsz
    elif bid == pbid:
        d_bid = bsz - pbsz
    else:
        d_bid = -pbsz
    if ask < pask:
        d_ask = asz
    elif ask == pask:
        d_ask = asz - pasz
    else:
        d_ask = -pasz
    raw = d_bid - d_ask
    scale = (bsz + asz) if (bsz + asz) > 0 else 1.0
    return float(np.clip(raw / scale, -3, 3))


def book_feats(book: dict | None, last: float) -> tuple[float, float]:
    """Back-compat: (top-5 size imbalance, microprice vs last)."""
    f = book_l2(book, last)
    return f["imb5"], f["micro"]


def _levels(side: list, n: int = 10) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for row in (side or [])[:n]:
        try:
            px, sz = float(row[0]), float(row[1])
        except (TypeError, ValueError, IndexError):
            continue
        if px > 0 and sz > 0:
            out.append((px, sz))
    return out


def book_l2(book: dict | None, last: float, band_bps: float = 5.0) -> dict[str, float]:
    """Real L2 snapshot: L1/L5 imbalance, microprice, depth within `band_bps` of mid."""
    z = {"imb1": 0.0, "imb5": 0.0, "micro": 0.0, "spread_bps": 0.0,
         "depth_imb": 0.0, "bid_usd": 0.0, "ask_usd": 0.0}
    if not book:
        return z
    bids, asks = _levels(book.get("bids") or []), _levels(book.get("asks") or [])
    if not bids or not asks:
        return z
    bid, b0 = bids[0]
    ask, a0 = asks[0]
    if ask <= bid:
        return z
    mid = 0.5 * (bid + ask)
    px = last if last > 0 else mid
    z["spread_bps"] = (ask - bid) / px * 1e4
    den1 = b0 + a0
    z["imb1"] = (b0 - a0) / den1 if den1 else 0.0
    # microprice: weighted toward the thinner side (queue theory)
    z["micro"] = ((bid * a0 + ask * b0) / den1 / px - 1.0) if den1 and px else 0.0
    bn = sum(p * s for p, s in bids[:5])
    an = sum(p * s for p, s in asks[:5])
    z["imb5"] = (bn - an) / (bn + an) if (bn + an) else 0.0
    band = band_bps * 1e-4
    bd = sum(p * s for p, s in bids if (mid - p) / mid <= band)
    ad = sum(p * s for p, s in asks if (p - mid) / mid <= band)
    z["bid_usd"], z["ask_usd"] = bd, ad
    z["depth_imb"] = (bd - ad) / (bd + ad) if (bd + ad) else 0.0
    for k in ("imb1", "imb5", "depth_imb"):
        z[k] = float(np.clip(z[k], -1.0, 1.0))
    z["micro"] = float(np.clip(z["micro"], -0.002, 0.002))
    return z
