import numpy as np
import pytest

pytest.importorskip("backtesting", reason="bundled real data needs 'backtesting'")

from hermes.data.real import load_bundled


def test_bundled_real_candles_are_sane():
    datasets = load_bundled()
    names = {c.inst for c in datasets}
    assert names == {"EURUSD-REAL", "GOOG-REAL"}
    for c in datasets:
        assert len(c) >= 2000
        assert np.all(np.diff(c.ts) > 0)          # strictly increasing time
        assert np.all(c.c > 0) and np.all(c.h >= c.l)
        assert np.all(c.h >= c.c - 1e-9) and np.all(c.l <= c.c + 1e-9)
        assert np.all(c.funding == 0)             # no funding for FX/equity


def test_real_candles_flow_through_backtester():
    from hermes.backtest import engine
    candles = load_bundled()[0]
    res = engine.run(candles, np.ones(len(candles)), fee_bps=0, slippage_bps=0)
    # buy & hold equity must equal the price ratio
    expected = candles.c[-1] / candles.c[0]
    assert res.equity[-1] == pytest.approx(expected, rel=1e-9)
