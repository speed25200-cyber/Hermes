"""Risk engine — the last line of defence before any order is sent.

Responsibilities:
  * clamp exposures (per-instrument and gross leverage caps)
  * daily loss limit  -> flatten and halt until next UTC day
  * max drawdown kill switch -> flatten and halt permanently (manual reset)
  * order sanity (min/max notional)
  * leverage governor: autonomously scales the whole book with live,
    realized performance — risk comes off fast in drawdown, goes back on
    slowly, and above 1x only when the live track record has earned it

The engine is deliberately stateful and persisted: a restart must not reset
a tripped kill switch (nor an earned/lost governor boost).
"""

from __future__ import annotations

import datetime as dt
import json
import math
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

    def check_order(self, notional: float, closing: bool = False
                    ) -> tuple[bool, str]:
        """`closing` marks an order that takes a position to flat.

        The minimum-notional floor exists to stop the book churning on
        rebalances too small to be worth their fees. Applied to an exit it
        does the opposite of its job: a position below the floor can never be
        closed, because every order that would close it is smaller than the
        floor. Measured on the live book, an empty registry left 22 dust
        positions that would have been retried and rejected every fifteen
        minutes indefinitely, bleeding funding the whole time.

        Entering below the floor is noise. Leaving below it is the only way
        out, so the floor does not apply.
        """
        n = abs(notional)
        if n < self.min_trade_notional and not closing:
            return False, f"below min notional ({n:.2f} < {self.min_trade_notional})"
        if n > self.max_order_notional:
            return False, f"above max order notional ({n:.2f} > {self.max_order_notional})"
        return True, ""


@dataclass
class LeverageGovernor:
    """Autonomous exposure throttle, applied to the whole book every cycle.

    Two forces, deliberately asymmetric:

    * risk-OFF (fast, unconditional): as live drawdown from the equity peak
      grows past ``derisk_start`` the multiplier shrinks linearly, reaching
      ``floor`` at ``derisk_full`` — well before the kill switch. Losing
      streaks cut exposure automatically.
    * risk-ON (slow, earned): the multiplier climbs above 1.0 only after at
      least ``min_track`` live cycles whose realized Sharpe beats
      ``boost_sharpe`` while drawdown stays under ``boost_dd``. It ramps a
      small ``step_up`` per cycle (days to reach ``max_boost``) and decays
      ``step_down`` per cycle — four times faster — the moment conditions
      fail. Favourable conditions raise leverage; the hard caps of the
      RiskEngine still bound everything above.
    """

    max_boost: float = 1.5      # ceiling on the earned risk-on multiplier
    floor: float = 0.25         # de-risk floor (never fully blind the book)
    window: int = 672           # live cycles kept (7 days of 15m bars)
    min_track: int = 192        # cycles required before any boost (2 days)
    boost_sharpe: float = 1.0   # live ann. Sharpe needed to earn risk-on
    boost_dd: float = 0.02      # max drawdown tolerated while boosting
    derisk_start: float = 0.05  # drawdown where de-risking begins
    derisk_full: float = 0.12   # drawdown where the floor is reached
    step_up: float = 0.005      # boost ramp per cycle
    step_down: float = 0.02     # boost decay per cycle (4x faster than up)
    bars_per_year: int = 35040  # cycle frequency for annualising (15m)

    boost: float = 1.0
    equity_hist: list = field(default_factory=list)
    last_mult: float = 1.0

    def _live_sharpe(self) -> float:
        eq = self.equity_hist
        n = len(eq)
        if n < 3:
            return 0.0
        rets = [eq[i] / eq[i - 1] - 1.0 for i in range(1, n)]
        mu = sum(rets) / len(rets)
        var = sum((r - mu) ** 2 for r in rets) / max(1, len(rets) - 1)
        sd = math.sqrt(var)
        if sd < 1e-12:
            # zero-variance track: infinitely good if positive, else worthless
            return float("inf") if mu > 0 else 0.0
        return mu / sd * math.sqrt(self.bars_per_year)

    def update(self, equity: float, peak_equity: float) -> float:
        """Feed the cycle's equity; returns the exposure multiplier."""
        self.equity_hist.append(float(equity))
        if len(self.equity_hist) > self.window:
            self.equity_hist = self.equity_hist[-self.window:]

        dd = 1.0 - equity / peak_equity if peak_equity > 0 else 0.0

        earned = (len(self.equity_hist) >= self.min_track
                  and dd <= self.boost_dd
                  and self._live_sharpe() >= self.boost_sharpe)
        if earned:
            self.boost = min(self.max_boost, self.boost + self.step_up)
        else:
            self.boost = max(1.0, self.boost - self.step_down)

        if dd <= self.derisk_start:
            f = 1.0
        elif dd >= self.derisk_full:
            f = self.floor
        else:
            t = (dd - self.derisk_start) / (self.derisk_full - self.derisk_start)
            f = 1.0 + t * (self.floor - 1.0)

        self.last_mult = max(self.floor, min(self.max_boost, self.boost * f))
        return self.last_mult

    def to_dict(self) -> dict:
        return {"boost": self.boost, "last_mult": self.last_mult,
                "equity_hist": self.equity_hist[-self.window:]}

    def from_dict(self, d: dict) -> None:
        self.boost = float(d.get("boost", 1.0))
        self.last_mult = float(d.get("last_mult", 1.0))
        self.equity_hist = list(d.get("equity_hist", []))
