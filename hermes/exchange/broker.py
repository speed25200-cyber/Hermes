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


@dataclass
class ExecStats:
    """Realised execution quality, accumulated notional-weighted.

    Every backtest prices trades through `effective_costs`, which blends the
    maker and taker fee by an ASSUMED `maker_miss_rate`. That assumption sits
    underneath every validated Sharpe, so it has to be checked against what
    the exchange actually did rather than trusted: at 15m bars a cost model
    that is wrong by a few bps per trade is the difference between an edge
    and a slow bleed.
    """

    orders: int = 0
    notional: float = 0.0
    maker_notional: float = 0.0
    taker_notional: float = 0.0
    fee_paid: float = 0.0
    # signed cost of the fill price against the decision price, in USDT;
    # positive means the fill was worse than the price the signal saw
    shortfall: float = 0.0

    def record(self, notional: float, maker_notional: float, fee: float,
               shortfall: float) -> None:
        if notional <= 0:
            return
        self.orders += 1
        self.notional += notional
        self.maker_notional += max(maker_notional, 0.0)
        self.taker_notional += max(notional - maker_notional, 0.0)
        self.fee_paid += fee
        self.shortfall += shortfall

    def summary(self) -> dict:
        n = self.notional
        if n <= 0:
            return {"orders": 0, "notional": 0.0}
        return {
            "orders": self.orders,
            "notional": n,
            "maker_share": self.maker_notional / n,
            "fee_bps": self.fee_paid / n * 1e4,
            "shortfall_bps": self.shortfall / n * 1e4,
            "all_in_bps": (self.fee_paid + self.shortfall) / n * 1e4,
        }

    def to_dict(self) -> dict:
        return self.__dict__.copy()

    def restore(self, d: dict) -> None:
        for k, v in (d or {}).items():
            if k in self.__dict__:
                setattr(self, k, type(self.__dict__[k])(v))


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
    entry: dict[str, float] = field(default_factory=dict)    # inst -> avg entry px
    fills: list[Fill] = field(default_factory=list)
    exec_stats: ExecStats = field(default_factory=ExecStats)

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
        old = self.pos.get(inst, 0.0)
        new = old + qty
        # volume-weighted average entry: adding to a position averages in the
        # fill; reducing keeps the entry; flipping through zero restarts it
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
        # the paper broker's costs are the model's own, so this records what
        # the backtest ASSUMES — the live broker records what actually happened
        # and `hermes execution` contrasts the two
        self.exec_stats.record(notional=notional, maker_notional=0.0, fee=fee,
                               shortfall=abs(qty) * abs(px - price_hint))
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
        self.exec_stats = ExecStats()
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
        def fmt(c: float) -> str:
            return f"{c:.10f}".rstrip("0").rstrip(".")

        filled = maker_filled = 0.0
        cost = fee_paid = 0.0        # sum(px * contracts) and USDT fees
        if self.prefer_maker:
            maker_filled, m_px, m_fee = self._maker_fill(
                inst, side, fmt(contracts), reduce_only)
            filled += maker_filled
            cost += m_px * maker_filled
            fee_paid += m_fee
        remaining = math.floor((contracts - filled) / lot) * lot
        if remaining >= spec["minSz"]:
            result = self.client.market_order(inst, side, fmt(remaining),
                                              self.td_mode,
                                              reduce_only=reduce_only)
            ord_id = result.get("ordId", "")
            t_px, t_fee = self._settled(inst, ord_id, price_hint)
            self.log(f"{inst}: {side} {fmt(remaining)} contracts TAKER "
                     f"@ {t_px:.6g} (ordId={ord_id})")
            filled += remaining
            cost += t_px * remaining
            fee_paid += t_fee
        if filled <= 0:
            return None

        ct_val = spec["ctVal"]
        qty = filled * ct_val
        avg_px = (cost / filled) if filled > 0 else price_hint
        # implementation shortfall: what the fill cost against the price the
        # signal actually decided on, signed so adverse fills are positive
        adverse = (avg_px - price_hint) if side == "buy" else (price_hint - avg_px)
        self.exec_stats.record(notional=qty * avg_px,
                               maker_notional=maker_filled * ct_val * avg_px,
                               fee=fee_paid, shortfall=qty * adverse)
        return Fill(inst, side, qty, avg_px, fee_paid, time.time())

    def _settled(self, inst: str, ord_id: str,
                 price_hint: float) -> tuple[float, float]:
        """Average fill price and fee actually charged for an order.

        Falls back to the decision price with a zero fee only if the exchange
        cannot be queried — that path understates cost, so it is logged rather
        than folded silently into the statistics.
        """
        if not ord_id:
            return price_hint, 0.0
        try:
            st = self.client.order_status(inst, ord_id)
        except OKXError as exc:
            self.log(f"{inst}: could not read fill detail for {ord_id} ({exc}); "
                     f"execution stats will understate cost")
            return price_hint, 0.0
        try:
            px = float(st.get("avgPx") or 0.0) or price_hint
        except (TypeError, ValueError):
            px = price_hint
        try:
            # OKX reports fee negative when charged, positive for a rebate
            fee = -float(st.get("fee") or 0.0)
        except (TypeError, ValueError):
            fee = 0.0
        return px, fee

    def _maker_fill(self, inst: str, side: str, sz: str,
                    reduce_only: bool) -> tuple[float, float, float]:
        """Post-only limit at the touch. Returns (contracts filled, average
        fill price, fee charged); the caller sends the remainder as a taker
        order. A partial fill is normal and is reported as such."""
        try:
            tick = self.client.ticker(inst)
            px = tick.get("bidPx") if side == "buy" else tick.get("askPx")
            if not px:
                return 0.0, 0.0, 0.0
            result = self.client.place_order(inst, side, sz, "post_only",
                                             px=str(px), td_mode=self.td_mode,
                                             reduce_only=reduce_only)
            ord_id = result.get("ordId", "")
            deadline = time.time() + self.maker_wait_s
            st: dict = {}
            while time.time() < deadline:
                self._sleep(min(2.0, self.maker_wait_s / 4))
                st = self.client.order_status(inst, ord_id)
                state = st.get("state", "")
                if state == "filled":
                    acc = float(st.get("accFillSz") or sz)
                    avg, fee = self._fill_detail(st, float(px))
                    self.log(f"{inst}: {side} {sz} contracts MAKER @ {avg:.6g}")
                    return acc, avg, fee
                if state in ("canceled", "mmp_canceled"):
                    # post-only rejected (would have crossed) or external cancel
                    acc = float(st.get("accFillSz") or 0.0)
                    avg, fee = self._fill_detail(st, float(px))
                    return acc, avg, fee
            try:
                self.client.cancel_order(inst, ord_id)
            except OKXError:
                pass  # cancel can race a fill; final status below decides
            st = self.client.order_status(inst, ord_id)
            acc = float(st.get("accFillSz") or 0.0)
            avg, fee = self._fill_detail(st, float(px))
            if acc > 0:
                self.log(f"{inst}: {side} {acc} contracts MAKER @ {avg:.6g} "
                         f"(partial)")
            return acc, avg, fee
        except OKXError as exc:
            self.log(f"{inst}: maker attempt failed ({exc}), falling back")
            return 0.0, 0.0, 0.0

    @staticmethod
    def _fill_detail(status: dict, fallback_px: float) -> tuple[float, float]:
        """(average fill price, fee charged) from an order-status payload."""
        try:
            px = float(status.get("avgPx") or 0.0) or fallback_px
        except (TypeError, ValueError):
            px = fallback_px
        try:
            fee = -float(status.get("fee") or 0.0)   # negative when charged
        except (TypeError, ValueError):
            fee = 0.0
        return px, fee
