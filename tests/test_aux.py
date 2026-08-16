"""Aux market data (open interest / taker flow / long-short ratio):
storage, causal bar alignment, signal families and cross-sectional books."""

import numpy as np

from hermes.data.store import (AUX_PERIOD_MS, BAR_MS, Candles, DataStore,
                               map_aux_to_bars)
from hermes.data.synthetic import generate
from hermes.strategy.genome import AUX_SIGNALS, CORE_SIGNALS, Genome, random_genome
from hermes.strategy.signals import compute_position


def _with_aux(candles: Candles, oi=None, buy=None, sell=None, lsr=None,
              ttp=None) -> Candles:
    n = len(candles)
    candles.x = {
        "oi": np.full(n, 1e6) if oi is None else np.asarray(oi, float),
        "tak_buy": np.full(n, 50.0) if buy is None else np.asarray(buy, float),
        "tak_sell": np.full(n, 50.0) if sell is None else np.asarray(sell, float),
        "lsr": np.ones(n) if lsr is None else np.asarray(lsr, float),
        "ttp": np.ones(n) if ttp is None else np.asarray(ttp, float),
    }
    return candles


# ---------------------------------------------------------------- storage --


def test_aux_mapping_is_causal():
    """A 1H row stamped T is only visible to bars that CLOSE at/after T+1h."""
    bar_ms = BAR_MS["15m"]
    bar_ts = np.arange(0, 8 * 3_600_000, bar_ms, dtype=np.int64)
    rows = [(0, 10.0, 1.0), (3_600_000, 20.0, 2.0)]  # rows at 00:00 and 01:00
    v1, _ = map_aux_to_bars(bar_ts, bar_ms, rows, AUX_PERIOD_MS)
    # bars closing at 00:15..00:45 predate 01:00 -> nothing known yet
    assert np.isnan(v1[0]) and np.isnan(v1[1]) and np.isnan(v1[2])
    # bar 3 closes exactly at 01:00 = availability of the 00:00 row
    assert v1[3] == 10.0
    # bar 7 closes at 02:00 -> the 01:00 row becomes visible
    assert v1[6] == 10.0 and v1[7] == 20.0
    # staleness: 3 periods after the last row's availability -> NaN again
    assert v1[19] == 20.0        # closes at 05:00, 3h after avail 02:00
    assert np.isnan(v1[20])      # closes at 05:15, beyond staleness


def test_store_roundtrip_attaches_aux(tmp_path):
    store = DataStore(str(tmp_path))
    inst, bar = "BTC-USDT-SWAP", "15m"
    bar_ms = BAR_MS[bar]
    candle_rows = [(i * bar_ms, 100.0, 101.0, 99.0, 100.0, 5.0)
                   for i in range(400)]
    store.upsert_candles(inst, bar, candle_rows)
    hours = range(0, 100)
    store.upsert_aux(inst, "oi", [(h * 3_600_000, 1000.0 + h, 0.0) for h in hours])
    store.upsert_aux(inst, "taker", [(h * 3_600_000, 60.0, 40.0) for h in hours])
    store.upsert_aux(inst, "lsr", [(h * 3_600_000, 1.5) for h in hours])
    c = store.load(inst, bar)
    assert set(c.x) == {"oi", "tak_buy", "tak_sell", "lsr"}
    # first three 15m bars close before any hourly row is complete
    assert np.isnan(c.x["oi"][0])
    assert c.x["oi"][3] == 1000.0
    assert c.x["tak_buy"][3] == 60.0 and c.x["tak_sell"][3] == 40.0
    assert c.x["lsr"][3] == 1.5
    # slicing keeps aux aligned
    s = c.slice(10, 50)
    assert len(s.x["oi"]) == 40
    assert s.x["oi"][0] == c.x["oi"][10]


# ---------------------------------------------------------------- signals --


