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

from .config import Config, effective_costs
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
    survivors, _n_trials = run_research(research_data, cfg, log=lambda m: print(f"[research] {m}"))
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
    demo_fee, demo_slip = effective_costs(cfg["costs"])
    broker = PaperBroker(cash=cfg["live"]["paper_equity"],
                         fee_bps=demo_fee, slippage_bps=demo_slip)
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
    registry.researched_at = time.time()
    registry.save()
    for stale in ("journal.jsonl", "hermes.log", "risk.json"):
        p = os.path.join(state_dir, stale)
        if os.path.exists(p):
            os.remove(p)
    risk.state_path = os.path.join(state_dir, "risk.json")
    log_path = os.path.join(state_dir, "hermes.log")

    def file_log(msg: str) -> None:
        with open(log_path, "a") as f:
            f.write(f"[demo] {msg}\n")

    trader = Trader(cfg, broker, registry, allocator, risk, log=file_log,
                    journal_path=os.path.join(state_dir, "journal.jsonl"))

    print(f"[demo] replaying {replay_bars} held-out bars through the paper trader...")
    eq_curve = []
    start = n_bars - replay_bars
    # expanding history (like live trading, where the store only grows):
    # keeps the ML/regime incremental caches hot bar over bar
    for i in range(start, n_bars):
        candle_map = {c.inst: c.slice(0, i + 1) for c in universe}
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


