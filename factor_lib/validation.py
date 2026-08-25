"""Reusable validation metrics for factor tests."""
from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime
import math

import numpy as np
from scipy.stats import spearmanr, t as student_t


def _finite_array(values: Iterable[float | None]) -> np.ndarray:
    arr = np.array([np.nan if v is None else v for v in values], dtype=float)
    return arr[np.isfinite(arr)]


def _coerce_date(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value)
    if len(text) == 7:
        text += "-01"
    try:
        return date.fromisoformat(text[:10])
    except ValueError as exc:
        raise ValueError(f"invalid return date: {value!r}") from exc


def _finite_returns_and_dates(
    returns: Iterable[float | None],
    dates: Iterable | None,
) -> tuple[np.ndarray, list[date] | None]:
    values = list(returns)
    if dates is None:
        return _finite_array(values), None
    date_values = list(dates)
    if len(values) != len(date_values):
        raise ValueError("returns and dates must have the same length")

    finite_returns: list[float] = []
    finite_dates: list[date] = []
    for value, dt in zip(values, date_values):
        numeric = np.nan if value is None else float(value)
        if not math.isfinite(numeric):
            continue
        if dt is None:
            raise ValueError("a finite return cannot have a missing date")
        finite_returns.append(numeric)
        finite_dates.append(_coerce_date(dt))
    return np.asarray(finite_returns, dtype=float), finite_dates


def _calendar_period_span(dates: list[date], periods_per_year: int) -> float:
    """返回从首个到最后一个收益期的完整日历期数（含首尾）。"""
    if not dates:
        return 0.0
    ordered = sorted(dates)
    if periods_per_year == 12:
        keys = [dt.year * 12 + dt.month for dt in ordered]
        if len(set(keys)) != len(keys):
            raise ValueError("monthly return dates must be unique by calendar month")
        return float(keys[-1] - keys[0] + 1)

    if len(set(ordered)) != len(ordered):
        raise ValueError("return dates must be unique")
    elapsed_years = (ordered[-1] - ordered[0]).days / 365.2425
    return max(1.0, elapsed_years * periods_per_year + 1.0)


def _observations_per_year(
    n_observations: int,
    dates: list[date] | None,
    periods_per_year: int,
) -> float:
    if not dates:
        return float(periods_per_year)
    span = _calendar_period_span(dates, periods_per_year)
    if span <= 0:
        return float(periods_per_year)
    return float(periods_per_year) * n_observations / span


def annualized_return(
    returns: Iterable[float | None],
    periods_per_year: int = 12,
    dates: Iterable | None = None,
) -> float | None:
    arr, finite_dates = _finite_returns_and_dates(returns, dates)
    if arr.size == 0:
        return None
    gross = float(np.prod(1.0 + arr))
    if gross < 0:
        return None
    if gross == 0:
        return -1.0
    elapsed_periods = (
        _calendar_period_span(finite_dates, periods_per_year)
        if finite_dates is not None
        else float(arr.size)
    )
    return gross ** (periods_per_year / elapsed_periods) - 1.0


def annualized_vol(
    returns: Iterable[float | None],
    periods_per_year: int = 12,
    dates: Iterable | None = None,
) -> float | None:
    arr, finite_dates = _finite_returns_and_dates(returns, dates)
    if arr.size < 2:
        return None
    frequency = _observations_per_year(int(arr.size), finite_dates, periods_per_year)
    return float(np.std(arr, ddof=1) * math.sqrt(frequency))


def safe_sharpe(ann_return: float | None, ann_vol: float | None) -> float | None:
    if ann_return is None or ann_vol is None:
        return None
    if not math.isfinite(ann_vol) or ann_vol <= 0:
        return None
    return float(ann_return / ann_vol)


def max_drawdown(returns: Iterable[float | None]) -> float | None:
    arr = _finite_array(returns)
    if arr.size == 0:
        return None
    nav = np.concatenate(([1.0], np.cumprod(1.0 + arr)))
    peak = np.maximum.accumulate(nav)
    drawdown = nav / peak - 1.0
    return float(np.min(drawdown))


