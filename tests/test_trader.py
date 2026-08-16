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


def test_book_is_capped_across_the_whole_universe():
    """Per-instrument caps do not bound a book: capital is shared over
    everything deployed, so 60 strategies starve each other below the
    rebalance band and nothing reaches the market. The cap binds globally and
    keeps the strongest."""
    from hermes.live.trader import cap_book

    made = []
    for i in range(12):
        g = Genome(signal="tsmom", params={"lookback": 24 + i, "deadband": 0.5},
                   vol_target=0.2, max_lev=1.0)
        made.append(ValidatedStrategy(genome=g, inst=f"I{i}-USDT-SWAP",
                                      bar="15m", is_stats={},
                                      oos_stats={"sharpe": float(i), "dsr": 0.2}))

    kept = cap_book(made, 3)
    assert [s.oos_stats["sharpe"] for s in kept] == [11.0, 10.0, 9.0]
    assert cap_book(made, 0) is made          # 0 disables the cap
    assert cap_book(made, 50) is made         # under the cap, untouched


def test_cap_spreads_the_book_across_instruments():
    """Taking the global top N would hand every slot to whichever instrument
    drew the luckiest estimates. Breadth is the reason for widening the
    universe, so the cap fills instrument by instrument."""
    from hermes.live.trader import cap_book

    made = []
    for inst, sharpes in (("LUCKY-USDT-SWAP", [9.0, 8.9, 8.8, 8.7]),
                          ("B-USDT-SWAP", [3.0, 2.5]),
                          ("C-USDT-SWAP", [2.8, 2.4]),
                          ("D-USDT-SWAP", [2.6, 2.2])):
        for sh in sharpes:
            g = Genome(signal="tsmom", params={"lookback": int(sh * 10),
                                               "deadband": 0.5},
                       vol_target=0.2, max_lev=1.0)
            made.append(ValidatedStrategy(genome=g, inst=inst, bar="15m",
                                          is_stats={},
                                          oos_stats={"sharpe": sh, "dsr": 0.2}))

    kept = cap_book(made, 4)
    assert len({s.inst for s in kept}) == 4       # one slot per instrument
    # the lucky instrument still leads, it just does not take every seat
    assert kept[0].inst == "LUCKY-USDT-SWAP"
    assert sum(1 for s in kept if s.inst == "LUCKY-USDT-SWAP") == 1


def test_registry_drops_a_book_todays_gates_would_reject():
    """Raising a gate has to apply to the capital already deployed against
    the old one. The live book was eighteen strategies with DSRs from 0.050
    to 0.175, written when the floor was 0.05; without this they are traded
    verbatim after the floor moves, because nothing re-examines what research
    left on disk."""
    import tempfile

    from hermes.live.trader import Registry
    from hermes.research.validate import ValidatedStrategy
    from hermes.strategy.genome import Genome

    def strat(dsr, sharpe=6.0, stats=True):
        g = Genome(signal="tsmom", params={"lookback": 50, "deadband": 0.1})
        return ValidatedStrategy(
            genome=g, inst=f"X{dsr}-USDT-SWAP", bar="15m", is_stats={},
            oos_stats={"dsr": dsr, "sharpe": sharpe} if stats else {})

    with tempfile.TemporaryDirectory() as d:
        reg = Registry(d)
        reg.strategies = [strat(0.050), strat(0.175), strat(0.71), strat(0.97)]
        said = []
        n = reg.prune_to_gates({"min_dsr": 0.5, "min_oos_sharpe": 0.5},
                               said.append)
        assert n == 2
        assert [s.oos_stats["dsr"] for s in reg.strategies] == [0.71, 0.97]
        assert "best DSR among them 0.175" in said[0]


def test_registry_drops_entries_with_no_recorded_verdict():
    import tempfile

    from hermes.live.trader import Registry
    from hermes.research.validate import ValidatedStrategy
    from hermes.strategy.genome import Genome

    with tempfile.TemporaryDirectory() as d:
        reg = Registry(d)
        reg.strategies = [ValidatedStrategy(
            genome=Genome(signal="tsmom", params={"lookback": 50,
                                                  "deadband": 0.1}),
            inst="A-USDT-SWAP", bar="15m", is_stats={}, oos_stats={})]
        assert reg.prune_to_gates({"min_dsr": 0.5, "min_oos_sharpe": 0.5}) == 1
        assert reg.strategies == []


def test_a_book_that_still_passes_is_left_alone():
    import tempfile

    from hermes.live.trader import Registry
    from hermes.research.validate import ValidatedStrategy
    from hermes.strategy.genome import Genome

    with tempfile.TemporaryDirectory() as d:
        reg = Registry(d)
        reg.strategies = [ValidatedStrategy(
            genome=Genome(signal="tsmom", params={"lookback": 50,
                                                  "deadband": 0.1}),
            inst="A-USDT-SWAP", bar="15m", is_stats={},
            oos_stats={"dsr": 0.97, "sharpe": 4.7})]
        said = []
        assert reg.prune_to_gates({"min_dsr": 0.5, "min_oos_sharpe": 0.5},
                                  said.append) == 0
        assert len(reg.strategies) == 1
        assert said == []


