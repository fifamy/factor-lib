"""抽样 (stock, date) 单元、抽价格窗口、为单因子选代表样例。"""
from __future__ import annotations

from datetime import date

import polars as pl


UNIT_COLUMNS = ["stock_code", "trade_date"]


def _sample_unit_frame(units: pl.DataFrame, k: int) -> list[tuple[str, date]]:
    """对候选键确定性等距抽样，优先覆盖较新的截面。"""
    if units.is_empty() or k <= 0:
        return []
    sub = (
        units.select(UNIT_COLUMNS)
        .drop_nulls()
        .unique()
        .sort(UNIT_COLUMNS[::-1], descending=[True, False])
    )
    n = sub.height
    if n > k:
        step = n / k
        sub = sub[[int(i * step) for i in range(k)]]
    return [(r["stock_code"], r["trade_date"]) for r in sub.to_dicts()]


def price_window_upto(panel: pl.DataFrame, stock_code: str, asof: date, n: int,
                      panel_index: dict | None = None) -> pl.DataFrame:
    """取某股截至 asof（含）的最后 n 个交易日，按日期升序。

    panel_index（可选）：{stock_code: 该股按 trade_date 升序的子 DataFrame}。提供时直接
    在小子表上 filter，避免扫描整张 panel；不提供时回退为全表 filter（默认行为不变）。
    """
    if panel_index is not None:
        sub = panel_index.get(stock_code)
        if sub is None:
            return panel.head(0)
        return sub.filter(pl.col("trade_date") <= asof).tail(n)
    return (
        panel.filter((pl.col("stock_code") == stock_code) & (pl.col("trade_date") <= asof))
        .sort("trade_date")
        .tail(n)
    )


def sample_units(factor_raw: pl.DataFrame, code: str, k: int = 200) -> list[tuple[str, date]]:
    """从 factor_raw 中该因子的非空行里确定性抽 k 个 (stock_code, trade_date)。

    确定性：按 (trade_date desc, stock_code) 排序后等距取样，无随机。优先靠近最新截面。
    """
    sub = (
        factor_raw.filter((pl.col("factor_code") == code) & pl.col("raw_value").is_not_null())
        .select(UNIT_COLUMNS)
    )
    return _sample_unit_frame(sub, k)


def sample_missing_units(
    candidate_units: pl.DataFrame | None,
    stored_rows: pl.DataFrame,
    k: int = 200,
) -> list[tuple[str, date]]:
    """从合格样本池抽取生产端没有非空值的键，用于发现 ``ref_only``。

    ``candidate_units`` 应是该因子对应 Word 样本空间的月末股票键，而不是完整
    日频价格面板；这样参考实现不会把本就不应进入生产因子的股票误报为单边样本。
    """
    if candidate_units is None or candidate_units.is_empty():
        return []
    stored_keys = (
        stored_rows.filter(pl.col("raw_value").is_not_null())
        .select(UNIT_COLUMNS)
        .unique()
    )
    missing = (
        candidate_units.select(UNIT_COLUMNS)
        .unique()
        .join(stored_keys, on=UNIT_COLUMNS, how="anti")
    )
    return _sample_unit_frame(missing, k)


def representative_unit(factor_raw: pl.DataFrame, code: str) -> tuple[str, date] | None:
    """选 1 个展示用代表样例：最新截面里 raw_value 接近中位数的一只（避免只看极端值）。"""
    sub = factor_raw.filter((pl.col("factor_code") == code) & pl.col("raw_value").is_not_null())
    if sub.is_empty():
        return None
    latest = sub.select(pl.col("trade_date").max()).item()
    cs = sub.filter(pl.col("trade_date") == latest).sort("raw_value")
    mid = cs.row(cs.height // 2, named=True)
    return (mid["stock_code"], latest)
