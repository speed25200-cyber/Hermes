"""Universe selection and causal membership.

Breadth is the main lever of cross-sectional alpha, but a universe chosen
by TODAY's volume and back-tested over history is survivorship bias in its
purest form: the names that rallied into the top of the ranking make every
momentum rule look good. Two mechanisms keep this honest:

  * `select_universe` picks the liquid USDT perpetuals to FETCH (an
    allowlist of crypto names, spread and volume floors) — this is the
    candidate pool, refreshed at each research pass;
  * `membership_mask` decides, bar by bar and using only trailing quote
    volume, which of the fetched names were in the investable top-N at
    that time. Positions outside the mask are zero. A name enters only
    after it has enough history to be ranked, and only once it was
    actually among the most-traded names of its day.
"""

from __future__ import annotations

import json
import os
import time

import numpy as np

from .data.store import Candles

LEADERS = ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP")

# explicit allowlist — OKX mixes equity/commodity swaps into the same ticker dump
CRYPTO = {
    "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "LTC",
    "DOT", "BCH", "UNI", "ATOM", "FIL", "NEAR", "APT", "SUI", "TON", "TRX",
    "SHIB", "PEPE", "WLD", "ONDO", "ENA", "OP", "ARB", "INJ", "SEI", "TIA",
    "S", "WIF", "BONK", "FLOKI", "ORDI", "JUP", "PENDLE", "ETC", "XLM",
    "HBAR", "STX", "IMX", "RUNE", "GALA", "LDO", "MKR", "AAVE", "CRV", "SNX",
    "COMP", "ENS", "SAND", "MANA", "AXS", "APE", "BLUR", "FET", "RENDER",
    "TAO", "HYPE", "ZEC", "OKB", "MNT", "POL", "STRK", "DYDX",
    "PENGU", "TRUMP", "BOME", "PEOPLE", "NEIRO", "W", "EIGEN",
    "MOVE", "BERA", "IP", "KAITO", "VIRTUAL", "AIXBT", "AI16Z", "FARTCOIN",
    "PNUT", "GOAT", "POPCAT", "MEW", "TURBO", "NOT", "MEME",
    "CFX", "IOTA", "XMR", "DASH", "EOS", "THETA", "ALGO", "VET", "XTZ",
    "KAS", "CORE", "ZK", "BLAST", "MANTA", "PIXEL", "PORTAL", "JTO",
    "PYTH", "JASMY", "CHZ", "ROSE", "KSM", "XPL",
    "SSV", "GMX", "MAGIC", "CAKE", "1INCH", "YFI", "UMA", "ZRX", "BAT",
    "LPT", "MASK", "RSR", "ANKR", "SKL", "CELO", "KAVA", "MINA", "QTUM",
    "ICX", "ZIL", "ONE", "GLMR", "MOVR", "KDA", "RVN", "SC", "DCR",
    "AR", "ARRR", "AKT", "CATI",
    "OM", "RESOLV", "SPX", "MOODENG", "BRETT", "ASTER", "BEAT", "CAP",
    "RE", "LIT", "ONT", "SUN", "JST", "NFT", "BTT", "WIN", "T",
    "ICP", "ETHFI", "PUMP", "MUBARAK", "GRVT", "EGLD", "BICO", "KITE",
    "ROBO", "DOS", "CHIP", "CRO", "GRT", "FLOW", "EGLD", "NEO", "WAVES",
    "ZRO", "IO", "TNSR", "SAGA", "ETHW", "ARKM", "CYBER", "AEVO", "ALT",
    "ACE", "NMR", "AUCTION", "BAND", "BAL", "BNT", "CVC", "KNC", "LRC",
    "OMG", "STORJ", "SUSHI", "TRB", "USTC", "LUNC", "LUNA", "GAS", "NEIROETH",
    "DEGEN", "BIGTIME", "MYRO", "SLERF", "ZETA", "DYM", "ALTLAYER", "ONDO",
}


