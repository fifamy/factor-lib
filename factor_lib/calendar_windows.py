from __future__ import annotations

from datetime import date
from math import sqrt


def month_id(value: date) -> int:
    return value.year * 12 + value.month


def month_distance(start: date, end: date) -> int:
    return month_id(end) - month_id(start)


def effective_annualization_scale(
    n_finite: int,
    start: date,
    end: date,
    horizon_months: int,
) -> float | None:
    if n_finite < 2 or horizon_months <= 0:
        return None
    span_months = max(1, month_distance(start, end) + 1)
    observations_per_year = min(12.0, n_finite * 12.0 / span_months)
    independent_frequency = observations_per_year / float(horizon_months)
    if independent_frequency <= 0:
        return None
    return sqrt(independent_frequency)
