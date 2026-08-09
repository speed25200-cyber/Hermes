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

from ..config import Config, effective_costs
from ..data.store import BAR_MS, BARS_PER_YEAR, Candles, DataStore
from ..ml.regime import regime_series
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
                  r: dict, fee_bps: float, slip_bps: float
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
        pop, candles, n_trials=n_trials,
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

    if workers == 1:
        results = [_research_one(i, c, ld, r, fee_bps, slip_bps)
                   for i, c, ld in eligible_list]
    else:
        import concurrent.futures as cf
        with cf.ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_research_one, i, c, ld, r, fee_bps, slip_bps)
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
        log(f"research {inst}: {len(survivors)} strategies passed OOS "
            f"validation ({n_trials} genomes)")
        all_survivors.extend(survivors)
        total_trials += n_trials

    # ---- cross-sectional portfolio strategies (funding carry) ----------
    eligible = {i: c for i, c in candles_by_inst.items() if len(c) >= min_bars}
    if len(eligible) >= 4:
        from ..research.xs import XS_TOTAL_TRIALS, research_xs
        xs_survivors = research_xs(
            eligible, fee_bps=fee_bps, slip_bps=slip_bps,
            is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
            min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"], log=log)
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
                    total += float(p) * (float(c.c[-1]) / prev_close - 1.0)
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
                strat_rets[sid] = float(last_pos) * bar_ret

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
                                             kind=XS_KINDS[s.genome.signal])
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

        # ---- allocate, clamp, reconcile -------------------------------------
        targets = self.allocator.combine(per_strategy)
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
            "weights": weights, "regimes": regimes,
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
        return equity

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
        self.last_positions = {
            k: (v if isinstance(v, dict) else float(v))
            for k, v in d.get("last_positions", {}).items()
        }
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
            self.broker: Broker = OKXBroker(
                self.client, cfg["live"]["td_mode"], self.log,
                prefer_maker=cfg["costs"].get("prefer_maker", True),
                maker_wait_s=cfg["live"].get("maker_wait_s", 20))
        else:
            pb_fee, pb_slip = effective_costs(cfg["costs"])
            self.broker = PaperBroker(
                cash=cfg["live"]["paper_equity"],
                fee_bps=pb_fee, slippage_bps=pb_slip,
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
            if survivors or not self.registry.strategies:
                self.registry.strategies = survivors
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
                else:
                    # between bars: live mark-to-market heartbeat for the
                    # dashboard and the risk engine (no trading decisions)
                    try:
                        ticks = self.client.tickers(self.cfg["instruments"])
                        if ticks:
                            self.trader.heartbeat(ticks, time.time())
                    except Exception as exc:
                        self.log(f"heartbeat: ticker refresh failed: "
                                 f"{type(exc).__name__}: {exc}")
            except KeyboardInterrupt:
                self.log("interrupted, exiting cleanly")
                return
            except Exception as exc:  # survive transient API failures
                self.log(f"cycle error: {type(exc).__name__}: {exc}")
            time.sleep(self.cfg["live"]["poll_seconds"])
