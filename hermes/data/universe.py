"""Which instruments Hermes trades.

The universe can be pinned in config or refreshed from the venue by traded
value. Refreshing matters because breadth is the one lever that raises the
combined Sharpe without raising cost per trade — independent edges add as
sqrt(N) while fees stay per-trade — and a hardcoded list decays: perpetuals
list and delist, and a name whose volume dried up keeps a slot it can no
longer fill.

The resolved list is persisted so research and the live engine always agree
on it. Two invariants hold whatever the venue reports:

  * the cross-asset leader stays at index 0, because the lead-lag features
    read it from there;
  * an instrument currently held keeps its place even if it falls out of the
    ranking, so a position can never be orphaned by a universe refresh.
"""

from __future__ import annotations

import json
import os
import time

UNIVERSE_FILE = "universe.json"


def persisted_path(state_dir: str) -> str:
    return os.path.join(state_dir, UNIVERSE_FILE)


def load_persisted(state_dir: str) -> list[str] | None:
    """The universe a previous resolution settled on, or None."""
    path = persisted_path(state_dir)
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            insts = json.load(f).get("instruments")
    except (OSError, ValueError):
        return None
    return insts if isinstance(insts, list) and insts else None


def save(state_dir: str, instruments: list[str], source: str) -> None:
    os.makedirs(state_dir, exist_ok=True)
    with open(persisted_path(state_dir), "w") as f:
        json.dump({"instruments": instruments, "source": source,
                   "resolved_at": time.time()}, f, indent=2)


def order(instruments: list[str], leader: str, held: list[str] | None = None
          ) -> list[str]:
    """Apply both invariants: leader first, held instruments never dropped."""
    out = [leader] if leader else []
    for inst in instruments:
        if inst != leader and inst not in out:
            out.append(inst)
    for inst in held or []:
        if inst not in out:
            out.append(inst)
    return out


def resolve(cfg, client=None, state_dir: str | None = None,
            held: list[str] | None = None, log=None) -> list[str]:
    """Instrument list to trade this pass.

    `universe_size` of 0 keeps the configured list. Otherwise the venue is
    ranked by 24h traded value; if that call fails the previous resolution is
    reused, and failing that the configured list — a refresh must never leave
    the engine with no universe at all.
    """
    configured = list(cfg["instruments"])
    leader = configured[0] if configured else ""
    size = int(cfg.get("universe_size", 0) or 0)
    state_dir = state_dir or cfg["state_dir"]

    if size <= 0:
        return order(configured, leader, held)

    if client is not None:
        try:
            ranked = client.liquid_swaps(
                top_n=size,
                min_vol_usdt=float(cfg.get("universe_min_vol_usdt", 5e6)))
            if ranked:
                insts = order(ranked, leader, held)
                save(state_dir, insts, "venue")
                if log:
                    fresh = [i for i in insts if i not in configured]
                    log(f"universe: {len(insts)} instruments by traded value "
                        f"({len(fresh)} beyond the configured list)")
                return insts
            if log:
                log("universe: venue returned nothing, keeping the last one")
        except Exception as exc:                   # network, schema, anything
            if log:
                log(f"universe: refresh failed ({exc}), keeping the last one")

    previous = load_persisted(state_dir)
    if previous:
        return order(previous, leader, held)
    return order(configured, leader, held)
