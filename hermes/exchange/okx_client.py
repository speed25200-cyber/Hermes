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
                 body: dict | None = None, auth: bool = False,
                 retry: bool = True) -> Any:
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
        attempts = (self.max_retries + 1) if retry else 1
        for attempt in range(attempts):
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
                retryable = retry and (
                    isinstance(exc, (requests.RequestException, ValueError)) or (
                        isinstance(exc, OKXError) and exc.code in ("429", "50011", "50013")
                    )
                )
                last_exc = exc
                if not retryable or attempt == attempts - 1:
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

    def candles(self, inst_id: str, bar: str = "1H", limit: int = 300,
                after: int | None = None, history: bool = False) -> list[list]:
        """Returns rows [ts, o, h, l, c, vol, ...] NEWEST FIRST (OKX order).
        `after` requests rows strictly older than that ts (pagination)."""
        path = "/api/v5/market/history-candles" if history else "/api/v5/market/candles"
        params: dict = {"instId": inst_id, "bar": bar, "limit": str(limit)}
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

    def funding_rate(self, inst_id: str) -> dict:
        return self._request("GET", "/api/v5/public/funding-rate",
                             {"instId": inst_id})[0]

    def funding_rate_history(self, inst_id: str, limit: int = 100,
                             after: int | None = None) -> list[dict]:
        params: dict = {"instId": inst_id, "limit": str(limit)}
        if after is not None:
            params["after"] = str(after)
        return self._request("GET", "/api/v5/public/funding-rate-history", params)

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
        data = self._request("POST", "/api/v5/trade/order", body=body, auth=True,
                             retry=False)
        result = data[0]
        if str(result.get("sCode", "0")) != "0":
            raise OKXError(str(result["sCode"]), str(result.get("sMsg", "")), result)
        return result

    def order_status(self, inst_id: str, ord_id: str) -> dict:
        data = self._request("GET", "/api/v5/trade/order",
                             {"instId": inst_id, "ordId": ord_id}, auth=True)
        return data[0]

    def order_by_cl_ord_id(self, inst_id: str, cl_ord_id: str) -> dict | None:
        """Lookup an order by client id (recovery after a transport timeout)."""
        try:
            data = self._request("GET", "/api/v5/trade/order",
                                 {"instId": inst_id, "clOrdId": cl_ord_id}, auth=True)
            return data[0] if data else None
        except OKXError:
            return None

    def cancel_order(self, inst_id: str, ord_id: str) -> dict:
        data = self._request("POST", "/api/v5/trade/cancel-order",
                             body={"instId": inst_id, "ordId": ord_id}, auth=True)
        return data[0]
