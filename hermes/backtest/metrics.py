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


def autocorr_inflation(rets: np.ndarray, max_lag: int | None = None) -> float:
    """Newey-West variance inflation factor for the mean of a serially
    correlated return series.

    Consecutive bar returns are not independent: a position is held across
    many bars, and the hourly aux series (open interest, taker flow,
    positioning) are carried onto 15m bars, so four consecutive bars can
    share one observation of the driving variable. The iid standard error
    then understates the true one and every Sharpe-based statistic comes out
    overconfident — a strategy can show an OOS Sharpe of 10 while its real
    sampling uncertainty is several times wider.

    Bartlett weights keep the estimate non-negative. The result is floored at
    1.0 on purpose: this feeds a selection gate, so the correction may only
    ever make a strategy look worse. Negative autocorrelation is not paid out
    as a bonus.
    """
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    n = len(r)
    if n < 20:
        return 1.0
    if max_lag is None:                      # Newey-West automatic bandwidth
        max_lag = int(4.0 * (n / 100.0) ** (2.0 / 9.0))
    max_lag = int(max(1, min(max_lag, n // 4)))
    d = r - r.mean()
    denom = float(d @ d)
    if denom <= 0.0:
        return 1.0
    acc = 0.0
    for k in range(1, max_lag + 1):
        rho = float(d[k:] @ d[:-k]) / denom
        acc += (1.0 - k / (max_lag + 1.0)) * rho
    return float(min(max(1.0, 1.0 + 2.0 * acc), 100.0))


def effective_obs(rets: np.ndarray, inflation: float | None = None) -> float:
    """Independent-observation count implied by the serial correlation."""
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    if inflation is None:
        inflation = autocorr_inflation(r)
    return max(len(r) / inflation, 3.0)


def sharpe_hac(rets: np.ndarray, bars_per_year: int,
               inflation: float | None = None) -> float:
    """Annualised Sharpe with the serial-correlation haircut (Lo 2002).

    Lo's multi-period scaling factor is q / sqrt(q + 2*sum (q-k)*rho_k); once
    the autocorrelations die out well before q it reduces to sqrt(q / IF), so
    the iid figure is simply divided by sqrt(IF).
    """
    sr = sharpe(rets, bars_per_year)
    if sr == 0.0:
        return 0.0
    if inflation is None:
        inflation = autocorr_inflation(rets)
    return sr / math.sqrt(inflation)


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
                         bars_per_year: int,
                         inflation: float | None = None) -> float:
    """P(true SR > benchmark), accounting for skew/kurtosis and sample size.

    Serial correlation is charged twice over, because it does two distinct
    things: it lowers the Sharpe actually achievable over a long horizon
    (the haircut on `sr`) and it shrinks the independent sample the estimate
    rests on (`n_eff`).
    """
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    n = len(r)
    if n < 10 or r.std(ddof=1) == 0:
        return 0.0
    if inflation is None:
        inflation = autocorr_inflation(r)
    sr = r.mean() / r.std(ddof=1) / math.sqrt(inflation)   # per-bar SR
    sr_b = sr_benchmark_annual / math.sqrt(bars_per_year)
    mu, sd = r.mean(), r.std(ddof=1)
    skew = float(np.mean(((r - mu) / sd) ** 3))
    kurt = float(np.mean(((r - mu) / sd) ** 4))
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr * sr
    if denom <= 0:
        return 0.0
    n_eff = effective_obs(r, inflation)
    stat = (sr - sr_b) * math.sqrt(n_eff - 1) / math.sqrt(denom)
    return norm_cdf(stat)


def expected_max_sharpe(n_trials: int, n_obs: int) -> float:
    """Expected maximum per-bar SR among n_trials independent noise trials."""
    if n_trials < 2 or n_obs < 3:
        return 0.0
    z1 = norm_ppf(1.0 - 1.0 / n_trials)
    z2 = norm_ppf(1.0 - 1.0 / (n_trials * math.e))
    return math.sqrt(1.0 / (n_obs - 1)) * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)


def bars_for_selection_bar(n_trials: int, bars_per_year: int,
                           max_bar: float) -> int:
    """Independent observations needed before the selection bar falls to
    `max_bar` annualised Sharpe.

    The bar is K * sqrt(bars_per_year / (n - 1)) with K fixed by the trial
    count, so the sample length required to make selection noise fall below
    a given Sharpe has a closed form. Searching a window shorter than this
    cannot produce a survivor: no strategy that exists can beat a bar set
    above what any strategy achieves, so every candidate that clears the
    other gates is an overfit by construction.

    Note which term dominates. Going from 500 trials to 83,793 moves the bar
    by 43%; going from 1,900 bars to 21,000 moves it by 76%. Search budget is
    a lever on this; sample length is the lever.
    """
    if n_trials < 2 or max_bar <= 0 or bars_per_year <= 0:
        return 0
    z1 = norm_ppf(1.0 - 1.0 / n_trials)
    z2 = norm_ppf(1.0 - 1.0 / (n_trials * math.e))
    k = (1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2
    return int(math.ceil(1.0 + bars_per_year * k * k / (max_bar * max_bar)))


def selection_bar(rets: np.ndarray, n_trials: int, bars_per_year: int,
                  inflation: float | None = None) -> float:
    """Annualised Sharpe that selection alone is expected to produce.

    Searching `n_trials` genomes and keeping the best one produces a high
    Sharpe whether or not any edge exists. This is how high, for this sample
    length. A strategy scoring below it has shown nothing that picking the
    luckiest of the same search would not have shown — which is what a DSR
    below 0.5 says, in the units the rest of the report is written in.
    """
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    if len(r) < 10:
        return 0.0
    if inflation is None:
        inflation = autocorr_inflation(r)
    n_eff = int(effective_obs(r, inflation))
    return expected_max_sharpe(n_trials, n_eff) * math.sqrt(bars_per_year)


def deflated_sharpe(rets: np.ndarray, n_trials: int, bars_per_year: int,
                    inflation: float | None = None) -> float:
    """DSR: probability the strategy's SR beats the expected max SR that pure
    selection over `n_trials` random strategies would produce.

    The selection bar is set from the *effective* sample: fewer independent
    observations mean a luckier best-of-n_trials, so a serially correlated
    strategy must clear a higher bar, not the same one.

    This is a probability, and it is meant to be read as a confidence level:
    Bailey and Lopez de Prado deploy at 0.95. A gate set at 0.05 admits
    strategies that are 95% likely to be nothing but the luckiest draw of the
    search that found them.
    """
    r = np.asarray(rets, dtype=np.float64)
    r = r[np.isfinite(r)]
    if len(r) < 10:
        return 0.0
    if inflation is None:
        inflation = autocorr_inflation(r)
    sr0 = selection_bar(r, n_trials, bars_per_year, inflation)
    return probabilistic_sharpe(r, sr0, bars_per_year, inflation=inflation)


def summarize(rets: np.ndarray, equity: np.ndarray, bars_per_year: int,
              turnover: float = 0.0, n_trials: int = 1) -> dict:
    r = np.asarray(rets, dtype=np.float64)
    total = float(equity[-1] / equity[0] - 1.0) if len(equity) > 1 else 0.0
    years = max(len(r) / bars_per_year, 1e-9)
    cagr = (1.0 + total) ** (1.0 / years) - 1.0 if total > -1 else -1.0
    mdd = max_drawdown(equity)
    # one inflation estimate drives every downstream statistic, so the headline
    # Sharpe, the PSR and the DSR all describe the same effective sample
    infl = autocorr_inflation(r)
    return {
        "bars": int(len(r)),
        "total_return": total,
        "cagr": float(cagr),
        # headline Sharpe is the serial-correlation-corrected one: it is what
        # the validation gate compares and what a human reads
        "sharpe": sharpe_hac(r, bars_per_year, inflation=infl),
        "sharpe_iid": sharpe(r, bars_per_year),
        "autocorr_inflation": float(infl),
        "effective_bars": float(effective_obs(r, infl)),
        "sortino": sortino(r, bars_per_year),
        "max_drawdown": mdd,
        "calmar": float(cagr / mdd) if mdd > 1e-9 else 0.0,
        "psr": probabilistic_sharpe(r, 0.0, bars_per_year, inflation=infl),
        "dsr": deflated_sharpe(r, n_trials, bars_per_year, inflation=infl),
        # the DSR in Sharpe units: what the search alone was expected to
        # produce on a sample this long, so the gap is readable at a glance
        "selection_bar": selection_bar(r, n_trials, bars_per_year, infl),
        "n_trials": int(n_trials),
        "turnover_per_bar": float(turnover),
    }
