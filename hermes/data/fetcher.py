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


def _index_id(inst: str) -> str:
    """BTC-USDT-SWAP -> BTC-USDT for index candles."""
    return inst[:-5] if inst.endswith("-SWAP") else inst


def fetch_oi(client: OKXClient, store: DataStore, inst: str,
             period: str = "15m", days: int = 180, sleep_s: float = 0.12,
             log=None) -> int:
    now_ms = int(time.time() * 1000)
    target = now_ms - days * 86_400_000
    total, end = 0, None
    while True:
        rows = client.open_interest_history(inst, period=period, limit=100, end=end)
        if not rows:
            break
        total += store.upsert_oi(inst, rows)
        oldest = min(ts for ts, _ in rows)
        if oldest <= target or (end is not None and oldest >= end):
            break
        end = oldest
        time.sleep(sleep_s)
    if log:
        log(f"{inst}: {total} OI rows stored")
    return total


def fetch_flow(client: OKXClient, store: DataStore, inst: str,
               period: str = "15m", days: int = 180, sleep_s: float = 0.12,
               log=None) -> int:
    now_ms = int(time.time() * 1000)
    target = now_ms - days * 86_400_000
    total, end = 0, None
    while True:
        rows = client.taker_volume_history(inst, period=period, limit=100, end=end)
        if not rows:
            break
        total += store.upsert_flow(inst, rows)
        oldest = min(ts for ts, _, _ in rows)
        if oldest <= target or (end is not None and oldest >= end):
            break
        end = oldest
        time.sleep(sleep_s)
    if log:
        log(f"{inst}: {total} taker-flow rows stored")
    return total


def _fetch_px_candles(client, store, inst: str, bar: str, table: str,
                      days: int, sleep_s: float, log, kind: str) -> int:
    now_ms = int(time.time() * 1000)
    target = now_ms - days * 86_400_000
    idx = _index_id(inst) if kind == "index" else inst
    fn = client.index_candles if kind == "index" else client.mark_candles
    total = 0
    try:
        rows = fn(idx, bar, limit=100, history=False)
    except Exception as exc:
        if log:
            log(f"{inst} {kind}: {type(exc).__name__}: {exc}")
        return 0
    def keep(rows):
        out = []
        for r in rows or []:
            try:
                ts, px = int(r[0]), float(r[4])  # close
                confirm = r[5] if len(r) > 5 else "1"
                if str(confirm) in ("0", "false"):
                    continue
                out.append((ts, px))
            except (TypeError, ValueError, IndexError):
                continue
        return out
    pairs = keep(rows)
    total += store.upsert_px(table, inst, bar, pairs)
    after = min(ts for ts, _ in pairs) if pairs else None
    while after is not None and after > target:
        try:
            rows = fn(idx, bar, limit=100, after=after, history=True)
        except Exception:
            break
        pairs = keep(rows)
        if not pairs:
            break
        total += store.upsert_px(table, inst, bar, pairs)
        oldest = min(ts for ts, _ in pairs)
        if oldest >= after:
            break
        after = oldest
        time.sleep(sleep_s)
    if log:
        log(f"{inst} {kind}: {total} px rows stored")
    return total


def fetch_basis(client: OKXClient, store: DataStore, inst: str, bar: str = "15m",
                days: int = 180, sleep_s: float = 0.12, log=None) -> int:
    n1 = _fetch_px_candles(client, store, inst, bar, "mark_px", days, sleep_s, log, "mark")
    n2 = _fetch_px_candles(client, store, inst, bar, "index_px", days, sleep_s, log, "index")
    return n1 + n2


def fetch_microstructure(client: OKXClient, store: DataStore, inst: str,
                         bar: str = "15m", days: int = 180, log=None) -> None:
    """OI + taker flow + mark/index. Best-effort: a missing series must not
    kill the candle/funding backfill."""
    period = bar if bar in ("5m", "15m", "30m", "1H", "4H", "1D") else "15m"
    for fn, label in (
        (lambda: fetch_oi(client, store, inst, period, days, log=log), "oi"),
        (lambda: fetch_flow(client, store, inst, period, days, log=log), "flow"),
        (lambda: fetch_basis(client, store, inst, bar, days, log=log), "basis"),
    ):
        try:
            fn()
        except Exception as exc:
            if log:
                log(f"{inst} {label}: {type(exc).__name__}: {exc} — skipping")


def update_latest(client: OKXClient, store: DataStore, inst: str, bar: str,
                  limit: int = 300, micro: bool = False) -> int:
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
    if micro:
        try:
            fetch_microstructure(client, store, inst, bar, days=7, log=None)
        except Exception:
            pass
    return n
