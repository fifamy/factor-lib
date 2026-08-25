"""IC / Rank IC 计算辅助函数。

生产批量计算入口是`scripts/04_factor_ic.py`；本模块保留为轻量单截面
辅助函数和单元测试入口，样本过滤规则需与生产入口保持一致。
"""
from __future__ import annotations

import numpy as np
from scipy.stats import pearsonr, spearmanr

from factor_lib.monthly_returns import MIN_VALID_FORWARD_RETURN


def compute_ic_for_cross_section(score: np.ndarray, fwd_return: np.ndarray) -> tuple[float, float]:
    """单截面IC（Pearson）与RankIC（Spearman）。

    生产脚本会先剔除非有限分数，并只保留有效远期收益区间；这里同步
    执行相同过滤。常数截面或有效样本少于3只返回NaN，不作为有效IC。
    """
    score = np.asarray(score, dtype=float)
    fwd_return = np.asarray(fwd_return, dtype=float)
    mask = (
        np.isfinite(score)
        & np.isfinite(fwd_return)
        & (fwd_return >= MIN_VALID_FORWARD_RETURN)
    )
    if mask.sum() < 3:
        return float("nan"), float("nan")
    s = score[mask]
    r = fwd_return[mask]
    if np.all(s == s[0]) or np.all(r == r[0]):
        return float("nan"), float("nan")
    ic = pearsonr(s, r).statistic
    rank_ic = spearmanr(s, r).statistic
    ic = float(ic) if np.isfinite(ic) else float("nan")
    rank_ic = float(rank_ic) if np.isfinite(rank_ic) else float("nan")
    return ic, rank_ic
