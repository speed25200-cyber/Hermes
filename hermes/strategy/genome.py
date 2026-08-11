"""Strategy genome: a serialisable description of a trading rule.

A genome is:
    signal    - which alpha family + parameters
    filter    - optional regime filter (trades only when regime condition holds)
    vol_target- per-strategy annualised vol target (position scaling)
    max_lev   - exposure cap

The research engine explores this space with an evolutionary algorithm; the
same genome objects are then executed identically in backtest, paper and live
trading, which eliminates backtest/live logic drift.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass, field
from typing import Any

# param spec: name -> (low, high, is_int, log_scale)
SIGNAL_SPECS: dict[str, dict[str, tuple]] = {
    "tsmom": {  # time-series momentum with deadband
        "lookback": (8, 400, True, True),
        "deadband": (0.0, 1.0, False, False),   # in units of ret std
    },
    "ma_cross": {
        "fast": (3, 60, True, True),
        "ratio": (2.0, 10.0, False, False),      # slow = fast * ratio
    },
    "meanrev": {  # continuous z-score mean reversion
        "lookback": (10, 240, True, True),
        "entry_z": (1.0, 3.0, False, False),
    },
    "breakout": {  # Donchian channel breakout, hold until opposite band
        "lookback": (10, 300, True, True),
    },
    "rsi_rev": {
        "lookback": (5, 60, True, True),
        "low": (10.0, 40.0, False, False),
        "high_gap": (60.0, 90.0, False, False),  # high = max(low+10, high_gap)
    },
    "funding_carry": {  # collect funding when it is persistently one-sided
        "lookback": (24, 400, True, True),
        "threshold": (0.00003, 0.0006, False, True),  # per-8h rate
    },
    "ml_ridge": {  # walk-forward ridge prediction engine
        "horizon": (2, 48, True, True),
        "thresh": (0.1, 1.2, False, False),     # entry threshold on |pred| z
        "l2_exp": (-1, 3, True, False),         # l2 = 10^l2_exp
        "cross": (0, 1, True, False),           # use leader lead-lag features
    },
    "ml_boost": {  # walk-forward gradient-boosted stumps
        "horizon": (2, 48, True, True),
        "thresh": (0.1, 1.2, False, False),
        "n_trees": (1, 4, True, False),         # trees = 10 * n_trees
        "cross": (0, 1, True, False),
    },
    "basis_rev": {  # perp premium/discount vs the spot index (full history)
        "lookback": (8, 400, True, True),
        "entry_z": (0.5, 3.0, False, False),
        "dir": (0, 1, True, False),             # 0 fade the premium, 1 follow
    },
    # ---- aux-data families (open interest / taker flow / positioning).
    # These need the rubik series in Candles.x, which cover only the recent
    # months, so they are searched in a dedicated pass on the covered window
    # (never in the main multi-year evolution).
    "oi_mom": {  # OI-confirmed momentum (mode 0) / squeeze fade (mode 1)
        "lookback": (4, 192, True, True),
        "conf_z": (0.2, 2.0, False, False),     # OI-change z threshold
        "mode": (0, 1, True, False),
    },
    "taker_flow": {  # aggressive taker buy/sell imbalance z-score
        "lookback": (4, 192, True, True),
        "entry_z": (0.5, 2.5, False, False),
        "dir": (0, 1, True, False),             # 0 follow the flow, 1 fade it
    },
    "lsr_fade": {  # crowd long/short account-ratio extremes
        "lookback": (8, 400, True, True),
        "entry_z": (0.5, 2.5, False, False),
        "dir": (0, 1, True, False),             # 0 fade the crowd, 1 follow
    },
    "ttp_follow": {  # top-trader (largest accounts) position-ratio shifts
        "lookback": (8, 400, True, True),
        "entry_z": (0.5, 2.5, False, False),
        "dir": (0, 1, True, False),             # 0 follow smart money, 1 fade
    },
}

# families that require Candles.x aux series; excluded from the default
# evolution pool and explored in their own pass on the aux-covered window
AUX_SIGNALS = ("oi_mom", "taker_flow", "lsr_fade", "ttp_follow")
CORE_SIGNALS = tuple(s for s in SIGNAL_SPECS if s not in AUX_SIGNALS)

FILTER_SPECS: dict[str, dict[str, tuple]] = {
    "none": {},
    "vol_below": {"pct": (0.3, 0.95, False, False)},
    "vol_above": {"pct": (0.05, 0.7, False, False)},
    "regime": {"mask": (1, 6, True, False)},   # bitmask over {quiet,normal,turbulent}
}

GLOBAL_SPECS: dict[str, tuple] = {
    "vol_target": (0.05, 0.60, False, False),  # annualised
    "max_lev": (0.25, 2.0, False, False),
}


def _sample_param(spec: tuple, rng: random.Random) -> float | int:
    lo, hi, is_int, log_scale = spec
    if log_scale:
        import math
        v = math.exp(rng.uniform(math.log(lo), math.log(hi)))
    else:
        v = rng.uniform(lo, hi)
    return int(round(v)) if is_int else round(v, 6)


def _clip_param(value: float, spec: tuple) -> float | int:
    lo, hi, is_int, _ = spec
    v = min(max(value, lo), hi)
    return int(round(v)) if is_int else round(v, 6)


@dataclass
class Genome:
    signal: str
    params: dict[str, Any]
    filter: str = "none"
    filter_params: dict[str, Any] = field(default_factory=dict)
    vol_target: float = 0.2
    max_lev: float = 1.0

    def to_dict(self) -> dict:
        return {
            "signal": self.signal,
            "params": self.params,
            "filter": self.filter,
            "filter_params": self.filter_params,
            "vol_target": self.vol_target,
            "max_lev": self.max_lev,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Genome":
        return cls(
            signal=d["signal"], params=dict(d["params"]),
            filter=d.get("filter", "none"),
            filter_params=dict(d.get("filter_params", {})),
            vol_target=float(d.get("vol_target", 0.2)),
            max_lev=float(d.get("max_lev", 1.0)),
        )

    @property
    def gid(self) -> str:
        payload = json.dumps(self.to_dict(), sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()[:12]

    def describe(self) -> str:
        p = ", ".join(f"{k}={v}" for k, v in sorted(self.params.items()))
        s = f"{self.signal}({p})"
        if self.filter != "none":
            fp = ", ".join(f"{k}={v}" for k, v in sorted(self.filter_params.items()))
            s += f" | {self.filter}({fp})"
        return s + f" | vt={self.vol_target:.2f} lev<={self.max_lev:.2f}"


def random_genome(rng: random.Random,
                  families: tuple[str, ...] | None = None) -> Genome:
    signal = rng.choice(list(families if families is not None else CORE_SIGNALS))
    params = {k: _sample_param(spec, rng) for k, spec in SIGNAL_SPECS[signal].items()}
    filt = rng.choice(list(FILTER_SPECS))
    fparams = {k: _sample_param(spec, rng) for k, spec in FILTER_SPECS[filt].items()}
    return Genome(
        signal=signal, params=params, filter=filt, filter_params=fparams,
        vol_target=float(_sample_param(GLOBAL_SPECS["vol_target"], rng)),
        max_lev=float(_sample_param(GLOBAL_SPECS["max_lev"], rng)),
    )


def mutate(g: Genome, rng: random.Random, rate: float = 0.4,
           families: tuple[str, ...] | None = None) -> Genome:
    d = g.to_dict()
    # occasionally jump to a fresh random genome to keep exploring
    if rng.random() < 0.06:
        return random_genome(rng, families)
    for k, spec in SIGNAL_SPECS[d["signal"]].items():
        if rng.random() < rate:
            lo, hi, is_int, _ = spec
            span = (hi - lo) * 0.25
            d["params"][k] = _clip_param(d["params"][k] + rng.gauss(0, span), spec)
    if rng.random() < rate * 0.5:
        filt = rng.choice(list(FILTER_SPECS))
        d["filter"] = filt
        d["filter_params"] = {k: _sample_param(s, rng) for k, s in FILTER_SPECS[filt].items()}
    else:
        for k, spec in FILTER_SPECS[d["filter"]].items():
            if rng.random() < rate:
                lo, hi, is_int, _ = spec
                d["filter_params"][k] = _clip_param(
                    d["filter_params"][k] + rng.gauss(0, (hi - lo) * 0.25), spec)
    for k in ("vol_target", "max_lev"):
        if rng.random() < rate:
            spec = GLOBAL_SPECS[k]
            lo, hi, _, _ = spec
            d[k] = float(_clip_param(d[k] + rng.gauss(0, (hi - lo) * 0.25), spec))
    return Genome.from_dict(d)


def crossover(a: Genome, b: Genome, rng: random.Random) -> Genome:
    """Uniform crossover; signal family (and its params) inherited as a block."""
    base, other = (a, b) if rng.random() < 0.5 else (b, a)
    d = base.to_dict()
    if rng.random() < 0.5:
        d["filter"] = other.filter
        d["filter_params"] = dict(other.filter_params)
    if rng.random() < 0.5:
        d["vol_target"] = other.vol_target
    if rng.random() < 0.5:
        d["max_lev"] = other.max_lev
    # blend numeric params when both parents share the signal family
    if a.signal == b.signal:
        for k, spec in SIGNAL_SPECS[a.signal].items():
            w = rng.random()
            d["params"][k] = _clip_param(w * a.params[k] + (1 - w) * b.params[k], spec)
    return Genome.from_dict(d)
