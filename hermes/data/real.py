"""Real market candles bundled offline.

Crypto exchange APIs are often unreachable from sandboxed environments, but
the `backtesting` package (PyPI) ships genuine historical market data:

  * EURUSD — hourly candles, 2017-2018 (5,000 bars)
  * GOOG   — daily candles, 2004-2013 (2,148 bars)

These are real price series (FX and equity), which makes them a legitimate
end-to-end test of the research pipeline on non-synthetic data. On a machine
with network access, `python -m hermes fetch` pulls real OKX perpetual
candles instead — this module is the offline fallback.

Note on annualisation: BARS_PER_YEAR assumes 24/7 crypto markets; FX (~120
hourly bars/week) and equities (~252 sessions/year) trade fewer bars, so
annualised Sharpe figures on these sets are overstated by roughly 15-20%.
The relative comparison (strategy vs buy & hold, IS vs OOS) is unaffected.
"""

from __future__ import annotations

import numpy as np

from .store import Candles


def _df_to_candles(df, inst: str, bar: str) -> Candles:
    ts = (df.index.astype("int64") // 1_000_000).to_numpy()  # ns -> ms
    return Candles(
        inst, bar, ts,
        df["Open"].to_numpy(dtype=float),
        df["High"].to_numpy(dtype=float),
        df["Low"].to_numpy(dtype=float),
        df["Close"].to_numpy(dtype=float),
        df["Volume"].to_numpy(dtype=float),
    )


def load_bundled() -> list[Candles]:
    """Returns the bundled real datasets as Candles (funding = 0)."""
    try:
        from backtesting.test import EURUSD, GOOG
    except ImportError as exc:
        raise SystemExit(
            "real-candle test data requires the 'backtesting' package: "
            "pip install backtesting"
        ) from exc
    return [
        _df_to_candles(EURUSD, "EURUSD-REAL", "1H"),
        _df_to_candles(GOOG, "GOOG-REAL", "1D"),
    ]
