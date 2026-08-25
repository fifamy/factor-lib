"""生成单因子行业中性组合回测与最新持仓权重。

行业口径：各月末时点有效的申万一级行业归属。
目标权重：每个月可投资股票池内，各行业股票数量占比。

用法：
    python3 scripts/05c_industry_neutral_backtest.py [--score ...] [--out ...] [--holdings-out ...]
"""
import argparse
from pathlib import Path

import polars as pl

from factor_lib.backtest import assert_backtest_economic_invariants
from factor_lib.factors import momentum, volatility, liquidity, beta, company, market_extra, investor, derived, tech_event, word_v2  # noqa: F401
from factor_lib.monthly_returns import valid_forward_return_expr
from factor_lib.industry import load_industry_map
from factor_lib.registry import FACTOR_REGISTRY
from factor_lib.universe import word_universe_for_scores
try:
    from _monthly_returns import monthly_forward_return
except ModuleNotFoundError:
    from scripts._monthly_returns import monthly_forward_return


TOP_NS = list(range(1, 101))
COST_PER_SIDE = 0.002


def load_descriptors(path: str, industry_history_path: str, trade_dates: list) -> pl.DataFrame:
    return load_industry_map(trade_dates, history_path=industry_history_path, static_path=path)


def add_industry_targets(score: pl.DataFrame, eligible_with_industry: pl.DataFrame) -> pl.DataFrame:
    industry_targets = (
        eligible_with_industry
        .group_by(["trade_date", "industry_sw1"])
        .agg(pl.len().alias("industry_count"))
        .with_columns(
            (pl.col("industry_count") / pl.col("industry_count").sum().over("trade_date")).alias("industry_weight")
        )
        .select(["trade_date", "industry_sw1", "industry_weight"])
    )
    return (
        score.join(eligible_with_industry, on=["trade_date", "stock_code"], how="inner")
        .join(industry_targets, on=["trade_date", "industry_sw1"], how="inner")
        .select(["trade_date", "stock_code", "score", "industry_sw1", "industry_weight"])
    )


def empty_holdings() -> pl.DataFrame:
    return pl.DataFrame(schema={
        "trade_date": pl.Date,
        "top_n": pl.Int64,
        "stock_code": pl.Utf8,
        "weight": pl.Float64,
        "industry_sw1": pl.Utf8,
    })


def build_industry_neutral_holdings_all_topn(score: pl.DataFrame, top_ns: list[int]) -> pl.DataFrame:
    if score.is_empty():
        return empty_holdings()
    ranked = (
        score.drop_nulls(["score", "industry_sw1", "industry_weight"])
        .filter(pl.col("industry_weight") > 0)
        .sort(["trade_date", "industry_sw1", "score", "stock_code"], descending=[False, False, True, False])
        .with_columns(
            pl.col("score")
            .rank(method="min", descending=True)
            .over(["trade_date", "industry_sw1"])
            .alias("industry_rank")
        )
    )
    if ranked.is_empty():
        return empty_holdings()

    targets = (
        ranked.group_by(["trade_date", "industry_sw1"])
        .agg(pl.col("industry_weight").max().alias("target_weight"))
        .with_columns((pl.col("target_weight") / pl.col("target_weight").sum().over("trade_date")).alias("target_weight"))
    )
    topn = pl.DataFrame({"top_n": top_ns})
    targets_n = (
        targets.join(topn, how="cross")
        .with_columns([
            (pl.col("target_weight") * pl.col("top_n")).alias("_raw_quota"),
        ])
        .with_columns([
            pl.col("_raw_quota").floor().cast(pl.Int64).alias("_base_quota"),
            (pl.col("_raw_quota") - pl.col("_raw_quota").floor()).alias("_frac_quota"),
        ])
        .with_columns([
            pl.col("_base_quota").sum().over(["trade_date", "top_n"]).alias("_base_sum"),
        ])
        .sort(
            ["trade_date", "top_n", "_frac_quota", "industry_sw1"],
            descending=[False, False, True, False],
        )
        .with_columns(
            pl.col("industry_sw1").cum_count().over(["trade_date", "top_n"]).alias("_frac_rank")
        )
        .with_columns(
            (
                pl.col("_base_quota")
                + (pl.col("_frac_rank") <= (pl.col("top_n") - pl.col("_base_sum"))).cast(pl.Int64)
            ).alias("quota")
        )
        .filter(pl.col("quota") > 0)
        .select(["trade_date", "industry_sw1", "top_n", "target_weight", "quota"])
    )
    # Competition rank deliberately includes every stock tied at an industry
    # quota boundary.  This can produce more than ``top_n`` names; weights are
    # renormalized below while preserving the industry target allocation.
    selected = (
        targets_n.join(
            ranked.select(["trade_date", "industry_sw1", "stock_code", "industry_rank"]),
            on=["trade_date", "industry_sw1"],
            how="inner",
        )
        .filter(pl.col("industry_rank") <= pl.col("quota"))
        .with_columns(pl.len().over(["trade_date", "top_n", "industry_sw1"]).alias("selected_count"))
    )
    if selected.is_empty():
        return empty_holdings()

    holdings = (
        selected
        .with_columns((pl.col("target_weight") / pl.col("selected_count")).alias("_weight"))
        .with_columns((pl.col("_weight") / pl.col("_weight").sum().over(["trade_date", "top_n"])).alias("weight"))
        .select(["trade_date", "top_n", "stock_code", "weight", "industry_sw1"])
        .sort(["top_n", "trade_date", "weight", "stock_code"], descending=[False, False, True, False])
    )
    return holdings