def test_oi_mom_confirms_trend():
    """Rising price + rising OI -> long under mode 0; OI collapse during the
    rise -> short (squeeze fade) under mode 1."""
    n = 600
    ts = np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    rng = np.random.default_rng(3)
    # noisy uptrend: the vol-targeting stage needs a realistic realized vol
    px = 100.0 * np.exp(np.linspace(0, 0.5, n) + rng.normal(0, 0.004, n).cumsum() * 0.2)
    c = Candles("T", "15m", ts, px, px, px, px, np.ones(n))
    rising = 1e6 * np.exp(np.linspace(0, 1.0, n)) * np.exp(rng.normal(0, .002, n))
    falling = 1e6 * np.exp(-np.linspace(0, 1.0, n)) * np.exp(rng.normal(0, .002, n))

    g_conf = Genome(signal="oi_mom",
                    params={"lookback": 24, "conf_z": 0.5, "mode": 0},
                    vol_target=0.3, max_lev=1.0)
    pos = compute_position(_with_aux(c, oi=rising), g_conf)
    assert pos[-100:].max() > 0 and pos[-100:].min() >= 0

    g_squeeze = Genome(signal="oi_mom",
                       params={"lookback": 24, "conf_z": 0.5, "mode": 1},
                       vol_target=0.3, max_lev=1.0)
    pos2 = compute_position(_with_aux(c, oi=falling), g_squeeze)
    assert pos2[-100:].min() < 0 and pos2[-100:].max() <= 0


def test_taker_flow_follows_imbalance():
    n = 600
    ts = np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    rng = np.random.default_rng(5)
    px = 100.0 * np.exp(rng.normal(0, 0.004, n).cumsum())
    c = Candles("T", "15m", ts, px, px, px, px, np.ones(n))
    buy = np.full(n, 50.0)
    buy[-50:] = 90.0                                     # sudden buy pressure
    g = Genome(signal="taker_flow",
               params={"lookback": 96, "entry_z": 1.0, "dir": 0},
               vol_target=0.3, max_lev=1.0)
    pos = compute_position(_with_aux(c, buy=buy, sell=100.0 - buy), g)
    assert pos[-10:].min() > 0
    g_fade = Genome(signal="taker_flow",
                    params={"lookback": 96, "entry_z": 1.0, "dir": 1},
                    vol_target=0.3, max_lev=1.0)
    pos2 = compute_position(_with_aux(c, buy=buy, sell=100.0 - buy), g_fade)
    assert pos2[-10:].max() < 0


def test_lsr_fade_leans_against_crowd():
    n = 600
    ts = np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    rng = np.random.default_rng(6)
    px = 100.0 * np.exp(rng.normal(0, 0.004, n).cumsum())
    c = Candles("T", "15m", ts, px, px, px, px, np.ones(n))
    lsr = np.full(n, 1.0)
    lsr[-50:] = 3.0                                      # crowd goes max long
    g = Genome(signal="lsr_fade",
               params={"lookback": 96, "entry_z": 1.0, "dir": 0},
               vol_target=0.3, max_lev=1.0)
    pos = compute_position(_with_aux(c, lsr=lsr), g)
    assert pos[-10:].max() < 0                           # fades the crowd


def test_ttp_follows_smart_money():
    n = 600
    ts = np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    rng = np.random.default_rng(7)
    px = 100.0 * np.exp(rng.normal(0, 0.004, n).cumsum())
    c = Candles("T", "15m", ts, px, px, px, px, np.ones(n))
    ttp = np.full(n, 1.0)
    ttp[-50:] = 2.5                                      # top traders load long
    g = Genome(signal="ttp_follow",
               params={"lookback": 96, "entry_z": 1.0, "dir": 0},
               vol_target=0.3, max_lev=1.0)
    pos = compute_position(_with_aux(c, ttp=ttp), g)
    assert pos[-10:].min() > 0                           # follows the shift


def test_cvd_divergence_fades_unsupported_moves():
    """Price grinds up while cumulative volume delta bleeds: mode 0 shorts
    the divergence; with flow confirming, mode 1 goes long."""
    n = 600
    ts = np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    rng = np.random.default_rng(8)
    px = 100.0 * np.exp(np.linspace(0, 0.4, n) + rng.normal(0, 0.003, n).cumsum() * 0.2)
    c = Candles("T", "15m", ts, px, px, px, px, np.ones(n))
    sell_heavy = _with_aux(c, buy=np.full(n, 40.0) + rng.normal(0, 2, n),
                           sell=np.full(n, 60.0) + rng.normal(0, 2, n))
    g_div = Genome(signal="cvd_div",
                   params={"lookback": 48, "thresh": 0.5, "mode": 0},
                   vol_target=0.3, max_lev=1.0)
    pos = compute_position(sell_heavy, g_div)
    assert pos[-100:].min() < 0 and pos[-100:].max() <= 0

    buy_heavy = _with_aux(c, buy=np.full(n, 60.0) + rng.normal(0, 2, n),
                          sell=np.full(n, 40.0) + rng.normal(0, 2, n))
    g_conf = Genome(signal="cvd_div",
                    params={"lookback": 48, "thresh": 0.5, "mode": 1},
                    vol_target=0.3, max_lev=1.0)
    pos2 = compute_position(buy_heavy, g_conf)
    assert pos2[-100:].max() > 0 and pos2[-100:].min() >= 0


