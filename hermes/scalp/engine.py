"""1-minute scalp loop: predict, cost-gate, time-stop, flatten."""

from __future__ import annotations

import json
import os
import time

from ..data.store import Candles, BAR_MS
from ..exchange.broker import Broker, PaperBroker
from . import features as F
from . import model as M
from .learn import BARS, HOLD, ScalpLearner, HorizonBook


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
        self.universe_n = int(s.get("universe_n", 40))
        self.trade_top = int(s.get("trade_top", 8))
        self.require_l2 = bool(s.get("require_l2", True))
        self.max_spread = float(s.get("max_spread_bps", 6.0))
        self.min_vol = float(s.get("min_vol_usd", 10_000_000))
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
        self.l2: dict[str, dict] = {}  # inst -> {ts, feats}
        self.flow: dict[str, float] = {}
        self.tape: dict[str, dict] = {}
        self.pending: dict[str, float] = {}  # inst -> desired coin qty
        self.horizons = HorizonBook(self.round_trip_bps, log=self.log)
        self.learner = self.horizons.learners["1m"]
        self.preds_h: dict[str, list] = {b: [] for b in BARS}
        self.hold_ms: dict[str, int] = {}
        self.opened_h: dict[str, str] = {}  # inst -> bar that opened it

    # ------------------------------------------------------------------ #

    def _snapshot(self, extra: dict | None = None) -> None:
        d = {
            "ts": time.time(),
            "preds": self.last_preds,
            "universe": self.instruments,
            "brackets": self.brackets,
            "round_trip_bps": self.round_trip_bps,
            "min_edge_bps": self.min_edge,
            "learner": self.learner.to_dict(),
            "horizons": self.horizons.to_dict(),
            "live_bars": self.horizons.live_bars(),
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

    def ingest_trades(self, inst: str, trades: list) -> None:
        now_ms = int(time.time() * 1000)
        last = float((self.ticks.get(inst) or {}).get("last") or 0.0)
        tape = F.trade_tape(trades, now_ms, last)
        self.flow[inst] = tape["flow"]
        self.tape[inst] = tape

    def ingest_book(self, inst: str, book: dict) -> None:
        last = float((self.ticks.get(inst) or {}).get("last") or 0.0)
        feats = F.book_l2(book, last)
        prev = (self.l2.get(inst) or {}).get("raw")
        feats["ofi"] = F.ofi_l1(prev, book)
        self.l2[inst] = {"ts": time.time(), "feats": feats, "raw": book}

    def _micro(self, inst: str, last: float) -> dict[str, float]:
        rec = self.l2.get(inst)
        if rec and (time.time() - rec["ts"]) < 25.0:
            f = rec["feats"]
            return {
                "imb": f["imb1"], "book": f["imb5"], "depth": f["depth_imb"],
                "micro": f["micro"], "spread_bps": f["spread_bps"], "l2": 1.0,
                "ofi": float(f.get("ofi") or 0.0),
            }
        t = self.ticks.get(inst) or {}
        bsz = float(t.get("bid_sz") or 0.0)
        asz = float(t.get("ask_sz") or 0.0)
        bid = float(t.get("bid") or 0.0)
        ask = float(t.get("ask") or 0.0)
        imb = (bsz - asz) / (bsz + asz) if (bsz + asz) > 0 else 0.0
        den = bsz + asz
        micro_px = (bid * asz + ask * bsz) / den if den > 0 and bid > 0 and ask > 0 else last
        vs = (micro_px / last - 1.0) if last > 0 else 0.0
        spr = ((ask - bid) / last * 1e4) if last > 0 and bid > 0 and ask > bid else 0.0
        return {"imb": imb, "book": imb, "depth": 0.0, "micro": vs,
                "spread_bps": spr, "l2": 0.0, "ofi": 0.0}

    def predict_all(self, candles_1m: dict[str, Candles], bar: str = "1m") -> list[dict]:
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
            micro = self._micro(inst, feat["px"])
            feat["imb"], feat["book"] = micro["imb"], micro["book"]
            feat["micro"], feat["depth"] = micro["micro"], micro["depth"]
            feat["flow"] = float(self.flow.get(inst) or 0.0)
            feat["ofi"] = float(micro.get("ofi") or 0.0)
            feat["vwap_vs"] = float((self.tape.get(inst) or {}).get("vwap_vs") or 0.0)
            pred = M.predict(feat, btc_r1, inst.startswith("BTC-"), self.horizon)
            learner = self.horizons.learners.get(bar, self.learner)
            inf = learner.infer(
                feat, btc_r1, inst.startswith("BTC-"),
                float(pred["score"]), float(pred["vol_bps"]),
            )
            score = float(inf["score"])
            vol = max(float(pred["vol_bps"]) * 1e-4, 1e-6)
            edge = score * vol * (max(self.horizon, 1) ** 0.5) * 1e4
            pred["score"], pred["edge_bps"] = score, edge
            spread = float(micro["spread_bps"] or 0.0) or float(
                (self.ticks.get(inst) or {}).get("spread_bps") or 0.0)
            if spread <= 0:
                spread = 3.0
            hurdle = max(self.min_edge, self.round_trip_bps, spread + 2.0 * self.taker_fee_bps)
            reason = ""
            if inf["veto"]:
                direction, reason = "flat", "ml-veto"
            elif bar == "1m" and (not micro["l2"]) and self.require_l2:
                direction, reason = "flat", "no L2"
            elif abs(edge) < hurdle:
                direction, reason = "flat", "cost"
            elif edge > 0:
                direction = "long"
            else:
                direction = "short"
            # book must not scream continuation against a fade
            if direction == "short" and feat["r1"] > 0 and micro["book"] > 0.25:
                direction, reason = "flat", "book disagrees"
            if direction == "long" and feat["r1"] < 0 and micro["book"] < -0.25:
                direction, reason = "flat", "book disagrees"
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
                "book": micro["book"],
                "depth": micro["depth"],
                "ofi": feat["ofi"],
                "loc": feat.get("loc", 0.0),
                "l2": bool(micro["l2"]),
                "reason": reason,
                "ml_bps": inf["ml_bps"],
                "ml": inf["status"],
                "tp_bps": inf["tp_bps"],
                "sl_bps": inf["sl_bps"],
                "bar": bar,
                "bar_ts": int(c.ts[-1]),
            })
        self.preds_h[bar] = out
        self._refresh_dashboard_preds()
        return out

    def _refresh_dashboard_preds(self) -> None:
        by: dict[str, dict] = {}
        live = set(self.horizons.live_bars()) or {"1m"}
        for bar, preds in self.preds_h.items():
            if bar not in live and bar != "1m":
                continue
            for p in preds:
                cur = by.get(p["inst"])
                if cur is None or abs(p.get("edge_bps") or 0) > abs(cur.get("edge_bps") or 0):
                    by[p["inst"]] = p
        if by:
            self.last_preds = list(by.values())
        elif self.preds_h.get("1m"):
            self.last_preds = self.preds_h["1m"]

    def _targets(self, preds: list[dict]) -> dict[str, float]:
        raw = {}
        live = [p for p in preds if p["dir"] != "flat"]
        live.sort(key=lambda p: abs(p["edge_bps"]), reverse=True)
        keep = {p["inst"] for p in live[: self.trade_top]}
        for p in preds:
            if p["dir"] == "flat" or p["inst"] not in keep:
                raw[p["inst"]] = 0.0
                continue
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

    def _arm(self, inst: str, qty: float, fill, vol_bps: float,
             tp_bps: float | None = None, sl_bps: float | None = None) -> None:
        entry = float(fill.price)
        sl_bps = float(sl_bps if sl_bps is not None else self.stop_bps)
        tp_bps = float(tp_bps if tp_bps is not None else self.take_bps)
        sl_bps = max(sl_bps, 2.0 * max(vol_bps, 1.0) * 0.5, 8.0)
        tp_bps = max(tp_bps, 1.0 * max(vol_bps, 1.0) * 0.5, 6.0)
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
            if reason is None:
                opened = self.opened_bar.get(inst)
                if opened:
                    held_ms = int(time.time() * 1000) - int(opened)
                    lim = int(self.hold_ms.get(inst) or self.max_hold * 60_000)
                    if held_ms >= lim:
                        reason = f"time-stop {held_ms // 60_000}m"
            if not reason:
                continue
            fill = self.broker.market_order(inst, -qty, last, force_taker=True)
            self.brackets.pop(inst, None)
            self.opened_bar.pop(inst, None)
            self.hold_ms.pop(inst, None)
            self.opened_h.pop(inst, None)
            if fill:
                self.log(f"scalp {reason} {inst} {qty:+.6f} @ {fill.price:.6f}")
                hit.append(inst)
                self.pending.pop(inst, None)
        return hit

    def _blend_targets(self) -> dict[str, float]:
        live = self.horizons.live_bars()
        if not live:
            return {inst: 0.0 for inst in self.instruments}
        acc: dict[str, float] = {}
        vol: dict[str, float] = {}
        n = float(len(live))
        for bar in live:
            preds = self.preds_h.get(bar) or []
            t = self._targets(preds)
            for k, v in t.items():
                acc[k] = acc.get(k, 0.0) + v / n
            for p in preds:
                vol[p["inst"]] = float(p.get("vol_bps") or 0.0)
        self._vol = vol
        gross = sum(abs(v) for v in acc.values())
        if gross > self.gross_cap and gross > 0:
            s = self.gross_cap / gross
            acc = {k: v * s for k, v in acc.items()}
        return acc

    def tick(self, candles_1m: dict[str, Candles], now: float | None = None,
             bar: str = "1m") -> dict:
        now = now or time.time()
        if hasattr(self.broker, "mark_ticks") and self.ticks:
            self.broker.mark_ticks(self.ticks)
        preds = self.predict_all(candles_1m, bar=bar)
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
            return {"preds": self.last_preds, "equity": self.broker.equity(), "halted": True}

        self.check_exits(candles_1m)

        if not self.risk.trading_allowed:
            self.pending = {}
            self._snapshot()
            return {"preds": self.last_preds, "equity": self.broker.equity()}

        equity = max(self.broker.equity(), 1.0)
        targets = self._blend_targets()
        pending: dict[str, float] = {}
        for inst, tgt_w in targets.items():
            last, _, _ = self._px(inst, prices.get(inst, 0.0))
            if last <= 0:
                continue
            pending[inst] = tgt_w * equity / last
        for inst in self.broker.positions():
            pending.setdefault(inst, 0.0)
        self.pending = pending
        self._vol = vol
        self.risk.update_equity(self.broker.equity(), now)
        self._snapshot({"equity": self.broker.equity(), "targets": targets})
        return {"preds": self.last_preds, "equity": self.broker.equity(), "targets": targets,
                "bar": bar, "live_bars": self.horizons.live_bars()}

    def execute_pending(self) -> None:
        """Fill last bar's targets once at the current bid/ask. Consumed.
        Re-firing the same delta every poll is a fee mill."""
        if not self.risk.trading_allowed:
            self.pending = {}
            return
        orders = self.pending
        self.pending = {}
        if not orders:
            return
        equity = max(self.broker.equity(), 1.0)
        current = self.broker.positions()
        vol = getattr(self, "_vol", {})
        for inst, tgt_qty in list(orders.items()):
            last, _, _ = self._px(inst)
            if last <= 0:
                continue
            if hasattr(self.broker, "_round_qty"):
                tgt_qty = self.broker._round_qty(inst, tgt_qty)
            cur = current.get(inst, 0.0)
            delta = tgt_qty - cur
            if abs(delta) * last < max(10.0, 0.002 * equity):
                continue
            opening = abs(cur) < 1e-9 and abs(tgt_qty) > 1e-9
            fill = self.broker.market_order(inst, delta, last, force_taker=True)
            if not fill:
                continue
            if abs(tgt_qty) < 1e-9:
                self.opened_bar.pop(inst, None)
                self.brackets.pop(inst, None)
                self.hold_ms.pop(inst, None)
                self.opened_h.pop(inst, None)
            elif opening:
                self.opened_bar[inst] = int(time.time() * 1000)
                plan = next((p for p in self.last_preds if p.get("inst") == inst), {})
                hb = plan.get("bar") or "1m"
                self.opened_h[inst] = hb
                self.hold_ms[inst] = int(HOLD.get(hb, 6)) * int(BAR_MS.get(hb, 60_000))
                self._arm(inst, tgt_qty, fill, vol.get(inst, 0.0),
                          plan.get("tp_bps"), plan.get("sl_bps"))
            self.log(f"scalp fill {inst} {delta:+.6f} @ {fill.price:.6f}")
        self.risk.update_equity(self.broker.equity(), time.time())
        self._snapshot({"equity": self.broker.equity()})
