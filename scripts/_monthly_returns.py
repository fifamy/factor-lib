"""Shared monthly forward-return construction for validation scripts."""
from __future__ import annotations

import polars as pl

from factor_lib.monthly_returns import (
    make_forward_returns,
    month_end_panel,
    valid_forward_return_expr,
)


def monthly_forward_return(panel: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    month_end = month_end_panel(panel)
    monthly_ret = (
        make_forward_returns(panel, horizons=[1])
        .with_columns(valid_forward_return_expr().alias("_valid_forward_return"))
        .with_columns(
            [
                pl.when(pl.col("_valid_forward_return"))
                .then(pl.col("fwd_return"))
                .otherwise(None)
                .alias("fwd_return"),
                pl.col("_valid_forward_return").alias("has_forward_return"),
            ]
        )
        .select(
            ["trade_date", "return_date", "stock_code", "fwd_return", "has_forward_return"]
        )
    )
    return month_end, monthly_ret
