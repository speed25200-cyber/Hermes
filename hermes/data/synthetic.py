"""Synthetic market generator for offline testing of the whole pipeline.

Produces regime-switching price paths with volatility clustering, fat tails,
and a funding-rate series — realistic enough that strategies which exploit
persistent structure (trend / mean-reversion / carry) are discoverable, while
pure noise strategies fail validation.
"""

from __future__ import annotations

import numpy as np

from .store import BAR_MS, Candles

REGIMES = ("trend_up", "trend_down", "meanrev", "chop")


def generate(
    inst: str = "SYN-USDT-SWAP",
    bar: str = "1H",
    n: int = 12000,
    seed: int = 7,
    s0: float = 100.0,
) -> Candles:
    rng = np.random.default_rng(seed)
    bar_ms = BAR_MS[bar]
    ts = (np.arange(n, dtype=np.int64) * bar_ms) + 1_600_000_000_000

    # --- regime chain -------------------------------------------------------
    # Average regime length ~ 400 bars; drift/AR structure differs per regime.
    regime = np.zeros(n, dtype=np.int64)
    cur = rng.integers(0, len(REGIMES))
    for i in range(n):
        if rng.random() < 1 / 400:
            cur = rng.integers(0, len(REGIMES))
        regime[i] = cur

    # --- volatility clustering (GARCH-like) ---------------------------------
    base_vol = 0.004  # per-bar
    var = np.empty(n)
    var[0] = base_vol**2
    z = rng.standard_t(df=4, size=n) / np.sqrt(2.0)  # fat tails, ~unit variance
    ret = np.empty(n)
    log_dev = 0.0  # deviation from slow anchor, drives mean reversion regime
    for i in range(n):
        if i > 0:
            var[i] = 0.90 * var[i - 1] + 0.08 * (ret[i - 1] ** 2) + 0.02 * base_vol**2
        sd = np.sqrt(var[i])
        r_name = REGIMES[regime[i]]
        drift = {"trend_up": 0.35 * sd, "trend_down": -0.35 * sd, "meanrev": 0.0, "chop": 0.0}[r_name]
        ar = 0.0
        if r_name == "meanrev":
            ar = -0.08 * log_dev  # pull back toward anchor
        elif r_name in ("trend_up", "trend_down") and i > 0:
            ar = 0.06 * ret[i - 1]  # mild autocorrelation in trends
        ret[i] = drift + ar + sd * z[i]
        log_dev = 0.97 * log_dev + ret[i]

    logp = np.log(s0) + np.cumsum(ret)
    c = np.exp(logp)
    o = np.empty(n)
    o[0] = s0
    o[1:] = c[:-1]
    wick = np.abs(rng.normal(0, 0.4, n)) * np.sqrt(var) * c
    h = np.maximum(o, c) + wick
    l = np.minimum(o, c) - wick
    v = rng.lognormal(mean=10, sigma=0.5, size=n) * (1 + 5 * np.sqrt(var) / base_vol)

    candles = Candles(inst, bar, ts, o, h, l, c, v)

    # --- funding: mildly persistent, correlated with recent trend -----------
    bars_per_8h = max(1, (8 * 3_600_000) // bar_ms)
    funding = np.zeros(n)
    f = 0.0001
    for i in range(0, n, bars_per_8h):
        lb = max(0, i - 24)
        recent = float(np.sum(ret[lb:i])) if i > 0 else 0.0
        f = 0.9 * f + 0.1 * (0.0001 + np.clip(recent * 0.01, -0.0005, 0.0005)) \
            + rng.normal(0, 0.00003)
        funding[i] = np.clip(f, -0.0075, 0.0075)
    candles.funding = funding
    return candles


def _rebuild_prices(candles: Candles, ret: np.ndarray, s0: float,
                    rng: np.random.Generator) -> None:
    """Rewrite o/h/l/c from a per-bar log-return series, keeping ts/v/funding."""
    logp = np.log(s0) + np.cumsum(ret)
    c = np.exp(logp)
    n = len(c)
    o = np.empty(n)
    o[0] = s0
    o[1:] = c[:-1]
    wick = np.abs(rng.normal(0, 0.4, n)) * np.abs(ret + 1e-6) * c
    candles.o, candles.c = o, c
    candles.h = np.maximum(o, c) + wick
    candles.l = np.minimum(o, c) - wick


def generate_universe(bar: str = "1H", n: int = 12000, seed: int = 7,
                      lead_lag: float = 0.25) -> list[Candles]:
    """A small universe of synthetic perpetuals. The first instrument (SYNA)
    is the leader: SYNB's returns partially follow SYNA's previous bar, an
    exploitable cross-asset lead-lag like BTC leading alts."""
    out = []
    for k, name in enumerate(["SYNA-USDT-SWAP", "SYNB-USDT-SWAP", "SYNC-USDT-SWAP"]):
        out.append(generate(inst=name, bar=bar, n=n, seed=seed + 100 * k, s0=50.0 * (k + 1)))
    if lead_lag > 0 and len(out) >= 2:
        leader, follower = out[0], out[1]
        rng = np.random.default_rng(seed + 999)
        r_lead = np.concatenate(([0.0], np.diff(np.log(leader.c))))
        r_fol = np.concatenate(([0.0], np.diff(np.log(follower.c))))
        blended = r_fol.copy()
        blended[1:] = r_fol[1:] * (1 - lead_lag * 0.5) + lead_lag * r_lead[:-1]
        _rebuild_prices(follower, blended, 100.0, rng)
    return out
