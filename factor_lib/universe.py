"""Reusable stock-universe filters for factor tests and exports."""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from factor_lib.word_categories import word_category_for_factor

MIN_LISTING_TRADING_DAYS = 120
COMPANY_LISTING_CALENDAR_DAYS = 183
STAR_BJ_LISTING_CALENDAR_DAYS = 365
MARKET_LISTING_CALENDAR_DAYS = 183
EVENT_LISTING_TRADING_DAYS = 60
COMPANY_MIN_AVG_AMOUNT_20D = 200.0  # Wind S_DQ_AMOUNT is in thousand CNY; 200 == 200k CNY.
MARKET_BOTTOM_LIQUIDITY_Q = 0.05
DEFAULT_ST_HISTORY_PATH = Path(
    "资料/word_only_factor_data_direct_only_processed/parquet/st_event_ext.parquet"
)
_ST_HISTORY_COLUMNS = {"S_INFO_WINDCODE", "S_TYPE_ST", "ENTRY_DT", "REMOVE_DT"}


@dataclass(frozen=True)
class WordUniverseProfile:
    """Executable subset of the Word stock-pool rules."""

    name: str
    listing_rule: str
    liquidity_rule: str


WORD_COMPANY_PROFILE = WordUniverseProfile(
    name="company",
    listing_rule="star_bj_1y_other_6m",
    liquidity_rule="avg_amount_20d_ge_200k",
)
WORD_MARKET_PROFILE = WordUniverseProfile(
    name="market",
    listing_rule="all_6m",
    liquidity_rule="avg_amount_20d_not_bottom_5pct",
)
WORD_EVENT_PROFILE = WordUniverseProfile(
    name="event",
    listing_rule="60_trading_days",
    liquidity_rule="none",
)


def word_universe_profile_for_factor(code: str, meta: dict | None = None) -> WordUniverseProfile:
    """Return the Word v2 universe profile for a factor code.

    Word has factor-specific invalid-value rules, but the executable stock-pool
    baseline maps cleanly to three profiles: company, market/investor, and event.
    """
    l1, _ = word_category_for_factor(code, meta or {"l1": "", "l2": ""})
    if l1 == "事件驱动信息":
        return WORD_EVENT_PROFILE
    if l1 == "公司内生信息":
        return WORD_COMPANY_PROFILE
    return WORD_MARKET_PROFILE


def eligible_stock_dates(
    panel: pl.DataFrame,
    min_listing_trading_days: int = MIN_LISTING_TRADING_DAYS,
) -> pl.DataFrame:
    """Return (trade_date, stock_code) rows eligible after enough trading history.

    The first eligible date is the stock's Nth observed trading date in price_panel,
    with N = min_listing_trading_days. This uses trading observations, not calendar
    days, so newly listed stocks cannot enter portfolios before they have enough
    live trading history.
    """
    if panel.is_empty():
        return pl.DataFrame({"trade_date": [], "stock_code": []})
    return (
        panel.select(["stock_code", "trade_date"])
        .unique()
        .sort(["stock_code", "trade_date"])
        .with_columns(
            pl.col("trade_date")
            .cum_count()
            .over("stock_code")
            .alias("_trading_day_no")
        )
        .filter(pl.col("_trading_day_no") >= min_listing_trading_days)
        .select(["trade_date", "stock_code"])
    )


def _empty_universe() -> pl.DataFrame:
    return pl.DataFrame(schema={"trade_date": pl.Date, "stock_code": pl.Utf8})


