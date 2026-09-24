"""Train/serve skew and drift: population stability index (PSI) of each feature, live versus training.

The bundle stores, for every feature, decile edges and the share of rows per bin (plus a missing-value bin)
measured on the most recent training months. Live, the same bins are filled with the member rows of the
last day and compared: ``PSI = sum (a - e) ln(a / e)``. Common reading: < 0.1 stable, 0.1-0.25 shifting,
> 0.25 a different distribution -- a regime change, or a data/feature bug that the model would otherwise
trade on silently. It is a warning for the operator, never a trading input.
"""

from __future__ import annotations

import numpy as np

FLOOR = 1e-4
DRIFT_PSI_FLOOR = 0.25  # the usual 'different distribution' reading, the least a calibrated threshold can be
DRIFT_MARKET_DAYS = 7  # live window of market-level features: a whole weekly cycle


def _shares(x: np.ndarray, edges: np.ndarray) -> np.ndarray:
    fin = np.isfinite(x)
    counts = np.bincount(np.searchsorted(edges, x[fin], side="right"), minlength=len(edges) + 1).astype(float)
    out = np.append(counts, float((~fin).sum()))
    return out / max(len(x), 1)


def feature_profile(
    X: np.ndarray, names: list[str], n_bins: int = 10, max_rows: int = 200_000, seed: int = 0
) -> dict[str, dict[str, list[float]]]:
    """Decile edges and bin shares per feature (rows subsampled to ``max_rows``)."""
    rng = np.random.default_rng(seed)
    rows = np.arange(len(X)) if len(X) <= max_rows else np.sort(rng.choice(len(X), max_rows, replace=False))
    out: dict[str, dict[str, list[float]]] = {}
    qs = np.linspace(0, 1, n_bins + 1)[1:-1]
    for j, name in enumerate(names):
        x = np.asarray(X[rows, j], dtype=np.float64)
        fin = x[np.isfinite(x)]
        edges = np.unique(np.quantile(fin, qs)) if len(fin) else np.array([])
        out[name] = {"edges": [float(e) for e in edges], "expected": [float(s) for s in _shares(x, edges)]}
    return out


def psi(profile: dict[str, dict[str, list[float]]], X: np.ndarray, names: list[str]) -> dict[str, float]:
    """PSI of each profiled feature on the rows of ``X`` (columns in ``names`` order)."""
    out: dict[str, float] = {}
    if len(X) == 0:
        return out
    for j, name in enumerate(names):
        p = profile.get(name)
        if p is None:
            continue
        e = np.maximum(np.asarray(p["expected"], dtype=float), FLOOR)
        a = np.maximum(_shares(np.asarray(X[:, j], dtype=np.float64), np.asarray(p["edges"], dtype=float)), FLOOR)
        out[name] = float(np.sum((a - e) * np.log(a / e)))
    return out


def null_quantiles(
    profile: dict[str, dict[str, list[float]]],
    X: np.ndarray,
    t_pos: np.ndarray,
    names: list[str],
    market: set[str],
    window_bars: int,
    market_window_bars: int,
    n_windows: int = 200,
    q: float = 0.99,
    seed: int = 0,
) -> dict[str, float]:
    """Per-feature PSI that windows of the live design reach with no skew at all: the ``q`` quantile over
    random windows of the calibration rows (``X``, sorted by bar ``t_pos``) against ``profile``.

    Contract-level features are read on every member row of ``window_bars`` bars, market-level ones
    (``market``: one value a bar shared by all members) on one row a bar over ``market_window_bars`` bars,
    as the live engine does. Serial correlation, a weekly cycle and the few independent draws of a short
    window all raise the PSI of an unchanged feature; a fixed 0.25 ignores that, this threshold prices it in.
    """
    rng = np.random.default_rng(seed)
    if len(t_pos) == 0:
        return {}
    first = np.r_[0, np.nonzero(np.diff(t_pos))[0] + 1]  # first row of each bar
    out: dict[str, list[float]] = {}
    for is_market, span in ((False, window_bars), (True, market_window_bars)):
        cols = [j for j, k in enumerate(names) if k in profile and (k in market) == is_market]
        lo_bar, hi_bar = int(t_pos[0]), int(t_pos[-1]) - span + 1
        if not cols or hi_bar < lo_bar:
            continue
        sub = [names[j] for j in cols]
        for b0 in rng.integers(lo_bar, hi_bar + 1, size=n_windows):
            lo, hi = np.searchsorted(t_pos, b0, "left"), np.searchsorted(t_pos, b0 + span, "left")
            rows = first[(first >= lo) & (first < hi)] if is_market else np.arange(lo, hi)
            if len(rows) < 2:
                continue
            for k, v in psi(profile, np.asarray(X[rows][:, cols], dtype=np.float32), sub).items():
                out.setdefault(k, []).append(v)
    return {k: float(np.quantile(v, q)) for k, v in out.items() if v}


def unseen_share(profile: dict[str, dict[str, list[float]]], X: np.ndarray, names: list[str]) -> dict[str, float]:
    """Share of rows per feature in bins that held under 0.1 % of the training rows: values training never
    produced (missing where it had none, below a tied minimum). Unlike the PSI level, this does not depend on
    the window, so it flags a broken live feature even without a calibrated threshold."""
    out: dict[str, float] = {}
    if len(X) == 0:
        return out
    for j, name in enumerate(names):
        p = profile.get(name)
        if p is None:
            continue
        a = _shares(np.asarray(X[:, j], dtype=np.float64), np.asarray(p["edges"], dtype=float))
        out[name] = float(a[np.asarray(p["expected"], dtype=float) < 1e-3].sum())
    return out


def drift_report(
    profile: dict[str, dict[str, list[float]]], blocks: list[tuple[np.ndarray, list[str]]]
) -> tuple[dict[str, float], list[str]]:
    """Risk fields and operator notes from windows of live rows (``(X, names)`` blocks).

    A feature drifts when its PSI exceeds its calibrated threshold (``null_q99``, floored at 0.25); bundles
    profiled before calibration get no drift verdict, only the window-free check for never-seen values."""
    values: dict[str, float] = {}
    unseen: dict[str, float] = {}
    for X, names in blocks:
        if len(X) and names:
            values.update(psi(profile, X, names))
            unseen.update(unseen_share(profile, X, names))
    if not values:
        return {}, []
    limits = {k: max(DRIFT_PSI_FLOOR, float(profile[k]["null_q99"][0])) for k in values if profile[k].get("null_q99")}
    drifted = sorted(((values[k] / v, k) for k, v in limits.items() if values[k] > v), reverse=True)
    broken = sorted(((v, k) for k, v in unseen.items() if v > 0.5), reverse=True)
    notes = []
    if limits and len(drifted) > 0.1 * len(limits):
        worst = ", ".join(k for _, k in drifted[:3])
        notes.append(
            f"dérive des variables face à l'entraînement : {len(drifted)} au-delà de leur seuil calibré ({worst})"
        )
    if broken:
        worst = ", ".join(k for _, k in broken[:3])
        notes.append(
            f"valeurs jamais vues à l'entraînement : {len(broken)} variables ({worst}), défaut de données probable"
        )
    risk = {
        "psi_max": round(max(values.values()), 3),
        "psi_drifted": float(len(drifted)),
        "psi_unseen": float(len(broken)),
        "psi_calibrated": float(bool(limits)),
        "psi_alert": float(bool(notes)),
    }
    return risk, notes
