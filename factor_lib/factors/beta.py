"""Beta 因子：252 日对市场组合的历史 Beta。

市场组合 = cap-weighted A 股组合（用 market_cap 加权日收益）。
"""
from __future__ import annotations

from datetime import date, timedelta
import numpy as np
import polars as pl

from factor_lib.registry import factor


def build_market_returns(panel: pl.DataFrame) -> pl.DataFrame:
    """构造 cap-weighted 市场组合日收益。

    返回：DataFrame(trade_date, market_return)
    算法：
      r_mkt(t) = Σ_i [w_i(t-1) · r_i(t)]
      w_i(t-1) = market_cap_i(t-1) / Σ_j market_cap_j(t-1)
    """
    df = panel.sort(["stock_code", "trade_date"])

    # 个股日对数收益
    df = df.with_columns(
        (pl.col("adj_close") / pl.col("adj_close").shift(1).over("stock_code"))
            .log().alias("log_ret")
    )

    # 前一日市值
    df = df.with_columns(
        pl.col("market_cap").shift(1).over("stock_code").alias("market_cap_prev")
    )

    df = df.filter(pl.col("log_ret").is_not_null() & pl.col("market_cap_prev").is_not_null())

    mkt = (
        df.group_by("trade_date")
          .agg(
              (pl.col("log_ret") * pl.col("market_cap_prev")).sum().alias("num"),
              pl.col("market_cap_prev").sum().alias("denom"),
          )
          .with_columns((pl.col("num") / pl.col("denom")).alias("market_return"))
          .select(["trade_date", "market_return"])
          .sort("trade_date")
    )
    return mkt


_MARKET_RETURNS_CACHE = None
MAX_BETA_CALENDAR_DAYS = 400
MIN_BETA_OBS = 200
MAX_STALE_DAYS = 10


def _panel_signature(panel: pl.DataFrame) -> tuple:
    if panel.is_empty():
        return (0, None, None, None, None, None)
    fp = panel.select([
        pl.len().alias("n"),
        pl.col("trade_date").min().alias("min_date"),
        pl.col("trade_date").max().alias("max_date"),
        pl.col("stock_code").n_unique().alias("n_stocks"),
        pl.col("adj_close").sum().alias("adj_close_sum"),
        pl.col("market_cap").sum().alias("market_cap_sum"),
    ]).row(0)
    return tuple(fp)


def _get_or_build_market_returns(panel: pl.DataFrame) -> pl.DataFrame:
    """Cache market returns keyed by a lightweight panel content signature."""
    global _MARKET_RETURNS_CACHE
    panel_key = _panel_signature(panel)
    if _MARKET_RETURNS_CACHE is not None and _MARKET_RETURNS_CACHE[0] == panel_key:
        return _MARKET_RETURNS_CACHE[1]
    mkt = build_market_returns(panel)
    _MARKET_RETURNS_CACHE = (panel_key, mkt)
    return mkt


@factor(
    code="BETA",
    l1="市场交易信息",
    l2="Beta",
    direction=1,
    description="过去 252 个交易日个股对 cap-weighted 市场组合的回归 Beta。"
)
def beta(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    market = _get_or_build_market_returns(panel).filter(pl.col("trade_date") <= asof)

    df = (
        panel.filter(pl.col("trade_date") <= asof)
             .sort(["stock_code", "trade_date"])
    )
    df = df.with_columns(
        (pl.col("adj_close") / pl.col("adj_close").shift(1).over("stock_code"))
            .log().alias("log_ret")
    )

    df = df.join(market, on="trade_date", how="left")

    results = []
    for code, sub in df.group_by("stock_code"):
        sub_sorted = sub.sort("trade_date").drop_nulls(subset=["log_ret", "market_return"])
        sub_sorted = sub_sorted.filter(pl.col("trade_date") >= asof - timedelta(days=MAX_BETA_CALENDAR_DAYS))
        if (
            sub_sorted.is_empty()
            or (asof - sub_sorted["trade_date"].max()).days > MAX_STALE_DAYS
            or len(sub_sorted) < MIN_BETA_OBS
        ):
            results.append({"stock_code": code[0], "value": None})
            continue
        recent = sub_sorted.tail(252)
        y = recent["log_ret"].to_numpy()
        x = recent["market_return"].to_numpy()

        cov = np.cov(y, x, ddof=1)[0, 1]
        var = np.var(x, ddof=1)
        if var == 0:
            results.append({"stock_code": code[0], "value": None})
            continue
        b = float(cov / var)
        results.append({"stock_code": code[0], "value": b})

    return pl.DataFrame(results)


@factor(
    code="DOWNBETA",
    l1="市场交易信息",
    l2="Beta",
    direction=-1,
    name_cn="下行beta",
    formula="DOWNBETA = cov(r_i, r_mkt | r_mkt<0) / var(r_mkt | r_mkt<0)，过去252个交易日。",
    wind_source="AShareEODPrices.S_DQ_ADJCLOSE; AShareEODDerivativeIndicator.S_DQ_MV",
    description="过去 252 个交易日中，仅使用市场组合下跌日估计个股对市场下跌的敏感度；越高代表弱市风险暴露越高。"
)
def downbeta(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    market = _get_or_build_market_returns(panel).filter(pl.col("trade_date") <= asof)

    df = (
        panel.filter(pl.col("trade_date") <= asof)
             .sort(["stock_code", "trade_date"])
    )
    df = df.with_columns(
        (pl.col("adj_close") / pl.col("adj_close").shift(1).over("stock_code"))
            .log().alias("log_ret")
    )
    df = df.join(market, on="trade_date", how="left")

    results = []
    for code, sub in df.group_by("stock_code"):
        sub_sorted = sub.sort("trade_date").drop_nulls(subset=["log_ret", "market_return"])
        sub_sorted = sub_sorted.filter(pl.col("trade_date") >= asof - timedelta(days=MAX_BETA_CALENDAR_DAYS))
        if (
            sub_sorted.is_empty()
            or (asof - sub_sorted["trade_date"].max()).days > MAX_STALE_DAYS
            or len(sub_sorted) < MIN_BETA_OBS
        ):
            results.append({"stock_code": code[0], "value": None})
            continue
        recent = sub_sorted.tail(252).filter(pl.col("market_return") < 0)
        if len(recent) < 20:
            results.append({"stock_code": code[0], "value": None})
            continue
        y = recent["log_ret"].to_numpy()
        x = recent["market_return"].to_numpy()
        var = np.var(x, ddof=1)
        if var == 0:
            results.append({"stock_code": code[0], "value": None})
            continue
        b = float(np.cov(y, x, ddof=1)[0, 1] / var)
        results.append({"stock_code": code[0], "value": b})

    return pl.DataFrame(results)
