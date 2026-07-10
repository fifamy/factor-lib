"""流动性类因子：STOM（月度对数换手率）。"""
from __future__ import annotations

from datetime import date, timedelta
import polars as pl

from factor_lib.registry import factor

MAX_STOM_CALENDAR_DAYS = 45
MIN_STOM_OBS = 15


@factor(
    code="STOM",
    l1="市场交易信息",
    l2="流动性",
    direction=-1,
    description="过去 21 个交易日换手率之和的对数。换手率 = 成交额 / S_DQ_MV。"
)
def stom(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    df = (
        panel.filter((pl.col("trade_date") <= asof) & (pl.col("trade_date") >= asof - timedelta(days=MAX_STOM_CALENDAR_DAYS)))
        .sort(["stock_code", "trade_date"])
        .with_columns(
            pl.when((pl.col("market_cap") > 0) & pl.col("market_cap").is_finite())
            .then(pl.col("amount") / pl.col("market_cap") / 10.0)
            .otherwise(None)
            .alias("turnover")
        )
        .with_columns(pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("_rk"))
        .filter(pl.col("_rk") <= 21)
        .filter((pl.col("turnover") > 0) & pl.col("turnover").is_finite())
        .group_by("stock_code")
        .agg([pl.col("turnover").sum().alias("_turnover_sum"), pl.len().alias("_n")])
        .filter(pl.col("_n") >= MIN_STOM_OBS)
        .with_columns(pl.col("_turnover_sum").log().alias("value"))
    )
    return df.select(["stock_code", "value"])
