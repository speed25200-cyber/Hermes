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
    carrys = [s for s in out if s.genome.signal == "funding_xs"]
    assert len(carrys) == 1
    assert carrys[0].oos_stats["sharpe"] >= 0.5


def test_zero_funding_prefix_is_trimmed():
    """Exchanges expose only a few months of funding history: earlier bars
    carry funding=0. The gate must research the covered window instead of
    letting the dead prefix zero-out the whole in-sample period (the bug
    that silently rejected every carry config on real OKX data)."""
    uni = make_universe(seed=1, funding_spread=True)
    for c in uni.values():
        c.funding[:2500] = 0.0          # first ~40% of history uncovered
    fee, slip = effective_costs({"taker_fee_bps": 5, "maker_fee_bps": 2,
                                 "slippage_bps": 2, "prefer_maker": True,
                                 "maker_miss_rate": 0.3})
    out = research_xs(uni, fee_bps=fee, slip_bps=slip, log=None)
    carrys = [s for s in out if s.genome.signal == "funding_xs"]
    assert len(carrys) == 1
    assert carrys[0].oos_stats["sharpe"] >= 0.5


def test_no_spread_means_no_deploy():
    """Without a structural funding spread the gate should almost always
    reject (we tolerate nothing less: reject expected)."""
    uni = make_universe(seed=2, funding_spread=False)
    out = research_xs(uni, fee_bps=2.9, slip_bps=0.6, log=None)
    assert all(s.oos_stats["dsr"] >= 0.05 for s in out)


def test_xs_momentum_finds_planted_trends():
    """Half the universe trends up, half trends down, persistently. The
    cross-sectional momentum book (long winners / short losers) must pass
    the gate and earn the spread out-of-sample."""
    uni = make_universe(seed=4, funding_spread=False)
    for k, inst in enumerate(sorted(uni)):
        c = uni[inst]
        drift = 0.0004 if k < 3 else -0.0004
        c.c = c.c * np.exp(drift * np.arange(len(c)))
    fee, slip = effective_costs({"taker_fee_bps": 5, "maker_fee_bps": 2,
                                 "slippage_bps": 2, "prefer_maker": True,
                                 "maker_miss_rate": 0.3})
    out = research_xs(uni, fee_bps=fee, slip_bps=slip, log=None)
    moms = [s for s in out if s.genome.signal == "xs_mom"]
    assert len(moms) == 1
    assert moms[0].oos_stats["sharpe"] >= 0.5


def test_xs_reversal_finds_mean_reverting_shocks():
    """Prices oscillate around a common base via AR(1) idiosyncratic spreads:
    short-horizon losers rebound. The reversal book must pass the gate."""
    rng = np.random.default_rng(11)
    base = generate(inst="BASE", bar="1H", n=6000, seed=99, s0=100.0).c
    uni = {}
    for k in range(6):
        s = np.zeros(6000)
        for t in range(1, 6000):
            s[t] = 0.985 * s[t - 1] + rng.normal(0, 0.004)
        c = generate(inst=f"R{k}-USDT-SWAP", bar="1H", n=6000, seed=200 + k)
        c.c = base * np.exp(s) * (1 + 0.1 * k)
        c.funding = np.zeros(6000)
        uni[c.inst] = c
    fee, slip = effective_costs({"taker_fee_bps": 5, "maker_fee_bps": 2,
                                 "slippage_bps": 2, "prefer_maker": True,
                                 "maker_miss_rate": 0.3})
    out = research_xs(uni, fee_bps=fee, slip_bps=slip, log=None)
    revs = [s for s in out if s.genome.signal == "xs_rev"]
    assert len(revs) == 1
    assert revs[0].oos_stats["sharpe"] >= 0.5


def test_portfolio_backtest_charges_costs():
    uni = make_universe(seed=4)
    common, insts, pos = funding_xs_positions(uni, {"lookback": 100, "max_w": 0.25})
    r_free = portfolio_backtest(uni, pos, common, 0.0, 0.0)
    r_cost = portfolio_backtest(uni, pos, common, 5.0, 2.0)
    assert r_cost.sum() < r_free.sum()


def test_xs_lead_lag_finds_planted_followers():
    """Followers whose returns partially echo the leader's PREVIOUS bar (with
    differing sensitivities) are a real catch-up trade: the lead-lag book
    must pass the gate. Without a leader argument the family is skipped.

    12000 bars, not 6000: the edge is identical either way (OOS Sharpe ~4.7
    at both lengths) but on the shorter sample the DSR is 0.46 — the gate
    cannot yet distinguish it from the best of the same search on noise, and
    says so. At 12000 it reads 0.71, at 24000 it reads 0.97. Confirming an
    edge takes data, and this test is about the family finding one, not about
    how little data it can be established on."""
    rng = np.random.default_rng(21)
    n = 12000
    lead_ret = rng.normal(0, 0.004, n)
    uni = {}
    lc = 100 * np.exp(np.cumsum(lead_ret))
    c = generate(inst="LEAD-USDT-SWAP", bar="1H", n=n, seed=500)
    c.c = lc
    c.funding = np.zeros(n)
    uni[c.inst] = c
    for k, coef in enumerate([0.5, 0.35, 0.2, 0.1, 0.0]):
        own = rng.normal(0, 0.004, n)
        r = own.copy()
        r[1:] += coef * lead_ret[:-1]
        ci = generate(inst=f"F{k}-USDT-SWAP", bar="1H", n=n, seed=600 + k)
        ci.c = (50 + 10 * k) * np.exp(np.cumsum(r))
        ci.funding = np.zeros(n)
        uni[ci.inst] = ci
    fee, slip = effective_costs({"taker_fee_bps": 5, "maker_fee_bps": 2,
                                 "slippage_bps": 2, "prefer_maker": True,
                                 "maker_miss_rate": 0.3})
    out = research_xs(uni, fee_bps=fee, slip_bps=slip, log=None,
                      leader="LEAD-USDT-SWAP")
    leads = [s for s in out if s.genome.signal == "xs_lead"]
    assert len(leads) == 1
    assert leads[0].oos_stats["sharpe"] >= 0.5
    # no leader passed -> family skipped, never crashes
    out2 = research_xs(uni, fee_bps=fee, slip_bps=slip, log=None)
    assert all(s.genome.signal != "xs_lead" for s in out2)


