"""Command-line interface.

    python -m hermes demo                # offline end-to-end proof (no network)
    python -m hermes fetch               # backfill candles + funding from OKX
    python -m hermes research            # run alpha search on stored data
    python -m hermes run                 # autonomous loop (paper by default)
    python -m hermes run --mode live     # live trading (needs OKX_* env keys)
    python -m hermes status              # show deployed strategies & state
"""

from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np

from .config import Config
from .data.store import BARS_PER_YEAR, DataStore


def cmd_demo(args) -> None:
    """Offline end-to-end: synthetic universe -> research -> paper replay."""
    from .backtest import metrics
    from .data.synthetic import generate_universe
    from .exchange.broker import PaperBroker
    from .live.trader import Registry, Trader, run_research
    from .portfolio.allocator import Allocator
    from .risk import RiskEngine

    cfg = Config.load(args.config)
    if args.fast:
        cfg.raw["research"]["population"] = 40
        cfg.raw["research"]["generations"] = 8
    cfg.raw["research"]["seed"] = args.seed

    bar = "1H"
    n_bars = 9000 if args.fast else 14000
    replay_bars = 800 if args.fast else 1500
    print(f"[demo] generating synthetic universe ({n_bars} bars of {bar})...")
    universe = generate_universe(bar=bar, n=n_bars, seed=args.seed)
    cfg.raw["instruments"] = [c.inst for c in universe]

    # research only sees data up to the replay start — replay is true OOS
    research_data = {c.inst: c.slice(0, n_bars - replay_bars) for c in universe}
    t0 = time.time()
    survivors = run_research(research_data, cfg, log=lambda m: print(f"[research] {m}"))
    print(f"[demo] research took {time.time() - t0:.1f}s, "
          f"{len(survivors)} strategies deployed")
    if not survivors:
        print("[demo] no strategy passed validation on this seed — the gate is "
              "doing its job; try another --seed")
        return

    # --- replay the held-out segment through the real trading stack --------
    state_dir = os.path.join(cfg["state_dir"], "demo")
    os.makedirs(state_dir, exist_ok=True)
    registry = Registry(state_dir)
    registry.strategies = survivors
    broker = PaperBroker(cash=cfg["live"]["paper_equity"],
                         fee_bps=cfg["costs"]["taker_fee_bps"],
                         slippage_bps=cfg["costs"]["slippage_bps"])
    bpy = BARS_PER_YEAR[bar]
    allocator = Allocator(
        ewma_halflife_bars=cfg["allocator"]["ewma_halflife_bars"],
        eta=cfg["allocator"]["eta"], max_weight=cfg["allocator"]["max_weight"],
        portfolio_vol_target=cfg["risk"]["portfolio_vol_target"], bars_per_year=bpy)
    r = cfg["risk"]
    risk = RiskEngine(
        max_gross_leverage=r["max_gross_leverage"],
        max_instrument_leverage=r["max_instrument_leverage"],
        daily_loss_limit_pct=r["daily_loss_limit_pct"],
        max_drawdown_pct=r["max_drawdown_pct"],
        min_trade_notional=r["min_trade_notional"],
        max_order_notional=r["max_order_notional"])
    trader = Trader(cfg, broker, registry, allocator, risk, log=lambda m: None)

    print(f"[demo] replaying {replay_bars} held-out bars through the paper trader...")
    eq_curve = []
    start = n_bars - replay_bars
    window = 4000  # rolling history window fed to strategies
    for i in range(start, n_bars):
        candle_map = {c.inst: c.slice(max(0, i + 1 - window), i + 1) for c in universe}
        now_ts = universe[0].ts[i] / 1000.0
        # funding applied on positions held into this bar
        for c in universe:
            if c.funding[i]:
                broker.apply_funding(c.inst, float(c.funding[i]))
        report = trader.run_cycle(candle_map, now_ts)
        eq_curve.append(report["equity"])
        if risk.state.killed:
            print(f"[demo] kill switch tripped at bar {i}: {risk.state.kill_reason}")
            break

    eq = np.array(eq_curve)
    rets = np.diff(eq) / eq[:-1]
    print("\n========== DEMO RESULT (out-of-sample paper replay) ==========")
    print(f"bars replayed      : {len(eq)}")
    print(f"final equity       : {eq[-1]:.2f} (start {eq[0]:.2f})")
    print(f"total return       : {(eq[-1] / eq[0] - 1) * 100:+.2f}%")
    print(f"annualised sharpe  : {metrics.sharpe(rets, bpy):.2f}")
    print(f"max drawdown       : {metrics.max_drawdown(eq):.2%}")
    print(f"halted             : {risk.state.killed or risk.state.halted_today}")
    print("strategies deployed:")
    for s in survivors:
        print(f"  {s.inst} {s.genome.gid} {s.genome.describe()} "
              f"(OOS sharpe {s.oos_stats['sharpe']:.2f}, dsr {s.oos_stats['dsr']:.2f})")


