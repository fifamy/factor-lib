"""Word v2 factor classification helpers.

The public HTML uses the same two-level tree as the Word v2 document:
``0级分类`` -> ``1级分类``.  Some executable system factors are not named in
the Word document, so this module assigns them to the closest existing Word
category instead of leaving older implementation-only buckets in the UI.
"""
from __future__ import annotations

from collections.abc import Mapping


WORD_L2 = {
    "估值类",
    "盈利能力类",
    "盈利质量类",
    "成长类",
    "财务稳健类",
    "运营效率类",
    "分红回报类",
    "收益趋势类",
    "均值回复类",
    "波动风险类",
    "beta风险类",
    "流动性类",
    "交易约束类",
    "价量配合类",
    "拥挤度类",
    "微观结构类",
    "资金流类",
    "筹码结构类",
    "分析师预期类",
    "关注度类",
    "情绪舆情类",
    "业绩事件类",
    "资本运作类",
    "股东行为类",
    "风险事件类",
    "供给冲击类",
}


def _pairs(l1: str, l2: str, codes: str) -> dict[str, tuple[str, str]]:
    return {code: (l1, l2) for code in codes.split()}


WORD_CATEGORY_BY_CODE: dict[str, tuple[str, str]] = {}
WORD_CATEGORY_BY_CODE.update(_pairs(
    "公司内生信息", "估值类",
    "PE PB PS EP PE_DED EV2EBITDA PCF PBPCTL RELPEIND RELPBIND PEPCTL EV2EBIT LNMV FWDPE",
))
WORD_CATEGORY_BY_CODE.update(_pairs("公司内生信息", "分红回报类", "DIVYLD DIVPAYOUT DIVSTREAK DIVGROWTH"))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "公司内生信息", "盈利能力类",
    "ROE ROA ROIC GROSSMGN NETMGN OPMGN",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "公司内生信息", "盈利质量类",
    "OCF2OR OCF2OI ACCRUAL ROEVOL",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "公司内生信息", "成长类",
    "NPGROWTH OPGROWTH CFOGROWTH GMGROWTH DEDNPGROWTH EQGROWTH ROEGROWTH ORGROWTH GRCAGR3Y ORCAGR3Y RDEXPRATIOCHG CAPEXGROWTH",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "公司内生信息", "财务稳健类",
    "LEVERAGE IMPAIRRISK CURRENT QUICK CASHRATIO INTCOVER DEBT2EQ EQMULT OCF2DEBT TANG2ASSET INTDEBTRATIO GOODWILLRATIO",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "公司内生信息", "运营效率类",
    "ASSETTURN INVTURN ARTURN CATURN FATURN ARRATIO",
))

WORD_CATEGORY_BY_CODE.update(_pairs(
    "市场交易信息", "收益趋势类",
    "MOM12_1 REV1M REV5D MOM60 MOM20 RELRET60 RELRETIND AROON RVI",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "市场交易信息", "均值回复类",
    "PRICEZ MA20BIAS HLPOS",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "市场交易信息", "波动风险类",
    "DASTD DOWNVOL MAXDD1Y RETSKEW RETKURT BIGDOWN GLVR60 TREYNOR60 REVSVAR KURT60 PSKEW",
))
WORD_CATEGORY_BY_CODE.update(_pairs("市场交易信息", "beta风险类", "BETA"))
WORD_CATEGORY_BY_CODE.update(_pairs("市场交易信息", "beta风险类", "DOWNBETA"))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "市场交易信息", "流动性类",
    "STOM AMOUNT20 VOLUME20 TURN20 AMTVOL TURNVOL TURNVOL20",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "市场交易信息", "交易约束类",
    "SUSPENDDAYS LIMITUPDAYS LIMITDOWNDAYS ONEBOARDDAYS",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "市场交易信息", "价量配合类",
    "PVCORR UPVOLRATIO VOL1M60 VR",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "市场交易信息", "拥挤度类",
    "ABTURN TURNPCTL TURN20D120 HIGHMOMTURN",
))

WORD_CATEGORY_BY_CODE.update(_pairs(
    "投资者行为信息", "资金流类",
    "MAINFLOW MARGINBALCHG MARGINBUYRATIO MFLOW20",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "投资者行为信息", "筹码结构类",
    "HOLDERCHG HOLDERCONC HOLDERCONCCHG HOLDERAVGCHG INSTHOLD TOP10HOLD UNLOCKPRESS",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "投资者行为信息", "分析师预期类",
    "NPFCST1M NPFCST3M EPSFCST1M SALESFCST1M FCSTGROWTH FCSTDISP RATINGCHG TARGETPRICECHG ESTEARNREV",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "投资者行为信息", "关注度类",
    "SURVEYCNT SURVEYINSTCNT ANALYSTCOVER",
))

WORD_CATEGORY_BY_CODE.update(_pairs(
    "事件驱动信息", "业绩事件类",
    "EXPDEDNP EXPSALES EXPROE EXPOP PROFITNOTICEBEAT REPORTSURPRISE",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "事件驱动信息", "资本运作类",
    "PLACEDISCOUNT INCENTIVESIZE PLACEMENTSIZE MERGERSIZE",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "事件驱动信息", "股东行为类",
    "BUYBACKRATIO MAJORHOLDERCHG EXECHOLDERCHG",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "事件驱动信息", "风险事件类",
    "RISKINVESTCNT PUNISHAMT LAWSUITAMT AUDITQUAL FINRESTATEMENT",
))
WORD_CATEGORY_BY_CODE.update(_pairs(
    "事件驱动信息", "供给冲击类",
    "UNLOCKMVRATIO REFINPRESS",
))


_L2_FALLBACK = {
    "Beta": "beta风险类",
    "业绩快报(事件)": "业绩事件类",
    "交易状态": "交易约束类",
    "价量": "价量配合类",
    "估值": "估值类",
    "关注度": "关注度类",
    "分析师预期": "分析师预期类",
    "动量": "收益趋势类",
    "回购增减持": "股东行为类",
    "均值回复": "均值回复类",
    "市值": "估值类",
    "成长": "成长类",
    "拥挤度": "拥挤度类",
    "波动": "波动风险类",
    "流动性": "流动性类",
    "盈利能力": "盈利能力类",
    "盈利质量": "盈利质量类",
    "筹码结构": "筹码结构类",
    "股权激励": "资本运作类",
    "融资并购": "资本运作类",
    "融资融券": "资金流类",
    "财务稳健": "财务稳健类",
    "财务质量": "财务稳健类",
    "资金流": "资金流类",
    "趋势资金": "收益趋势类",
    "运营效率": "运营效率类",
    "量价技术": "价量配合类",
    "风险事件": "风险事件类",
    "风险技术": "波动风险类",
}


def word_category_for_factor(code: str, meta: Mapping[str, object]) -> tuple[str, str]:
    """Return ``(l1, l2)`` using the Word v2 category system."""
    if code in WORD_CATEGORY_BY_CODE:
        return WORD_CATEGORY_BY_CODE[code]
    l1 = str(meta.get("l1") or "")
    l2 = str(meta.get("l2") or "")
    return l1, _L2_FALLBACK.get(l2, l2)
