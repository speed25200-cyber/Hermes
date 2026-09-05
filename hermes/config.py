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
    # 1H bars: the horizon where documented crypto premia (carry, multi-day
    # momentum, short-term reversal, vol-managed trend) live, and where
    # maker-first execution costs stay small relative to the edge. Faster
    # bars quadruple the sample but the extra observations are bid-ask
    # bounce, not signal — and costs eat them alive.
    "bar": "1H",
    # dynamic universe: the configured names plus the top-n liquid USDT
    # perpetuals by 24h quote volume, re-resolved at every research pass.
    # Back-tests only let a name into the book while it was among the
    # `top_n` most-traded names of its own day (trailing quote volume) —
    # survivorship bias is controlled, not assumed away.
    "universe": {
        "auto": True,
        "n": 40,                     # names fetched by volume
        "top_n": 30,                 # names investable at any bar
        "membership_hours": 720,     # trailing window for the volume rank
        "min_vol_usd": 20_000_000.0,
        "max_spread_bps": 8.0,
    },
    "data_dir": "data",
    "state_dir": "state",
    # five years of hourly bars (~44k/instrument): the validation holdout is
    # then ~1.7 years, which is the minimum for a Sharpe-1 rule to be
    # statistically separable from the luckiest of a handful of noise trials.
    # Newer listings contribute what they have.
    "history_days": 1825,
    "research": {
        # "panel": one rule applied to the whole universe (default);
        # "per_instrument": legacy per-coin genomes
        "mode": "panel",
        "population": 64,
        "generations": 18,
        "seed": None,
        "is_fraction": 0.65,         # fraction of history used in-sample
        "embargo_bars": 72,          # 3 days of 1H — must exceed max ML horizon (48)
        "top_k": 6,                  # rules tested on the holdout (= DSR trials)
        "min_oos_sharpe": 0.7,       # OOS annualised Sharpe required to deploy
        "min_dsr": 0.5,              # P(true SR > expected max of top_k noise trials)
        "max_oos_drawdown": 0.30,
        "n_folds": 4,                # purged OOS sub-folds, majority must be > 0
        "max_pbo": 0.5,              # CSCV probability of backtest overfitting cap
        "pbo_blocks": 10,
        "max_deployed": 4,           # max strategies live at once
        # hourly reversal / lead-lag books are fee mills on real data (IS
        # Sharpe -4 to -13 after costs on every universe tried); they stay
        # available but are not charged as trials by default
        "xs_families": ["funding_xs", "xs_mom"],
        "refresh_hours": 168,        # re-run research weekly
        "refresh_hours_empty": 24,   # ...but daily while nothing is deployed:
                                     # the hunt escalates instead of sleeping
        "retire_after_bars": 720,    # live bars (30 days of 1H) before retirement can trigger
        "retire_sharpe": -0.5,       # retire when live Sharpe falls below
    },
    "costs": {
        "taker_fee_bps": 5.0,        # OKX swap taker ~0.05%
        "maker_fee_bps": 2.0,        # OKX swap maker ~0.02%
        "slippage_bps": 2.0,         # paid on taker fills only
        "prefer_maker": True,        # post-only limit first, market fallback
        "maker_miss_rate": 0.30,     # fraction of maker attempts that fall
                                     # back to taker (modelled in backtests
                                     # AND in paper fills)
    },
    "risk": {
        "portfolio_vol_target": 0.15,   # annualised
        "max_gross_leverage": 3.0,
        "max_instrument_leverage": 1.0,
        "daily_loss_limit_pct": 4.0,    # flatten + sit out the UTC day
        "max_drawdown_pct": 20.0,       # kill switch: flatten, halt, manual reset
        "min_trade_notional": 10.0,     # USDT
        "max_order_notional": 50000.0,
        # leverage governor: autonomous risk-on/risk-off throttle. Exposure
        # above 1x must be EARNED by live results (rolling Sharpe >= 1 with
        # tiny drawdown, ramped slowly); drawdown de-risks fast and always
        # wins. Hard caps above still bound everything.
        "governor": {"enabled": True, "max_boost": 1.5},
    },
    "allocator": {
        "ewma_halflife_bars": 336,   # ~2 weeks of 1H
        "eta": 2.0,
        "max_weight": 0.5,
    },
    "live": {
        "mode": "paper",             # "paper" | "live"
        "poll_seconds": 20,
        "td_mode": "cross",
        "paper_equity": 10000.0,
        "maker_wait_s": 20,          # post-only resting time before fallback
        "rebalance_band": 0.02,      # ignore re-sizes below 2% of equity
    },
    # Experimental intraday desk (1m–15m clocks, L2 order flow). OFF by
    # default: its single-split "holdout" has no multiple-testing control
    # and its economics after fees are unproven — it must never be the
    # engine. Opt in for research only.
    "scalp": {
        "enabled": False,
        "bar": "15m",
        "instruments": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"],
        "universe_n": 3,
        "trade_top": 3,
        "require_l2": False,
        "max_spread_bps": 6.0,
        "min_vol_usd": 10_000_000.0,
        "stop_bps": 25.0,
        "take_bps": 18.0,
        "horizon": 8,
        "min_edge_bps": 6.0,
        "max_hold_bars": 16,
        "max_name_lev": 1.0,
        "gross_cap": 2.0,
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
