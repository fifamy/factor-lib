"""测试归一化函数与脚本。"""
import numpy as np
import polars as pl
import pytest
import subprocess
import sys
from pathlib import Path

from factor_lib.normalize import (
    winsorize_3mad, cross_section_zscore, rank_to_normal, apply_direction,
    neutralize_by_industry_size,
)


def test_winsorize_clips_outliers():
    x = np.array([1, 2, 3, 4, 5, 100], dtype=float)
    out = winsorize_3mad(x)
    assert out[-1] < 100
    assert out[-1] >= 5


def test_winsorize_preserves_normal_data():
    x = np.array([1, 2, 3, 4, 5], dtype=float)
    out = winsorize_3mad(x)
    np.testing.assert_array_almost_equal(out, x)


def test_zscore_mean_zero_std_one():
    x = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    z = cross_section_zscore(x)
    assert abs(z.mean()) < 1e-10
    assert abs(z.std(ddof=0) - 1.0) < 1e-10


def test_zscore_handles_nan():
    x = np.array([1.0, 2.0, np.nan, 4.0, 5.0])
    z = cross_section_zscore(x)
    assert np.isnan(z[2])
    assert not np.isnan(z[0])


def test_rank_to_normal_strictly_monotonic():
    """严格保序：输入大 → 输出大，无并列（除非输入真的相等）。"""
    x = np.array([3.0, 1.0, 2.0, 5.0, 4.0])
    z = rank_to_normal(x)
    # 输出顺序应与输入排名一致
    assert np.argsort(z).tolist() == np.argsort(x).tolist()
    # 全不相等的输入 → 输出也全不相等
    assert len(set(np.round(z, 8))) == len(x)


def test_rank_to_normal_approx_standard_normal():
    """大样本下 ≈ N(0,1)：均值≈0，标准差≈1。"""
    rng = np.random.default_rng(0)
    x = rng.standard_normal(5000)
    z = rank_to_normal(x)
    assert abs(z.mean()) < 0.05
    assert abs(z.std(ddof=0) - 1.0) < 0.05


def test_rank_to_normal_robust_to_heavy_tail():
    """重尾右偏因子（如 ROE）：不再大量并列顶格。

    构造 1000 个样本，其中 50 个是极大值。z-score 缩尾后这 50 个会并列同一上限；
    rank_to_normal 则给它们 50 个互不相同、单调递增的高分。
    """
    x = np.concatenate([np.arange(950, dtype=float), 1e6 + np.arange(50, dtype=float)])
    z = rank_to_normal(x)
    top = z[-50:]               # 那 50 个极大值
    assert len(set(np.round(top, 8))) == 50   # 全部可区分，无并列
    assert np.all(np.diff(top) > 0)            # 严格递增


def test_rank_to_normal_handles_nan():
    x = np.array([1.0, 2.0, np.nan, 4.0, 5.0])
    z = rank_to_normal(x)
    assert np.isnan(z[2])
    assert not np.isnan(z[0])
    # 有效值的均值仍≈0
    assert abs(np.nanmean(z)) < 1e-9


def test_rank_to_normal_ties_share_value():
    """真正相等的输入 → 相同输出（平均法）。"""
    x = np.array([1.0, 2.0, 2.0, 3.0])
    z = rank_to_normal(x)
    assert abs(z[1] - z[2]) < 1e-12


def test_rank_to_normal_singleton_section_is_missing_not_neutral_score():
    """稀疏截面（仅 1 个有效值）：不得把未归一原始量级或伪中性 0 当 score。

    回归：某些月份事件/技术因子只有 1 只票有值，rank_to_normal 旧实现 `n<2 return x`
    会把原始量级（可达 1e9）当成 score 直接输出，污染合成加权。之后曾置 0，
    但 0 容易被误读为截面中位数；单样本没有截面可比性，应置空。
    """
    x = np.array([np.nan, 7.65e9, np.nan])   # 单个有效值且量级巨大
    z = rank_to_normal(x)
    assert np.isnan(z[1])                     # 唯一有效值 → 无法排序，置空
    assert np.isnan(z[0]) and np.isnan(z[2])  # NaN 仍保留
    # 全 NaN（n=0）也不应炸
    allnan = rank_to_normal(np.array([np.nan, np.nan]))
    assert np.all(np.isnan(allnan))


def test_apply_direction_positive():
    score = np.array([1.0, -1.0, 0.0])
    out = apply_direction(score, direction=1)
    np.testing.assert_array_equal(out, score)


def test_apply_direction_negative():
    score = np.array([1.0, -1.0, 0.0])
    out = apply_direction(score, direction=-1)
    np.testing.assert_array_equal(out, -score)


