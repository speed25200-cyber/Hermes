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
            max_deployed=r["max_deployed"], max_corr=r.get("max_corr", 0.9),
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


def _held_instruments(state_dir: str, broker=None) -> list[str]:
    """Instruments carrying a position right now.

    A live broker is asked directly: `trader.json` only records a book for the
    paper broker, so reading the file alone would report nothing in live mode —
    exactly where stranding a position actually costs money.
    """
    held: set[str] = set()
    if broker is not None:
        try:
            held.update(inst for inst, qty in broker.positions().items()
                        if abs(float(qty)) > 1e-12)
        except Exception:
            pass                      # fall through to the persisted book
    path = os.path.join(state_dir, "trader.json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                pos = (json.load(f).get("paper_broker") or {}).get("pos") or {}
            held.update(inst for inst, qty in pos.items()
                        if abs(float(qty)) > 1e-12)
        except (OSError, ValueError):
            pass
    return sorted(held)


def cmd_fetch(args) -> None:
    from .data.fetcher import (fetch_aux, fetch_candles, fetch_funding,
                               fetch_index)
    from .exchange.okx_client import OKXClient

    from .data import universe

    cfg = Config.load(args.config)
    store = DataStore(cfg["data_dir"])
    client = OKXClient(cfg.credentials)
    # an instrument we still hold stays in the universe whatever the venue
    # ranking says, so a refresh can never strand an open position
    live_broker = None
    if cfg.credentials.present:
        from .exchange.broker import OKXBroker
        live_broker = OKXBroker(client, td_mode=cfg["live"]["td_mode"])
    held = _held_instruments(cfg["state_dir"], live_broker)
    insts = universe.resolve(cfg, client, cfg["state_dir"], held, log=print)
    cfg.raw["instruments"] = insts
    failed = []
    for inst in insts:
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
    # incumbents are seeded into the search and get a free pass to the OOS
    # exam; one that today's gates reject must not re-enter through that door
    registry.prune_to_gates(cfg["research"], print)
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


def cmd_coverage(args) -> None:
    """Report how much history each data source actually holds.

    Open interest, taker flow and positioning are served by the exchange for
    only a few months, and the order-book series has no exchange history at
    all — Hermes records it itself, one snapshot at a time, and it cannot be
    re-fetched if lost. That recording is best-effort and silent, so without
    this report a broken sampler would surface months later as "ob_imb never
    deploys" rather than as an error.
    """
    from .data.store import AUX_SERIES, DataStore

    cfg = Config.load(args.config)
    store = DataStore(cfg["data_dir"])
    bar = cfg["bar"]
    day = 86_400_000

    def span(lo: int, hi: int, n: int) -> str:
        if not n:
            return "        —            (absent)"
        return (f"{(hi - lo) / day:7.1f}d  {n:7d} rows  "
                f"last {time.strftime('%Y-%m-%d %H:%M', time.gmtime(hi / 1000))}")

    print(f"{'instrument':<18} {'source':<10} coverage")
    researchable = 0
    for inst in cfg["instruments"]:
        print(f"{inst:<18} {'candles':<10} {span(*store.candle_range(inst, bar))}")
        for kind in AUX_SERIES:
            lo, hi, n = store.aux_range(inst, kind)
            print(f"{'':<18} {kind:<10} {span(lo, hi, n)}")
            if kind == "ob" and n and (hi - lo) >= 30 * day:
                researchable += 1
    print()
    if researchable:
        print(f"order-book history: {researchable} instrument(s) past 30 days "
              f"— the ob_imb family has enough to be searched")
    else:
        print("order-book history: still accumulating (needs ~30 days per "
              "instrument before ob_imb is worth searching)")


def cmd_calibration(args) -> None:
    """Compare the OOS Sharpe the gate promised against the one actually
    realised live, per deployed strategy.

    This is the diagnostic the whole research pipeline should be judged on.
    A gate that deploys strategies whose live Sharpe lands far below its OOS
    estimate is miscalibrated no matter how good the individual backtests
    look — the thresholds are then fitting noise, and the honest response is
    to raise them rather than to keep trading. Live figures are the
    allocator's EWMA (halflife ~1 week), so they describe recent behaviour
    rather than the whole deployment.
    """
    cfg = Config.load(args.config)
    state_dir = cfg["state_dir"]
    bpy = BARS_PER_YEAR[cfg["bar"]]

    def _read(name):
        path = os.path.join(state_dir, name)
        if not os.path.exists(path):
            return {}
        with open(path) as f:
            return json.load(f)

    registry = _read("registry.json")
    tracks = _read("trader.json").get("allocator", {}).get("tracks", {})
    strategies = registry.get("strategies", [])
    if not strategies:
        print("no deployed strategies (the gate deploying nothing is a "
              "legitimate outcome)")
        return

    from .strategy.genome import Genome

    print(f"{'strategy':<34} {'OOS':>8} {'live':>8} {'gap':>8} {'bars':>7}")
    pairs = []
    for s in strategies:
        try:
            sid = f"{s['inst']}:{Genome.from_dict(s['genome']).gid}"
        except Exception:
            continue
        # compare like with like: the live figure is a plain EWMA Sharpe with
        # no serial-correlation haircut, so hold it against the uncorrected
        # OOS number rather than the haircut one, which would flatter the gap
        oos = s.get("oos_stats") or {}
        promised = float(oos.get("sharpe_iid", oos.get("sharpe", 0.0)))
        t = tracks.get(sid)
        label = f"{s['inst']} {s['genome'].get('signal', '?')}"
        if not t or int(t.get("n_obs", 0)) < 24:
            print(f"{label:<34} {promised:8.2f} {'—':>8} {'—':>8} "
                  f"{int(t.get('n_obs', 0)) if t else 0:7d}")
            continue
        var = max(float(t["ewma_var"]) - float(t["ewma_ret"]) ** 2, 0.0)
        sd = var ** 0.5
        live = (float(t["ewma_ret"]) / sd) * (bpy ** 0.5) if sd > 1e-12 else 0.0
        pairs.append((promised, live))
        print(f"{label:<34} {promised:8.2f} {live:8.2f} {live - promised:8.2f} "
              f"{int(t['n_obs']):7d}")

    if not pairs:
        print("\nno strategy has enough live bars yet to judge calibration")
        return
    prom = np.array([p for p, _ in pairs])
    real = np.array([r for _, r in pairs])
    print(f"\nstrategies with a live sample : {len(pairs)}")
    print(f"mean OOS Sharpe promised      : {prom.mean():6.2f}  "
          f"(uncorrected, to match the live estimator)")
    print(f"mean live Sharpe realised     : {real.mean():6.2f}")
    print(f"mean shortfall                : {(real - prom).mean():6.2f}")
    if len(pairs) >= 3:
        num = float(((prom - prom.mean()) * (real - real.mean())).sum())
        den = float(np.sqrt(((prom - prom.mean()) ** 2).sum()
                            * ((real - real.mean()) ** 2).sum()))
        if den > 0:
            print(f"rank of OOS vs live (corr)    : {num / den:6.2f}  "
                  f"(near 0 means the OOS estimate carries no information "
                  f"about live performance)")


def cmd_backup(args) -> None:
    """Export the series that cannot be re-fetched.

    Candles and funding can always be pulled from the exchange again. The aux
    series cannot, and not only the order book: OKX serves a few months of
    open interest, taker flow and positioning, so every stored row older than
    that window is already beyond recovery. The order-book imbalance is
    unrecoverable from the first day, since no venue serves its history at
    all — the only copy is the one Hermes recorded itself.

    All of it therefore gets exported by default. This is also the dataset
    whose value comes entirely from how long it has been accumulating, which
    makes a single VPS disk the wrong place for the only copy.

    Restores are additive (INSERT OR REPLACE on the timestamp), so importing
    an older export onto a live store cannot lose newer rows.
    """
    from .data.store import AUX_SERIES, DataStore

    cfg = Config.load(args.config)
    store = DataStore(cfg["data_dir"])
    kinds = ["ob"] if args.order_book_only else list(AUX_SERIES)

    if args.restore:
        total = 0
        with open(args.restore) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                total += store.upsert_aux(rec["inst"], rec["kind"],
                                          [tuple(r) for r in rec["rows"]])
        print(f"restored {total} rows from {args.restore}")
        return

    out = args.out or "hermes-aux-backup.jsonl"
    written = 0
    with open(out, "w") as f:
        for inst in cfg["instruments"]:
            for kind in kinds:
                rows = store.read_aux(inst, kind)
                if not rows:
                    continue
                f.write(json.dumps({"inst": inst, "kind": kind,
                                    "rows": rows}) + "\n")
                written += len(rows)
    print(f"wrote {written} rows to {out}")
    if not written:
        print("nothing recorded yet — run the engine so the order-book "
              "sampler can accumulate")
    else:
        print("keep this OFF the trading host: for the order book it is the "
              "only copy in existence, and the rest is unrecoverable once it "
              "ages past the exchange's retention window")


def cmd_execution(args) -> None:
    """Contrast realised execution cost with the cost the backtest assumed.

    Every validated Sharpe was computed through `effective_costs`, which
    blends the maker and taker fee by an assumed maker miss rate. If the real
    maker share is worse than assumed, every backtest in the registry is
    optimistic by the difference — at 15m bars and ~1% turnover per bar, a
    couple of bps per trade is the whole edge.
    """
    cfg = Config.load(args.config)
    path = os.path.join(cfg["state_dir"], "trader.json")
    if not os.path.exists(path):
        print("no trading state yet")
        return
    with open(path) as f:
        stats = (json.load(f) or {}).get("exec_stats") or {}
    notional = float(stats.get("notional", 0.0))
    if notional <= 0:
        print("no fills recorded yet — execution quality is unmeasured")
        return

    orders = int(stats.get("orders", 0))
    maker_share = float(stats.get("maker_notional", 0.0)) / notional
    fee_bps = float(stats.get("fee_paid", 0.0)) / notional * 1e4
    short_bps = float(stats.get("shortfall", 0.0)) / notional * 1e4
    costs = cfg["costs"]
    model_fee, model_slip = effective_costs(costs)

    print(f"orders filled            : {orders}")
    print(f"notional traded          : {notional:,.0f} USDT")
    print(f"maker share (realised)   : {maker_share:6.1%}")
    if costs.get("prefer_maker", False):
        print(f"maker share (assumed)    : "
              f"{1.0 - float(costs.get('maker_miss_rate', 0.3)):6.1%}")
    print(f"fees        (realised)   : {fee_bps:6.2f} bps")
    print(f"            (modelled)   : {model_fee:6.2f} bps")
    print(f"shortfall vs decision px : {short_bps:6.2f} bps")
    print(f"            (modelled)   : {model_slip:6.2f} bps")
    realised = fee_bps + short_bps
    modelled = model_fee + model_slip
    print(f"ALL-IN      (realised)   : {realised:6.2f} bps")
    print(f"            (modelled)   : {modelled:6.2f} bps")
    gap = realised - modelled
    print()
    if gap > 1.0:
        print(f"Trading costs {gap:.2f} bps MORE per trade than every backtest "
              f"assumed.\nRaise costs.maker_miss_rate / slippage_bps to match "
              f"and re-run research:\nthe deployed book was validated against "
              f"costs it does not actually pay.")
    elif gap < -1.0:
        print(f"Trading costs {-gap:.2f} bps less than modelled — the gate is "
              f"conservative,\nwhich is the safe direction to be wrong in.")
    else:
        print("Realised cost matches the model; the validated Sharpes rest on "
              "the right\nassumption.")


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


def _read_journal(state_dir: str, keep: int) -> list[dict]:
    """The last `keep` journal records.

    Read from the end rather than front to back: an engine journalling every
    bar and every heartbeat writes a line carrying prices and positions for
    the whole universe, and this command exists to be run casually against a
    box that has been trading for months.
    """
    from .dashboard.server import _tail_lines

    path = os.path.join(state_dir, "journal.jsonl")
    rows = []
    for line in _tail_lines(path, keep, max_bytes=64_000_000):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _print_near_misses(state_dir: str, top: int = 5) -> None:
    """What the last research pass came closest to deploying, and why not.

    Printed only when the book is empty, which is the case where "nothing
    deployed" needs a reason attached to be worth anything.
    """
    path = os.path.join(state_dir, "last_research.json")
    if not os.path.exists(path):
        print("  (no research summary on disk — the pass predates this "
              "record, or has not run since)")
        return
    try:
        with open(path) as f:
            d = json.load(f)
    except (OSError, ValueError):
        print("  (research summary unreadable)")
        return
    misses = d.get("near_misses", [])
    print(f"  {d.get('considered', 0)} candidates reached the gate, "
          f"{d.get('deployed', 0)} passed")
    if not misses:
        print("  no candidate got far enough to record a reason")
        return
    print("  closest misses:")
    for m in misses[:top]:
        print(f"    {m.get('what', '?'):<28} sharpe {m.get('sharpe', 0.0):6.2f} "
              f"(bar {m.get('selection_bar', 0.0):5.2f})  {m.get('why', '')}")


def cmd_report(args) -> None:
    """One-screen operational truth: is the book actually trading?

    `status` dumps raw state; useful for forensics, useless for the question
    that matters day to day. This answers it directly — which strategies hold
    capital, what they are signalling, what is on the exchange right now, and
    how many orders the last N cycles actually produced. A book that decides
    every 15 minutes and never trades looks identical to a healthy one in the
    service logs; here the difference is the first number printed.
    """
    cfg = Config.load(args.config)
    state_dir = cfg["state_dir"]
    # Between bars the engine journals a heartbeat: same shape, but it marks
    # positions to live prices and takes no decision, so it always carries an
    # empty order list. Counting those as cycles reports "0% of cycles
    # traded" for a perfectly healthy book — the exact false alarm this
    # command exists to rule out. They are tagged and excluded, and read
    # generously from the tail so the decision cycles are not crowded out.
    journal = _read_journal(state_dir, args.cycles * 40)
    decisions = [r for r in journal if not r.get("hb")]
    cycles = [r for r in decisions if not r.get("halted")][-args.cycles:]
    beats = len(journal) - len(decisions)

    now = time.time()
    # Which names the system believes it trades, and where that list came
    # from. Breadth is the lever behind everything else here — research only
    # searches instruments it was handed — so a universe that silently fell
    # back to the configured list explains a narrow book better than any
    # amount of staring at the strategies it produced.
    upath = os.path.join(state_dir, "universe.json")
    if os.path.exists(upath):
        try:
            with open(upath) as f:
                u = json.load(f)
            print(f"universe: {len(u.get('instruments', []))} instruments "
                  f"from {u.get('source', '?')}, resolved "
                  f"{(now - u.get('resolved_at', 0.0)) / 3600.0:.1f}h ago")
        except (OSError, ValueError):
            print("universe: unreadable")
    else:
        print(f"universe: not venue-resolved, using the configured "
              f"{len(cfg['instruments'])} instruments")
    print()

    reg_path = os.path.join(state_dir, "registry.json")
    print("===== deployed book =====")
    if not os.path.exists(reg_path):
        print("no registry — research has never produced a survivor")
    else:
        with open(reg_path) as f:
            reg = json.load(f)
        strategies = reg.get("strategies", [])
        age_h = (now - reg.get("researched_at", 0.0)) / 3600.0
        print(f"{len(strategies)} strategies | searched {reg.get('n_trials', 0):,} "
              f"genomes | {reg.get('consecutive_empty', 0)} empty passes | "
              f"researched {age_h:.1f}h ago")
        below = 0
        if not strategies:
            _print_near_misses(state_dir)
        for s in strategies:
            o = s.get("oos_stats", {})
            bar = o.get("selection_bar")
            # the Sharpe the search alone was expected to reach: a strategy
            # under it has shown nothing the luckiest draw would not have
            bar_s = f" vs bar {bar:5.2f}" if bar is not None else ""
            if bar is not None and o.get("sharpe", 0.0) < bar:
                below += 1
                bar_s += " !"
            print(f"  {s['inst']:<18} {s['genome']['signal']:<12} "
                  f"oos_sharpe={o.get('sharpe', 0.0):6.2f}{bar_s} "
                  f"dsr={o.get('dsr', 0.0):.3f} "
                  f"folds+={o.get('oos_folds_positive', '?')}")
        if below:
            print(f"  ! {below} of {len(strategies)} scored BELOW the Sharpe "
                  f"that searching that many genomes produces on noise alone")
    print()
    orders = [o for r in cycles for o in r.get("orders", [])]
    traded = sum(1 for r in cycles if r.get("orders"))
    print("===== activity =====")
    if not cycles:
        print("no completed cycle in the journal — the engine has not decided "
              "anything yet")
        if beats:
            print(f"({beats} heartbeats: the engine is marking positions but "
                  f"has taken no decision)")
    else:
        first, last = cycles[0], cycles[-1]
        span_h = max(last["ts"] - first["ts"], 0) / 3600.0
        gross = sum(abs(o.get("notional", 0.0)) for o in orders)
        age_min = (now - last["ts"]) / 60.0
        # a replay journal (demo, backtest) carries the timestamps of the
        # data, not of the run: "2574754 min ago" is not a staleness warning
        when = (f"last {age_min:.0f} min ago" if age_min < 43_200 else
                "replay: " + time.strftime("%Y-%m-%d",
                                           time.gmtime(last["ts"])))
        print(f"cycles           : {len(cycles)} over {span_h:.1f}h "
              f"({when}, {beats} heartbeats)")
        print(f"cycles that traded: {traded} ({traded / len(cycles):.0%})")
        print(f"orders           : {len(orders)}  gross {gross:,.0f} USDT")
        if orders:
            by_inst: dict[str, float] = {}
            for o in orders:
                by_inst[o["inst"]] = by_inst.get(o["inst"], 0.0) + abs(
                    o.get("notional", 0.0))
            top = sorted(by_inst.items(), key=lambda kv: -kv[1])[:8]
            print("  " + "  ".join(f"{i.split('-')[0]}={v:,.0f}" for i, v in top))
        print(f"equity           : {last.get('equity', 0.0):,.2f} USDT")
        if abs(last.get("risk_mult", 1.0) - 1.0) > 1e-9:
            print(f"risk multiplier  : {last['risk_mult']:.2f} (de-risked)")

    halted = [r for r in decisions if r.get("halted")]
    if halted:
        print(f"HALTED cycles    : {len(halted)} — last reason: "
              f"{halted[-1].get('reason', '?')}")

    if not cycles:
        return
    last = cycles[-1]
    weights = last.get("weights", {})
    signals = last.get("strat_pos", {})
    tracks = {}
    tpath = os.path.join(state_dir, "trader.json")
    if os.path.exists(tpath):
        with open(tpath) as f:
            tracks = json.load(f).get("allocator", {}).get("tracks", {})

    print()
    print("===== capital allocation =====")
    if not weights:
        print("no strategy holds capital")
    for sid, w in sorted(weights.items(), key=lambda kv: -kv[1]):
        sig = signals.get(sid)
        n_obs = tracks.get(sid, {}).get("n_obs", 0)
        sig_s = f"{sig:+.4f}" if isinstance(sig, (int, float)) else "    -   "
        print(f"  {w:6.2%}  {sid:<46} signal={sig_s}  n_obs={n_obs}")

    print()
    print("===== live exposure =====")
    # marked from the newest row, heartbeats included: they exist precisely
    # to re-mark positions between decisions, so they hold the fresher prices
    mark = journal[-1]
    positions = mark.get("positions", {})
    prices = mark.get("prices", {}) or last.get("prices", {})
    eq = mark.get("equity", 0.0) or 1.0
    held = {i: q for i, q in positions.items() if abs(q) > 0}
    if not held:
        print("flat — no position on the exchange")
    for inst, qty in sorted(held.items(),
                            key=lambda kv: -abs(kv[1] * prices.get(kv[0], 0.0))):
        notional = qty * prices.get(inst, 0.0)
        print(f"  {inst:<20} {qty:+14.6f}  {notional:+12.2f} USDT  "
              f"({notional / eq:+.2%} of equity)")
    tgt = last.get("targets", {})
    live_gross = sum(abs(q * prices.get(i, 0.0)) for i, q in held.items())
    print(f"  gross exposure: {live_gross / eq:.2%} of equity   "
          f"target gross: {sum(abs(v) for v in tgt.values()):.2%}")


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

    rp = sub.add_parser("report",
                        help="compact operational report: allocation, live "
                             "exposure and how often the book actually trades")
    rp.add_argument("--cycles", type=int, default=200,
                    help="how many recent journal cycles to summarise")
    rp.set_defaults(fn=cmd_report)

    cv = sub.add_parser("coverage",
                        help="history held per data source (incl. the "
                             "self-recorded order book)")
    cv.set_defaults(fn=cmd_coverage)

    bk = sub.add_parser("backup",
                        help="export the market history that cannot be "
                             "re-fetched (order book, and aux rows aged out "
                             "of the exchange's retention window)")
    bk.add_argument("--out", default=None, help="output JSONL path")
    bk.add_argument("--restore", default=None,
                    help="import a previous export instead of writing one")
    bk.add_argument("--order-book-only", action="store_true",
                    help="export only the recorded order book")
    bk.set_defaults(fn=cmd_backup)

    ex = sub.add_parser("execution",
                        help="realised trading cost vs the cost every "
                             "backtest assumed")
    ex.set_defaults(fn=cmd_execution)

    cal = sub.add_parser("calibration",
                         help="OOS Sharpe promised by the gate vs the one "
                              "realised live, per strategy")
    cal.set_defaults(fn=cmd_calibration)

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
