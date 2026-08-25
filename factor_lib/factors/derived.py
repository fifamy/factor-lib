"""派生因子（用已有数据跨月/跨股计算，零新下载）。由 scripts/02e_derived_factors.py 加载。

这些因子需要"多月时序/截面"计算（分位、复合增速、相对收益），不是单字段直取，
也不是 @factor 的"按月 panel"形态，故单独由 02e 算好追加 factor_raw。
02b/02d 不 import 本模块，互不影响；03/06 import 取元数据。
"""
from __future__ import annotations
from factor_lib.registry import register_external

# (code, l1, l2, direction, name_cn, source_key, description)
_DEFS = [
    ("GRCAGR3Y", "公司内生信息", "成长", 1, "营收3年复合增速", "grcagr3y",
     "营业总收入(TTM) 近3年复合年增速 = (今值/36月前值)^(1/3) − 1；持续高成长。"),
    ("PBPCTL", "公司内生信息", "估值", -1, "PB历史分位", "pbpctl",
     "仅对 PB>0 的有经济含义样本，计算市净率在自身过去36个月的分位（0~1）；分位越低=相对自身越便宜，方向负。"),
    ("RELRET60", "市场交易信息", "动量", 1, "相对市场收益", "relret60",
     "个股近60交易日收益 − 全市场中位收益；跑赢大盘的相对强度。"),
    ("RELPEIND", "公司内生信息", "估值", -1, "行业相对PE", "relpeind",
     "仅使用 PE>0 样本：个股PE − 历史时点所属申万一级行业同截面正PE中位数；相对行业越便宜越好，方向负。"),
    ("RELPBIND", "公司内生信息", "估值", -1, "行业相对PB", "relpbind",
     "仅使用 PB>0 样本：个股PB − 历史时点所属申万一级行业同截面正PB中位数；相对行业越便宜越好，方向负。"),
    ("RELRETIND", "市场交易信息", "动量", 1, "相对行业收益", "relretind",
     "个股近60交易日收益 − 历史时点所属申万一级行业指数同期收益；相对行业的强度。"),
]

for code, l1, l2, direction, name_cn, key, desc in _DEFS:
    register_external(
        code=code, l1=l1, l2=l2, direction=direction, name_cn=name_cn,
        source_file=key, source_field=key, description=desc, transform="derived",
        formula=desc, wind_source="派生（已有数据计算）",
        input_positive_only=code in {"PBPCTL", "RELPEIND", "RELPBIND"},
    )