def test_neutralize_by_industry_size_removes_sw1_and_size_exposure():
    """残差应去掉申万一级行业均值差异和 log 市值线性暴露。"""
    industries = np.array(["银行", "银行", "银行", "医药", "医药", "医药", "科技", "科技", "科技"], dtype=object)
    market_caps = np.array([100, 200, 400, 120, 240, 480, 80, 160, 320], dtype=float)
    log_mv = np.log(market_caps)
    industry_effect = {"银行": 3.0, "医药": -1.5, "科技": 0.5}
    residual_signal = np.array([-0.30, 0.05, 0.25, 0.20, -0.10, -0.10, 0.10, 0.15, -0.25])
    values = np.array([industry_effect[i] for i in industries]) + 1.7 * log_mv + residual_signal

    resid = neutralize_by_industry_size(values, industries, market_caps)
    valid = ~np.isnan(resid)

    assert valid.sum() == len(values)
    assert abs(np.nanmean(resid)) < 1e-10
    for ind in set(industries):
        assert abs(np.nanmean(resid[industries == ind])) < 1e-10
    assert abs(np.corrcoef(resid[valid], log_mv[valid])[0, 1]) < 1e-10


def test_neutralize_by_industry_size_keeps_invalid_rows_nan():
    values = np.array([1.0, 2.0, 4.0, 3.0, np.nan, 5.0])
    industries = np.array(["银行", "银行", "医药", None, "医药", "医药"], dtype=object)
    market_caps = np.array([100.0, 200.0, 500.0, 300.0, 400.0, np.nan])

    resid = neutralize_by_industry_size(values, industries, market_caps)

    assert np.isfinite(resid[0])
    assert np.isfinite(resid[1])
    assert np.isfinite(resid[2])
    assert np.isnan(resid[3])
    assert np.isnan(resid[4])
    assert np.isnan(resid[5])


def test_neutralize_by_industry_size_sparse_sample_is_missing_not_demeaned():
    values = np.array([1.0, 2.0, np.nan])
    industries = np.array(["银行", "医药", "科技"], dtype=object)
    market_caps = np.array([100.0, 200.0, 300.0])

    resid = neutralize_by_industry_size(values, industries, market_caps)

    assert np.all(np.isnan(resid))


def test_03_normalize_script(tmp_path):
    """脚本 smoke 测试：构造一份迷你 raw，跑 03_normalize.py。"""
    from datetime import date
    raw = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 6,
        "stock_code": ["A", "B", "C", "A", "B", "C"],
        "factor_code": ["MOM12_1", "MOM12_1", "MOM12_1", "DASTD", "DASTD", "DASTD"],
        "raw_value": [0.1, 0.2, 0.3, 0.5, 0.4, 0.6],
    })
    raw_path = tmp_path / "factor_raw.parquet"
    out_path = tmp_path / "factor_score.parquet"
    raw.write_parquet(raw_path)

    subprocess.run(
        [sys.executable, "scripts/03_normalize.py",
         "--raw", str(raw_path),
         "--out", str(out_path)],
        check=True,
    )

    out = pl.read_parquet(out_path)
    assert set(out.columns) >= {"trade_date", "stock_code", "factor_code", "raw_value", "score"}
    for fac in ["MOM12_1", "DASTD"]:
        scores = out.filter(pl.col("factor_code") == fac)["score"].to_numpy()
        assert abs(np.mean(scores)) < 1e-6


def test_03_normalize_positive_only_excludes_nonpositive(tmp_path):
    """positive_only 因子（如 PE）：原始值 ≤0 的样本 score 应为空（不参与排序），
    但 raw_value 仍保留；正值样本正常打分。"""
    from datetime import date
    # PE 是已注册的 positive_only 因子。构造 4 只：两负两正。
    raw = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 4,
        "stock_code": ["A", "B", "C", "D"],
        "factor_code": ["PE"] * 4,
        "raw_value": [-50.0, -10.0, 8.0, 20.0],
    })
    raw_path = tmp_path / "factor_raw.parquet"
    out_path = tmp_path / "factor_score.parquet"
    raw.write_parquet(raw_path)
    subprocess.run(
        [sys.executable, "scripts/03_normalize.py",
         "--raw", str(raw_path), "--out", str(out_path)],
        check=True,
    )
    out = pl.read_parquet(out_path).sort("stock_code")
    score = dict(zip(out["stock_code"].to_list(), out["score"].to_list()))
    raw_v = dict(zip(out["stock_code"].to_list(), out["raw_value"].to_list()))
    # 负 PE：score 为空，raw_value 保留
    assert score["A"] is None and score["B"] is None
    assert raw_v["A"] == -50.0 and raw_v["B"] == -10.0
    # 正 PE：有分；PE=8 比 PE=20 便宜（direction=-1），得分更高
    assert score["C"] is not None and score["D"] is not None
    assert score["C"] > score["D"]


