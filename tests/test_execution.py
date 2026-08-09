"""Maker-first smart execution: cost model + broker order logic (mock client)."""

import pytest

from hermes.config import effective_costs
from hermes.exchange.broker import OKXBroker


def test_effective_costs_maker_blend():
    costs = {"taker_fee_bps": 5.0, "maker_fee_bps": 2.0, "slippage_bps": 2.0,
             "prefer_maker": True, "maker_miss_rate": 0.3}
    fee, slip = effective_costs(costs)
    assert fee == pytest.approx(0.7 * 2.0 + 0.3 * 5.0)
    assert slip == pytest.approx(0.3 * 2.0)
    costs["prefer_maker"] = False
    assert effective_costs(costs) == (5.0, 2.0)


class FakeClient:
    """Scriptable OKX client covering the smart-order paths."""

    def __init__(self, fill_after_polls=1, final_state="filled", acc="10"):
        self.fill_after_polls = fill_after_polls
        self.final_state = final_state
        self.acc = acc
        self.polls = 0
        self.orders = []
        self.cancels = []

    def instruments(self, t):
        return [{"instId": "X-USDT-SWAP", "ctVal": "0.1", "lotSz": "1",
                 "minSz": "1"}]

    def ticker(self, inst):
        return {"bidPx": "100.0", "askPx": "100.1"}

    def positions(self, t="SWAP"):
        return []

    def place_order(self, inst, side, sz, ord_type, px=None, td_mode="cross",
                    reduce_only=False, cl_ord_id=None):
        self.orders.append((ord_type, side, sz, px))
        return {"ordId": f"o{len(self.orders)}"}

    def market_order(self, inst, side, sz, td_mode="cross", reduce_only=False,
                     cl_ord_id=None):
        self.orders.append(("market", side, sz, None))
        return {"ordId": f"o{len(self.orders)}"}

    def order_status(self, inst, ord_id):
        self.polls += 1
        if self.polls >= self.fill_after_polls:
            return {"state": self.final_state, "accFillSz": self.acc}
        return {"state": "live", "accFillSz": "0"}

    def cancel_order(self, inst, ord_id):
        self.cancels.append(ord_id)
        return {}


def make_broker(client, wait=0.2):
    return OKXBroker(client, prefer_maker=True, maker_wait_s=wait,
                     sleep_fn=lambda s: None)


def test_maker_full_fill_no_taker():
    c = FakeClient(fill_after_polls=1, final_state="filled", acc="10")
    b = make_broker(c)
    fill = b.market_order("X-USDT-SWAP", 1.0, 100.0)  # 1.0 coin / 0.1 ctVal = 10 contracts
    assert fill is not None and fill.qty == pytest.approx(1.0)
    types = [o[0] for o in c.orders]
    assert types == ["post_only"]           # no taker order sent


def test_maker_timeout_falls_back_to_taker():
    c = FakeClient(fill_after_polls=999, final_state="live", acc="0")
    b = make_broker(c)
    fill = b.market_order("X-USDT-SWAP", 1.0, 100.0)
    types = [o[0] for o in c.orders]
    assert types == ["post_only", "market"]
    assert c.cancels                        # resting order was cancelled
    assert fill.qty == pytest.approx(1.0)


def test_maker_partial_fill_takes_remainder():
    class PartialClient(FakeClient):
        def order_status(self, inst, ord_id):
            self.polls += 1
            return {"state": "live", "accFillSz": "4"}
    c = PartialClient()
    b = make_broker(c)
    fill = b.market_order("X-USDT-SWAP", 1.0, 100.0)
    # 4 contracts maker + 6 taker = 10 contracts = 1.0 coin
    taker = [o for o in c.orders if o[0] == "market"]
    assert taker and taker[0][2] == "6"
    assert fill.qty == pytest.approx(1.0)


def test_prefer_maker_off_goes_straight_taker():
    c = FakeClient()
    b = OKXBroker(c, prefer_maker=False, sleep_fn=lambda s: None)
    b.market_order("X-USDT-SWAP", 1.0, 100.0)
    assert [o[0] for o in c.orders] == ["market"]