def nav_from_weighted_holdings_all_topn(
    holdings: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    cost_per_side: float,
) -> pl.DataFrame:
    if holdings.is_empty():
        return pl.DataFrame(schema={
            "trade_date": pl.Date,
            "return_date": pl.Date,
            "top_n": pl.Int64,
            "port_ret": pl.Float64,
            "turnover": pl.Float64,
            "nav": pl.Float64,
        })

    held = holdings.join(monthly_ret, on=["trade_date", "stock_code"], how="left")
    held = held.with_columns([
        pl.col("return_date").max().over(["top_n", "trade_date"]).alias("_period_return_date"),
        valid_forward_return_expr().alias("_has_valid_return"),
    ]).filter(pl.col("_period_return_date").is_not_null())
    if held.is_empty():
        return pl.DataFrame(schema={
            "trade_date": pl.Date,
            "return_date": pl.Date,
            "top_n": pl.Int64,
            "port_ret": pl.Float64,
            "turnover": pl.Float64,
            "nav": pl.Float64,
        })
    port_ret = (
        held.with_columns([
            pl.when(pl.col("_has_valid_return"))
            .then(pl.col("weight") * pl.col("fwd_return"))
            .otherwise(None)
            .alias("_ret"),
            pl.when(pl.col("_has_valid_return"))
            .then(pl.col("weight"))
            .otherwise(0.0)
            .alias("_observed_weight"),
        ])
        .group_by(["top_n", "trade_date"])
        .agg([
            pl.col("_period_return_date").max().alias("return_date"),
            pl.col("_ret").sum().alias("_weighted_ret"),
            pl.col("_observed_weight").sum().alias("_observed_weight"),
        ])
        .filter(pl.col("_observed_weight") > 0)
        .with_columns((pl.col("_weighted_ret") / pl.col("_observed_weight")).alias("port_ret_gross"))
        .select(["top_n", "trade_date", "return_date", "port_ret_gross"])
    )

    months = sorted(holdings["trade_date"].unique().to_list())
    month_idx = pl.DataFrame({"trade_date": months, "month_idx": list(range(len(months)))})
    h = holdings.join(month_idx, on="trade_date", how="inner")
    changes = pl.concat([
        h.select(["top_n", "month_idx", "stock_code", pl.col("weight").alias("delta")]),
        h.select(["top_n", (pl.col("month_idx") + 1).alias("month_idx"), "stock_code", (-pl.col("weight")).alias("delta")]),
    ])
    turnover = (
        changes.group_by(["top_n", "month_idx", "stock_code"])
        .agg(pl.col("delta").sum().alias("delta"))
        .group_by(["top_n", "month_idx"])
        .agg((pl.col("delta").abs().sum() * 0.5).alias("turnover"))
        .join(month_idx, on="month_idx", how="inner")
        .with_columns(
            pl.when(pl.col("month_idx") == 0).then(1.0).otherwise(pl.col("turnover")).alias("turnover")
        )
        .with_columns(
            pl.when(pl.col("month_idx") == 0)
            .then(cost_per_side * pl.col("turnover"))
            .otherwise(2 * cost_per_side * pl.col("turnover"))
            .alias("trading_cost")
        )
        .select(["top_n", "trade_date", "turnover", "trading_cost"])
    )

    out = (
        port_ret.join(turnover, on=["top_n", "trade_date"], how="left")
        .with_columns([
            pl.col("turnover").fill_null(0.0),
            pl.col("trading_cost").fill_null(0.0),
        ])
        .with_columns(
            pl.max_horizontal(
                pl.lit(-1.0),
                (1.0 + pl.col("port_ret_gross"))
                * (1.0 - pl.col("trading_cost"))
                - 1.0,
            ).alias("port_ret")
        )
        .sort(["top_n", "trade_date"])
        .with_columns((1.0 + pl.col("port_ret")).cum_prod().over("top_n").alias("nav"))
        .select(["trade_date", "return_date", "top_n", "port_ret", "turnover", "nav"])
    )
    return out


