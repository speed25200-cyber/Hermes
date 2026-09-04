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

from .. import ENGINE_VERSION
from ..config import Config, effective_costs
from ..data.store import BAR_MS, BARS_PER_YEAR, Candles, DataStore
from ..ml.regime import regime_series
from ..portfolio.allocator import Allocator
from ..research.evolve import evolve, return_matrix
from ..research.panel import PANEL_INST, Panel
from ..research.pbo import cscv
from ..research.validate import (ValidatedStrategy, select_book, split_is_oos,
                                 validate_candidates, validate_panel)
from ..risk import LeverageGovernor, RiskEngine
from ..strategy.signals import compute_position
from ..strategy.xs import hours_to_bars
from ..universe import resolve_universe
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


STATE_FILES = ("registry.json", "risk.json", "trader.json", "journal.jsonl",
               "scalp.json", "flow.jsonl", "flow_model.json", "hermes.log",
               "research.json")


def ensure_state_version(state_dir: str, log=None) -> bool:
    """State written by another engine version is archived, never reused:
    strategies validated under a different protocol, paper books opened
    under another risk regime and a kill switch tripped by a retired desk
    have no business steering this engine. Returns True when archived."""
    os.makedirs(state_dir, exist_ok=True)
    marker = os.path.join(state_dir, "engine_version")
    current = None
    if os.path.exists(marker):
        try:
            with open(marker) as f:
                current = int(f.read().strip() or 0)
        except (OSError, ValueError):
            current = None
    if current == ENGINE_VERSION:
        return False
    present = [n for n in STATE_FILES if os.path.exists(os.path.join(state_dir, n))]
    archived = False
    if present:
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        dest = os.path.join(state_dir, f"archive-v{current or 0}-{stamp}")
        os.makedirs(dest, exist_ok=True)
        for n in present:
            os.replace(os.path.join(state_dir, n), os.path.join(dest, n))
        archived = True
        if log:
            log(f"state: engine v{current or 0} -> v{ENGINE_VERSION}; archived "
                f"{len(present)} file(s) to {dest}")
    with open(marker, "w") as f:
        f.write(f"{ENGINE_VERSION}\n")
    return archived


