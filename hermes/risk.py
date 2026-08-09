"""Risk engine — the last line of defence before any order is sent.

Responsibilities:
  * clamp exposures (per-instrument and gross leverage caps)
  * daily loss limit  -> flatten and halt until next UTC day
  * max drawdown kill switch -> flatten and halt permanently (manual reset)
  * order sanity (min/max notional)

The engine is deliberately stateful and persisted: a restart must not reset
a tripped kill switch.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from dataclasses import dataclass, field


def _utc_day(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")


@dataclass
class RiskState:
    peak_equity: float = 0.0
    day: str = ""
    day_start_equity: float = 0.0
    halted_today: bool = False
    killed: bool = False
    kill_reason: str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, d: dict) -> "RiskState":
        s = cls()
        s.__dict__.update(d)
        return s


@dataclass
class RiskEngine:
    max_gross_leverage: float = 2.0
    max_instrument_leverage: float = 1.0
    daily_loss_limit_pct: float = 3.0
    max_drawdown_pct: float = 15.0
    min_trade_notional: float = 10.0
    max_order_notional: float = 25000.0
    state_path: str | None = None
    state: RiskState = field(default_factory=RiskState)

    def load(self) -> None:
        if self.state_path and os.path.exists(self.state_path):
            with open(self.state_path) as f:
                self.state = RiskState.from_dict(json.load(f))

    def save(self) -> None:
        if self.state_path:
            os.makedirs(os.path.dirname(self.state_path) or ".", exist_ok=True)
            with open(self.state_path, "w") as f:
                json.dump(self.state.to_dict(), f, indent=2)

    # ------------------------------------------------------------------ #

    def update_equity(self, equity: float, now_ts: float) -> None:
        """Feed the latest account equity; may trip halts. Call every cycle."""
        s = self.state
        day = _utc_day(now_ts)
        if day != s.day:
            s.day = day
            s.day_start_equity = equity
            s.halted_today = False
        s.peak_equity = max(s.peak_equity, equity)

        if s.peak_equity > 0:
            dd = 1.0 - equity / s.peak_equity
            if dd * 100.0 >= self.max_drawdown_pct and not s.killed:
                s.killed = True
                s.kill_reason = (
                    f"max drawdown {dd:.1%} >= {self.max_drawdown_pct}% "
                    f"(equity {equity:.2f}, peak {s.peak_equity:.2f})"
                )
        if s.day_start_equity > 0:
            day_loss = 1.0 - equity / s.day_start_equity
            if day_loss * 100.0 >= self.daily_loss_limit_pct:
                s.halted_today = True
        self.save()

    @property
    def trading_allowed(self) -> bool:
        return not (self.state.killed or self.state.halted_today)

    @property
    def must_flatten(self) -> bool:
        """When tripped, all positions must be closed immediately."""
        return self.state.killed or self.state.halted_today

    def reset_kill(self) -> None:
        self.state.killed = False
        self.state.kill_reason = ""
        self.save()

    # ------------------------------------------------------------------ #

    def clamp_targets(self, targets: dict[str, float]) -> dict[str, float]:
        """Clamp per-instrument exposures and total gross leverage.
        `targets` maps instrument -> signed exposure (fraction of equity)."""
        out = {
            inst: max(-self.max_instrument_leverage,
                      min(self.max_instrument_leverage, exp))
            for inst, exp in targets.items()
        }
        gross = sum(abs(e) for e in out.values())
        if gross > self.max_gross_leverage and gross > 0:
            scale = self.max_gross_leverage / gross
            out = {inst: e * scale for inst, e in out.items()}
        return out

    def check_order(self, notional: float) -> tuple[bool, str]:
        n = abs(notional)
        if n < self.min_trade_notional:
            return False, f"below min notional ({n:.2f} < {self.min_trade_notional})"
        if n > self.max_order_notional:
            return False, f"above max order notional ({n:.2f} > {self.max_order_notional})"
        return True, ""
