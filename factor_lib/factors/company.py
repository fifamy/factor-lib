"""公司内生信息类因子（对应《因子库技术文档_v0.1.docx》1.1~1.4）。

这些因子的原始值是 Wind 已算好的字段（PIT 财务因子 / 估值指标 / 日频估值），
由 scripts/09b... 不，由 scripts/02b_load_external_factors.py 从 CSV 取值，
不需要计算函数。这里只登记元数据 + CSV 字段映射。

source_file ∈ {pit_financial, valuation, daily_valuation}（对应 资料/*.csv）。
"""
from __future__ import annotations

from factor_lib.registry import register_external

# (code, l1, l2, direction, name_cn, source_file, source_field, description)
_DEFS = [
    # ---- 1.1 估值类 ----
    ("PE",        "公司内生信息", "估值", -1, "市盈率PE",   "valuation", "S_VAL_PE_TTM",
     "PE = 总市值 / TTM归母净利润；越低越便宜。"),
    ("PB",        "公司内生信息", "估值", -1, "市净率PB",   "valuation", "S_VAL_PB_LF",
     "PB = 总市值 / 归母净资产；越低账面估值越便宜。"),
    ("PS",        "公司内生信息", "估值", -1, "市销率PS",   "valuation", "S_VAL_PS_TTM",
     "PS = 总市值 / TTM营业收入；适用盈利波动大的成长公司。"),
    ("DIVYLD",    "公司内生信息", "估值", 1,  "股息率",     "valuation", "S_VAL_DIVIDENDYIELD2",
     "近12个月现金分红 / 总市值；越高分红回报越好。"),
    ("EP",        "公司内生信息", "估值", 1,  "收益市值比", "daily_valuation", "S_DFA_PROFITTOMV",
     "EP = TTM净利润 / 总市值（PE 的倒数）；越高越便宜。"),
    ("PE_DED",    "公司内生信息", "估值", -1, "扣非市盈率", "daily_valuation", "S_DFA_PETTM_DEDUCTED",
     "扣除非经常性损益后的 PE(TTM)；剔除一次性损益的估值。"),
    ("EV2EBITDA", "公司内生信息", "估值", -1, "总市值/EBITDA", "daily_valuation", "S_DFA_MVTOEBITDA",
     "总市值 / EBITDA(TTM)；仅反映股权市值相对经营收益的估值，不等同于企业价值倍数。"),
    # ---- 1.2 盈利能力类 ----
    ("ROE",       "公司内生信息", "盈利能力", 1, "净资产收益率", "pit_financial", "S_DFA_ROE_TTM",
     "ROE = TTM归母净利润 / 平均归母净资产；股东资本回报。"),
    ("ROA",       "公司内生信息", "盈利能力", 1, "总资产收益率", "pit_financial", "S_DFA_ROA1_TTM",
     "ROA = TTM净利润 / 平均总资产；资产盈利效率。"),
    ("ROIC",      "公司内生信息", "盈利能力", 1, "投入资本回报率", "pit_financial", "S_DFA_ROIC_TTM",
     "ROIC = NOPAT / 平均投入资本；投入资本回报。"),
    ("GROSSMGN",  "公司内生信息", "盈利能力", 1, "毛利率", "pit_financial", "S_DFA_GROSSPROFITMARGIN_TTM",
     "毛利率 = (营收-营业成本)/营收；产品盈利空间。"),
    ("NETMGN",    "公司内生信息", "盈利能力", 1, "净利率", "pit_financial", "S_DFA_NETPROFITMARGIN_TTM",
     "净利率 = TTM净利润 / TTM营收；收入转化利润能力。"),
    ("OPMGN",     "公司内生信息", "盈利能力", 1, "营业利润率", "pit_financial", "S_DFA_OPTOOR_TTM",
     "营业利润 / 营业收入（≈EBIT Margin）；经营盈利率。"),
    # ---- 1.3 盈利质量类 ----
    ("OCF2OR",    "公司内生信息", "盈利质量", 1, "现金流收入比", "pit_financial", "S_DFA_OCFTOOR_TTM",
     "经营活动现金流 / 营业收入；利润的现金含量。"),
    # ---- 1.4 成长类 ----
    ("NPGROWTH",  "公司内生信息", "成长", 1, "净利润同比", "pit_financial", "S_DFA_TTMGROWRATE_NETPROFIT",
     "归母净利润 TTM 同比增速。"),
    ("OPGROWTH",  "公司内生信息", "成长", 1, "营业利润同比", "pit_financial", "S_DFA_TTMGROWRATE_OP",
     "营业利润 TTM 同比增速。"),
    ("CFOGROWTH", "公司内生信息", "成长", 1, "现金流同比", "pit_financial", "S_DFA_TTMGROWRATE_CFOTT",
     "经营活动现金流 TTM 同比增速。"),
    # ---- 1.5 财务稳健（杠杆，顺带） ----
    ("LEVERAGE",  "公司内生信息", "财务稳健", -1, "资产负债率", "pit_financial", "S_DFA_DEBTTOASSET",
     "总负债 / 总资产；越高财务杠杆/风险越大。"),

    # ================= 以下为本批扩充（数据已下载，Wind 已算好，直接登记） =================
    # ---- 1.1 估值（补充） ----
    ("LNMV",      "公司内生信息", "市值", -1, "对数市值", "daily_valuation", "S_DFA_LNMV",
     "ln(总市值)；Barra Size 风格因子，A 股小市值历史占优故标负向。"),
    ("PCF",       "公司内生信息", "估值", -1, "市现率PCF", "valuation", "S_VAL_PCF_OCFTTM",
     "PCF = 总市值 / TTM经营活动现金流；越低现金流估值越便宜。"),
    # ---- 1.2 盈利能力（补充） ----
    ("OCF2OI",    "公司内生信息", "盈利质量", 1, "现金流经营收益比", "pit_financial", "S_DFA_OCFTOOPERATEINCOME_TTM",
     "经营活动现金流净额 / 经营活动净收益；经营收益的现金支撑。"),
    # ---- 1.3 盈利质量（补充） ----
    ("ACCRUAL",   "公司内生信息", "盈利质量", 1, "现金流资产比（负应计）", "pit_financial", "S_DFA_ACCA",
     "现金流资产比=(经营现金流-净利润)/平均总资产×100%；数值越高，盈利现金含量越好。"),
    ("IMPAIRRISK","公司内生信息", "财务稳健", -1, "减值风险", "pit_financial", "S_DFA_IMPAIRTOGR_TTM",
     "资产减值损失 / 营业总收入(TTM)；越高减值风险越大，故负向。"),
    # ---- 1.4 成长（补充） ----
    ("GMGROWTH",  "公司内生信息", "成长", 1, "毛利率同比改善（百分点）", "pit_financial", "S_DFA_GROSSPROFITMARGIN_TTM",
     "销售毛利率(TTM)相对12个月前同月的百分点变化。"),
    ("DEDNPGROWTH","公司内生信息", "成长", 1, "扣非净利同比", "financial_indicator", "S_FA_YOYNETPROFIT_DEDUCTED",
     "扣非归母净利润同比增速；剔除一次性损益的真实成长。"),
    ("EQGROWTH",  "公司内生信息", "成长", 1, "净资产增长率", "financial_indicator", "S_FA_YOYEQUITY",
     "归母净资产比年初增长率。"),
    ("ROEGROWTH", "公司内生信息", "成长", 1, "ROE同比", "financial_indicator", "S_FA_YOYROE",
     "净资产收益率(摊薄)同比变化。"),
    ("ORGROWTH",  "公司内生信息", "成长", 1, "营业收入同比", "financial_indicator", "S_FA_YOY_OR",
     "营业收入同比增速。"),
    # ---- 1.5 财务稳健（补充） ----
    ("CURRENT",   "公司内生信息", "财务稳健", 1, "流动比率", "financial_indicator", "S_FA_CURRENT",
     "流动资产 / 流动负债；短期偿债能力，越高越稳健。"),
    ("QUICK",     "公司内生信息", "财务稳健", 1, "速动比率", "financial_indicator", "S_FA_QUICK",
     "(流动资产-存货) / 流动负债；剔除存货的短期偿债能力。"),
    ("CASHRATIO", "公司内生信息", "财务稳健", 1, "保守速动比率", "financial_indicator", "S_FA_CASHRATIO",
     "(货币资金+交易性金融资产+应收票据+应收账款+其他应收款)/流动负债。"),
    ("INTCOVER",  "公司内生信息", "财务稳健", 1, "利息保障倍数", "financial_indicator", "S_FA_EBITTOINTEREST",
     "已获利息倍数 = EBIT / 利息费用；偿付利息的能力，越高越安全。"),
    ("DEBT2EQ",   "公司内生信息", "财务稳健", -1, "产权比率", "financial_indicator", "S_FA_DEBTTOEQUITY",
     "总负债 / 总权益；越高财务杠杆越大，故负向。"),
    ("EQMULT",    "公司内生信息", "财务稳健", -1, "权益乘数", "financial_indicator", "S_FA_ASSETSTOEQUITY",
     "总资产 / 股东权益 = 1/(1-资产负债率)；越高杠杆越大，故负向。"),
    ("OCF2DEBT",  "公司内生信息", "财务稳健", 1, "现金流负债比", "financial_indicator", "S_FA_OCFTODEBT",
     "经营活动现金流净额 / 负债合计；偿债的现金保障。"),
    ("TANG2ASSET","公司内生信息", "财务稳健", 1, "有形资产占比", "financial_indicator", "S_FA_TANGIBLEASSETSTOASSETS",
     "有形资产 / 总资产；资产质量，无形/商誉占比越低越实。"),
    # ---- 1.6 运营效率 ----
    ("ASSETTURN", "公司内生信息", "运营效率", 1, "总资产周转率", "financial_indicator", "S_FA_ASSETSTURN",
     "营业总收入 / 平均总资产；资产运用效率。"),
    ("INVTURN",   "公司内生信息", "运营效率", 1, "存货周转率", "financial_indicator", "S_FA_INVTURN",
     "营业成本 / 平均存货；存货周转速度。"),
    ("ARTURN",    "公司内生信息", "运营效率", 1, "应收账款周转率", "financial_indicator", "S_FA_ARTURN",
     "营业收入 / 平均应收账款；回款效率。"),
    ("CATURN",    "公司内生信息", "运营效率", 1, "流动资产周转率", "financial_indicator", "S_FA_CATURN",
     "营业总收入 / 平均流动资产。"),
    ("FATURN",    "公司内生信息", "运营效率", 1, "固定资产周转率", "financial_indicator", "S_FA_FATURN",
     "营业总收入 / 平均固定资产；产能利用效率。"),
]

