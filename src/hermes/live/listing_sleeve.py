"""New-listing short sleeve: a second, weakly correlated return stream run next to the book.

Rule (docs/RESULTS.md, § 17; research code in research/leverage_2026-09/newlisting): short every newly listed Binance
USDT-M perpetual whose token is new -- no Binance spot market, or one opened at most ``new_token_days`` before the
perpetual -- and that OKX lists, from ``entry_hours`` to ``exit_hours`` after the perpetual's launch, hedged with a BTC
long of ``hedge_beta`` times the notional, with a stop ``stop`` above the entry. New tokens tend to drift down in their
first week (airdrop and unlock selling). Selected in-sample (2022-2024) by a rule fixed in advance: Sharpe 2.34; out
of sample (2025-01 -> 2026-08, OKX prices) 1.40, 2025 +37 %, 2026 +27 %, correlation with the book -0.09. It did not
pass the promotion bar on its own (leave-one-month-out 0.8, wide bootstrap interval), hence paper only: a forward test.

Sizing as in research: at entry, notional = NAV x leverage / slots x clip(sigma_ref / sigma, 0.25, 1), where sigma is
the coin's realised daily volatility since listing (scale 0.5 with less than 12 hours of data), and the sleeve's short
notional never exceeds leverage x NAV. Quantities stay fixed until the exit, as in research. The sleeve tracks its own
trades; the book is decided on the positions net of them, and the two target lists are added before execution.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from hermes.config import ListingSleeveConfig
from hermes.execution.okx.instruments import okx_inst_id
from hermes.live.state import StateStore

log = logging.getLogger(__name__)

HEDGE = "BTCUSDT"
STATE_KEY = "listing_sleeve"


@dataclass
class ListingTrade:
    symbol: str
    listed: str  # perpetual launch time (UTC ISO)
    entry: str
    exit_due: str
    qty: float  # signed coin quantity (negative: short)
    entry_px: float
    hedge_qty: float  # BTC quantity (positive: long)
    hedge_px: float
    stop_px: float | None


class ListingSleeve:
    def __init__(self, cfg: ListingSleeveConfig, store: StateStore):
        self.cfg = cfg
        self.store = store
        st = store.get(STATE_KEY) or {}
        st = st if isinstance(st, dict) else {}
        self.open: list[ListingTrade] = [ListingTrade(**t) for t in st.get("open", []) if isinstance(t, dict)]
        self.done: list[dict[str, object]] = list(st.get("done", []) or [])
        self.listings: dict[str, dict[str, object]] = dict(st.get("listings", {}) or {})  # symbol -> launch, newtok
        self.calendar_at: str | None = st.get("calendar_at")  # type: ignore[assignment]

    # -- calendar ---------------------------------------------------------------------------------------------
    async def refresh(self, feed: object, now: pd.Timestamp) -> None:
        """New perpetuals launched within the holding window (Binance exchangeInfo), with the age of their token's
        oldest Binance spot market; at most every six hours, cached in the state store."""
        if self.calendar_at is not None and now - pd.Timestamp(self.calendar_at) < pd.Timedelta(hours=6):
            return
        launches: dict[str, int] = await feed.perp_listings()  # type: ignore[attr-defined]
        horizon = now - pd.Timedelta(hours=self.cfg.exit_hours)
        for sym, ms in launches.items():
            t0 = pd.Timestamp(ms, unit="ms", tz="UTC")
            if t0 < horizon or sym in self.listings or sym == HEDGE:
                continue
            spot = await feed.spot_first_open(sym)  # type: ignore[attr-defined]
            newtok = spot is None or (t0 - spot) <= pd.Timedelta(days=self.cfg.new_token_days)
            self.listings[sym] = {"launch": t0.isoformat(), "new_token": bool(newtok)}
        # Listings whose window has passed are no longer needed.
        self.listings = {s: v for s, v in self.listings.items() if pd.Timestamp(str(v["launch"])) >= horizon}
        self.calendar_at = now.isoformat()
        self._save()

    def due(self, now: pd.Timestamp) -> list[str]:
        """New-token listings inside their entry window and not yet traded."""
        held = {t.symbol for t in self.open} | {str(t.get("symbol")) for t in self.done}
        out = []
        start, end = pd.Timedelta(hours=self.cfg.entry_hours), pd.Timedelta(hours=self.cfg.exit_hours)
        for sym, v in self.listings.items():
            t0 = pd.Timestamp(str(v["launch"]))
            if v.get("new_token") and sym not in held and t0 + start <= now < t0 + end:
                out.append(sym)
        return sorted(out)

    def symbols_needed(self, now: pd.Timestamp) -> list[str]:
        """Contracts whose prices the next decision needs (open trades, entries due, the hedge)."""
        syms = {t.symbol for t in self.open} | set(self.due(now))
        return sorted(syms | {HEDGE}) if syms else []

    # -- positions --------------------------------------------------------------------------------------------
    def holdings(self, prices: dict[str, float]) -> dict[str, float]:
        """Notional the sleeve holds per contract at ``prices`` (the book is decided on positions net of it)."""
        out: dict[str, float] = {}
        for t in self.open:
            px = prices.get(t.symbol, t.entry_px)
            out[t.symbol] = out.get(t.symbol, 0.0) + t.qty * px
            if t.hedge_qty:
                hpx = prices.get(HEDGE, t.hedge_px)
                out[HEDGE] = out.get(HEDGE, 0.0) + t.hedge_qty * hpx
        return out

    def reconcile(self, held: dict[str, float], prices: dict[str, float], now: pd.Timestamp) -> None:
        """Forget trades whose short is no longer on the account (flattened by a halt, closed by hand, an order
        that never filled): the sleeve never re-targets a position the account does not hold."""
        for t in [t for t in self.open if not held.get(t.symbol, 0.0) < 0]:
            self._close(t, prices.get(t.symbol, t.entry_px), prices, now, "gone")
        self._save()

    def on_stops(self, fills: dict[str, float | None], prices: dict[str, float], now: pd.Timestamp) -> None:
        """Close the trades whose coin leg was stopped out (paper stop or exchange-side stop) at the fill price."""
        for t in [t for t in self.open if t.symbol in fills]:
            px = fills[t.symbol] or t.stop_px or prices.get(t.symbol, t.entry_px)
            self._close(t, float(px), prices, now, "stop")
        self._save()

    def targets(
        self,
        now: pd.Timestamp,
        prices: dict[str, float],
        nav: float,
        tradable: set[str],
        vol_daily: dict[str, float],
        entries: bool = True,
    ) -> dict[str, float]:
        """Target notional per contract after the exits and (when ``entries``) the entries due at ``now``."""
        c = self.cfg
        for t in list(self.open):
            if now >= pd.Timestamp(t.exit_due):
                self._close(t, prices.get(t.symbol, t.entry_px), prices, now, "end")
        hpx = prices.get(HEDGE)
        if entries and hpx and np.isfinite(hpx):
            for sym in self.due(now):
                px = prices.get(sym)
                if len(self.open) >= c.slots or sym not in tradable or not px or not np.isfinite(px):
                    continue
                sig = vol_daily.get(sym)
                scale = float(np.clip(c.sigma_ref / sig, 0.25, 1.0)) if sig and np.isfinite(sig) and sig > 0 else 0.5
                gross = sum(abs(t.qty) * prices.get(t.symbol, t.entry_px) for t in self.open)
                notional = min(nav * c.leverage * scale / c.slots, max(nav * c.leverage - gross, 0.0))
                if notional <= 0:
                    continue
                t0 = pd.Timestamp(str(self.listings[sym]["launch"]))
                trade = ListingTrade(
                    symbol=sym,
                    listed=t0.isoformat(),
                    entry=now.isoformat(),
                    exit_due=(t0 + pd.Timedelta(hours=c.exit_hours)).isoformat(),
                    qty=-notional / px,
                    entry_px=float(px),
                    hedge_qty=c.hedge_beta * notional / hpx,
                    hedge_px=float(hpx),
                    stop_px=float(px * (1.0 + c.stop)) if c.stop > 0 else None,
                )
                self.open.append(trade)
                log.info("listing sleeve: short %s %.2f USDT (scale %.2f)", sym, notional, scale)
        self._save()
        return self.holdings(prices)

    def stop_fractions(self, prices: dict[str, float]) -> dict[str, float]:
        """Distance of each coin leg's stop from the current price (the brokers place stops as fractions)."""
        out = {}
        for t in self.open:
            px = prices.get(t.symbol)
            if t.stop_px and px and px > 0:
                out[t.symbol] = max(t.stop_px / px - 1.0, 0.005)
        return out

    def summary(self, prices: dict[str, float]) -> dict[str, object]:
        pnl = 0.0
        for t in self.open:
            px = prices.get(t.symbol, t.entry_px)
            pnl += t.qty * (px - t.entry_px) + t.hedge_qty * (prices.get(HEDGE, t.hedge_px) - t.hedge_px)
        return {
            "enabled": True,
            "rule": f"short nouveaux tokens de +{self.cfg.entry_hours:.0f} h à +{self.cfg.exit_hours:.0f} h, "
            f"couverture BTC x{self.cfg.hedge_beta:g}, stop +{self.cfg.stop:.0%}",
            "open": [asdict(t) for t in self.open],
            "open_pnl": round(pnl, 2),
            "closed": self.done[-20:],
            "closed_pnl": round(sum(float(t.get("pnl", 0.0)) for t in self.done), 2),  # type: ignore[arg-type]
            "watch": {s: v for s, v in self.listings.items() if v.get("new_token")},
        }

    # -- internals --------------------------------------------------------------------------------------------
    def _close(self, t: ListingTrade, px: float, prices: dict[str, float], now: pd.Timestamp, reason: str) -> None:
        pnl = t.qty * (px - t.entry_px) + t.hedge_qty * (prices.get(HEDGE, t.hedge_px) - t.hedge_px)
        self.done.append(
            {
                "symbol": t.symbol,
                "entry": t.entry,
                "exit": now.isoformat(),
                "entry_px": t.entry_px,
                "exit_px": px,
                "notional": round(abs(t.qty) * t.entry_px, 2),
                "pnl": round(pnl, 2),
                "reason": reason,
            }
        )
        self.done = self.done[-200:]
        self.open.remove(t)

    def _save(self) -> None:
        self.store.put(
            STATE_KEY,
            {
                "open": [asdict(t) for t in self.open],
                "done": self.done,
                "listings": self.listings,
                "calendar_at": self.calendar_at,
            },
        )


def okx_listed(symbol: str, okx_swaps: set[str]) -> bool:
    return okx_inst_id(symbol) in okx_swaps
