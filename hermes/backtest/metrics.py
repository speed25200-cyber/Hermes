"""Performance metrics, including Probabilistic and Deflated Sharpe Ratios
(Bailey & Lopez de Prado) to penalise multiple-testing / selection bias.
No scipy dependency: normal CDF via erf, inverse CDF via Acklam's algorithm.
"""

from __future__ import annotations

import math

import numpy as np

EULER_GAMMA = 0.5772156649015329


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_ppf(p: float) -> float:
    """Inverse normal CDF (Acklam's rational approximation)."""
    if not 0.0 < p < 1.0:
        raise ValueError("p must be in (0, 1)")
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
                ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def sharpe(rets: np.ndarray, bars_per_year: int) -> float:
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    if len(r) < 2 or r.std(ddof=1) == 0:
        return 0.0
    return float(r.mean() / r.std(ddof=1) * math.sqrt(bars_per_year))


def sortino(rets: np.ndarray, bars_per_year: int) -> float:
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    downside = r[r < 0]
    if len(r) < 2 or len(downside) == 0 or downside.std(ddof=1) == 0:
        return 0.0
    return float(r.mean() / downside.std(ddof=1) * math.sqrt(bars_per_year))


def max_drawdown(equity: np.ndarray) -> float:
    """Max drawdown as a positive fraction (0.2 == -20%)."""
    eq = np.asarray(equity, dtype=np.float64)
    if len(eq) == 0:
        return 0.0
    peak = np.maximum.accumulate(eq)
    dd = 1.0 - eq / peak
    return float(np.nanmax(dd))


def probabilistic_sharpe(rets: np.ndarray, sr_benchmark_annual: float,
                         bars_per_year: int) -> float:
    """P(true SR > benchmark), accounting for skew/kurtosis and sample size."""
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    n = len(r)
    if n < 10 or r.std(ddof=1) == 0:
        return 0.0
    sr = r.mean() / r.std(ddof=1)                       # per-bar SR
    sr_b = sr_benchmark_annual / math.sqrt(bars_per_year)
    mu, sd = r.mean(), r.std(ddof=1)
    skew = float(np.mean(((r - mu) / sd) ** 3))
    kurt = float(np.mean(((r - mu) / sd) ** 4))
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr * sr
    if denom <= 0:
        return 0.0
    stat = (sr - sr_b) * math.sqrt(n - 1) / math.sqrt(denom)
    return norm_cdf(stat)


def expected_max_sharpe(n_trials: int, n_obs: int) -> float:
    """Expected maximum per-bar SR among n_trials independent noise trials."""
    if n_trials < 2 or n_obs < 3:
        return 0.0
    z1 = norm_ppf(1.0 - 1.0 / n_trials)
    z2 = norm_ppf(1.0 - 1.0 / (n_trials * math.e))
    return math.sqrt(1.0 / (n_obs - 1)) * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)


def deflated_sharpe(rets: np.ndarray, n_trials: int, bars_per_year: int) -> float:
    """DSR: probability the strategy's SR beats the expected max SR that pure
    selection over `n_trials` random strategies would produce."""
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    if len(r) < 10:
        return 0.0
    sr0 = expected_max_sharpe(n_trials, len(r)) * math.sqrt(bars_per_year)
    return probabilistic_sharpe(r, sr0, bars_per_year)


def summarize(rets: np.ndarray, equity: np.ndarray, bars_per_year: int,
              turnover: float = 0.0, n_trials: int = 1) -> dict:
    r = np.asarray(rets, dtype=np.float64)
    total = float(equity[-1] / equity[0] - 1.0) if len(equity) > 1 else 0.0
    years = max(len(r) / bars_per_year, 1e-9)
    cagr = (1.0 + total) ** (1.0 / years) - 1.0 if total > -1 else -1.0
    mdd = max_drawdown(equity)
    return {
        "bars": int(len(r)),
        "total_return": total,
        "cagr": float(cagr),
        "sharpe": sharpe(r, bars_per_year),
        "sortino": sortino(r, bars_per_year),
        "max_drawdown": mdd,
        "calmar": float(cagr / mdd) if mdd > 1e-9 else 0.0,
        "psr": probabilistic_sharpe(r, 0.0, bars_per_year),
        "dsr": deflated_sharpe(r, n_trials, bars_per_year),
        "turnover_per_bar": float(turnover),
    }
