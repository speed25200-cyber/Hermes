"""SQLite-backed market data store for candles and funding rates.

All timestamps are epoch milliseconds (OKX convention). Candles are stored
one row per (instrument, bar, ts) and always returned oldest-first.
"""

from __future__ import annotations

import os
import sqlite3

import numpy as np

BAR_MS = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1H": 3_600_000,
    "2H": 7_200_000,
    "4H": 14_400_000,
    "6H": 21_600_000,
    "12H": 43_200_000,
    "1D": 86_400_000,
}

BARS_PER_YEAR = {bar: int(round(365 * 86_400_000 / ms)) for bar, ms in BAR_MS.items()}


class Candles:
    """Column-oriented candle series (numpy arrays, oldest first)."""

    __slots__ = ("inst", "bar", "ts", "o", "h", "l", "c", "v", "funding", "x")

    def __init__(self, inst, bar, ts, o, h, l, c, v, funding=None, x=None):
        self.inst = inst
        self.bar = bar
        self.ts = np.asarray(ts, dtype=np.int64)
        self.o = np.asarray(o, dtype=np.float64)
        self.h = np.asarray(h, dtype=np.float64)
        self.l = np.asarray(l, dtype=np.float64)
        self.c = np.asarray(c, dtype=np.float64)
        self.v = np.asarray(v, dtype=np.float64)
        # per-bar funding rate actually charged at that bar (0 for most bars)
        self.funding = (
            np.zeros_like(self.c) if funding is None else np.asarray(funding, dtype=np.float64)
        )
        # auxiliary market series aligned to bars (NaN where not covered):
        # "oi" open interest (coin), "tak_buy"/"tak_sell" hourly taker volume,
        # "lsr" long/short account ratio
        self.x: dict[str, np.ndarray] = x if x is not None else {}

    def __len__(self) -> int:
        return len(self.ts)

    def slice(self, start: int, stop: int) -> "Candles":
        return Candles(
            self.inst, self.bar,
            self.ts[start:stop], self.o[start:stop], self.h[start:stop],
            self.l[start:stop], self.c[start:stop], self.v[start:stop],
            self.funding[start:stop],
            {k: v[start:stop] for k, v in self.x.items()},
        )

    @property
    def returns(self) -> np.ndarray:
        r = np.zeros(len(self.c))
        if len(self.c) > 1:
            r[1:] = self.c[1:] / self.c[:-1] - 1.0
        return r


