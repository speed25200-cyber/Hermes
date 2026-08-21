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
        self.horizon = int(s.get("horizon", 3))
        self.min_edge = float(s.get("min_edge_bps", 5.0))
        self.max_hold = int(s.get("max_hold_bars", 6))
        self.max_name = float(s.get("max_name_lev", 0.30))
        self.gross_cap = float(s.get("gross_cap", 0.90))
        self.opened_bar: dict[str, int] = {}  # inst -> 1m ts when opened
        self.last_bar: dict[str, int] = {}
        self.last_preds: list[dict] = []
        costs = (cfg.get("costs") or {})
        # maker-heavy scalp: ~2 bps fee + leftover slip
        self.round_trip_bps = 2.0 * (
            float(costs.get("maker_fee_bps", 2.0)) * 0.7
            + float(costs.get("taker_fee_bps", 5.0)) * 0.3
            + float(costs.get("slippage_bps", 2.0)) * 0.3
        )

    # ------------------------------------------------------------------ #

    def _snapshot(self, extra: dict | None = None) -> None:
        d = {
            "ts": time.time(),
            "preds": self.last_preds,
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

    def _micro(self, inst: str, last: float) -> tuple[float, float, float]:
        imb = book = micro = 0.0
        try:
            trades = self.client.last_trades(inst, limit=80)
            imb = F.trade_imbalance(trades, int(time.time() * 1000))
        except Exception:
            pass
        try:
            book_raw = self.client.books(inst, sz=5)
            book, micro = F.book_feats(book_raw, last)
        except Exception:
            pass
        return imb, book, micro

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
            # cost gate: predicted move must beat a round-trip
            if abs(edge) < max(self.min_edge, self.round_trip_bps):
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

    def tick(self, candles_1m: dict[str, Candles], now: float | None = None) -> dict:
        now = now or time.time()
        preds = self.predict_all(candles_1m)
        prices = {p["inst"]: p["px"] for p in preds if p["px"] > 0}
        self.broker.mark_prices(prices)
        if self.risk.must_flatten:
            for inst, qty in list(self.broker.positions().items()):
                px = prices.get(inst, 0.0)
                if px > 0 and abs(qty) * px > 1:
                    self.broker.market_order(inst, -qty, px, force_taker=True)
            self._snapshot({"halted": True})
            return {"preds": preds, "equity": self.broker.equity(), "halted": True}

        # time-stop: flatten names held longer than max_hold 1m bars
        pos = self.broker.positions()
        for inst, qty in list(pos.items()):
            c = candles_1m.get(inst)
            if c is None or not len(c) or abs(qty) < 1e-12:
                continue
            opened = self.opened_bar.get(inst, int(c.ts[-1]))
            held = int((int(c.ts[-1]) - opened) / 60_000)
            if held >= self.max_hold:
                px = prices.get(inst, float(c.c[-1]))
                self.broker.market_order(inst, -qty, px, force_taker=True)
                self.opened_bar.pop(inst, None)
                self.log(f"scalp time-stop {inst} after {held}m")

        if not self.risk.trading_allowed:
            self._snapshot()
            return {"preds": preds, "equity": self.broker.equity()}

        equity = max(self.broker.equity(), 1.0)
        targets = self._targets(preds)
        current = self.broker.positions()
        for inst, tgt_w in targets.items():
            px = prices.get(inst, 0.0)
            if px <= 0:
                continue
            tgt_qty = tgt_w * equity / px
            cur = current.get(inst, 0.0)
            delta = tgt_qty - cur
            if abs(delta) * px < max(10.0, 0.002 * equity):
                continue
            fill = self.broker.market_order(inst, delta, px)
            if fill:
                if abs(tgt_qty) < 1e-9:
                    self.opened_bar.pop(inst, None)
                elif inst not in self.opened_bar or abs(cur) < 1e-9:
                    c = candles_1m.get(inst)
                    self.opened_bar[inst] = int(c.ts[-1]) if c is not None and len(c) else 0
                self.log(f"scalp {inst} {delta:+.6f} @ {px:.4f} "
                         f"dir={[p['dir'] for p in preds if p['inst']==inst]}")
        self.risk.update_equity(self.broker.equity(), now)
        self._snapshot({"equity": self.broker.equity(), "targets": targets})
        return {"preds": preds, "equity": self.broker.equity(), "targets": targets}