def cmd_realtest(args) -> None:
    """Research + OOS paper replay on bundled REAL market candles."""
    from .backtest import metrics
    from .data.real import load_bundled
    from .exchange.broker import PaperBroker
    from .live.trader import Registry, Trader, run_research
    from .portfolio.allocator import Allocator
    from .risk import RiskEngine

    cfg = Config.load(args.config)
    r = cfg.raw["research"]
    if args.fast:
        r["population"] = 48
        r["generations"] = 10
    r["seed"] = args.seed
    datasets = load_bundled()
    print("[realtest] real candles loaded:")
    for c in datasets:
        t0 = time.strftime("%Y-%m-%d", time.gmtime(c.ts[0] / 1000))
        t1 = time.strftime("%Y-%m-%d", time.gmtime(c.ts[-1] / 1000))
        print(f"  {c.inst} ({c.bar}): {len(c)} bars, {t0} -> {t1}")
    print("[realtest] note: annualised figures overstate FX/equity Sharpe by "
          "~15-20% (24/7 bar count); relative comparisons are unaffected\n")

    from .backtest import engine as bt_engine
    from .research.evolve import evolve
    from .research.validate import split_is_oos, validate_candidates
    from .strategy.signals import compute_position

    for candles in datasets:
        inst, bar = candles.inst, candles.bar
        n = len(candles)
        replay_bars = max(200, int(n * 0.15))
        research_data = candles.slice(0, n - replay_bars)
        cfg.raw["instruments"] = [inst]
        cfg.raw["bar"] = bar
        print(f"===== {inst} ({bar}) — research on {len(research_data)} bars, "
              f"replay on final {replay_bars} =====")
        candles_is, _ = split_is_oos(research_data, r["is_fraction"],
                                     r["embargo_bars"])
        rt_fee, rt_slip = effective_costs(cfg["costs"])
        pop, n_trials = evolve(
            candles_is, population=r["population"],
            generations=r["generations"],
            fee_bps=rt_fee, slip_bps=rt_slip, seed=r.get("seed"),
            log=lambda m: print(f"[research] {m}"))
        survivors = validate_candidates(
            pop, research_data, n_trials=n_trials,
            is_fraction=r["is_fraction"], embargo_bars=r["embargo_bars"],
            min_oos_sharpe=r["min_oos_sharpe"], min_dsr=r["min_dsr"],
            fee_bps=rt_fee, slip_bps=rt_slip,
            max_deployed=r["max_deployed"],
            log=lambda m: print(f"[research] {m}"))

        # what a NAIVE optimiser (no validation gate) would have deployed:
        # the best in-sample genome, run on the untouched replay segment
        naive = pop[0].genome
        naive_pos = compute_position(candles, naive)
        replay_slice = candles.slice(n - replay_bars, n)
        naive_res = bt_engine.run(replay_slice, naive_pos[n - replay_bars:],
                                  rt_fee, rt_slip)
        print(f"[naive] best in-sample genome ({naive.describe()}) on the "
              f"untouched replay segment: {naive_res.stats['total_return'] * 100:+.2f}%, "
              f"sharpe {naive_res.stats['sharpe']:.2f}, "
              f"mdd {naive_res.stats['max_drawdown']:.1%}")

        if not survivors:
            print(f"[realtest] {inst}: NOTHING passed the validation gate — "
                  "the honest outcome when no robust edge exists in this "
                  "sample. Hermes deploys no capital here, while a naive "
                  "optimiser would have traded the genome above.\n")
            continue

        state_dir = os.path.join(cfg["state_dir"], "realtest", inst)
        os.makedirs(state_dir, exist_ok=True)
        registry = Registry(state_dir)
        registry.strategies = survivors
        registry.researched_at = time.time()
        registry.save()
        broker = PaperBroker(cash=cfg["live"]["paper_equity"],
                             fee_bps=rt_fee, slippage_bps=rt_slip)
        bpy = BARS_PER_YEAR[bar]
        allocator = Allocator(
            ewma_halflife_bars=cfg["allocator"]["ewma_halflife_bars"],
            eta=cfg["allocator"]["eta"], max_weight=cfg["allocator"]["max_weight"],
            portfolio_vol_target=cfg["risk"]["portfolio_vol_target"],
            bars_per_year=bpy)
        rk = cfg["risk"]
        risk = RiskEngine(
            max_gross_leverage=rk["max_gross_leverage"],
            max_instrument_leverage=rk["max_instrument_leverage"],
            daily_loss_limit_pct=rk["daily_loss_limit_pct"],
            max_drawdown_pct=rk["max_drawdown_pct"],
            min_trade_notional=rk["min_trade_notional"],
            max_order_notional=rk["max_order_notional"])
        journal = os.path.join(state_dir, "journal.jsonl")
        if os.path.exists(journal):
            os.remove(journal)
        trader = Trader(cfg, broker, registry, allocator, risk,
                        log=lambda m: None, journal_path=journal)

        eq_curve = []
        for i in range(n - replay_bars, n):
            window = {inst: candles.slice(0, i + 1)}
            report = trader.run_cycle(window, candles.ts[i] / 1000.0)
            eq_curve.append(report["equity"])
            if risk.state.killed:
                print(f"[realtest] kill switch at bar {i}: {risk.state.kill_reason}")
                break
        eq = np.array(eq_curve)
        rets = np.diff(eq) / eq[:-1]
        bh = candles.c[-1] / candles.c[n - replay_bars] - 1.0
        print(f"\n----- {inst} OOS replay ({len(eq)} bars, never seen by research) -----")
        print(f"strategy return    : {(eq[-1] / eq[0] - 1) * 100:+.2f}%")
        print(f"buy & hold return  : {bh * 100:+.2f}%")
        print(f"annualised sharpe  : {metrics.sharpe(rets, bpy):.2f}")
        print(f"max drawdown       : {metrics.max_drawdown(eq):.2%}")
        print(f"time in market     : {np.mean(np.abs(np.diff(eq)) > 1e-9) * 100:.0f}% of bars")
        print("deployed:")
        for s in survivors:
            print(f"  {s.genome.gid} {s.genome.describe()} "
                  f"(OOS sharpe {s.oos_stats['sharpe']:.2f}, "
                  f"dsr {s.oos_stats['dsr']:.2f}, "
                  f"folds+ {s.oos_stats.get('oos_folds_positive', '?')})")
        print()


def cmd_fetch(args) -> None:
    from .data.fetcher import (fetch_aux, fetch_candles, fetch_funding,
                               fetch_index)
    from .exchange.okx_client import OKXClient

    cfg = Config.load(args.config)
    store = DataStore(cfg["data_dir"])
    client = OKXClient(cfg.credentials)
    failed = []
    for inst in cfg["instruments"]:
        # one bad/unlisted instrument must never sink the whole backfill —
        # research simply skips instruments without enough bars
        try:
            fetch_candles(client, store, inst, cfg["bar"], cfg["history_days"],
                          log=print)
            fetch_funding(client, store, inst, cfg["history_days"], log=print)
            fetch_aux(client, store, inst, cfg["history_days"], log=print)
            fetch_index(client, store, inst, cfg["bar"], cfg["history_days"],
                        log=print)
        except Exception as exc:
            failed.append(inst)
            print(f"fetch {inst}: FAILED ({type(exc).__name__}: {exc}) — skipping")
    if failed:
        print(f"fetch: {len(failed)} instrument(s) skipped: {', '.join(failed)}")