def test_ob_imbalance_follows_book():
    n = 600
    ts = np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    rng = np.random.default_rng(10)
    px = 100.0 * np.exp(rng.normal(0, 0.004, n).cumsum())
    c = Candles("T", "15m", ts, px, px, px, px, np.ones(n))
    ob = np.zeros(n)
    ob[-50:] = 0.6                                       # bids stack up
    c = _with_aux(c)
    c.x["ob_near"] = ob
    c.x["ob_deep"] = ob
    g = Genome(signal="ob_imb",
               params={"lookback": 96, "entry_z": 1.0, "dir": 0},
               vol_target=0.3, max_lev=1.0)
    pos = compute_position(c, g)
    assert pos[-10:].min() > 0


class _FakeBookClient:
    def __init__(self):
        self.calls = 0

    def order_book(self, inst, sz=100):
        self.calls += 1
        return {"ts": str(int(_time.time() * 1000)),
                "bids": [["99.9", "50"], ["99.0", "30"]],
                "asks": [["100.1", "10"], ["101.0", "5"]]}


def test_orderbook_snapshot_records_and_throttles(tmp_path):
    from hermes.data.fetcher import snapshot_orderbook
    store = DataStore(str(tmp_path))
    client = _FakeBookClient()
    snapshot_orderbook(client, store, "BTC-USDT-SWAP")
    snapshot_orderbook(client, store, "BTC-USDT-SWAP")   # within 10min: no-op
    assert client.calls == 1
    _, _, cnt = store.aux_range("BTC-USDT-SWAP", "ob")
    assert cnt == 1
    rows = store.conn.execute(
        "SELECT v1, v2 FROM aux WHERE inst=? AND kind='ob'",
        ("BTC-USDT-SWAP",)).fetchone()
    assert rows[0] > 0                    # bid-heavy book -> positive imbalance
    assert rows[1] > rows[0] * 0.5        # deep imbalance likewise positive


def test_aux_families_zero_without_data():
    candles = generate(bar="15m", n=600, seed=11)        # no x arrays at all
    for sig, params in (
        ("oi_mom", {"lookback": 24, "conf_z": 0.5, "mode": 0}),
        ("taker_flow", {"lookback": 96, "entry_z": 1.0, "dir": 0}),
        ("lsr_fade", {"lookback": 96, "entry_z": 1.0, "dir": 0}),
        ("ttp_follow", {"lookback": 96, "entry_z": 1.0, "dir": 0}),
        ("cvd_div", {"lookback": 48, "thresh": 0.5, "mode": 0}),
        ("ob_imb", {"lookback": 96, "entry_z": 1.0, "dir": 0}),
    ):
        g = Genome(signal=sig, params=params, vol_target=0.3, max_lev=1.0)
        assert not np.any(compute_position(candles, g))


# ------------------------------------------------------------- evolution --


def test_random_genome_family_pools():
    import random as _r
    rng = _r.Random(1)
    drawn = {random_genome(rng).signal for _ in range(200)}
    assert drawn <= set(CORE_SIGNALS)                    # default: no aux
    drawn_aux = {random_genome(rng, tuple(AUX_SIGNALS)).signal
                 for _ in range(100)}
    assert drawn_aux == set(AUX_SIGNALS)