def select_universe(tickers: dict[str, dict], n: int = 50,
                    max_spread_bps: float = 8.0,
                    min_vol_usd: float = 20_000_000.0) -> list[str]:
    """Top-n liquid crypto USDT perpetuals by 24h quote volume (leaders first)."""
    scored: list[tuple[float, str]] = []
    for inst, t in tickers.items():
        if not inst.endswith("-USDT-SWAP"):
            continue
        base = inst.split("-", 1)[0]
        if base not in CRYPTO:
            continue
        if float(t.get("spread_bps", 999)) > max_spread_bps:
            continue
        vol = float(t.get("vol_usd") or 0.0)
        if vol < min_vol_usd:
            continue
        scored.append((vol, inst))
    scored.sort(reverse=True)
    picked = [inst for _, inst in scored[:n]]
    head = [x for x in LEADERS if x in picked]
    rest = [x for x in picked if x not in head]
    return head + rest


def universe_path(state_dir: str) -> str:
    return os.path.join(state_dir, "universe.json")


def load_universe(state_dir: str) -> list[str] | None:
    try:
        with open(universe_path(state_dir)) as f:
            d = json.load(f)
        insts = list(d.get("instruments") or [])
        return insts or None
    except (OSError, ValueError):
        return None


def resolve_universe(cfg, state_dir: str, client=None, log=None) -> list[str]:
    """The instrument list the engine works on.

    `universe.auto` off: the configured `instruments`. On: the configured
    names plus the top-n liquid perpetuals by 24h volume, resolved from
    live tickers when a client is given, else the last persisted
    resolution, else the configured names. The configured leader stays
    first (cross-asset features key off it)."""
    base = list(cfg["instruments"])
    u = cfg.get("universe") or {}
    if not u.get("auto", False):
        return base
    picked: list[str] | None = None
    if client is not None:
        try:
            ticks = client.swap_tickers()
            picked = select_universe(
                ticks, n=int(u.get("n", 40)),
                max_spread_bps=float(u.get("max_spread_bps", 8.0)),
                min_vol_usd=float(u.get("min_vol_usd", 20e6)))
            out = base + [i for i in picked if i not in base]
            os.makedirs(state_dir, exist_ok=True)
            with open(universe_path(state_dir), "w") as f:
                json.dump({"instruments": out, "resolved_at": time.time(),
                           "vol_usd": {i: float(ticks[i]["vol_usd"]) for i in picked
                                       if i in ticks}}, f, indent=1)
            if log:
                log(f"universe: {len(out)} instruments ({len(picked)} by volume)")
            return out
        except Exception as exc:
            if log:
                log(f"universe: ticker resolution failed ({type(exc).__name__}: "
                    f"{exc}); using the last persisted universe")
    saved = load_universe(state_dir)
    if saved:
        return base + [i for i in saved if i not in base]
    return base


def membership_mask(candles_map: dict[str, Candles], insts: list[str],
                    idx: dict[str, np.ndarray], n: int, top_n: int | None,
                    window_bars: int = 720, min_bars: int = 200) -> np.ndarray:
    """(k, n) boolean: instrument j investable at master bar t.

    Uses only trailing quote volume (window_bars, ~30 days of 1H) up to and
    including t. Names without quote volume in the store cannot be ranked
    and are treated as always investable once they have `min_bars` of
    history — the caller should know that this weakens the survivorship
    control (it is logged at research time)."""
    k = len(insts)
    present = np.zeros((k, n), dtype=bool)
    tv = np.full((k, n), np.nan)
    have_qv = True
    for j, inst in enumerate(insts):
        c = candles_map[inst]
        ix = idx[inst]
        present[j, ix[min_bars:]] = True
        q = np.asarray(c.qv, dtype=np.float64)
        if not np.any(q > 0):
            have_qv = False
            continue
        cs = np.concatenate(([0.0], np.cumsum(np.nan_to_num(q, nan=0.0))))
        w = min(window_bars, len(q))
        trail = np.empty(len(q))
        trail[:w] = cs[1:w + 1]
        trail[w:] = cs[w + 1:] - cs[1:-w]
        tv[j, ix] = trail
    if top_n is None or top_n >= k or not have_qv:
        return present
    tv = np.where(present, tv, -np.inf)
    # rank per bar (descending); membership = rank < top_n
    order = np.argsort(-tv, axis=0, kind="stable")
    ranks = np.empty_like(order)
    ranks[order, np.arange(n)[None, :]] = np.arange(k)[:, None]
    return present & (ranks < top_n)