def _with_daily_features(panel: pl.DataFrame) -> pl.DataFrame:
    if panel.is_empty():
        return panel
    required = {"stock_code", "trade_date"}
    missing = required - set(panel.columns)
    if missing:
        raise ValueError(f"panel missing required columns: {sorted(missing)}")
    out = panel.select([
        "stock_code",
        "trade_date",
        *([c for c in ["amount", "is_suspended"] if c in panel.columns]),
    ])
    if "amount" not in out.columns:
        out = out.with_columns(pl.lit(None).cast(pl.Float64).alias("amount"))
    if "is_suspended" not in out.columns:
        out = out.with_columns(pl.lit(False).alias("is_suspended"))
    return (
        out.sort(["stock_code", "trade_date"])
        .with_columns([
            pl.col("amount").cast(pl.Float64, strict=False).alias("amount"),
            pl.col("is_suspended").fill_null(True).alias("is_suspended"),
            pl.col("trade_date").first().over("stock_code").alias("first_trade_date"),
            pl.col("trade_date").cum_count().over("stock_code").alias("trading_day_no"),
            pl.col("amount").rolling_mean(window_size=20, min_samples=1).over("stock_code").alias("avg_amount_20d"),
        ])
    )


def _with_meta_filters(daily: pl.DataFrame, meta: pl.DataFrame | None) -> pl.DataFrame:
    if daily.is_empty():
        return daily
    if meta is None or meta.is_empty():
        return daily.with_columns(
            (pl.col("trade_date") - pl.col("first_trade_date"))
            .dt.total_days()
            .alias("listing_calendar_days")
        )
    # ``stock_meta.is_st`` is a latest-name snapshot and must never be applied
    # to historical dates.  Historical ST eligibility is attached separately
    # from Wind's entry/removal intervals in ``_with_pit_st_filter``.
    keep_cols = ["stock_code", *([c for c in ["list_date"] if c in meta.columns])]
    m = meta.select(keep_cols).unique("stock_code")
    if "list_date" not in m.columns:
        m = m.with_columns(pl.lit(None).cast(pl.Date).alias("list_date"))
    return (
        daily.join(m, on="stock_code", how="left")
        .with_columns([
            pl.coalesce([pl.col("list_date").cast(pl.Date, strict=False), pl.col("first_trade_date")]).alias("_listing_date"),
        ])
        .with_columns(
            (pl.col("trade_date") - pl.col("_listing_date")).dt.total_days().alias("listing_calendar_days")
        )
        .drop(["list_date", "_listing_date"])
    )


def _load_st_history(
    st_history: pl.DataFrame | None,
    st_history_path: str | Path,
) -> pl.DataFrame:
    """Load the required PIT ST interval table.

    Passing an explicit DataFrame (including an empty one) is reserved for
    controlled fixtures.  Production callers omit it and therefore fail with a
    clear error when the PIT source is unavailable instead of silently falling
    back to today's stock name.
    """
    if st_history is None:
        path = Path(st_history_path)
        if not path.exists():
            raise FileNotFoundError(
                f"PIT ST history not found: {path}; historical universe cannot use stock_meta.is_st"
            )
        st_history = pl.read_parquet(path)
    if st_history.is_empty():
        return st_history
    missing = _ST_HISTORY_COLUMNS - set(st_history.columns)
    if missing:
        raise ValueError(f"PIT ST history missing required columns: {sorted(missing)}")
    return st_history


def _st_transitions(st_history: pl.DataFrame) -> pl.DataFrame:
    """Convert possibly-overlapping ST intervals into per-stock state changes."""
    if st_history.is_empty():
        return pl.DataFrame(schema={
            "stock_code": pl.Utf8,
            "effective_date": pl.Date,
            "_active_st_count": pl.Int64,
        })
    intervals = (
        st_history.select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("S_TYPE_ST").cast(pl.Utf8).str.strip_chars().alias("st_type"),
            pl.col("ENTRY_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("entry_date"),
            pl.col("REMOVE_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("remove_date"),
        ])
        # Wind R means resumption/relisting, not an ST restriction interval.
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("entry_date").is_not_null()
            & (pl.col("st_type") != "R")
            & (pl.col("remove_date").is_null() | (pl.col("remove_date") > pl.col("entry_date")))
        )
    )
    entries = intervals.select([
        "stock_code",
        pl.col("entry_date").alias("effective_date"),
        pl.lit(1, dtype=pl.Int64).alias("_delta"),
    ])
    removals = intervals.drop_nulls("remove_date").select([
        "stock_code",
        pl.col("remove_date").alias("effective_date"),
        pl.lit(-1, dtype=pl.Int64).alias("_delta"),
    ])
    return (
        pl.concat([entries, removals], how="vertical")
        .group_by(["stock_code", "effective_date"])
        .agg(pl.col("_delta").sum())
        .sort(["stock_code", "effective_date"])
        .with_columns(
            pl.col("_delta").cum_sum().over("stock_code").alias("_active_st_count")
        )
        .drop("_delta")
    )


