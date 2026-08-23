"""1-minute scalp loop: predict, cost-gate, time-stop, flatten."""

from __future__ import annotations

import json
import os
import time

import numpy as np

from ..data.store import Candles, BAR_MS
from ..exchange.broker import Broker, PaperBroker
from . import features as F
from . import economics as ECON
from . import model as M
from .clock import BARS, HOLD, ScaleDesk
from .flow import HORIZON_S, FlowBrain


class ScalpEngine:
    def __init__(self, cfg: dict, broker: Broker, client, risk, log, state_dir: str):
        s = cfg.get("scalp") or {}
        self.cfg = s
        self.broker = broker
        self.client = client
        self.risk = risk
        self.log = log
        self.state_path = os.path.join(state_dir, "scalp.json")
        self.instruments = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"]
        self.universe_n = 3
        self.trade_top = 3
        self.require_l2 = False
        self.max_spread = float(s.get("max_spread_bps", 6.0))
        self.min_vol = float(s.get("min_vol_usd", 10_000_000))
        self.horizon = int(s.get("horizon", 3))
        # Le pré-filtre doit MINORER le coût vrai, pas ajouter un seuil
        # arbitraire par-dessus : 6 bps en dur bloquait des horloges
        # validées à 5. Ce qui juge vraiment, c'est l'espérance simulée du
        # bracket, qui exige déjà de battre sa propre friction d'un quart.
        self.min_edge = float(s.get("min_edge_bps", 0.0))
        self.max_hold = int(s.get("max_hold_bars", 16))
        self.max_name = float(s.get("max_name_lev", 20.0))
        self.gross_cap = float(s.get("gross_cap", 20.0))
        self.trade_top = int(s.get("trade_top", 2))
        self.lev_min = 2
        self.lev_max = 20
        self.opened_bar: dict[str, int] = {}
        self.last_bar: dict[str, int] = {}
        self.last_preds: list[dict] = []
        self.ticks: dict[str, dict] = {}
        self.universe_at = 0.0
        costs = (cfg.get("costs") or {})
        taker = float(costs.get("taker_fee_bps", 5.0))
        self.taker_fee_bps = taker
        # Entry is posted, exit is taken: maker + taker. Read from the same
        # costs block the rest of the system uses — a hardcoded 7.0 meant
        # configuring costs changed the backtest and not the live gate.
        maker = float(costs.get("maker_fee_bps", 2.0))
        self.round_trip_bps = float(s.get("round_trip_bps", maker + taker))
        # The winning leg is cheaper than the losing one: entry is posted
        # and the take-profit rests on the book, so a trade that ends at
        # its take pays maker twice and crosses no spread. Stops and
        # time-stops still pay the full taker round trip.
        self.cost_tp_bps = 2.0 * maker
        self.stop_bps = float(s.get("stop_bps", 15.0))
        self.take_bps = float(s.get("take_bps", 10.0))
        self.brackets: dict[str, dict] = {}
        self.l2: dict[str, dict] = {}
        self.flow: dict[str, float] = {}
        self.tape: dict[str, dict] = {}
        self.pending: dict[str, float] = {}
        self.horizons = ScaleDesk(fee_bps=self.round_trip_bps, log=self.log)
        self.brain = FlowBrain(state_dir, fee_bps=self.round_trip_bps, log=self.log)
        self._px_t: dict[str, tuple[float, float]] = {}
        self.preds_h: dict[str, list] = {b: [] for b in BARS}
        self.hold_ms: dict[str, int] = {}
        self.opened_h: dict[str, str] = {}
        self.trades: list[dict] = []
        # Mode éclaireur : des trades réels à la taille MINIMALE de
        # l'échange, sous un budget de perte journalier plafonné en dur.
        # Il ne prédit rien et ne remplace aucune gate : il paie un tout
        # petit prix connu pour (a) exercer la chaîne d'exécution en vrai
        # et (b) mesurer ce que la simulation suppose — d'abord le taux de
        # remplissage maker au take-profit (QUEUE_MISS). La taille ne
        # dépend jamais du signal : un éclaireur qui grossirait avec la
        # conviction redeviendrait un trade non validé.
        ex = (s.get("explore") or {})
        self.explore_on = bool(ex.get("enabled", True))
        self.explore_daily_bps = float(ex.get("daily_loss_bps", 15.0))
        self.explore_cooldown_s = float(ex.get("cooldown_s", 600.0))
        self.explore_max_open = int(ex.get("max_open", 2))
        self.explore_notional = float(ex.get("notional_usd", 150.0))
        self.explore_cap_pct = float(ex.get("notional_cap_pct", 3.0))
        self.explore_pnl_day = 0.0
        self._explore_day = ""
        self._explore_last: dict[str, float] = {}
        self.explore_stats = {"trades": 0, "tp_maker": 0, "tp_taker": 0,
                              "sl": 0, "time": 0,
                              # mesures qui remplacent des hypothèses du
                              # modèle de coût, une fois assez d'échantillons
                              "entry_edge_bps": 0.0, "exit_edge_bps": 0.0}
        try:
            with open(self.state_path) as f:
                prev = json.load(f)
            self.trades = list(prev.get("trades") or [])[-200:]
        except (OSError, ValueError):
            pass

    # ------------------------------------------------------------------ #

    def _snapshot(self, extra: dict | None = None) -> None:
        tg = self._targets(self.last_preds or []) if self.last_preds else {}
        eq = 0.0
        if extra and extra.get("equity"):
            eq = float(extra["equity"])
        else:
            try:
                eq = float(self.broker.equity())
            except Exception:
                eq = 0.0
        used = 0.0
        if eq > 0:
            pos = self.broker.positions()
            for inst, q in pos.items():
                last, _, _ = self._px(inst)
                used += abs(float(q) * last) / eq
        preds = []
        for p in (self.last_preds or []):
            q = dict(p)
            q["lev"] = float(tg.get(p.get("inst"), 0.0) or 0.0)
            preds.append(q)
        d = {
            "ts": time.time(),
            "preds": preds,
            "universe": self.instruments,
            "brackets": self.brackets,
            "round_trip_bps": self.round_trip_bps,
            "min_edge_bps": self.min_edge,
            "horizon_bars": self.horizon,
            "horizons": self.horizons.to_dict(),
            "live_bars": self.horizons.live_bars(),
            "flow": self.brain.to_dict(),
            "lev": {
                "name_cap": self.max_name,
                "gross_cap": self.gross_cap,
                "used": used,
                "okx": int(self.lev_max),
                "targets": tg,
                "margin": (self.broker.margin_used() / eq) if eq and hasattr(self.broker, "margin_used") else 0.0,
            },
            "risk_limits": {
                "daily_pct": self.risk.daily_loss_limit_pct,
                "dd_pct": self.risk.max_drawdown_pct,
                "scale": self._risk_scale(),
            },
            "trades": self.trades[-80:],
            "explore": {
                "enabled": self.explore_on,
                "pnl_day_usd": self.explore_pnl_day,
                "budget_usd": self.explore_daily_bps * 1e-4 * eq,
                **self.explore_stats,
            },
            "desk": { (p.get("inst") or "").split("-")[0]: {
                "bar": p.get("bar"), "policy": p.get("policy"),
                "status": p.get("ml") or p.get("reason"),
                "holdout": p.get("edge_bps"), "clocks": p.get("clocks"),
                "lev": p.get("lev"),
            } for p in preds},
        }
        if extra:
            d.update(extra)
        try:
            with open(self.state_path, "w") as f:
                json.dump(d, f)
        except OSError:
            pass

    def refresh_universe(self, tickers: dict[str, dict]) -> list[str]:
        self.ticks = tickers
        self.instruments = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"]
        self.universe_at = time.time()
        self.flatten_foreign()
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
        # Tout le panel vote AVANT que quoi que ce soit ne fusionne. Une
        # horloge validée en marché-neutre ne décide pas sur sa propre
        # prédiction mais sur son écart à la moyenne du panel : cet écart
        # n'existe qu'une fois tout le monde passé au micro. Voter et
        # fusionner dans la même boucle aurait fait juger le premier actif
        # sur la moyenne du tour PRÉCÉDENT.
        for inst in self.instruments:
            c = candles_1m.get(inst)
            if c is not None and len(c) >= 12:
                self.horizons.vote_clock(inst, bar, c, btc)
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
            last = float(feat["px"] or 0.0)
            btc_last = float((self.ticks.get("BTC-USDT-SWAP") or {}).get("last") or 0.0)
            if btc is not None and len(btc) and btc.c[-1] > 0:
                btc_last = float(btc.c[-1])
            prev = self._px_t.get(inst)
            own = 0.0
            nowt = time.time()
            if prev and last > 0 and prev[1] > 0 and nowt - prev[0] < 120:
                own = (last / prev[1] - 1.0) * 1e4
            self._px_t[inst] = (nowt, last)
            x = self.brain.vec(inst, micro, self.tape.get(inst) or {}, last, btc_last, own)
            if last > 0 and micro.get("l2") and bar == "1m":
                self.brain.push(inst, x, last)
            mids = {i: float((self.ticks.get(i) or {}).get("last") or 0.0)
                    for i in self.instruments}
            mids = {k: v for k, v in mids.items() if v > 0}
            if last > 0:
                mids[inst] = last
            if bar == "1m":
                self.brain.settle(mids)
            inf = self.brain.infer(x, micro)
            # The clocks used to vote and be ignored: fuse() was computed for
            # the dashboard while every order followed the flow model alone.
            # Two validated sources now co-decide. Agreement adds size,
            # disagreement sits out, and either alone may still trade.
            cinf = self.horizons.fuse(inst)
            # the flow brain now speaks at the horizon of its best
            # validated head — 90 s, 5 min or 15 min
            h_flow = int(inf.get("h_bars") or max(1, round(HORIZON_S / 60.0)))
            mins = {"1m": 1, "3m": 3, "5m": 5, "15m": 15}
            # L'horizon vient de la validation de l'horloge, plus d'une
            # constante : le modèle a été prouvé sur h barres, la position
            # doit vivre h barres.
            h_clock = (mins.get(cinf.get("bar") or "5m", 5)
                       * int(cinf.get("horizon_bars")
                             or HOLD.get(cinf.get("bar") or "5m", 3)))
            sources = []
            if not inf.get("veto"):
                sources.append((float(inf.get("r_bps") or 0.0),
                                max(float(inf.get("q_bps") or 8.0), 4.0), h_flow, "flow"))
            if not cinf.get("veto"):
                sources.append((float(cinf.get("r_bps") or 0.0),
                                max(float(cinf.get("q_bps") or 12.0), 4.0), h_clock, "candle"))
            fused_veto = not sources
            if len(sources) == 2 and sources[0][0] * sources[1][0] < 0:
                # validated sources that disagree are a fact worth respecting
                sources, fused_veto = [], True
                inf = dict(inf); inf["status"] = "disagree"
            if sources:
                wts = [1.0 / q for _, q, _, _ in sources]
                edge = sum(e * w for (e, _, _, _), w in zip(sources, wts)) / sum(wts)
                h_use = max(h for _, _, h, _ in sources)
                inf = dict(inf)
                inf["veto"] = False
                inf["policy"] = "+".join(nom for *_, nom in sources)
                # la cohérence des horloges se paie en taille : une seule
                # horloge validée trade à demi-Kelly, deux d'accord à plein
                inf["size_mult"] = float(cinf.get("alpha") or 1.0) \
                    if any(n == "candle" for *_, n in sources) else 1.0
                inf["bar"] = cinf.get("bar") if any(n == "candle" for *_, n in sources) else inf.get("bar")
            else:
                edge = float(inf.get("r_bps") or 0.0)
                h_use = h_flow
                inf = dict(inf); inf["veto"] = True
            score = edge / 8.0
            pred["score"], pred["edge_bps"] = score, edge
            pred["p_up"] = 0.5 + 0.5 * max(-1.0, min(1.0, edge / 12.0))
            spread = float(micro["spread_bps"] or 0.0) or float(
                (self.ticks.get(inst) or {}).get("spread_bps") or 0.0)
            if spread <= 0:
                spread = 3.0
            # The pre-filter is a lower bound of the true cost; the
            # simulated EV makes the precise call. Gating at the full taker
            # round trip killed forecasts the maker take could have paid for.
            hurdle = max(self.min_edge, self.cost_tp_bps, spread + 1.5)
            reason = ""
            # The losing exit is taken: fees plus half the spread. The
            # winning exit rests at the take and pays maker, no spread.
            cost_bps = self.round_trip_bps + 0.5 * spread
            bracket = None
            if inf["veto"]:
                direction, reason = "flat", inf.get("status") or "veto"
            elif abs(edge) < hurdle:
                direction, reason = "flat", "cost"
            else:
                bracket = ECON.choose_bracket(
                    edge_bps=edge, vol_bps=max(pred["vol_bps"], 1.0),
                    horizon=h_use, cost_bps=cost_bps,
                    cost_tp_bps=self.cost_tp_bps)
                if bracket is None:
                    # No take/stop pair on this forecast is worth its own
                    # friction. Predicting a direction is not the same as
                    # having a trade.
                    direction, reason = "flat", "no-ev"
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
                "book": micro["book"],
                "depth": micro["depth"],
                "ofi": feat["ofi"],
                "loc": feat.get("loc", 0.0),
                "l2": bool(micro["l2"]),
                "reason": reason,
                "ml_bps": inf["ml_bps"],
                "ml": inf.get("status"),
                "policy": inf.get("policy"),
                "tp_bps": bracket[0] if bracket else inf["tp_bps"],
                "sl_bps": bracket[1] if bracket else inf["sl_bps"],
                "ev_bps": bracket[2] if bracket else 0.0,
                "cost_bps": cost_bps,
                "cost_tp_bps": self.cost_tp_bps,
                "size_mult": float(inf.get("size_mult") or 1.0),
                # what this horizon demands of the forecast before trading it
                # can pay — the number a flat book is really reporting
                "required_ic": ECON.required_ic(cost_bps, h_use,
                                                max(pred["vol_bps"], 1.0)),
                "h_bars": h_use,
                "bar": inf.get("bar") or bar,
                "clocks": inf.get("clocks") or {},
                "bar_ts": int(c.ts[-1]),
            })
        self.preds_h[bar] = out
        self.last_preds = out
        return out

    def _refresh_dashboard_preds(self) -> None:
        by: dict[str, dict] = {}
        live = set(self.horizons.live_bars()) or set(BARS)
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

    def _risk_scale(self) -> float:
        """Cut leverage as we spend the daily / DD budget. Never blind-trade into the kill."""
        s = self.risk.state
        try:
            eq = float(self.broker.equity())
        except Exception:
            return 1.0
        dd_lim = max(self.risk.max_drawdown_pct / 100.0, 1e-6)
        day_lim = max(self.risk.daily_loss_limit_pct / 100.0, 1e-6)
        dd = (1.0 - eq / s.peak_equity) if s.peak_equity > 0 else 0.0
        day = (1.0 - eq / s.day_start_equity) if s.day_start_equity > 0 else 0.0
        def taper(used, lim):
            if used <= 0.4 * lim:
                return 1.0
            if used >= 0.85 * lim:
                return 0.25
            return max(0.25, 1.0 - (used - 0.4 * lim) / (0.45 * lim))
        return min(taper(dd, dd_lim), taper(day, day_lim))

    def _pick_lev(self, p: dict) -> float:
        """Growth-optimal size, then the caps.

        Quarter-Kelly from the same simulation that priced the bracket sets
        the notional; the 2.5%-per-stop rule survives as a ruin ceiling, not
        as the size. The old rule sized every trade at the ceiling — the
        -8.33% day was three stop-outs at maximum size. And when the
        growth-optimal size lands below the exchange minimum, the honest
        answer is no trade at all: forcing 2x onto a 0.4x edge is trading
        at five times Kelly, where expected log growth is negative.
        """
        if self.max_name <= 1.0:
            return float(self.max_name)
        sl = max(float(p.get("sl_bps") or 12.0), 8.0)
        tp = max(float(p.get("tp_bps") or 10.0), 1.0)
        edge = abs(float(p.get("edge_bps") or 0.0))
        vol = max(float(p.get("vol_bps") or 4.0), 1.0)
        h = int(p.get("h_bars") or self.horizon)
        cost = float(p.get("cost_bps") or self.round_trip_bps)
        c_tp = float(p.get("cost_tp_bps") or self.cost_tp_bps)
        kelly = ECON.kelly_fraction(tp, sl, edge, vol, h, cost,
                                    cost_tp_bps=c_tp)
        kelly *= float(p.get("size_mult") or 1.0)
        lev = kelly * self._risk_scale()
        lev = min(lev, 0.025 / (sl * 1e-4), self.lev_max, self.max_name)
        if lev < self.lev_min:
            return 0.0
        # arrondi vers le bas : round() ferait franchir le plafond de ruine
        # d'un demi-cran (13,89x -> 14x)
        return float(int(lev))

    def _targets(self, preds: list[dict]) -> dict[str, float]:
        """Weights are notional/equity. Margin = |w|/lev ≤ 0.92 of equity total."""
        raw = {}
        live = [p for p in preds if p["dir"] != "flat"]
        live.sort(key=lambda p: abs(p["edge_bps"]), reverse=True)
        keep = {p["inst"] for p in live[: self.trade_top]}
        n_keep = max(1, len(keep))
        margin_each = 0.92 / n_keep if self.max_name > 1.0 else None
        for p in preds:
            if p["dir"] == "flat" or p["inst"] not in keep:
                raw[p["inst"]] = 0.0
                p["lev"] = 0.0
                p["margin"] = 0.0
                continue
            lev = self._pick_lev(p)
            p["lev"] = float(lev)
            if margin_each is None:
                w = float(lev)
            else:
                w = float(margin_each * lev)
            p["margin"] = (abs(w) / lev) if lev else 0.0
            raw[p["inst"]] = w if p["dir"] == "long" else -w
        gross = sum(abs(v) for v in raw.values())
        cap = min(self.gross_cap, float(self.lev_max)) if self.max_name > 1 else self.gross_cap
        if gross > cap and gross > 0:
            s = cap / gross
            raw = {k: v * s for k, v in raw.items()}
            for p in preds:
                if p.get("inst") in raw and p.get("lev"):
                    p["margin"] = abs(raw[p["inst"]]) / p["lev"]
                    p["lev"] = abs(raw[p["inst"]]) / max(p["margin"], 1e-9) if p["margin"] else p["lev"]
        return raw

    def _px(self, inst: str, fallback: float = 0.0) -> tuple[float, float, float]:
        t = self.ticks.get(inst) or {}
        if not t:
            t = getattr(self.broker, "book", {}).get(inst) or {}
        last = float(t.get("last") or fallback or 0.0)
        bid = float(t.get("bid") or 0.0) or last
        ask = float(t.get("ask") or 0.0) or last
        return last, bid, ask

    def _record(self, fill, qty: float, reason: str, lev: float = 0.0) -> None:
        if not fill:
            return
        self.trades.append({
            "ts": float(fill.ts),
            "inst": fill.inst,
            "qty": float(qty),
            "px": float(fill.price),
            "fee": float(fill.fee),
            "reason": reason,
            "notional": abs(float(qty)) * float(fill.price),
            "lev": float(lev or 0.0),
        })
        self.trades = self.trades[-200:]

    def _arm(self, inst: str, qty: float, fill, vol_bps: float,
             tp_bps: float | None = None, sl_bps: float | None = None) -> None:
        entry = float(fill.price)
        # A 45-minute clock signal cut by the global 16-minute time-stop was
        # never given the time its own forecast asked for.
        plan = next((q for q in (self.last_preds or [])
                     if q.get("inst") == inst), {})
        h = int(plan.get("h_bars") or self.horizon)
        self.hold_ms[inst] = int(min(90, max(6, 2 * h)) * 60_000)
        sl_bps = float(sl_bps if sl_bps is not None else self.stop_bps)
        tp_bps = float(tp_bps if tp_bps is not None else self.take_bps)
        # These arrive already chosen by expected value; the floors that used
        # to widen them here could arm a 6bps take against a 7bps round trip,
        # a "winning" trade that books a loss. The only floor left is the one
        # that cannot be argued with: a take must clear its own cost.
        tp_bps = max(tp_bps, 1.25 * self.cost_tp_bps)
        sl_bps = max(sl_bps, 1.0)
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
            "t0": int(time.time() * 1000),   # l'écran affiche la tenue
        }

    def check_exits(self, candles_1m: dict[str, Candles] | None = None) -> list[str]:
        """SL / TP / time-stop.

        Stops and time-stops always exit taker at bid (sell) / ask (buy).
        The take-profit rests on the book as a post-only limit: when price
        trades strictly THROUGH the level the resting order has filled at
        its own price at the maker fee. A mere touch leaves the queue
        position unknown, so it exits taker at the market, as before —
        never better than reality, sometimes worse.
        """
        hit: list[str] = []
        pos = self.broker.positions()
        for inst, qty in list(pos.items()):
            last, bid, ask = self._px(inst)
            if last <= 0 or abs(qty) < 1e-12:
                continue
            reason = None
            maker_at = None
            br = self.brackets.get(inst)
            if br:
                if qty > 0:
                    if bid <= br["sl"]:
                        reason = f"SL {br['sl_bps']:.0f}bps"
                    elif bid > br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps maker"
                        maker_at = br["tp"]
                    elif bid >= br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps"
                else:
                    if ask >= br["sl"]:
                        reason = f"SL {br['sl_bps']:.0f}bps"
                    elif ask < br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps maker"
                        maker_at = br["tp"]
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
            fill = self.broker.market_order(inst, -qty, last,
                                            force_taker=maker_at is None,
                                            maker_at=maker_at)
            if fill and br and br.get("explore"):
                entree = float(br.get("entry") or fill.price)
                # ce que la sortie obtient par rapport au marché courant :
                # un TP traversé remplit à SON prix, mieux que le bid
                if last > 0:
                    ex = -float(np.sign(qty)) * (last - fill.price) / last * 1e4
                    n_ex = (self.explore_stats["tp_maker"]
                            + self.explore_stats["tp_taker"]
                            + self.explore_stats["sl"]
                            + self.explore_stats["time"])
                    moy = self.explore_stats["exit_edge_bps"]
                    self.explore_stats["exit_edge_bps"] = \
                        (moy * n_ex + ex) / (n_ex + 1)
                self.explore_pnl_day += qty * (fill.price - entree) \
                    - float(br.get("entry_fee") or 0.0) - float(fill.fee)
                if maker_at is not None:
                    self.explore_stats["tp_maker"] += 1
                elif reason.startswith("TP"):
                    self.explore_stats["tp_taker"] += 1
                elif reason.startswith("SL"):
                    self.explore_stats["sl"] += 1
                else:
                    self.explore_stats["time"] += 1
            self.brackets.pop(inst, None)
            self.opened_bar.pop(inst, None)
            self.hold_ms.pop(inst, None)
            self.opened_h.pop(inst, None)
            if fill:
                self._record(fill, -qty, reason, 0.0)
                self.log(f"scalp {reason} {inst} {qty:+.6f} @ {fill.price:.6f}")
                hit.append(inst)
                self.pending.pop(inst, None)
        return hit

    def _blend_targets(self) -> dict[str, float]:
        return self._targets(self.last_preds or [])

    def _explore(self, preds: list[dict], equity: float,
                 targets: dict[str, float]) -> None:
        """Ouvre au plus une position éclaireur par appel.

        Taille minimale d'échange, plafond notionnel, budget de perte
        journalier ; direction = signe du prévu courant (même non validé :
        au pire une pièce, et la taille est fixe). Les sorties passent par
        check_exits — c'est là que le remplissage maker au TP se mesure.
        """
        if not self.explore_on or not self.risk.trading_allowed:
            return
        jour = time.strftime("%Y-%m-%d", time.gmtime())
        if jour != self._explore_day:
            self._explore_day, self.explore_pnl_day = jour, 0.0
        if self.explore_pnl_day <= -self.explore_daily_bps * 1e-4 * equity:
            return          # budget du jour consommé : on observe, c'est tout
        ouverts = sum(1 for b in self.brackets.values() if b.get("explore"))
        if ouverts >= self.explore_max_open:
            return
        now = time.time()
        pos = self.broker.positions()
        for p in preds:
            inst = p.get("inst") or ""
            if inst in pos or targets.get(inst):
                continue
            if not p.get("l2"):
                continue
            spread = float(p.get("spread_bps") or 99.0)
            if spread > self.max_spread:
                continue
            if now - self._explore_last.get(inst, 0.0) < self.explore_cooldown_s:
                continue
            edge = float(p.get("edge_bps") or 0.0)
            last = float(p.get("px") or 0.0)
            if edge == 0.0 or last <= 0:
                continue
            sens = 1.0 if edge > 0 else -1.0
            qty = sens * self.explore_notional / last
            if hasattr(self.broker, "_round_qty"):
                arrondi = self.broker._round_qty(inst, qty)
                if arrondi == 0:      # le minimum d'échange dépasse le vœu :
                    arrondi = self.broker._round_qty(   # tenter sous plafond
                        inst, sens * self.explore_cap_pct * 1e-2 * equity / last)
                qty = arrondi
            if qty == 0 or abs(qty) * last > self.explore_cap_pct * 1e-2 * equity:
                continue              # minimum d'échange inabordable : passer
            _, bid, ask = self._px(inst, last)
            mid = (bid + ask) / 2.0 if bid > 0 and ask > bid else last
            fill = self.broker.market_order(inst, qty, last)   # entrée maker
            if not fill:
                continue
            # Ce que l'entrée postée obtient VRAIMENT par rapport au mid.
            # Le modèle de coût suppose maker + rien ; poser à l'intérieur
            # du spread gagne une fraction du spread, mais la sélection
            # adverse la reprend en partie. Personne ne peut trancher ça
            # depuis un fauteuil : on le mesure, comme QUEUE_MISS. Positif
            # = rempli mieux que le mid.
            if mid > 0:
                edge_e = float(sens) * (mid - fill.price) / mid * 1e4
                n = self.explore_stats["trades"]
                moy = self.explore_stats["entry_edge_bps"]
                self.explore_stats["entry_edge_bps"] = (moy * n + edge_e) / (n + 1)
            self._explore_last[inst] = now
            self.explore_stats["trades"] += 1
            self.opened_bar[inst] = int(now * 1000)
            self.opened_h[inst] = p.get("bar") or "90s"
            self._arm(inst, qty, fill, float(p.get("vol_bps") or 0.0),
                      p.get("tp_bps"), p.get("sl_bps"))
            self.brackets[inst]["explore"] = True
            self.brackets[inst]["entry_fee"] = float(fill.fee)
            self._record(fill, qty, "explore", 0.0)
            self.log(f"explore {inst} {qty:+.6f} @ {fill.price:.6f} "
                     f"(pnl jour {self.explore_pnl_day:+.2f} USD)")
            return                    # un seul par cycle : pas un moulin

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
        # Une position éclaireur vit par son bracket (TP/SL/time-stop), pas
        # par la cible du desk : _targets met un poids ZÉRO sur tout
        # instrument plat, et cette cible nulle refermait chaque éclaireur
        # au cycle suivant en payant deux fois les frais — mesuré en live :
        # ouvert 10:25:09, aplati 10:25:20. Une vraie cible non nulle,
        # elle, garde la priorité.
        for inst in list(pending):
            if (self.brackets.get(inst) or {}).get("explore") \
                    and abs(pending[inst]) < 1e-12:
                pending.pop(inst)
        self.pending = pending
        self._explore(preds, equity, targets)
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
            # L'exemption éclaireur doit vivre ICI, à la consommation : le
            # pending construit dans le même tick AVANT l'ouverture porte
            # une cible zéro explicite pour l'instrument, et la version qui
            # n'exemptait qu'à la construction refermait l'éclaireur ~12 s
            # après l'entrée (mesuré : explore 15:43:05, fill 15:43:17).
            if (self.brackets.get(inst) or {}).get("explore") \
                    and abs(tgt_qty) < 1e-12:
                continue
            delta = tgt_qty - cur
            if abs(delta) * last < max(10.0, 0.002 * equity):
                continue
            opening = abs(cur) < 1e-9 and abs(tgt_qty) > 1e-9
            flatten = abs(tgt_qty) < 1e-9
            plan = next((p for p in self.last_preds if p.get("inst") == inst), {})
            lev = float(plan.get("lev") or 0.0) if self.max_name > 1 else 0.0
            fill = self.broker.market_order(
                inst, delta, last, force_taker=flatten,
                leverage=(lev if lev >= 2 else None),
            )
            if not fill:
                continue
            why = "close" if flatten else ("open" if opening else "resize")
            self._record(fill, delta, why, lev)
            if abs(tgt_qty) < 1e-9:
                self.opened_bar.pop(inst, None)
                self.brackets.pop(inst, None)
                self.hold_ms.pop(inst, None)
                self.opened_h.pop(inst, None)
            elif opening:
                self.opened_bar[inst] = int(time.time() * 1000)
                plan = next((p for p in self.last_preds if p.get("inst") == inst), {})
                hb = plan.get("bar") or "90s"
                self.opened_h[inst] = hb
                if hb in ("90s", "flow") or plan.get("policy") in ("prior", "flow"):
                    self.hold_ms[inst] = 180_000
                else:
                    h_val = int(plan.get("h_bars") or 0)
                    self.hold_ms[inst] = (h_val * 60_000 if h_val > 0 else
                                          int(HOLD.get(hb, 3))
                                          * int(BAR_MS.get(hb, 60_000)))
                self._arm(inst, tgt_qty, fill, vol.get(inst, 0.0),
                          plan.get("tp_bps"), plan.get("sl_bps"))
            self.log(f"scalp fill {inst} {delta:+.6f} @ {fill.price:.6f}")
        self.risk.update_equity(self.broker.equity(), time.time())
        self._snapshot({"equity": self.broker.equity()})
