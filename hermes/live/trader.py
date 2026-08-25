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
import math
import os
import threading
import time
from dataclasses import dataclass, field

import numpy as np

from ..config import Config, effective_costs
from ..data.store import BAR_MS, BARS_PER_YEAR, Candles, DataStore
from ..ml.regime import regime_series
from ..portfolio.allocator import Allocator
from ..research.evolve import evolve
from ..research.validate import ValidatedStrategy, split_is_oos, validate_candidates

# Instruments dont on relit le carnet et le ruban a chaque tour. Ils ne
# nourrissent que le modele de flux ; les bougies, elles, sont relues
# pour tout le panel a chaque tour parce que c'est l'horloge qui trade.
MICRO_PAR_TOUR = 6
from ..risk import LeverageGovernor, RiskEngine
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
        self.consecutive_empty: int = 0   # empty research passes in a row
        self.load()

    def load(self) -> None:
        if os.path.exists(self.path):
            with open(self.path) as f:
                d = json.load(f)
            self.strategies = [ValidatedStrategy.from_dict(s) for s in d.get("strategies", [])]
            self.researched_at = d.get("researched_at", 0.0)
            self.n_trials = d.get("n_trials", 0)
            self.consecutive_empty = d.get("consecutive_empty", 0)

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w") as f:
            json.dump({
                "strategies": [s.to_dict() for s in self.strategies],
                "researched_at": self.researched_at,
                "n_trials": self.n_trials,
                "consecutive_empty": self.consecutive_empty,
            }, f, indent=2)

    def apply_survivors(self, survivors: list) -> bool:
        """Replace the book only when the new pass found something, or when
        there was nothing to keep. An empty research pass must not unwind a
        live/paper book that is already trading."""
        if survivors or not self.strategies:
            self.strategies = survivors
            return True
        return False

    def record_outcome(self, survivors: list) -> None:
        """Track how many consecutive passes came back empty — the hunt
        escalates its search budget and cadence while the book is empty."""
        self.consecutive_empty = 0 if survivors else self.consecutive_empty + 1

    def sid(self, s: ValidatedStrategy) -> str:
        return f"{s.inst}:{s.genome.gid}"


def make_ctx(candles_by_inst: dict[str, Candles], inst: str,
             leader_inst: str | None) -> dict:
    """Cross-asset context for signal computation: the universe leader whose
    lagged returns feed lead-lag ML features (not used for itself)."""
    if leader_inst and leader_inst != inst and leader_inst in candles_by_inst:
        return {"leader": candles_by_inst[leader_inst]}
    return {}


def _research_one(inst: str, candles: Candles, leader: Candles | None,
                  r: dict, fee_bps: float, slip_bps: float,
                  n_universe: int = 1
                  ) -> tuple[str, list[ValidatedStrategy], int, list[str]]:
    """Evolve + validate a single instrument (worker-safe: no shared state,
    returns log lines instead of printing)."""
    lines: list[str] = []
    ctx = {"leader": leader} if leader is not None else {}
    if leader is not None:
        cut = int(len(leader) * r["is_fraction"])
        ctx_is = {"leader": leader.slice(0, cut)}
    else:
        ctx_is = ctx
    candles_is, _ = split_is_oos(candles, r["is_fraction"], r["embargo_bars"])
    pop, n_trials = evolve(
        candles_is,
        population=r["population"], generations=r["generations"],
        fee_bps=fee_bps, slip_bps=slip_bps,
        seed=r.get("seed"), ctx=ctx_is, log=None,
    )
    survivors = validate_candidates(
        pop, candles, n_trials=max(n_trials, 1) * max(n_universe, 1),
        is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
        min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
        fee_bps=fee_bps, slip_bps=slip_bps,
        max_deployed=r["max_deployed"], ctx=ctx, log=lines.append,
    )
    return inst, survivors, n_trials, lines


