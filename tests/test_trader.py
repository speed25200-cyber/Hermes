"""End-to-end trader cycle tests with the paper broker."""

import numpy as np

from hermes.config import Config
from hermes.data.store import BARS_PER_YEAR
from hermes.data.synthetic import generate
from hermes.exchange.broker import PaperBroker
from hermes.live.trader import Registry, Trader
from hermes.portfolio.allocator import Allocator
from hermes.research.validate import ValidatedStrategy
from hermes.risk import RiskEngine
from hermes.strategy.genome import Genome


def make_trader(tmp_path, strategies, cash=10000.0):
    cfg = Config()
    registry = Registry(str(tmp_path))
    registry.strategies = strategies
    broker = PaperBroker(cash=cash, fee_bps=5.0, slippage_bps=2.0)
    allocator = Allocator(bars_per_year=BARS_PER_YEAR["1H"])
    risk = RiskEngine(max_gross_leverage=2.0, max_instrument_leverage=1.0,
                      daily_loss_limit_pct=50.0, max_drawdown_pct=90.0,
                      min_trade_notional=10.0, max_order_notional=100000.0)
    return Trader(cfg, broker, registry, allocator, risk, log=lambda m: None), broker, risk


def trend_strategy(inst):
    g = Genome(signal="ma_cross", params={"fast": 10, "ratio": 5.0},
               vol_target=0.3, max_lev=1.0)
    return ValidatedStrategy(genome=g, inst=inst, bar="1H",
                             is_stats={}, oos_stats={"sharpe": 1.0, "dsr": 0.5})


def test_cycle_opens_and_updates_positions(tmp_path):
    candles = generate(n=3000, seed=9)
    strat = trend_strategy(candles.inst)
    trader, broker, _ = make_trader(tmp_path, [strat])
    # run several cycles over successive bars
    n_orders = 0
    for i in range(2500, 2600):
        window = {candles.inst: candles.slice(0, i + 1)}
        report = trader.run_cycle(window, candles.ts[i] / 1000.0)
        n_orders += len(report.get("orders", []))
        assert report["equity"] > 0
    assert n_orders > 0  # it actually trades
    # exposure never exceeds per-instrument cap (equity fraction)
    eq = broker.equity()
    pos = broker.positions()
    for inst, q in pos.items():
        assert abs(q) * broker.prices[inst] / eq <= 1.0 + 0.05


def test_kill_switch_flattens(tmp_path):
    candles = generate(n=3000, seed=9)
    strat = trend_strategy(candles.inst)
    trader, broker, risk = make_trader(tmp_path, [strat])
    risk.max_drawdown_pct = 0.0001  # trip immediately after any dip
    window = {candles.inst: candles.slice(0, 2500)}
    trader.run_cycle(window, candles.ts[2499] / 1000.0)
    # force an equity dip by marking prices down sharply
    broker.mark_prices({candles.inst: float(candles.c[2499]) * 0.5})
    window2 = {candles.inst: candles.slice(0, 2501)}
    report = trader.run_cycle(window2, candles.ts[2500] / 1000.0)
    if broker.positions():
        # if a position existed, the halt must have flattened it
        assert report["halted"]
        assert broker.positions() == {}


def test_state_persistence_roundtrip(tmp_path):
    candles = generate(n=3000, seed=9)
    strat = trend_strategy(candles.inst)
    trader, broker, _ = make_trader(tmp_path, [strat])
    window = {candles.inst: candles.slice(0, 2500)}
    trader.run_cycle(window, candles.ts[2499] / 1000.0)
    trader.save_state(str(tmp_path))

    trader2, broker2, _ = make_trader(tmp_path, [strat])
    trader2.load_state(str(tmp_path))
    assert broker2.cash == broker.cash
    assert broker2.pos == broker.pos
    assert trader2.last_close == trader.last_close


def test_registry_tracks_empty_streak(tmp_path):
    """The hunt escalates while research keeps coming back empty: the
    registry counts consecutive empty passes (persisted) and resets on the
    first deploy."""
    reg = Registry(str(tmp_path))
    reg.record_outcome([])
    reg.record_outcome([])
    reg.save()
    reg2 = Registry(str(tmp_path))
    assert reg2.consecutive_empty == 2
    reg2.record_outcome([trend_strategy("BTC-USDT-SWAP")])
    assert reg2.consecutive_empty == 0


