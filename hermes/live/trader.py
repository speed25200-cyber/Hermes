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
from ..research.panel import PANEL_INST, panel_positions
from ..research.validate import (ValidatedStrategy, split_is_oos,
                                 validate_candidates,
                                 window_supports_validation)
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

    def record_outcome(self, survivors: list) -> None:
        """Track how many consecutive passes came back empty — the hunt
        escalates its search budget and cadence while the book is empty."""
        self.consecutive_empty = 0 if survivors else self.consecutive_empty + 1

    def sid(self, s: ValidatedStrategy) -> str:
        return f"{s.inst}:{s.genome.gid}"

    def prune_to_gates(self, r: dict, log=None) -> int:
        """Drop inherited strategies that today's gates would not admit.

        The registry outlives the thresholds that wrote it. A book validated
        under min_dsr 0.05 stays on disk and is traded verbatim after the
        gate is raised, because nothing re-examines it — the engine loads
        what research left. Raising a gate has to apply to the capital
        already deployed against the old one, or it only governs strategies
        that do not exist yet.

        The recorded OOS statistics are what the gate judged, so this is a
        re-read of the same verdict, not a re-run: no data is needed and
        nothing is recomputed. A strategy whose stats were never recorded
        cannot be vouched for either, and goes with them.
        """
        keep, dropped = [], []
        for s in self.strategies:
            dsr = s.oos_stats.get("dsr")
            sharpe = s.oos_stats.get("sharpe")
            if (dsr is None or sharpe is None
                    or dsr < r["min_dsr"] or sharpe < r["min_oos_sharpe"]):
                dropped.append(s)
            else:
                keep.append(s)
        if dropped and log:
            worst = max((s.oos_stats.get("dsr") or 0.0) for s in dropped)
            log(f"registry: dropped {len(dropped)} of {len(self.strategies)} "
                f"strategies that today's gates reject (best DSR among them "
                f"{worst:.3f} against a floor of {r['min_dsr']:.2f}) — they "
                f"were validated under looser thresholds")
        self.strategies = keep
        return len(dropped)


def make_ctx(candles_by_inst: dict[str, Candles], inst: str,
             leader_inst: str | None) -> dict:
    """Cross-asset context for signal computation: the universe leader whose
    lagged returns feed lead-lag ML features (not used for itself)."""
    if leader_inst and leader_inst != inst and leader_inst in candles_by_inst:
        return {"leader": candles_by_inst[leader_inst]}
    return {}


def _aux_start(candles: Candles) -> int | None:
    """First bar index where every aux series (OI, taker flow, positioning)
    is populated, or None if any is missing entirely."""
    need = ("oi", "tak_buy", "tak_sell", "lsr")
    if any(k not in candles.x for k in need):
        return None
    valid = np.ones(len(candles), dtype=bool)
    for k in need:
        valid &= ~np.isnan(candles.x[k])
    idx = np.nonzero(valid)[0]
    return int(idx[0]) if len(idx) else None


AUX_MIN_BARS = 4800  # ~50 days of 15m bars: minimum aux coverage to research


def _with_incumbents_first(pop, incumbent_genomes, candles_is, fee_bps,
                           slip_bps, ctx):
    """Guarantee every deployed incumbent reaches the OOS validation gate,
    ahead of the newcomers. An incumbent with mediocre in-sample fitness
    (rsi_rev BTC had IS 0.31 / OOS 2.95) must not be culled before the OOS
    exam — it keeps its seat only by failing the gates on fresh data."""
    if not incumbent_genomes:
        return pop
    from ..research.evolve import Candidate, _fitness
    gids = {g.gid for g in incumbent_genomes}
    head = []
    for g in incumbent_genomes:
        fit, stats = _fitness(candles_is, g, fee_bps, slip_bps, ctx=ctx)
        head.append(Candidate(g, fit, stats))
    return head + [c for c in pop if c.genome.gid not in gids]


