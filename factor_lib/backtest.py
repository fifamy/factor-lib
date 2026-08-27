"""月末调仓 + 等权持有 + 按换手扣交易成本的回测内核。"""
from __future__ import annotations

import polars as pl

from factor_lib.monthly_returns import valid_forward_return_expr


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


def completed_period_calendar(
    monthly_ret: pl.DataFrame,
    signal_dates: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """Return globally completed signal periods and their realised exit date.

    The market calendar, rather than factor holdings, determines whether a
    period is complete.  This lets a factor with no eligible names emit a cash
    month while still excluding the unfinished terminal signal period.
    """
    if monthly_ret.is_empty():
        return pl.DataFrame(schema={"trade_date": pl.Date, "return_date": pl.Date})
    source = monthly_ret
    if "return_date" not in source.columns:
        source = source.with_columns(pl.col("trade_date").alias("return_date"))
    calendar = (
        source.group_by("trade_date")
        .agg(pl.col("return_date").max().alias("return_date"))
        .filter(pl.col("return_date").is_not_null())
        .sort("trade_date")
    )
    if signal_dates is not None:
        calendar = calendar.join(
            signal_dates.select("trade_date").drop_nulls().unique(),
            on="trade_date",
            how="inner",
        )
    return calendar.sort("trade_date")


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


def assert_backtest_economic_invariants(
    frame: pl.DataFrame,
    *,
    context: str = "backtest",
    group_columns: list[str] | None = None,
    tolerance: float = 1e-12,
) -> None:
    """Fail a build when a limited-liability wealth series is impossible."""
    if frame.is_empty():
        return
    required = {"port_ret", "nav"}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"{context}: missing invariant columns {sorted(missing)}")
    invalid = frame.filter(
        (pl.col("port_ret").is_finite() & (pl.col("port_ret") < -1.0 - tolerance))
        | (pl.col("nav").is_finite() & (pl.col("nav") < -tolerance))
    )
    if not invalid.is_empty():
        sample = invalid.select([c for c in ["trade_date", "portfolio", "top_n", "port_ret", "nav"] if c in invalid.columns]).head(3).to_dicts()
        raise ValueError(f"{context}: limited-liability invariant failed: {sample}")

    keys = group_columns or [c for c in ["factor_code", "portfolio", "top_n"] if c in frame.columns]
    groups = frame.partition_by(keys, as_dict=False) if keys else [frame]
    for group in groups:
        ordered = group.sort("trade_date") if "trade_date" in group.columns else group
        zero_seen = False
        for value in ordered["nav"].to_list():
            if value is None:
                continue
            nav = float(value)
            if zero_seen and nav > tolerance:
                raise ValueError(f"{context}: NAV revived after reaching zero")
            if nav <= tolerance:
                zero_seen = True


def _nav_from_selected(
    selected: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    top_n: int | None,
    cost_per_side: float,
    *,
    calendar: pl.DataFrame | None = None,
    prejoined_returns: pl.DataFrame | None = None,
) -> pl.DataFrame:
    if selected.is_empty() and calendar is None:
        return _empty_nav()
    holdings = (
        selected.with_columns((1.0 / pl.len().over("trade_date")).alias("weight"))
        .select(["trade_date", "stock_code", "weight"])
    )
    return _nav_from_weighted_holdings(
        holdings,
        monthly_ret,
        cost_per_side=cost_per_side,
        calendar=calendar,
        prejoined_returns=prejoined_returns,
    )


