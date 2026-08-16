"""`hermes report`: the one-screen answer to "is the book trading?".

The failure this command exists to catch is a book that decides every bar and
never places an order — invisible in the service logs, fatal to the system's
purpose. So the tests assert the report distinguishes a trading book from a
frozen one, and never crashes on a state directory that has nothing in it.
"""

import json
import os

import pytest

from hermes import cli


class Args:
    def __init__(self, state_dir, cycles=200):
        self.config = os.path.join(state_dir, "config.json")
        self.cycles = cycles


def _setup(tmp_path, rows):
    sd = tmp_path / "state"
    sd.mkdir()
    with open(tmp_path / "config.json", "w") as f:
        json.dump({"state_dir": str(sd)}, f)
    with open(sd / "journal.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    args = Args(str(tmp_path))
    args.config = str(tmp_path / "config.json")
    return sd, args


def _cycle(ts, orders=(), weights=None, positions=None, prices=None):
    return {
        "ts": ts, "equity": 10_000.0, "halted": False,
        "prices": prices or {"BTC-USDT-SWAP": 50_000.0},
        "targets": {"BTC-USDT-SWAP": 0.1},
        "orders": list(orders),
        "weights": weights or {"BTC-USDT-SWAP:abc": 1.0},
        "strat_pos": {"BTC-USDT-SWAP:abc": 0.4},
        "positions": positions or {},
    }


def test_empty_state_does_not_crash(tmp_path, capsys):
    _, args = _setup(tmp_path, [])
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "never produced a survivor" in out
    assert "has not decided anything yet" in out


def test_registry_is_summarised_one_line_per_strategy(tmp_path, capsys):
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "registry.json", "w") as f:
        json.dump({"strategies": [
            {"inst": "SUI-USDT-SWAP", "genome": {"signal": "cvd_div"},
             "oos_stats": {"sharpe": 8.44, "dsr": 0.109,
                           "oos_folds_positive": "2/3"}}],
            "n_trials": 83793, "consecutive_empty": 0,
            "researched_at": 0.0}, f)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "1 strategies | searched 83,793 genomes" in out
    assert "SUI-USDT-SWAP      cvd_div      oos_sharpe=  8.44" in out
    assert "folds+=2/3" in out


def test_frozen_book_reports_zero_orders(tmp_path, capsys):
    _, args = _setup(tmp_path, [_cycle(1000.0 + 900 * i) for i in range(20)])
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "cycles that traded: 0 (0%)" in out
    assert "orders           : 0" in out
    assert "flat — no position on the exchange" in out


def test_trading_book_reports_flow_and_exposure(tmp_path, capsys):
    order = {"inst": "BTC-USDT-SWAP", "qty": 0.02, "px": 50_000.0,
             "notional": 1000.0}
    rows = [_cycle(1000.0 + 900 * i) for i in range(9)]
    rows.append(_cycle(1000.0 + 900 * 9, orders=[order],
                       positions={"BTC-USDT-SWAP": 0.02}))
    _, args = _setup(tmp_path, rows)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "cycles that traded: 1 (10%)" in out
    assert "gross 1,000 USDT" in out
    assert "BTC=1,000" in out
    assert "+1000.00 USDT" in out
    assert "+10.00% of equity" in out


def test_halt_is_surfaced_with_its_reason(tmp_path, capsys):
    rows = [_cycle(1000.0), {"ts": 1900.0, "equity": 9000.0, "halted": True,
                             "reason": "daily loss limit", "prices": {},
                             "targets": {}, "orders": [], "weights": {},
                             "positions": {}}]
    _, args = _setup(tmp_path, rows)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "HALTED cycles    : 1" in out
    assert "daily loss limit" in out


def test_allocation_shows_starved_strategies(tmp_path, capsys):
    """The freeze signature: one strategy holds everything with a dead signal
    while the rest sit at a weight the exchange cannot express."""
    sd, args = _setup(tmp_path, [_cycle(
        1000.0, weights={"ETC-USDT-SWAP:old": 1.0, "AVAX-USDT-SWAP:new": 0.0})])
    row = _cycle(1000.0, weights={"ETC-USDT-SWAP:old": 1.0,
                                  "AVAX-USDT-SWAP:new": 0.0})
    row["strat_pos"] = {"ETC-USDT-SWAP:old": 0.0, "AVAX-USDT-SWAP:new": 0.4084}
    with open(sd / "journal.jsonl", "w") as f:
        f.write(json.dumps(row) + "\n")
    with open(sd / "trader.json", "w") as f:
        json.dump({"allocator": {"tracks": {
            "ETC-USDT-SWAP:old": {"n_obs": 367},
            "AVAX-USDT-SWAP:new": {"n_obs": 23}}}}, f)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "100.00%  ETC-USDT-SWAP:old" in out
    assert "signal=+0.0000" in out
    assert "n_obs=367" in out
    assert "n_obs=23" in out