def test_research_one_runs_aux_pass():
    """With covered aux data, the per-instrument research runs the dedicated
    aux-family pass and charges its trials."""
    from hermes.live.trader import AUX_MIN_BARS, _research_one
    c = generate(bar="15m", n=AUX_MIN_BARS + 1200, seed=42)
    _with_aux(c)
    # max_selection_bar is lifted out of the way: this test is about the aux
    # pass running at all, not about whether a 5-day synthetic window is long
    # enough to validate on (it is not — see test_aux_pass_is_skipped_...)
    r = {"is_fraction": 0.7, "embargo_bars": 24, "population": 8,
         "generations": 1, "min_oos_sharpe": 0.5, "min_dsr": 0.05,
         "max_deployed": 3, "seed": 1, "max_selection_bar": 1e9}
    _, _, n_trials, lines = _research_one(c.inst, c, None, r, 5.0, 2.0)
    assert any("aux search" in ln for ln in lines)
    assert n_trials > 8 * 2          # core pass plus a real aux pass

    # without aux coverage the pass is skipped silently
    c2 = generate(bar="15m", n=AUX_MIN_BARS + 1200, seed=43)
    _, _, _, lines2 = _research_one(c2.inst, c2, None, r, 5.0, 2.0)
    assert not any("aux search" in ln for ln in lines2)


def test_incumbent_seeding_preserves_book_continuity():
    """A deployed genome is seeded into the next pass's population: when it
    still validates, it must be rediscovered — never lost to random-search
    luck. (Regression guard for the pass that silently dropped the whole
    2-year-validated book.)"""
    import random as _r

    from hermes.research.evolve import evolve
    from hermes.strategy.genome import Genome

    c = generate(bar="15m", n=4000, seed=21)
    incumbent = Genome(signal="ma_cross", params={"fast": 10, "ratio": 5.0},
                       vol_target=0.3, max_lev=1.0)
    # incumbents are (re)scored and placed ahead of the evolved population,
    # so they always reach the OOS gate — even with mediocre IS fitness
    from hermes.live.trader import _research_one, _with_incumbents_first
    pop, _ = evolve(c, population=16, generations=2, seed=7,
                    seeds=[incumbent])
    pop = _with_incumbents_first(pop, [incumbent], c, 5.0, 2.0, None)
    assert pop[0].genome.gid == incumbent.gid
    r = {"is_fraction": 0.7, "embargo_bars": 24, "population": 8,
         "generations": 1, "min_oos_sharpe": -99.0, "min_dsr": -99.0,
         "max_deployed": 6, "seed": 1}
    _, survivors, _, _ = _research_one(c.inst, c, None, r, 5.0, 2.0,
                                       incumbents=[incumbent])
    assert any(s.genome.gid == incumbent.gid for s in survivors), \
        "with open gates the incumbent must come back deployed"


# ------------------------------------------------------ cross-sectional --


def _universe(n=4000, insts=("A", "B", "C", "D", "E", "F")):
    uni = {}
    for k, name in enumerate(insts):
        c = generate(inst=f"{name}-USDT-SWAP", bar="15m", n=n, seed=100 + k)
        uni[c.inst] = _with_aux(c)
    return uni


def test_xs_taker_prefers_bought_names():
    uni = _universe()
    insts = sorted(uni)
    # plant persistent aggressive buying in one name, selling in another
    nb = len(uni[insts[0]])
    uni[insts[0]].x["tak_buy"] = np.full(nb, 80.0)
    uni[insts[0]].x["tak_sell"] = np.full(nb, 20.0)
    uni[insts[1]].x["tak_buy"] = np.full(nb, 20.0)
    uni[insts[1]].x["tak_sell"] = np.full(nb, 80.0)
    from hermes.strategy.xs import xs_positions
    common, out_insts, pos = xs_positions(uni, {"lookback": 48, "max_w": 0.25},
                                          kind="taker")
    assert pos, "taker book must produce positions"
    assert np.mean(pos[insts[0]][2500:]) > 0             # bought name held long
    assert np.mean(pos[insts[1]][2500:]) < 0             # sold name held short
    # dollar-neutral book
    net = sum(np.asarray(pos[i]) for i in out_insts)
    gross = sum(np.abs(np.asarray(pos[i])) for i in out_insts)
    live = gross > 0.05
    assert np.all(np.abs(net[live]) <= 0.55 * gross[live])


def test_xs_oi_gates_on_open_interest():
    uni = _universe()
    insts = sorted(uni)
    from hermes.strategy.xs import xs_positions
    n = len(uni[insts[0]])
    # same synthetic prices, but OI collapses for one name -> its momentum
    # score is gated to zero, so its positions shrink versus the OI-rising run
    for inst in insts:
        uni[inst].x["oi"] = 1e6 * np.exp(np.linspace(0, 0.5, len(uni[inst])))
    _, _, pos_all = xs_positions(uni, {"lookback": 96, "max_w": 0.25}, kind="oi")
    uni[insts[0]].x["oi"] = 1e6 * np.exp(-np.linspace(0, 0.5, n))
    _, _, pos_gated = xs_positions(uni, {"lookback": 96, "max_w": 0.25}, kind="oi")
    assert pos_all and pos_gated
    a = np.abs(np.asarray(pos_all[insts[0]]))
    b = np.abs(np.asarray(pos_gated[insts[0]]))
    # falling-OI name may still be shorted (relative ranking) but its own
    # momentum score is dead: exposures must differ materially
    assert not np.allclose(a, b)


