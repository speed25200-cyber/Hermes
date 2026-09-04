"""Evolutionary alpha search.

Fitness is computed ONLY on in-sample data, and is itself an average across
contiguous sub-windows (a strategy must work in every sub-period, not just on
one lucky stretch). Out-of-sample data is never touched during evolution —
it is reserved for the final validation gate in `validate.py`.

The search is evaluator-agnostic: a `SingleEvaluator` scores a genome on one
instrument, a `PanelEvaluator` scores the same rule applied across the whole
universe (the default research mode). Every evaluated genome's in-sample
return series is archived so the whole population can be audited for
backtest overfitting (see `pbo.py`).
"""

from __future__ import annotations

import multiprocessing as mp
import random
from dataclasses import dataclass, field

import numpy as np

from ..backtest import engine, metrics
from ..data.store import BARS_PER_YEAR, Candles
from ..strategy.genome import Genome, crossover, mutate, random_genome
from ..strategy.signals import compute_position
from .panel import Panel


@dataclass
class Candidate:
    genome: Genome
    fitness: float = -1e9
    is_stats: dict = field(default_factory=dict)
    rets: np.ndarray | None = None      # in-sample per-bar returns (float32)


def _window_fitness(rets: np.ndarray, turnover: float, bpy: int,
                    n_windows: int = 3) -> float:
    n = len(rets)
    if n < n_windows * 100:
        return -1e9
    edges = np.linspace(0, n, n_windows + 1).astype(int)
    ws = [metrics.sharpe(rets[a:b], bpy) for a, b in zip(edges[:-1], edges[1:])]
    eq = np.cumprod(1.0 + rets)
    mdd = metrics.max_drawdown(eq)
    total_sh = metrics.sharpe(rets, bpy)
    # trade-activity guard: strategies that barely trade are degenerate
    if turnover < 1e-5 or total_sh == 0.0:
        return -1e9
    return float(np.mean(ws) + 0.5 * np.min(ws) - 2.0 * mdd - 5.0 * turnover)


class SingleEvaluator:
    """Per-instrument fitness (legacy mode, also used by `realtest`)."""

    def __init__(self, candles_is: Candles, fee_bps: float, slip_bps: float,
                 ctx: dict | None = None):
        self.candles = candles_is
        self.fee, self.slip = fee_bps, slip_bps
        self.ctx = ctx
        self.bpy = BARS_PER_YEAR[candles_is.bar]

    def evaluate(self, g: Genome) -> tuple[float, dict, np.ndarray]:
        pos = compute_position(self.candles, g, self.ctx)
        res = engine.run(self.candles, pos, self.fee, self.slip)
        fit = _window_fitness(res.rets, res.turnover, self.bpy)
        return fit, res.stats, res.rets.astype(np.float32)


class PanelEvaluator:
    """Universe-wide fitness: the rule is applied to every instrument."""

    def __init__(self, panel_is: Panel, fee_bps: float, slip_bps: float):
        self.panel = panel_is
        self.fee, self.slip = fee_bps, slip_bps
        self.bpy = panel_is.bpy

    def evaluate(self, g: Genome) -> tuple[float, dict, np.ndarray]:
        P = self.panel.positions(g)
        rets, turnover, gross = self.panel.book_returns(P, self.fee, self.slip)
        eq = np.cumprod(1.0 + rets)
        stats = metrics.summarize(rets, eq, self.bpy, turnover, 1)
        stats["gross_exposure"] = gross
        fit = _window_fitness(rets, turnover, self.bpy)
        return fit, stats, rets.astype(np.float32)


# ---- worker-side evaluation (fork: the evaluator is inherited, no copies) --
_WORKER_EVAL = None


def _init_worker(evaluator) -> None:
    global _WORKER_EVAL
    _WORKER_EVAL = evaluator


def _worker_eval(gd: dict) -> tuple[float, dict, np.ndarray]:
    try:
        return _WORKER_EVAL.evaluate(Genome.from_dict(gd))
    except Exception as exc:  # a broken genome must not sink the generation
        return -1e9, {"error": f"{type(exc).__name__}: {exc}"}, np.zeros(0, np.float32)


