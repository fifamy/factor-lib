from __future__ import annotations

import polars as pl

from factor_lib.monthly_returns import _market_month_schedule


BENCHMARK_INDEX_CODES = {
    "000300.SH": "HS300",
    "000906.SH": "CSI800",
    "000905.SH": "CSI500",
    "000852.SH": "CSI1000",
    "932000.CSI": "CSI2000",
    "000510.SH": "CSIA500",
}


BENCHMARK_PERIOD_SCHEMA = {
    "signal_date": pl.Date,
    "entry_date": pl.Date,
    "return_date": pl.Date,
    "index_code": pl.Utf8,
    "entry_close": pl.Float64,
    "return_close": pl.Float64,
    "benchmark_return": pl.Float64,
}


def _empty_benchmark_periods() -> pl.DataFrame:
    return pl.DataFrame(schema=BENCHMARK_PERIOD_SCHEMA)


def build_benchmark_period_returns(
    panel: pl.DataFrame,
    index_prices: pl.DataFrame,
    *,
    wind_code_column: str = "wind_code",
    date_column: str = "trade_date",
    close_column: str = "close",
    index_code_map: dict[str, str] | None = None,
) -> pl.DataFrame:
    """Build benchmark returns on the portfolio's exact entry/exit dates.

    The stock portfolio is formed after a month-end EOD signal, enters at the
    next market trading-day close and exits at the next signal month's first
    trading-day close.  Benchmark comparison must use the same two dates; a
    month-end NAV return or a return keyed only by the exit month is not the
    same holding period.
    """
    if panel.is_empty() or index_prices.is_empty():
        return _empty_benchmark_periods()

    code_map = index_code_map or BENCHMARK_INDEX_CODES
    required = {wind_code_column, date_column, close_column}
    missing = sorted(required - set(index_prices.columns))
    if missing:
        raise ValueError(f"index_prices missing columns: {missing}")

    schedule = _market_month_schedule(panel).select(
        pl.col("month_id"),
        pl.col("trade_date").alias("signal_date"),
        pl.col("entry_date"),
    )
    periods = (
        schedule.with_columns((pl.col("month_id") + 1).alias("return_month_id"))
        .join(
            schedule.select(
                pl.col("month_id").alias("return_month_id"),
                pl.col("entry_date").alias("return_date"),
            ),
            on="return_month_id",
            how="left",
        )
        .drop("return_month_id")
        .drop_nulls(["entry_date", "return_date"])
    )

    prices = (
        index_prices.select(
            pl.col(wind_code_column).cast(pl.Utf8).str.strip_chars().alias("wind_code"),
            pl.col(date_column).cast(pl.Date, strict=False).alias("price_date"),
            pl.col(close_column).cast(pl.Float64, strict=False).alias("close"),
        )
        .filter(
            pl.col("wind_code").is_in(list(code_map))
            & pl.col("price_date").is_not_null()
            & pl.col("close").is_finite()
            & (pl.col("close") > 0)
        )
        .with_columns(pl.col("wind_code").replace_strict(code_map).alias("index_code"))
        .select(["index_code", "price_date", "close"])
    )
    conflicts = (
        prices.group_by(["index_code", "price_date"])
        .agg(pl.col("close").n_unique().alias("n_close"))
        .filter(pl.col("n_close") > 1)
    )
    if not conflicts.is_empty():
        raise ValueError(
            "index_prices contains conflicting duplicate closes: "
            f"{conflicts.head(5).to_dicts()}"
        )
    prices = prices.unique(["index_code", "price_date"], keep="last")

    indices = pl.DataFrame(
        {"index_code": list(code_map.values())},
        schema={"index_code": pl.Utf8},
    )
    entry_prices = prices.rename({"price_date": "entry_date", "close": "entry_close"})
    return_prices = prices.rename({"price_date": "return_date", "close": "return_close"})
    return (
        periods.join(indices, how="cross")
        .join(entry_prices, on=["index_code", "entry_date"], how="left")
        .join(return_prices, on=["index_code", "return_date"], how="left")
        .with_columns(
            pl.when(
                pl.col("entry_close").is_finite()
                & pl.col("return_close").is_finite()
                & (pl.col("entry_close") > 0)
            )
            .then(pl.col("return_close") / pl.col("entry_close") - 1.0)
            .otherwise(None)
            .alias("benchmark_return")
        )
        .select(list(BENCHMARK_PERIOD_SCHEMA))
        .sort(["index_code", "signal_date"])
    )
