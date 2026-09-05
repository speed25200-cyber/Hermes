"""Panel research: alignment, causality, CSCV/PBO, holdout gate, state
versioning and live execution of a panel rule."""

import json
import os
import random

import numpy as np

from hermes import ENGINE_VERSION
from hermes.config import Config
from hermes.data.store import BARS_PER_YEAR, Candles
from hermes.data.synthetic import generate, generate_universe
from hermes.exchange.broker import PaperBroker
from hermes.live.trader import (Registry, Trader, ensure_state_version,
                                panel_live_book)
from hermes.portfolio.allocator import Allocator
from hermes.research.evolve import Candidate, PanelEvaluator, evolve, return_matrix
from hermes.research.panel import PANEL_INST, Panel
from hermes.research.pbo import cscv
from hermes.research.validate import ValidatedStrategy, select_book, validate_panel
from hermes.risk import RiskEngine
from hermes.strategy.genome import Genome, random_genome


def _universe(n=4000, seed=1):
    uni = generate_universe(bar="1H", n=n, seed=seed)
    # a late listing: only the last 60% of history
    late = generate(inst="LATE-USDT-SWAP", bar="1H", n=n, seed=seed + 55, s0=5.0)
    uni.append(late.slice(int(n * 0.4), n))
    return {c.inst: c for c in uni}


def test_panel_aligns_ragged_histories():
    data = _universe()
    p = Panel(data, leader="SYNA-USDT-SWAP")
    assert p.k == 4
    assert p.n == len(data["SYNA-USDT-SWAP"])
    late = p.insts.index("LATE-USDT-SWAP")
    # absent bars are NaN, present ones carry the instrument's own return
    assert np.isnan(p.ret[late, 0])
    assert p.present[late].sum() == len(data["LATE-USDT-SWAP"])
    assert p.n_present[0] == 3 and p.n_present[-1] == 4


def test_panel_book_returns_match_single_instrument_engine():
    """With one instrument, the panel book equals the single backtest."""
    from hermes.backtest import engine
    c = generate(n=3000, seed=2)
    p = Panel({c.inst: c})
    g = Genome(signal="tsmom", params={"lookback": 200, "deadband": 0.2},
               vol_target=0.3, max_lev=1.0)
    P = p.positions(g)
    rets, turnover, _ = p.book_returns(P, 3.0, 1.0)
    from hermes.strategy.signals import compute_position
    res = engine.run(c, compute_position(c, g), 3.0, 1.0)
    np.testing.assert_allclose(rets, res.rets, atol=1e-12)
    assert abs(turnover - res.turnover) < 1e-12


def test_panel_positions_are_causal_and_slice_is_blind():
    data = _universe(seed=3)
    p = Panel(data, leader="SYNA-USDT-SWAP")
    cut = p.cut_index(0.6)
    p_is = p.slice_to(cut)
    assert p_is.n == cut
    assert all(c.ts[-1] < p.ts[cut] for c in p_is.candles.values())
    rng = random.Random(0)
    for _ in range(5):
        g = random_genome(rng)
        full = p.positions(g)
        part = p_is.positions(g)
        for j, inst in enumerate(p_is.insts):
            jj = p.insts.index(inst)
            n = len(p_is.candles[inst])
            ix_full = p.idx[inst][:n]
            ix_part = p_is.idx[inst]
            # regime/vol filters use trailing windows only; positions on the
            # shared bars must agree except for ML warm-up edge effects
            a = full[jj, ix_full]
            b = part[j, ix_part]
            m = min(len(a), len(b)) - 100
            np.testing.assert_allclose(a[:m], b[:m], atol=1e-9)


def test_live_book_matches_panel_construction():
    data = _universe(seed=4)
    p = Panel(data, leader="SYNA-USDT-SWAP")
    g = Genome(signal="meanrev", params={"lookback": 40, "entry_z": 1.5},
               vol_target=0.3, max_lev=1.0)
    W = p.book(p.positions(g))
    book = panel_live_book(data, g, "SYNA-USDT-SWAP")
    for inst, w in book.items():
        j = p.insts.index(inst)
        assert abs(W[j, -1] - w) < 1e-12


def test_cscv_flags_noise_and_passes_signal():
    rng = np.random.default_rng(0)
    T, N = 4000, 60
    noise = rng.normal(0, 0.01, (T, N))
    res = cscv(noise, bars_per_year=8760, n_blocks=8)
    assert res["n_combos"] == 70
    assert res["pbo"] >= 0.3          # selecting on noise does not carry over
    # one column with a real edge dominates in every split
    signal = noise.copy()
    signal[:, 7] += 0.004
    res2 = cscv(signal, bars_per_year=8760, n_blocks=8)
    assert res2["pbo"] < 0.1
    assert res2["oos_sharpe_median"] > 1.0