def cmd_research(args) -> None:
    from .live.trader import Registry, run_research

    cfg = Config.load(args.config)
    store = DataStore(cfg["data_dir"])
    candles = {inst: store.load(inst, cfg["bar"]) for inst in cfg["instruments"]}
    registry = Registry(cfg["state_dir"])
    incumbents = list(registry.strategies)
    survivors, n_trials = run_research(
        candles, cfg, log=print, escalation=registry.consecutive_empty,
        incumbents=incumbents)
    registry.strategies = survivors
    registry.record_outcome(survivors)
    registry.researched_at = time.time()
    registry.n_trials = n_trials
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


def cmd_dashboard(args) -> None:
    from .dashboard.server import serve

    cfg = Config.load(args.config)
    state_dir = os.path.join(cfg["state_dir"], "demo") if args.demo else cfg["state_dir"]
    ticker_fn = None
    instruments = None
    if not args.demo:
        from .exchange.okx_client import OKXClient
        instruments = cfg["instruments"]
        ticker_fn = OKXClient(cfg.credentials).tickers_full  # public endpoint
    serve(state_dir, host=args.host, port=args.port,
          mode_hint="demo" if args.demo else cfg["live"]["mode"],
          open_browser=not args.no_browser, token=args.token or "",
          instruments=instruments, ticker_fn=ticker_fn,
          meta={"refresh_hours": cfg["research"]["refresh_hours"]})


def cmd_cycle(args) -> None:
    """Single trading cycle, then exit (for cron / GitHub Actions)."""
    from .live.trader import LiveRunner

    cfg = Config.load(args.config)
    if args.mode:
        cfg.raw["live"]["mode"] = args.mode
    if cfg["live"]["mode"] == "live" and not cfg.credentials.present:
        raise SystemExit("live mode requires OKX_API_KEY, OKX_API_SECRET, "
                         "OKX_API_PASSPHRASE environment variables")
    runner = LiveRunner(cfg)
    runner.run_once(allow_research=args.research)


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

    rt = sub.add_parser("realtest",
                        help="research + OOS replay on bundled REAL candles")
    rt.add_argument("--fast", action="store_true")
    rt.add_argument("--seed", type=int, default=7)
    rt.set_defaults(fn=cmd_realtest)

    r = sub.add_parser("research", help="run alpha search on stored data")
    r.set_defaults(fn=cmd_research)

    u = sub.add_parser("run", help="autonomous trading loop")
    u.add_argument("--mode", choices=["paper", "live"], default=None)
    u.set_defaults(fn=cmd_run)

    cy = sub.add_parser("cycle",
                        help="one trading cycle then exit (cron/CI runners)")
    cy.add_argument("--mode", choices=["paper", "live"], default=None)
    cy.add_argument("--research", action="store_true",
                    help="also refresh research if stale (long)")
    cy.set_defaults(fn=cmd_cycle)

    s = sub.add_parser("status", help="show state")
    s.set_defaults(fn=cmd_status)

    b = sub.add_parser("dashboard", help="local web console (live monitoring)")
    b.add_argument("--port", type=int, default=8899)
    b.add_argument("--host", default="127.0.0.1",
                   help="bind address; 0.0.0.0 exposes to your LAN so a "
                        "phone can connect (trusted networks only)")
    b.add_argument("--demo", action="store_true",
                   help="point at the demo state dir (state/demo)")
    b.add_argument("--no-browser", action="store_true")
    b.add_argument("--token", default=None,
                   help="access key required from clients (or env "
                        "HERMES_DASH_TOKEN); use when exposing beyond localhost")
    b.set_defaults(fn=cmd_dashboard)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
