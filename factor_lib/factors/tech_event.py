"""技术扩充 + 业绩快报事件类因子（本批新接入的 4 个 Wind CSV）。

原始值来自 资料/download_more_factors.py 下载的 4 个 CSV，由 02f_load_more_factors.py 取值：
  revtech.csv   —— 收益风险技术（RevenueTechnicalFactor，TRADE_DT 月末直取）
  turntech.csv  —— 换手量价技术（TurnoverTechnicalFactor，TRADE_DT 月末直取）
  mktderiv.csv  —— 市场衍生（MarketDerivativeFactor，趋势/资金/偏度，TRADE_DT 月末直取）
  profitexpress.csv —— 业绩快报（AShareProfitExpress，已 PIT as-of 对齐月末）→ 事件驱动

取值方式（transform）：
  - level       ：直接用字段当月值（前 12 个技术因子）
  - event_first ：业绩快报「首次出现」——只在该期快报首次进入截面的月末发出值，其余月份缺失。
                  由 02f 用 EXPRESS_AGE 反推报告期、检测报告期跳进实现（真正的事件信号，不 carry-forward）。

注意：02/02b 不 import 本模块，所以这批因子只走 02f 加载；03/06 import 本模块取元数据。
"""
from __future__ import annotations

from factor_lib.registry import register_external

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
    ("VR",       "市场交易信息", "量价技术", -1, "成交量比率VR", "turntech", "S_TECH_VR", "level",
     "成交量比率（上涨日量 / 下跌日量）；实测高者后续收益偏低，按 RankIC 取负向。"),
    ("TURNVOL20", "市场交易信息", "量价技术", -1, "换手率波动(20D)", "turntech", "S_TECH_TURNOVERRATEVOL20", "level",
     "换手率相对波动率；换手不稳定=交易结构不稳，故负向。"),
    # ============ mktderiv：市场衍生（市场交易信息·趋势资金）============
    # 注：mktderiv（MarketDerivativeFactor）这 4 个 Wind 字段仅自 2022-10 起有全市场覆盖，
    #     之前月份近乎空（单股），故有效历史约 3 年、IC 样本偏少、IC_IR 噪声较大。
    ("MFLOW20",  "市场交易信息", "趋势资金", -1, "资金流量(20D)", "mktderiv", "S_TECH_MONEYFLOW20", "level",
     "近20日资金流量指标；A股实测近期资金大幅流入者后续收益偏低（追高反转），按 RankIC 取负向。"
     "（Wind 该表自 2022-10 起才有全市场覆盖，有效历史约 3 年。）"),
    ("AROON",    "市场交易信息", "趋势资金", -1, "阿隆趋势", "mktderiv", "S_TECH_AROON", "level",
     "Aroon 趋势指标；实测上行趋势强者后续收益偏低（动量反转），按 RankIC 取负向。"
     "（Wind 该表自 2022-10 起才有全市场覆盖，有效历史约 3 年。）"),
    ("PSKEW",    "市场交易信息", "趋势资金", -1, "股价偏度", "mktderiv", "S_TECH_SKEWNESS", "level",
     "股价收益偏度；正偏=彩票偏好，历史上对应未来低收益，故负向。"
     "（Wind 该表自 2022-10 起才有全市场覆盖，有效历史约 3 年。）"),
    ("RVI",      "市场交易信息", "趋势资金", 1, "相对离散指数RVI", "mktderiv", "S_TECH_RVI", "level",
     "相对离散指数（Relative Vigor Index）；动能向上越强越好。"
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