def run_research(candles_by_inst: dict[str, Candles], cfg: Config, log,
                 min_bars: int = 2000, escalation: int = 0
                 ) -> tuple[list[ValidatedStrategy], int]:
    """Full autonomous research pass over every instrument, parallelised
    across CPU cores (each instrument is independent).

    escalation > 0 (consecutive empty passes) widens the evolutionary
    search — more population and generations — so the hunt digs deeper
    each time it comes back empty-handed. Validation thresholds NEVER move.
    Returns (survivors, total genomes evaluated)."""
    r = dict(cfg["research"])
    if escalation > 0:
        boost = 1.0 + 0.5 * min(escalation, 2)
        r["population"] = int(r["population"] * boost)
        r["generations"] = int(r["generations"] * boost)
        log(f"research: escalation x{boost:.1f} after {escalation} empty "
            f"pass(es) -> population={r['population']} "
            f"generations={r['generations']}")
    fee_bps, slip_bps = effective_costs(cfg["costs"])
    leader_inst = cfg["instruments"][0] if cfg["instruments"] else None
    all_survivors: list[ValidatedStrategy] = []
    total_trials = 0

    eligible_list = []
    for inst, candles in candles_by_inst.items():
        if len(candles) < min_bars:
            log(f"research {inst}: only {len(candles)} bars, skipping "
                f"(need {min_bars}+)")
            continue
        leader = candles_by_inst.get(leader_inst) if (
            leader_inst and leader_inst != inst) else None
        eligible_list.append((inst, candles, leader))

    # worker count: leave one core for the OS/dashboard, cap memory usage
    workers = max(1, min(len(eligible_list), (os.cpu_count() or 1) - 1, 6))
    log(f"research: {len(eligible_list)} instruments on {workers} worker(s), "
        f"population={r['population']} generations={r['generations']}")

    n_universe = max(len(eligible_list), 1)
    if workers == 1:
        results = [_research_one(i, c, ld, r, fee_bps, slip_bps, n_universe)
                   for i, c, ld in eligible_list]
    else:
        import concurrent.futures as cf
        with cf.ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_research_one, i, c, ld, r, fee_bps, slip_bps,
                                   n_universe)
                       for i, c, ld in eligible_list]
            results = []
            for fut in cf.as_completed(futures):
                try:
                    results.append(fut.result())
                except Exception as exc:
                    log(f"research worker failed: {type(exc).__name__}: {exc}")

    for inst, survivors, n_trials, lines in sorted(results, key=lambda t: t[0]):
        for line in lines:
            log(line)
        charged = max(n_trials, 1) * n_universe
        if survivors:
            for s in survivors:
                s.oos_stats["n_trials_charged"] = charged
        log(f"research {inst}: {len(survivors)} strategies passed OOS "
            f"validation ({n_trials} genomes, DSR N={charged})")
        all_survivors.extend(survivors)
        total_trials += n_trials

    # ---- cross-sectional portfolio strategies (funding carry) ----------
    eligible = {i: c for i, c in candles_by_inst.items() if len(c) >= min_bars}
    if len(eligible) >= 4:
        from ..research.xs import XS_TOTAL_TRIALS, research_xs
        xs_survivors = research_xs(
            eligible, fee_bps=fee_bps, slip_bps=slip_bps,
            is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
            min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"], log=log,
            leader=leader_inst)
        all_survivors.extend(xs_survivors)
        total_trials += XS_TOTAL_TRIALS
        log(f"research XS: {len(xs_survivors)} portfolio strategies deployed")
    return all_survivors, total_trials