class Registry:
    """Deployed strategies + research metadata, persisted to disk."""

    def __init__(self, state_dir: str):
        self.path = os.path.join(state_dir, "registry.json")
        self.strategies: list[ValidatedStrategy] = []
        self.researched_at: float = 0.0
        self.n_trials: int = 0
        self.consecutive_empty: int = 0   # empty research passes in a row
        self.last_report: dict = {}       # diagnostics of the last pass (PBO...)
        self.load()

    def load(self) -> None:
        if os.path.exists(self.path):
            with open(self.path) as f:
                d = json.load(f)
            self.strategies = [ValidatedStrategy.from_dict(s) for s in d.get("strategies", [])]
            self.researched_at = d.get("researched_at", 0.0)
            self.n_trials = d.get("n_trials", 0)
            self.consecutive_empty = d.get("consecutive_empty", 0)
            self.last_report = d.get("last_report", {}) or {}

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w") as f:
            json.dump({
                "engine_version": ENGINE_VERSION,
                "strategies": [s.to_dict() for s in self.strategies],
                "researched_at": self.researched_at,
                "n_trials": self.n_trials,
                "consecutive_empty": self.consecutive_empty,
                "last_report": self.last_report,
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


def _membership_cfg(cfg: Config) -> tuple[int | None, int]:
    u = cfg.get("universe") or {}
    top_n = u.get("top_n") if u.get("auto", False) else None
    bars = hours_to_bars(float(u.get("membership_hours", 720)), cfg["bar"])
    return (int(top_n) if top_n else None), bars


def panel_live_book(candles_by_inst: dict[str, Candles], genome,
                    leader_inst: str | None, top_n: int | None = None,
                    membership_bars: int = 720) -> dict[str, float]:
    """Latest exposure of a panel rule on every investable instrument,
    equal-split — the same construction the research scored."""
    if not candles_by_inst:
        return {}
    panel = Panel(candles_by_inst, leader=leader_inst, min_bars=1,
                  top_n=top_n, membership_bars=membership_bars)
    return panel.live_book(genome, min_bars=600)


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
                 min_bars: int = 2000, escalation: int = 0,
                 report: dict | None = None
                 ) -> tuple[list[ValidatedStrategy], int]:
    """Full autonomous research pass.

    Default ("panel") mode: one rule is applied to the whole universe and
    scored as a book; the evolutionary search explores rules in-sample,
    the whole evaluated population is audited for backtest overfitting
    (CSCV / PBO), the best rules face the embargoed holdout (Sharpe, DSR
    charged for the number of holdout tests, drawdown, purged folds), and
    finally the deployed set must clear the Sharpe floor as a book. The
    market-neutral cross-sectional families run beside it.

    escalation > 0 (consecutive empty passes) widens the evolutionary
    search — more population and generations — so the hunt digs deeper
    each time it comes back empty-handed. Validation thresholds NEVER move.
    Returns (survivors, total genomes evaluated)."""
    r = dict(cfg["research"])
    rep: dict = report if report is not None else {}
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
    workers = max(1, min((os.cpu_count() or 1) - 1, 6))

    eligible = {i: c for i, c in candles_by_inst.items() if len(c) >= min_bars}
    for inst, c in candles_by_inst.items():
        if inst not in eligible:
            log(f"research {inst}: only {len(c)} bars, skipping (need {min_bars}+)")
    if not eligible:
        log("research: no instrument has enough history")
        return [], 0
    bar = next(iter(eligible.values())).bar
    bpy = BARS_PER_YEAR[bar]
    mode = r.get("mode", "panel")

    top_n, memb_bars = _membership_cfg(cfg)
    if mode == "panel":
        panel = Panel(eligible, leader=leader_inst, top_n=top_n,
                      membership_bars=memb_bars)
        if top_n is not None:
            have_qv = all(np.any(c.qv > 0) for c in eligible.values())
            log(f"research: membership = top {top_n} by trailing "
                f"{memb_bars}-bar quote volume"
                + ("" if have_qv else " — quote volume missing for some names, "
                   "membership falls back to presence (weaker survivorship control)"))
            log(f"research: {int(panel.n_present[-1])} names investable now: "
                + ",".join(i.split("-")[0] for i in panel.members_now()))
        cut = panel.cut_index(r["is_fraction"])
        panel_is = panel.slice_to(cut)
        log(f"research: panel of {panel.k} instruments, {panel.n} bars of {bar} "
            f"(in-sample {panel_is.n}, holdout {panel.n - cut - r['embargo_bars']}), "
            f"population={r['population']} generations={r['generations']} "
            f"workers={workers}")
        archive: list = []
        t0 = time.time()
        pop, n_eval = evolve(
            panel_is, population=r["population"], generations=r["generations"],
            fee_bps=fee_bps, slip_bps=slip_bps, seed=r.get("seed"),
            log=log, workers=workers, archive=archive)
        total_trials += n_eval
        log(f"research: evolution evaluated {n_eval} rules in {time.time() - t0:.0f}s")
        R = return_matrix(archive)
        pb = cscv(R, bpy, n_blocks=int(r.get("pbo_blocks", 10)))
        rep["pbo"] = pb
        rep["n_evaluated"] = n_eval
        log(f"research: CSCV over {pb['n_trials']} rules x {pb['n_combos']} splits: "
            f"PBO={pb['pbo']:.2f} median OOS sharpe of IS-winner={pb['oos_sharpe_median']:.2f} "
            f"P(loss)={pb['p_oos_loss']:.2f} slope={pb['slope']:.2f}")
        if pb["pbo"] > float(r.get("max_pbo", 0.5)):
            log(f"research: PBO {pb['pbo']:.2f} > {r.get('max_pbo', 0.5)} — the search "
                "is ranking noise; nothing from evolution is eligible this pass")
        else:
            survivors = validate_panel(
                pop, panel, is_fraction=r["is_fraction"],
                embargo_bars=r["embargo_bars"],
                min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
                max_oos_drawdown=float(r.get("max_oos_drawdown", 0.30)),
                fee_bps=fee_bps, slip_bps=slip_bps, top_k=int(r.get("top_k", 10)),
                max_deployed=r["max_deployed"], n_folds=int(r.get("n_folds", 4)),
                log=log)
            for s_ in survivors:
                s_.oos_stats["pbo"] = pb["pbo"]
            log(f"research panel: {len(survivors)} rules passed the holdout")
            all_survivors.extend(survivors)
    else:
        eligible_list = []
        for inst, candles in eligible.items():
            leader = eligible.get(leader_inst) if (
                leader_inst and leader_inst != inst) else None
            eligible_list.append((inst, candles, leader))
        n_universe = max(len(eligible_list), 1)
        wk = max(1, min(len(eligible_list), workers))
        log(f"research: {len(eligible_list)} instruments on {wk} worker(s), "
            f"population={r['population']} generations={r['generations']}")
        if wk == 1:
            results = [_research_one(i, c, ld, r, fee_bps, slip_bps, n_universe)
                       for i, c, ld in eligible_list]
        else:
            import concurrent.futures as cf
            with cf.ProcessPoolExecutor(max_workers=wk) as pool:
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
            for s_ in survivors:
                s_.oos_stats["n_trials_charged"] = charged
            log(f"research {inst}: {len(survivors)} strategies passed OOS "
                f"validation ({n_trials} genomes, DSR N={charged})")
            all_survivors.extend(survivors)
            total_trials += n_trials

    # ---- cross-sectional portfolio strategies (market-neutral books) -----
    if len(eligible) >= 4:
        from ..research.xs import research_xs, xs_total_trials
        fams = tuple(r.get("xs_families") or ())
        if fams:
            xs_survivors = research_xs(
                eligible, fee_bps=fee_bps, slip_bps=slip_bps,
                is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
                min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
                max_oos_drawdown=float(r.get("max_oos_drawdown", 0.35)),
                log=log, leader=leader_inst, families=fams,
                top_n=top_n, membership_bars=memb_bars)
            all_survivors.extend(xs_survivors)
            total_trials += xs_total_trials(fams, bar)
            log(f"research XS: {len(xs_survivors)} portfolio strategies deployed")

    # ---- the deployed set must work as a book ----------------------------
    all_survivors = select_book(all_survivors, r["min_oos_sharpe"], bpy, log)
    rep["deployed"] = len(all_survivors)
    rep["total_trials"] = total_trials
    rep["finished_at"] = time.time()
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
                bpy = BARS_PER_YEAR.get(self.cfg.get("bar", "1H"), 8760)
                per_day = max(1, bpy // 365)
                self.governor = LeverageGovernor(
                    max_boost=float(g.get("max_boost", 1.5)),
                    window=14 * per_day, min_track=2 * per_day,
                    bars_per_year=bpy)

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
            if s.inst == PANEL_INST:
                eligible = {i: c for i, c in candles_by_inst.items()
                            if len(c) >= 600}
                top_n, memb_bars = _membership_cfg(self.cfg)
                book = panel_live_book(eligible, s.genome, leader_inst,
                                       top_n=top_n, membership_bars=memb_bars)
                if book:
                    per_strategy[sid] = book
                    self.last_positions[sid] = book
                continue
            if s.genome.signal in XS_KINDS:
                eligible = {i: c for i, c in candles_by_inst.items()
                            if len(c) >= 600}
                top_n, memb_bars = _membership_cfg(self.cfg)
                _, _, pos_map = xs_positions(eligible, s.genome.params,
                                             kind=XS_KINDS[s.genome.signal],
                                             leader=leader_inst, top_n=top_n,
                                             membership_bars=memb_bars)
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
        # rebalance band: allocator weights and the portfolio vol scale drift
        # a little every bar; re-sizing a position for a drift smaller than
        # this fraction of equity only pays fees. Closing to zero is exempt.
        band = float(self.cfg["live"].get("rebalance_band", 0.02)) * equity
        for inst in sorted(all_insts):
            px = prices.get(inst, 0.0)
            if px <= 0:
                continue
            tgt_qty = targets.get(inst, 0.0) * equity / px
            cur_qty = current.get(inst, 0.0)
            delta = tgt_qty - cur_qty
            if abs(tgt_qty) > 1e-12 and abs(delta) * px < band:
                continue
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
        ensure_state_version(state_dir, log=None)
        self.log = _log_factory(state_dir)
        self.store = DataStore(cfg["data_dir"])
        self.registry = Registry(state_dir)
        self._research_lock = threading.Lock()

        from ..exchange.okx_client import OKXClient
        creds = cfg.credentials
        self.client = OKXClient(creds)
        self.instruments: list[str] = resolve_universe(cfg, state_dir, self.client,
                                                       log=self.log)
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
            # Paper fills mirror the live execution model: post-only at the
            # touch, with the configured miss rate falling back to taker at
            # bid/ask — the same assumption every backtest was scored under.
            costs = cfg["costs"]
            self.broker = PaperBroker(
                cash=cfg["live"]["paper_equity"],
                fee_bps=float(costs["taker_fee_bps"]),
                maker_fee_bps=float(costs.get("maker_fee_bps", 2.0)),
                slippage_bps=float(costs["slippage_bps"]),
                maker_miss_rate=(float(costs.get("maker_miss_rate", 0.3))
                                 if costs.get("prefer_maker", True) else 1.0),
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
        for inst in self.instruments:
            try:
                self.client.set_leverage(inst, lever, td)
            except Exception as exc:
                self.log(f"account: leverage {inst} ({type(exc).__name__}: {exc})")

    # ------------------------------------------------------------------ #

    def _load_candles(self) -> dict[str, Candles]:
        return {inst: self.store.load(inst, self.cfg["bar"])
                for inst in self.instruments}

    def ensure_data(self) -> None:
        from ..data.fetcher import fetch_candles, fetch_funding, fetch_microstructure
        self.instruments = resolve_universe(self.cfg, self.cfg["state_dir"],
                                            self.client, log=self.log)
        for inst in self.instruments:
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
        self._ensure_scalp_data()

    def _ensure_scalp_data(self) -> None:
        if self.scalp is None:
            return
        from ..data.fetcher import fetch_candles
        from ..scalp.clock import ASSETS, BARS, DAYS
        leaders = list(ASSETS)
        for bar in BARS:
            d = DAYS[bar]
            for inst in leaders:
                try:
                    self.log(f"desk backfill {inst} {bar} ({d}d)...")
                    fetch_candles(self.client, self.store, inst, bar, d, log=self.log)
                except Exception as exc:
                    self.log(f"desk backfill {inst} {bar}: {type(exc).__name__}: {exc}")

    def ensure_research(self, force: bool = False) -> bool:
        """Re-run the hunt when the deployed set is stale (weekly), daily
        while the book is empty, or when it never ran. Returns True when a
        pass ran. Serialised: two passes never overlap."""
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
        if not (force or stale or never_ran):
            return False
        lock = getattr(self, "_research_lock", None)
        if lock is None:
            lock = self._research_lock = threading.Lock()
        if not lock.acquire(blocking=False):
            self.log("research pass already running, skipping")
            return False
        try:
            self.log(f"research pass starting (stale={stale}, "
                     f"deployed={len(self.registry.strategies)}, "
                     f"empty_streak={self.registry.consecutive_empty})")
            report: dict = {"started_at": time.time()}
            survivors, n_trials = run_research(
                self._load_candles(), self.cfg, self.log,
                escalation=self.registry.consecutive_empty, report=report)
            replaced = self.registry.apply_survivors(survivors)
            if not replaced:
                self.log(f"research empty — keeping {len(self.registry.strategies)} "
                         "already-deployed strategies (will not unwind the book)")
            self.registry.record_outcome(survivors)
            self.registry.researched_at = time.time()
            self.registry.n_trials = n_trials
            self.registry.last_report = report
            self.registry.save()
            self.log(f"research done: {len(self.registry.strategies)} deployed")
            return True
        finally:
            lock.release()

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
        for inst in self.instruments:
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
        self.log(f"Hermes v{ENGINE_VERSION} starting: mode={self.cfg['live']['mode']} "
                 f"bar={self.cfg['bar']} instruments={len(self.instruments)} "
                 f"deployed={len(self.registry.strategies)}"
                 + (" +scalp-desk" if self.scalp else ""))
        if self.risk.state.killed:
            self.log("KILL SWITCH is set — idling, no orders. "
                     f"reason={self.risk.state.kill_reason!r}. "
                     "reset_kill to resume. systemd must NOT respawn a halt.")
            self._idle_forever()
        # data first (blocking: the first decision needs full history), then
        # the hunt runs in the background so the loop is never blocked by a
        # research pass — the book keeps trading whatever is deployed
        try:
            self.ensure_data()
        except Exception as exc:
            self.log(f"startup sync failed ({type(exc).__name__}: {exc}); "
                     "continuing with cached data")
        threading.Thread(target=self._research_bg, daemon=True).start()
        if self.scalp:
            self._ensure_scalp_data()
            try:
                self.scalp.horizons.fit_store(self.store, list(self.scalp.instruments))
            except Exception as exc:
                self.log(f"learner fit: {type(exc).__name__}: {exc}")
        poll = int(self.cfg["live"]["poll_seconds"])
        if self.scalp:
            poll = min(poll, int((self.cfg.raw.get("scalp") or {}).get("poll_seconds", 5)))
        last_cycle_bar = 0
        last_light = 0.0
        while True:
            try:
                now = time.time()
                # the swing book: one decision per closed bar
                if now - last_light >= max(poll, 20):
                    last_light = now
                    self._refresh_latest()
                    candles = self._load_candles()
                    newest = max((int(c.ts[-1]) for c in candles.values() if len(c)),
                                 default=0)
                    if newest > last_cycle_bar:
                        last_cycle_bar = newest
                        if self.registry.strategies:
                            report = self.trader.run_cycle(candles, now)
                            self.trader.save_state(self.cfg["state_dir"])
                            tg = {k.split("-")[0]: round(v, 3)
                                  for k, v in report.get("targets", {}).items()
                                  if abs(v) > 1e-4}
                            self.log(f"cycle @ {newest}: equity={report['equity']:.2f} "
                                     f"book={tg}")
                        else:
                            # nothing deployed: still mark to market so the
                            # journal / dashboard stay alive
                            prices = {i: float(c.c[-1]) for i, c in candles.items()
                                      if len(c)}
                            if prices:
                                self.trader.heartbeat(prices, now)
                if self.risk.state.killed:
                    self.log("KILL SWITCH TRIPPED - idling (no systemd restart mill).")
                    self._idle_forever()
                if self.scalp:
                    self._scalp_step()
                else:
                    try:
                        ticks = self.client.tickers(self.instruments)
                        if ticks:
                            self.trader.heartbeat(ticks, time.time())
                            self.trader.save_state(self.cfg["state_dir"])
                    except Exception as exc:
                        self.log(f"heartbeat: {type(exc).__name__}: {exc}")
            except KeyboardInterrupt:
                self.log("interrupted, exiting cleanly")
                return
            except Exception as exc:
                self.log(f"cycle error: {type(exc).__name__}: {exc}")
            time.sleep(poll)

    def _idle_forever(self) -> None:
        while True:
            time.sleep(30)

    def _refresh_latest(self) -> None:
        from ..data.fetcher import update_latest
        for inst in self.instruments:
            try:
                update_latest(self.client, self.store, inst, self.cfg["bar"])
            except Exception as exc:
                self.log(f"refresh {inst}: {type(exc).__name__}: {exc}")

    def _research_bg(self) -> None:
        """Background hunt: checks hourly whether the deployed set is stale
        (weekly) or empty (daily) and re-runs the whole research pass on
        fresh data. Never blocks the trading loop."""
        time.sleep(5)
        while True:
            try:
                self.ensure_research()
            except Exception as exc:
                self.log(f"research thread: {type(exc).__name__}: {exc}")
            time.sleep(3600)

    # ---- optional intraday desk (opt-in) ----------------------------------

    def _scalp_step(self) -> None:
        from ..data.fetcher import update_latest
        try:
            ticks = self.client.swap_tickers()
        except Exception as exc:
            self.log(f"scalp tickers: {type(exc).__name__}: {exc}")
            ticks = {}
        if ticks:
            if self.scalp.universe_at == 0.0 or time.time() - self.scalp.universe_at > 900:
                self.scalp.refresh_universe(ticks)
            else:
                self.scalp.ticks = ticks
            if hasattr(self.broker, "mark_ticks"):
                self.broker.mark_ticks(ticks)
        names = list(self.scalp.instruments)
        if time.time() - getattr(self, "_last_learn", 0.0) > 3600:
            self._last_learn = time.time()

            def _refit():
                try:
                    self.scalp.horizons.fit_store(self.store, names)
                except Exception as exc:
                    self.log(f"learner refit: {type(exc).__name__}: {exc}")
            threading.Thread(target=_refit, daemon=True).start()
        t0, r0 = self.client.timeout, self.client.max_retries
        self.client.timeout, self.client.max_retries = 4.0, 1
        try:
            for inst in names:
                try:
                    self.scalp.ingest_book(inst, self.client.books(inst, sz=10))
                except Exception as exc:
                    self.log(f"L2 {inst}: {type(exc).__name__}")
                try:
                    self.scalp.ingest_trades(inst, self.client.last_trades(inst, limit=50))
                except Exception:
                    pass
                for bar in ("1m", "3m", "5m", "15m"):
                    try:
                        update_latest(self.client, self.store, inst, bar, limit=120)
                    except Exception:
                        pass
        finally:
            self.client.timeout, self.client.max_retries = t0, r0
        from ..scalp.clock import BARS as _BARS
        if not hasattr(self, "_last_scalp_bar"):
            self._last_scalp_bar = {b: 0 for b in _BARS}
        any_new = False
        for bar in _BARS:
            cbar = {inst: self.store.load(inst, bar) for inst in names}
            newest = max((int(c.ts[-1]) for c in cbar.values() if len(c)), default=0)
            if newest > self._last_scalp_bar.get(bar, 0):
                self._last_scalp_bar[bar] = newest
                any_new = True
                rep = self.scalp.tick(cbar, time.time(), bar=bar)
                live = [p for p in (rep.get("preds") or []) if p.get("dir") != "flat"]
                self.log(f"desk {bar} @ {newest}: eq={rep.get('equity', 0):.2f} "
                         f"live={len(live)}/{len(rep.get('preds') or [])}")
        if not any_new:
            if self.risk.trading_allowed:
                self.scalp.check_exits()
                self.scalp.execute_pending()
            else:
                self.scalp.pending = {}
        px = {i: float((t or {}).get("last") or 0)
              for i, t in (self.scalp.ticks or {}).items()}
        px = {k: v for k, v in px.items() if v > 0}
        if px:
            eq = self.trader.heartbeat(px, time.time())
            self.trader.save_state(self.cfg["state_dir"])
            self.scalp._snapshot({"equity": eq})
