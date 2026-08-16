"""Configuration loading.

Secrets (API keys) come exclusively from environment variables so they are
never written to disk or committed:

    OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE
    OKX_SIMULATED=1  -> use OKX demo-trading mode (x-simulated-trading header)

Everything else lives in a JSON config file (see config.example.json).
"""

from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass, field
from typing import Any

DEFAULTS: dict[str, Any] = {
    # a wide liquid universe gives the research more independent chances to
    # find a real edge (funding carry and BTC lead-lag are alt-heavy);
    # instruments[0] is the cross-asset leader
    "instruments": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP",
                    "XRP-USDT-SWAP", "DOGE-USDT-SWAP", "BNB-USDT-SWAP",
                    "AVAX-USDT-SWAP", "LINK-USDT-SWAP", "ADA-USDT-SWAP",
                    "LTC-USDT-SWAP", "DOT-USDT-SWAP", "BCH-USDT-SWAP",
                    "NEAR-USDT-SWAP", "SUI-USDT-SWAP", "APT-USDT-SWAP",
                    "TRX-USDT-SWAP", "UNI-USDT-SWAP", "ATOM-USDT-SWAP",
                    "FIL-USDT-SWAP", "ETC-USDT-SWAP", "XLM-USDT-SWAP",
                    "ARB-USDT-SWAP", "OP-USDT-SWAP", "INJ-USDT-SWAP",
                    "TIA-USDT-SWAP", "SEI-USDT-SWAP", "CRV-USDT-SWAP",
                    "AAVE-USDT-SWAP", "PEPE-USDT-SWAP", "SHIB-USDT-SWAP"],
    # The list above is the fallback; this many of the venue's most-traded
    # USDT perpetuals replace it, refreshed on every fetch. More independent
    # names lift the combined Sharpe as sqrt(N) while fees stay per-trade, so
    # breadth is the one lever that costs nothing per trade. Set 0 to pin the
    # list. The book stays bounded by research.max_deployed_total, without
    # which twice the candidates would starve every strategy of capital.
    "universe_size": 60,
    "universe_min_vol_usdt": 5e6,   # 24h traded value floor for a candidate
    # 15m bars: ~35k bars/year per instrument -> 4x the statistical power of
    # 1H for the validation gates, and intraday seasonality becomes usable
    "bar": "15m",
    "data_dir": "data",
    "state_dir": "state",
    # two years of 15m bars (~70k/instrument) doubles the statistical power
    # of every validation gate; newer listings contribute what they have
    "history_days": 730,
    "research": {
        # Search budget sets the bar the survivor must then clear, so more
        # search is not more power. Measured on a 21,000-bar scored window,
        # the annualised Sharpe that selection alone reaches:
        #
        #      26 rules (the panel grid)   2.60
        #     100 trials                   3.27
        #     600 trials (this budget)     4.03
        #   2,400 trials (the old one)     4.52
        #  10,000 trials                   4.99
        #
        # A per-instrument edge in these families runs Sharpe 1 to 2, so no
        # budget makes single-name research likely to produce a survivor —
        # but the old one spent 2.5 hours per pass raising its own bar by
        # half a Sharpe point to do it. Cutting to a quarter costs whatever
        # a four-times-larger hunt would have found beyond it, and buys back
        # the bar and the hours. Breadth carries the search now: the panel
        # asks one question of the whole universe at a bar of 2.60.
        "population": 48,
        "generations": 12,
        "seed": None,
        "is_fraction": 0.7,          # fraction of history used in-sample
        "embargo_bars": 24,          # gap between IS and OOS to avoid leakage
        "min_oos_sharpe": 0.5,       # OOS annualised Sharpe required to deploy
        # The DSR is a confidence level, not a score: the probability that a
        # strategy's Sharpe beats what picking the best of the whole search
        # would produce on noise alone. This gate stood at 0.05 — it admitted
        # anything 95% likely to be the luckiest draw, and the live book
        # showed it: all 18 deployed strategies sat between 0.050 and 0.175,
        # every one of them scoring BELOW its own selection bar.
        #
        # 0.95 is the textbook figure, and it is unreachable on samples this
        # short: a deliberately planted cross-sectional trend, OOS Sharpe
        # 6.90, scores 0.701. A gate there would reject edges that are real
        # by construction. 0.5 is the line with a meaning worth holding —
        # the strategy's true Sharpe more likely than not exceeds what the
        # search alone would have produced — and it separates the two cases
        # measured here by a wide margin.
        "min_dsr": 0.5,

        "max_deployed": 6,           # max strategies live at once PER instrument
        # ...and across the whole book. Capital is shared over everything
        # deployed, so an unbounded book starves each strategy below the
        # rebalance band and nothing reaches the market. Measured on the live
        # allocator: 18 strategies put a typical signal at 454 USDT of a
        # 9,955 USDT book, 60 put it at 136 — under the 199 USDT band.
        "max_deployed_total": 24,
        # A parameter grid returns whole neighbourhoods of the same optimum,
        # so two "different" genomes routinely trade the identical series.
        # A survivor whose OOS returns correlate above this with one already
        # accepted for the instrument is a second copy of that bet, not a
        # second bet: it is refused the slot.
        "max_corr": 0.9,
        # Selection over a search this size produces a Sharpe on noise alone
        # that shrinks as the scored window lengthens. Above this bar, no
        # strategy that exists can clear it, so the search can only mint
        # overfits — the aux families were being searched on a 65-day window
        # where the bar sits near 15, which is where the live book's Sharpes
        # of 6.5 to 9.5 came from. 10 is deliberately generous: a sustained
        # out-of-sample Sharpe of 10 is already beyond anything credible.
        "max_selection_bar": 10.0,
        "refresh_hours": 168,        # re-run research weekly
        "refresh_hours_empty": 24,   # ...but daily while nothing is deployed:
                                     # the hunt escalates instead of sleeping
        "retire_after_bars": 1000,   # live bars before retirement can trigger
        "retire_sharpe": -0.5,       # retire when live Sharpe falls below
    },
    "costs": {
        "taker_fee_bps": 5.0,        # OKX swap taker ~0.05%
        "maker_fee_bps": 2.0,        # OKX swap maker ~0.02%
        "slippage_bps": 2.0,         # paid on taker fills only
        "prefer_maker": True,        # post-only limit first, market fallback
        "maker_miss_rate": 0.30,     # fraction of maker attempts that fall
                                     # back to taker (modelled in backtests)
    },
    "risk": {
        "portfolio_vol_target": 0.20,   # annualised
        "max_gross_leverage": 2.0,
        "max_instrument_leverage": 1.0,
        "daily_loss_limit_pct": 3.0,    # halt for the day
        "max_drawdown_pct": 15.0,       # kill switch: flatten + halt
        "min_trade_notional": 10.0,     # USDT
        "max_order_notional": 25000.0,  # sanity cap per order
        # leverage governor: autonomous risk-on/risk-off throttle. Exposure
        # above 1x must be EARNED by live results (rolling Sharpe >= 1 with
        # tiny drawdown, ramped slowly); drawdown de-risks fast and always
        # wins. Hard caps above still bound everything.
        "governor": {"enabled": True, "max_boost": 1.5},
    },
    "allocator": {
        "ewma_halflife_bars": 168,
        "eta": 2.0,
        "max_weight": 0.5,
    },
    "live": {
        "mode": "paper",             # "paper" | "live"
        "poll_seconds": 20,
        "td_mode": "cross",
        "paper_equity": 10000.0,
        "maker_wait_s": 20,          # post-only resting time before fallback
    },
}