def _with_pit_st_filter(daily: pl.DataFrame, st_history: pl.DataFrame) -> pl.DataFrame:
    if daily.is_empty():
        return daily.with_columns(pl.lit(False).alias("is_st"))
    transitions = _st_transitions(st_history)
    if transitions.is_empty():
        return daily.with_columns(pl.lit(False).alias("is_st"))
    return (
        daily.sort(["stock_code", "trade_date"])
        .join_asof(
            transitions,
            left_on="trade_date",
            right_on="effective_date",
            by="stock_code",
            strategy="backward",
            check_sortedness=False,
        )
        .with_columns(
            (pl.col("_active_st_count").fill_null(0) > 0).alias("is_st")
        )
        .drop(["effective_date", "_active_st_count"])
    )


def _non_suspended_expr() -> pl.Expr:
    return (~pl.col("is_suspended")) & pl.col("amount").is_not_null() & (pl.col("amount") > 0)


def word_universe_dates(
    panel: pl.DataFrame,
    meta: pl.DataFrame | None,
    profile: WordUniverseProfile,
    *,
    st_history: pl.DataFrame | None = None,
    st_history_path: str | Path = DEFAULT_ST_HISTORY_PATH,
) -> pl.DataFrame:
    """Return (trade_date, stock_code) rows passing a Word v2 stock-pool profile."""
    if panel.is_empty():
        return _empty_universe()
    return _word_universe_dates_from_daily(
        _prepare_word_daily(panel, meta, st_history, st_history_path), profile
    )


def word_universe_dates_by_profile(
    panel: pl.DataFrame,
    meta: pl.DataFrame | None,
    profiles: Iterable[WordUniverseProfile],
    *,
    st_history: pl.DataFrame | None = None,
    st_history_path: str | Path = DEFAULT_ST_HISTORY_PATH,
) -> dict[str, pl.DataFrame]:
    """Return Word stock-pool eligibility for multiple profiles.

    This prepares daily liquidity/listing features once, which matters for the
    full audit page where all three Word profiles are needed.
    """
    profile_list = list(profiles)
    if panel.is_empty():
        return {profile.name: _empty_universe() for profile in profile_list}
    daily = _prepare_word_daily(panel, meta, st_history, st_history_path)
    out: dict[str, pl.DataFrame] = {}
    for profile in profile_list:
        if profile.name not in out:
            out[profile.name] = _word_universe_dates_from_daily(daily, profile)
    return out


def _prepare_word_daily(
    panel: pl.DataFrame,
    meta: pl.DataFrame | None,
    st_history: pl.DataFrame | None = None,
    st_history_path: str | Path = DEFAULT_ST_HISTORY_PATH,
) -> pl.DataFrame:
    history = _load_st_history(st_history, st_history_path)
    return _with_pit_st_filter(
        _with_meta_filters(_with_daily_features(panel), meta), history
    )


