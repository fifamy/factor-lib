"""月末调仓 + 等权持有 + 双边成本的回测内核。"""
from __future__ import annotations

import polars as pl


def _empty_nav() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            "trade_date": pl.Date,
            "return_date": pl.Date,
            "port_ret_gross": pl.Float64,
            "port_ret": pl.Float64,
            "turnover": pl.Float64,
            "nav": pl.Float64,
        }
    )


def _empty_holdings() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            "trade_date": pl.Date,
            "stock_code": pl.Utf8,
            "weight": pl.Float64,
        }
    )


def _empty_group_backtest() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            "trade_date": pl.Date,
            "return_date": pl.Date,
            "portfolio": pl.Utf8,
            "port_ret": pl.Float64,
            "turnover": pl.Float64,
            "nav": pl.Float64,
        }
    )


def _nav_from_selected(
    selected: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    top_n: int | None,
    cost_per_side: float,
) -> pl.DataFrame:
    if selected.is_empty():
        return _empty_nav()
    holdings = (
        selected.with_columns((1.0 / pl.len().over("trade_date")).alias("weight"))
        .select(["trade_date", "stock_code", "weight"])
    )
    return _nav_from_weighted_holdings(holdings, monthly_ret, cost_per_side=cost_per_side)


def _nav_from_weighted_holdings(
    holdings: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    cost_per_side: float,
) -> pl.DataFrame:
    if holdings.is_empty():
        return _empty_nav()

    if "return_date" not in monthly_ret.columns:
        monthly_ret = monthly_ret.with_columns(pl.col("trade_date").alias("return_date"))

    held = holdings.join(monthly_ret, on=["trade_date", "stock_code"], how="left")
    held = held.with_columns(
        [
            pl.col("return_date").max().over("trade_date").alias("_period_return_date"),
            pl.when(pl.col("fwd_return").is_not_null())
            .then(pl.col("fwd_return"))
            .otherwise(-1.0)
            .alias("_member_return"),
        ]
    ).filter(pl.col("_period_return_date").is_not_null())
    if held.is_empty():
        return _empty_nav()
    port_ret = (
        held.with_columns((pl.col("weight") * pl.col("_member_return")).alias("_ret"))
        .group_by("trade_date")
        .agg([
            pl.col("_period_return_date").max().alias("return_date"),
            pl.col("_ret").sum().alias("port_ret_gross"),
        ])
        .sort("trade_date")
    )

    months = sorted(holdings["trade_date"].unique().to_list())
    prev: dict[str, float] = {}
    turnovers = []
    for m in months:
        curr = {
            r["stock_code"]: float(r["weight"])
            for r in holdings.filter(pl.col("trade_date") == m).iter_rows(named=True)
        }
        if not prev:
            t = 1.0
            trading_cost = cost_per_side * t
        else:
            names = set(curr) | set(prev)
            t = 0.5 * sum(abs(curr.get(s, 0.0) - prev.get(s, 0.0)) for s in names)
            trading_cost = 2 * cost_per_side * t
        turnovers.append({"trade_date": m, "turnover": t, "trading_cost": trading_cost})
        prev = curr
    turnover_df = pl.DataFrame(turnovers)

    out = port_ret.join(turnover_df, on="trade_date", how="left")
    out = out.with_columns(
        (pl.col("port_ret_gross") - pl.col("trading_cost")).alias("port_ret")
    )
    out = out.sort("trade_date").with_columns(
        (1.0 + pl.col("port_ret")).cum_prod().alias("nav")
    )
    return out.select(["trade_date", "return_date", "port_ret_gross", "port_ret", "turnover", "nav"])


def nav_from_weighted_holdings(
    holdings: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    cost_per_side: float,
) -> pl.DataFrame:
    return _nav_from_weighted_holdings(holdings, monthly_ret, cost_per_side=cost_per_side)


