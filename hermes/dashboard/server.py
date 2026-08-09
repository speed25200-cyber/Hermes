"""Hermes dashboard server — Python stdlib only, zero dependencies.

Serves the single-file UI and a JSON API aggregated from the state directory
(journal.jsonl, registry.json, risk.json, trader.json, hermes.log). Runs on
localhost; start with `python -m hermes dashboard` (opens the browser) or the
Windows launcher `hermes-dashboard.bat`.
"""

from __future__ import annotations

import json
import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATIC_DIR = os.path.dirname(os.path.abspath(__file__))


def _tail_lines(path: str, max_lines: int, max_bytes: int = 2_000_000) -> list[str]:
    """Read up to max_lines from the end of a file without loading it all."""
    if not os.path.exists(path):
        return []
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - max_bytes))
        chunk = f.read().decode("utf-8", errors="replace")
    lines = chunk.splitlines()
    if size > max_bytes and lines:
        lines = lines[1:]  # drop possibly-truncated first line
    return lines[-max_lines:]


def _read_json(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


class StateReader:
    def __init__(self, state_dir: str, mode_hint: str = ""):
        self.state_dir = state_dir
        self.mode_hint = mode_hint

    def snapshot(self, journal_points: int = 1500) -> dict:
        sd = self.state_dir
        journal = []
        for line in _tail_lines(os.path.join(sd, "journal.jsonl"), journal_points):
            try:
                journal.append(json.loads(line))
            except ValueError:
                continue
        registry = _read_json(os.path.join(sd, "registry.json"))
        # enrich each strategy with its journal key (inst:gid) so the UI can
        # match allocation weights exactly
        try:
            from ..strategy.genome import Genome
            for s in registry.get("strategies", []):
                s["sid"] = f"{s['inst']}:{Genome.from_dict(s['genome']).gid}"
        except Exception:
            pass
        return {
            "mode": self.mode_hint,
            "state_dir": sd,
            "registry": registry,
            "risk": _read_json(os.path.join(sd, "risk.json")),
            "trader": _read_json(os.path.join(sd, "trader.json")),
            "journal": journal,
            "log": _tail_lines(os.path.join(sd, "hermes.log"), 120),
        }


class Handler(BaseHTTPRequestHandler):
    reader: StateReader = None  # set by serve()
    token: str = ""             # optional access key (set by serve())

    def log_message(self, fmt, *args):  # silence default request logging
        pass

    def _send(self, code: int, content: bytes, ctype: str,
              extra_headers: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content)

    def _authorized(self) -> tuple[bool, dict]:
        """Token auth for remote exposure: accept ?key=<token> once (sets a
        long-lived cookie) or the cookie on subsequent requests."""
        if not self.token:
            return True, {}
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        if q.get("key", [None])[0] == self.token:
            cookie = (f"hermes_key={self.token}; Max-Age=31536000; "
                      f"Path=/; HttpOnly; SameSite=Lax")
            return True, {"Set-Cookie": cookie}
        cookies = self.headers.get("Cookie", "")
        for part in cookies.split(";"):
            name, _, value = part.strip().partition("=")
            if name == "hermes_key" and value == self.token:
                return True, {}
        return False, {}

    FONTS = {"InterVariable.woff2", "JetBrainsMono-Regular.woff2"}
    ICONS = {"icon-192.png", "icon-512.png", "apple-touch-icon.png"}

    def do_GET(self):
        ok, extra = self._authorized()
        if not ok:
            self._send(403, b"Hermes: access key required", "text/plain")
            return
        self._extra_headers = extra
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            fp = os.path.join(STATIC_DIR, "index.html")
            with open(fp, "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8",
                           extra_headers=self._extra_headers)
        elif path == "/api/status":
            payload = json.dumps(self.reader.snapshot()).encode()
            self._send(200, payload, "application/json")
        elif path.startswith("/fonts/") and os.path.basename(path) in self.FONTS:
            fp = os.path.join(STATIC_DIR, os.path.basename(path))
            with open(fp, "rb") as f:
                self._send(200, f.read(), "font/woff2")
        elif path == "/manifest.webmanifest":
            fp = os.path.join(STATIC_DIR, "manifest.webmanifest")
            with open(fp, "rb") as f:
                self._send(200, f.read(), "application/manifest+json")
        elif path.startswith("/icons/") and os.path.basename(path) in self.ICONS:
            fp = os.path.join(STATIC_DIR, "icons", os.path.basename(path))
            with open(fp, "rb") as f:
                self._send(200, f.read(), "image/png")
        else:
            self._send(404, b"not found", "text/plain")


def serve(state_dir: str, host: str = "127.0.0.1", port: int = 8899,
          mode_hint: str = "", open_browser: bool = True,
          token: str = "") -> None:
    Handler.reader = StateReader(state_dir, mode_hint)
    Handler.token = token or os.environ.get("HERMES_DASH_TOKEN", "")
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}/"
    lock = " [key required]" if Handler.token else ""
    print(f"Hermes dashboard: {url}{lock}  (state: {state_dir})  Ctrl+C to stop")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\ndashboard stopped")
    finally:
        httpd.server_close()
