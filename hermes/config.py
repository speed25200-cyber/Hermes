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
    # a wider liquid universe gives the research more independent chances to
    # find a real edge (funding carry and BTC lead-lag are alt-heavy);
    # instruments[0] is the cross-asset leader
    "instruments": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP",
                    "XRP-USDT-SWAP", "DOGE-USDT-SWAP", "BNB-USDT-SWAP",
                    "AVAX-USDT-SWAP", "LINK-USDT-SWAP"],
    "bar": "1H",
    "data_dir": "data",
    "state_dir": "state",
    "history_days": 730,
    "research": {
        "population": 96,
        "generations": 25,
        "seed": None,
        "is_fraction": 0.7,          # fraction of history used in-sample
        "embargo_bars": 24,          # gap between IS and OOS to avoid leakage
        "min_oos_sharpe": 0.5,       # OOS annualised Sharpe required to deploy
        "min_dsr": 0.05,             # deflated Sharpe probability threshold
        "max_deployed": 6,           # max strategies live at once
        "refresh_hours": 168,        # re-run research weekly
    },
    "costs": {
        "taker_fee_bps": 5.0,        # OKX swap taker ~0.05%
        "slippage_bps": 2.0,
    },
    "risk": {
        "portfolio_vol_target": 0.20,   # annualised
        "max_gross_leverage": 2.0,
        "max_instrument_leverage": 1.0,
        "daily_loss_limit_pct": 3.0,    # halt for the day
        "max_drawdown_pct": 15.0,       # kill switch: flatten + halt
        "min_trade_notional": 10.0,     # USDT
        "max_order_notional": 25000.0,  # sanity cap per order
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
    },
}


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