def test_cycles_window_is_respected(tmp_path, capsys):
    order = {"inst": "BTC-USDT-SWAP", "qty": 0.02, "px": 50_000.0,
             "notional": 1000.0}
    rows = [_cycle(1000.0, orders=[order])]
    rows += [_cycle(1000.0 + 900 * i) for i in range(1, 40)]
    _, args = _setup(tmp_path, rows)
    args.cycles = 5
    cli.cmd_report(args)
    assert "orders           : 0" in capsys.readouterr().out


@pytest.mark.parametrize("bad", ["", "not json", "{"])
def test_corrupt_journal_lines_are_skipped(tmp_path, capsys, bad):
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "journal.jsonl", "a") as f:
        f.write(bad + "\n")
    cli.cmd_report(args)
    assert "cycles           : 1" in capsys.readouterr().out


def _beat(ts, positions=None, prices=None):
    return {"ts": ts, "equity": 10_000.0, "halted": False,
            "prices": prices or {"BTC-USDT-SWAP": 50_000.0},
            "targets": {}, "orders": [], "weights": {},
            "positions": positions or {}, "hb": True}


def test_heartbeats_are_not_counted_as_cycles(tmp_path, capsys):
    """A healthy book beats between bars and decides on the close. Counting
    the beats reports 0% of cycles traded for a book that trades every time
    it decides — the false alarm this command exists to rule out."""
    order = {"inst": "BTC-USDT-SWAP", "qty": 0.02, "px": 50_000.0,
             "notional": 1000.0}
    rows = []
    for i in range(4):
        rows.append(_cycle(1000.0 + 900 * i, orders=[order]))
        rows += [_beat(1000.0 + 900 * i + 60 * k) for k in range(1, 15)]
    _, args = _setup(tmp_path, rows)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "cycles           : 4" in out
    assert "56 heartbeats" in out
    assert "cycles that traded: 4 (100%)" in out


def test_heartbeat_only_journal_says_no_decision_yet(tmp_path, capsys):
    _, args = _setup(tmp_path, [_beat(1000.0 + 60 * k) for k in range(30)])
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "has not decided anything yet" in out
    assert "30 heartbeats" in out


def test_exposure_is_marked_from_the_newest_row(tmp_path, capsys):
    """Heartbeats exist to re-mark positions between decisions, so they carry
    the fresher price — the exposure section must use them."""
    rows = [_cycle(1000.0, positions={"BTC-USDT-SWAP": 0.02})]
    rows.append(_beat(1600.0, positions={"BTC-USDT-SWAP": 0.02},
                      prices={"BTC-USDT-SWAP": 60_000.0}))
    _, args = _setup(tmp_path, rows)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "+1200.00 USDT" in out


def test_cycle_window_counts_decisions_not_lines(tmp_path, capsys):
    order = {"inst": "BTC-USDT-SWAP", "qty": 0.02, "px": 50_000.0,
             "notional": 1000.0}
    rows = []
    for i in range(10):
        rows.append(_cycle(1000.0 + 900 * i, orders=[order]))
        rows += [_beat(1000.0 + 900 * i + 60 * k) for k in range(1, 10)]
    _, args = _setup(tmp_path, rows)
    args.cycles = 3
    cli.cmd_report(args)
    assert "cycles           : 3" in capsys.readouterr().out


def test_replay_timestamps_are_not_reported_as_staleness(tmp_path, capsys):
    """A demo/backtest journal carries the data's timestamps, not the run's.
    "2574754 min ago" reads as a dead engine; it is a replay."""
    _, args = _setup(tmp_path, [_cycle(1000.0 + 900 * i) for i in range(5)])
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "min ago" not in out
    assert "replay: 1970-01-01" in out


def test_universe_source_is_reported(tmp_path, capsys):
    """A universe that silently fell back to the configured list explains a
    narrow book better than the strategies it produced ever will."""
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "universe.json", "w") as f:
        json.dump({"instruments": [f"I{i}-USDT-SWAP" for i in range(60)],
                   "source": "venue", "resolved_at": 0.0}, f)
    cli.cmd_report(args)
    assert "universe: 60 instruments from venue" in capsys.readouterr().out


