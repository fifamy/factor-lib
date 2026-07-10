"""Shared monthly forward-return construction for validation scripts."""
from __future__ import annotations

import polars as pl

from factor_lib.monthly_returns import make_forward_returns, month_end_panel


def monthly_forward_return(panel: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    month_end = month_end_panel(panel)
    monthly_ret = make_forward_returns(panel, horizons=[1]).select(
        ["trade_date", "return_date", "stock_code", "fwd_return", "has_forward_return"]
    )
    return month_end, monthly_ret
