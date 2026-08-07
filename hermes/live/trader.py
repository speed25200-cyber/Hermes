"""Autonomous trading core.

`Trader` is pure decision logic (testable, replayable): given the latest
candle history per instrument it computes every deployed strategy's position,
feeds realised shadow returns to the allocator, combines into a target book,
applies risk, and reconciles positions through a Broker (paper or OKX).

`LiveRunner` wraps it with the real-world concerns: polling OKX for new bars,
periodic automatic re-research (the system re-derives its own edge when the
current one goes stale or was never found), state persistence and logging.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

import numpy as np

from ..config import Config
from ..data.store import BAR_MS, BARS_PER_YEAR, Candles, DataStore
from ..portfolio.allocator import Allocator
from ..research.evolve import evolve
from ..research.validate import ValidatedStrategy, split_is_oos, validate_candidates
from ..risk import RiskEngine
from ..strategy.signals import compute_position
from ..exchange.broker import Broker, PaperBroker


def _log_factory(state_dir: str):
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, "hermes.log")

    def log(msg: str) -> None:
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())}Z] {msg}"
        print(line, flush=True)
        with open(path, "a") as f:
            f.write(line + "\n")

    return log


class Registry:
    """Deployed strategies + research metadata, persisted to disk."""

    def __init__(self, state_dir: str):
        self.path = os.path.join(state_dir, "registry.json")
        self.strategies: list[ValidatedStrategy] = []
        self.researched_at: float = 0.0
        self.n_trials: int = 0
        self.load()

    def load(self) -> None:
        if os.path.exists(self.path):
            with open(self.path) as f:
                d = json.load(f)
            self.strategies = [ValidatedStrategy.from_dict(s) for s in d.get("strategies", [])]
            self.researched_at = d.get("researched_at", 0.0)
            self.n_trials = d.get("n_trials", 0)

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w") as f:
            json.dump({
                "strategies": [s.to_dict() for s in self.strategies],
                "researched_at": self.researched_at,
                "n_trials": self.n_trials,
            }, f, indent=2)

    def sid(self, s: ValidatedStrategy) -> str:
        return f"{s.inst}:{s.genome.gid}"


def run_research(candles_by_inst: dict[str, Candles], cfg: Config, log) -> list[ValidatedStrategy]:
    """Full autonomous research pass over every instrument."""
    r = cfg["research"]
    c = cfg["costs"]
    all_survivors: list[ValidatedStrategy] = []
    for inst, candles in candles_by_inst.items():
        if len(candles) < 2000:
            log(f"research {inst}: only {len(candles)} bars, skipping (need 2000+)")
            continue
        log(f"research {inst}: evolving population={r['population']} "
            f"generations={r['generations']} on {len(candles)} bars")
        candles_is, _ = split_is_oos(candles, r["is_fraction"], r["embargo_bars"])
        pop, n_trials = evolve(
            candles_is,
            population=r["population"], generations=r["generations"],
            fee_bps=c["taker_fee_bps"], slip_bps=c["slippage_bps"],
            seed=r.get("seed"), log=log,
        )
        survivors = validate_candidates(
            pop, candles, n_trials=n_trials,
            is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
            min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
            fee_bps=c["taker_fee_bps"], slip_bps=c["slippage_bps"],
            max_deployed=r["max_deployed"], log=log,
        )
        log(f"research {inst}: {len(survivors)} strategies passed OOS validation")
        all_survivors.extend(survivors)
    return all_survivors


@dataclass
class Trader:
    cfg: Config
    broker: Broker
    registry: Registry
    allocator: Allocator
    risk: RiskEngine
    log: object = print
    journal_path: str | None = None
    last_positions: dict[str, np.ndarray] = field(default_factory=dict)  # sid -> last pos value
    last_close: dict[str, float] = field(default_factory=dict)
    last_ts: dict[str, int] = field(default_factory=dict)

    def _journal(self, entry: dict) -> None:
        """Append one cycle record to the JSONL journal (dashboard feed)."""
        if not self.journal_path:
            return
        os.makedirs(os.path.dirname(self.journal_path) or ".", exist_ok=True)
        with open(self.journal_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def run_cycle(self, candles_by_inst: dict[str, Candles], now_ts: float) -> dict:
        """One decision cycle at the close of the newest bar. Returns a report."""
        prices = {inst: float(c.c[-1]) for inst, c in candles_by_inst.items() if len(c)}
        self.broker.mark_prices(prices)
        equity = self.broker.equity()

        # ---- shadow returns: what did each strategy's last position earn? ----
        strat_rets: dict[str, float] = {}
        for s in self.registry.strategies:
            sid = self.registry.sid(s)
            c = candles_by_inst.get(s.inst)
            if c is None or len(c) < 2:
                continue
            prev_close = self.last_close.get(s.inst)
            last_pos = self.last_positions.get(sid)
            if prev_close and last_pos is not None:
                bar_ret = float(c.c[-1]) / prev_close - 1.0
                strat_rets[sid] = float(last_pos) * bar_ret

        # portfolio realised return
        port_ret = 0.0
        prev_eq = getattr(self, "_prev_equity", None)
        if prev_eq:
            port_ret = equity / prev_eq - 1.0
        self._prev_equity = equity
        if strat_rets or port_ret:
            self.allocator.observe(strat_rets, port_ret)

        # ---- risk: equity update may trip halts -----------------------------
        self.risk.update_equity(equity, now_ts)
        if self.risk.must_flatten:
            reason = self.risk.state.kill_reason or "daily loss limit"
            self.log(f"RISK HALT ({reason}) -> flattening all positions")
            self._flatten(prices)
            self._journal({"ts": now_ts, "equity": equity, "halted": True,
                           "reason": reason, "prices": prices, "targets": {},
                           "orders": [], "weights": {}, "positions": {}})
            return {"equity": equity, "halted": True, "targets": {}}

        # ---- compute per-strategy target positions --------------------------
        per_strategy: dict[str, dict[str, float]] = {}
        for s in self.registry.strategies:
            c = candles_by_inst.get(s.inst)
            if c is None or len(c) < 600:
                continue
            pos_series = compute_position(c, s.genome)
            pos_now = float(pos_series[-1])
            sid = self.registry.sid(s)
            per_strategy[sid] = {s.inst: pos_now}
            self.last_positions[sid] = pos_now
        for inst, c in candles_by_inst.items():
            if len(c):
                self.last_close[inst] = float(c.c[-1])
                self.last_ts[inst] = int(c.ts[-1])

        # ---- allocate, clamp, reconcile -------------------------------------
        targets = self.allocator.combine(per_strategy)
        targets = self.risk.clamp_targets(targets)
        orders = self._reconcile(targets, prices, equity)

        weights = self.allocator.weights(list(per_strategy))
        self._journal({
            "ts": now_ts, "equity": equity, "halted": False,
            "prices": prices, "targets": targets, "orders": orders,
            "weights": weights,
            "strat_pos": {sid: v for sid, v in
                          ((s, list(p.values())[0]) for s, p in per_strategy.items())},
            "positions": self.broker.positions(),
        })
        return {"equity": equity, "halted": False, "targets": targets,
                "orders": orders, "weights": weights}

    # ------------------------------------------------------------------ #

    def _reconcile(self, targets: dict[str, float], prices: dict[str, float],
                   equity: float) -> list[dict]:
        current = self.broker.positions()
        orders = []
        all_insts = set(targets) | set(current)
        for inst in sorted(all_insts):
            px = prices.get(inst, 0.0)
            if px <= 0:
                continue
            tgt_qty = targets.get(inst, 0.0) * equity / px
            cur_qty = current.get(inst, 0.0)
            delta = tgt_qty - cur_qty
            notional = abs(delta) * px
            ok, why = self.risk.check_order(notional)
            if not ok:
                if notional > 0 and "min notional" not in why:
                    self.log(f"{inst}: order rejected: {why}")
                continue
            fill = self.broker.market_order(inst, delta, px)
            if fill:
                orders.append({"inst": inst, "qty": delta, "px": px,
                               "notional": notional})
                self.log(f"order {inst}: {'+' if delta > 0 else ''}{delta:.6f} "
                         f"@ ~{px:.2f} ({notional:.2f} USDT)")
        return orders

    def _flatten(self, prices: dict[str, float]) -> None:
        for inst, qty in self.broker.positions().items():
            px = prices.get(inst, 0.0)
            if px > 0 and abs(qty) * px > 1.0:
                self.broker.market_order(inst, -qty, px)
                self.log(f"flatten {inst}: closed {qty:.6f}")

    # persistence ------------------------------------------------------- #

    def save_state(self, state_dir: str) -> None:
        d = {
            "allocator": self.allocator.to_dict(),
            "last_positions": self.last_positions,
            "last_close": self.last_close,
            "last_ts": self.last_ts,
        }
        if isinstance(self.broker, PaperBroker):
            d["paper_broker"] = self.broker.to_dict()
        with open(os.path.join(state_dir, "trader.json"), "w") as f:
            json.dump(d, f, indent=2)

    def load_state(self, state_dir: str) -> None:
        path = os.path.join(state_dir, "trader.json")
        if not os.path.exists(path):
            return
        with open(path) as f:
            d = json.load(f)
        self.allocator.restore(d.get("allocator", {}))
        self.last_positions = {k: float(v) for k, v in d.get("last_positions", {}).items()}
        self.last_close = d.get("last_close", {})
        self.last_ts = {k: int(v) for k, v in d.get("last_ts", {}).items()}
        if isinstance(self.broker, PaperBroker) and "paper_broker" in d:
            self.broker.restore(d["paper_broker"])


# --------------------------------------------------------------------- #


class LiveRunner:
    """Polls for new bars, keeps research fresh, runs the trader forever."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        state_dir = cfg["state_dir"]
        os.makedirs(state_dir, exist_ok=True)
        self.log = _log_factory(state_dir)
        self.store = DataStore(cfg["data_dir"])
        self.registry = Registry(state_dir)

        from ..exchange.okx_client import OKXClient
        creds = cfg.credentials
        self.client = OKXClient(creds)
        mode = cfg["live"]["mode"]
        if mode == "live":
            if not creds.present:
                raise SystemExit(
                    "live mode requires OKX_API_KEY / OKX_API_SECRET / "
                    "OKX_API_PASSPHRASE in the environment")
            from ..exchange.broker import OKXBroker
            self.broker: Broker = OKXBroker(self.client, cfg["live"]["td_mode"], self.log)
        else:
            self.broker = PaperBroker(
                cash=cfg["live"]["paper_equity"],
                fee_bps=cfg["costs"]["taker_fee_bps"],
                slippage_bps=cfg["costs"]["slippage_bps"],
            )

        bpy = BARS_PER_YEAR[cfg["bar"]]
        self.allocator = Allocator(
            ewma_halflife_bars=cfg["allocator"]["ewma_halflife_bars"],
            eta=cfg["allocator"]["eta"],
            max_weight=cfg["allocator"]["max_weight"],
            portfolio_vol_target=cfg["risk"]["portfolio_vol_target"],
            bars_per_year=bpy,
        )
        r = cfg["risk"]
        self.risk = RiskEngine(
            max_gross_leverage=r["max_gross_leverage"],
            max_instrument_leverage=r["max_instrument_leverage"],
            daily_loss_limit_pct=r["daily_loss_limit_pct"],
            max_drawdown_pct=r["max_drawdown_pct"],
            min_trade_notional=r["min_trade_notional"],
            max_order_notional=r["max_order_notional"],
            state_path=os.path.join(state_dir, "risk.json"),
        )
        self.risk.load()
        self.trader = Trader(cfg, self.broker, self.registry, self.allocator,
                             self.risk, self.log,
                             journal_path=os.path.join(state_dir, "journal.jsonl"))
        self.trader.load_state(state_dir)

    # ------------------------------------------------------------------ #

    def _load_candles(self) -> dict[str, Candles]:
        return {inst: self.store.load(inst, self.cfg["bar"])
                for inst in self.cfg["instruments"]}

    def ensure_data(self) -> None:
        from ..data.fetcher import fetch_candles, fetch_funding
        for inst in self.cfg["instruments"]:
            _, _, n = self.store.candle_range(inst, self.cfg["bar"])
            if n < 2000:
                self.log(f"backfilling {inst} ({self.cfg['history_days']}d of "
                         f"{self.cfg['bar']} candles)...")
                fetch_candles(self.client, self.store, inst, self.cfg["bar"],
                              self.cfg["history_days"], log=self.log)
                fetch_funding(self.client, self.store, inst,
                              self.cfg["history_days"], log=self.log)

    def ensure_research(self, force: bool = False) -> None:
        age_h = (time.time() - self.registry.researched_at) / 3600.0
        stale = age_h > self.cfg["research"]["refresh_hours"]
        if force or stale or not self.registry.strategies:
            self.log(f"research pass starting (stale={stale}, "
                     f"deployed={len(self.registry.strategies)})")
            survivors = run_research(self._load_candles(), self.cfg, self.log)
            if survivors or not self.registry.strategies:
                self.registry.strategies = survivors
            self.registry.researched_at = time.time()
            self.registry.save()
            self.log(f"research done: {len(self.registry.strategies)} deployed")

    def run_forever(self) -> None:
        self.log(f"Hermes starting: mode={self.cfg['live']['mode']} "
                 f"bar={self.cfg['bar']} instruments={self.cfg['instruments']}")
        self.ensure_data()
        self.ensure_research()
        bar_ms = BAR_MS[self.cfg["bar"]]
        last_cycle_bar = 0
        while True:
            try:
                from ..data.fetcher import update_latest
                for inst in self.cfg["instruments"]:
                    update_latest(self.client, self.store, inst, self.cfg["bar"])
                candles = self._load_candles()
                newest = max((int(c.ts[-1]) for c in candles.values() if len(c)),
                             default=0)
                if newest > last_cycle_bar:
                    last_cycle_bar = newest
                    report = self.trader.run_cycle(candles, time.time())
                    self.trader.save_state(self.cfg["state_dir"])
                    self.log(f"cycle @ {newest}: equity={report['equity']:.2f} "
                             f"targets={ {k: round(v, 3) for k, v in report['targets'].items()} }")
                    if self.risk.state.killed:
                        self.log("KILL SWITCH TRIPPED - halting. Review, then "
                                 "delete state/risk.json (or reset_kill) to resume.")
                        return
                    self.ensure_research()  # refresh when stale
            except KeyboardInterrupt:
                self.log("interrupted, exiting cleanly")
                return
            except Exception as exc:  # survive transient API failures
                self.log(f"cycle error: {type(exc).__name__}: {exc}")
            time.sleep(self.cfg["live"]["poll_seconds"])
