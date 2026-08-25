"""因子注册器。

每个因子函数用 @factor(...) 装饰，注册到 FACTOR_REGISTRY。
后续 02_factor_compute.py 遍历 FACTOR_REGISTRY 跑所有因子。
"""
from __future__ import annotations

from typing import Callable

FACTOR_REGISTRY: dict[str, dict] = {}


def factor(code: str, l1: str, l2: str, direction: int, description: str = "",
           *, name_cn: str = "", formula: str = "", wind_source: str = "",
           v2_status: str = "computed"):
    """装饰器：把因子函数注册到 FACTOR_REGISTRY。

    参数：
        code:        因子英文短代码，全大写（如 "MOM12_1"）
        l1:          一级分类（如 "市场交易信息"）
        l2:          二级分类（如 "动量"）
        direction:   +1（正向，越高越好）或 -1（负向，越低越好）
        description: 一句话定义，前端因子详情页用
        name_cn/formula/wind_source/v2_status: v2 文档导出可选元数据
    """
    if direction not in (-1, 1):
        raise ValueError(f"direction 必须是 +1 或 -1，得到 {direction}")

    def deco(fn: Callable):
        if code in FACTOR_REGISTRY:
            raise ValueError(f"factor code {code!r} already registered")
        FACTOR_REGISTRY[code] = {
            "code": code,
            "l1": l1,
            "l2": l2,
            "direction": direction,
            "description": description,
            "name_cn": name_cn,
            "formula": formula,
            "wind_source": wind_source,
            "v2_status": v2_status,
            "compute": fn,
        }
        return fn

    return deco


def register_external(code: str, l1: str, l2: str, direction: int,
                      name_cn: str, source_file: str, source_field: str,
                      description: str = "", formula: str = "", wind_source: str = "",
                      positive_only: bool = False, transform: str = "level",
                      input_positive_only: bool = False):
    """登记一个「外部已算」因子（Wind 直接给出的字段值，无计算函数）。

    这类因子（PE/ROE/成长等）的原始值来自下载的 CSV（source_file 的 source_field 列），
    由 02b_load_external.py 取值，不走 @factor 的 compute。元数据同样进 FACTOR_REGISTRY，
    供归一化（取 direction）、导出目录（name_cn/formula/wind_source）使用。

    positive_only：估值类比率（PE/PS/PB/EV2EBITDA/PCF…）分母为负（亏损/负净资产/负现金流）
    时，比率本身没有"便宜/贵"的含义，负 PE 不是低估值而是公司亏钱。标记此项后，
    03_normalize 在标准化前把原始值 ≤0 置为缺失（不参与排序、不进 top）。

    input_positive_only：仅用于派生估值因子，表示底层 PE/PB 输入必须为正。
    派生差值本身可以为负，因此不能误用 ``positive_only`` 过滤输出。
    """
    if direction not in (-1, 1):
        raise ValueError(f"direction 必须是 +1 或 -1，得到 {direction}")
    if code in FACTOR_REGISTRY:
        raise ValueError(f"factor code {code!r} already registered")
    FACTOR_REGISTRY[code] = {
        "code": code, "l1": l1, "l2": l2, "direction": direction,
        "description": description, "compute": None, "external": True,
        "name_cn": name_cn, "source_file": source_file, "source_field": source_field,
        "formula": formula, "wind_source": wind_source,
        "positive_only": positive_only,
        "input_positive_only": input_positive_only,
        # transform: 取值方式。"level"=直接用字段值；"mom_diff"=逐股月度差分（本期−上期）；
        #            "mom_pct"=逐股月度变化率。差分类由 02d_load_investor_factors 处理。
        "transform": transform,
    }


def get_factor(code: str) -> dict:
    """按 code 取注册项。"""
    if code not in FACTOR_REGISTRY:
        raise KeyError(f"factor {code!r} not in registry")
    return FACTOR_REGISTRY[code]


def list_factors() -> list[str]:
    """所有已注册因子代码。"""
    return list(FACTOR_REGISTRY.keys())