def test_return_matrix_and_archive():
    data = _universe(n=2500, seed=5)
    p = Panel(data, leader="SYNA-USDT-SWAP")
    archive = []
    pop, n = evolve(p, population=8, generations=1, seed=1, archive=archive)
    assert n == len(archive) >= 8
    R = return_matrix(archive)
    assert R.shape == (p.n, len(archive))
    assert R.dtype == np.float32


def test_validate_panel_rejects_random_walks():
    rng = np.random.default_rng(11)
    data = {}
    n = 6000
    for k in range(4):
        ts = np.arange(n, dtype=np.int64) * 3_600_000
        c = 100 * np.cumprod(1 + rng.normal(0, 0.01, n))
        data[f"RW{k}-USDT-SWAP"] = Candles(f"RW{k}-USDT-SWAP", "1H", ts, c,
                                          c * 1.001, c * 0.999, c, np.ones(n))
    p = Panel(data)
    p_is = p.slice_to(p.cut_index(0.6))
    pop, _ = evolve(p_is, population=20, generations=2, seed=3)
    surv = validate_panel(pop, p, is_fraction=0.6, embargo_bars=24,
                          min_oos_sharpe=1.0, min_dsr=0.5, top_k=6)
    assert len(surv) <= 1


def test_validate_panel_finds_planted_trend():
    """A universe with a common drift regime: a tsmom rule applied as a
    panel must pass the holdout."""
    rng = np.random.default_rng(21)
    n = 8000
    data = {}
    ts = np.arange(n, dtype=np.int64) * 3_600_000
    regime = np.sign(np.sin(np.arange(n) / 400.0))      # slow alternating trends
    for k in range(5):
        r = 0.0015 * regime + rng.normal(0, 0.006, n)
        c = 100 * np.cumprod(1 + r)
        data[f"T{k}-USDT-SWAP"] = Candles(f"T{k}-USDT-SWAP", "1H", ts, c,
                                         c * 1.001, c * 0.999, c, np.ones(n))
    p = Panel(data)
    g = Genome(signal="tsmom", params={"lookback": 150, "deadband": 0.3},
               vol_target=0.3, max_lev=1.0)
    ev = PanelEvaluator(p.slice_to(p.cut_index(0.6)), 3.0, 1.0)
    fit, stats, rets = ev.evaluate(g)
    cand = Candidate(g, fit, stats, rets)
    surv = validate_panel([cand], p, is_fraction=0.6, embargo_bars=24,
                          min_oos_sharpe=0.7, min_dsr=0.5, top_k=1)
    assert len(surv) == 1
    assert surv[0].inst == PANEL_INST
    assert surv[0].oos_stats["sharpe"] > 0.7
    assert surv[0].oos_rets is not None


def test_select_book_drops_weakest_until_floor():
    bpy = BARS_PER_YEAR["1H"]
    rng = np.random.default_rng(3)
    good = rng.normal(0.0004, 0.004, 3000)
    bad = rng.normal(-0.0006, 0.004, 3000)

    def vs(name, rets, sh):
        g = Genome(signal="tsmom", params={"lookback": 100, "deadband": 0.1})
        return ValidatedStrategy(g, name, "1H", {}, {"sharpe": sh}, oos_rets=rets)
    out = select_book([vs("A", good, 2.0), vs("B", bad, -1.5)], 1.0, bpy)
    assert [s.inst for s in out] == ["A"]


def test_state_version_archives_foreign_state(tmp_path):
    sd = str(tmp_path)
    for name in ("registry.json", "risk.json", "trader.json"):
        with open(os.path.join(sd, name), "w") as f:
            json.dump({"old": True}, f)
    assert ensure_state_version(sd) is True
    assert not os.path.exists(os.path.join(sd, "registry.json"))
    arch = [d for d in os.listdir(sd) if d.startswith("archive-v0-")]
    assert len(arch) == 1
    assert os.path.exists(os.path.join(sd, arch[0], "risk.json"))
    with open(os.path.join(sd, "engine_version")) as f:
        assert int(f.read()) == ENGINE_VERSION
    # same version: nothing moves
    with open(os.path.join(sd, "registry.json"), "w") as f:
        json.dump({"engine_version": ENGINE_VERSION}, f)
    assert ensure_state_version(sd) is False
    assert os.path.exists(os.path.join(sd, "registry.json"))


