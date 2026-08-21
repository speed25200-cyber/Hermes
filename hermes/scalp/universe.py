"""Pick the most tradeable USDT perps: volume first, spread as a hard veto.

A 1m scalp on a 20 bps spread is a donation. Top-50 by volume is the
candidate set; names whose spread exceeds the predicted edge never get a
target.
"""

from __future__ import annotations

LEADERS = ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP")


def select_universe(tickers: dict[str, dict], n: int = 50,
                    max_spread_bps: float = 8.0,
                    min_vol_usd: float = 20_000_000.0) -> list[str]:
    """Return up to `n` USDT-SWAP ids, volume-desc, spread-filtered.

    BTC/ETH/SOL are pinned at the front if they pass the spread screen so
    the lead-lag feature always has a leader.
    """
    scored: list[tuple[float, str]] = []
    for inst, t in tickers.items():
        if not inst.endswith("-USDT-SWAP"):
            continue
        if float(t.get("spread_bps", 999)) > max_spread_bps:
            continue
        vol = float(t.get("vol_usd") or 0.0)
        if vol < min_vol_usd:
            continue
        scored.append((vol, inst))
    scored.sort(reverse=True)
    picked = [inst for _, inst in scored[:n]]
    # pin leaders (already filtered) without duplicating
    head = [x for x in LEADERS if x in picked]
    rest = [x for x in picked if x not in head]
    return head + rest
