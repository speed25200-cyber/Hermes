"""USDT-perp universe: liquid crypto only. Stocks/metals/oil are not the product."""

from __future__ import annotations

LEADERS = ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP")

# explicit allowlist — OKX mixes equity/commodity swaps into the same ticker dump
CRYPTO = {
    "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "LTC",
    "DOT", "BCH", "UNI", "ATOM", "FIL", "NEAR", "APT", "SUI", "TON", "TRX",
    "SHIB", "PEPE", "WLD", "ONDO", "ENA", "OP", "ARB", "INJ", "SEI", "TIA",
    "S", "WIF", "BONK", "FLOKI", "ORDI", "JUP", "PENDLE", "ETC", "XLM",
    "HBAR", "STX", "IMX", "RUNE", "GALA", "LDO", "MKR", "AAVE", "CRV", "SNX",
    "COMP", "ENS", "SAND", "MANA", "AXS", "APE", "BLUR", "FET", "RENDER",
    "NEAR", "TAO", "HYPE", "ZEC", "OKB", "MNT", "POL", "STRK", "DYDX",
    "PENGU", "TRUMP", "BOME", "PEOPLE", "NEIRO", "W", "ENA", "EIGEN",
    "MOVE", "BERA", "IP", "KAITO", "VIRTUAL", "AIXBT", "AI16Z", "FARTCOIN",
    "PNUT", "GOAT", "POPCAT", "MEW", "TURBO", "NOT", "MEME", "ORDI",
    "CFX", "IOTA", "XMR", "DASH", "EOS", "THETA", "ALGO", "VET", "XTZ",
    "KAS", "CORE", "ZK", "BLAST", "MANTA", "PIXEL", "PORTAL", "JTO",
    "PYTH", "JASMY", "GALA", "CHZ", "ROSE", "KSM", "ZEC", "XPL", "LDO",
    "SSV", "GMX", "MAGIC", "CAKE", "1INCH", "YFI", "UMA", "ZRX", "BAT",
    "LPT", "MASK", "RSR", "ANKR", "SKL", "CELO", "KAVA", "MINA", "QTUM",
    "ICX", "ZIL", "ONE", "GLMR", "MOVR", "KDA", "RVN", "SC", "DCR",
    "AR", "ARRR", "KSM", "AKT", "TIA", "STRK", "ZK", "CATI", "EIGEN",
    "OM", "RESOLV", "SPX", "MOODENG", "BRETT", "ASTER", "BEAT", "CAP",
    "RE", "LIT", "ONT", "SUN", "JST", "NFT", "BTT", "WIN", "T",
}


def select_universe(tickers: dict[str, dict], n: int = 50,
                    max_spread_bps: float = 8.0,
                    min_vol_usd: float = 20_000_000.0) -> list[str]:
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