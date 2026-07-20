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
    formula="STOM = ln(sum(TURN_d, 最长21个交易日))，至少15个有效换手日；TURN = S_DQ_AMOUNT / S_DQ_MV / 10。",
    wind_source="AShareEODPrices.S_DQ_AMOUNT; AShareEODDerivativeIndicator.S_DQ_MV",
    description="最长21个交易日换手率之和的对数，至少需要15个有效换手日。"
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
