"""New-listing short sleeve: calendar, entries and exits, sizing, stops, and its netting with the book."""

import asyncio

import numpy as np
import pandas as pd
import pytest

from hermes.config import ListingSleeveConfig
from hermes.live.listing_sleeve import HEDGE, ListingSleeve
from hermes.live.state import StateStore

NOW = pd.Timestamp("2026-09-25 12:00", tz="UTC")


class Cal:
    """Binance calendar stub: perpetual launches and first spot candles."""

    def __init__(self, launches, spot):
        self.launches, self.spot, self.calls = launches, spot, 0

    async def perp_listings(self):
        self.calls += 1
        return {s: int(t.value // 1_000_000) for s, t in self.launches.items()}

    async def spot_first_open(self, symbol):
        return self.spot.get(symbol)


def _sleeve(tmp_path, **kw):
    return ListingSleeve(ListingSleeveConfig(enabled=True, **kw), StateStore(tmp_path / "s"))


def test_calendar_keeps_new_tokens_in_their_window(tmp_path):
    cal = Cal(
        {
            "NEWUSDT": NOW - pd.Timedelta(hours=80),  # in the window, no spot market: new token
            "SPOTNEWUSDT": NOW - pd.Timedelta(hours=100),  # spot opened 10 days before the perp: new token
            "OLDTOKUSDT": NOW - pd.Timedelta(hours=90),  # spot for a year: not a new token
            "EARLYUSDT": NOW - pd.Timedelta(hours=20),  # not yet 72 h old
            "STALEUSDT": NOW - pd.Timedelta(days=30),  # window long gone
        },
        {
            "SPOTNEWUSDT": NOW - pd.Timedelta(days=14),
            "OLDTOKUSDT": NOW - pd.Timedelta(days=400),
        },
    )
    sl = _sleeve(tmp_path)
    asyncio.run(sl.refresh(cal, NOW))
    assert sl.due(NOW) == [("NEWUSDT", 0), ("NEWUSDT", 1), ("SPOTNEWUSDT", 0), ("SPOTNEWUSDT", 1)]
    assert "STALEUSDT" not in sl.listings
    asyncio.run(sl.refresh(cal, NOW + pd.Timedelta(hours=1)))
    assert cal.calls == 1  # cached for six hours
    assert sl.due(NOW + pd.Timedelta(hours=10)) == [  # EARLY's first tranche (+24 h) is due, not its second
        ("EARLYUSDT", 0),
        ("NEWUSDT", 0),
        ("NEWUSDT", 1),
        ("SPOTNEWUSDT", 0),
        ("SPOTNEWUSDT", 1),
    ]
    assert sl.due(NOW + pd.Timedelta(hours=90)) == [("EARLYUSDT", 0), ("EARLYUSDT", 1)]  # the others have closed
    assert sl.symbols_needed(NOW) == sorted(["NEWUSDT", "SPOTNEWUSDT", HEDGE])


def test_entry_sizing_hedge_stop_exit_and_persistence(tmp_path):
    sl = _sleeve(tmp_path, slots=5, leverage=1.0, stop=0.5, hedge_beta=1.0)
    t0 = NOW - pd.Timedelta(hours=73)
    sl.listings = {
        "AUSDT": {"launch": t0.isoformat(), "new_token": True},
        "BUSDT": {"launch": t0.isoformat(), "new_token": True},
        "CUSDT": {"launch": t0.isoformat(), "new_token": True},
    }
    prices = {"AUSDT": 2.0, "BUSDT": 10.0, "CUSDT": 1.0, HEDGE: 100_000.0}
    vol = {"AUSDT": 0.062, "BUSDT": 0.5}  # A: half the reference vol -> full size; B: 4x -> the 0.25 floor
    tg = sl.targets(NOW, prices, nav=10_000.0, tradable={"AUSDT", "BUSDT"}, vol_daily=vol)
    # Two tranches each (+24 h and +72 h are both past). C is not tradable (not on OKX): skipped.
    # A: 10k x 1 / 5 x 1.0, split in two; B: x 0.124/0.5 = 0.248 -> clipped at 0.25.
    assert tg["AUSDT"] == pytest.approx(-2_000.0)
    assert tg["BUSDT"] == pytest.approx(-500.0)
    assert tg[HEDGE] == pytest.approx(2_500.0)  # one BTC long per unit of short
    assert "CUSDT" not in tg
    assert sl.stop_fractions(prices) == pytest.approx({"AUSDT": 0.5, "BUSDT": 0.5})  # one stop per contract
    assert [(t.symbol, t.tranche) for t in sl.open] == [("AUSDT", 0), ("AUSDT", 1), ("BUSDT", 0), ("BUSDT", 1)]
    assert sl.coverage == {"AUSDT": True, "BUSDT": True, "CUSDT": False}
    # Quantities stay fixed: the target notional follows the price.
    moved = dict(prices, AUSDT=1.0)
    assert sl.holdings(moved)["AUSDT"] == pytest.approx(-1_000.0)
    # A restart reloads the same trades.
    again = ListingSleeve(sl.cfg, sl.store)
    assert [t.symbol for t in again.open] == ["AUSDT", "AUSDT", "BUSDT", "BUSDT"]
    # Exit at launch + 7 days; a stopped contract closes every tranche at the fill, never re-entered.
    again.on_stops({"BUSDT": 15.0}, prices, NOW + pd.Timedelta(hours=1))
    assert {t.symbol for t in again.open} == {"AUSDT"}
    assert not [p for p in again.due(NOW + pd.Timedelta(hours=2)) if p[0] == "BUSDT"]
    assert [d["pnl"] for d in again.done] == pytest.approx([-25.0 * 5.0, -25.0 * 5.0])
    later = t0 + pd.Timedelta(hours=168)
    assert again.targets(later, moved, 10_000.0, {"AUSDT"}, {}) == {}
    s = again.summary(moved)
    assert s["closed_pnl"] == pytest.approx(-250.0 + 1_000.0) and not s["open"]


def test_short_notional_cap_and_slots(tmp_path):
    sl = _sleeve(tmp_path, slots=2, leverage=0.5)
    t0 = NOW - pd.Timedelta(hours=80)
    sl.listings = {s: {"launch": t0.isoformat(), "new_token": True} for s in ("AUSDT", "BUSDT", "CUSDT")}
    prices = {"AUSDT": 1.0, "BUSDT": 1.0, "CUSDT": 1.0, HEDGE: 50_000.0}
    tg = sl.targets(NOW, prices, 1_000.0, {"AUSDT", "BUSDT", "CUSDT"}, {}, entries=True)
    # Unknown vol -> scale 0.5: 1000 x 0.5 / 2 x 0.5 = 125 each; two slots only.
    assert sorted(tg) == sorted(["AUSDT", "BUSDT", HEDGE]) and tg["AUSDT"] == pytest.approx(-125.0)
    assert sl.targets(NOW, prices, 1_000.0, {"CUSDT"}, {}, entries=False).get("CUSDT") is None


def test_reconcile_forgets_trades_the_account_does_not_hold(tmp_path):
    sl = _sleeve(tmp_path)
    t0 = NOW - pd.Timedelta(hours=80)
    sl.listings = {"AUSDT": {"launch": t0.isoformat(), "new_token": True}}
    prices = {"AUSDT": 1.0, HEDGE: 50_000.0}
    sl.targets(NOW, prices, 1_000.0, {"AUSDT"}, {})
    sl.reconcile({"AUSDT": -100.0}, prices, NOW)
    assert len(sl.open) == 2  # both tranches
    sl.reconcile({}, prices, NOW)  # flattened by a halt, for instance
    assert not sl.open and sl.done[-1]["reason"] == "gone"


def test_kill_rule_stops_new_entries(tmp_path):
    """Fixed in advance: the last 25 closed trades losing on average (or > 10 % of the sleeve's cap) end entries."""
    sl = _sleeve(tmp_path, kill_trades=3, kill_loss=0.10, leverage=1.0)
    win = {"symbol": "W", "tranche": 0, "notional": 100.0, "pnl": 10.0, "nav": 1_000.0, "reason": "end"}
    lose = dict(win, pnl=-20.0)
    sl.done = [win, win, dict(lose, pnl=-15.0)]  # mean return > 0, small loss: keeps trading
    assert not sl.suspended()
    sl.done = [win, lose, lose]  # mean return < 0
    assert sl.suspended()
    big = dict(win, notional=1_000.0, pnl=-150.0)  # mean return > 0 but -110 USDT of a 1000 cap (> 10 %)
    sl.done = [big, dict(win, pnl=30.0), dict(win, pnl=10.0)]
    assert sl.suspended()
    t0 = NOW - pd.Timedelta(hours=80)
    sl.listings = {"AUSDT": {"launch": t0.isoformat(), "new_token": True}}
    assert sl.targets(NOW, {"AUSDT": 1.0, HEDGE: 50_000.0}, 1_000.0, {"AUSDT"}, {}) == {}


@pytest.mark.slow
def test_engine_nets_the_sleeve_with_the_book(cfg_small, tmp_path):
    """The book is decided on the account net of the sleeve; the broker ends with book + sleeve per contract."""
    from hermes.live.engine import LiveEngine
    from test_live import FakeFeed, _engine

    panel, bundle, broker, store, cfg = _engine(cfg_small, tmp_path)
    cfg = cfg.model_copy(
        update={"live": cfg.live.model_copy(update={"listing_sleeve": ListingSleeveConfig(enabled=True)})}
    )

    class Feed(FakeFeed):
        async def perp_listings(self):
            last = self.panel.index[self.t - 1]
            return {"S11USDT": int((last - pd.Timedelta(hours=80)).value // 1_000_000)}

        async def spot_first_open(self, symbol):
            return None

    feed = Feed(panel, 96 * 45 + 40, 96 * 30)
    eng = LiveEngine(cfg, bundle, feed, broker, store, mode="paper")
    d = asyncio.run(eng.step())
    assert d is not None and eng.sleeve is not None
    assert [t.symbol for t in eng.sleeve.open] == ["S11USDT", "S11USDT"]  # +24 h and +72 h tranches
    prices = {s: float(v) for s, v in feed.panel["close"].iloc[feed.t - 1].dropna().items()}
    held = eng.sleeve.holdings(prices)
    pos = {s: p.notional for s, p in asyncio.run(broker.positions()).items()}
    for s in ("S11USDT", HEDGE):
        assert pos.get(s, 0.0) == pytest.approx(d.targets.get(s, 0.0) + held[s], rel=0.02, abs=5.0)
    assert np.isclose(held["S11USDT"], -held[HEDGE], rtol=1e-6)
    import json

    status = json.loads((tmp_path / "state" / "status.json").read_text())
    assert status["listing_sleeve"]["open"][0]["symbol"] == "S11USDT"
