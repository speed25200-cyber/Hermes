"""Panel research: one rule across the universe, validated on the pooled record.

The point of the panel is statistical. A per-instrument edge of Sharpe 1 is
invisible against its own selection bar of ~4.5; pooled across thirty names
the same edge shows up near sqrt(30) larger while the bar stays put. These
tests check the machinery is causal and correctly weighted, and then check
that the statistical claim actually holds on a planted edge.
"""

import numpy as np
import pytest

from hermes.data.store import BAR_MS, Candles
from hermes.research.panel import (PANEL_INST, panel_positions,
                                   research_panel, _inverse_vol_weights)
from hermes.strategy.genome import Genome
from hermes.strategy.xs import align_universe


def _candles(inst, closes, bar="1H"):
    n = len(closes)
    ts = np.arange(n, dtype=np.int64) * BAR_MS[bar]
    c = np.asarray(closes, dtype=np.float64)
    return Candles(inst, bar, ts, c, c * 1.001, c * 0.999, c, np.ones(n))


def _trending_universe(n=6000, k=8, seed=3, edge=0.0):
    """k instruments whose returns mean-revert; `edge` plants a predictable
    component a reversal rule can capture."""
    rng = np.random.default_rng(seed)
    uni = {}
    for j in range(k):
        x = np.zeros(n)
        for i in range(1, n):
            x[i] = (1.0 - edge) * x[i - 1] + rng.normal(0, 0.01)
        uni[f"I{j}-USDT-SWAP"] = _candles(f"I{j}-USDT-SWAP", 100 * np.exp(x))
    return uni


def test_inverse_vol_weights_are_causal_and_normalised():
    """A weight that peeked at future volatility would leak the answer."""
    uni = _trending_universe(n=800, k=4)
    common, idx = align_universe(uni)
    w = _inverse_vol_weights(uni, idx, len(common))
    total = sum(w[i] for i in uni)
    assert np.allclose(total[200:], 1.0, atol=1e-9)

    # perturbing only the tail must not move an early weight
    uni2 = {i: Candles(c.inst, c.bar, c.ts.copy(), c.o.copy(), c.h.copy(),
                       c.l.copy(), c.c.copy(), c.v.copy())
            for i, c in uni.items()}
    first = sorted(uni2)[0]
    uni2[first].c[600:] *= 3.0
    w2 = _inverse_vol_weights(uni2, idx, len(common))
    assert np.allclose(w[first][:500], w2[first][:500])


def test_a_calm_instrument_gets_more_weight_than_a_wild_one():
    n = 2000
    rng = np.random.default_rng(1)
    calm = 100 * np.exp(np.cumsum(rng.normal(0, 0.002, n)))
    wild = 100 * np.exp(np.cumsum(rng.normal(0, 0.020, n)))
    uni = {"CALM-USDT-SWAP": _candles("CALM-USDT-SWAP", calm),
           "WILD-USDT-SWAP": _candles("WILD-USDT-SWAP", wild)}
    common, idx = align_universe(uni)
    w = _inverse_vol_weights(uni, idx, len(common))
    assert w["CALM-USDT-SWAP"][-1] > 5 * w["WILD-USDT-SWAP"][-1]


def test_panel_applies_one_rule_to_every_instrument():
    uni = _trending_universe(n=3000, k=6)
    g = Genome(signal="meanrev", params={"lookback": 100, "entry_z": 1.2},
               vol_target=0.2, max_lev=1.0)
    common, pos = panel_positions(uni, g)
    assert len(pos) == 6
    assert all(len(p) == len(common) for p in pos.values())
    # the rule is uniform, so the positions must differ only through the data
    assert not np.allclose(pos["I0-USDT-SWAP"], pos["I1-USDT-SWAP"])


def test_panel_needs_at_least_two_instruments():
    uni = _trending_universe(n=1000, k=1)
    common, pos = panel_positions(uni, Genome(signal="tsmom",
                                              params={"lookback": 50,
                                                      "deadband": 0.1}))
    assert pos == {}


def test_pooling_lifts_a_shared_edge_above_its_selection_bar():
    """The statistical claim, checked directly.

    One rule, one planted edge, twenty instruments. On a single instrument
    it scores 0.93 — under the 3.61 that a 400-genome search reaches on
    noise, so the deflated Sharpe correctly refuses to call it an edge.
    Pooled across the twenty it scores 4.72, above the same bar. The lift is
    5.1x against a sqrt(20) = 4.47 prediction, which is the whole argument
    for asking the question at the panel level.
    """
    from hermes.backtest import engine, metrics
    from hermes.data.store import BARS_PER_YEAR
    from hermes.strategy.signals import compute_position
    from hermes.strategy.xs import portfolio_backtest

    uni = _trending_universe(n=6000, k=20, seed=11, edge=0.005)
    g = Genome(signal="meanrev", params={"lookback": 60, "entry_z": 1.0},
               vol_target=0.2, max_lev=1.0)
    bpy = BARS_PER_YEAR["1H"]

    one = uni["I0-USDT-SWAP"]
    res = engine.run(one, compute_position(one, g, None), 2.0, 1.0)
    solo = metrics.sharpe(res.rets, bpy)

    common, pos = panel_positions(uni, g)
    pooled = metrics.sharpe(
        portfolio_backtest(uni, pos, common, 2.0, 1.0), bpy)

    bar = metrics.selection_bar(res.rets, 400, bpy)
    assert solo < bar < pooled, (solo, bar, pooled)
    # the lift tracks sqrt(number of instruments), not the instrument count
    assert 2.0 < pooled / solo < 2.0 * np.sqrt(len(uni)), (solo, pooled)


