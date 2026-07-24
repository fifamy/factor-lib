"""Historical point-in-time industry mappings shared by research stages."""
from __future__ import annotations

from pathlib import Path

import polars as pl


DEFAULT_HISTORY_PATH = Path(
    "资料/balance_sheet_interest_bearing_processed/parquet/sw_industry_history.parquet"
)


def build_pit_industry_map(history: pl.DataFrame, trade_dates: list) -> pl.DataFrame:
    """Expand Wind entry/removal intervals to the requested month-end dates."""
    if history.is_empty() or not trade_dates:
        return pl.DataFrame(schema={
            "trade_date": pl.Date,
            "stock_code": pl.Utf8,
            "industry_sw1": pl.Utf8,
        })
    base = history.select([
        pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
        pl.col("ENTRY_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("entry_date"),
        pl.col("REMOVE_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("remove_date"),
        pl.col("INDUSTRY_SW1").cast(pl.Utf8).str.strip_chars().alias("industry_sw1"),
    ]).filter(
        pl.col("stock_code").is_not_null()
        & pl.col("entry_date").is_not_null()
        & pl.col("industry_sw1").is_not_null()
        & (pl.col("industry_sw1").str.len_chars() > 0)
    )
    dates = pl.DataFrame({"trade_date": sorted(set(trade_dates))})
    return (
        base.join(dates, how="cross")
        .filter(
            (pl.col("entry_date") <= pl.col("trade_date"))
            & (pl.col("remove_date").is_null() | (pl.col("remove_date") > pl.col("trade_date")))
        )
        .sort(["stock_code", "trade_date", "entry_date"])
        .group_by(["trade_date", "stock_code"])
        .last()
        .select(["trade_date", "stock_code", "industry_sw1"])
    )


def load_industry_map(
    trade_dates: list,
    history_path: str | Path = DEFAULT_HISTORY_PATH,
    static_path: str | Path | None = None,
) -> pl.DataFrame:
    """Prefer PIT history; use the static descriptor only as an explicit fallback."""
    history_file = Path(history_path)
    if history_file.exists():
        return build_pit_industry_map(pl.read_parquet(history_file), trade_dates)
    if static_path is None:
        raise FileNotFoundError(f"industry history not found: {history_file}")
    static_file = Path(static_path)
    if not static_file.exists():
        raise FileNotFoundError(f"stock descriptors not found: {static_file}")
    return (
        pl.read_parquet(static_file, columns=["stock_code", "industry_sw1"])
        .filter(pl.col("industry_sw1").is_not_null() & (pl.col("industry_sw1").cast(pl.Utf8).str.len_chars() > 0))
        .unique("stock_code")
    )