def _nav_from_weighted_holdings(
    holdings: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    cost_per_side: float,
    *,
    calendar: pl.DataFrame | None = None,
    prejoined_returns: pl.DataFrame | None = None,
) -> pl.DataFrame:
    if holdings.is_empty() and calendar is None:
        return _empty_nav()

    calendar = calendar if calendar is not None else completed_period_calendar(monthly_ret)
    if calendar.is_empty():
        return _empty_nav()
    completed_holdings = holdings.join(
        calendar.select("trade_date"), on="trade_date", how="inner"
    )
    return_source = (
        prejoined_returns
        if prejoined_returns is not None
        else monthly_ret.select(["trade_date", "stock_code", "fwd_return"])
    )
    held = (
        completed_holdings.join(
            return_source,
            on=["trade_date", "stock_code"],
            how="left",
        )
        .with_columns(valid_forward_return_expr().alias("_has_valid_return"))
    )
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
        .group_by("trade_date")
        .agg([
            pl.col("_ret").sum().alias("_observed_weighted_return"),
            pl.col("_observed_weight").sum().alias("_observed_weight"),
        ])
        # Invalid, suspended, or otherwise missing members are excluded and
        # the remaining observable holdings are renormalized.  A completed
        # period with no observable member return is omitted, not fabricated
        # as a -100% portfolio loss.
        .filter(pl.col("_observed_weight") > 0)
        .with_columns(
            (pl.col("_observed_weighted_return") / pl.col("_observed_weight")).alias("port_ret_gross")
        )
        .select(["trade_date", "port_ret_gross"])
        .sort("trade_date")
    )
    gross_by_month = dict(zip(port_ret["trade_date"].to_list(), port_ret["port_ret_gross"].to_list()))
    holdings_by_month = {
        (key[0] if isinstance(key, tuple) else key): part
        for key, part in completed_holdings.partition_by("trade_date", as_dict=True).items()
    }
    prev: dict[str, float] | None = None
    periods = []
    for period in calendar.iter_rows(named=True):
        trade_date = period["trade_date"]
        month_holdings = holdings_by_month.get(trade_date)
        if month_holdings is not None and trade_date not in gross_by_month:
            # Holdings exist, but every member return is missing/invalid.  The
            # period is unobservable: emit nothing and do not advance ``prev``.
            continue
        if month_holdings is None:
            curr: dict[str, float] = {}
            gross = 0.0
        else:
            curr = dict(zip(
                month_holdings["stock_code"].to_list(),
                (float(v) for v in month_holdings["weight"].to_list()),
            ))
            gross = float(gross_by_month[trade_date])
        if prev is None:
            t = 0.0 if not curr else 1.0
            trading_cost = cost_per_side * t
        else:
            names = set(curr) | set(prev)
            t = 0.5 * sum(abs(curr.get(s, 0.0) - prev.get(s, 0.0)) for s in names)
            trading_cost = 2 * cost_per_side * t
        periods.append({
            "trade_date": trade_date,
            "return_date": period["return_date"],
            "port_ret_gross": gross,
            "turnover": t,
            "trading_cost": trading_cost,
        })
        prev = curr
    if not periods:
        return _empty_nav()
    out = pl.DataFrame(periods)
    # Charge long-only costs against the capital that remains after the
    # holding-period return.  Additive subtraction can push a total loss
    # below -100% (for example -1.0 - 0.002) and create an impossible negative
    # NAV.  The multiplicative convention preserves the economic lower bound:
    # gross == -1.0 always implies net == -1.0.
    out = out.with_columns(
        pl.max_horizontal(
            pl.lit(-1.0),
            (1.0 + pl.col("port_ret_gross"))
            * (1.0 - pl.col("trading_cost"))
            - 1.0,
        ).alias("port_ret")
    )
    out = out.sort("trade_date").with_columns(
        (1.0 + pl.col("port_ret")).cum_prod().alias("nav")
    )
    return out.select(["trade_date", "return_date", "port_ret_gross", "port_ret", "turnover", "nav"])


def nav_from_weighted_holdings(
    holdings: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    cost_per_side: float,
    *,
    calendar: pl.DataFrame | None = None,
) -> pl.DataFrame:
    return _nav_from_weighted_holdings(
        holdings,
        monthly_ret,
        cost_per_side=cost_per_side,
        calendar=calendar,
    )


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
                .with_columns(
                    pl.col("score").rank(method="min", descending=True).alias("_score_rank")
                )
                .filter(pl.col("_score_rank") <= q["quota"])
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
    *,
    calendar: pl.DataFrame | None = None,
) -> dict[int, pl.DataFrame]:
    """一次排序后批量计算多个 top_n 组合，结果与逐个 run_topn_backtest 一致。"""
    calendar = calendar if calendar is not None else completed_period_calendar(monthly_ret)
    return_source = monthly_ret.select(["trade_date", "stock_code", "fwd_return"])
    ranked = (
        score.drop_nulls("score")
        .sort(["trade_date", "score", "stock_code"], descending=[False, True, False])
        .with_columns(
            # Competition rank includes every stock tied at the requested
            # boundary.  stock_code only stabilizes row order; it never breaks
            # an economically identical score tie.
            pl.col("score").rank(method="min", descending=True).over("trade_date").alias("rank")
        )
        # Joining the market return panel once is materially faster than
        # repeating the same 900k-row join for every requested Top-N.  Each
        # portfolio still uses the identical selected rows and NAV state
        # machine below, so this is a computation-only optimisation.
        .join(return_source, on=["trade_date", "stock_code"], how="left")
    )

    out = {}
    for top_n in top_ns:
        if top_n <= 0:
            raise ValueError("top_n must be positive")
        selected_returns = (
            ranked.filter(pl.col("rank") <= top_n)
            .select(["trade_date", "stock_code", "fwd_return"])
        )
        selected = selected_returns.select(["trade_date", "stock_code"])
        out[top_n] = _nav_from_selected(
            selected,
            monthly_ret,
            top_n,
            cost_per_side,
            calendar=calendar,
            prejoined_returns=selected_returns,
        )
    return out


