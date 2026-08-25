"""截面归一化：±3MAD 缩尾 + rank-based 高斯标准化 + 方向统一。"""
from __future__ import annotations

import numpy as np


def winsorize_3mad(x: np.ndarray) -> np.ndarray:
    """±3 MAD 缩尾。MAD = median(|x - median(x)|)，3MAD × 1.4826 约等于 ±3σ。"""
    x = x.astype(float).copy()
    valid_mask = ~np.isnan(x)
    if valid_mask.sum() == 0:
        return x
    valid = x[valid_mask]
    med = np.median(valid)
    mad = np.median(np.abs(valid - med))
    if mad == 0:
        return x
    upper = med + 3 * 1.4826 * mad
    lower = med - 3 * 1.4826 * mad
    x[valid_mask & (x > upper)] = upper
    x[valid_mask & (x < lower)] = lower
    return x


def cross_section_zscore(x: np.ndarray) -> np.ndarray:
    """截面 z-score。NaN 保留。"""
    x = x.astype(float).copy()
    valid = ~np.isnan(x)
    if valid.sum() < 2:
        return x
    mean = np.mean(x[valid])
    std = np.std(x[valid], ddof=0)
    if std == 0:
        return np.where(valid, 0.0, x)
    out = x.copy()
    out[valid] = (x[valid] - mean) / std
    return out


def rank_to_normal(x: np.ndarray) -> np.ndarray:
    """截面 rank → 正态分位数（rank-based 高斯标准化，Wind/Barra 常用）。

    为什么不用 mean/std z-score：重尾/右偏因子（如 ROE，少数极值拉高均值）
    缩尾后会有大量样本顶到缩尾边界、并列同一个 z 值，导致 Top-N 选股在并列中
    无法区分、排序退化为任意 tie-break。

    本函数改用截面分位 rank 映射到标准正态：
      r_i = rank(x_i) ∈ {1..n}（升序，平均法处理并列）
      p_i = (r_i - 0.5) / n         # ∈ (0,1)，避免端点 ±inf
      z_i = Φ⁻¹(p_i)                # 标准正态逆 CDF
    结果严格保序、对单调变换/重尾天然鲁棒，均值≈0、分布≈N(0,1)。
    NaN 保留（不参与 rank）。有效值少于 2 个时无法做截面排序：该唯一有效值
    置为 NaN，而不是原样返回原始值或置为 0。原样返回会把未归一的原始量级
    泄漏出去；置 0 则容易被误读为截面中位数。
    """
    from scipy.stats import norm, rankdata

    x = x.astype(float).copy()
    valid = ~np.isnan(x)
    n = int(valid.sum())
    if n < 2:
        x[valid] = np.nan
        return x
    out = x.copy()
    # 平均法处理并列：完全相等的值得到相同分位（仍可能并列，但仅限"真的相等"）
    ranks = rankdata(x[valid], method="average")
    p = (ranks - 0.5) / n
    out[valid] = norm.ppf(p)
    return out


def apply_direction(score: np.ndarray, direction: int) -> np.ndarray:
    """方向统一：direction=-1 的因子乘 -1。"""
    return score * direction


def _neutralization_design(
    values: np.ndarray,
    industries: np.ndarray,
    market_caps: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """构建中性化有效样本掩码和设计矩阵。"""
    v = np.asarray(values, dtype=float)
    ind = np.asarray(industries, dtype=object)
    mv = np.asarray(market_caps, dtype=float)
    valid_ind = np.array([
        x is not None and str(x) != "" and str(x).lower() != "nan"
        for x in ind
    ])
    valid = (~np.isnan(v)) & valid_ind & (~np.isnan(mv)) & (mv > 0)
    n = int(valid.sum())
    if n == 0:
        return valid, np.empty((0, 0), dtype=float)

    valid_industries = ind[valid].astype(str)
    levels = sorted(set(valid_industries.tolist()))
    cols = [np.ones(n)]
    for level in levels[1:]:
        cols.append((valid_industries == level).astype(float))
    cols.append(np.log(mv[valid]))
    return valid, np.column_stack(cols)


def neutralization_design_stats(
    values: np.ndarray,
    industries: np.ndarray,
    market_caps: np.ndarray,
) -> dict[str, int]:
    """返回中性化回归的样本数、列数、秩和剩余自由度。

    剩余自由度以矩阵实际秩计算，而不是简单用样本数减列数。
    该诊断同时供生产计算、质量标记和发布审计使用，避免三者口径分叉。
    """
    valid, xmat = _neutralization_design(values, industries, market_caps)
    n = int(valid.sum())
    n_parameters = int(xmat.shape[1]) if xmat.ndim == 2 else 0
    try:
        rank = int(np.linalg.matrix_rank(xmat)) if n and n_parameters else 0
    except np.linalg.LinAlgError:
        rank = 0
    return {
        "valid_count": n,
        "parameter_count": n_parameters,
        "design_rank": rank,
        "residual_dof": max(n - rank, 0),
    }


def neutralize_by_industry_size(
    values: np.ndarray,
    industries: np.ndarray,
    market_caps: np.ndarray,
) -> np.ndarray:
    """对原始因子做申万一级行业 + log 市值中性化，返回回归残差。

    有效样本要求：
    - values 非 NaN；
    - industries 非空；
    - market_caps > 0。

    回归设计矩阵为：常数项 + 行业哑变量（drop first）+ log(market_cap)。
    无效样本残差保留 NaN。样本过少时不退化为去均值，避免把未充分中性化
    的结果伪装成行业/市值中性残差。
    """
    v = np.asarray(values, dtype=float)
    out = np.full(v.shape, np.nan, dtype=float)
    valid, xmat = _neutralization_design(values, industries, market_caps)
    n = int(valid.sum())
    if n < 3:
        return out

    # 样本数多于 2 不等于回归有可识别的剩余项。事件类稀疏因子常见
    # n == rank(X)，此时残差只是 1e-15 量级的数值噪声，不得再排名成信号。
    try:
        design_rank = int(np.linalg.matrix_rank(xmat))
    except np.linalg.LinAlgError:
        return out
    if design_rank < xmat.shape[1] or n - design_rank <= 0:
        return out

    try:
        beta, *_ = np.linalg.lstsq(xmat, v[valid], rcond=None)
        resid = v[valid] - xmat @ beta
    except np.linalg.LinAlgError:
        return out

    # 完全可由行业/市值解释的截面没有剩余信号。将浮点回归误差
    # 显式压为 0，避免后续线性标准化把 1e-15 噪声放大成排序。
    tolerance = np.finfo(float).eps * max(xmat.shape) * max(float(np.linalg.norm(v[valid])), 1.0)
    if float(np.linalg.norm(resid)) <= tolerance:
        resid = np.zeros_like(resid)

    out[valid] = resid
    return out