def main(
    score_path: str,
    panel_path: str,
    meta_path: str,
    descriptors_path: str,
    out_path: str,
    holdings_out_path: str,
    industry_history_path: str,
):
    score_all = pl.read_parquet(score_path)
    panel = pl.read_parquet(panel_path).sort(["stock_code", "trade_date"])
    meta = pl.read_parquet(meta_path)
    desc = load_descriptors(descriptors_path, industry_history_path, score_all["trade_date"].unique().to_list())

    month_end, monthly_ret = monthly_forward_return(panel)
    score_all = word_universe_for_scores(score_all, panel, meta, FACTOR_REGISTRY)
    eligible_with_industry_all = (
        score_all
        .select(["factor_code", "trade_date", "stock_code"])
        .unique()
        .join(desc, on=["trade_date", "stock_code"] if "trade_date" in desc.columns else ["stock_code"], how="inner")
    )
    print(
        f"月度收益 {monthly_ret.height:,} 行；Word 股票池过滤后 score 样本 {score_all.height:,} 行；"
        f"行业可投资样本 {eligible_with_industry_all.height:,} 行",
        flush=True,
    )

    all_nav = []
    all_holdings = []
    score_by_factor = {
        (key[0] if isinstance(key, tuple) else key): part
        for key, part in score_all.partition_by("factor_code", as_dict=True).items()
    }
    eligible_by_factor = {
        (key[0] if isinstance(key, tuple) else key): part
        for key, part in eligible_with_industry_all.partition_by("factor_code", as_dict=True).items()
    }
    for code in sorted(score_by_factor):
        score_one = score_by_factor[code].drop_nulls("score").select(
            ["trade_date", "stock_code", "score"]
        )
        eligible_with_industry = eligible_by_factor[code].select(
            ["trade_date", "stock_code", "industry_sw1"]
        )
        score_one = add_industry_targets(score_one, eligible_with_industry)
        if score_one.is_empty():
            print(f"  Skip {code}: no industry coverage", flush=True)
            continue
        holdings = build_industry_neutral_holdings_all_topn(score_one, TOP_NS)
        nav = nav_from_weighted_holdings_all_topn(holdings, monthly_ret, COST_PER_SIDE)
        if not nav.is_empty():
            all_nav.append(nav.with_columns(pl.lit(code).alias("factor_code")))

        latest_holdings = holdings.filter(pl.col("trade_date") == pl.col("trade_date").max())
        if not latest_holdings.is_empty():
            all_holdings.append(latest_holdings.with_columns(pl.lit(code).alias("factor_code")))
        print(f"  Done {code}", flush=True)

    out = pl.concat(all_nav) if all_nav else pl.DataFrame()
    assert_backtest_economic_invariants(out, context="preset_backtest_industry")
    out.write_parquet(out_path)
    holdings = pl.concat(all_holdings) if all_holdings else pl.DataFrame()
    holdings.write_parquet(holdings_out_path)
    print(f"Wrote {out_path}: {out.height:,} rows", flush=True)
    print(f"Wrote {holdings_out_path}: {holdings.height:,} rows", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--score", default="data/factor_score.parquet")
    parser.add_argument("--panel", default="data/raw/price_panel.parquet")
    parser.add_argument("--meta", default="data/raw/stock_meta.parquet")
    parser.add_argument("--descriptors", default="frontend/data/stock_descriptors.parquet")
    parser.add_argument("--out", default="data/preset_backtest_industry_neutral.parquet")
    parser.add_argument("--holdings-out", default="data/factor_holdings_industry_neutral.parquet")
    parser.add_argument("--industry-history", default="资料/balance_sheet_interest_bearing_processed/parquet/sw_industry_history.parquet")
    args = parser.parse_args()
    main(args.score, args.panel, args.meta, args.descriptors, args.out, args.holdings_out, args.industry_history)
