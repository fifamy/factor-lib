"""IC / Rank IC 计算。"""
from __future__ import annotations

import numpy as np
from scipy.stats import pearsonr, spearmanr


def compute_ic_for_cross_section(score: np.ndarray, fwd_return: np.ndarray) -> tuple[float, float]:
    """单截面 IC（pearson）+ Rank IC（spearman）。NaN 自动剔除。"""
    mask = ~(np.isnan(score) | np.isnan(fwd_return))
    if mask.sum() < 3:
        return float("nan"), float("nan")
    s = score[mask]
    r = fwd_return[mask]
    ic = pearsonr(s, r).statistic
    rank_ic = spearmanr(s, r).statistic
    return float(ic), float(rank_ic)