def evolve(
    target,
    population: int = 96,
    generations: int = 25,
    fee_bps: float = 5.0,
    slip_bps: float = 2.0,
    seed: int | None = None,
    elite_frac: float = 0.1,
    ctx: dict | None = None,
    log=None,
    workers: int = 1,
    archive: list | None = None,
) -> tuple[list[Candidate], int]:
    """Returns (final population sorted by fitness desc, total genomes
    evaluated). `target` is a Candles (single-instrument mode), a Panel, or
    any object with an `evaluate(genome)` method. Every distinct genome
    evaluated is appended to `archive` when given (for CSCV / PBO)."""
    if isinstance(target, Candles):
        evaluator = SingleEvaluator(target, fee_bps, slip_bps, ctx)
    elif isinstance(target, Panel):
        evaluator = PanelEvaluator(target, fee_bps, slip_bps)
    else:
        evaluator = target
    rng = random.Random(seed)
    seen: dict[str, Candidate] = {}
    evaluated = 0

    pool = None
    if workers > 1:
        import concurrent.futures as cf
        pool = cf.ProcessPoolExecutor(
            max_workers=workers, mp_context=mp.get_context("fork"),
            initializer=_init_worker, initargs=(evaluator,))

    def eval_many(genomes: list[Genome]) -> list[Candidate]:
        nonlocal evaluated
        out: list[Candidate | None] = [None] * len(genomes)
        todo: list[tuple[int, Genome]] = []
        for i, g in enumerate(genomes):
            hit = seen.get(g.gid)
            if hit is not None:
                out[i] = Candidate(g, hit.fitness, hit.is_stats, hit.rets)
            else:
                todo.append((i, g))
        # dedupe within the batch
        first: dict[str, int] = {}
        uniq: list[tuple[int, Genome]] = []
        dup: list[tuple[int, str]] = []
        for i, g in todo:
            if g.gid in first:
                dup.append((i, g.gid))
            else:
                first[g.gid] = i
                uniq.append((i, g))
        if uniq:
            if pool is not None:
                results = list(pool.map(_worker_eval, [g.to_dict() for _, g in uniq],
                                        chunksize=1))
            else:
                results = [evaluator.evaluate(g) for _, g in uniq]
            for (i, g), (fit, stats, rets) in zip(uniq, results):
                c = Candidate(g, float(fit), stats, rets)
                seen[g.gid] = c
                evaluated += 1
                if archive is not None:
                    archive.append(c)
                out[i] = c
        for i, gid in dup:
            h = seen[gid]
            out[i] = Candidate(genomes[i], h.fitness, h.is_stats, h.rets)
        return [c for c in out if c is not None]

    try:
        pop = eval_many([random_genome(rng) for _ in range(population)])
        for gen in range(generations):
            pop.sort(key=lambda c: c.fitness, reverse=True)
            n_elite = max(2, int(population * elite_frac))
            elites = pop[:n_elite]

            def tournament() -> Candidate:
                return max(rng.sample(pop, 3), key=lambda c: c.fitness)

            children: list[Genome] = []
            while len(children) < population - n_elite:
                if rng.random() < 0.6:
                    child = crossover(tournament().genome, tournament().genome, rng)
                    child = mutate(child, rng, rate=0.25)
                else:
                    child = mutate(tournament().genome, rng, rate=0.5)
                children.append(child)
            pop = elites + eval_many(children)
            if log:
                best = max(pop, key=lambda c: c.fitness)
                log(f"gen {gen + 1}/{generations}: best_fitness={best.fitness:.3f} "
                    f"({best.genome.describe()}) evaluated={evaluated}")
    finally:
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)

    pop.sort(key=lambda c: c.fitness, reverse=True)
    return pop, evaluated


def return_matrix(candidates: list[Candidate]) -> np.ndarray:
    """(T, N) float32 matrix of in-sample returns for CSCV, keeping only
    candidates with a full-length series."""
    series = [c.rets for c in candidates if c.rets is not None and len(c.rets)]
    if not series:
        return np.zeros((0, 0), dtype=np.float32)
    T = max(len(s) for s in series)
    keep = [s for s in series if len(s) == T]
    return np.column_stack(keep).astype(np.float32)