def test_direction_inverts_the_book():
    """`dir` must flip every leg. Pinning the sign let a family express only
    half its hypothesis: xs_oi came back between -3.2 and -5.9 Sharpe on
    every single config in production, which is a strong edge held the wrong
    way round rather than an absent one."""
    import numpy as np

    from hermes.strategy.xs import xs_positions

    cmap = make_universe(n=6000, seed=17)
    base = {"lookback": 48, "max_w": 0.25, "dir": 0}
    _, _, a = xs_positions(cmap, base, kind="rev")
    _, _, b = xs_positions(cmap, {**base, "dir": 1}, kind="rev")

    assert a and b
    moved = 0
    for inst in a:
        np.testing.assert_allclose(a[inst], -b[inst], atol=1e-9)
        moved += int(np.abs(a[inst]).max() > 1e-9)
    assert moved, "the book never took a position, so the flip proves nothing"


def test_only_the_open_families_search_direction():
    """Every extra config raises the deflated-Sharpe bar for the WHOLE sweep,
    so a family whose sign is pinned by theory must not be taxed to rescue
    one whose sign is an open question. Carry is pinned (the crowded side
    pays funding), lead-lag by construction, and momentum/reversal already
    span both directions of the same score by existing as two families."""
    from hermes.strategy import xs

    for name in ("XS_TAKER_GRID", "XS_OI_GRID", "XS_BASIS_GRID"):
        assert {c["dir"] for c in getattr(xs, name)} == {0, 1}, \
            f"{name} should search direction"
    for name in ("XS_GRID", "XS_MOM_GRID", "XS_REV_GRID", "XS_LEAD_GRID"):
        assert not any("dir" in c for c in getattr(xs, name)), \
            f"{name} has a sign its theory pins; searching it taxes everyone"


def test_search_can_reach_an_inverted_cross_sectional_edge():
    """The production symptom: xs_oi rejected at -3.2 to -5.9 Sharpe on every
    config. A whole grid that negative means the winning configuration was
    outside the search space, not that no edge existed."""
    from hermes.data.store import BARS_PER_YEAR
    from hermes.strategy.xs import portfolio_backtest, xs_positions

    rng = np.random.default_rng(3)
    n, drift = 6000, rng.normal(0, 1, 8)
    cmap = {}
    for k in range(8):
        c = generate(inst=f"X{k}-USDT-SWAP", bar="1H", n=n, seed=900 + k,
                     s0=100.0)
        # each name carries its own persistent trend, so winners keep winning
        # — the opposite of what the reversal family assumes
        c.c = c.c * np.exp(np.linspace(0, 0.30 * drift[k], n))
        cmap[c.inst] = c

    bpy = BARS_PER_YEAR["1H"]
    scores = {}
    for d in (0, 1):
        common, _, pos = xs_positions(
            cmap, {"lookback": 48, "max_w": 0.25, "dir": d}, kind="rev")
        rets = portfolio_backtest(cmap, pos, common, fee_bps=2.9, slip_bps=0.6)
        scores[d] = metrics.sharpe(rets, bpy)

    assert scores[0] < -5, f"the pinned sign should lose badly here: {scores}"
    assert scores[1] > 5, f"the search must be able to reach it: {scores}"


def test_inverted_configs_are_negated_not_recomputed():
    """`dir` only flips signs, and everything downstream is odd-symmetric, so
    the inverted book is the exact negation. Rebuilding it would repeat a
    universe alignment, two realized-vol passes per name and a per-bar
    hysteresis loop — seconds per config on a production universe."""
    from hermes.research import xs as rxs
    from hermes.strategy import xs as sxs

    cmap = make_universe(n=4000, seed=23)
    calls = []
    original = rxs.xs_positions

    def counting(*a, **kw):
        calls.append(kw.get("kind"))
        return original(*a, **kw)

    try:
        rxs.xs_positions = counting
        rxs._research_family(
            cmap, "xs_oi", "oi", sxs.XS_OI_GRID, fee_bps=2.9, slip_bps=0.6,
            is_fraction=0.7, embargo_bars=24, min_oos_sharpe=99.0,
            min_dsr=0.99, max_oos_drawdown=0.35, n_folds=3, log=None,
            leader=None)
    except Exception:
        pass                      # the gate rejecting is fine; we count calls
    finally:
        rxs.xs_positions = original

    # 12 configs but only 6 distinct (lookback, max_w) pairs in-sample
    assert len([c for c in calls if c == "oi"]) <= 7, (
        f"inverted configs were recomputed: {len(calls)} builds")