def _word_universe_dates_from_daily(
    daily: pl.DataFrame,
    profile: WordUniverseProfile,
) -> pl.DataFrame:
    if daily.is_empty():
        return _empty_universe()
    base = daily.filter(
        (pl.col("is_st") == False)
        & _non_suspended_expr()
    )
    if profile.listing_rule == "star_bj_1y_other_6m":
        is_star_bj = (
            pl.col("stock_code").cast(pl.Utf8).str.starts_with("688")
            | pl.col("stock_code").cast(pl.Utf8).str.starts_with("689")
            | pl.col("stock_code").cast(pl.Utf8).str.ends_with(".BJ")
        )
        base = base.filter(
            pl.when(is_star_bj)
            .then(pl.col("listing_calendar_days") >= STAR_BJ_LISTING_CALENDAR_DAYS)
            .otherwise(pl.col("listing_calendar_days") >= COMPANY_LISTING_CALENDAR_DAYS)
        )
    elif profile.listing_rule == "all_6m":
        base = base.filter(pl.col("listing_calendar_days") >= MARKET_LISTING_CALENDAR_DAYS)
    elif profile.listing_rule == "60_trading_days":
        base = base.filter(pl.col("trading_day_no") >= EVENT_LISTING_TRADING_DAYS)
    else:
        raise ValueError(f"unknown Word listing rule: {profile.listing_rule}")

    if profile.liquidity_rule == "avg_amount_20d_ge_200k":
        base = base.filter(pl.col("avg_amount_20d") >= COMPANY_MIN_AVG_AMOUNT_20D)
    elif profile.liquidity_rule == "avg_amount_20d_not_bottom_5pct":
        base = (
            base.with_columns([
                pl.col("avg_amount_20d").rank("ordinal").over("trade_date").alias("_liquidity_rank"),
                pl.len().over("trade_date").alias("_liquidity_n"),
            ])
            .with_columns(
                (pl.col("_liquidity_n").cast(pl.Float64) * MARKET_BOTTOM_LIQUIDITY_Q)
                .ceil()
                .cast(pl.UInt32)
                .alias("_liquidity_cut_count")
            )
            .filter(
                pl.col("avg_amount_20d").is_not_null()
                & (pl.col("_liquidity_rank") > pl.col("_liquidity_cut_count"))
            )
            .drop(["_liquidity_rank", "_liquidity_n", "_liquidity_cut_count"])
        )
    elif profile.liquidity_rule == "none":
        pass
    else:
        raise ValueError(f"unknown Word liquidity rule: {profile.liquidity_rule}")

    return base.select(["trade_date", "stock_code"]).unique().sort(["trade_date", "stock_code"])


def word_universe_for_factor(
    panel: pl.DataFrame,
    meta: pl.DataFrame | None,
    code: str,
    factor_meta: dict | None = None,
    *,
    st_history: pl.DataFrame | None = None,
    st_history_path: str | Path = DEFAULT_ST_HISTORY_PATH,
) -> pl.DataFrame:
    """Return Word stock-pool eligibility for ``code``."""
    return word_universe_dates(
        panel,
        meta,
        word_universe_profile_for_factor(code, factor_meta),
        st_history=st_history,
        st_history_path=st_history_path,
    )


def word_universe_for_scores(
    score: pl.DataFrame,
    panel: pl.DataFrame,
    meta: pl.DataFrame | None,
    registry: dict[str, dict] | None = None,
    *,
    st_history: pl.DataFrame | None = None,
    st_history_path: str | Path = DEFAULT_ST_HISTORY_PATH,
) -> pl.DataFrame:
    """Filter score/raw rows through each factor's Word stock-pool profile."""
    if score.is_empty():
        return score
    if "factor_code" not in score.columns:
        raise ValueError("score must contain factor_code")
    registry = registry or {}
    daily = _prepare_word_daily(panel, meta, st_history, st_history_path)
    profiles: dict[str, tuple[WordUniverseProfile, list[str]]] = {}
    for code in score["factor_code"].unique().sort():
        profile = word_universe_profile_for_factor(code, registry.get(code))
        if profile.name not in profiles:
            profiles[profile.name] = (profile, [])
        profiles[profile.name][1].append(code)
    frames = []
    for profile, codes in profiles.values():
        part = score.filter(pl.col("factor_code").is_in(codes))
        eligible = _word_universe_dates_from_daily(daily, profile)
        if eligible.is_empty():
            continue
        frames.append(part.join(eligible, on=["trade_date", "stock_code"], how="inner"))
    if not frames:
        return score.head(0)
    return pl.concat(frames, how="vertical")