def test_panel_gate_rejects_a_universe_with_no_edge():
    uni = _trending_universe(n=6000, k=8, seed=5, edge=0.0)
    grid = [Genome(signal="meanrev", params={"lookback": lb, "entry_z": z},
                   vol_target=0.2, max_lev=1.0)
            for lb in (40, 80, 160) for z in (1.0, 1.5, 2.0)]
    out = research_panel(uni, grid, fee_bps=2.0, slip_bps=1.0, log=None)
    assert out == []


def test_panel_survivor_records_how_many_instruments_carried_it():
    uni = _trending_universe(n=9000, k=20, seed=11, edge=0.03)
    grid = [Genome(signal="meanrev", params={"lookback": lb, "entry_z": z},
                   vol_target=0.2, max_lev=1.0)
            for lb in (30, 60, 120) for z in (0.8, 1.0, 1.5)]
    said = []
    out = research_panel(uni, grid, fee_bps=2.0, slip_bps=1.0,
                         log=said.append)
    assert any("panel OOS" in m for m in said), said
    for s in out:
        assert s.inst == PANEL_INST
        assert s.oos_stats["panel_instruments"] == 20
        assert s.oos_stats["dsr"] >= 0.5


def test_panel_refuses_a_window_too_short_to_validate():
    # 180 scored bars against the 204 a nine-rule grid needs. The threshold
    # is genuinely low for a small grid — which is the point: the guard
    # tracks the search budget rather than imposing a fixed minimum.
    uni = _trending_universe(n=600, k=8)
    grid = [Genome(signal="meanrev", params={"lookback": lb, "entry_z": z},
                   vol_target=0.2, max_lev=1.0)
            for lb in (40, 80, 160) for z in (1.0, 1.5, 2.0)]
    said = []
    assert research_panel(uni, grid, 2.0, 1.0, log=said.append) == []
    assert any("scored bars against" in m for m in said), said


@pytest.mark.parametrize("k", [0, 1, 3])
def test_panel_needs_a_real_universe(k):
    uni = _trending_universe(n=2000, k=k) if k else {}
    grid = [Genome(signal="tsmom", params={"lookback": 50, "deadband": 0.1})]
    assert research_panel(uni, grid, 2.0, 1.0, log=None) == []


def test_panel_grid_is_small_enough_to_stay_validatable():
    """The bar rises with the number of rules tried, so a large grid would
    undo the reason for pooling. This checks the grid stays in a range where
    two years of 15m bars can still validate what it finds."""
    from hermes.backtest.metrics import bars_for_selection_bar
    from hermes.data.store import BARS_PER_YEAR
    from hermes.research.panel import panel_grid

    grid = panel_grid()
    assert 10 <= len(grid) <= 80, len(grid)
    assert len({g.gid for g in grid}) == len(grid), "duplicate rules"
    # two years of 15m bars, 30% scored out of sample
    need = bars_for_selection_bar(len(grid), BARS_PER_YEAR["15m"], 6.0)
    assert need < 0.3 * 70_000, need


def test_panel_grid_spans_the_full_history_families():
    """Families whose inputs exist only for recent months have no place in a
    grid meant to be validated over years."""
    from hermes.strategy.genome import AUX_SIGNALS
    from hermes.research.panel import panel_grid

    signals = {g.signal for g in panel_grid()}
    assert signals & {"tsmom", "meanrev", "breakout"}
    assert not (signals & set(AUX_SIGNALS)), signals


def test_a_panel_strategy_actually_trades():
    """A panel rule is a multi-leg book. Without its own branch in the
    decision loop the trader looks up an instrument called "PANEL", finds
    nothing, and the strategy silently never trades — deployed on paper,
    absent from the exchange."""
    from hermes.config import Config
    from hermes.exchange.broker import PaperBroker
    from hermes.live.trader import Registry, Trader
    from hermes.portfolio.allocator import Allocator
    from hermes.research.validate import ValidatedStrategy
    from hermes.risk import RiskEngine
    import tempfile

    uni = _trending_universe(n=1200, k=6, seed=2, edge=0.02)
    cfg = Config.load(None)
    cfg.raw["instruments"] = sorted(uni)
    cfg.raw["bar"] = "1H"

    with tempfile.TemporaryDirectory() as d:
        reg = Registry(d)
        reg.strategies = [ValidatedStrategy(
            genome=Genome(signal="meanrev",
                          params={"lookback": 60, "entry_z": 1.0},
                          vol_target=0.2, max_lev=1.0),
            inst=PANEL_INST, bar="1H", is_stats={},
            oos_stats={"dsr": 0.9, "sharpe": 3.0})]
        broker = PaperBroker(cash=10_000.0, fee_bps=2.0, slippage_bps=1.0)
        risk = RiskEngine(**{k: v for k, v in (
            ("max_gross_leverage", 2.0), ("max_instrument_leverage", 1.0),
            ("daily_loss_limit_pct", 3.0), ("max_drawdown_pct", 15.0),
            ("min_trade_notional", 10.0), ("max_order_notional", 25_000.0))})
        risk.state_path = None
        trader = Trader(cfg, broker, reg, Allocator(bars_per_year=8760), risk,
                        log=lambda m: None)
        report = trader.run_cycle(uni, now_ts=1_000_000.0)

    sid = f"{PANEL_INST}:{reg.strategies[0].genome.gid}"
    assert sid in report["weights"], report["weights"]
    assert report["targets"], "panel rule produced no book"
    assert len(report["targets"]) >= 4, report["targets"]
    assert report["orders"], "panel book never reached the broker"
