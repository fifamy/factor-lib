"""测试回测内核：月末调仓 + 等权 + 成本。"""
import importlib.util
import numpy as np
import polars as pl
import pytest
from polars.testing import assert_frame_equal
from datetime import date
from pathlib import Path

from factor_lib.backtest import (
    build_industry_neutral_holdings,
    run_industry_neutral_topn_backtest,
    run_group_backtests,
    run_quantile_backtests,
    run_topn_backtest,
    run_topn_backtests,
)


def load_industry_neutral_backtest_script():
    path = Path("scripts/05c_industry_neutral_backtest.py")
    spec = importlib.util.spec_from_file_location("script_05c_industry_neutral_backtest", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_equal_weight_no_cost_perfect_factor():
    """构造一个完美因子：score 排序与下月收益单调一致。"""
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 4 + [date(2025, 2, 28)] * 4 + [date(2025, 3, 31)] * 4,
        "stock_code": ["A", "B", "C", "D"] * 3,
        "score": [3.0, 2.0, 1.0, 0.0, 3.0, 2.0, 1.0, 0.0, 3.0, 2.0, 1.0, 0.0],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 4 + [date(2025, 2, 28)] * 4,
        "stock_code": ["A", "B", "C", "D"] * 2,
        "fwd_return": [0.1, 0.05, 0.0, -0.05, 0.1, 0.05, 0.0, -0.05],
    })
    nav = run_topn_backtest(score, monthly_ret, top_n=2, cost_per_side=0.0)
    rets = nav["port_ret"].drop_nulls().to_list()
    # 月 1：选 A, B，下月收益 (0.1+0.05)/2 = 0.075
    # 月 2：选 A, B，下月收益 (0.1+0.05)/2 = 0.075
    assert abs(rets[0] - 0.075) < 1e-6
    assert abs(rets[1] - 0.075) < 1e-6


def test_cost_reduces_return():
    """有成本时收益应更低。"""
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 4 + [date(2025, 2, 28)] * 4,
        "stock_code": ["A", "B", "C", "D"] * 2,
        "score": [3.0, 2.0, 1.0, 0.0, 0.0, 1.0, 2.0, 3.0],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 4,
        "stock_code": ["A", "B", "C", "D"],
        "fwd_return": [0.1, 0.1, 0.1, 0.1],
    })
    nav_no_cost = run_topn_backtest(score, monthly_ret, top_n=2, cost_per_side=0.0)
    nav_with_cost = run_topn_backtest(score, monthly_ret, top_n=2, cost_per_side=0.002)
    r0 = nav_no_cost["port_ret"].drop_nulls().to_list()[0]
    r1 = nav_with_cost["port_ret"].drop_nulls().to_list()[0]
    assert r1 < r0


def test_initial_long_only_position_charges_single_side_cost():
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 2,
        "stock_code": ["A", "B"],
        "score": [2.0, 1.0],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 2,
        "return_date": [date(2025, 2, 28)] * 2,
        "stock_code": ["A", "B"],
        "fwd_return": [0.10, 0.10],
    })

    nav = run_topn_backtest(score, monthly_ret, top_n=2, cost_per_side=0.002)

    assert abs(nav["turnover"].item() - 1.0) < 1e-12
    assert abs(nav["port_ret_gross"].item() - 0.10) < 1e-12
    assert abs(nav["port_ret"].item() - 0.098) < 1e-12


def test_initial_group_long_short_charges_one_side_per_leg():
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 4,
        "stock_code": ["A", "B", "C", "D"],
        "score": [4.0, 3.0, 2.0, 1.0],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 4,
        "return_date": [date(2025, 2, 28)] * 4,
        "stock_code": ["A", "B", "C", "D"],
        "fwd_return": [0.10, 0.10, 0.00, 0.00],
    })

    out = run_group_backtests(score, monthly_ret, n_groups=2, group_prefix="G", cost_per_side=0.002)
    first_ls = out.filter(pl.col("portfolio") == "LS").row(0, named=True)

    assert abs(first_ls["turnover"] - 2.0) < 1e-12
    assert abs(first_ls["port_ret"] - (0.10 - 0.00 - 0.004)) < 1e-12


