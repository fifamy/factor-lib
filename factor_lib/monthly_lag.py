from __future__ import annotations

import polars as pl


def month_id_expr(date_col: str = "trade_date") -> pl.Expr:
    return pl.col(date_col).dt.year() * 12 + pl.col(date_col).dt.month()


def with_strict_month_lag(
    df: pl.DataFrame,
    value_col: str,
    periods: int = 1,
    lag_col: str = "_prev",
    date_col: str = "trade_date",
    by: str | list[str] | None = "stock_code",
) -> pl.DataFrame:
    if periods <= 0:
        raise ValueError("periods must be positive")
    by_cols = [] if by is None else ([by] if isinstance(by, str) else list(by))
    sort_cols = by_cols + [date_col]
    month_col = "__strict_month_id"
    prev_month_col = "__strict_prev_month_id"

    value_shift = pl.col(value_col).shift(periods)
    month_shift = pl.col(month_col).shift(periods)
    if by is not None:
        value_shift = value_shift.over(by)
        month_shift = month_shift.over(by)

    return (
        df.with_columns(month_id_expr(date_col).alias(month_col))
        .sort(sort_cols)
        .with_columns([
            value_shift.alias(lag_col),
            month_shift.alias(prev_month_col),
        ])
        .with_columns(
            pl.when((pl.col(month_col) - pl.col(prev_month_col)) == periods)
            .then(pl.col(lag_col))
            .otherwise(None)
            .alias(lag_col)
        )
        .drop([month_col, prev_month_col])
    )
