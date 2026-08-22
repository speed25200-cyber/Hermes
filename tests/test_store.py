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


def test_funding_mapping():
    bar_ts = np.array([0, 100, 200, 300], dtype=np.int64)
    out = map_funding_to_bars(bar_ts, [(150, 0.001), (300, 0.002), (999, 0.5)])
    assert out[2] == 0.001   # 150 -> first bar at/after = 200
    assert out[3] == 0.002
    assert out.sum() == 0.003  # payment beyond range dropped


def test_microstructure_mapping(tmp_path):
    store = DataStore(str(tmp_path))
    rows = [(1000 + i * 900_000, 1.0, 2.0, 0.5, 1.0 + i, 10.0) for i in range(5)]
    store.upsert_candles("X", "15m", rows)
    store.upsert_oi("X", [(1000, 10.0), (2800, 20.0)])
    store.upsert_flow("X", [(1000, 4.0, 1.0)])
    store.upsert_px("mark_px", "X", "15m", [(1000, 1.01)])
    store.upsert_px("index_px", "X", "15m", [(1000, 1.00)])
    c = store.load("X", "15m")
    assert c.oi[0] == 10.0
    assert c.oi[2] == 20.0          # last-known as of bar close
    assert abs(c.taker_imb[0] - 0.6) < 1e-9
    assert abs(c.basis[0] - 0.01) < 1e-9