def test_batch_topn_matches_single_topn():
    """批量 top_n 复用同一份排名时，结果应与逐个调用内核完全一致。"""
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 5 + [date(2025, 2, 28)] * 5 + [date(2025, 3, 31)] * 5,
        "stock_code": ["A", "B", "C", "D", "E"] * 3,
        "score": [
            5.0, 4.0, 3.0, 2.0, 1.0,
            1.0, 2.0, 3.0, 4.0, 5.0,
            3.0, 5.0, 1.0, 4.0, 2.0,
        ],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 5 + [date(2025, 2, 28)] * 5,
        "stock_code": ["A", "B", "C", "D", "E"] * 2,
        "fwd_return": [0.10, 0.08, 0.06, 0.04, 0.02, -0.01, 0.03, 0.05, 0.07, 0.09],
    })

    batch = run_topn_backtests(score, monthly_ret, top_ns=[1, 2, 4], cost_per_side=0.002)

    for top_n, got in batch.items():
        expected = run_topn_backtest(score, monthly_ret, top_n=top_n, cost_per_side=0.002)
        assert_frame_equal(got, expected)


def test_topn_backtest_missing_member_return_is_not_reweighted():
    score = pl.DataFrame(
        {
            "trade_date": [date(2024, 1, 31), date(2024, 1, 31)],
            "stock_code": ["A", "B"],
            "score": [2.0, 1.0],
        }
    )
    monthly_ret = pl.DataFrame(
        {
            "trade_date": [date(2024, 1, 31), date(2024, 1, 31)],
            "return_date": [date(2024, 2, 29), None],
            "stock_code": ["A", "B"],
            "fwd_return": [0.10, None],
            "has_forward_return": [True, False],
        }
    )

    nav = run_topn_backtest(score, monthly_ret, top_n=2, cost_per_side=0.0)

    assert abs(nav["port_ret"].item() - (-0.45)) < 1e-12


def test_group_long_short_subtracts_costs_for_both_sides():
    score = pl.DataFrame(
        {
            "trade_date": [date(2024, 1, 31), date(2024, 1, 31), date(2024, 2, 29), date(2024, 2, 29)],
            "stock_code": ["A", "B", "A", "B"],
            "score": [2.0, 1.0, 1.0, 2.0],
        }
    )
    monthly_ret = pl.DataFrame(
        {
            "trade_date": [date(2024, 1, 31), date(2024, 1, 31), date(2024, 2, 29), date(2024, 2, 29)],
            "return_date": [date(2024, 2, 29), date(2024, 2, 29), date(2024, 3, 29), date(2024, 3, 29)],
            "stock_code": ["A", "B", "A", "B"],
            "fwd_return": [0.10, 0.00, 0.00, 0.10],
            "has_forward_return": [True, True, True, True],
        }
    )

    out = run_group_backtests(score, monthly_ret, n_groups=2, group_prefix="G", cost_per_side=0.002)
    ls_second = out.filter((pl.col("portfolio") == "LS") & (pl.col("trade_date") == date(2024, 2, 29))).row(0, named=True)

    assert abs(ls_second["port_ret"] - (0.10 - 0.00 - 0.008)) < 1e-12


def test_industry_neutral_holdings_allocate_target_industry_weights():
    """行业中性组合应按目标行业权重分配到行业内高分股票，而不是简单等权。"""
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 6,
        "stock_code": ["A1", "A2", "A3", "B1", "B2", "B3"],
        "score": [9.0, 8.0, 1.0, 7.0, 6.0, 5.0],
        "industry_sw1": ["行业A", "行业A", "行业A", "行业B", "行业B", "行业B"],
        "industry_weight": [0.50, 0.50, 0.50, 0.50, 0.50, 0.50],
    })

    holdings = build_industry_neutral_holdings(score, top_n=3)
    got = {
        r["stock_code"]: r["weight"]
        for r in holdings.sort("stock_code").iter_rows(named=True)
    }

    assert set(got) == {"A1", "A2", "B1"}
    assert abs(sum(got.values()) - 1.0) < 1e-12
    assert abs(got["A1"] - 0.25) < 1e-12
    assert abs(got["A2"] - 0.25) < 1e-12
    assert abs(got["B1"] - 0.50) < 1e-12


def test_industry_neutral_backtest_uses_stock_weights_for_return():
    """行业中性回测收益应使用持仓权重加权，且输出换手和净值。"""
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 6,
        "stock_code": ["A1", "A2", "A3", "B1", "B2", "B3"],
        "score": [9.0, 8.0, 1.0, 7.0, 6.0, 5.0],
        "industry_sw1": ["行业A", "行业A", "行业A", "行业B", "行业B", "行业B"],
        "industry_weight": [0.50, 0.50, 0.50, 0.50, 0.50, 0.50],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 6,
        "return_date": [date(2025, 2, 28)] * 6,
        "stock_code": ["A1", "A2", "A3", "B1", "B2", "B3"],
        "fwd_return": [0.10, 0.00, 0.00, 0.20, 0.00, 0.00],
    })

    nav = run_industry_neutral_topn_backtest(score, monthly_ret, top_n=3, cost_per_side=0.0)

    expected = 0.25 * 0.10 + 0.50 * 0.20
    assert nav["trade_date"].to_list() == [date(2025, 1, 31)]
    assert nav["return_date"].to_list() == [date(2025, 2, 28)]
    assert abs(nav["port_ret"].item() - expected) < 1e-12
    assert abs(nav["turnover"].item() - 1.0) < 1e-12
    assert abs(nav["nav"].item() - (1.0 + expected)) < 1e-12