def run_group_backtests(
    score: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    n_groups: int,
    group_prefix: str = "G",
    cost_per_side: float = 0.002,
    *,
    calendar: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """Build equal-count score groups plus high-minus-low long-short returns.

    Group 1 is the lowest score bucket and group N is the highest score bucket.
    Scores are assumed to already have the economically correct direction.
    """
    if n_groups < 2:
        raise ValueError("n_groups must be at least 2")
    if score.is_empty():
        return _empty_group_backtest()

    return_source = monthly_ret.select(["trade_date", "stock_code", "fwd_return"])
    ranked = (
        score.drop_nulls("score")
        .sort(["trade_date", "score", "stock_code"], descending=[False, False, False])
        .with_columns([
            # Average rank maps an entire score tie to one bucket.  Buckets may
            # therefore be uneven or empty, which is preferable to inventing a
            # cross-sectional ordering that the factor does not contain.
            pl.col("score").rank(method="average").over("trade_date").alias("rank"),
            pl.len().over("trade_date").alias("n_in_month"),
        ])
        .with_columns(
            (
                ((((pl.col("rank") - 1) * n_groups) / pl.col("n_in_month")).floor().cast(pl.Int64))
                + 1
            ).alias("group_no")
        )
        .join(return_source, on=["trade_date", "stock_code"], how="left")
    )

    rows = []
    for group_no in range(1, n_groups + 1):
        selected_returns = (
            ranked.filter(pl.col("group_no") == group_no)
            .select(["trade_date", "stock_code", "fwd_return"])
        )
        selected = selected_returns.select(["trade_date", "stock_code"])
        nav = _nav_from_selected(
            selected,
            monthly_ret,
            top_n=None,
            cost_per_side=cost_per_side,
            calendar=calendar,
            prejoined_returns=selected_returns,
        )
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
            pl.max_horizontal(
                pl.lit(-1.0),
                pl.col("port_ret_gross_top") - pl.col("port_ret_gross_bottom"),
            ).alias("port_ret_gross"),
            (pl.col("turnover_top") + pl.col("turnover_bottom")).alias("turnover"),
        ])
        .with_columns([
            pl.when(pl.col("trade_date") == pl.col("trade_date").min())
            .then(cost_per_side * pl.col("turnover"))
            .otherwise(2 * cost_per_side * pl.col("turnover"))
            .alias("trading_cost"),
        ])
        .with_columns([
            pl.max_horizontal(
                pl.lit(-1.0),
                pl.col("port_ret_gross") - pl.col("trading_cost"),
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
    *,
    calendar: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """按截面分位构造 Q1..Qn 与最高-最低多空组合。

    Q1 是最低分数组，Qn 是最高分数组；因子方向已经体现在 score 上。
    多空组合 LS = Qn - Q1，并按两个腿的换手分别承担成本。
    """
    if n_quantiles < 2:
        raise ValueError("n_quantiles must be at least 2")
    return run_group_backtests(
        score,
        monthly_ret,
        n_groups=n_quantiles,
        group_prefix="Q",
        cost_per_side=cost_per_side,
        calendar=calendar,
    )


def run_topn_backtest(
    score: pl.DataFrame,
    monthly_ret: pl.DataFrame,
    top_n: int,
    cost_per_side: float,
    *,
    calendar: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """对每个月末截面取 top_n 个 score 最高的股票，等权下月持有。

    参数：
        score:        DataFrame(trade_date, stock_code, score)
        monthly_ret:  DataFrame(trade_date, stock_code, fwd_return) — fwd_return 是该月末持仓到下月末的收益
        top_n:        每月持仓股票数
        cost_per_side: 单边成本（如 0.002 = 0.2%）。换仓时双边成本 = 2 × cost_per_side × turnover

    返回：DataFrame(trade_date, port_ret, turnover, nav)
    """
    return run_topn_backtests(
        score,
        monthly_ret,
        [top_n],
        cost_per_side,
        calendar=calendar,
    )[top_n]
