from datetime import date

import polars as pl

from factor_lib.monthly_returns import make_forward_returns, valid_forward_return_expr
from scripts._monthly_returns import monthly_forward_return


def test_forward_returns_keep_extreme_losses_and_reject_skipped_calendar_months():
    panel = pl.DataFrame(
        {
            "stock_code": ["A", "A", "B", "B"],
            "trade_date": [date(2024, 1, 31), date(2024, 2, 29), date(2024, 1, 31), date(2024, 4, 30)],
            "adj_close": [100.0, 1.0, 100.0, 110.0],
            "market_cap": [100.0, 1.0, 100.0, 110.0],
        }
    )

    out = make_forward_returns(panel, horizons=[1])

    a = out.filter((pl.col("stock_code") == "A") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    b = out.filter((pl.col("stock_code") == "B") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    assert abs(a["fwd_return"] + 0.99) < 1e-12
    assert a["has_forward_return"] is True
    assert b["fwd_return"] is None
    assert b["has_forward_return"] is False


def test_valid_forward_return_expr_uses_shared_extreme_return_bounds():
    df = pl.DataFrame({"fwd_return": [-1.0, -0.96, -0.95, -0.949, 0.0, 4.99, 5.0, None]})

    out = df.with_columns(valid_forward_return_expr().alias("valid"))["valid"].to_list()

    assert out == [False, False, False, True, True, True, False, False]


def test_backtest_monthly_returns_mask_extremes_with_shared_bounds():
    panel = pl.DataFrame(
        {
            "stock_code": ["LOW", "LOW", "OK", "OK", "HIGH", "HIGH"],
            "trade_date": [date(2024, 1, 31), date(2024, 2, 29)] * 3,
            "adj_close": [100.0, 4.0, 100.0, 6.0, 1.0, 7.0],
        }
    )

    _, monthly_ret = monthly_forward_return(panel)
    first_month = monthly_ret.filter(pl.col("trade_date") == date(2024, 1, 31))
    got = {row["stock_code"]: row for row in first_month.iter_rows(named=True)}

    assert got["LOW"]["fwd_return"] is None
    assert got["LOW"]["has_forward_return"] is False
    assert abs(got["OK"]["fwd_return"] + 0.94) < 1e-12
    assert got["OK"]["has_forward_return"] is True
    assert got["HIGH"]["fwd_return"] is None
    assert got["HIGH"]["has_forward_return"] is False


def test_forward_returns_expose_and_invalidate_suspended_return_months():
    panel = pl.DataFrame(
        {
            "stock_code": ["A", "A", "B", "B"],
            "trade_date": [date(2024, 1, 31), date(2024, 2, 29), date(2024, 1, 31), date(2024, 2, 29)],
            "adj_close": [100.0, 110.0, 100.0, 105.0],
            "is_suspended": [False, True, True, False],
        }
    )

    out = make_forward_returns(panel, horizons=[1])

    a = out.filter((pl.col("stock_code") == "A") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    b = out.filter((pl.col("stock_code") == "B") & (pl.col("trade_date") == date(2024, 1, 31))).row(0, named=True)
    assert a["signal_is_suspended"] is False
    assert a["return_is_suspended"] is True
    assert a["fwd_return"] is None
    assert a["has_forward_return"] is False
    assert a["valid_return_reason"] == "return_month_suspended"
    assert b["signal_is_suspended"] is True
    assert b["return_is_suspended"] is False
    assert b["fwd_return"] is None
    assert b["has_forward_return"] is False
    assert b["valid_return_reason"] == "signal_month_suspended"
