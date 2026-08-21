"""Historical data fetcher: paginates OKX candle + funding history into the
local store. Public endpoints only (no credentials required)."""

from __future__ import annotations

import time

from ..exchange.okx_client import OKXClient
from .store import BAR_MS, DataStore


def fetch_candles(
    client: OKXClient,
    store: DataStore,
    inst: str,
    bar: str = "1H",
    days: int = 730,
    sleep_s: float = 0.12,
    log=None,
) -> int:
    """Backfill `days` of candles, resuming from what is already stored.

    Also repairs a *middle* gap (old history + latest 300 bars, hole in
    between) which used to be skipped because pagination stopped at the
    stored oldest timestamp instead of walking back until it overlapped
    the stored newest.
    """
    now_ms = int(time.time() * 1000)
    target_start = now_ms - days * 86_400_000
    lo, hi, n = store.candle_range(inst, bar)
    total = 0

    def save(rows: list[list]) -> int:
        # OKX rows: [ts, o, h, l, c, vol, ...] newest first; keep confirmed only
        keep = [(int(r[0]), r[1], r[2], r[3], r[4], r[5])
                for r in rows if len(r) < 9 or r[8] == "1"]
        return store.upsert_candles(inst, bar, keep) if keep else 0

    # 1) newest chunk (regular endpoint covers the most recent bars)
    rows = client.candles(inst, bar, limit=300)
    total += save(rows)
    if not rows:
        if log:
            log(f"{inst} {bar}: no candles returned")
        return total

    # Walk back from the oldest row of this newest chunk.
    after = int(rows[-1][0])

    def walk_until(stop_ts: int) -> None:
        nonlocal after, total
        while after > stop_ts:
            hist = client.candles(inst, bar, limit=100, after=after, history=True)
            if not hist:
                break
            total += save(hist)
            oldest = int(hist[-1][0])
            if oldest >= after:
                break
            after = oldest
            if log and total % 2000 < 100:
                log(f"{inst} {bar}: fetched back to "
                    f"{time.strftime('%Y-%m-%d', time.gmtime(after / 1000))}")
            time.sleep(sleep_s)

    # Phase A: repair a hole between "latest 300" and stored newest (`hi`)
    if hi:
        walk_until(max(int(hi), target_start))
    # Phase B: deepen older than stored oldest (`lo`) down to target_start
    if lo and int(lo) > target_start:
        after = int(lo)
        walk_until(target_start)
    elif not lo:
        walk_until(target_start)

    if log:
        _, _, n2 = store.candle_range(inst, bar)
        log(f"{inst} {bar}: {n2} candles stored (+{total} upserted)")
    return total


def fetch_funding(client: OKXClient, store: DataStore, inst: str,
                  days: int = 730, sleep_s: float = 0.15, log=None) -> int:
    now_ms = int(time.time() * 1000)
    target_start = now_ms - days * 86_400_000
    total = 0
    after: int | None = None
    while True:
        rows = client.funding_rate_history(inst, limit=100, after=after)
        if not rows:
            break
        pairs = [(int(r["fundingTime"]), float(r["fundingRate"])) for r in rows]
        total += store.upsert_funding(inst, pairs)
        oldest = min(ts for ts, _ in pairs)
        if oldest <= target_start or (after is not None and oldest >= after):
            break
        after = oldest
        time.sleep(sleep_s)
    if log:
        log(f"{inst}: {total} funding rows stored")
    return total


def update_latest(client: OKXClient, store: DataStore, inst: str, bar: str,
                  limit: int = 300) -> int:
    """Light refresh for the live loop: latest confirmed candles + funding."""
    rows = client.candles(inst, bar, limit=limit)
    keep = [(int(r[0]), r[1], r[2], r[3], r[4], r[5])
            for r in rows if len(r) < 9 or r[8] == "1"]
    n = store.upsert_candles(inst, bar, keep) if keep else 0
    try:
        fr = client.funding_rate_history(inst, limit=20)
        store.upsert_funding(inst, [(int(r["fundingTime"]), float(r["fundingRate"]))
                                    for r in fr])
    except Exception:
        pass  # funding refresh is best-effort
    return n