def build_industry_neutral_holdings(score: pl.DataFrame, top_n: int) -> pl.DataFrame:
    """Build weighted top-N holdings with industry target weights.

    Required columns:
        trade_date, stock_code, score, industry_sw1, industry_weight

    ``industry_weight`` is the target industry weight for that month, usually
    computed from the eligible universe. Industries unavailable in a given
    month are dropped and remaining target weights are renormalized.
    """
    if top_n <= 0:
        raise ValueError("top_n must be positive")
    if score.is_empty():
        return _empty_holdings()

    rows = []
    for month, group in score.drop_nulls(["score", "industry_sw1", "industry_weight"]).group_by("trade_date"):
        month = month[0] if isinstance(month, tuple) else month
        group = group.filter(pl.col("industry_weight") > 0)
        if group.is_empty():
            continue
        targets = (
            group.group_by("industry_sw1")
            .agg(pl.col("industry_weight").max().alias("target_weight"))
            .sort("industry_sw1")
        )
        targets = targets.with_columns((pl.col("target_weight") / pl.col("target_weight").sum()).alias("target_weight"))
        industries = targets["industry_sw1"].to_list()
        n_ind = len(industries)
        if n_ind == 0:
            continue
        quotas = []
        for r in targets.iter_rows(named=True):
            raw = float(r["target_weight"]) * top_n
            base = int(raw)
            quotas.append({
                "industry_sw1": r["industry_sw1"],
                "target_weight": float(r["target_weight"]),
                "quota": base,
                "frac": raw - base,
            })
        remaining = top_n - sum(q["quota"] for q in quotas)
        for q in sorted(quotas, key=lambda x: (-x["frac"], x["industry_sw1"])):
            if remaining <= 0:
                break
            q["quota"] += 1
            remaining -= 1

        month_rows = []
        for q in quotas:
            ind_group = (
                group.filter(pl.col("industry_sw1") == q["industry_sw1"])
                .sort(["score", "stock_code"], descending=[True, False])
                .head(q["quota"])
            )
            picked = ind_group.height
            if picked == 0:
                continue
            weight = q["target_weight"] / picked
            for r in ind_group.iter_rows(named=True):
                month_rows.append({
                    "trade_date": month,
                    "stock_code": r["stock_code"],
                    "weight": weight,
                    "industry_sw1": q["industry_sw1"],
                })
        total_weight = sum(float(r["weight"]) for r in month_rows)
        if total_weight <= 0:
            continue
        for r in month_rows:
            r["weight"] = float(r["weight"]) / total_weight
            rows.append(r)

    if not rows:
        return _empty_holdings()
    return pl.DataFrame(rows).select(["trade_date", "stock_code", "weight", "industry_sw1"])


def run_industry_neutral_topn_backtest(
    score: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    top_n: int,
    cost_per_side: float,
) -> pl.DataFrame:
    holdings = build_industry_neutral_holdings(score, top_n=top_n)
    return _nav_from_weighted_holdings(holdings, monthly_ret, cost_per_side=cost_per_side)


def run_topn_backtests(
    score: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    top_ns: list[int],
    cost_per_side: float,
) -> dict[int, pl.DataFrame]:
    """一次排序后批量计算多个 top_n 组合，结果与逐个 run_topn_backtest 一致。"""
    ranked = (
        score.sort(["trade_date", "score"], descending=[False, True])
        .with_columns(
            pl.col("score").cum_count().over("trade_date").alias("rank")
        )
    )

    out = {}
    for top_n in top_ns:
        selected = (
            ranked.filter(pl.col("rank") <= top_n)
            .select(["trade_date", "stock_code"])
        )
        out[top_n] = _nav_from_selected(selected, monthly_ret, top_n, cost_per_side)
    return out