def _research_one(inst: str, candles: Candles, leader: Candles | None,
                  r: dict, fee_bps: float, slip_bps: float,
                  incumbents: list[Genome] | None = None
                  ) -> tuple[str, list[ValidatedStrategy], int, list[str]]:
    """Evolve + validate a single instrument (worker-safe: no shared state,
    returns log lines instead of printing). Deployed incumbents for this
    instrument are seeded into the search so the book has continuity: they
    survive when they still pass, never vanish to random-search luck."""
    from ..strategy.genome import AUX_SIGNALS
    lines: list[str] = []
    inc = incumbents or []
    seeds_core = [g for g in inc if g.signal not in AUX_SIGNALS]
    seeds_aux = [g for g in inc if g.signal in AUX_SIGNALS]
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
        seed=r.get("seed"), ctx=ctx_is, seeds=seeds_core, log=None,
    )
    pop = _with_incumbents_first(pop, seeds_core, candles_is, fee_bps,
                                 slip_bps, ctx_is)
    survivors = validate_candidates(
        pop, candles, n_trials=n_trials,
        is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
        min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
        fee_bps=fee_bps, slip_bps=slip_bps,
        max_deployed=r["max_deployed"], max_corr=r.get("max_corr", 0.9),
        ctx=ctx, log=lines.append,
    )

    # ---- aux-data families, searched only on the window the rubik series
    # actually cover (a few months) — same validation gates, never mixed
    # into the multi-year pass where their inputs would be blank
    i0 = _aux_start(candles)
    if i0 is not None and len(candles) - i0 >= AUX_MIN_BARS:
        ca = candles.slice(i0, len(candles))
        lines.append(f"  aux search {inst}: {len(ca)} covered bars")
        pop_a_planned = max(48, r["population"] // 2)
        gen_a_planned = max(12, r["generations"] // 2)
        ok, need = window_supports_validation(
            n_oos=int(len(ca) * (1.0 - r["is_fraction"])),
            n_trials=pop_a_planned * (gen_a_planned + 1),
            bars_per_year=BARS_PER_YEAR[candles.bar],
            max_bar=float(r.get("max_selection_bar", 10.0)))
        if not ok:
            # The exchange serves ~65 days of open interest and taker flow;
            # the store keeps every row it has ever seen, so this window grows
            # on its own. Searching it early cannot find anything real — it
            # can only mint candidates whose Sharpe is the search's, not the
            # market's, which is exactly what the live book was full of.
            have_d = len(ca) * (1.0 - r["is_fraction"]) * 15 / 1440
            need_d = need * 15 / 1440
            lines.append(
                f"  aux search {inst}: skipped — {have_d:.0f} days of scored "
                f"history against the {need_d:.0f} a search this size needs "
                f"before selection noise drops below Sharpe "
                f"{r.get('max_selection_bar', 10.0):.0f}. Recording continues; "
                f"the window grows on its own.")
            i0 = None
    if i0 is not None and len(candles) - i0 >= AUX_MIN_BARS:
        ca = candles.slice(i0, len(candles))
        ca_is, _ = split_is_oos(ca, r["is_fraction"], r["embargo_bars"])
        pop_a, trials_a = evolve(
            ca_is,
            population=max(48, r["population"] // 2),
            generations=max(12, r["generations"] // 2),
            fee_bps=fee_bps, slip_bps=slip_bps,
            seed=r.get("seed"), families=tuple(AUX_SIGNALS),
            seeds=seeds_aux, log=None,
        )
        pop_a = _with_incumbents_first(pop_a, seeds_aux, ca_is, fee_bps,
                                       slip_bps, None)
        survivors += validate_candidates(
            pop_a, ca, n_trials=trials_a,
            is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
            min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
            fee_bps=fee_bps, slip_bps=slip_bps,
            max_deployed=r["max_deployed"],
            max_corr=r.get("max_corr", 0.9), log=lines.append,
        )
        n_trials += trials_a
    # max_deployed is a per-instrument cap, and the aux pass appends to the
    # same book: without trimming here the two passes together deploy twice
    # the configured limit. Best OOS Sharpe first, so the cut keeps the
    # strongest survivors regardless of which pass found them.
    if len(survivors) > r["max_deployed"]:
        survivors.sort(key=lambda s: s.oos_stats.get("sharpe", 0.0),
                       reverse=True)
        survivors = survivors[:r["max_deployed"]]
    return inst, survivors, n_trials, lines


def run_research(candles_by_inst: dict[str, Candles], cfg: Config, log,
                 min_bars: int = 2000, escalation: int = 0,
                 incumbents: list[ValidatedStrategy] | None = None
                 ) -> tuple[list[ValidatedStrategy], int]:
    """Full autonomous research pass over every instrument, parallelised
    across CPU cores (each instrument is independent).

    escalation > 0 (consecutive empty passes) widens the evolutionary
    search — more population and generations — so the hunt digs deeper
    each time it comes back empty-handed. Validation thresholds NEVER move.
    `incumbents` (the currently deployed book) are seeded into each
    instrument's search for continuity. Returns (survivors, total genomes
    evaluated)."""
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

    by_inst: dict[str, list] = {}
    for s in incumbents or []:
        by_inst.setdefault(s.inst, []).append(s.genome)

    eligible_list = []
    for inst, candles in candles_by_inst.items():
        if len(candles) < min_bars:
            log(f"research {inst}: only {len(candles)} bars, skipping "
                f"(need {min_bars}+)")
            continue
        leader = candles_by_inst.get(leader_inst) if (
            leader_inst and leader_inst != inst) else None
        eligible_list.append((inst, candles, leader, by_inst.get(inst)))

    # worker count: leave one core for the OS/dashboard, cap memory usage
    workers = max(1, min(len(eligible_list), (os.cpu_count() or 1) - 1, 6))
    log(f"research: {len(eligible_list)} instruments on {workers} worker(s), "
        f"population={r['population']} generations={r['generations']}")

    if workers == 1:
        results = [_research_one(i, c, ld, r, fee_bps, slip_bps, inc)
                   for i, c, ld, inc in eligible_list]
    else:
        import concurrent.futures as cf
        with cf.ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_research_one, i, c, ld, r, fee_bps,
                                   slip_bps, inc)
                       for i, c, ld, inc in eligible_list]
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
            min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
            max_selection_bar=float(r.get("max_selection_bar", 10.0)),
            log=log, leader=leader_inst)
        all_survivors.extend(xs_survivors)
        total_trials += XS_TOTAL_TRIALS
        log(f"research XS: {len(xs_survivors)} portfolio strategies deployed")

    # ---- panel: one rule applied to the whole universe -----------------
    # The per-instrument pass asks whether a rule works on ATOM, and a
    # 2,400-genome search over ATOM's own record cannot answer that: the
    # selection bar sits above any edge a single name carries. Asking
    # whether the same rule works across every name at once costs one grid
    # instead of thirty searches and scores a portfolio rather than a
    # position, which lifts a shared edge by roughly sqrt(N) while leaving
    # the bar where it was. Measured on a planted edge across twenty names:
    # 0.93 alone, under a 3.61 bar; 4.72 pooled, over it.
    if len(eligible) >= 4:
        from ..research.panel import panel_grid, research_panel
        grid = panel_grid(r.get("panel_seed"))
        panel_survivors = research_panel(
            eligible, grid, fee_bps=fee_bps, slip_bps=slip_bps,
            is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
            min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
            max_corr=r.get("max_corr", 0.9),
            max_selection_bar=float(r.get("max_selection_bar", 10.0)),
            log=log)
        all_survivors.extend(panel_survivors)
        total_trials += len(grid)
        log(f"research panel: {len(panel_survivors)} universe-wide rules "
            f"deployed from a {len(grid)}-rule grid")

    # A book is capped in total, not just per instrument. Capital is shared
    # across everything deployed, so an unbounded book starves each strategy:
    # measured on the live allocator, 18 strategies put a typical signal at
    # 454 USDT of a 9,955 USDT book while 60 put it at 136 — under the
    # rebalance band, which is the flat-book failure all over again. Widening
    # the universe multiplies candidates, so the cap has to bind globally.
    cap = int(cfg["research"].get("max_deployed_total", 0) or 0)
    return cap_book(all_survivors, cap, log), total_trials


def cap_book(survivors: list[ValidatedStrategy], cap: int,
             log=None) -> list[ValidatedStrategy]:
    """Keep the best `cap` strategies across the whole universe.

    A per-instrument cap does not bound a book. Capital is shared over
    everything deployed, so an unbounded book starves each strategy: measured
    on the live allocator, 18 strategies put a typical signal at 454 USDT of a
    9,955 USDT book while 60 put it at 136 — under the rebalance band, which
    is the flat-book failure all over again. Widening the universe multiplies
    candidates, so this has to bind globally.

    Slots are filled instrument by instrument, best first, rather than by
    global Sharpe rank. Taking the top N outright would hand every slot to
    whichever few instruments drew the luckiest estimates — and those
    estimates are noisy enough that the allocator already refuses to chase
    them. Spreading across names is the entire reason for widening the
    universe, so the cap has to preserve it.
    """
    if not cap or len(survivors) <= cap:
        return survivors
    by_inst: dict[str, list] = {}
    for s in survivors:
        by_inst.setdefault(s.inst, []).append(s)
    for group in by_inst.values():
        group.sort(key=lambda s: s.oos_stats.get("sharpe", 0.0), reverse=True)
    order = sorted(by_inst, key=lambda i: -by_inst[i][0].oos_stats.get("sharpe", 0.0))

    kept: list = []
    rank = 0
    while len(kept) < cap:
        added = False
        for inst in order:
            if rank < len(by_inst[inst]):
                kept.append(by_inst[inst][rank])
                added = True
                if len(kept) >= cap:
                    break
        if not added:
            break
        rank += 1
    if log:
        log(f"research: book capped at {cap} strategies across "
            f"{len({s.inst for s in kept})} instruments "
            f"({len(survivors) - len(kept)} dropped) so each keeps enough "
            f"capital to reach the market")
    return kept


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
                                             kind=XS_KINDS[s.genome.signal],
                                             leader=leader_inst)
                if pos_map:
                    book = {inst: float(arr[-1]) for inst, arr in pos_map.items()
                            if len(arr)}
                    per_strategy[sid] = book
                    self.last_positions[sid] = book
                continue
            if s.inst == PANEL_INST:
                # one rule over the whole universe: a multi-leg book like the
                # cross-sectional families, so it takes the same path. Without
                # this branch the lookup below asks for an instrument called
                # "PANEL" and the strategy silently never trades.
                eligible = {i: c for i, c in candles_by_inst.items()
                            if len(c) >= 600}
                _, pos_map = panel_positions(eligible, s.genome)
                if pos_map:
                    book = {inst: float(arr[-1])
                            for inst, arr in pos_map.items() if len(arr)}
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
        books = [set(legs) for legs in per_strategy.values() if len(legs) > 1]
        orders = self._reconcile(targets, prices, equity, books,
                                 derisk=risk_mult < 1.0)

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

    # no-trade band for single-instrument books (the XS books carry their
    # own): a position only moves when the target drifts materially — at
    # least REBALANCE_FLOOR of equity AND REBALANCE_REL of the held
    # exposure. Absorbs the per-cycle churn of z-score signals oscillating
    # near their entry threshold (fees ate ~0.5%/day of whipsaw on AVAX
    # before this). Chosen a priori, identical for every strategy: adds
    # ZERO trials to the deflated-Sharpe penalty. Full closes always pass.
    REBALANCE_FLOOR = 0.02   # 2% of equity
    REBALANCE_REL = 0.20     # 20% of the currently-held exposure

    def _breaches_band(self, tgt_exp: float, cur_exp: float,
                       derisk: bool = False) -> bool:
        """Is this move worth sending, or is it churn inside the dead band?"""
        if tgt_exp == 0.0:
            return True                       # full closes always pass
        band = max(self.REBALANCE_FLOOR, self.REBALANCE_REL * abs(cur_exp))
        if derisk and abs(tgt_exp) < abs(cur_exp):
            # The leverage governor has cut exposure this cycle. That is a risk
            # instruction, not signal drift, so only the absolute floor applies:
            # the relative band would swallow any cut smaller than 20% of the
            # held position and the journal would record the risk-off
            # multiplier as applied while no order was ever sent.
            band = self.REBALANCE_FLOOR
        return abs(tgt_exp - cur_exp) >= band

    def _reconcile(self, targets: dict[str, float], prices: dict[str, float],
                   equity: float,
                   books: list[set[str]] | None = None,
                   derisk: bool = False) -> list[dict]:
        current = self.broker.positions()
        orders = []
        all_insts = set(targets) | set(current)

        def cur_exposure(inst: str, px: float) -> float:
            return current.get(inst, 0.0) * px / equity if equity > 0 else 0.0

        trade = {}
        for inst in all_insts:
            px = prices.get(inst, 0.0)
            trade[inst] = px > 0 and (
                equity <= 0
                or self._breaches_band(targets.get(inst, 0.0),
                                       cur_exposure(inst, px), derisk))
        # a cross-sectional book moves as a unit: if any leg breaches its band
        # every leg trades. Executing the large legs while the small ones sit
        # inside the band would leave a dollar-neutral book net long or short,
        # which is precisely what it exists not to be.
        for members in (books or []):
            if any(trade.get(i) for i in members):
                for i in members:
                    if prices.get(i, 0.0) > 0:
                        trade[i] = True

        for inst in sorted(all_insts):
            px = prices.get(inst, 0.0)
            if px <= 0 or not trade[inst]:
                continue
            tgt_exp = targets.get(inst, 0.0)
            cur_qty = current.get(inst, 0.0)
            tgt_qty = tgt_exp * equity / px
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
        if self.governor is not None:
            d["governor"] = self.governor.to_dict()
        if isinstance(self.broker, PaperBroker):
            d["paper_broker"] = self.broker.to_dict()
        stats = getattr(self.broker, "exec_stats", None)
        if stats is not None:
            d["exec_stats"] = stats.to_dict()
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
        stats = getattr(self.broker, "exec_stats", None)
        if stats is not None and "exec_stats" in d:
            stats.restore(d["exec_stats"])


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
        # a book inherited from a looser gate is re-read against the current
        # one before a single order is sized against it
        if self.registry.prune_to_gates(cfg["research"], self.log):
            self.registry.save()

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
        from ..data.fetcher import (IDX_SUFFIX, fetch_aux, fetch_candles,
                                    fetch_funding, fetch_index)
        for inst in self.cfg["instruments"]:
            _, _, n = self.store.candle_range(inst, self.cfg["bar"])
            if n < 2000:
                self.log(f"backfilling {inst} ({self.cfg['history_days']}d of "
                         f"{self.cfg['bar']} candles)...")
                fetch_candles(self.client, self.store, inst, self.cfg["bar"],
                              self.cfg["history_days"], log=self.log)
                fetch_funding(self.client, self.store, inst,
                              self.cfg["history_days"], log=self.log)
            # aux stats (open interest / taker flow / positioning): backfill
            # when absent, or catch up after downtime beyond the light
            # per-cycle refresh window
            _, hi, n_oi = self.store.aux_range(inst, "oi")
            if n_oi == 0 or hi < (time.time() - 2 * 86_400) * 1000:
                self.log(f"backfilling aux stats for {inst}...")
                fetch_aux(self.client, self.store, inst,
                          self.cfg["history_days"], log=self.log)
            # underlying index candles (basis signal): full-history backfill
            _, _, n_idx = self.store.candle_range(inst + IDX_SUFFIX,
                                                  self.cfg["bar"])
            if n_idx < 2000:
                self.log(f"backfilling index candles for {inst}...")
                try:
                    fetch_index(self.client, self.store, inst, self.cfg["bar"],
                                self.cfg["history_days"], log=self.log)
                except Exception as exc:
                    self.log(f"index backfill {inst} failed: "
                             f"{type(exc).__name__}: {exc}")

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
                escalation=self.registry.consecutive_empty,
                incumbents=self.registry.strategies)
            if survivors or not self.registry.strategies:
                self.registry.strategies = survivors
            self.registry.record_outcome(survivors)
            self.registry.researched_at = time.time()
            self.registry.n_trials = n_trials
            self.registry.save()
            self.log(f"research done: {len(self.registry.strategies)} deployed")

    def _refresh_universe(self) -> None:
        """Re-read the venue-resolved universe.

        The engine is a long-lived service while fetch and research run on
        their own schedule, so a universe resolved by a later fetch would
        never reach this loop and the strategies research deployed on the new
        names would be skipped for having no instrument to trade.
        """
        if int(self.cfg.get("universe_size", 0) or 0) <= 0:
            return
        from ..data.universe import load_persisted, order
        persisted = load_persisted(self.cfg["state_dir"])
        if not persisted:
            return
        current = list(self.cfg["instruments"])
        leader = current[0] if current else ""
        try:
            held = [i for i, q in self.trader.broker.positions().items()
                    if abs(float(q)) > 1e-12]
        except Exception:
            held = []
        fresh = order(persisted, leader, held)
        if fresh != current:
            self.log(f"universe refreshed: {len(current)} -> {len(fresh)} "
                     f"instruments")
            self.cfg.raw["instruments"] = fresh

    def run_once(self, allow_research: bool = False) -> dict | None:
        """One decision cycle then return — the execution model for scheduled
        runners (GitHub Actions cron): wake, decide, persist, exit.
        Research is opt-in so an hourly cycle never blocks on a long search."""
        try:
            self.ensure_data()
        except Exception as exc:
            self.log(f"cycle: backfill failed ({type(exc).__name__}: {exc}); "
                     "continuing with cached data")
        self._refresh_universe()
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
                self._refresh_universe()
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
