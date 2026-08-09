"""Broker abstraction: identical interface for paper trading and live OKX.

Positions are expressed in coin quantity (signed, net mode). The trader layer
thinks purely in exposures and quantities; only OKXBroker knows about
contracts (ctVal / lotSz).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from .okx_client import OKXClient, OKXError


@dataclass
class Fill:
    inst: str
    side: str          # "buy" | "sell"
    qty: float         # coin quantity (positive)
    price: float
    fee: float         # USDT paid
    ts: float


class Broker:
    """Interface."""

    def equity(self) -> float:
        raise NotImplementedError

    def positions(self) -> dict[str, float]:
        """inst -> signed coin qty."""
        raise NotImplementedError

    def market_order(self, inst: str, qty: float, price_hint: float) -> Fill | None:
        """qty signed (+ buy / - sell), in coin units."""
        raise NotImplementedError

    def mark_prices(self, prices: dict[str, float]) -> None:
        """Feed latest close prices (paper broker uses them for MTM/fills)."""


# --------------------------------------------------------------------- #


@dataclass
class PaperBroker(Broker):
    cash: float = 10000.0
    fee_bps: float = 5.0
    slippage_bps: float = 2.0
    pos: dict[str, float] = field(default_factory=dict)      # inst -> qty
    prices: dict[str, float] = field(default_factory=dict)   # inst -> last px
    fills: list[Fill] = field(default_factory=list)

    def mark_prices(self, prices: dict[str, float]) -> None:
        self.prices.update(prices)

    def equity(self) -> float:
        eq = self.cash
        for inst, q in self.pos.items():
            eq += q * self.prices.get(inst, 0.0)
        return eq

    def positions(self) -> dict[str, float]:
        return {k: v for k, v in self.pos.items() if abs(v) > 1e-12}

    def market_order(self, inst: str, qty: float, price_hint: float) -> Fill | None:
        if qty == 0 or price_hint <= 0:
            return None
        side = "buy" if qty > 0 else "sell"
        slip = self.slippage_bps * 1e-4
        px = price_hint * (1 + slip) if qty > 0 else price_hint * (1 - slip)
        notional = abs(qty) * px
        fee = notional * self.fee_bps * 1e-4
        self.cash -= qty * px
        self.cash -= fee
        self.pos[inst] = self.pos.get(inst, 0.0) + qty
        if abs(self.pos[inst]) < 1e-12:
            self.pos.pop(inst, None)
        fill = Fill(inst, side, abs(qty), px, fee, time.time())
        self.fills.append(fill)
        return fill

    def apply_funding(self, inst: str, rate: float) -> None:
        """Long pays positive funding on notional."""
        q = self.pos.get(inst, 0.0)
        px = self.prices.get(inst, 0.0)
        if q and px:
            self.cash -= q * px * rate

    # persistence ------------------------------------------------------- #

    def to_dict(self) -> dict:
        return {"cash": self.cash, "pos": self.pos, "prices": self.prices}

    def restore(self, d: dict) -> None:
        self.cash = d.get("cash", self.cash)
        self.pos = dict(d.get("pos", {}))
        self.prices = dict(d.get("prices", {}))


# --------------------------------------------------------------------- #


class OKXBroker(Broker):
    def __init__(self, client: OKXClient, td_mode: str = "cross", log=None):
        self.client = client
        self.td_mode = td_mode
        self.log = log or (lambda m: None)
        self._specs: dict[str, dict] = {}

    def _spec(self, inst: str) -> dict:
        if inst not in self._specs:
            for row in self.client.instruments("SWAP"):
                self._specs[row["instId"]] = {
                    "ctVal": float(row["ctVal"]),
                    "lotSz": float(row["lotSz"]),
                    "minSz": float(row["minSz"]),
                }
        if inst not in self._specs:
            raise OKXError("SPEC", f"unknown instrument {inst}")
        return self._specs[inst]

    def equity(self) -> float:
        return self.client.equity_usdt()

    def positions(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for p in self.client.positions("SWAP"):
            inst = p["instId"]
            if not p.get("pos"):
                continue
            contracts = float(p["pos"])  # signed in net mode
            ct_val = self._spec(inst)["ctVal"]
            out[inst] = contracts * ct_val
        return out

    def market_order(self, inst: str, qty: float, price_hint: float) -> Fill | None:
        spec = self._spec(inst)
        contracts = abs(qty) / spec["ctVal"]
        lot = spec["lotSz"]
        contracts = math.floor(contracts / lot) * lot
        if contracts < spec["minSz"]:
            self.log(f"{inst}: order below min size ({contracts} < {spec['minSz']}), skipped")
            return None
        side = "buy" if qty > 0 else "sell"
        # reduceOnly when this order shrinks the current position
        cur = self.positions().get(inst, 0.0)
        reduce_only = (cur > 0 and qty < 0 and abs(qty) <= cur + 1e-12) or \
                      (cur < 0 and qty > 0 and qty <= -cur + 1e-12)
        sz = f"{contracts:.10f}".rstrip("0").rstrip(".")
        result = self.client.market_order(inst, side, sz, self.td_mode,
                                          reduce_only=reduce_only)
        self.log(f"{inst}: {side} {sz} contracts (ordId={result.get('ordId')})")
        filled_qty = contracts * spec["ctVal"]
        return Fill(inst, side, filled_qty, price_hint, 0.0, time.time())