def test_empty_book_uses_fast_research_cadence(tmp_path):
    """With no deployed strategies, research goes stale after
    refresh_hours_empty (daily), not the weekly refresh_hours."""
    import time as _t
    from unittest import mock

    from hermes.live.trader import LiveRunner

    def make_runner(strategies):
        lr = LiveRunner.__new__(LiveRunner)   # no network / broker needed
        lr.cfg = Config()
        lr.registry = Registry(str(tmp_path))
        lr.registry.strategies = strategies
        lr.registry.researched_at = _t.time() - 30 * 3600   # 30h ago
        lr.log = lambda m: None
        lr._load_candles = lambda: {}
        return lr

    with mock.patch("hermes.live.trader.run_research",
                    return_value=([], 0)) as rr:
        make_runner([]).ensure_research()
    assert rr.called, "empty book after 30h must re-run research"

    # a non-empty book at the same age must NOT re-run (weekly cadence)
    with mock.patch("hermes.live.trader.run_research",
                    return_value=([], 0)) as rr2:
        make_runner([trend_strategy("BTC-USDT-SWAP")]).ensure_research()
    assert not rr2.called, "deployed book at 30h is fresh on weekly cadence"


def test_dead_strategy_is_retired(tmp_path):
    """A deployed strategy whose live shadow returns show a clearly negative
    risk-adjusted edge over enough bars is removed autonomously; a healthy
    one stays."""
    from hermes.portfolio.allocator import StrategyTrack

    dead = trend_strategy("BTC-USDT-SWAP")
    alive = trend_strategy("ETH-USDT-SWAP")
    trader, _, _ = make_trader(tmp_path, [dead, alive])
    sid_dead = trader.registry.sid(dead)
    sid_alive = trader.registry.sid(alive)
    # losing consistently: mean -2bps/bar, sd ~10bps -> deeply negative sharpe
    trader.allocator.tracks[sid_dead] = StrategyTrack(
        ewma_ret=-2e-4, ewma_var=(1e-3) ** 2, n_obs=2000)
    trader.allocator.tracks[sid_alive] = StrategyTrack(
        ewma_ret=+2e-4, ewma_var=(1e-3) ** 2, n_obs=2000)
    trader._retire_dead_strategies()
    sids = [trader.registry.sid(s) for s in trader.registry.strategies]
    assert sid_dead not in sids and sid_alive in sids
    # too few observations must never retire
    trader.registry.strategies = [dead]
    trader.allocator.tracks[sid_dead].n_obs = 10
    trader._retire_dead_strategies()
    assert len(trader.registry.strategies) == 1


def test_rebalance_band_absorbs_small_target_drift(tmp_path):
    """Small per-cycle target wiggles must NOT trade (whipsaw churn); big
    moves, flips and full closes must."""
    inst = "BTC-USDT-SWAP"
    trader, broker, _ = make_trader(tmp_path, [])
    broker.mark_prices({inst: 100.0})

    trader._reconcile({inst: 0.30}, {inst: 100.0}, broker.equity())
    q0 = broker.positions()[inst]
    assert q0 > 0                                     # opened (>= 2% floor)

    # +-2% absolute / <20% relative drift: held, no order
    trader._reconcile({inst: 0.32}, {inst: 100.0}, broker.equity())
    assert broker.positions()[inst] == q0
    trader._reconcile({inst: 0.27}, {inst: 100.0}, broker.equity())
    assert broker.positions()[inst] == q0

    # a real move (0.30 -> 0.15) passes the band
    trader._reconcile({inst: 0.15}, {inst: 100.0}, broker.equity())
    q1 = broker.positions()[inst]
    assert 0 < q1 < q0

    # dust target from flat: rejected by the floor
    trader._reconcile({"ETH-USDT-SWAP": 0.01}, {"ETH-USDT-SWAP": 100.0},
                      broker.equity())
    assert "ETH-USDT-SWAP" not in broker.positions()

    # explicit flat always executes
    trader._reconcile({inst: 0.0}, {inst: 100.0}, broker.equity())
    assert inst not in broker.positions()


