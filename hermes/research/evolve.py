"""Evolutionary alpha search.

Fitness is computed ONLY on in-sample data, and is itself an average across
contiguous sub-windows (a strategy must work in every sub-period, not just on
one lucky stretch). Out-of-sample data is never touched during evolution —
it is reserved for the final validation gate in `validate.py`.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np

from ..backtest import engine, metrics
from ..data.store import BARS_PER_YEAR, Candles
from ..strategy.genome import Genome, crossover, mutate, random_genome
from ..strategy.signals import compute_position


@dataclass
class Candidate:
    genome: Genome
    fitness: float = -1e9
    is_stats: dict = field(default_factory=dict)


def _fitness(candles_is: Candles, g: Genome, fee_bps: float, slip_bps: float,
             n_windows: int = 3) -> tuple[float, dict]:
    pos = compute_position(candles_is, g)
    res = engine.run(candles_is, pos, fee_bps, slip_bps)
    n = len(candles_is)
    if n < n_windows * 100:
        return -1e9, res.stats

    bpy = BARS_PER_YEAR[candles_is.bar]
    edges = np.linspace(0, n, n_windows + 1).astype(int)
    window_sharpes = [
        metrics.sharpe(res.rets[a:b], bpy) for a, b in zip(edges[:-1], edges[1:])
    ]
    mean_sh = float(np.mean(window_sharpes))
    worst_sh = float(np.min(window_sharpes))
    mdd = res.stats["max_drawdown"]

    # trade-activity guard: strategies that barely trade are degenerate
    if res.turnover < 1e-4 or res.stats["sharpe"] == 0.0:
        return -1e9, res.stats

    fitness = mean_sh + 0.5 * worst_sh - 2.0 * mdd - 5.0 * res.turnover
    return float(fitness), res.stats


def evolve(
    candles_is: Candles,
    population: int = 96,
    generations: int = 25,
    fee_bps: float = 5.0,
    slip_bps: float = 2.0,
    seed: int | None = None,
    elite_frac: float = 0.1,
    log=None,
) -> tuple[list[Candidate], int]:
    """Returns (final population sorted by fitness desc, total genomes evaluated)."""
    rng = random.Random(seed)
    seen: dict[str, float] = {}
    evaluated = 0

    def eval_candidate(g: Genome) -> Candidate:
        nonlocal evaluated
        cached = seen.get(g.gid)
        if cached is not None:
            return Candidate(g, cached)
        fit, stats = _fitness(candles_is, g, fee_bps, slip_bps)
        seen[g.gid] = fit
        evaluated += 1
        return Candidate(g, fit, stats)

    pop = [eval_candidate(random_genome(rng)) for _ in range(population)]

    for gen in range(generations):
        pop.sort(key=lambda c: c.fitness, reverse=True)
        n_elite = max(2, int(population * elite_frac))
        next_pop = pop[:n_elite]

        def tournament() -> Candidate:
            k = 3
            return max(rng.sample(pop, k), key=lambda c: c.fitness)

        while len(next_pop) < population:
            if rng.random() < 0.6:
                child = crossover(tournament().genome, tournament().genome, rng)
                child = mutate(child, rng, rate=0.25)
            else:
                child = mutate(tournament().genome, rng, rate=0.5)
            next_pop.append(eval_candidate(child))
        pop = next_pop
        if log:
            best = max(pop, key=lambda c: c.fitness)
            log(f"gen {gen + 1}/{generations}: best_fitness={best.fitness:.3f} "
                f"({best.genome.describe()}) evaluated={evaluated}")

    pop.sort(key=lambda c: c.fitness, reverse=True)
    return pop, evaluated
