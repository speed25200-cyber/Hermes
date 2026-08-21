"""Causal 1-minute features from candles + last trades + L2 book."""

from __future__ import annotations

import numpy as np

from ..data.store import Candles


def candle_feats(c: Candles) -> dict[str, float]:
    """Last-bar features only. Empty history -> zeros."""
    n = len(c)
    if n < 5:
        return {k: 0.0 for k in ("r1", "r3", "r12", "r60", "vol", "px")}
    px = float(c.c[-1])
    def ret(k: int) -> float:
        if n <= k or c.c[-1 - k] <= 0:
            return 0.0
        return float(c.c[-1] / c.c[-1 - k] - 1.0)
    r = np.zeros(min(n - 1, 60))
    r[:] = c.c[-len(r):] / np.where(c.c[-len(r) - 1:-1] > 0, c.c[-len(r) - 1:-1], np.nan) - 1.0
    vol = float(np.nanstd(r)) if len(r) > 5 else 0.0
    return {
        "r1": ret(1), "r3": ret(3), "r12": ret(12), "r60": ret(60),
        "vol": vol, "px": px,
    }


def trade_imbalance(trades: list[dict], now_ms: int, window_ms: int = 60_000) -> float:
    buy = sell = 0.0
    for t in trades or []:
        try:
            if now_ms - int(t["ts"]) > window_ms:
                continue
            n = float(t["px"]) * float(t["sz"])
        except (KeyError, TypeError, ValueError):
            continue
        if str(t.get("side", "")).lower() == "buy":
            buy += n
        else:
            sell += n
    tot = buy + sell
    return (buy - sell) / tot if tot > 0 else 0.0


def book_feats(book: dict | None, last: float) -> tuple[float, float]:
    """(imbalance, microprice_vs_last)."""
    if not book:
        return 0.0, 0.0
    bids, asks = book.get("bids") or [], book.get("asks") or []
    if not bids or not asks:
        return 0.0, 0.0
    try:
        bsz = sum(float(x[1]) for x in bids[:5])
        asz = sum(float(x[1]) for x in asks[:5])
        bid, b0 = float(bids[0][0]), float(bids[0][1])
        ask, a0 = float(asks[0][0]), float(asks[0][1])
    except (TypeError, ValueError, IndexError):
        return 0.0, 0.0
    imb = (bsz - asz) / (bsz + asz) if (bsz + asz) > 0 else 0.0
    den = b0 + a0
    micro = (bid * a0 + ask * b0) / den if den > 0 else last
    vs = (micro / last - 1.0) if last > 0 else 0.0
    return float(np.clip(imb, -1, 1)), float(np.clip(vs, -0.002, 0.002))
