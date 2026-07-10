from datetime import date

from factor_lib.calendar_windows import effective_annualization_scale, month_distance


def test_month_distance_uses_calendar_months():
    assert month_distance(date(2024, 1, 31), date(2024, 2, 29)) == 1
    assert month_distance(date(2024, 1, 31), date(2025, 1, 31)) == 12


def test_effective_annualization_scale_respects_sparse_events():
    scale = effective_annualization_scale(
        n_finite=4,
        start=date(2024, 1, 31),
        end=date(2024, 12, 31),
        horizon_months=1,
    )
    assert abs(scale - 2.0) < 1e-12
