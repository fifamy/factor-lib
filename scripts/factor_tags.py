from __future__ import annotations

import numpy as np


TIME_DELTA = 0.012
RIC_DEAD = 0.01
ENV_Z_FLOOR = 0.5
TIME_TAGS = (
    "长期稳定型",
    "近期转强",
    "近期转弱",
    "近期失效",
    "持续反向",
    "反向改善",
    "反向恶化",
    "近期转正",
    "近期反转",
    "持续低效",
    "数据不足",
)


def classify_env_tag(z_bull: float | None, z_bear: float | None, z_shock: float | None, z_floor: float = ENV_Z_FLOOR) -> str:
    values = [
        (z_bull, "牛市进攻型"),
        (z_bear, "熊市防御型"),
        (z_shock, "震荡占优型"),
    ]
    if any(v is None or not np.isfinite(v) for v, _ in values):
        return "数据不足"
    zmax, tag = max(values, key=lambda t: t[0])
    return "全天候型" if zmax < z_floor else tag


def classify_time_tag(ric_all: float | None, ric_12: float | None) -> str:
    if ric_all is None or ric_12 is None or not np.isfinite(ric_all) or not np.isfinite(ric_12):
        return "数据不足"

    # 时效标签不只描述 RankIC 的变化幅度，也必须保留方向。
    # 否则“稳定地为负”会被误标为“长期稳定型”，负值收窄也会被
    # 误解为可直接用于正向排序的“近期转强”。
    delta = ric_12 - ric_all

    if abs(ric_all) < RIC_DEAD and abs(ric_12) < RIC_DEAD:
        return "持续低效"

    # 近期明确为负：历史正向/低效后转负称为“近期反转”；
    # 历史本就为负时，区分反向改善、恶化和持续反向。
    if ric_12 <= -RIC_DEAD:
        if ric_all > -RIC_DEAD:
            return "近期反转"
        if delta > TIME_DELTA:
            return "反向改善"
        if delta < -TIME_DELTA:
            return "反向恶化"
        return "持续反向"

    # 近期回到低效区间。历史正向因子视为失效；历史反向因子
    # 虽然有所改善，仍不能使用“转强”这个正向标签。
    if abs(ric_12) < RIC_DEAD:
        if ric_all >= RIC_DEAD:
            return "近期失效"
        if ric_all <= -RIC_DEAD:
            return "反向改善"
        return "持续低效"

    # 近期明确为正。历史反向跨过正负阈值时，单独标记“近期转正”。
    if ric_all <= -RIC_DEAD:
        return "近期转正"
    if ric_all < RIC_DEAD or delta > TIME_DELTA:
        return "近期转强"
    if delta < -TIME_DELTA:
        return "近期转弱"
    return "长期稳定型"


def recent_rank_ic_mean(months, rank_ic_values, window: int = 12, min_months: int = 6) -> float | None:
    pairs = []
    for month, value in zip(months, rank_ic_values):
        if value is None:
            continue
        v = float(value)
        if np.isfinite(v):
            pairs.append((month, v))
    if len(pairs) < min_months:
        return None
    pairs.sort(key=lambda item: item[0])
    recent = [v for _, v in pairs[-window:]]
    if len(recent) < min_months:
        return None
    return float(np.mean(recent))


def zscore_ignore_nan(values):
    x = np.array(values, float)
    out = np.full_like(x, np.nan, dtype=float)
    mask = np.isfinite(x)
    if mask.sum() == 0:
        return out
    s = x[mask].std()
    if s <= 0:
        out[mask] = 0.0
    else:
        out[mask] = (x[mask] - x[mask].mean()) / s
    return out
