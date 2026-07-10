from __future__ import annotations

import polars as pl

MIN_VALID_FORWARD_RETURN = -0.95
MAX_VALID_FORWARD_RETURN = 5.0


def valid_forward_return_expr(column: str = "fwd_return") -> pl.Expr:
    value = pl.col(column)
    return (
        value.is_not_null()
        & value.is_finite()
        & (value > MIN_VALID_FORWARD_RETURN)
        & (value < MAX_VALID_FORWARD_RETURN)
    )


def _month_id_expr(name: str) -> pl.Expr:
    return pl.col(name).dt.year() * 12 + pl.col(name).dt.month()


def month_end_panel(panel: pl.DataFrame) -> pl.DataFrame:
    aggregations = [
        pl.col("trade_date").max().alias("trade_date"),
        pl.col("adj_close").last().alias("month_close"),
    ]
    if "market_cap" in panel.columns:
        aggregations.append(pl.col("market_cap").last().alias("market_cap"))
    if "amount" in panel.columns:
        aggregations.append(pl.col("amount").mean().alias("avg_amount_month"))
    if "is_suspended" in panel.columns:
        aggregations.append(pl.col("is_suspended").last().alias("is_suspended"))

    return (
        panel.with_columns(
            [
                pl.col("trade_date").dt.year().alias("_year"),
                pl.col("trade_date").dt.month().alias("_month"),
            ]
        )
        .sort(["stock_code", "trade_date"])
        .group_by(["stock_code", "_year", "_month"], maintain_order=True)
        .agg(aggregations)
        .with_columns(_month_id_expr("trade_date").alias("month_id"))
        .sort(["stock_code", "trade_date"])
    )


def make_forward_returns(panel: pl.DataFrame, horizons: list[int]) -> pl.DataFrame:
    base = month_end_panel(panel)
    if "is_suspended" not in base.columns:
        base = base.with_columns(pl.lit(False).alias("is_suspended"))
    frames = []
    for horizon in horizons:
        ret = (
            base.with_columns(
                [
                    pl.col("is_suspended").fill_null(False).alias("signal_is_suspended"),
                    pl.col("is_suspended")
                    .shift(-horizon)
                    .over("stock_code")
                    .fill_null(False)
                    .alias("return_is_suspended"),
                    pl.col("trade_date").shift(-horizon).over("stock_code").alias("return_date"),
                    pl.col("month_id").shift(-horizon).over("stock_code").alias("return_month_id"),
                    (pl.col("month_close").shift(-horizon).over("stock_code") / pl.col("month_close") - 1).alias(
                        "raw_fwd_return"
                    ),
                ]
            )
            .with_columns((pl.col("return_month_id") - pl.col("month_id")).alias("month_step"))
            .with_columns(
                pl.when(
                    (pl.col("month_step") == horizon)
                    & pl.col("raw_fwd_return").is_finite()
                    & ~pl.col("signal_is_suspended")
                    & ~pl.col("return_is_suspended")
                )
                .then(pl.col("raw_fwd_return"))
                .otherwise(None)
                .alias("fwd_return")
            )
            .with_columns(
                pl.when(pl.col("signal_is_suspended"))
                .then(pl.lit("signal_month_suspended"))
                .when(pl.col("return_is_suspended"))
                .then(pl.lit("return_month_suspended"))
                .when(pl.col("month_step").is_null() | (pl.col("month_step") != horizon))
                .then(pl.lit("missing_forward_month"))
                .when(pl.col("raw_fwd_return").is_null() | ~pl.col("raw_fwd_return").is_finite())
                .then(pl.lit("invalid_price"))
                .otherwise(pl.lit("ok"))
                .alias("valid_return_reason")
            )
        )
        frames.append(
            ret.select(
                [
                    "trade_date",
                    "return_date",
                    "stock_code",
                    "fwd_return",
                    pl.lit(horizon).alias("horizon_months"),
                    pl.col("fwd_return").is_not_null().alias("has_forward_return"),
                    "month_step",
                    "signal_is_suspended",
                    "return_is_suspended",
                    "valid_return_reason",
                ]
            )
        )
    return pl.concat(frames, how="vertical")
