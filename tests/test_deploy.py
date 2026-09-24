"""deploy/challenger.sh: the one champion/challenger rule (runner retraining and retrain.sh)."""

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _bundle(d: Path, config_hash: str, promoted: bool) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    (d / "bundle.json").write_text(
        json.dumps({"config_hash": config_hash, "promoted": promoted, "train_end": "2026-09-01"})
    )
    return d


@pytest.fixture
def vps(tmp_path):
    """A fake /opt/hermes with a stub ``hermes`` that records ``model install`` calls."""
    log = tmp_path / "calls.log"
    stub = tmp_path / "hermes"
    stub.write_text(f'#!/usr/bin/env bash\necho "$@" >> "{log}"\n')
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    env = {**os.environ, "HERMES_ROOT": str(tmp_path), "HERMES_BIN": str(stub)}

    def run(new: Path):
        subprocess.run(["bash", str(ROOT / "deploy/challenger.sh"), str(new)], env=env, check=True, capture_output=True)
        return log.read_text().splitlines() if log.exists() else []

    return tmp_path, run


def test_first_champion_and_same_strategy_are_always_installed(vps):
    root, run = vps
    assert len(run(_bundle(root / "new1", "aaa", False))) == 1  # no champion yet
    _bundle(root / "artifacts/models/champion", "aaa", True)
    calls = run(_bundle(root / "new2", "aaa", False))  # same strategy, now failing the gate: demotion
    assert len(calls) == 2 and calls[-1].startswith("model install") and "artifacts/models/champion" in calls[-1]


def test_other_strategy_replaces_a_promoted_champion_only_if_promoted(vps):
    root, run = vps
    _bundle(root / "artifacts/models/champion", "aaa", True)
    assert run(_bundle(root / "new", "bbb", False)) == []  # the promoted champion stays
    assert len(run(_bundle(root / "new2", "bbb", True))) == 1
    _bundle(root / "artifacts/models/champion", "aaa", False)
    assert len(run(_bundle(root / "new3", "ccc", False))) == 2  # an unpromoted champion is always replaced
