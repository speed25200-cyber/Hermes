"""Broker abstraction: identical interface for paper trading and live OKX.

Positions are expressed in coin quantity (signed, net mode). The trader layer
thinks purely in exposures and quantities; only OKXBroker knows about
contracts (ctVal / lotSz).
"""

from __future__ import annotations

import math
import time
import uuid
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

    def market_order(self, inst: str, qty: float, price_hint: float,
                     force_taker: bool = False) -> Fill | None:
        """qty signed (+ buy / - sell), in coin units."""
        raise NotImplementedError

    def mark_prices(self, prices: dict[str, float]) -> None:
        """Feed latest close prices (paper broker uses them for MTM/fills)."""


# --------------------------------------------------------------------- #


@dataclass
class PaperBroker(Broker):
    cash: float = 10000.0
    fee_bps: float = 5.0          # taker
    maker_fee_bps: float = 2.0    # join the book
    slippage_bps: float = 2.0     # used only when bid/ask missing
    pos: dict[str, float] = field(default_factory=dict)
    prices: dict[str, float] = field(default_factory=dict)
    entry: dict[str, float] = field(default_factory=dict)
    fills: list[Fill] = field(default_factory=list)
    book: dict[str, dict] = field(default_factory=dict)   # inst -> bid/ask/last
    specs: dict[str, dict] = field(default_factory=dict)  # ctVal/lotSz/minSz

    def set_specs(self, specs: dict[str, dict]) -> None:
        self.specs = dict(specs)

    def mark_prices(self, prices: dict[str, float]) -> None:
        self.prices.update(prices)
        self._maybe_liquidate()

    def mark_ticks(self, ticks: dict[str, dict]) -> None:
        """OKX ticker snapshot: last/bid/ask. Fills use bid/ask, MTM uses last."""
        for inst, t in (ticks or {}).items():
            last = float(t.get("last") or 0.0)
            bid = float(t.get("bid") or 0.0)
            ask = float(t.get("ask") or 0.0)
            if last > 0:
                self.prices[inst] = last
            self.book[inst] = {"last": last, "bid": bid, "ask": ask}
        self._maybe_liquidate()

    def _maybe_liquidate(self) -> None:
        """USDT-M: wipe when equity ≤ ~maintenance (0.4% of notional), like ~20x."""
        notion = 0.0
        for inst, q in self.pos.items():
            notion += abs(q) * float(self.prices.get(inst) or 0.0)
        if notion <= 0:
            return
        eq = self.equity()
        if eq > 0.004 * notion and eq > 0:
            return
        for inst, q in list(self.pos.items()):
            px = float(self.prices.get(inst) or 0.0)
            if px > 0 and abs(q) > 0:
                self.market_order(inst, -q, px, force_taker=True)
        self.cash = max(self.cash, 0.0)

    def equity(self) -> float:
        eq = self.cash
        for inst, q in self.pos.items():
            eq += q * self.prices.get(inst, 0.0)
        return eq

    def positions(self) -> dict[str, float]:
        return {k: v for k, v in self.pos.items() if abs(v) > 1e-12}

    def _round_qty(self, inst: str, qty: float) -> float:
        spec = self.specs.get(inst)
        if not spec or qty == 0:
            return qty
        ct = float(spec.get("ctVal") or 0.0)
        lot = float(spec.get("lotSz") or 0.0)
        mn = float(spec.get("minSz") or 0.0)
        if ct <= 0 or lot <= 0:
            return qty
        contracts = abs(qty) / ct
        contracts = math.floor(contracts / lot + 1e-12) * lot
        if contracts < mn:
            return 0.0
        return math.copysign(contracts * ct, qty)

    def _taker_px(self, inst: str, qty: float, price_hint: float) -> float:
        b = self.book.get(inst) or {}
        bid, ask = float(b.get("bid") or 0.0), float(b.get("ask") or 0.0)
        if bid > 0 and ask > bid:
            return ask if qty > 0 else bid
        slip = self.slippage_bps * 1e-4
        hint = price_hint or float(self.prices.get(inst) or 0.0)
        if hint <= 0:
            return 0.0
        return hint * (1 + slip) if qty > 0 else hint * (1 - slip)

    def _maker_px(self, inst: str, qty: float, price_hint: float) -> float:
        """Join the queue: capture 75% of the spread, not the last print."""
        b = self.book.get(inst) or {}
        bid, ask = float(b.get("bid") or 0.0), float(b.get("ask") or 0.0)
        if bid > 0 and ask > bid:
            spr = ask - bid
            return (bid + 0.25 * spr) if qty > 0 else (ask - 0.25 * spr)
        hint = price_hint or float(self.prices.get(inst) or 0.0)
        return hint

    def market_order(self, inst: str, qty: float, price_hint: float,
                     force_taker: bool = False) -> Fill | None:
        qty = self._round_qty(inst, qty)
        if qty == 0 or (price_hint <= 0 and not (self.book.get(inst) or {}).get("bid")):
            return None
        if force_taker:
            px = self._taker_px(inst, qty, price_hint)
            fee_bps = self.fee_bps
        else:
            px = self._maker_px(inst, qty, price_hint)
            fee_bps = self.maker_fee_bps
        if px <= 0:
            return None
        side = "buy" if qty > 0 else "sell"
        notional = abs(qty) * px
        fee = notional * fee_bps * 1e-4
        self.cash -= qty * px
        self.cash -= fee
        old = self.pos.get(inst, 0.0)
        new = old + qty
        if old == 0.0 or old * qty > 0:
            tot = abs(old) + abs(qty)
            self.entry[inst] = ((abs(old) * self.entry.get(inst, px)
                                 + abs(qty) * px) / tot)
        elif old * new < 0:
            self.entry[inst] = px
        self.pos[inst] = new
        if abs(self.pos[inst]) < 1e-12:
            self.pos.pop(inst, None)
            self.entry.pop(inst, None)
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
        return {"cash": self.cash, "pos": self.pos, "prices": self.prices,
                "entry": self.entry}

    def restore(self, d: dict) -> None:
        self.cash = d.get("cash", self.cash)
        self.pos = dict(d.get("pos", {}))
        self.prices = dict(d.get("prices", {}))
        self.entry = dict(d.get("entry", {}))


