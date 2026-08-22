"""1-minute scalp loop: predict, cost-gate, time-stop, flatten."""

from __future__ import annotations

import json
import os
import time

from ..data.store import Candles
from ..exchange.broker import Broker, PaperBroker
from . import features as F
from . import model as M


class ScalpEngine:
    def __init__(self, cfg: dict, broker: Broker, client, risk, log, state_dir: str):
        s = cfg.get("scalp") or {}
        self.cfg = s
        self.broker = broker
        self.client = client
        self.risk = risk
        self.log = log
        self.state_path = os.path.join(state_dir, "scalp.json")
        self.instruments = list(s.get("instruments") or ["BTC-USDT-SWAP"])
        self.universe_n = int(s.get("universe_n", 50))
        self.max_spread = float(s.get("max_spread_bps", 8.0))
        self.min_vol = float(s.get("min_vol_usd", 20_000_000))
        self.horizon = int(s.get("horizon", 3))
        self.min_edge = float(s.get("min_edge_bps", 5.0))
        self.max_hold = int(s.get("max_hold_bars", 6))
        self.max_name = float(s.get("max_name_lev", 0.12))
        self.gross_cap = float(s.get("gross_cap", 1.50))
        self.opened_bar: dict[str, int] = {}  # inst -> 1m ts when opened
        self.last_bar: dict[str, int] = {}
        self.last_preds: list[dict] = []
        self.ticks: dict[str, dict] = {}
        self.universe_at = 0.0
        costs = (cfg.get("costs") or {})
        taker = float(costs.get("taker_fee_bps", 5.0))
        # paper scalp is taker: round-trip = 2 * taker; spread is added per name
        self.taker_fee_bps = taker
        self.round_trip_bps = 2.0 * taker
        self.stop_bps = float(s.get("stop_bps", 15.0))
        self.take_bps = float(s.get("take_bps", 10.0))
        self.brackets: dict[str, dict] = {}

    # ------------------------------------------------------------------ #

    def _snapshot(self, extra: dict | None = None) -> None:
        d = {
            "ts": time.time(),
            "preds": self.last_preds,
            "universe": self.instruments,
            "brackets": self.brackets,
            "round_trip_bps": self.round_trip_bps,
            "min_edge_bps": self.min_edge,
        }
        if extra:
            d.update(extra)
        try:
            with open(self.state_path, "w") as f:
                json.dump(d, f)
        except OSError:
            pass

    def refresh_universe(self, tickers: dict[str, dict]) -> list[str]:
        from .universe import select_universe
        self.ticks = tickers
        picked = select_universe(tickers, n=self.universe_n,
                                 max_spread_bps=self.max_spread,
                                 min_vol_usd=self.min_vol)
        if picked:
            dropped = [i for i in self.instruments if i not in picked]
            self.instruments = picked
            self.universe_at = time.time()
            # flatten anything that fell out of the liquid set
            pos = self.broker.positions()
            for inst in dropped:
                qty = pos.get(inst, 0.0)
                px = float((tickers.get(inst) or {}).get("last") or 0.0)
                if px > 0 and abs(qty) * px > 1:
                    self.broker.market_order(inst, -qty, px, force_taker=True)
                    self.opened_bar.pop(inst, None)
                    self.log(f"scalp drop {inst}: left top-{self.universe_n} / wide spread")
        return self.instruments

    def flatten_foreign(self) -> None:
        """Close leftover names that are not in the live scalp universe
        (old RSI dust, delisted alts, zero-price junk)."""
        uni = set(self.instruments)
        pos = self.broker.positions()
        for inst, qty in list(pos.items()):
            if inst in uni or abs(qty) < 1e-12:
                continue
            px = float((self.ticks.get(inst) or {}).get("last") or 0.0)
            if px <= 0:
                px = float(getattr(self.broker, "prices", {}).get(inst, 0.0) or 0.0)
            if px <= 0:
                continue
            self.broker.market_order(inst, -qty, px, force_taker=True)
            self.opened_bar.pop(inst, None)
            self.brackets.pop(inst, None)
            self.log(f"scalp flatten dust {inst} qty={qty:.6f}")

    def _micro(self, inst: str, last: float) -> tuple[float, float, float]:
        """Book proxy from the all-swaps ticker (one REST call, not 50)."""
        t = self.ticks.get(inst) or {}
        bsz = float(t.get("bid_sz") or 0.0)
        asz = float(t.get("ask_sz") or 0.0)
        bid = float(t.get("bid") or 0.0)
        ask = float(t.get("ask") or 0.0)
        imb = (bsz - asz) / (bsz + asz) if (bsz + asz) > 0 else 0.0
        den = bsz + asz
        micro_px = (bid * asz + ask * bsz) / den if den > 0 and bid > 0 and ask > 0 else last
        vs = (micro_px / last - 1.0) if last > 0 else 0.0
        return float(imb), float(imb), float(vs)  # book≈size imbalance; no L2 hammering

    def predict_all(self, candles_1m: dict[str, Candles]) -> list[dict]:
        btc = candles_1m.get("BTC-USDT-SWAP")
        btc_r1 = 0.0
        if btc is not None and len(btc) >= 2 and btc.c[-2] > 0:
            btc_r1 = float(btc.c[-1] / btc.c[-2] - 1.0)
        out = []
        for inst in self.instruments:
            c = candles_1m.get(inst)
            if c is None or len(c) < 12:
                continue
            feat = F.candle_feats(c)
            imb, book, micro = self._micro(inst, feat["px"])
            feat["imb"], feat["book"], feat["micro"] = imb, book, micro
            pred = M.predict(feat, btc_r1, inst.startswith("BTC-"), self.horizon)
            edge = float(pred["edge_bps"])
            spread = float((self.ticks.get(inst) or {}).get("spread_bps") or 0.0)
            if spread <= 0:
                spread = 3.0  # unknown book → don't treat as free
            hurdle = max(self.min_edge, self.round_trip_bps, spread + 2.0 * self.taker_fee_bps)
            if abs(edge) < hurdle:
                direction = "flat"
            elif edge > 0:
                direction = "long"
            else:
                direction = "short"
            out.append({
                "inst": inst,
                "px": feat["px"],
                "p_up": pred["p_up"],
                "edge_bps": edge,
                "dir": direction,
                "score": pred["score"],
                "vol_bps": pred["vol_bps"],
                "spread_bps": spread,
                "r1": feat["r1"],
                "bar_ts": int(c.ts[-1]),
            })
        self.last_preds = out
        return out

    def _targets(self, preds: list[dict]) -> dict[str, float]:
        raw = {}
        for p in preds:
            if p["dir"] == "flat":
                raw[p["inst"]] = 0.0
                continue
            # size ~ how far the edge clears costs, capped
            spare = abs(p["edge_bps"]) / max(self.round_trip_bps, 1.0) - 1.0
            w = min(self.max_name, self.max_name * min(spare, 2.0) / 2.0)
            raw[p["inst"]] = w if p["dir"] == "long" else -w
        gross = sum(abs(v) for v in raw.values())
        if gross > self.gross_cap and gross > 0:
            s = self.gross_cap / gross
            raw = {k: v * s for k, v in raw.items()}
        return raw

    def _px(self, inst: str, fallback: float = 0.0) -> tuple[float, float, float]:
        t = self.ticks.get(inst) or {}
        if not t:
            t = getattr(self.broker, "book", {}).get(inst) or {}
        last = float(t.get("last") or fallback or 0.0)
        bid = float(t.get("bid") or 0.0) or last
        ask = float(t.get("ask") or 0.0) or last
        return last, bid, ask

    def _arm(self, inst: str, qty: float, fill, vol_bps: float) -> None:
        entry = float(fill.price)
        sl_bps = max(self.stop_bps, 2.0 * max(vol_bps, 1.0))
        tp_bps = max(self.take_bps, 1.2 * max(vol_bps, 1.0))
        if qty > 0:
            sl = entry * (1.0 - sl_bps * 1e-4)
            tp = entry * (1.0 + tp_bps * 1e-4)
            side = "long"
        else:
            sl = entry * (1.0 + sl_bps * 1e-4)
            tp = entry * (1.0 - tp_bps * 1e-4)
            side = "short"
        self.brackets[inst] = {
            "side": side, "entry": entry, "sl": sl, "tp": tp,
            "sl_bps": sl_bps, "tp_bps": tp_bps,
        }

    def check_exits(self, candles_1m: dict[str, Candles] | None = None) -> list[str]:
        """SL / TP / time-stop. Exits always taker at bid (sell) / ask (buy)."""
        hit: list[str] = []
        pos = self.broker.positions()
        for inst, qty in list(pos.items()):
            last, bid, ask = self._px(inst)
            if last <= 0 or abs(qty) < 1e-12:
                continue
            reason = None
            br = self.brackets.get(inst)
            if br:
                if qty > 0:
                    if bid <= br["sl"]:
                        reason = f"SL {br['sl_bps']:.0f}bps"
                    elif bid >= br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps"
                else:
                    if ask >= br["sl"]:
                        reason = f"SL {br['sl_bps']:.0f}bps"
                    elif ask <= br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps"
            if reason is None and candles_1m:
                c = candles_1m.get(inst)
                if c is not None and len(c):
                    opened = self.opened_bar.get(inst, int(c.ts[-1]))
                    held = int((int(c.ts[-1]) - opened) / 60_000)
                    if held >= self.max_hold:
                        reason = f"time-stop {held}m"
            if not reason:
                continue
            fill = self.broker.market_order(inst, -qty, last, force_taker=True)
            self.brackets.pop(inst, None)
            self.opened_bar.pop(inst, None)
            if fill:
                self.log(f"scalp {reason} {inst} {qty:+.6f} @ {fill.price:.6f}")
                hit.append(inst)
        return hit

    def tick(self, candles_1m: dict[str, Candles], now: float | None = None) -> dict:
        now = now or time.time()
        if hasattr(self.broker, "mark_ticks") and self.ticks:
            self.broker.mark_ticks(self.ticks)
        preds = self.predict_all(candles_1m)
        prices = {p["inst"]: p["px"] for p in preds if p["px"] > 0}
        extra = {i: float((t or {}).get("last") or 0) for i, t in self.ticks.items()}
        prices.update({k: v for k, v in extra.items() if v > 0})
        self.broker.mark_prices(prices)
        vol = {p["inst"]: float(p.get("vol_bps") or 0) for p in preds}

        if self.risk.must_flatten:
            for inst, qty in list(self.broker.positions().items()):
                px = prices.get(inst, 0.0)
                if px > 0 and abs(qty) * px > 1:
                    self.broker.market_order(inst, -qty, px, force_taker=True)
            self.brackets.clear()
            self._snapshot({"halted": True})
            return {"preds": preds, "equity": self.broker.equity(), "halted": True}

        self.check_exits(candles_1m)

        if not self.risk.trading_allowed:
            self._snapshot()
            return {"preds": preds, "equity": self.broker.equity()}

        equity = max(self.broker.equity(), 1.0)
        targets = self._targets(preds)
        current = self.broker.positions()
        for inst, tgt_w in targets.items():
            last, bid, ask = self._px(inst, prices.get(inst, 0.0))
            px = last
            if px <= 0:
                continue
            tgt_qty = tgt_w * equity / px
            cur = current.get(inst, 0.0)
            delta = tgt_qty - cur
            if abs(delta) * px < max(10.0, 0.002 * equity):
                continue
            opening = abs(cur) < 1e-9 and abs(tgt_qty) > 1e-9
            fill = self.broker.market_order(inst, delta, px, force_taker=True)
            if fill:
                if abs(tgt_qty) < 1e-9:
                    self.opened_bar.pop(inst, None)
                    self.brackets.pop(inst, None)
                elif opening:
                    c = candles_1m.get(inst)
                    self.opened_bar[inst] = int(c.ts[-1]) if c is not None and len(c) else 0
                    self._arm(inst, tgt_qty, fill, vol.get(inst, 0.0))
                self.log(f"scalp {inst} {delta:+.6f} @ {fill.price:.6f} "
                         f"dir={[p['dir'] for p in preds if p['inst']==inst]}")
        self.risk.update_equity(self.broker.equity(), now)
        self._snapshot({"equity": self.broker.equity(), "targets": targets})
        return {"preds": preds, "equity": self.broker.equity(), "targets": targets}
