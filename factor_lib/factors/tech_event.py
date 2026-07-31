"""技术扩充 + 业绩快报事件类因子。

大部分原始值来自资料/download_more_factors.py下载的Wind CSV，由02f_load_more_factors.py取值：
  revtech.csv   —— 收益风险技术（RevenueTechnicalFactor，TRADE_DT 月末直取）
  turntech.csv  —— 换手量价技术（除 VR 外，TRADE_DT 月末直取）
  mktderiv.csv  —— 市场衍生（仅保留股价偏度月末直取；AROON/MFLOW20/RVI由日行情回算）
  profitexpress.csv —— 业绩快报（AShareProfitExpress，已 PIT as-of 对齐月末）→ 事件驱动

取值方式（transform）：
  - level       ：直接用字段当月值
  - event_first ：业绩快报「首次出现」——只在该期快报首次进入截面的月末发出值，其余月份缺失。
                  由 02f 用 EXPRESS_AGE 反推报告期、检测报告期跳进实现（真正的事件信号，不 carry-forward）。

注意：02/02b 不 import 本模块，所以这批因子只走 02f 加载；03/06 import 本模块取元数据。
"""
from __future__ import annotations

from datetime import date

import polars as pl

from factor_lib.registry import factor, register_external

# (code, l1, l2, direction, name_cn, source_file, source_field, transform, description)
_DEFS = [
    # ============ revtech：收益风险技术（市场交易信息·风险技术）============
    ("GLVR60",   "市场交易信息", "风险技术", -1, "收益损失方差比(60D)", "revtech", "S_RISK_GLVARIANCERATIO60", "level",
     "近60日收益方差 / 损失方差；A股实测该比率偏高者后续收益反而偏低（低风险异象），按 RankIC 取负向。"),
    ("TREYNOR60", "市场交易信息", "风险技术", -1, "特诺雷比率(60D)", "revtech", "S_RISK_TREYNORRATIO60", "level",
     "近60日 (超额收益 / Beta)；A股低风险/反转特征，实测高者后续收益偏低，按 RankIC 取负向。"),
    ("REVSVAR",  "市场交易信息", "风险技术", -1, "回报方差比率(30/120)", "revtech", "S_RISK_REVSVARRATIO", "level",
     "30日 / 120日回报方差比；短期波动相对放大者后续收益偏低，按 RankIC 取负向。"),
    ("KURT60",   "市场交易信息", "风险技术", -1, "收益峰度(60D)", "revtech", "S_RISK_KURTOSIS60", "level",
     "近60日日收益峰度；越高尾部极端风险越大，故负向。"),
    # ============ turntech：换手量价技术（市场交易信息·量价技术）============
    ("TURN20D120", "市场交易信息", "量价技术", -1, "短长换手比(20/120)", "turntech", "S_TECH_TURN20DTURN120", "level",
     "20日 / 120日换手率比；越高交易越拥挤，拥挤度回撤风险大，故负向。"),
    ("VOL1M60",  "市场交易信息", "量价技术", -1, "量能比(20/60)", "turntech", "S_TECH_VOLUME1M60", "level",
     "20日 / 60日成交量比；A股实测放量者后续收益偏低（拥挤/反转），按 RankIC 取负向。"),
    ("TURNVOL20", "市场交易信息", "量价技术", -1, "换手率波动(20D)", "turntech", "S_TECH_TURNOVERRATEVOL20", "level",
     "换手率相对波动率；换手不稳定=交易结构不稳，故负向。"),
    # ============ mktderiv：市场衍生（市场交易信息·趋势资金）============
    ("PSKEW",    "市场交易信息", "趋势资金", -1, "股价偏度", "mktderiv", "S_TECH_SKEWNESS", "level",
     "股价收益偏度；正偏=彩票偏好，历史上对应未来低收益，故负向。"
     "（Wind 该表自 2022-10 起才有全市场覆盖，有效历史约 3 年。）"),
    # ============ profitexpress：业绩快报（公司内生信息·业绩快报(事件)，首次出现）============
    ("EXPDEDNP", "公司内生信息", "业绩快报(事件)", 1, "快报扣非净利同比", "profitexpress", "S_FA_YOYNETPROFIT_DEDUCTED", "event_first",
     "业绩快报扣非归母净利润同比；仅在快报首次披露当月发出（事件驱动）。"),
    ("EXPSALES", "公司内生信息", "业绩快报(事件)", 1, "快报营收同比", "profitexpress", "S_FA_YOYSALES", "event_first",
     "业绩快报营业收入同比；仅在快报首次披露当月发出（事件驱动）。"),
    ("EXPROE",   "公司内生信息", "业绩快报(事件)", 1, "快报摊薄ROE", "profitexpress", "ROE_DILUTED", "event_first",
     "业绩快报摊薄净资产收益率；仅在快报首次披露当月发出（事件驱动）。"),
    ("EXPOP",    "公司内生信息", "业绩快报(事件)", 1, "快报营业利润同比", "profitexpress", "S_FA_YOYOP", "event_first",
     "业绩快报营业利润同比；仅在快报首次披露当月发出（事件驱动）。"),
]