def test_03_normalize_applies_word_universe_when_panel_and_meta_are_passed(tmp_path):
    """传入 panel/meta 时，03 应按 Word 股票池过滤后再做截面标准化。"""
    from datetime import date, timedelta
    asof = date(2025, 1, 15)
    old_dates = [date(2024, 1, 1) + timedelta(days=i) for i in range((asof - date(2024, 1, 1)).days + 1)]
    young_dates = [date(2024, 10, 1) + timedelta(days=i) for i in range((asof - date(2024, 10, 1)).days + 1)]
    low_liq_dates = old_dates
    panel_rows = []
    for code, dates, amount in [
        ("000001.SZ", old_dates, 300.0),
        ("000002.SZ", young_dates, 300.0),
        ("000003.SZ", low_liq_dates, 100.0),
    ]:
        panel_rows.extend({
            "stock_code": code,
            "trade_date": d,
            "amount": amount,
            "is_suspended": False,
        } for d in dates)
    raw = pl.DataFrame({
        "trade_date": [asof, asof, asof],
        "stock_code": ["000001.SZ", "000002.SZ", "000003.SZ"],
        "factor_code": ["PE", "PE", "PE"],
        "raw_value": [10.0, 8.0, 6.0],
    })
    meta = pl.DataFrame({
        "stock_code": ["000001.SZ", "000002.SZ", "000003.SZ"],
        "is_st": [False, False, False],
    })
    raw_path = tmp_path / "factor_raw.parquet"
    panel_path = tmp_path / "price_panel.parquet"
    meta_path = tmp_path / "stock_meta.parquet"
    out_path = tmp_path / "factor_score.parquet"
    raw.write_parquet(raw_path)
    pl.DataFrame(panel_rows).write_parquet(panel_path)
    meta.write_parquet(meta_path)

    subprocess.run(
        [sys.executable, "scripts/03_normalize.py",
         "--raw", str(raw_path),
         "--out", str(out_path),
         "--panel", str(panel_path),
         "--meta", str(meta_path)],
        check=True,
    )

    out = pl.read_parquet(out_path)
    assert out["stock_code"].to_list() == ["000001.SZ"]


def test_03b_neutralize_script_uses_sw1_and_market_cap(tmp_path):
    """03b 输出 neutral score，并对行业/市值缺失样本置空。"""
    from datetime import date
    raw = pl.DataFrame({
        "trade_date": [date(2025, 1, 31)] * 7,
        "stock_code": ["A", "B", "C", "D", "E", "F", "G"],
        "factor_code": ["MOM12_1"] * 7,
        "raw_value": [10.0, 11.0, 12.0, 20.0, 21.0, 22.0, 30.0],
    })
    desc = pl.DataFrame({
        "stock_code": ["A", "B", "C", "D", "E", "F", "G"],
        "industry_sw1": ["银行", "银行", "银行", "医药", "医药", "医药", None],
        "market_cap": [100.0, 200.0, 400.0, 100.0, 200.0, 400.0, 500.0],
    })
    raw_path = tmp_path / "factor_raw.parquet"
    desc_path = tmp_path / "stock_descriptors.parquet"
    out_path = tmp_path / "factor_score_neutral.parquet"
    raw.write_parquet(raw_path)
    desc.write_parquet(desc_path)

    subprocess.run(
        [sys.executable, "scripts/03b_neutralize.py",
         "--raw", str(raw_path),
         "--descriptors", str(desc_path),
         "--out", str(out_path)],
        check=True,
    )

    out = pl.read_parquet(out_path).sort("stock_code")
    assert set(out.columns) >= {"trade_date", "stock_code", "factor_code", "raw_value", "score"}
    score = dict(zip(out["stock_code"].to_list(), out["score"].to_list()))
    assert score["G"] is None
    valid_scores = [v for k, v in score.items() if k != "G"]
    assert all(v is not None for v in valid_scores)
    assert max(valid_scores) > min(valid_scores)


def test_03b_neutralize_uses_panel_month_end_market_cap_not_static_descriptor(tmp_path):
    """传入 panel 时，中性化应使用截面月末市值，而不是描述表里的静态市值。"""
    from datetime import date
    import importlib.util

    spec = importlib.util.spec_from_file_location("neutralize03b", Path("scripts/03b_neutralize.py"))
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)

    raw_path = tmp_path / "factor_raw.parquet"
    desc_path = tmp_path / "stock_descriptors.parquet"
    panel_path = tmp_path / "price_panel.parquet"
    out_path = tmp_path / "factor_score_neutral.parquet"

    pl.DataFrame(
        {
            "trade_date": [date(2020, 1, 31), date(2020, 1, 31), date(2020, 1, 31)],
            "stock_code": ["A", "B", "C"],
            "factor_code": ["MOM12_1", "MOM12_1", "MOM12_1"],
            "raw_value": [1.0, 2.0, 3.0],
        }
    ).write_parquet(raw_path)
    pl.DataFrame(
        {
            "stock_code": ["A", "B", "C"],
            "industry_sw1": ["银行", "银行", "银行"],
            "market_cap": [999.0, 999.0, 999.0],
        }
    ).write_parquet(desc_path)
    pl.DataFrame(
        {
            "stock_code": ["A", "B", "C"],
            "trade_date": [date(2020, 1, 31), date(2020, 1, 31), date(2020, 1, 31)],
            "adj_close": [1.0, 1.0, 1.0],
            "market_cap": [10.0, 100.0, 1000.0],
            "amount": [1.0, 1.0, 1.0],
        }
    ).write_parquet(panel_path)

    mod.main(str(raw_path), str(desc_path), str(out_path), panel_path=str(panel_path), meta_path=None)

    out = pl.read_parquet(out_path)
    assert out.height == 3
    assert out["score"].null_count() < 3