def test_governor_scales_book_targets(tmp_path):
    """A de-risked governor must shrink every target the cycle produces."""
    from hermes.risk import LeverageGovernor

    inst = "BTC-USDT-SWAP"
    c = generate(inst=inst, bar="1H", n=1200, seed=5)

    t_full, _, _ = make_trader(tmp_path / "a", [trend_strategy(inst)])
    t_half, _, _ = make_trader(tmp_path / "b", [trend_strategy(inst)])

    class Halved(LeverageGovernor):
        def update(self, equity, peak):  # forced 0.5x, deterministic
            self.last_mult = 0.5
            return 0.5

    t_full.governor = None
    t_half.governor = Halved()

    r_full = t_full.run_cycle({inst: c}, now_ts=1_700_000_000)
    r_half = t_half.run_cycle({inst: c}, now_ts=1_700_000_000)
    tgt_full = r_full["targets"].get(inst, 0.0)
    tgt_half = r_half["targets"].get(inst, 0.0)
    assert abs(tgt_full) > 0.01, "test needs a live signal"
    assert abs(tgt_half - 0.5 * tgt_full) < 1e-9


def test_calibration_report_contrasts_promised_and_realised(tmp_path, capsys):
    """The gate's OOS estimate is only trustworthy if live performance tracks
    it; the report must surface the shortfall rather than hide it."""
    import json as _json
    import os as _os
    import types

    from hermes.cli import cmd_calibration
    from hermes.config import Config
    from hermes.strategy.genome import Genome

    g = Genome(signal="tsmom", params={"lookback": 24, "deadband": 0.5},
               vol_target=0.2, max_lev=1.0)
    state = str(tmp_path)
    with open(_os.path.join(state, "registry.json"), "w") as f:
        _json.dump({"strategies": [{
            "genome": g.to_dict(), "inst": "BTC-USDT-SWAP", "bar": "1H",
            "is_stats": {}, "oos_stats": {"sharpe": 6.0, "dsr": 0.2},
        }]}, f)
    # live returns are flat: a deployed strategy earning nothing
    with open(_os.path.join(state, "trader.json"), "w") as f:
        _json.dump({"allocator": {"tracks": {
            f"BTC-USDT-SWAP:{g.gid}": {
                "ewma_ret": 0.0, "ewma_var": 1e-6, "n_obs": 500},
        }}}, f)

    cfg = Config.load(None)
    cfg.raw["state_dir"] = state
    cfg.raw["bar"] = "1H"
    original = Config.load
    try:
        Config.load = staticmethod(lambda *_a, **_k: cfg)
        cmd_calibration(types.SimpleNamespace(config=None))
    finally:
        Config.load = original

    out = capsys.readouterr().out
    assert "6.00" in out                      # the promise is shown
    assert "shortfall" in out                 # and so is the gap


def test_cross_sectional_book_moves_as_one_unit(tmp_path):
    """A dollar-neutral book must not be half-executed. When one leg breaches
    the dead band, the legs that sit inside it have to trade too — otherwise
    the large legs move alone and the book stops being neutral."""
    a, b = "BTC-USDT-SWAP", "ETH-USDT-SWAP"
    px = {a: 100.0, b: 100.0}

    def run(books):
        trader, broker, _ = make_trader(tmp_path, [])
        broker.mark_prices(px)
        trader._reconcile({a: 0.30, b: -0.30}, px, broker.equity(), books)
        before = dict(broker.positions())
        # leg a moves a lot (0.30 -> 0.10), leg b barely (-0.30 -> -0.28)
        trader._reconcile({a: 0.10, b: -0.28}, px, broker.equity(), books)
        return before, dict(broker.positions())

    before, after = run([{a, b}])
    assert after[a] != before[a]           # the breaching leg trades
    assert after[b] != before[b]           # and so does its partner

    # ungrouped, the small leg is left behind — the defect this guards against
    before, after = run(None)
    assert after[a] != before[a]
    assert after[b] == before[b]


def test_risk_off_cut_is_not_swallowed_by_the_band(tmp_path):
    """A leverage-governor cut is a risk instruction, not signal drift: it
    must reach the exchange even when it is under the relative band."""
    inst = "BTC-USDT-SWAP"
    px = {inst: 100.0}
    trader, broker, _ = make_trader(tmp_path, [])
    broker.mark_prices(px)
    trader._reconcile({inst: 0.30}, px, broker.equity())
    held = broker.positions()[inst]

    # 0.30 -> 0.249 is a 17% cut: inside the 20% relative band
    trader._reconcile({inst: 0.249}, px, broker.equity())
    assert broker.positions()[inst] == held          # drift: correctly held

    trader._reconcile({inst: 0.249}, px, broker.equity(), derisk=True)
    assert broker.positions()[inst] < held           # risk-off: executed