def test_xs_trim_to_aux_coverage():
    from hermes.research.xs import _trim_to_coverage
    uni = _universe(n=5000)
    insts = sorted(uni)
    # coverage starts late for one instrument: window must trim to it
    late = uni[insts[0]]
    for k in late.x:
        late.x[k][:1500] = np.nan
    trimmed = _trim_to_coverage(uni, "aux", max_selection_bar=1e9)
    assert trimmed is not None
    assert all(len(c) == 3500 for c in trimmed.values())
    # an instrument with no aux at all is dropped
    uni[insts[1]].x = {}
    trimmed2 = _trim_to_coverage(uni, "aux", max_selection_bar=1e9)
    assert trimmed2 is not None and insts[1] not in trimmed2


# ------------------------------------------------------------------ basis --


def test_basis_rev_fades_premium():
    """A perp trading rich to its index gets shorted (dir 0)."""
    n = 600
    ts = np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    rng = np.random.default_rng(9)
    idx = 100.0 * np.exp(rng.normal(0, 0.004, n).cumsum())
    px = idx.copy()
    px[-40:] *= 1.004                                    # sudden 40bp premium
    c = Candles("T", "15m", ts, px, px, px, px, np.ones(n))
    c.x = {"idx": idx}
    g = Genome(signal="basis_rev",
               params={"lookback": 96, "entry_z": 1.0, "dir": 0},
               vol_target=0.3, max_lev=1.0)
    pos = compute_position(c, g)
    assert pos[-10:].max() < 0
    # without index data the family is silent
    c.x = {}
    assert not np.any(compute_position(c, g))


def test_store_attaches_index_series(tmp_path):
    store = DataStore(str(tmp_path))
    inst, bar = "BTC-USDT-SWAP", "15m"
    bar_ms = BAR_MS[bar]
    store.upsert_candles(inst, bar, [(i * bar_ms, 100, 101, 99, 100.0, 1)
                                     for i in range(100)])
    # index rows for a subset of bars only (holes -> NaN)
    store.upsert_candles(inst + "#IDX", bar,
                         [(i * bar_ms, 99, 100, 98, 99.5, 0.0)
                          for i in range(50, 100)])
    c = store.load(inst, bar)
    assert "idx" in c.x
    assert np.isnan(c.x["idx"][49]) and c.x["idx"][50] == 99.5


def test_xs_basis_shorts_rich_names():
    uni = _universe()
    insts = sorted(uni)
    for inst in insts:
        c = uni[inst]
        c.x["idx"] = c.c.copy()                          # fair value baseline
    rich = uni[insts[0]]
    rich.x["idx"] = rich.c / 1.004                       # persistent premium
    cheap = uni[insts[1]]
    cheap.x["idx"] = cheap.c / 0.996                     # persistent discount
    from hermes.strategy.xs import xs_positions
    _, _, pos = xs_positions(uni, {"lookback": 192, "max_w": 0.25},
                             kind="basis")
    assert pos, "basis book must produce positions"
    assert np.mean(pos[insts[0]][2500:]) < 0             # rich name shorted
    assert np.mean(pos[insts[1]][2500:]) > 0             # cheap name long