def cmd_fetch(args) -> None:
    from .data.fetcher import fetch_candles, fetch_funding
    from .exchange.okx_client import OKXClient

    cfg = Config.load(args.config)
    store = DataStore(cfg["data_dir"])
    client = OKXClient(cfg.credentials)
    for inst in cfg["instruments"]:
        fetch_candles(client, store, inst, cfg["bar"], cfg["history_days"], log=print)
        fetch_funding(client, store, inst, cfg["history_days"], log=print)


def cmd_research(args) -> None:
    from .live.trader import Registry, run_research

    cfg = Config.load(args.config)
    store = DataStore(cfg["data_dir"])
    candles = {inst: store.load(inst, cfg["bar"]) for inst in cfg["instruments"]}
    survivors = run_research(candles, cfg, log=print)
    registry = Registry(cfg["state_dir"])
    registry.strategies = survivors
    registry.researched_at = time.time()
    registry.save()
    print(f"deployed {len(survivors)} strategies -> {registry.path}")


def cmd_run(args) -> None:
    from .live.trader import LiveRunner

    cfg = Config.load(args.config)
    if args.mode:
        cfg.raw["live"]["mode"] = args.mode
    if cfg["live"]["mode"] == "live":
        creds = cfg.credentials
        if not creds.present:
            raise SystemExit("live mode requires OKX_API_KEY, OKX_API_SECRET, "
                             "OKX_API_PASSPHRASE environment variables")
        print("LIVE MODE: real orders will be sent to OKX"
              + (" (demo trading)" if creds.simulated else ""))
    LiveRunner(cfg).run_forever()


def cmd_status(args) -> None:
    cfg = Config.load(args.config)
    state_dir = cfg["state_dir"]
    for name in ("registry.json", "risk.json", "trader.json"):
        path = os.path.join(state_dir, name)
        print(f"--- {path} ---")
        if os.path.exists(path):
            with open(path) as f:
                print(json.dumps(json.load(f), indent=2)[:3000])
        else:
            print("(absent)")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="hermes",
                                description="Autonomous OKX perpetual trading system")
    p.add_argument("--config", default=None, help="path to config JSON")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("demo", help="offline end-to-end demo on synthetic data")
    d.add_argument("--fast", action="store_true")
    d.add_argument("--seed", type=int, default=7)
    d.set_defaults(fn=cmd_demo)

    f = sub.add_parser("fetch", help="backfill market data from OKX")
    f.set_defaults(fn=cmd_fetch)

    r = sub.add_parser("research", help="run alpha search on stored data")
    r.set_defaults(fn=cmd_research)

    u = sub.add_parser("run", help="autonomous trading loop")
    u.add_argument("--mode", choices=["paper", "live"], default=None)
    u.set_defaults(fn=cmd_run)

    s = sub.add_parser("status", help="show state")
    s.set_defaults(fn=cmd_status)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
