"""Vectorized backtest engine for a single instrument.

Convention: `pos[i]` is the target exposure (fraction of equity, signed,
leverage allowed) decided at the close of bar i. It earns the return of bar
i+1. Transaction costs are charged on |pos[i] - pos[i-1]|; funding is charged
on the position held into the funding bar (long pays positive funding).
"""

from __future__ import annotations

import numpy as np

from ..data.store import BARS_PER_YEAR, Candles
from . import metrics


class BacktestResult:
    __slots__ = ("rets", "equity", "pos", "turnover", "stats")

    def __init__(self, rets, equity, pos, turnover, stats):
        self.rets = rets
        self.equity = equity
        self.pos = pos
        self.turnover = turnover
        self.stats = stats


def run(
    candles: Candles,
    pos: np.ndarray,
    fee_bps: float = 5.0,
    slippage_bps: float = 2.0,
    n_trials: int = 1,
) -> BacktestResult:
    n = len(candles)
    pos = np.nan_to_num(np.asarray(pos, dtype=np.float64), nan=0.0)
    if len(pos) != n:
        raise ValueError(f"pos length {len(pos)} != candles length {n}")

    mkt_ret = candles.returns
    cost_rate = (fee_bps + slippage_bps) * 1e-4

    prev_pos = np.concatenate(([0.0], pos[:-1]))          # held into bar i
    trade_size = np.abs(pos - prev_pos)                    # traded at close i
    # bar i pnl: position held during bar i (decided at close i-1) times ret i
    gross = prev_pos * mkt_ret
    costs = trade_size * cost_rate
    funding_cost = prev_pos * candles.funding              # charged into bar
    rets = gross - costs - funding_cost
    rets = np.clip(rets, -0.95, 10.0)                      # ruin guard

    equity = np.cumprod(1.0 + rets)
    turnover = float(trade_size.mean()) if n else 0.0
    bpy = BARS_PER_YEAR[candles.bar]
    stats = metrics.summarize(rets, equity, bpy, turnover, n_trials)
    return BacktestResult(rets, equity, pos, turnover, stats)