class _FakeIdxClient:
    def index_candles(self, index_id, bar="15m", limit=100, after=None,
                      history=False):
        assert index_id == "BTC-USDT"
        H = BAR_MS["15m"]
        base = ((int(_time.time() * 1000)) // H) * H
        if not history:
            return [[str(base - i * H), "1", "1", "1", str(100.0 + i), "1"]
                    for i in range(5)]
        aft = int(after)
        if aft > base - 9 * H:
            return [[str(base - (5 + i) * H), "1", "1", "1",
                     str(200.0 + i), "1"] for i in range(5)]
        return []


def test_fetch_index_stores_under_namespace(tmp_path):
    from hermes.data.fetcher import fetch_index
    store = DataStore(str(tmp_path))
    fetch_index(_FakeIdxClient(), store, "BTC-USDT-SWAP", bar="15m",
                days=730, sleep_s=0)
    _, _, n = store.candle_range("BTC-USDT-SWAP#IDX", "15m")
    assert n == 10


# ---------------------------------------------------------------- fetcher --


import time as _time

_H = 3_600_000
_NOW_H = (int(_time.time() * 1000) // _H) * _H


class _FakeClient:
    """Serves one page of dict rows, one page of list rows, then runs dry
    (mimicking OKX's short rubik history)."""

    def _pages(self, end):
        if end is None:                    # page 1: newest 5 hours, dict rows
            return [{"ts": str(_NOW_H - i * _H), "oiCcy": str(100 + i),
                     "oiUsd": "1"} for i in range(5)]
        if int(end) > _NOW_H - 9 * _H:     # page 2: 5 older hours, list rows
            return [[str(_NOW_H - (5 + i) * _H), "x", str(200 + i), "1"]
                    for i in range(5)]
        return []

    def open_interest_history(self, inst, period="1H", limit=100, end=None):
        from hermes.exchange.okx_client import OKXClient
        return OKXClient._stat_rows(self._pages(end),
                                    ("ts", "oiCcy", "oiUsd"), (0, 2, 3))

    def taker_volume_history(self, inst, period="1H", limit=100, end=None):
        return [(_NOW_H, 60.0, 40.0)] if end is None else []

    def long_short_ratio_history(self, inst, period="1H", limit=100, end=None):
        return [(_NOW_H, 1.4)] if end is None else []

    def top_trader_ratio_history(self, inst, period="1H", limit=100, end=None):
        return [(_NOW_H, 0.9)] if end is None else []


def test_fetch_aux_paginates_and_stores(tmp_path):
    from hermes.data.fetcher import fetch_aux
    store = DataStore(str(tmp_path))
    n = fetch_aux(_FakeClient(), store, "BTC-USDT-SWAP", days=730, sleep_s=0)
    assert n == 13
    lo, hi, cnt = store.aux_range("BTC-USDT-SWAP", "oi")
    assert cnt == 10                       # both pages, dict AND list shapes
    assert lo == _NOW_H - 9 * _H and hi == _NOW_H
    _, _, cnt_t = store.aux_range("BTC-USDT-SWAP", "taker")
    _, _, cnt_l = store.aux_range("BTC-USDT-SWAP", "lsr")
    assert cnt_t == 1 and cnt_l == 1


def test_aux_pass_is_skipped_when_the_window_cannot_validate():
    """The exchange serves ~65 days of open interest and taker flow. Scored
    against a few hundred genomes, selection alone reaches an annualised
    Sharpe near 15 on a window that short — so anything clearing the other
    gates there is an overfit by construction. That is where the live book's
    Sharpes of 6.5 to 9.5 came from."""
    from hermes.live.trader import AUX_MIN_BARS, _research_one
    c = generate(bar="15m", n=AUX_MIN_BARS + 1200, seed=42)
    _with_aux(c)
    r = {"is_fraction": 0.7, "embargo_bars": 24, "population": 8,
         "generations": 1, "min_oos_sharpe": 0.5, "min_dsr": 0.5,
         "max_deployed": 3, "seed": 1, "max_selection_bar": 10.0}
    _, survivors, _, lines = _research_one(c.inst, c, None, r, 5.0, 2.0)
    assert any("skipped" in ln and "days of scored history" in ln
               for ln in lines), lines
    assert all("aux" not in s.genome.signal for s in survivors)


def test_xs_short_coverage_window_is_refused():
    from hermes.research.xs import _trim_to_coverage
    uni = _universe(n=5000)
    said = []
    assert _trim_to_coverage(uni, "aux", said.append,
                             max_selection_bar=10.0) is None
    assert any("selection noise" in m for m in said), said


def test_bars_needed_shrinks_as_the_tolerated_bar_rises():
    from hermes.backtest.metrics import bars_for_selection_bar

    need = [bars_for_selection_bar(624, 35040, b) for b in (6.0, 10.0, 20.0)]
    assert need[0] > need[1] > need[2]
    # and grows with the search budget, though far more slowly
    assert (bars_for_selection_bar(83793, 35040, 10.0)
            > bars_for_selection_bar(100, 35040, 10.0))