def effective_costs(costs: dict[str, Any]) -> tuple[float, float]:
    """(fee_bps, slip_bps) equivalent used by every backtest, modelling
    post-only maker execution with a taker fallback on misses. With maker
    preference off, this is plain taker + slippage."""
    taker = float(costs["taker_fee_bps"])
    slip = float(costs["slippage_bps"])
    if not costs.get("prefer_maker", False):
        return taker, slip
    miss = float(costs.get("maker_miss_rate", 0.3))
    maker = float(costs.get("maker_fee_bps", 2.0))
    return (1.0 - miss) * maker + miss * taker, miss * slip


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


@dataclass
class Credentials:
    api_key: str = ""
    api_secret: str = ""
    passphrase: str = ""
    simulated: bool = False

    @property
    def present(self) -> bool:
        return bool(self.api_key and self.api_secret and self.passphrase)

    @classmethod
    def from_env(cls) -> "Credentials":
        return cls(
            api_key=os.environ.get("OKX_API_KEY", ""),
            api_secret=os.environ.get("OKX_API_SECRET", ""),
            passphrase=os.environ.get("OKX_API_PASSPHRASE", ""),
            simulated=os.environ.get("OKX_SIMULATED", "0") == "1",
        )


@dataclass
class Config:
    raw: dict[str, Any] = field(default_factory=lambda: copy.deepcopy(DEFAULTS))
    path: str | None = None

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)

    @property
    def credentials(self) -> Credentials:
        return Credentials.from_env()

    @classmethod
    def load(cls, path: str | None = None) -> "Config":
        raw = copy.deepcopy(DEFAULTS)
        used = None
        candidates = [path] if path else ["config.json", "config.local.json"]
        for cand in candidates:
            if cand and os.path.exists(cand):
                with open(cand) as f:
                    raw = _merge(raw, json.load(f))
                used = cand
                break
        # When the universe is venue-resolved, every entry point — research,
        # the live loop, status, the dashboard — must see the same list as the
        # fetch that resolved it. Reading it here is the only way they cannot
        # disagree.
        if int(raw.get("universe_size", 0) or 0) > 0:
            from .data.universe import load_persisted, order
            persisted = load_persisted(raw["state_dir"])
            if persisted:
                leader = raw["instruments"][0] if raw["instruments"] else ""
                raw["instruments"] = order(persisted, leader)
        return cls(raw=raw, path=used)