_WIND_TABLE = {
    "valuation": "AShareValuationIndicator",
    "daily_valuation": "DailyValuationFactor",
    "pit_financial": "PITFinancialFactor（PIT，无未来函数）",
    "financial_indicator": "AShareFinancialIndicator（按 ANN_DT PIT as-of 对齐月末）",
}

# 价格/盈利类估值比率：分母为负（亏损/负净资产/负现金流/负EBITDA）时，比率没有"便宜"含义，
# 03_normalize 会把原始值 ≤0 置为缺失，避免亏损股被当成"超低估值"选进 top。
_POSITIVE_ONLY = {"PE", "PB", "PS", "PE_DED", "EV2EBITDA", "PCF"}
_TRANSFORMS = {"GMGROWTH": "yoy_diff_12m"}

for code, l1, l2, direction, name_cn, sfile, sfield, desc in _DEFS:
    register_external(
        code=code, l1=l1, l2=l2, direction=direction, name_cn=name_cn,
        source_file=sfile, source_field=sfield, description=desc,
        formula=(
            "GMGROWTH = S_DFA_GROSSPROFITMARGIN_TTM_t - S_DFA_GROSSPROFITMARGIN_TTM_{t-12个月}"
            if code == "GMGROWTH"
            else "ACCRUAL = S_DFA_ACCA = (经营现金流TTM - 净利润TTM) / 平均总资产 × 100%"
            if code == "ACCRUAL"
            else f"{name_cn} = {_WIND_TABLE[sfile]}.{sfield}（Wind已算好，月末截面取值）"
        ),
        wind_source=f"{_WIND_TABLE[sfile]}.{sfield}",
        positive_only=code in _POSITIVE_ONLY,
        transform=_TRANSFORMS.get(code, "level"),
    )
