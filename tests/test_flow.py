"""Delayed labels: y is the mid 90s later, never the same poll."""
import time
import numpy as np
from hermes.scalp.flow import HORIZON_S, FlowBrain


def test_does_not_label_same_poll(tmp_path):
    b = FlowBrain(str(tmp_path), log=lambda m: None)
    x = np.zeros(10)
    b.push("BTC-USDT-SWAP", x, 100.0)
    n = b.settle({"BTC-USDT-SWAP": 101.0})
    assert n == 0
    assert b.pending


def test_labels_after_horizon(tmp_path):
    b = FlowBrain(str(tmp_path), log=lambda m: None)
    x = np.zeros(10)
    b.push("BTC-USDT-SWAP", x, 100.0)
    b.pending[0]["t"] = time.time() - HORIZON_S - 1
    n = b.settle({"BTC-USDT-SWAP": 100.2})
    assert n == 1
    assert abs(b.y[0] - 20.0) < 1e-6  # +20 bps


def test_prior_waits_without_l2(tmp_path):
    b = FlowBrain(str(tmp_path), log=lambda m: None)
    x = np.zeros(10)
    inf = b.infer(x, {"imb": 0.1, "micro": 0.0, "spread_bps": 5.0, "l2": 0.0, "ofi": 0.0})
    assert inf["veto"] is True
