import random

import numpy as np

from hermes.data.synthetic import generate
from hermes.strategy.genome import (Genome, SIGNAL_SPECS, crossover, mutate,
                                    random_genome)
from hermes.strategy.signals import compute_position


def test_all_signal_families_produce_bounded_causal_positions():
    candles = generate(n=3000, seed=3)
    rng = random.Random(0)
    for name in SIGNAL_SPECS:
        for _ in range(5):
            g = random_genome(rng)
            while g.signal != name:
                g = random_genome(rng)
            pos = compute_position(candles, g)
            assert len(pos) == len(candles)
            assert np.all(np.isfinite(pos))
            assert np.max(np.abs(pos)) <= g.max_lev + 1e-9


def test_positions_are_causal():
    """Changing the future must not change past positions."""
    candles = generate(n=3000, seed=4)
    tampered = generate(n=3000, seed=4)
    tampered.c[2500:] *= 2.0
    tampered.h[2500:] *= 2.0
    tampered.l[2500:] *= 2.0
    rng = random.Random(1)
    for _ in range(20):
        g = random_genome(rng)
        a = compute_position(candles, g)
        b = compute_position(tampered, g)
        np.testing.assert_allclose(a[:2400], b[:2400], atol=1e-12)


def test_genome_roundtrip_and_ops():
    rng = random.Random(2)
    g = random_genome(rng)
    g2 = Genome.from_dict(g.to_dict())
    assert g.gid == g2.gid
    m = mutate(g, rng)
    assert m.signal in SIGNAL_SPECS
    c = crossover(g, random_genome(rng), rng)
    assert c.signal in SIGNAL_SPECS
    # params remain within spec bounds after many mutations
    for _ in range(200):
        g = mutate(g, rng)
        for k, (lo, hi, _, _) in SIGNAL_SPECS[g.signal].items():
            assert lo <= g.params[k] <= hi
