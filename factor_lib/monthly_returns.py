from __future__ import annotations

import polars as pl

# A realised long-only total return cannot be below -100%.  Keep an observed
# -100% return (for example a genuine terminal loss) instead of silently
# turning it into a missing observation.  The upper bound remains a shared
# data-quality guard and is applied identically by IC and portfolio code.
MIN_VALID_FORWARD_RETURN = -1.0
# Retain the old public constant for compatibility with callers, but do not
# impose a hard positive-return cutoff.  Large finite returns stay in both IC
# and portfolios and are separately flagged for data-quality review.
MAX_VALID_FORWARD_RETURN = float("inf")
EXTREME_FORWARD_RETURN_WARNING = 5.0


def valid_forward_return_expr(column: str = "fwd_return") -> pl.Expr:
    value = pl.col(column)
    return (
        value.is_not_null()
        & value.is_finite()
        & (value >= MIN_VALID_FORWARD_RETURN)
    )


def _month_id_expr(name: str) -> pl.Expr:
    return pl.col(name).dt.year() * 12 + pl.col(name).dt.month()


def _market_month_schedule(panel: pl.DataFrame) -> pl.DataFrame:
    """Return the global market month-end and next-trading-day schedule.

    Entry/exit dates are market calendar dates, not the next row observed for
    each stock.  A suspended stock may have no rows for weeks or months; using
    its own next row would silently defer execution until the resumption date
    and make one rebalance period overlap later calendar periods.
    """
    calendar = panel.select("trade_date").drop_nulls().unique().sort("trade_date")
    next_dates = calendar.with_columns(
        pl.col("trade_date").shift(-1).alias("entry_date")
    )
    return (
        calendar.with_columns([
            pl.col("trade_date").dt.year().alias("_year"),
            pl.col("trade_date").dt.month().alias("_month"),
        ])
        .group_by(["_year", "_month"], maintain_order=True)
        .agg(pl.col("trade_date").max().alias("trade_date"))
        .join(next_dates, on="trade_date", how="left")
        .with_columns(_month_id_expr("trade_date").alias("month_id"))
        .sort("trade_date")
    )


def month_end_panel(panel: pl.DataFrame) -> pl.DataFrame:
    panel = panel.sort(["stock_code", "trade_date"])
    schedule = _market_month_schedule(panel)

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
    monthly = (
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
    )
    # Only a row observed on the global market month-end is a tradable EOD
    # signal.  Joining on the exact signal date leaves earlier stale rows with
    # a null entry date instead of treating their following row as execution.
    monthly = monthly.join(
        schedule.select(["trade_date", "entry_date"]),
        on="trade_date",
        how="left",
    )
    entry_values = panel.select([
        "stock_code",
        pl.col("trade_date").alias("entry_date"),
        pl.col("adj_close").alias("entry_close"),
        *(
            [pl.col("is_suspended").alias("entry_is_suspended")]
            if "is_suspended" in panel.columns
            else []
        ),
    ])
    monthly = monthly.join(entry_values, on=["stock_code", "entry_date"], how="left")
    return monthly.sort(["stock_code", "trade_date"])


def make_forward_returns(panel: pl.DataFrame, horizons: list[int]) -> pl.DataFrame:
    base = month_end_panel(panel)
    if "is_suspended" not in base.columns:
        base = base.with_columns([
            pl.lit(False).alias("is_suspended"),
            pl.lit(False).alias("entry_is_suspended"),
        ])
    schedule = _market_month_schedule(panel).select([
        pl.col("month_id").alias("return_month_id"),
        pl.col("entry_date").alias("return_date"),
    ])
    return_values = panel.select([
        "stock_code",
        pl.col("trade_date").alias("return_date"),
        pl.col("adj_close").alias("return_close"),
        *(
            [pl.col("is_suspended").alias("return_is_suspended")]
            if "is_suspended" in panel.columns
            else [pl.lit(False).alias("return_is_suspended")]
        ),
    ])
    frames = []
    for horizon in horizons:
        ret = (
            base.with_columns(
                [
                    pl.col("is_suspended").fill_null(False).alias("signal_is_suspended"),
                    pl.col("entry_is_suspended").fill_null(False).alias("entry_is_suspended"),
                    (pl.col("month_id") + horizon).alias("return_month_id"),
                ]
            )
            .join(schedule, on="return_month_id", how="left")
            .join(return_values, on=["stock_code", "return_date"], how="left")
            .with_columns([
                pl.col("return_is_suspended").fill_null(False).alias("return_is_suspended"),
                (pl.col("return_close") / pl.col("entry_close") - 1).alias("raw_fwd_return"),
            ])
            .with_columns(
                pl.when(pl.col("return_date").is_not_null())
                .then(pl.col("return_month_id") - pl.col("month_id"))
                .otherwise(None)
                .alias("month_step")
            )
            .with_columns(
                pl.when(
                    (pl.col("month_step") == horizon)
                    & pl.col("raw_fwd_return").is_finite()
                    & pl.col("entry_date").is_not_null()
                    & pl.col("return_date").is_not_null()
                    & ~pl.col("signal_is_suspended")
                    & ~pl.col("entry_is_suspended")
                    & ~pl.col("return_is_suspended")
                )
                .then(pl.col("raw_fwd_return"))
                .otherwise(None)
                .alias("fwd_return")
            )
            .with_columns(
                pl.when(pl.col("signal_is_suspended"))
                .then(pl.lit("signal_month_suspended"))
                .when(pl.col("entry_date").is_null())
                .then(pl.lit("missing_entry_date"))
                .when(pl.col("entry_close").is_null())
                .then(pl.lit("missing_entry_price"))
                .when(pl.col("entry_is_suspended"))
                .then(pl.lit("entry_day_suspended"))
                .when(pl.col("return_date").is_null())
                .then(pl.lit("missing_exit_date"))
                .when(pl.col("return_close").is_null())
                .then(pl.lit("missing_exit_price"))
                .when(pl.col("return_is_suspended"))
                .then(pl.lit("return_month_suspended"))
                .when(pl.col("month_step").is_null() | (pl.col("month_step") != horizon))
                .then(pl.lit("missing_forward_month"))
                .when(pl.col("raw_fwd_return").is_null() | ~pl.col("raw_fwd_return").is_finite())
                .then(pl.lit("invalid_price"))
                .otherwise(pl.lit("ok"))
                .alias("valid_return_reason")
            )
            .with_columns(
                pl.when(pl.col("fwd_return").is_null())
                .then(pl.lit("unavailable"))
                .when(pl.col("raw_fwd_return") >= EXTREME_FORWARD_RETURN_WARNING)
                .then(pl.lit("extreme_positive_return"))
                .when(pl.col("raw_fwd_return") <= -0.95)
                .then(pl.lit("extreme_negative_return"))
                .otherwise(pl.lit("ok"))
                .alias("return_quality_flag")
            )
        )
        frames.append(
            ret.select(
                [
                    "trade_date",
                    "entry_date",
                    "return_date",
                    "stock_code",
                    "fwd_return",
                    pl.lit(horizon).alias("horizon_months"),
                    pl.col("fwd_return").is_not_null().alias("has_forward_return"),
                    "month_step",
                    "signal_is_suspended",
                    "entry_is_suspended",
                    "return_is_suspended",
                    "valid_return_reason",
                    "return_quality_flag",
                ]
            )
        )
    return pl.concat(frames, how="vertical")
