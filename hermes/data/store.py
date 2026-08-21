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

    __slots__ = ("inst", "bar", "ts", "o", "h", "l", "c", "v", "funding",
                 "oi", "taker_buy", "taker_sell", "mark", "index")

    def __init__(self, inst, bar, ts, o, h, l, c, v, funding=None,
                 oi=None, taker_buy=None, taker_sell=None, mark=None, index=None):
        self.inst = inst
        self.bar = bar
        self.ts = np.asarray(ts, dtype=np.int64)
        self.o = np.asarray(o, dtype=np.float64)
        self.h = np.asarray(h, dtype=np.float64)
        self.l = np.asarray(l, dtype=np.float64)
        self.c = np.asarray(c, dtype=np.float64)
        self.v = np.asarray(v, dtype=np.float64)
        n = len(self.c)
        def _col(x, fallback=None):
            if x is None:
                return np.zeros(n) if fallback is None else np.asarray(fallback, dtype=np.float64)
            a = np.asarray(x, dtype=np.float64)
            if len(a) == n:
                return a
            out = np.zeros(n) if fallback is None else np.asarray(fallback, dtype=np.float64).copy()
            m = min(n, len(a), len(out))
            out[:m] = a[:m]
            return out
        self.funding = _col(funding)
        self.oi = _col(oi)
        self.taker_buy = _col(taker_buy)
        self.taker_sell = _col(taker_sell)
        self.mark = _col(mark, fallback=self.c)
        self.index = _col(index, fallback=self.c)

    def __len__(self) -> int:
        return len(self.ts)

    def slice(self, start: int, stop: int) -> "Candles":
        return Candles(
            self.inst, self.bar,
            self.ts[start:stop], self.o[start:stop], self.h[start:stop],
            self.l[start:stop], self.c[start:stop], self.v[start:stop],
            self.funding[start:stop],
            oi=self.oi[start:stop], taker_buy=self.taker_buy[start:stop],
            taker_sell=self.taker_sell[start:stop], mark=self.mark[start:stop],
            index=self.index[start:stop],
        )

    @property
    def returns(self) -> np.ndarray:
        r = np.zeros(len(self.c))
        if len(self.c) > 1:
            r[1:] = self.c[1:] / self.c[:-1] - 1.0
        return r

    @property
    def taker_imb(self) -> np.ndarray:
        """Taker buy minus sell, in [-1, 1]. 0 when no volume."""
        tot = self.taker_buy + self.taker_sell
        with np.errstate(invalid="ignore", divide="ignore"):
            imb = (self.taker_buy - self.taker_sell) / np.where(tot > 0, tot, np.nan)
        return np.nan_to_num(imb, nan=0.0)

    @property
    def basis(self) -> np.ndarray:
        """(mark / index) - 1. Positive = perp rich = crowded long."""
        with np.errstate(invalid="ignore", divide="ignore"):
            b = self.mark / np.where(self.index > 1e-12, self.index, np.nan) - 1.0
        return np.clip(np.nan_to_num(b, nan=0.0), -0.05, 0.05)


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
            CREATE TABLE IF NOT EXISTS oi (
                inst TEXT NOT NULL, ts INTEGER NOT NULL, oi REAL,
                PRIMARY KEY (inst, ts)
            );
            CREATE TABLE IF NOT EXISTS flow (
                inst TEXT NOT NULL, ts INTEGER NOT NULL, buy REAL, sell REAL,
                PRIMARY KEY (inst, ts)
            );
            CREATE TABLE IF NOT EXISTS mark_px (
                inst TEXT NOT NULL, bar TEXT NOT NULL, ts INTEGER NOT NULL, px REAL,
                PRIMARY KEY (inst, bar, ts)
            );
            CREATE TABLE IF NOT EXISTS index_px (
                inst TEXT NOT NULL, bar TEXT NOT NULL, ts INTEGER NOT NULL, px REAL,
                PRIMARY KEY (inst, bar, ts)
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
        if not rows:
            return 0
        self.conn.executemany(
            "INSERT OR REPLACE INTO funding (inst, ts, rate) VALUES (?, ?, ?)",
            [(inst, int(ts), float(rate)) for ts, rate in rows],
        )
        self.conn.commit()
        return len(rows)

    def upsert_oi(self, inst: str, rows: list[tuple]) -> int:
        if not rows:
            return 0
        self.conn.executemany(
            "INSERT OR REPLACE INTO oi (inst, ts, oi) VALUES (?, ?, ?)",
            [(inst, int(ts), float(oi)) for ts, oi in rows],
        )
        self.conn.commit()
        return len(rows)

    def upsert_flow(self, inst: str, rows: list[tuple]) -> int:
        if not rows:
            return 0
        self.conn.executemany(
            "INSERT OR REPLACE INTO flow (inst, ts, buy, sell) VALUES (?, ?, ?, ?)",
            [(inst, int(ts), float(b), float(s)) for ts, b, s in rows],
        )
        self.conn.commit()
        return len(rows)

    def upsert_px(self, table: str, inst: str, bar: str, rows: list[tuple]) -> int:
        if not rows or table not in ("mark_px", "index_px"):
            return 0
        self.conn.executemany(
            f"INSERT OR REPLACE INTO {table} (inst, bar, ts, px) VALUES (?, ?, ?, ?)",
            [(inst, bar, int(ts), float(px)) for ts, px in rows],
        )
        self.conn.commit()
        return len(rows)

    def candle_range(self, inst: str, bar: str) -> tuple[int, int, int]:
        cur = self.conn.execute(
            "SELECT MIN(ts), MAX(ts), COUNT(*) FROM candles WHERE inst=? AND bar=?",
            (inst, bar),
        )
        lo, hi, n = cur.fetchone()
        return (lo or 0, hi or 0, n or 0)

    def load(self, inst: str, bar: str, with_funding: bool = True) -> Candles:
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
            oi = self.conn.execute(
                "SELECT ts, oi FROM oi WHERE inst=? ORDER BY ts", (inst,)
            ).fetchall()
            if oi:
                candles.oi = map_last_to_bars(candles.ts, oi)
            fl = self.conn.execute(
                "SELECT ts, buy, sell FROM flow WHERE inst=? ORDER BY ts", (inst,)
            ).fetchall()
            if fl:
                candles.taker_buy = map_last_to_bars(candles.ts, [(t, b) for t, b, _ in fl])
                candles.taker_sell = map_last_to_bars(candles.ts, [(t, s) for t, _, s in fl])
            mk = self.conn.execute(
                "SELECT ts, px FROM mark_px WHERE inst=? AND bar=? ORDER BY ts",
                (inst, bar),
            ).fetchall()
            if mk:
                candles.mark = map_last_to_bars(candles.ts, mk, fallback=candles.c)
            ix = self.conn.execute(
                "SELECT ts, px FROM index_px WHERE inst=? AND bar=? ORDER BY ts",
                (inst, bar),
            ).fetchall()
            if ix:
                candles.index = map_last_to_bars(candles.ts, ix, fallback=candles.c)
        return candles

    def close(self) -> None:
        self.conn.close()


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


def map_last_to_bars(bar_ts: np.ndarray, rows: list[tuple],
                     fallback: np.ndarray | None = None) -> np.ndarray:
    """Last observation at or before each bar close (strictly causal)."""
    n = len(bar_ts)
    out = np.zeros(n) if fallback is None else np.asarray(fallback, dtype=np.float64).copy()
    if n == 0 or not rows:
        return out
    rts = np.asarray([r[0] for r in rows], dtype=np.int64)
    vals = np.asarray([r[1] for r in rows], dtype=np.float64)
    idx = np.searchsorted(rts, bar_ts, side="right") - 1
    valid = idx >= 0
    out[valid] = vals[idx[valid]]
    return out
