"""Dashboard server token auth: 403 without key, cookie flow with key."""

import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

import pytest

from hermes.dashboard.server import Handler, StateReader


@pytest.fixture
def server(tmp_path):
    Handler.reader = StateReader(str(tmp_path), "test")
    Handler.token = "sekret"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    Handler.token = ""


def test_rejects_without_key(server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(f"{server}/api/status")
    assert exc.value.code == 403


def test_key_param_sets_cookie_then_cookie_works(server):
    resp = urllib.request.urlopen(f"{server}/?key=sekret")
    assert resp.status == 200
    cookie = resp.headers.get("Set-Cookie", "")
    assert "hermes_key=sekret" in cookie
    req = urllib.request.Request(f"{server}/api/status",
                                 headers={"Cookie": "hermes_key=sekret"})
    assert urllib.request.urlopen(req).status == 200


def test_wrong_key_rejected(server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(f"{server}/?key=wrong")
    assert exc.value.code == 403


def test_no_token_means_open(server):
    Handler.token = ""
    assert urllib.request.urlopen(f"{server}/api/status").status == 200