# --------------------------------------------------------------------- #


class OKXBroker(Broker):
    def __init__(self, client: OKXClient, td_mode: str = "cross", log=None,
                 prefer_maker: bool = True, maker_wait_s: float = 20.0,
                 sleep_fn=time.sleep):
        self.client = client
        self.td_mode = td_mode
        self.log = log or (lambda m: None)
        self.prefer_maker = prefer_maker
        self.maker_wait_s = maker_wait_s
        self._sleep = sleep_fn
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

    def market_order(self, inst: str, qty: float, price_hint: float,
                     force_taker: bool = False) -> Fill | None:
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

        def fmt(c: float) -> str:
            return f"{c:.10f}".rstrip("0").rstrip(".")

        filled = 0.0
        use_maker = self.prefer_maker and not force_taker
        if use_maker:
            filled = self._maker_fill(inst, side, fmt(contracts), reduce_only)
        remaining = math.floor((contracts - filled) / lot) * lot
        if remaining >= spec["minSz"]:
            cl_id = uuid.uuid4().hex[:32]
            try:
                result = self.client.market_order(
                    inst, side, fmt(remaining), self.td_mode,
                    reduce_only=reduce_only, cl_ord_id=cl_id)
            except OKXError as exc:
                recovered = self._recover_cl_ord(inst, cl_id)
                if recovered is None:
                    self.log(f"{inst}: taker failed ({exc})")
                    result = None
                else:
                    result = recovered
            except Exception as exc:
                recovered = self._recover_cl_ord(inst, cl_id)
                if recovered is None:
                    self.log(f"{inst}: taker transport error ({type(exc).__name__}: {exc})")
                    result = None
                else:
                    result = recovered
                    self.log(f"{inst}: recovered taker via clOrdId={cl_id}")
            taker_filled = self._confirmed_fill(inst, result, remaining)
            if result is not None:
                self.log(f"{inst}: {side} {taker_filled:g}/{remaining:g} contracts TAKER "
                         f"(ordId={result.get('ordId')})")
            filled += taker_filled
        if filled <= 0:
            return None
        return Fill(inst, side, filled * spec["ctVal"], price_hint, 0.0,
                    time.time())

    def _recover_cl_ord(self, inst: str, cl_id: str) -> dict | None:
        lookup = getattr(self.client, "order_by_cl_ord_id", None)
        if lookup is None:
            return None
        try:
            return lookup(inst, cl_id)
        except OKXError:
            return None

    def _confirmed_fill(self, inst: str, result: dict | None,
                        requested: float) -> float:
        """Prefer exchange accFillSz on a *terminal* fill state.

        A 'live' status after a market order is usually a race; do not treat
        a leftover maker accFillSz as the taker fill (that under-counts).
        """
        if not result:
            return 0.0
        ord_id = result.get("ordId")
        if ord_id and hasattr(self.client, "order_status"):
            try:
                st = self.client.order_status(inst, ord_id)
                state = st.get("state", "")
                acc = float(st.get("accFillSz") or 0.0)
                if state in ("filled", "partially_filled") and acc > 0:
                    return acc
            except (OKXError, TypeError, ValueError):
                pass
        if result.get("ordId") or result.get("clOrdId"):
            return requested
        return 0.0

    def _maker_fill(self, inst: str, side: str, sz: str,
                    reduce_only: bool) -> float:
        """Post-only limit at the touch. Returns contracts filled (possibly
        partial); the caller sends the remainder as a taker order."""
        try:
            tick = self.client.ticker(inst)
            px = tick.get("bidPx") if side == "buy" else tick.get("askPx")
            if not px:
                return 0.0
            result = self.client.place_order(inst, side, sz, "post_only",
                                             px=str(px), td_mode=self.td_mode,
                                             reduce_only=reduce_only,
                                             cl_ord_id=uuid.uuid4().hex[:32])
            ord_id = result.get("ordId", "")
            deadline = time.time() + self.maker_wait_s
            st: dict = {}
            while time.time() < deadline:
                self._sleep(min(2.0, self.maker_wait_s / 4))
                st = self.client.order_status(inst, ord_id)
                state = st.get("state", "")
                if state == "filled":
                    self.log(f"{inst}: {side} {sz} contracts MAKER @ {px}")
                    return float(st.get("accFillSz") or sz)
                if state in ("canceled", "mmp_canceled"):
                    # post-only rejected (would have crossed) or external cancel
                    return float(st.get("accFillSz") or 0.0)
            try:
                self.client.cancel_order(inst, ord_id)
            except OKXError:
                pass  # cancel can race a fill; final status below decides
            st = self.client.order_status(inst, ord_id)
            acc = float(st.get("accFillSz") or 0.0)
            if acc > 0:
                self.log(f"{inst}: {side} {acc} contracts MAKER @ {px} (partial)")
            return acc
        except OKXError as exc:
            self.log(f"{inst}: maker attempt failed ({exc}), falling back")
            return 0.0
