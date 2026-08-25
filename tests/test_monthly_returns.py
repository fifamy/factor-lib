from datetime import date

import polars as pl

from factor_lib.monthly_returns import make_forward_returns, valid_forward_return_expr
from scripts._monthly_returns import monthly_forward_return


def test_forward_returns_keep_extreme_losses_and_reject_skipped_calendar_months():
    panel = pl.DataFrame(
        {
            "stock_code": ["A", "A", "A", "A", "B", "B", "B"],
            "trade_date": [
                date(2024, 1, 31), date(2024, 2, 1), date(2024, 2, 29), date(2024, 3, 1),
                date(2024, 1, 31), date(2024, 4, 30), date(2024, 5, 1),
            ],
            "adj_close": [100.0, 100.0, 1.0, 1.0, 100.0, 110.0, 110.0],
            "market_cap": [100.0, 100.0, 1.0, 1.0, 100.0, 110.0, 110.0],
        }
    )

    out = make_forward_returns(panel, horizons=[1])

    a = out.filter((pl.col("stock_code") == "A") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    b = out.filter((pl.col("stock_code") == "B") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    assert abs(a["fwd_return"] + 0.99) < 1e-12
    assert a["entry_date"] == date(2024, 2, 1)
    assert a["return_date"] == date(2024, 3, 1)
    assert a["has_forward_return"] is True
    assert b["fwd_return"] is None
    assert b["has_forward_return"] is False


def test_valid_forward_return_expr_uses_shared_extreme_return_bounds():
    df = pl.DataFrame({"fwd_return": [-1.01, -1.0, -0.96, -0.95, 0.0, 5.0, 10.0, None]})

    out = df.with_columns(valid_forward_return_expr().alias("valid"))["valid"].to_list()

    assert out == [False, True, True, True, True, True, True, False]


def test_backtest_monthly_returns_keep_finite_extremes_with_shared_rule():
    panel = pl.DataFrame(
        {
            "stock_code": ["LOW"] * 4 + ["OK"] * 4 + ["HIGH"] * 4,
            "trade_date": [date(2024, 1, 31), date(2024, 2, 1), date(2024, 2, 29), date(2024, 3, 1)] * 3,
            "adj_close": [100.0, 100.0, 4.0, 4.0, 100.0, 100.0, 6.0, 6.0, 1.0, 1.0, 7.0, 7.0],
        }
    )

    _, monthly_ret = monthly_forward_return(panel)
    first_month = monthly_ret.filter(pl.col("trade_date") == date(2024, 1, 31))
    got = {row["stock_code"]: row for row in first_month.iter_rows(named=True)}

    assert abs(got["LOW"]["fwd_return"] + 0.96) < 1e-12
    assert got["LOW"]["has_forward_return"] is True
    assert abs(got["OK"]["fwd_return"] + 0.94) < 1e-12
    assert got["OK"]["has_forward_return"] is True
    assert abs(got["HIGH"]["fwd_return"] - 6.0) < 1e-12
    assert got["HIGH"]["has_forward_return"] is True
    high_quality = make_forward_returns(panel, horizons=[1]).filter(
        (pl.col("stock_code") == "HIGH") & (pl.col("trade_date") == date(2024, 1, 31))
    )["return_quality_flag"].item()
    assert high_quality == "extreme_positive_return"


def test_forward_returns_expose_and_invalidate_suspended_return_months():
    panel = pl.DataFrame(
        {
            "stock_code": ["A"] * 4 + ["B"] * 4,
            "trade_date": [date(2024, 1, 31), date(2024, 2, 1), date(2024, 2, 29), date(2024, 3, 1)] * 2,
            "adj_close": [100.0, 100.0, 110.0, 110.0, 100.0, 100.0, 105.0, 105.0],
            "is_suspended": [False, True, False, False, True, False, False, False],
        }
    )

    out = make_forward_returns(panel, horizons=[1])

    a = out.filter((pl.col("stock_code") == "A") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    b = out.filter((pl.col("stock_code") == "B") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    assert a["signal_is_suspended"] is False
    assert a["return_is_suspended"] is False
    assert a["entry_is_suspended"] is True
    assert a["fwd_return"] is None
    assert a["has_forward_return"] is False
    assert a["valid_return_reason"] == "entry_day_suspended"
    assert b["signal_is_suspended"] is True
    assert b["return_is_suspended"] is False
    assert b["entry_is_suspended"] is False
    assert b["fwd_return"] is None
    assert b["has_forward_return"] is False
    assert b["valid_return_reason"] == "signal_month_suspended"


def test_suspended_stock_does_not_defer_exit_to_its_resumption_date():
    panel = pl.DataFrame(
        {
            "stock_code": (
                ["ACTIVE"] * 8
                + ["HALTED"] * 6
            ),
            "trade_date": (
                [
                    date(2020, 6, 30), date(2020, 7, 1), date(2020, 7, 7),
                    date(2020, 7, 31), date(2020, 8, 3), date(2020, 8, 31),
                    date(2020, 9, 1), date(2020, 9, 21),
                ]
                + [
                    date(2020, 6, 30), date(2020, 7, 1), date(2020, 7, 7),
                    date(2020, 8, 31), date(2020, 9, 1), date(2020, 9, 21),
                ]
            ),
            "adj_close": [100, 101, 102, 103, 104, 105, 106, 107, 50, 50, 50, 50, 50, 60],
            "is_suspended": [False] * 8 + [False, True, True, True, True, False],
        }
    )

    out = make_forward_returns(panel, horizons=[1])
    halted_june = out.filter(
        (pl.col("stock_code") == "HALTED")
        & (pl.col("trade_date") == date(2020, 6, 30))
    ).row(0, named=True)

    # June EOD signal must exit at the first market trading day after July
    # month-end.  The stock has no quote that day, so the return is missing;
    # it must never be deferred to the September resumption date.
    assert halted_june["entry_date"] == date(2020, 7, 1)
    assert halted_june["return_date"] == date(2020, 8, 3)
    assert halted_june["fwd_return"] is None
    assert halted_june["valid_return_reason"] == "entry_day_suspended"