class DataStore:
    def __init__(self, data_dir: str):
        os.makedirs(data_dir, exist_ok=True)
        self.path = os.path.join(data_dir, "market.db")
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS candles (
                inst TEXT NOT NULL, bar TEXT NOT NULL, ts INTEGER NOT NULL,
                o REAL, h REAL, l REAL, c REAL, v REAL,
                PRIMARY KEY (inst, bar, ts)
            );
            CREATE TABLE IF NOT EXISTS funding (
                inst TEXT NOT NULL, ts INTEGER NOT NULL, rate REAL,
                PRIMARY KEY (inst, ts)
            );
            CREATE TABLE IF NOT EXISTS aux (
                inst TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL,
                v1 REAL, v2 REAL,
                PRIMARY KEY (inst, kind, ts)
            );
            """
        )
        self.conn.commit()

    def upsert_candles(self, inst: str, bar: str, rows: list[tuple]) -> int:
        """rows: iterable of (ts, o, h, l, c, v)."""
        self.conn.executemany(
            "INSERT OR REPLACE INTO candles (inst, bar, ts, o, h, l, c, v) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(inst, bar, int(r[0]), *map(float, r[1:6])) for r in rows],
        )
        self.conn.commit()
        return len(rows)

    def upsert_funding(self, inst: str, rows: list[tuple]) -> int:
        """rows: iterable of (ts, rate)."""
        self.conn.executemany(
            "INSERT OR REPLACE INTO funding (inst, ts, rate) VALUES (?, ?, ?)",
            [(inst, int(ts), float(rate)) for ts, rate in rows],
        )
        self.conn.commit()
        return len(rows)

    def upsert_aux(self, inst: str, kind: str, rows: list[tuple]) -> int:
        """rows: iterable of (ts, v1, v2). kind: 'oi' | 'taker' | 'lsr'."""
        self.conn.executemany(
            "INSERT OR REPLACE INTO aux (inst, kind, ts, v1, v2) "
            "VALUES (?, ?, ?, ?, ?)",
            [(inst, kind, int(r[0]), float(r[1]),
              float(r[2]) if len(r) > 2 and r[2] is not None else 0.0)
             for r in rows],
        )
        self.conn.commit()
        return len(rows)

    def aux_range(self, inst: str, kind: str) -> tuple[int, int, int]:
        cur = self.conn.execute(
            "SELECT MIN(ts), MAX(ts), COUNT(*) FROM aux WHERE inst=? AND kind=?",
            (inst, kind),
        )
        lo, hi, n = cur.fetchone()
        return (lo or 0, hi or 0, n or 0)

    def candle_range(self, inst: str, bar: str) -> tuple[int, int, int]:
        cur = self.conn.execute(
            "SELECT MIN(ts), MAX(ts), COUNT(*) FROM candles WHERE inst=? AND bar=?",
            (inst, bar),
        )
        lo, hi, n = cur.fetchone()
        return (lo or 0, hi or 0, n or 0)

    def load(self, inst: str, bar: str, with_funding: bool = True,
             with_aux: bool = True) -> Candles:
        cur = self.conn.execute(
            "SELECT ts, o, h, l, c, v FROM candles WHERE inst=? AND bar=? ORDER BY ts",
            (inst, bar),
        )
        rows = cur.fetchall()
        if not rows:
            return Candles(inst, bar, [], [], [], [], [], [])
        arr = np.array(rows, dtype=np.float64)
        candles = Candles(inst, bar, arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4], arr[:, 5])
        if with_funding:
            fr = self.conn.execute(
                "SELECT ts, rate FROM funding WHERE inst=? ORDER BY ts", (inst,)
            ).fetchall()
            if fr:
                candles.funding = map_funding_to_bars(candles.ts, fr)
        if with_aux:
            bar_ms = BAR_MS[bar]
            for kind, names in AUX_SERIES.items():
                ar = self.conn.execute(
                    "SELECT ts, v1, v2 FROM aux WHERE inst=? AND kind=? ORDER BY ts",
                    (inst, kind),
                ).fetchall()
                if not ar:
                    continue
                cols = map_aux_to_bars(candles.ts, bar_ms, ar,
                                       AUX_PERIODS.get(kind, AUX_PERIOD_MS))
                for name, col in zip(names, cols):
                    candles.x[name] = col
            # underlying index close (same-bar, exact ts join): known at the
            # bar's own close, exactly like the perp close itself
            ir = self.conn.execute(
                "SELECT ts, c FROM candles WHERE inst=? AND bar=? ORDER BY ts",
                (inst + "#IDX", bar),
            ).fetchall()
            if ir:
                its = np.array([r[0] for r in ir], dtype=np.int64)
                ic = np.array([r[1] for r in ir], dtype=np.float64)
                out = np.full(len(candles), np.nan)
                pos = np.searchsorted(its, candles.ts)
                ok = (pos < len(its))
                safe = np.minimum(pos, len(its) - 1)
                ok &= its[safe] == candles.ts
                out[ok] = ic[safe[ok]]
                candles.x["idx"] = out
        return candles

    def close(self) -> None:
        self.conn.close()


# aux kind -> Candles.x series names for (v1, v2)
AUX_SERIES = {
    "oi": ("oi",),
    "taker": ("tak_buy", "tak_sell"),
    "lsr": ("lsr",),
    "ttp": ("ttp",),
    "ob": ("ob_near", "ob_deep"),   # self-recorded order-book imbalance
}
AUX_PERIOD_MS = 3_600_000  # rubik endpoints are fetched at 1H granularity
# per-kind bucket length; order-book snapshots are taken every ~10 minutes
AUX_PERIODS = {"ob": 900_000}


def map_aux_to_bars(bar_ts: np.ndarray, bar_ms: int, rows: list[tuple],
                    period_ms: int, stale_periods: int = 3) -> list[np.ndarray]:
    """Align raw aux rows (ts, v1, v2) to bars without look-ahead.

    A row stamped T describes the period [T, T+period): it is only fully
    known at T+period, so a bar may use it only if the bar CLOSES at or
    after T+period. Values forward-fill until they go stale
    (> stale_periods behind), then turn NaN."""
    n = len(bar_ts)
    out1 = np.full(n, np.nan)
    out2 = np.full(n, np.nan)
    if n == 0 or not rows:
        return [out1, out2]
    ats = np.array([int(r[0]) for r in rows], dtype=np.int64) + period_ms
    v1 = np.array([float(r[1]) for r in rows])
    v2 = np.array([float(r[2]) if len(r) > 2 and r[2] is not None else 0.0
                   for r in rows])
    close = bar_ts.astype(np.int64) + bar_ms
    idx = np.searchsorted(ats, close, side="right") - 1
    valid = idx >= 0
    safe = np.maximum(idx, 0)
    age_ok = (close - ats[safe]) <= stale_periods * period_ms
    use = valid & age_ok
    out1[use] = v1[safe[use]]
    out2[use] = v2[safe[use]]
    return [out1, out2]


def map_funding_to_bars(bar_ts: np.ndarray, funding_rows: list[tuple]) -> np.ndarray:
    """Assign each funding payment to the first bar at/after its timestamp."""
    out = np.zeros(len(bar_ts))
    if len(bar_ts) == 0:
        return out
    for ts, rate in funding_rows:
        idx = int(np.searchsorted(bar_ts, ts, side="left"))
        if idx >= len(bar_ts):
            continue
        out[idx] += rate
    return out