def test_research_reports_each_instrument_as_it_finishes():
    """Workers run in other processes and return their log lines rather than
    printing them. Buffering every line until the last worker landed meant a
    pass emitted nothing for its whole duration — 2h34 on the live box, with
    a hung run and a working one looking identical the entire time."""
    from hermes.config import Config
    from hermes.data.synthetic import generate
    from hermes.live.trader import run_research

    cfg = Config.load(None)
    cfg.raw["research"].update(population=8, generations=1, seed=1,
                               min_dsr=0.5, max_deployed=2)
    uni = {f"S{k}-USDT-SWAP": generate(inst=f"S{k}-USDT-SWAP", bar="1H",
                                       n=2600, seed=40 + k)
           for k in range(4)}
    cfg.raw["instruments"] = sorted(uni)
    cfg.raw["bar"] = "1H"
    said = []
    run_research(uni, cfg, log=said.append)

    progress = [m for m in said if "strategies passed OOS validation" in m]
    assert len(progress) == 4, said
    # each carries its position in the queue and the elapsed time
    for k, m in enumerate(progress, start=1):
        assert f"[{k}/4," in m, m
        assert "min elapsed]" in m, m


def test_dust_positions_are_closable_when_the_book_empties():
    """The live book held 22 positions worth 0.08 to 4.15 USDT. With the
    registry pruned to nothing every target is zero, and every closing order
    was under the 10 USDT floor — so they would have been retried and
    rejected every fifteen minutes forever, bleeding funding."""
    from hermes.config import Config
    from hermes.exchange.broker import PaperBroker
    from hermes.live.trader import Registry, Trader
    from hermes.portfolio.allocator import Allocator
    from hermes.risk import RiskEngine
    import tempfile

    prices = {"AVAX-USDT-SWAP": 6.35, "DOT-USDT-SWAP": 0.759}
    with tempfile.TemporaryDirectory() as d:
        cfg = Config.load(None)
        cfg.raw["instruments"] = sorted(prices)
        broker = PaperBroker(cash=10_000.0, fee_bps=2.0, slippage_bps=1.0)
        broker.mark_prices(prices)
        broker.market_order("AVAX-USDT-SWAP", -0.653720, prices["AVAX-USDT-SWAP"])
        broker.market_order("DOT-USDT-SWAP", -5.218024, prices["DOT-USDT-SWAP"])
        assert broker.positions()

        risk = RiskEngine(max_gross_leverage=2.0, max_instrument_leverage=1.0,
                          daily_loss_limit_pct=3.0, max_drawdown_pct=15.0,
                          min_trade_notional=10.0, max_order_notional=25_000.0)
        risk.state_path = None
        reg = Registry(d)                       # empty book
        trader = Trader(cfg, broker, reg, Allocator(bars_per_year=35040), risk,
                        log=lambda m: None)
        orders = trader._reconcile({}, prices, equity=10_000.0)

    assert len(orders) == 2, orders
    assert all(abs(o["notional"]) < 10.0 for o in orders), orders
    assert not broker.positions() or all(
        abs(q) < 1e-9 for q in broker.positions().values())


def test_a_position_too_small_for_the_venue_is_left_alone():
    """Below a dollar the exchange's own lot size refuses the order; retrying
    every bar would only spam the log."""
    from hermes.config import Config
    from hermes.exchange.broker import PaperBroker
    from hermes.live.trader import Registry, Trader
    from hermes.portfolio.allocator import Allocator
    from hermes.risk import RiskEngine
    import tempfile

    prices = {"ETC-USDT-SWAP": 5.86}
    with tempfile.TemporaryDirectory() as d:
        cfg = Config.load(None)
        cfg.raw["instruments"] = sorted(prices)
        broker = PaperBroker(cash=10_000.0, fee_bps=2.0, slippage_bps=1.0)
        broker.mark_prices(prices)
        broker.market_order("ETC-USDT-SWAP", -0.013657, prices["ETC-USDT-SWAP"])
        risk = RiskEngine(max_gross_leverage=2.0, max_instrument_leverage=1.0,
                          daily_loss_limit_pct=3.0, max_drawdown_pct=15.0,
                          min_trade_notional=10.0, max_order_notional=25_000.0)
        risk.state_path = None
        trader = Trader(cfg, broker, Registry(d),
                        Allocator(bars_per_year=35040), risk,
                        log=lambda m: None)
        orders = trader._reconcile({}, prices, equity=10_000.0)
    assert orders == []
