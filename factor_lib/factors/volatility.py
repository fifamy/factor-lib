"""波动率类因子：DASTD（日收益年化波动率）。"""
from __future__ import annotations

from datetime import date
import numpy as np
import polars as pl

from factor_lib.registry import factor


@factor(
    code="DASTD",
    l1="市场交易信息",
    l2="波动",
    direction=-1,
    description="过去 252 个交易日的日对数收益标准差，乘 √252 年化。"
)
def dastd(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    """DASTD: 日收益年化波动率 = std(log_ret_252) × √252。

    参数：
        panel: 长面板 (stock_code, trade_date, adj_close, ...)
        asof:  截面日（取 asof 当天可观察的过去 252 个交易日）
    返回：
        DataFrame(stock_code, value)
    """
    df = (
        panel.filter(pl.col("trade_date") <= asof)
             .sort(["stock_code", "trade_date"])
    )

    results = []
    for code, sub in df.group_by("stock_code"):
        prices = sub["adj_close"].to_numpy()
        if len(prices) < 252:
            results.append({"stock_code": code[0], "value": None})
            continue
        recent = prices[-252:]
        log_ret = np.diff(np.log(recent))
        annual_std = float(np.std(log_ret, ddof=1) * np.sqrt(252))
        results.append({"stock_code": code[0], "value": annual_std})

    return pl.DataFrame(results)
