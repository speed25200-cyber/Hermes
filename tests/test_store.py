import numpy as np

from hermes.data.store import DataStore, map_funding_to_bars


def test_candle_roundtrip(tmp_path):
    store = DataStore(str(tmp_path))
    rows = [(1000 + i * 3_600_000, 1.0, 2.0, 0.5, 1.5, 10.0) for i in range(100)]
    store.upsert_candles("X", "1H", rows)
    store.upsert_candles("X", "1H", rows[:10])  # idempotent upsert
    candles = store.load("X", "1H", with_funding=False)
    assert len(candles) == 100
    assert list(candles.ts[:3]) == [1000, 3601000, 7201000]
    lo, hi, n = store.candle_range("X", "1H")
    assert n == 100 and lo == 1000


def test_funding_mapping(tmp_path):
    bar_ts = np.array([0, 100, 200, 300], dtype=np.int64)
    out = map_funding_to_bars(bar_ts, [(150, 0.001), (300, 0.002), (999, 0.5)])
    assert out[2] == 0.001   # 150 -> first bar at/after = 200
    assert out[3] == 0.002
    assert out.sum() == 0.003  # payment beyond range dropped


def test_coverage_report_shows_recorded_order_book(tmp_path, capsys):
    """The order-book series is self-recorded and cannot be re-fetched, so the
    coverage report must make its accumulation (or its absence) visible."""
    import types

    from hermes.cli import cmd_coverage
    from hermes.config import Config

    store = DataStore(str(tmp_path))
    day = 86_400_000
    store.upsert_candles("BTC-USDT-SWAP", "15m",
                         [(i * 900_000, 1.0, 1.0, 1.0, 1.0, 1.0)
                          for i in range(200)])
    store.upsert_aux("BTC-USDT-SWAP", "ob",
                     [(i * 900_000, 0.1, 0.2) for i in range(40 * 96)])

    cfg = Config.load(None)
    cfg.raw["instruments"] = ["BTC-USDT-SWAP"]
    cfg.raw["bar"] = "15m"
    cfg.raw["data_dir"] = str(tmp_path)
    monkey = types.SimpleNamespace(config=None)
    original = Config.load
    try:
        Config.load = staticmethod(lambda *_a, **_k: cfg)
        cmd_coverage(monkey)
    finally:
        Config.load = original

    out = capsys.readouterr().out
    assert "ob" in out and "rows" in out
    assert "enough to be searched" in out          # 40 days recorded > 30


def test_order_book_backup_roundtrip(tmp_path):
    """The recorded order book is the only irreplaceable series, so an export
    must restore exactly — and must not clobber newer snapshots."""
    import types

    from hermes.cli import cmd_backup
    from hermes.config import Config

    src, dst = tmp_path / "src", tmp_path / "dst"
    store = DataStore(str(src))
    rows = [(i * 600_000, 0.1 * i, 0.2 * i) for i in range(50)]
    store.upsert_aux("BTC-USDT-SWAP", "ob", rows)

    out = str(tmp_path / "backup.jsonl")
    cfg = Config.load(None)
    cfg.raw["instruments"] = ["BTC-USDT-SWAP"]
    original = Config.load
    try:
        Config.load = staticmethod(lambda *_a, **_k: cfg)
        cfg.raw["data_dir"] = str(src)
        cmd_backup(types.SimpleNamespace(config=None, out=out, restore=None,
                                         order_book_only=False))
        # a newer snapshot exists on the target that the export predates
        target = DataStore(str(dst))
        target.upsert_aux("BTC-USDT-SWAP", "ob", [(99 * 600_000, 9.0, 9.0)])
        cfg.raw["data_dir"] = str(dst)
        cmd_backup(types.SimpleNamespace(config=None, out=None, restore=out,
                                         order_book_only=False))
    finally:
        Config.load = original

    restored = DataStore(str(dst)).read_aux("BTC-USDT-SWAP", "ob")
    assert restored[:50] == rows                     # exact roundtrip
    assert restored[-1] == (99 * 600_000, 9.0, 9.0)  # newer row survived
