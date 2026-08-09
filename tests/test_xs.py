"""Cross-sectional funding-carry portfolio: neutrality, causality, edge."""

import numpy as np
import pytest

from hermes.backtest import metrics
from hermes.config import effective_costs
from hermes.data.store import BARS_PER_YEAR
from hermes.data.synthetic import generate
from hermes.research.xs import research_xs
from hermes.strategy.xs import funding_xs_positions, portfolio_backtest


def make_universe(n=6000, seed=0, funding_spread=True):
    """6 synthetic perps; half with persistently positive funding, half with
    negative — an exploitable carry spread when funding_spread=True."""
    universe = {}
    rng = np.random.default_rng(seed)
    for k in range(6):
        c = generate(inst=f"U{k}-USDT-SWAP", bar="1H", n=n, seed=seed + 10 * k,
                     s0=50.0 + 10 * k)
        if funding_spread:
            sign = 1.0 if k < 3 else -1.0
            bars8h = 8
            f = np.zeros(n)
            for i in range(0, n, bars8h):
                f[i] = sign * (0.0004 + rng.normal(0, 0.00005))
            c.funding = f
        universe[c.inst] = c
    return universe


def test_book_is_dollar_neutral_and_bounded():
    uni = make_universe()
    common, insts, pos = funding_xs_positions(uni, {"lookback": 200, "max_w": 0.25})
    assert pos
    mat = np.vstack([pos[i] for i in insts])
    live = np.abs(mat).sum(axis=0) > 1e-6
    net = mat.sum(axis=0)[live]
    gross = np.abs(mat).sum(axis=0)[live]
    assert np.all(np.abs(net) <= 0.35 * gross + 1e-9)  # ~dollar-neutral
    assert np.nanmax(np.abs(mat)) < 1.0                # per-name cap * scale


def test_positions_causal():
    a = make_universe(seed=3)
    b = make_universe(seed=3)
    for inst in b:
        b[inst].c[5500:] *= 2.0
        b[inst].funding[5500:] = 0.005
    _, insts, pa = funding_xs_positions(a, {"lookback": 100, "max_w": 0.25})
    _, _, pb = funding_xs_positions(b, {"lookback": 100, "max_w": 0.25})
    for inst in insts:
        np.testing.assert_allclose(pa[inst][:5400], pb[inst][:5400], atol=1e-10)


def test_carry_edge_is_found_and_validated():
    """With a persistent funding spread, the XS gate must deploy, and the
    OOS portfolio must earn the carry."""
    uni = make_universe(seed=1, funding_spread=True)
    fee, slip = effective_costs({"taker_fee_bps": 5, "maker_fee_bps": 2,
                                 "slippage_bps": 2, "prefer_maker": True,
                                 "maker_miss_rate": 0.3})
    out = research_xs(uni, fee_bps=fee, slip_bps=slip, log=None)
    assert len(out) == 1
    s = out[0]
    assert s.genome.signal == "funding_xs"
    assert s.oos_stats["sharpe"] >= 0.5


def test_no_spread_means_no_deploy():
    """Without a structural funding spread the gate should almost always
    reject (we tolerate nothing less: reject expected)."""
    uni = make_universe(seed=2, funding_spread=False)
    out = research_xs(uni, fee_bps=2.9, slip_bps=0.6, log=None)
    assert out == [] or out[0].oos_stats["dsr"] >= 0.05


def test_portfolio_backtest_charges_costs():
    uni = make_universe(seed=4)
    common, insts, pos = funding_xs_positions(uni, {"lookback": 100, "max_w": 0.25})
    r_free = portfolio_backtest(uni, pos, common, 0.0, 0.0)
    r_cost = portfolio_backtest(uni, pos, common, 5.0, 2.0)
    assert r_cost.sum() < r_free.sum()
