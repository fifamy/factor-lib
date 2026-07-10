"""动量类因子：MOM12_1（12 月动量剔除 1 月），REV1M（短期反转）。"""
from __future__ import annotations

from datetime import date
import numpy as np
import polars as pl

from factor_lib.registry import factor


def _half_life_weights(window: int, half_life: int) -> np.ndarray:
    """半衰期加权：w_k = 0.5^(k / half_life)，从最近到最远。

    返回长度 window 的权重数组，已归一化到和为 1。
    """
    k = np.arange(window)
    w = 0.5 ** (k / half_life)
    return w / w.sum()


@factor(
    code="MOM12_1",
    l1="市场交易信息",
    l2="动量",
    direction=1,
    description="过去 252 个交易日剔除最近 21 个交易日的累计对数收益，半衰期 126 加权。"
)
def mom12_1(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    """MOM12_1: 半衰期 126 加权累计对数收益，窗口 [t-252, t-22]。

    参数：
        panel: 长面板 (stock_code, trade_date, adj_close, ...)
        asof:  截面日（取 asof 当天可观察的过去 252 个交易日）
    返回：
        DataFrame(stock_code, value)
    """
    skip_days = 21
    window = 252 - skip_days  # 231
    half_life = 126

    df = (
        panel.filter(pl.col("trade_date") <= asof)
             .sort(["stock_code", "trade_date"])
    )

    weights = _half_life_weights(window, half_life)

    results = []
    for code, sub in df.group_by("stock_code"):
        prices = sub["adj_close"].to_numpy()
        if len(prices) < 253:
            results.append({"stock_code": code[0], "value": None})
            continue
        # 253 个价格点对应 252 个交易日收益；剔除最近 21 个收益，留下 [t-252, t-22]。
        recent_253 = prices[-253:]
        log_ret = np.diff(np.log(recent_253))
        # 取 [t-252, t-22]：前 231 个 log_ret
        window_ret = log_ret[:window]
        # 半衰期：越近越大（weights[0] 最大）；window_ret[0] 是最远日 → 反转 weights
        value = float(np.sum(window_ret * weights[::-1]))
        results.append({"stock_code": code[0], "value": value})

    return pl.DataFrame(results)


@factor(
    code="REV1M",
    l1="市场交易信息",
    l2="动量",
    direction=-1,
    description="过去 21 个交易日的累计对数收益（短期反转：高过去收益往往跟随回调）。"
)
def rev1m(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    """REV1M = ln(P_asof / P_{asof-21})。"""
    df = (
        panel.filter(pl.col("trade_date") <= asof)
             .sort(["stock_code", "trade_date"])
    )

    results = []
    for code, sub in df.group_by("stock_code"):
        prices = sub["adj_close"].to_numpy()
        if len(prices) < 22:
            results.append({"stock_code": code[0], "value": None})
            continue
        ret = float(np.log(prices[-1] / prices[-22]))
        results.append({"stock_code": code[0], "value": ret})

    return pl.DataFrame(results)
