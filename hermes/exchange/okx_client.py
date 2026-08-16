"""OKX v5 REST client (public market data + signed private endpoints).

Auth per OKX docs: OK-ACCESS-SIGN = base64(HMAC-SHA256(timestamp + method +
requestPath + body, secret)) with ISO-millisecond UTC timestamp.
Set OKX_SIMULATED=1 to hit demo trading (x-simulated-trading: 1).
"""

from __future__ import annotations

import base64
import datetime as dt
import hmac
import json
import time
from hashlib import sha256
from typing import Any
from urllib.parse import urlencode

import requests

from ..config import Credentials

BASE_URL = "https://www.okx.com"


class OKXError(RuntimeError):
    def __init__(self, code: str, msg: str, data: Any = None):
        super().__init__(f"OKX error {code}: {msg}")
        self.code = code
        self.msg = msg
        self.data = data


class OKXClient:
    def __init__(self, creds: Credentials | None = None, base_url: str = BASE_URL,
                 timeout: float = 15.0, max_retries: int = 4):
        self.creds = creds or Credentials()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = requests.Session()

    # ------------------------------------------------------------------ #

    @staticmethod
    def _timestamp() -> str:
        return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def _sign(self, ts: str, method: str, path: str, body: str) -> str:
        msg = f"{ts}{method}{path}{body}"
        mac = hmac.new(self.creds.api_secret.encode(), msg.encode(), sha256)
        return base64.b64encode(mac.digest()).decode()

    def _request(self, method: str, path: str, params: dict | None = None,
                 body: dict | None = None, auth: bool = False) -> Any:
        query = f"?{urlencode(params)}" if params else ""
        full_path = f"{path}{query}"
        url = f"{self.base_url}{full_path}"
        body_str = json.dumps(body) if body else ""
        headers = {"Content-Type": "application/json"}
        if auth:
            if not self.creds.present:
                raise OKXError("AUTH", "API credentials not configured "
                               "(set OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE)")
            ts = self._timestamp()
            headers.update({
                "OK-ACCESS-KEY": self.creds.api_key,
                "OK-ACCESS-SIGN": self._sign(ts, method, full_path, body_str),
                "OK-ACCESS-TIMESTAMP": ts,
                "OK-ACCESS-PASSPHRASE": self.creds.passphrase,
            })
            if self.creds.simulated:
                headers["x-simulated-trading"] = "1"

        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                resp = self.session.request(
                    method, url, data=body_str if body else None,
                    headers=headers, timeout=self.timeout,
                )
                if resp.status_code == 429:
                    raise OKXError("429", "rate limited")
                payload = resp.json()
                if str(payload.get("code", "0")) not in ("0",):
                    # surface per-order errors too
                    detail = payload.get("data") or payload.get("msg", "")
                    raise OKXError(str(payload["code"]), str(payload.get("msg", detail)),
                                   payload.get("data"))
                return payload["data"]
            except (requests.RequestException, ValueError, OKXError) as exc:
                retryable = isinstance(exc, (requests.RequestException, ValueError)) or (
                    isinstance(exc, OKXError) and exc.code in ("429", "50011", "50013")
                )
                last_exc = exc
                if not retryable or attempt == self.max_retries:
                    raise
                time.sleep(2 ** attempt)
        raise last_exc  # pragma: no cover

    # ---------------------- public market data ------------------------ #

    def server_time(self) -> int:
        data = self._request("GET", "/api/v5/public/time")
        return int(data[0]["ts"])

    def instruments(self, inst_type: str = "SWAP") -> list[dict]:
        return self._request("GET", "/api/v5/public/instruments",
                             {"instType": inst_type})

    def ticker(self, inst_id: str) -> dict:
        return self._request("GET", "/api/v5/market/ticker", {"instId": inst_id})[0]

    def liquid_swaps(self, top_n: int = 60, quote: str = "USDT",
                     min_vol_usdt: float = 5e6) -> list[str]:
        """Live USDT-margined perpetuals ranked by 24h traded value, richest
        first.

        Breadth is the one lever that lifts the combined Sharpe without paying
        more cost per trade: independent edges add as sqrt(N), while fees stay
        per-trade. A hardcoded list cannot deliver that for long — venues list
        and delist constantly, and a name that dried up keeps consuming a slot
        it can no longer fill.

        Ranking by traded value also keeps the universe where maker-first
        execution can actually rest an order, which is exactly where the cost
        model's assumed fill rate holds up.
        """
        live = {i["instId"] for i in self.instruments("SWAP")
                if i.get("state") == "live"}
        rows = self._request("GET", "/api/v5/market/tickers",
                             {"instType": "SWAP"})
        ranked = []
        for r in rows:
            inst = r.get("instId", "")
            if not inst.endswith(f"-{quote}-SWAP") or inst not in live:
                continue
            try:                       # volCcy24h is the quote-currency volume
                vol = float(r.get("volCcy24h") or 0.0)
            except (TypeError, ValueError):
                continue
            if vol >= min_vol_usdt:
                ranked.append((vol, inst))
        ranked.sort(reverse=True)
        return [inst for _, inst in ranked[:top_n]]

    def candles(self, inst_id: str, bar: str = "1H", limit: int = 300,
                after: int | None = None, history: bool = False) -> list[list]:
        """Returns rows [ts, o, h, l, c, vol, ...] NEWEST FIRST (OKX order).
        `after` requests rows strictly older than that ts (pagination)."""
        path = "/api/v5/market/history-candles" if history else "/api/v5/market/candles"
        params: dict = {"instId": inst_id, "bar": bar, "limit": str(limit)}
        if after is not None:
            params["after"] = str(after)
        return self._request("GET", path, params)

    def index_candles(self, index_id: str, bar: str = "1H", limit: int = 100,
                      after: int | None = None, history: bool = False
                      ) -> list[list]:
        """Index (spot basket) candles, e.g. index_id 'BTC-USDT'. Rows
        [ts, o, h, l, c, confirm] NEWEST FIRST — no volume column."""
        path = ("/api/v5/market/history-index-candles" if history
                else "/api/v5/market/index-candles")
        params: dict = {"instId": index_id, "bar": bar, "limit": str(limit)}
        if after is not None:
            params["after"] = str(after)
        return self._request("GET", path, params)

    def tickers(self, inst_ids: list[str]) -> dict[str, float]:
        """Live last prices for the given SWAP instruments (public)."""
        return {inst: t["last"] for inst, t in self.tickers_full(inst_ids).items()}

    def tickers_full(self, inst_ids: list[str]) -> dict[str, dict]:
        """Live last price + 24h change for the given SWAP instruments."""
        data = self._request("GET", "/api/v5/market/tickers", {"instType": "SWAP"})
        want = set(inst_ids)
        out: dict[str, dict] = {}
        for row in data:
            if row.get("instId") in want and row.get("last"):
                last = float(row["last"])
                open24 = float(row.get("open24h") or 0.0)
                out[row["instId"]] = {
                    "last": last,
                    "chg24h": (last / open24 - 1.0) if open24 > 0 else 0.0,
                }
        return out

    def order_book(self, inst_id: str, sz: int = 100) -> dict:
        """Live depth snapshot: {'asks': [[px, sz, ...], ...], 'bids': [...],
        'ts': ms}. No history exists on any exchange — callers record
        snapshots to build their own."""
        return self._request("GET", "/api/v5/market/books",
                             {"instId": inst_id, "sz": str(sz)})[0]

    def funding_rate(self, inst_id: str) -> dict:
        return self._request("GET", "/api/v5/public/funding-rate",
                             {"instId": inst_id})[0]

    def funding_rate_history(self, inst_id: str, limit: int = 100,
                             after: int | None = None) -> list[dict]:
        params: dict = {"instId": inst_id, "limit": str(limit)}
        if after is not None:
            params["after"] = str(after)
        return self._request("GET", "/api/v5/public/funding-rate-history", params)

    # ------------------ public trading statistics (rubik) -------------- #
    # Open interest, aggressive taker flow and crowd positioning. All free
    # public endpoints; rows are normalised to plain tuples (newest first)
    # whether OKX returns arrays or objects.

    @staticmethod
    def _stat_rows(data: list, keys: tuple[str, ...],
                   idx: tuple[int, ...]) -> list[tuple]:
        out = []
        for r in data:
            try:
                if isinstance(r, dict):
                    out.append(tuple(float(r[k]) for k in keys))
                else:
                    out.append(tuple(float(r[i]) for i in idx))
            except (KeyError, IndexError, TypeError, ValueError):
                continue
        return out

    def _stat(self, path: str, inst_id: str, period: str, limit: int,
              end: int | None, extra: dict | None = None) -> list:
        params: dict = {"instId": inst_id, "period": period, "limit": str(limit)}
        if end is not None:
            params["end"] = str(end)
        if extra:
            params.update(extra)
        return self._request("GET", path, params)

    def open_interest_history(self, inst_id: str, period: str = "1H",
                              limit: int = 100, end: int | None = None
                              ) -> list[tuple]:
        """(ts, oi_coin, oi_usd) newest first."""
        data = self._stat("/api/v5/rubik/stat/contracts/open-interest-history",
                          inst_id, period, limit, end)
        return self._stat_rows(data, ("ts", "oiCcy", "oiUsd"), (0, 2, 3))

    def taker_volume_history(self, inst_id: str, period: str = "1H",
                             limit: int = 100, end: int | None = None
                             ) -> list[tuple]:
        """(ts, buy_vol, sell_vol) newest first (contract units; only the
        buy/sell ratio is consumed, so the unit never matters)."""
        data = self._stat("/api/v5/rubik/stat/taker-volume-contract",
                          inst_id, period, limit, end)
        # OKX array order is [ts, sellVol, buyVol]
        return self._stat_rows(data, ("ts", "buyVol", "sellVol"), (0, 2, 1))

    def long_short_ratio_history(self, inst_id: str, period: str = "1H",
                                 limit: int = 100, end: int | None = None
                                 ) -> list[tuple]:
        """(ts, long_short_account_ratio) newest first."""
        data = self._stat(
            "/api/v5/rubik/stat/contracts/long-short-account-ratio-contract",
            inst_id, period, limit, end)
        return self._stat_rows(data, ("ts", "longShortAcctRatio"), (0, 1))

    def top_trader_ratio_history(self, inst_id: str, period: str = "1H",
                                 limit: int = 100, end: int | None = None
                                 ) -> list[tuple]:
        """(ts, top-trader long/short POSITION ratio) newest first — the
        positioning of the largest accounts, not the crowd."""
        data = self._stat(
            "/api/v5/rubik/stat/contracts/"
            "long-short-position-ratio-contract-top-trader",
            inst_id, period, limit, end)
        return self._stat_rows(data, ("ts", "longShortPosRatio"), (0, 1))

    # ---------------------- private (signed) --------------------------- #

    def balance(self, ccy: str = "USDT") -> dict:
        data = self._request("GET", "/api/v5/account/balance", {"ccy": ccy}, auth=True)
        return data[0]

    def equity_usdt(self) -> float:
        bal = self.balance("USDT")
        for detail in bal.get("details", []):
            if detail.get("ccy") == "USDT":
                return float(detail.get("eq", 0.0))
        return float(bal.get("totalEq", 0.0))

    def positions(self, inst_type: str = "SWAP") -> list[dict]:
        return self._request("GET", "/api/v5/account/positions",
                             {"instType": inst_type}, auth=True)

    def set_position_mode(self, net: bool = True) -> Any:
        return self._request("POST", "/api/v5/account/set-position-mode",
                             body={"posMode": "net_mode" if net else "long_short_mode"},
                             auth=True)

    def set_leverage(self, inst_id: str, lever: int, td_mode: str = "cross") -> Any:
        return self._request("POST", "/api/v5/account/set-leverage",
                             body={"instId": inst_id, "lever": str(lever),
                                   "mgnMode": td_mode}, auth=True)

    def market_order(self, inst_id: str, side: str, sz: str, td_mode: str = "cross",
                     reduce_only: bool = False, cl_ord_id: str | None = None) -> dict:
        return self.place_order(inst_id, side, sz, "market", td_mode=td_mode,
                                reduce_only=reduce_only, cl_ord_id=cl_ord_id)

    def place_order(self, inst_id: str, side: str, sz: str, ord_type: str,
                    px: str | None = None, td_mode: str = "cross",
                    reduce_only: bool = False,
                    cl_ord_id: str | None = None) -> dict:
        """ord_type: market | limit | post_only. px required for non-market."""
        body = {
            "instId": inst_id, "tdMode": td_mode, "side": side,
            "ordType": ord_type, "sz": sz,
        }
        if px is not None:
            body["px"] = px
        if reduce_only:
            body["reduceOnly"] = "true"
        if cl_ord_id:
            body["clOrdId"] = cl_ord_id
        data = self._request("POST", "/api/v5/trade/order", body=body, auth=True)
        result = data[0]
        if str(result.get("sCode", "0")) != "0":
            raise OKXError(str(result["sCode"]), str(result.get("sMsg", "")), result)
        return result

    def order_status(self, inst_id: str, ord_id: str) -> dict:
        data = self._request("GET", "/api/v5/trade/order",
                             {"instId": inst_id, "ordId": ord_id}, auth=True)
        return data[0]

    def cancel_order(self, inst_id: str, ord_id: str) -> dict:
        data = self._request("POST", "/api/v5/trade/cancel-order",
                             body={"instId": inst_id, "ordId": ord_id}, auth=True)
        return data[0]
