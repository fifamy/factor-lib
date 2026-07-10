"""投资者行为信息类因子（技术文档 3.1~3.3）。

原始值来自 download_investor_factors.py 下载的 4 个 CSV，由 02d_load_investor_factors.py 取值。
有两类取法（transform）：
  - level   ：直接用字段当月值（预期变化、分歧度、主力净流入强度、北向占比）
  - mom_diff：逐股月度差分（北向持股占比变化）
  - mom_pct ：逐股月度变化率（股东户数变化）

注意：02b 不 import 本模块，所以这批因子不走 02b；由独立的 02d 加载。03/06 import 本模块取元数据。
"""
from __future__ import annotations

from factor_lib.registry import register_external

# (code, l2, direction, name_cn, source_file, source_field, transform, description)
_DEFS = [
    # ---- 3.3 分析师预期类 ----
    ("NPFCST1M", "分析师预期", 1, "净利预期上修(1M)", "consensus", "S_WEST_NETPROFIT_FTM_1M", "level",
     "一致预测净利润(未来12月)近1个月的变化率；上修=分析师看好，正向。"),
    ("NPFCST3M", "分析师预期", 1, "净利预期上修(3M)", "consensus", "S_WEST_NETPROFIT_FTM_3M", "level",
     "一致预测净利润(未来12月)近3个月的变化率。"),
    ("EPSFCST1M", "分析师预期", 1, "EPS预期上修(1M)", "consensus", "S_WEST_EPS_FY1_1M", "level",
     "一致预测每股收益(FY1)近1个月的变化率。"),
    ("SALESFCST1M", "分析师预期", 1, "营收预期上修(1M)", "consensus", "S_WEST_SALES_FTM_1M", "level",
     "一致预测营业收入(未来12月)近1个月的变化率。"),
    ("FCSTGROWTH", "分析师预期", 1, "预期成长", "consensus", "S_WEST_EPS_FYGROWTH", "level",
     "一致预测 FY2/FY1 每股收益增速预期；预期成长越高越好。"),
    ("FCSTDISP", "分析师预期", -1, "盈利预测分歧度", "consensus", "S_WEST_STDEPS_FY1", "level",
     "一致预测 EPS(FY1) 的标准差；分歧越大不确定性越高，方向负。"),
    # ---- 3.1 资金流类 ----
    ("MAINFLOW", "资金流", 1, "主力净流入强度", "moneyflow", "MAINFORCE_NET_RATIO", "level",
     "近20交易日(机构+大户)净流入 / 近20日总成交额；主力资金净买入越强越好。"),
    ("NBRATIO", "资金流", 1, "北向持股占比", "northbound", "S_RATIO", "level",
     "陆股通(北向)持股占流通股比例；外资偏好，仅覆盖陆股通标的。"),
    ("NBHOLDCHG", "资金流", 1, "北向持股变化", "northbound", "S_RATIO", "mom_diff",
     "北向持股占比的月度变化(本月−上月，百分点)；北向净增持，正向。"),
    # ---- 3.2 筹码结构类 ----
    ("HOLDERCHG", "筹码结构", -1, "股东户数变化", "holdernum", "S_HOLDER_NUM", "mom_pct",
     "股东户数月度变化率；户数减少=筹码集中(通常利好)，方向负。"),
    ("HOLDERCONC", "筹码结构", 1, "户均持股(集中度)", "holderconc", "PER_HOLDER", "level",
     "户均流通股 = 流通股本 / 股东户数；越高=散户越少、筹码越集中，正向。"),
    ("HOLDERCONCCHG", "筹码结构", 1, "筹码集中度变化", "holderconc", "PER_HOLDER", "mom_pct",
     "户均持股的月度变化率；上升=筹码进一步集中，正向。"),
]

_WIND_TABLE = {
    "consensus": "ConsensusExpectationFactor",
    "moneyflow": "AShareMoneyFlow（日频→近20日聚合）",
    "northbound": "SHSCChannelholdings（陆股通持股）",
    "holdernum": "AShareHolderNumber（ANN_DT PIT 对齐）",
    "holderconc": "AShareHolderNumber + price_panel（户均流通股，本地算）",
}

_TRANSFORM_DESC = {"level": "当月值", "mom_diff": "月度差分", "mom_pct": "月度变化率"}

for code, l2, direction, name_cn, sfile, sfield, transform, desc in _DEFS:
    register_external(
        code=code, l1="投资者行为信息", l2=l2, direction=direction, name_cn=name_cn,
        source_file=sfile, source_field=sfield, description=desc, transform=transform,
        formula=f"{name_cn} = {_WIND_TABLE[sfile]}.{sfield}（{_TRANSFORM_DESC[transform]}）",
        wind_source=f"{_WIND_TABLE[sfile]}.{sfield}",
    )