def test_industry_neutral_script_initial_position_charges_single_side_cost():
    module = load_industry_neutral_backtest_script()
    holdings = pl.DataFrame({
        "trade_date": [date(2025, 1, 31), date(2025, 1, 31)],
        "top_n": [2, 2],
        "stock_code": ["A", "B"],
        "weight": [0.5, 0.5],
        "industry_sw1": ["行业A", "行业B"],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31), date(2025, 1, 31)],
        "return_date": [date(2025, 2, 28), date(2025, 2, 28)],
        "stock_code": ["A", "B"],
        "fwd_return": [0.10, 0.10],
    })

    nav = module.nav_from_weighted_holdings_all_topn(holdings, monthly_ret, cost_per_side=0.002)

    row = nav.row(0, named=True)
    assert abs(row["turnover"] - 1.0) < 1e-12
    assert abs(row["port_ret"] - 0.098) < 1e-12


def test_backtest_keeps_signal_date_and_return_date():
    """回测结果应同时保留信号日和收益结束日，方便页面按收益落地月展示。"""
    score = pl.DataFrame({
        "trade_date": [date(2026, 4, 30)] * 2,
        "stock_code": ["A", "B"],
        "score": [2.0, 1.0],
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2026, 4, 30)] * 2,
        "return_date": [date(2026, 5, 29)] * 2,
        "stock_code": ["A", "B"],
        "fwd_return": [0.10, 0.00],
    })

    nav = run_topn_backtest(score, monthly_ret, top_n=1, cost_per_side=0.0)

    assert nav["trade_date"].to_list() == [date(2026, 4, 30)]
    assert nav["return_date"].to_list() == [date(2026, 5, 29)]
    assert abs(nav["port_ret"].to_list()[0] - 0.10) < 1e-6


def test_quantile_backtest_builds_monotonic_buckets_and_long_short():
    """完美因子下，最高分位应跑赢最低分位，多空应等于 Q5-Q1。"""
    codes = [f"S{i}" for i in range(10)]
    score = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 10 + [date(2025, 2, 28)] * 10,
        "stock_code": codes * 2,
        "score": list(range(10, 0, -1)) * 2,
    })
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 10 + [date(2025, 2, 28)] * 10,
        "return_date": [date(2025, 2, 28)] * 10 + [date(2025, 3, 31)] * 10,
        "stock_code": codes * 2,
        "fwd_return": [0.10, 0.09, 0.07, 0.05, 0.03, 0.01, -0.01, -0.03, -0.05, -0.08] * 2,
    })

    out = run_quantile_backtests(score, monthly_ret, n_quantiles=5, cost_per_side=0.0)
    portfolios = set(out["portfolio"].to_list())
    assert portfolios == {"Q1", "Q2", "Q3", "Q4", "Q5", "LS"}

    first_month = out.filter(pl.col("trade_date") == date(2025, 1, 31))
    q1 = first_month.filter(pl.col("portfolio") == "Q1")["port_ret"].item()
    q5 = first_month.filter(pl.col("portfolio") == "Q5")["port_ret"].item()
    ls = first_month.filter(pl.col("portfolio") == "LS")["port_ret"].item()

    assert q5 > q1
    assert abs(ls - (q5 - q1)) < 1e-9


def test_quantile_backtest_reversed_scores_flip_long_short():
    """把分数取反后，默认多空收益应翻到相反方向。"""
    codes = [f"S{i}" for i in range(10)]
    monthly_ret = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 10,
        "stock_code": codes,
        "fwd_return": [0.10, 0.09, 0.07, 0.05, 0.03, 0.01, -0.01, -0.03, -0.05, -0.08],
    })
    score_default = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 10,
        "stock_code": codes,
        "score": list(range(10, 0, -1)),
    })
    score_reverse = score_default.with_columns((-pl.col("score")).alias("score"))

    default_ls = (
        run_quantile_backtests(score_default, monthly_ret, n_quantiles=5, cost_per_side=0.0)
        .filter(pl.col("portfolio") == "LS")["port_ret"].item()
    )
    reverse_ls = (
        run_quantile_backtests(score_reverse, monthly_ret, n_quantiles=5, cost_per_side=0.0)
        .filter(pl.col("portfolio") == "LS")["port_ret"].item()
    )

    assert default_ls > 0
    assert reverse_ls < 0
    assert abs(default_ls + reverse_ls) < 1e-9