_WIND_TABLE = {
    "revtech": "RevenueTechnicalFactor",
    "turntech": "TurnoverTechnicalFactor",
    "mktderiv": "MarketDerivativeFactor",
    "profitexpress": "AShareProfitExpress（业绩快报，PIT as-of 对齐月末）",
}

_TRANSFORM_DESC = {"level": "当月值", "event_first": "快报首次披露当月值（事件驱动）"}

for code, l1, l2, direction, name_cn, sfile, sfield, transform, desc in _DEFS:
    register_external(
        code=code, l1=l1, l2=l2, direction=direction, name_cn=name_cn,
        source_file=sfile, source_field=sfield, description=desc, transform=transform,
        formula=f"{name_cn} = {_WIND_TABLE[sfile]}.{sfield}（{_TRANSFORM_DESC[transform]}）",
        wind_source=f"{_WIND_TABLE[sfile]}.{sfield}",
    )


def _recent(panel: pl.DataFrame, asof: date, window: int) -> pl.DataFrame:
    return (
        panel.filter(pl.col("trade_date") <= asof)
        .sort(["stock_code", "trade_date"])
        .with_columns(
            pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("_rk")
        )
        .filter(pl.col("_rk") <= window)
    )


@factor(
    code="VR",
    l1="市场交易信息",
    l2="量价技术",
    direction=-1,
    name_cn="成交量比率VR(24D)",
    formula=(
        "VR24 = sum(S_DQ_VOLUME | S_DQ_ADJCLOSE_t>S_DQ_ADJCLOSE_{t-1},24D) / "
        "sum(S_DQ_VOLUME | S_DQ_ADJCLOSE_t<S_DQ_ADJCLOSE_{t-1},24D)"
    ),
    wind_source="AShareEODPrices.S_DQ_ADJCLOSE; S_DQ_VOLUME",
    description=(
        "近24个交易日上涨日成交量合计除以下跌日成交量合计；涨跌按复权收盘价判断，"
        "平盘日成交量不进入分子或分母。实测高者后续收益偏低，方向取负。"
    ),
)
def vr(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    """用 25 个价格观测构造 24 个涨跌比较，平盘日成交量不计入。"""
    h = (
        _recent(panel, asof, 25)
        .sort(["stock_code", "trade_date"])
        .with_columns(pl.col("adj_close").shift(1).over("stock_code").alias("_prev_close"))
        .with_columns(
            (
                pl.col("adj_close").is_not_null()
                & pl.col("_prev_close").is_not_null()
                & pl.col("volume").is_not_null()
                & (pl.col("volume") >= 0)
            ).alias("_valid")
        )
        .with_columns([
            pl.when(pl.col("_valid") & (pl.col("adj_close") > pl.col("_prev_close")))
            .then(pl.col("volume"))
            .otherwise(0.0)
            .alias("_up_volume"),
            pl.when(pl.col("_valid") & (pl.col("adj_close") < pl.col("_prev_close")))
            .then(pl.col("volume"))
            .otherwise(0.0)
            .alias("_down_volume"),
        ])
    )
    return (
        h.group_by("stock_code")
        .agg([
            pl.col("_up_volume").sum().alias("_up_sum"),
            pl.col("_down_volume").sum().alias("_down_sum"),
            pl.col("_valid").sum().alias("_n_valid"),
        ])
        .filter((pl.col("_n_valid") == 24) & (pl.col("_down_sum") > 0))
        .with_columns((pl.col("_up_sum") / pl.col("_down_sum")).alias("value"))
        .select(["stock_code", "value"])
        .filter(pl.col("value").is_finite())
    )


@factor(
    code="AROON",
    l1="市场交易信息",
    l2="趋势资金",
    direction=-1,
    name_cn="阿隆趋势",
    formula="AROON = AroonUp(25)-AroonDown(25)",
    wind_source="AShareEODPrices.S_DQ_HIGH; S_DQ_LOW",
    description="25日阿隆上行指标减阿隆下行指标；越高代表上行趋势越强，按历史RankIC取负向。",
)
def aroon(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    h = _recent(panel, asof, 25).drop_nulls(["high", "low"])
    out = (
        h.group_by("stock_code")
        .agg([
            ((pl.col("high").arg_max() + 1) * 4.0).alias("up"),
            ((pl.col("low").arg_min() + 1) * 4.0).alias("down"),
            pl.len().alias("n"),
        ])
        .filter(pl.col("n") == 25)
        .with_columns((pl.col("up") - pl.col("down")).alias("value"))
    )
    return out.select(["stock_code", "value"])


@factor(
    code="MFLOW20",
    l1="市场交易信息",
    l2="趋势资金",
    direction=-1,
    name_cn="资金流量(20D)",
    formula="MFLOW20 = sum(((S_DQ_CLOSE+S_DQ_HIGH+S_DQ_LOW)/3)*S_DQ_VOLUME*100,20)",
    wind_source="AShareEODPrices.S_DQ_CLOSE; S_DQ_HIGH; S_DQ_LOW; S_DQ_VOLUME",
    description="近20日典型价格乘实际成交量的资金流量合计；数值越高规模和近期资金流入越大，方向负。",
)
def mflow20(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    h = _recent(panel, asof, 20).drop_nulls(["close", "high", "low", "volume"])
    out = (
        h.filter(pl.col("volume") >= 0)
        .with_columns(
            (((pl.col("close") + pl.col("high") + pl.col("low")) / 3.0) * pl.col("volume") * 100.0)
            .alias("money_flow")
        )
        .group_by("stock_code")
        .agg([pl.col("money_flow").sum().alias("value"), pl.len().alias("n")])
        .filter(pl.col("n") == 20)
    )
    return out.select(["stock_code", "value"])


@factor(
    code="RVI",
    l1="市场交易信息",
    l2="趋势资金",
    direction=1,
    name_cn="相对离散指数RVI",
    formula="RVI = (S_DQ_CLOSE-S_DQ_OPEN)/(S_DQ_HIGH-S_DQ_LOW)",
    wind_source="AShareEODPrices.S_DQ_OPEN; S_DQ_HIGH; S_DQ_LOW; S_DQ_CLOSE",
    description="当日实体相对高低价振幅的比例；越高表示收盘相对开盘更强，方向正。",
)
def rvi(panel: pl.DataFrame, asof: date) -> pl.DataFrame:
    h = _recent(panel, asof, 1).drop_nulls(["open", "high", "low", "close"])
    return (
        h.filter(pl.col("high") > pl.col("low"))
        .with_columns(((pl.col("close") - pl.col("open")) / (pl.col("high") - pl.col("low"))).alias("value"))
        .select(["stock_code", "value"])
        .filter(pl.col("value").is_finite())
    )