def default_newey_west_lags(n_obs: int) -> int:
    """Andrews-style automatic lag count for monthly IC significance checks."""
    if n_obs < 2:
        return 0
    return max(0, int(math.floor(4.0 * (float(n_obs) / 100.0) ** (2.0 / 9.0))))


def newey_west_t_stat(
    values: Iterable[float | None],
    lags: int | None = None,
    min_lags: int = 0,
) -> float | None:
    arr = _finite_array(values)
    n = int(arr.size)
    if n < 2:
        return None
    mean = float(np.mean(arr))
    demeaned = arr - mean
    max_lag = n - 1
    lag_count = default_newey_west_lags(n) if lags is None else int(lags)
    lag_count = min(max(lag_count, int(min_lags), 0), max_lag)
    long_run_var = float(np.dot(demeaned, demeaned) / n)
    for lag in range(1, lag_count + 1):
        gamma = float(np.dot(demeaned[lag:], demeaned[:-lag]) / n)
        weight = 1.0 - lag / (lag_count + 1.0)
        long_run_var += 2.0 * weight * gamma
    if not math.isfinite(long_run_var) or long_run_var <= 0:
        return None
    se = math.sqrt(long_run_var / n)
    if se <= 0:
        return None
    return float(mean / se)


def two_sided_t_p_value(t_stat: float | None, df: int) -> float | None:
    if t_stat is None or not math.isfinite(float(t_stat)) or df < 1:
        return None
    return float(min(max(2.0 * student_t.sf(abs(float(t_stat)), int(df)), 0.0), 1.0))


def benjamini_hochberg_q_values(p_values: Iterable[float | None]) -> list[float | None]:
    values = list(p_values)
    finite_pairs = [
        (i, float(p))
        for i, p in enumerate(values)
        if p is not None and math.isfinite(float(p))
    ]
    if not finite_pairs:
        return [None for _ in values]
    finite_pairs.sort(key=lambda item: item[1])
    m = len(finite_pairs)
    out: list[float | None] = [None for _ in values]
    prev = 1.0
    for rank, (idx, p) in reversed(list(enumerate(finite_pairs, start=1))):
        q = min(prev, p * m / rank, 1.0)
        out[idx] = float(q)
        prev = q
    return out


def win_rate(returns: Iterable[float | None]) -> float | None:
    arr = _finite_array(returns)
    if arr.size == 0:
        return None
    return float(np.mean(arr > 0))


def monotonicity_spearman(group_returns: Iterable[float | None]) -> float | None:
    arr = _finite_array(group_returns)
    if arr.size < 2:
        return None
    x = np.arange(1, arr.size + 1, dtype=float)
    stat = spearmanr(x, arr).statistic
    return float(stat) if math.isfinite(stat) else None


def summarize_return_series(
    returns: Iterable[float | None],
    turnovers: Iterable[float | None] | None = None,
    periods_per_year: int = 12,
    dates: Iterable | None = None,
) -> dict[str, float | int | None]:
    ret_arr, finite_dates = _finite_returns_and_dates(returns, dates)
    ann_ret = annualized_return(ret_arr, periods_per_year=periods_per_year, dates=finite_dates)
    ann_vol = annualized_vol(ret_arr, periods_per_year=periods_per_year, dates=finite_dates)
    turn_arr = _finite_array(turnovers or [])
    avg_turn = float(np.mean(turn_arr)) if turn_arr.size else None
    frequency = _observations_per_year(int(ret_arr.size), finite_dates, periods_per_year)
    return {
        "ann_return": ann_ret,
        "ann_vol": ann_vol,
        "sharpe": safe_sharpe(ann_ret, ann_vol),
        "max_drawdown": max_drawdown(ret_arr),
        "month_win_rate": win_rate(ret_arr),
        "avg_turnover": avg_turn,
        "ann_turnover": (avg_turn * frequency) if avg_turn is not None else None,
        "n_months": int(ret_arr.size),
    }