@dataclass
class Trader:
    cfg: Config
    broker: Broker
    registry: Registry
    allocator: Allocator
    risk: RiskEngine
    log: object = print
    journal_path: str | None = None
    last_hb_journal: float = 0.0
    last_positions: dict[str, np.ndarray] = field(default_factory=dict)  # sid -> last pos value
    last_close: dict[str, float] = field(default_factory=dict)
    last_ts: dict[str, int] = field(default_factory=dict)
    governor: LeverageGovernor | None = None

    def __post_init__(self) -> None:
        if self.governor is None:
            g = (self.cfg["risk"].get("governor", {})
                 if isinstance(self.cfg.get("risk"), dict) else {})
            if g.get("enabled", True):
                self.governor = LeverageGovernor(
                    max_boost=float(g.get("max_boost", 1.5)))

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
        # paper must pay the same funding the exchange would (demo already did;
        # the live loop did not — carry strategies were scored on price only)
        if isinstance(self.broker, PaperBroker):
            for inst, c in candles_by_inst.items():
                if not len(c):
                    continue
                ts = int(c.ts[-1])
                prev_ts = self.last_ts.get(inst)
                if prev_ts is not None and ts != prev_ts and float(c.funding[-1]) != 0.0:
                    self.broker.apply_funding(inst, float(c.funding[-1]))
        equity = self.broker.equity()

        # ---- shadow returns: what did each strategy's last position earn? ----
        strat_rets: dict[str, float] = {}
        for s in self.registry.strategies:
            sid = self.registry.sid(s)
            last_pos = self.last_positions.get(sid)
            if last_pos is None:
                continue
            if isinstance(last_pos, dict):
                # cross-sectional book: sum exposure * per-instrument return
                total = 0.0
                seen = False
                for inst, p in last_pos.items():
                    c = candles_by_inst.get(inst)
                    prev_close = self.last_close.get(inst)
                    if c is None or len(c) < 2 or not prev_close:
                        continue
                    total += float(p) * (float(c.c[-1]) / prev_close - 1.0
                                         - float(c.funding[-1]))
                    seen = True
                if seen:
                    strat_rets[sid] = total
                continue
            c = candles_by_inst.get(s.inst)
            if c is None or len(c) < 2:
                continue
            prev_close = self.last_close.get(s.inst)
            if prev_close:
                bar_ret = float(c.c[-1]) / prev_close - 1.0
                fund = float(c.funding[-1]) if len(c) else 0.0
                strat_rets[sid] = float(last_pos) * (bar_ret - fund)

        # portfolio realised return
        port_ret = 0.0
        prev_eq = getattr(self, "_prev_equity", None)
        if prev_eq:
            port_ret = equity / prev_eq - 1.0
        self._prev_equity = equity
        if strat_rets or port_ret:
            self.allocator.observe(strat_rets, port_ret)

        # ---- self-healing: retire strategies whose live edge collapsed ------
        self._retire_dead_strategies()

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
        leader_inst = self.cfg["instruments"][0] if self.cfg["instruments"] else None
        per_strategy: dict[str, dict[str, float]] = {}
        for s in self.registry.strategies:
            sid = self.registry.sid(s)
            from ..strategy.xs import XS_KINDS, xs_positions
            if s.genome.signal in XS_KINDS:
                eligible = {i: c for i, c in candles_by_inst.items()
                            if len(c) >= 600}
                _, _, pos_map = xs_positions(eligible, s.genome.params,
                                             kind=XS_KINDS[s.genome.signal],
                                             leader=leader_inst)
                if pos_map:
                    book = {inst: float(arr[-1]) for inst, arr in pos_map.items()
                            if len(arr)}
                    per_strategy[sid] = book
                    self.last_positions[sid] = book
                continue
            c = candles_by_inst.get(s.inst)
            if c is None or len(c) < 600:
                continue
            ctx = make_ctx(candles_by_inst, s.inst, leader_inst)
            pos_series = compute_position(c, s.genome, ctx)
            pos_now = float(pos_series[-1])
            per_strategy[sid] = {s.inst: pos_now}
            self.last_positions[sid] = pos_now
        for inst, c in candles_by_inst.items():
            if len(c):
                self.last_close[inst] = float(c.c[-1])
                self.last_ts[inst] = int(c.ts[-1])

        # ---- allocate, govern, clamp, reconcile -----------------------------
        targets = self.allocator.combine(per_strategy)
        risk_mult = 1.0
        if self.governor is not None:
            risk_mult = self.governor.update(equity, self.risk.state.peak_equity)
            if abs(risk_mult - 1.0) > 1e-9:
                targets = {i: e * risk_mult for i, e in targets.items()}
        targets = self.risk.clamp_targets(targets)
        orders = self._reconcile(targets, prices, equity)

        weights = self.allocator.weights(list(per_strategy))
        regimes = {}
        for inst, c in candles_by_inst.items():
            if len(c) >= 900:
                try:
                    regimes[inst] = int(regime_series(c)[-1])
                except Exception:
                    pass
        # remembered for heartbeat journal entries between bars
        self._last_targets = targets
        self._last_weights = weights
        self._last_regimes = regimes
        self._journal({
            "ts": now_ts, "equity": equity, "halted": False,
            "prices": prices, "targets": targets, "orders": orders,
            "weights": weights, "regimes": regimes, "risk_mult": risk_mult,
            "strat_pos": {sid: v for sid, v in
                          ((s, list(p.values())[0]) for s, p in per_strategy.items())},
            "positions": self.broker.positions(),
        })
        return {"equity": equity, "halted": False, "targets": targets,
                "orders": orders, "weights": weights}

    def _retire_dead_strategies(self) -> None:
        """Autonomous self-healing: a deployed strategy whose LIVE shadow
        returns show a clearly negative risk-adjusted edge over a meaningful
        sample is removed from the book — no human in the loop. The next
        research pass (daily while the book is empty) hunts for a
        replacement. Thresholds live in config; validation gates are
        untouched."""
        r = self.cfg["research"]
        min_obs = int(r.get("retire_after_bars", 1000))
        floor = float(r.get("retire_sharpe", -0.5))
        bpy = self.allocator.bars_per_year
        keep, dropped = [], []
        for s in self.registry.strategies:
            sid = self.registry.sid(s)
            t = self.allocator.tracks.get(sid)
            if t is None or t.n_obs < min_obs:
                keep.append(s)
                continue
            var = max(t.ewma_var - t.ewma_ret ** 2, 0.0)
            sd = var ** 0.5
            live_sharpe = (t.ewma_ret / sd) * (bpy ** 0.5) if sd > 1e-12 else 0.0
            if live_sharpe < floor:
                dropped.append((sid, live_sharpe))
                self.last_positions.pop(sid, None)
            else:
                keep.append(s)
        if dropped:
            for sid, sh in dropped:
                self.log(f"RETIRING {sid}: live sharpe {sh:.2f} < {floor} "
                         f"after {min_obs}+ bars — edge is gone, book unwinds")
            self.registry.strategies = keep
            self.registry.save()

    def heartbeat(self, prices: dict[str, float], now_ts: float) -> float:
        """Light between-bars update: mark positions to live ticker prices,
        refresh the risk state, journal a point for the dashboard. Returns
        current equity. No trading decisions are made here."""
        self.broker.mark_prices(prices)
        equity = self.broker.equity()
        self.risk.update_equity(equity, now_ts)
        if self.risk.must_flatten and self.broker.positions():
            self.log("risk tripped between bars -> flattening")
            self._flatten(prices)
        if now_ts - self.last_hb_journal >= 5.0:
            self._journal({
                "ts": now_ts, "equity": equity, "halted": self.risk.must_flatten,
                "prices": prices,
                "targets": getattr(self, "_last_targets", {}),
                "orders": [],
                "weights": getattr(self, "_last_weights", {}),
                "regimes": getattr(self, "_last_regimes", {}),
                "positions": self.broker.positions(),
                "hb": True,
            })
            self.last_hb_journal = now_ts
        return equity

    # ------------------------------------------------------------------ #

    def _reconcile(self, targets: dict[str, float], prices: dict[str, float],
                   equity: float) -> list[dict]:
        current = self.broker.positions()
        orders = []
        all_insts = set(targets) | set(current)
        max_n = float(self.risk.max_order_notional)
        min_n = float(self.risk.min_trade_notional)
        for inst in sorted(all_insts):
            px = prices.get(inst, 0.0)
            if px <= 0:
                continue
            tgt_qty = targets.get(inst, 0.0) * equity / px
            cur_qty = current.get(inst, 0.0)
            delta = tgt_qty - cur_qty
            reducing = abs(tgt_qty) <= abs(cur_qty) + 1e-12
            while abs(delta) * px >= min_n:
                cap_qty = max_n / px if px > 0 else abs(delta)
                step = math.copysign(min(abs(delta), cap_qty), delta)
                notional = abs(step) * px
                ok, why = self.risk.check_order(notional, reducing=reducing)
                if not ok:
                    if notional > 0 and "min notional" not in why:
                        self.log(f"{inst}: order rejected: {why}")
                    break
                fill = self.broker.market_order(inst, step, px)
                if fill:
                    orders.append({"inst": inst, "qty": step, "px": px,
                                   "notional": notional})
                    self.log(f"order {inst}: {'+' if step > 0 else ''}{step:.6f} "
                             f"@ ~{px:.2f} ({notional:.2f} USDT)")
                    delta -= step
                    if abs(fill.qty) + 1e-12 < abs(step) * 0.5:
                        break  # exchange didn't fill; don't loop
                else:
                    break
        return orders

    def _flatten(self, prices: dict[str, float]) -> None:
        """Emergency close: taker, reduce-only, no 20s maker wait. Parallel
        on live so a 15-name book is not flattened sequentially in a crash."""
        items = [(inst, qty) for inst, qty in self.broker.positions().items()
                 if prices.get(inst, 0.0) > 0 and abs(qty) * prices[inst] > 1.0]

        def close_one(item: tuple[str, float]) -> None:
            inst, qty = item
            px = prices[inst]
            try:
                self.broker.market_order(inst, -qty, px, force_taker=True)
                self.log(f"flatten {inst}: closed {qty:.6f} TAKER")
            except Exception as exc:
                self.log(f"flatten {inst} FAILED ({type(exc).__name__}: {exc})")

        if len(items) <= 1 or isinstance(self.broker, PaperBroker):
            for item in items:
                close_one(item)
            return
        from concurrent.futures import ThreadPoolExecutor, wait
        with ThreadPoolExecutor(max_workers=min(8, len(items))) as pool:
            wait([pool.submit(close_one, item) for item in items], timeout=30)

    # persistence ------------------------------------------------------- #

    def save_state(self, state_dir: str) -> None:
        d = {
            "allocator": self.allocator.to_dict(),
            "last_positions": self.last_positions,
            "last_close": self.last_close,
            "last_ts": self.last_ts,
        }
        if self.governor is not None:
            d["governor"] = self.governor.to_dict()
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
        self.last_positions = {
            k: (v if isinstance(v, dict) else float(v))
            for k, v in d.get("last_positions", {}).items()
        }
        self.last_close = d.get("last_close", {})
        self.last_ts = {k: int(v) for k, v in d.get("last_ts", {}).items()}
        if self.governor is not None and "governor" in d:
            self.governor.from_dict(d["governor"])
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
            self.broker: Broker = OKXBroker(
                self.client, cfg["live"]["td_mode"], self.log,
                prefer_maker=cfg["costs"].get("prefer_maker", True),
                maker_wait_s=cfg["live"].get("maker_wait_s", 20))
            self._configure_account()
        else:
            # Paper = taker at bid/ask. Do not blend in phantom maker rebates.
            self.broker = PaperBroker(
                cash=cfg["live"]["paper_equity"],
                fee_bps=float(cfg["costs"]["taker_fee_bps"]),
                slippage_bps=float(cfg["costs"]["slippage_bps"]),
            )
            try:
                specs = {}
                for row in self.client.instruments("SWAP"):
                    inst = row.get("instId") or ""
                    if inst.endswith("-USDT-SWAP"):
                        specs[inst] = {
                            "ctVal": float(row.get("ctVal") or 0) or 1.0,
                            "lotSz": float(row.get("lotSz") or 0) or 1.0,
                            "minSz": float(row.get("minSz") or 0) or 1.0,
                        }
                self.broker.set_specs(specs)
            except Exception as exc:
                self.log(f"lot specs: {type(exc).__name__}: {exc}")

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
        self.scalp = None
        sc = cfg.raw.get("scalp") or {}
        if sc.get("enabled", False):
            from ..scalp.engine import ScalpEngine
            self.scalp = ScalpEngine(cfg.raw, self.broker, self.client, self.risk,
                                     self.log, state_dir)

    def _configure_account(self) -> None:
        """Force net mode + a leverage cap OKX will actually honour.

        Hermes risk is an internal exposure fraction; without this, a UI
        account left in long/short mode or 20x leverage will not match paper.
        """
        try:
            self.client.set_position_mode(net=True)
            self.log("account: posMode=net_mode")
        except Exception as exc:
            self.log(f"account: position mode ({type(exc).__name__}: {exc})")
        lever = max(1, int(math.ceil(float(self.cfg["risk"]["max_gross_leverage"]))))
        td = self.cfg["live"]["td_mode"]
        for inst in self.cfg["instruments"]:
            try:
                self.client.set_leverage(inst, lever, td)
            except Exception as exc:
                self.log(f"account: leverage {inst} ({type(exc).__name__}: {exc})")

    # ------------------------------------------------------------------ #

    def _load_candles(self) -> dict[str, Candles]:
        return {inst: self.store.load(inst, self.cfg["bar"])
                for inst in self.cfg["instruments"]}

    def ensure_data(self) -> None:
        from ..data.fetcher import fetch_candles, fetch_funding, fetch_microstructure
        for inst in self.cfg["instruments"]:
            try:
                self.log(f"syncing {inst} ({self.cfg['history_days']}d "
                         f"{self.cfg['bar']})...")
                fetch_candles(self.client, self.store, inst, self.cfg["bar"],
                              self.cfg["history_days"], log=self.log)
                fetch_funding(self.client, self.store, inst,
                              self.cfg["history_days"], log=self.log)
                fetch_microstructure(self.client, self.store, inst,
                                     self.cfg["bar"],
                                     days=min(14, int(self.cfg["history_days"])),
                                     log=self.log)
            except Exception as exc:
                self.log(f"sync {inst} failed: {type(exc).__name__}: {exc}")
        # Au demarrage on ne rattrape QUE le panel courant — deja en cache,
        # donc quelques secondes. Viser d emblee les vingt plus echanges
        # bloquerait la boucle le temps de quatorze instruments sur quatre
        # echelles, et le moteur ne traderait pas pendant ce temps : le
        # rattrapage couterait la mesure qu il est cense enrichir. Les noms
        # que le volume reclame en plus arrivent par la tache de fond, trois
        # par tour, et entrent au panel des qu ils ont de quoi etre juges.
        self._ensure_scalp_data(list(self.scalp.instruments) if self.scalp else [])

    def _panel_vise(self) -> list[str]:
        """Les noms que le panel VEUT, classes par volume reel sur OKX.

        Le remplissage ne suivait pas l univers : il recopiait les six noms
        ecrits en dur, si bien qu un actif promu par le volume n avait
        jamais d histoire et ne pouvait donc jamais entrer — le classement
        dynamique n aurait servi a rien. En cas d echec de l appel public
        on retombe sur l univers courant, jamais sur rien.
        """
        if self.scalp is None:
            return []
        n = max(1, int(getattr(self.scalp, "universe_n", 6)))
        try:
            classe = self.scalp.classement(self.client.swap_tickers())
        except Exception as exc:
            self.log(f"desk classement: {type(exc).__name__}: {exc}")
            classe = []
        vise = list(dict.fromkeys(list(self.scalp.instruments) + classe))[:n]
        # Le meneur transversal doit etre RAMASSE meme s il ne trade pas :
        # sa serie porte la colonne de decalage de toutes les autres jambes,
        # et sans elle cette colonne vaut zero pour tout le panel.
        from ..scalp.clock import ASSETS as _A
        if _A and _A[0] not in vise:
            vise.append(_A[0])
        return vise

    def _ajuster(self, noms: list[str], quoi: str) -> bool:
        """Un seul ajustement d horloge a la fois.

        Trois chemins peuvent le declencher — le demarrage, le fond qui
        vient de finir son rattrapage, et le refit horaire. fit_store vide
        self.models avant de le repeupler : deux passes concurrentes
        laisseraient le vote lire un dictionnaire a moitie rempli, et le
        moteur veto-erait des horloges vivantes sans que rien ne plante.
        Le second arrivant renonce au lieu d attendre : son tour reviendra.
        """
        verrou = getattr(self, "_verrou_fit", None)
        if verrou is None:
            verrou = self._verrou_fit = threading.Lock()
        if not verrou.acquire(blocking=False):
            return False
        try:
            self.scalp.horizons.fit_store(self.store, list(noms))
        except Exception as exc:
            self.log(f"{quoi}: {type(exc).__name__}: {exc}")
        finally:
            verrou.release()
        return True

    def _ensure_scalp_data(self, noms: list[str] | None = None) -> None:
        if self.scalp is None:
            return
        from ..data.fetcher import fetch_candles
        from ..scalp.clock import BARS, DAYS
        cibles = noms if noms is not None else self._panel_vise()
        if cibles:
            self.log(f"desk panel vise {len(cibles)}: "
                     + ",".join(i.split("-")[0] for i in cibles[:20]))
        for bar in BARS:
            d = DAYS[bar]
            for inst in cibles:
                try:
                    self.log(f"desk backfill {inst} {bar} ({d}d)...")
                    fetch_candles(self.client, self.store, inst, bar, d, log=self.log)
                except Exception as exc:
                    self.log(f"desk backfill {inst} {bar}: {type(exc).__name__}: {exc}")

    def ensure_research(self, force: bool = False) -> None:
        age_h = (time.time() - self.registry.researched_at) / 3600.0
        r = self.cfg["research"]
        # adaptive cadence: while the book is empty the hunt re-runs daily
        # (on fresh data, with an escalating search budget) instead of
        # sleeping the full weekly interval
        refresh_h = (r.get("refresh_hours_empty", 24)
                     if not self.registry.strategies else r["refresh_hours"])
        stale = age_h > refresh_h
        never_ran = self.registry.researched_at == 0
        # NB: an empty deployed set after a completed research is a legitimate
        # outcome (no robust edge) — it must NOT trigger an immediate re-run
        if force or stale or never_ran:
            self.log(f"research pass starting (stale={stale}, "
                     f"deployed={len(self.registry.strategies)}, "
                     f"empty_streak={self.registry.consecutive_empty})")
            survivors, n_trials = run_research(
                self._load_candles(), self.cfg, self.log,
                escalation=self.registry.consecutive_empty)
            replaced = self.registry.apply_survivors(survivors)
            if not replaced:
                self.log(f"research empty — keeping {len(self.registry.strategies)} "
                         "already-deployed strategies (will not unwind the book)")
            self.registry.record_outcome(survivors)
            self.registry.researched_at = time.time()
            self.registry.n_trials = n_trials
            self.registry.save()
            self.log(f"research done: {len(self.registry.strategies)} deployed")

    def run_once(self, allow_research: bool = False) -> dict | None:
        """One decision cycle then return — the execution model for scheduled
        runners (GitHub Actions cron): wake, decide, persist, exit.
        Research is opt-in so an hourly cycle never blocks on a long search."""
        try:
            self.ensure_data()
        except Exception as exc:
            self.log(f"cycle: backfill failed ({type(exc).__name__}: {exc}); "
                     "continuing with cached data")
        if allow_research:
            self.ensure_research()
        if not self.registry.strategies:
            self.log("cycle: no deployed strategies — run `hermes research` "
                     "(or the research workflow) first; nothing to trade")
            return None
        from ..data.fetcher import update_latest
        for inst in self.cfg["instruments"]:
            try:
                update_latest(self.client, self.store, inst, self.cfg["bar"])
            except Exception as exc:
                self.log(f"cycle: data refresh {inst} failed: "
                         f"{type(exc).__name__}: {exc}")
        candles = self._load_candles()
        newest = max((int(c.ts[-1]) for c in candles.values() if len(c)), default=0)
        if not newest:
            self.log("cycle: no candle data available, aborting")
            return None
        report = self.trader.run_cycle(candles, time.time())
        self.trader.save_state(self.cfg["state_dir"])
        self.log(f"cycle @ {newest}: equity={report['equity']:.2f} "
                 f"targets={ {k: round(v, 3) for k, v in report['targets'].items()} }")
        if self.risk.state.killed:
            self.log("KILL SWITCH TRIPPED - positions flattened. Review, then "
                     "delete state/risk.json (or reset_kill) to resume.")
        return report

    def run_forever(self) -> None:
        self.log(f"Hermes starting: mode={self.cfg['live']['mode']} "
                 f"bar={self.cfg['bar']} instruments={self.cfg['instruments']}"
                 + (" scalp=1m" if self.scalp else ""))
        if self.risk.state.killed:
            self.log("KILL SWITCH is set — idling, no orders. "
                     f"reason={self.risk.state.kill_reason!r}. "
                     "reset_kill to resume. systemd must NOT respawn a halt.")
            while True:
                time.sleep(30)
        if self.scalp:
            # SECOND appel, celui qui compte vraiment : il precede la boucle
            # et la bloque. Laisse sans argument, il visait les vingt plus
            # echanges et rattrapait quatorze instruments sur quatre echelles
            # A CHAQUE DEMARRAGE — donc a chaque deploiement. Le moteur
            # passait son temps a remplir au lieu de trader, et la mesure du
            # direct payait le remplissage cense l enrichir. Constate au
            # journal : quatorze noms en rattrapage 3m juste apres un
            # redemarrage. Comme celui de ensure_data, il ne vise que le
            # panel courant ; le reste arrive en tache de fond.
            # Le rattrapage d histoire NE BLOQUE PLUS le demarrage.
            #
            # Mesure en direct : la profondeur 1m passee de trente a
            # soixante jours a fait passer ce rattrapage de huit a dix-sept
            # minutes pour SIX noms — dix-sept minutes sans un tick, sans
            # un instantane ecrit, sans une position surveillee, et un
            # ecran qui montre l etat du processus precedent. A vingt noms
            # il en aurait fait cinquante-sept.
            #
            # Or le magasin porte deja l histoire du tour precedent :
            # l horloge s ajuste tout de suite sur ce qui est la, le fond
            # se creuse derriere, et un second ajustement suit quand il a
            # fini. Sur une machine vierge le premier ajustement rend
            # « few-samples » — c est la verite, et elle ne coute rien.
            # L UNIVERS D ABORD. `self.scalp.instruments` vaut encore les
            # six noms de la CONFIGURATION a cet instant : refresh_universe
            # ne tourne que dans la boucle, et le reajustement suivant
            # n arrive qu une heure plus tard. L horloge s ajustait donc sur
            # six jambes pendant une heure APRES CHAQUE DEMARRAGE — donc
            # apres chaque deploiement, et le panel elargi n a jamais servi
            # a rien. Mesure : vingt-six instruments avaient les 86 000
            # barres exigees, et le journal affichait toujours
            # « clock 1m panel[6] ».
            #
            # La barre deflatee ne depend que du nombre d instants, et
            # chaque jambe en apporte : partir a six quand vingt sont
            # disponibles, c est se donner une barre plus haute pour rien.
            try:
                self.scalp.store = self.store
                uni = self.scalp.refresh_universe(self.client.swap_tickers())
                self.log(f"scalp universe {len(uni)} au demarrage: "
                         + ",".join(i.split("-")[0] for i in uni[:12])
                         + ("…" if len(uni) > 12 else ""))
            except Exception as exc:
                self.log(f"scalp universe demarrage: {type(exc).__name__}: {exc}")
            noms = list(self.scalp.instruments)
            self._ajuster(noms, "learner fit")

            def _fond():
                try:
                    self._ensure_scalp_data(noms)
                except Exception as exc:
                    self.log(f"desk fond: {type(exc).__name__}: {exc}")
                self._ajuster(noms, "learner fit (fond)")

            threading.Thread(target=_fond, daemon=True).start()
            threading.Thread(target=self._bg_sync, daemon=True).start()
        else:
            self.ensure_data()
            threading.Thread(target=self._research_bg, daemon=True).start()
        last_cycle_bar = 0
        # La liste vient de clock.BARS : ecrite en dur ici, une echelle
        # ajoutee la-bas n aurait jamais ete suivie et son horloge se
        # serait ajustee sans jamais decider.
        from ..scalp.clock import BARS as _BARS0
        last_scalp_bar = {b: 0 for b in _BARS0}
        last_uni = 0.0
        last_learn = time.time()
        rr = 0
        book_rr = 0
        poll = int((self.cfg.raw.get("scalp") or {}).get("poll_seconds", 5)
                   if self.scalp else self.cfg["live"]["poll_seconds"])
        while True:
            try:
                from ..data.fetcher import update_latest
                if self.scalp:
                    try:
                        ticks = self.client.swap_tickers()
                    except Exception as exc:
                        self.log(f"scalp tickers: {type(exc).__name__}: {exc}")
                        ticks = {}
                    self.scalp.store = self.store
                    if ticks and (last_uni == 0.0 or time.time() - last_uni > 900):
                        before = list(self.scalp.instruments)
                        uni = self.scalp.refresh_universe(ticks)
                        last_uni = time.time()
                        self.scalp.flatten_foreign()
                        self.trader.save_state(self.cfg["state_dir"])
                        if uni != before:
                            self.log(f"scalp universe {len(uni)}: "
                                     + ",".join(i.split("-")[0] for i in uni[:12])
                                     + ("…" if len(uni) > 12 else ""))
                            # Une jambe de plus, c est des instants de plus
                            # dans le holdout, donc une barre plus basse.
                            # Attendre l heure du prochain reajustement
                            # laisserait l horloge juger un panel qui n est
                            # plus celui qu on trade.
                            if len(uni) != len(before):
                                last_learn = 0.0
                    elif ticks:
                        self.scalp.ticks = ticks
                    # Un nom que le volume reclame mais qui n a pas encore
                    # d histoire ne peut pas etre juge. On le rattrape en
                    # tache de fond — a CHAQUE tour, pas seulement au
                    # rafraichissement d univers : trois noms tous les quarts
                    # d heure mettraient plus d une heure a completer le
                    # panel. Le verrou empeche deux rattrapages simultanes.
                    att = [i for i in getattr(self.scalp, "attendus", [])][:3]
                    if att and not getattr(self, "_rattrapage", False):
                        self._rattrapage = True
                        def _bf(noms=att):
                            try:
                                self._ensure_scalp_data(noms)
                                # rayes de la liste une fois rattrapes :
                                # sinon le meme trio serait refetche a chaque
                                # tour jusqu au prochain classement, dans un
                                # quart d heure
                                self.scalp.attendus = [
                                    i for i in self.scalp.attendus
                                    if i not in set(noms)]
                            finally:
                                self._rattrapage = False
                        threading.Thread(target=_bf, daemon=True).start()
                    if ticks and hasattr(self.broker, "mark_ticks"):
                        self.broker.mark_ticks(ticks)
                    names = list(self.scalp.instruments)
                    if time.time() - last_learn > 3600:
                        last_learn = time.time()
                        threading.Thread(
                            target=self._ajuster,
                            args=(names, "learner refit"),
                            daemon=True).start()
                    t0, r0 = self.client.timeout, self.client.max_retries
                    self.client.timeout, self.client.max_retries = 4.0, 1
                    try:
                        # Le carnet et le ruban ne nourrissent que le modèle
                        # de flux, qui est en veto ; les bougies nourrissent
                        # l'horloge, qui trade. À vingt instruments, tout
                        # récupérer à chaque tour ferait quatre-vingts
                        # appels et rallongerait le cycle — donc le retard
                        # d'entrée, la chose même qu'on vient de ramener à
                        # une seconde. On tourne donc la microstructure et
                        # on garde les bougies pour tout le monde.
                        micro = names[book_rr % max(len(names), 1):][:MICRO_PAR_TOUR]
                        if len(micro) < min(MICRO_PAR_TOUR, len(names)):
                            micro += names[: MICRO_PAR_TOUR - len(micro)]
                        book_rr += len(micro) or 1
                        for inst in micro:
                            try:
                                self.scalp.ingest_book(inst, self.client.books(inst, sz=10))
                            except Exception as exc:
                                self.log(f"L2 {inst}: {type(exc).__name__}")
                            try:
                                self.scalp.ingest_trades(inst, self.client.last_trades(inst, limit=50))
                            except Exception:
                                pass
                        for inst in names:
                            try:
                                update_latest(self.client, self.store, inst, "1m", limit=120)
                            except Exception:
                                pass
                            slow = ("3m", "5m", "15m")[rr % 3]
                            try:
                                update_latest(self.client, self.store, inst, slow, limit=120)
                            except Exception:
                                pass
                        rr += 1
                    finally:
                        self.client.timeout, self.client.max_retries = t0, r0
                    from ..scalp.clock import BARS as _BARS
                    any_new = False
                    last_rep = None
                    for bar in _BARS:
                        # On demande d abord le dernier horodatage, qui ne
                        # coute qu un MAX(ts) indexe. Charger les series
                        # completes a chaque tour de cinq secondes — quatre-
                        # vingts historiques de dizaines de milliers de
                        # lignes avec leurs jointures — rendait le moteur
                        # muet plusieurs minutes d affilee, et doubler la
                        # profondeur 1m avait double ce cout.
                        newest = max((self.store.dernier_ts(inst, bar)
                                      for inst in names), default=0)
                        if newest > last_scalp_bar.get(bar, 0):
                            last_scalp_bar[bar] = newest
                            any_new = True
                            cbar = {inst: self.store.load(inst, bar)
                                    for inst in names}
                            last_rep = self.scalp.tick(cbar, time.time(), bar=bar)
                            live = [p for p in (last_rep.get("preds") or []) if p.get("dir") != "flat"]
                            self.log(f"desk {bar} @ {newest}: eq={last_rep.get('equity', 0):.2f} "
                                     f"live={len(live)}/{len(last_rep.get('preds') or [])} "
                                     f"hz={last_rep.get('live_bars')}")
                    if last_rep and last_rep.get("targets") is not None:
                        self.trader._last_targets = last_rep["targets"]
                    if self.risk.state.killed:
                        self.log("KILL SWITCH TRIPPED - idling (no systemd restart mill).")
                        while True:
                            time.sleep(30)
                    # Les cibles d'une barre qui vient de fermer partent
                    # MAINTENANT. Le pending n'etait consomme que dans la
                    # branche « aucune nouvelle barre » ci-dessous, donc
                    # jamais sur le cycle qui venait de le produire : il
                    # attendait le tour suivant, et un tour comprend la
                    # collecte des carnets, des trades et des bougies des
                    # six instruments. La porte, elle, mesure une entree
                    # AU PRIX DE CLOTURE de la barre (ENTREE_DECALEE = 0).
                    # Ce decalage-la n'est pas une hypothese de plus dans
                    # le modele de cout : il change la regle jouee sans
                    # que rien ne le mesure.
                    if any_new and self.risk.trading_allowed:
                        self.scalp.execute_pending()
                    if not any_new:
                        if self.risk.trading_allowed:
                            self.scalp.check_exits()
                            self.scalp.execute_pending()
                        else:
                            self.scalp.pending = {}
                        self.scalp._snapshot({"equity": self.broker.equity()})
                    px = {i: float((t or {}).get("last") or 0)
                          for i, t in (self.scalp.ticks or {}).items()}
                    px = {k: v for k, v in px.items() if v > 0}
                    if px:
                        eq = self.trader.heartbeat(px, time.time())
                        self.trader.save_state(self.cfg["state_dir"])
                        self.scalp._snapshot({"equity": eq})
                else:
                    for inst in self.cfg["instruments"]:
                        try:
                            update_latest(self.client, self.store, inst, self.cfg["bar"])
                        except Exception:
                            pass
                    candles = self._load_candles()
                    newest = max((int(c.ts[-1]) for c in candles.values() if len(c)),
                                 default=0)
                    if newest > last_cycle_bar and self.registry.strategies:
                        last_cycle_bar = newest
                        report = self.trader.run_cycle(candles, time.time())
                        self.trader.save_state(self.cfg["state_dir"])
                        self.log(f"swing @ {newest}: equity={report['equity']:.2f}")
                        if self.risk.state.killed:
                            self.log("KILL SWITCH TRIPPED - idling (no systemd restart mill).")
                            while True:
                                time.sleep(30)
                    else:
                        try:
                            ticks = self.client.tickers(self.cfg["instruments"])
                            if ticks:
                                self.trader.heartbeat(ticks, time.time())
                        except Exception as exc:
                            self.log(f"heartbeat: {type(exc).__name__}: {exc}")
            except KeyboardInterrupt:
                self.log("interrupted, exiting cleanly")
                return
            except Exception as exc:
                self.log(f"cycle error: {type(exc).__name__}: {exc}")
            time.sleep(poll)

    def _bg_sync(self) -> None:
        time.sleep(45)  # let the 1m loop run uncontended first
        try:
            self.ensure_data()
        except Exception as exc:
            self.log(f"bg sync: {type(exc).__name__}: {exc}")
        try:
            self.ensure_research()
        except Exception as exc:
            self.log(f"research thread: {type(exc).__name__}: {exc}")
