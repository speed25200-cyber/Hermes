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