def test_trader_executes_panel_strategy(tmp_path):
    data = _universe(n=3000, seed=8)
    cfg = Config()
    cfg.raw["instruments"] = sorted(data)
    g = Genome(signal="tsmom", params={"lookback": 120, "deadband": 0.1},
               vol_target=0.4, max_lev=1.0)
    strat = ValidatedStrategy(g, PANEL_INST, "1H", {}, {"sharpe": 1.0, "dsr": 0.6})
    registry = Registry(str(tmp_path))
    registry.strategies = [strat]
    broker = PaperBroker(cash=10000.0, fee_bps=5.0, slippage_bps=2.0)
    allocator = Allocator(bars_per_year=BARS_PER_YEAR["1H"])
    risk = RiskEngine(max_gross_leverage=3.0, max_instrument_leverage=1.0,
                      daily_loss_limit_pct=50.0, max_drawdown_pct=90.0,
                      min_trade_notional=10.0, max_order_notional=100000.0)
    trader = Trader(cfg, broker, registry, allocator, risk, log=lambda m: None)
    n_orders = 0
    n = len(data["SYNA-USDT-SWAP"])
    for i in range(n - 150, n):
        window = {inst: c.slice(0, max(0, i + 1 - (n - len(c)))) for inst, c in data.items()}
        window = {k: v for k, v in window.items() if len(v)}
        rep = trader.run_cycle(window, data["SYNA-USDT-SWAP"].ts[i] / 1000.0)
        n_orders += len(rep.get("orders", []))
        assert rep["equity"] > 0
    assert n_orders > 0
    sid = registry.sid(strat)
    assert isinstance(trader.last_positions[sid], dict)
    assert allocator.tracks[sid].n_obs > 100


def test_membership_mask_is_causal_and_ranks_by_trailing_volume():
    from hermes.universe import membership_mask
    n = 3000
    ts = np.arange(n, dtype=np.int64) * 3_600_000
    rng = np.random.default_rng(5)
    data = {}
    for k in range(6):
        c = 100 * np.cumprod(1 + rng.normal(0, 0.01, n))
        qv = np.full(n, 1e6 * (k + 1))
        if k == 0:   # the biggest name at the end, tiny at the start
            qv[: n // 2] = 1.0
            qv[n // 2:] = 1e9
        data[f"M{k}-USDT-SWAP"] = Candles(f"M{k}-USDT-SWAP", "1H", ts, c, c, c, c,
                                         np.ones(n), qv=qv)
    insts = sorted(data)
    idx = {i: np.arange(n) for i in insts}
    m = membership_mask(data, insts, idx, n, top_n=3, window_bars=240, min_bars=100)
    j0 = insts.index("M0-USDT-SWAP")
    assert not m[j0, 1000]            # small volume then: out
    assert m[j0, -1]                  # dominant volume now: in
    assert m[:, 1000].sum() == 3      # exactly top_n investable
    assert not m[:, 50].any()         # warm-up
    # tampering with the future cannot change past membership
    data["M0-USDT-SWAP"].qv[2500:] = 0.0
    m2 = membership_mask(data, insts, idx, n, top_n=3, window_bars=240, min_bars=100)
    assert np.array_equal(m[:, :2400], m2[:, :2400])


def test_panel_zeroes_positions_outside_membership():
    data = _universe(n=3000, seed=9)
    for k, (inst, c) in enumerate(sorted(data.items())):
        c.qv = np.full(len(c), 1e6 * (k + 1))
    p = Panel(data, leader="SYNA-USDT-SWAP", top_n=2, membership_bars=100)
    g = Genome(signal="tsmom", params={"lookback": 100, "deadband": 0.0},
               vol_target=0.4, max_lev=1.0)
    P = p.positions(g)
    out = p.present & ~p.investable
    assert out.any()
    assert np.all(P[out] == 0.0)
    assert p.n_present.max() <= 2


def test_align_to_reference_truncates_and_drops_stale():
    from hermes.live.trader import align_to_reference
    data = _universe(n=1000, seed=12)
    lead = data["SYNA-USDT-SWAP"]
    ahead = data["SYNB-USDT-SWAP"]
    # SYNC is one bar behind the leader (still fine), LATE is three bars behind (stale)
    data["SYNC-USDT-SWAP"] = data["SYNC-USDT-SWAP"].slice(0, 999)
    data["LATE-USDT-SWAP"] = data["LATE-USDT-SWAP"].slice(0, len(data["LATE-USDT-SWAP"]) - 3)
    # leader truncated so SYNB is "ahead" by one bar
    data["SYNA-USDT-SWAP"] = lead.slice(0, 999)
    out = align_to_reference(data, "SYNA-USDT-SWAP")
    ref = int(data["SYNA-USDT-SWAP"].ts[-1])
    assert "LATE-USDT-SWAP" not in out
    assert int(out["SYNB-USDT-SWAP"].ts[-1]) == ref
    assert int(out["SYNC-USDT-SWAP"].ts[-1]) == ref
    assert len(out["SYNB-USDT-SWAP"]) == len(ahead) - 1