def test_missing_universe_file_says_configured(tmp_path, capsys):
    _, args = _setup(tmp_path, [_cycle(1000.0)])
    cli.cmd_report(args)
    assert "not venue-resolved" in capsys.readouterr().out


def test_strategies_below_their_selection_bar_are_flagged(tmp_path, capsys):
    """A Sharpe of 8.4 reads as spectacular until you learn that searching
    83,793 genomes on a two-month window produces 10.5 from noise alone."""
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "registry.json", "w") as f:
        json.dump({"strategies": [
            {"inst": "SUI-USDT-SWAP", "genome": {"signal": "cvd_div"},
             "oos_stats": {"sharpe": 8.44, "dsr": 0.109,
                           "selection_bar": 10.52,
                           "oos_folds_positive": "2/3"}},
            {"inst": "BTC-USDT-SWAP", "genome": {"signal": "tsmom"},
             "oos_stats": {"sharpe": 4.70, "dsr": 0.970,
                           "selection_bar": 2.15,
                           "oos_folds_positive": "3/3"}}],
            "n_trials": 83793, "consecutive_empty": 0,
            "researched_at": 0.0}, f)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "vs bar 10.52 !" in out
    assert "vs bar  2.15 dsr=0.970" in out
    assert "! 1 of 2 scored BELOW" in out


def test_registry_without_a_bar_still_prints(tmp_path, capsys):
    """Registries written before the bar was recorded must not crash it."""
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "registry.json", "w") as f:
        json.dump({"strategies": [
            {"inst": "ETC-USDT-SWAP", "genome": {"signal": "cvd_div"},
             "oos_stats": {"sharpe": 8.92, "dsr": 0.121}}],
            "n_trials": 1, "consecutive_empty": 0, "researched_at": 0.0}, f)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "oos_sharpe=  8.92 dsr=0.121" in out
    assert "scored BELOW" not in out


def test_an_empty_book_says_what_it_came_closest_to(tmp_path, capsys):
    """"Nothing deployed" is the honest outcome most of the time, and on its
    own it is indistinguishable from a broken pipeline. The binding
    constraint is the useful fact."""
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "registry.json", "w") as f:
        json.dump({"strategies": [], "n_trials": 6240,
                   "consecutive_empty": 1, "researched_at": 0.0}, f)
    with open(sd / "last_research.json", "w") as f:
        json.dump({"at": 0.0, "deployed": 0, "considered": 41,
                   "near_misses": [
                       {"what": "panel tsmom", "sharpe": 3.1,
                        "selection_bar": 2.6, "why": "folds 1/3"},
                       {"what": "ATOM-USDT-SWAP rsi_rev", "sharpe": 2.5,
                        "selection_bar": 4.03,
                        "why": "dsr 0.052 < 0.50 (bar 4.03)"}]}, f)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "41 candidates reached the gate, 0 passed" in out
    assert "panel tsmom" in out and "folds 1/3" in out
    assert "dsr 0.052 < 0.50" in out


def test_an_empty_book_without_a_summary_says_so(tmp_path, capsys):
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "registry.json", "w") as f:
        json.dump({"strategies": [], "n_trials": 0, "consecutive_empty": 0,
                   "researched_at": 0.0}, f)
    cli.cmd_report(args)
    assert "no research summary on disk" in capsys.readouterr().out


def test_a_full_book_does_not_print_misses(tmp_path, capsys):
    sd, args = _setup(tmp_path, [_cycle(1000.0)])
    with open(sd / "registry.json", "w") as f:
        json.dump({"strategies": [
            {"inst": "PANEL", "genome": {"signal": "tsmom"},
             "oos_stats": {"sharpe": 4.7, "dsr": 0.97,
                           "selection_bar": 2.6}}],
            "n_trials": 26, "consecutive_empty": 0, "researched_at": 0.0}, f)
    with open(sd / "last_research.json", "w") as f:
        json.dump({"deployed": 1, "considered": 26, "near_misses": [
            {"what": "panel meanrev", "sharpe": 1.0, "selection_bar": 2.6,
             "why": "sharpe 1.00 < 0.50"}]}, f)
    cli.cmd_report(args)
    out = capsys.readouterr().out
    assert "closest misses" not in out
    assert "PANEL" in out