def run_group_backtests(
    score: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    n_groups: int,
    group_prefix: str = "G",
    cost_per_side: float = 0.002,
) -> pl.DataFrame:
    """Build equal-count score groups plus high-minus-low long-short returns.

    Group 1 is the lowest score bucket and group N is the highest score bucket.
    Scores are assumed to already have the economically correct direction.
    """
    if n_groups < 2:
        raise ValueError("n_groups must be at least 2")
    if score.is_empty():
        return _empty_group_backtest()

    ranked = (
        score.drop_nulls("score")
        .sort(["trade_date", "score"], descending=[False, True])
        .with_columns([
            pl.col("score").cum_count().over("trade_date").alias("rank"),
            pl.len().over("trade_date").alias("n_in_month"),
        ])
        .with_columns(
            (
                pl.lit(n_groups)
                - ((((pl.col("rank") - 1) * n_groups) / pl.col("n_in_month")).floor().cast(pl.Int64))
            ).alias("group_no")
        )
    )

    rows = []
    for group_no in range(1, n_groups + 1):
        selected = (
            ranked.filter(pl.col("group_no") == group_no)
            .select(["trade_date", "stock_code"])
        )
        nav = _nav_from_selected(selected, monthly_ret, top_n=None, cost_per_side=cost_per_side)
        if not nav.is_empty():
            rows.append(nav.with_columns(pl.lit(f"{group_prefix}{group_no}").alias("portfolio")))

    if not rows:
        return _empty_group_backtest()

    out = pl.concat(rows).select(["trade_date", "return_date", "portfolio", "port_ret_gross", "port_ret", "turnover", "nav"])
    top_label = f"{group_prefix}{n_groups}"
    bottom_label = f"{group_prefix}1"
    top = (
        out.filter(pl.col("portfolio") == top_label)
        .select([
            "trade_date",
            pl.col("return_date").alias("return_date_top"),
            pl.col("port_ret_gross").alias("port_ret_gross_top"),
            pl.col("port_ret").alias("port_ret_top"),
            pl.col("turnover").alias("turnover_top"),
        ])
    )
    bottom = (
        out.filter(pl.col("portfolio") == bottom_label)
        .select([
            "trade_date",
            pl.col("return_date").alias("return_date_bottom"),
            pl.col("port_ret_gross").alias("port_ret_gross_bottom"),
            pl.col("port_ret").alias("port_ret_bottom"),
            pl.col("turnover").alias("turnover_bottom"),
        ])
    )
    long_short = (
        top.join(bottom, on="trade_date", how="inner")
        .with_columns([
            pl.max_horizontal(["return_date_top", "return_date_bottom"]).alias("return_date"),
            (pl.col("port_ret_gross_top") - pl.col("port_ret_gross_bottom")).alias("port_ret_gross"),
            (pl.col("turnover_top") + pl.col("turnover_bottom")).alias("turnover"),
        ])
        .with_columns([
            pl.when(pl.col("trade_date") == pl.col("trade_date").min())
            .then(cost_per_side * pl.col("turnover"))
            .otherwise(2 * cost_per_side * pl.col("turnover"))
            .alias("trading_cost"),
        ])
        .with_columns([
            (
                pl.col("port_ret_gross")
                - pl.col("trading_cost")
            ).alias("port_ret"),
        ])
        .sort("trade_date")
        .with_columns([
            (1.0 + pl.col("port_ret")).cum_prod().alias("nav"),
            pl.lit("LS").alias("portfolio"),
        ])
        .select(["trade_date", "return_date", "portfolio", "port_ret_gross", "port_ret", "turnover", "nav"])
    )
    if not long_short.is_empty():
        out = pl.concat([out, long_short])

    return out.sort(["portfolio", "trade_date"]).select(["trade_date", "return_date", "portfolio", "port_ret", "turnover", "nav"])


def run_quantile_backtests(
    score: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    n_quantiles: int = 5,
    cost_per_side: float = 0.002,
) -> pl.DataFrame:
    """按截面分位构造 Q1..Qn 与最高-最低多空组合。

    Q1 是最低分数组，Qn 是最高分数组；因子方向已经体现在 score 上。
    多空组合 LS = Qn - Q1，收益使用两个腿分别扣成本后的净收益相减。
    """
    if n_quantiles < 2:
        raise ValueError("n_quantiles must be at least 2")
    return run_group_backtests(
        score,
        monthly_ret,
        n_groups=n_quantiles,
        group_prefix="Q",
        cost_per_side=cost_per_side,
    )


def run_topn_backtest(
    score: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    top_n: int,
    cost_per_side: float,
) -> pl.DataFrame:
    """对每个月末截面取 top_n 个 score 最高的股票，等权下月持有。

    参数：
        score:        DataFrame(trade_date, stock_code, score)
        monthly_ret:  DataFrame(trade_date, stock_code, fwd_return) — fwd_return 是该月末持仓到下月末的收益
        top_n:        每月持仓股票数
        cost_per_side: 单边成本（如 0.002 = 0.2%）。换仓时双边成本 = 2 × cost_per_side × turnover

    返回：DataFrame(trade_date, port_ret, turnover, nav)
    """
    return run_topn_backtests(score, monthly_ret, [top_n], cost_per_side)[top_n]
