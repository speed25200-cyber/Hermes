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
                    "XRP-USDT-SWAP", "BNB-USDT-SWAP", "DOGE-USDT-SWAP",
                    "AVAX-USDT-SWAP", "LINK-USDT-SWAP", "ADA-USDT-SWAP",
                    "LTC-USDT-SWAP", "DOT-USDT-SWAP", "BCH-USDT-SWAP",
                    "UNI-USDT-SWAP", "ATOM-USDT-SWAP"],
    # 15m bars: ~35k bars/year per instrument -> 4x the statistical power of
    # 1H for the validation gates, and intraday seasonality becomes usable
    "bar": "15m",
    "data_dir": "data",
    "state_dir": "state",
    # two years of 15m bars (~70k/instrument) doubles the statistical power
    # of every validation gate; newer listings contribute what they have
    "history_days": 730,
    "research": {
        "population": 64,
        "generations": 18,
        "seed": None,
        "is_fraction": 0.7,          # fraction of history used in-sample
        "embargo_bars": 192,         # 2 days of 15m — must exceed max ML horizon (48)
        "min_oos_sharpe": 0.5,       # OOS annualised Sharpe required to deploy
        "min_dsr": 0.05,             # deflated Sharpe probability threshold
        "max_deployed": 4,           # max strategies live at once
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
        "max_gross_leverage": 20.0,
        "max_instrument_leverage": 20.0,
        "daily_loss_limit_pct": 8.0,    # ~2–3 SL at 20x then sit out the UTC day
        "max_drawdown_pct": 25.0,       # kill: ~8 SL or one ~1.2% unstopped wick
        "min_trade_notional": 10.0,     # USDT
        "max_order_notional": 250000.0, # 20x on $10k book + headroom
        # leverage governor: autonomous risk-on/risk-off throttle. Exposure
        # above 1x must be EARNED by live results (rolling Sharpe >= 1 with
        # tiny drawdown, ramped slowly); drawdown de-risks fast and always
        # wins. Hard caps above still bound everything.
        "governor": {"enabled": True, "max_boost": 1.5},
    },
    "allocator": {
        "ewma_halflife_bars": 672,   # ~7 days of 15m; 24 bars is too short for corr
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
    # 1-minute order-flow scalp: live directional loop. NOT a candle-color
    # oracle — fade bounce + book imbalance, trade only if edge > costs.
    "scalp": {
        "enabled": True,
        "bar": "15m",
        # Le même panel que les horloges : une horloge validée parle pour
        # les six au même instant, et c'est exactement le portefeuille sur
        # lequel elle a été jugée.
        "instruments": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP",
                        "XRP-USDT-SWAP", "DOGE-USDT-SWAP", "BNB-USDT-SWAP"],
        # Les vingt perpétuels USDT les plus échangés d OKX, choisis par
        # VOLUME reel a chaque rafraichissement — pas une liste ecrite en
        # dur. Chaque jambe de plus moyenne une variance idiosyncratique de
        # plus dans le rendement de portefeuille que la porte juge.
        "universe_n": 20,
        "trade_top": 20,
        "require_l2": False,
        "max_spread_bps": 6.0,
        "min_vol_usd": 10_000_000.0,
        "stop_bps": 25.0,
        "take_bps": 18.0,
        "horizon": 8,
        "min_edge_bps": 6.0,
        "max_hold_bars": 16,
        "max_name_lev": 20.0,
        "gross_cap": 20.0,
        "poll_seconds": 5,
        "history_days": 60,
        "maker_wait_s": 8,
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
        return cls(raw=raw, path=used)
