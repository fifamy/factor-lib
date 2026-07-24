"""对账驱动：按因子类型选 numpy 重算或源回查，产出统一 recon 结构 + 代表样例。"""
from __future__ import annotations

import importlib.util
import math
from pathlib import Path

import polars as pl

from factor_lib.audit.refs import REF_IMPLS
from factor_lib.audit.sampling import (
    price_window_upto,
    representative_unit,
    sample_missing_units,
    sample_units,
)
from factor_lib.audit.source_recheck import recheck_external

SAMPLE_K = 200
REL_TOL = 1e-6
ABS_TOL = 1e-9
REL_TOL_BY_CODE = {
    # 回归 Beta 在早期样本会出现 1e-5 量级浮点差异；远低于口径错误，避免核对页红灯噪音。
    "BETA": 2e-4,
}

# 各计算因子参考实现所需价格窗口长度（与 refs.py / tests/test_audit_refs.py 一致）
WIN_N = {
    "REV1M": 22, "REV5D": 6, "MOM20": 21, "MOM60": 61, "MOM12_1": 253, "RSTR252": 253, "DASTD": 252,
    "DOWNVOL": 520, "MAXDD1Y": 252, "RETSKEW": 520, "RETKURT": 520, "BIGDOWN": 61,
    "AMOUNT20": 20, "VOLUME20": 20, "TURN20": 20, "STOM": 21, "AMTVOL": 20,
    "TURNVOL": 60, "TURNPCTL": 120, "PVCORR": 61, "UPVOLRATIO": 21, "PRICEZ": 20,
    "MA20BIAS": 20, "HLPOS": 60, "ABTURN": 60, "HIGHMOMTURN": 61, "BETA": 253, "DOWNBETA": 253,
    "AROON": 25, "MFLOW20": 20, "RVI": 1,
}
DEFAULT_WIN = 260
DERIVED_CODES = {"GRCAGR3Y", "PBPCTL", "RELRET60", "RELPEIND", "RELPBIND", "RELRETIND"}
ROOT = Path(__file__).resolve().parents[2]
WORD_V2_DEFAULT_SRC = ROOT / "资料" / "word_only_factor_data_direct_only_processed" / "parquet"
WORD_V2_MISSING_SRC = ROOT / "资料" / "word_only_factor_data_42_missing_processed" / "parquet"
FACTOR_GAP_SRC = ROOT / "资料" / "balance_sheet_interest_bearing_processed" / "parquet"
_WORD_V2_MODULE = None
_DERIVED_MODULE = None


def _close(ref, stored, rel_tol: float = REL_TOL) -> bool:
    if ref is None or stored is None:
        return False
    return abs(ref - stored) <= ABS_TOL + rel_tol * abs(stored)


def _finite_or_none(value):
    """Normalize missing and non-finite values before single-sided comparison."""
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _merge_units(*groups: list[tuple]) -> list[tuple]:
    """Merge deterministic samples while preserving their original order."""
    seen = set()
    out = []
    for group in groups:
        for unit in group:
            if unit not in seen:
                seen.add(unit)
                out.append(unit)
    return out


def _load_word_v2_loader():
    """Load scripts/02g_load_word_v2_factors.py without making scripts a package."""
    global _WORD_V2_MODULE
    if _WORD_V2_MODULE is not None:
        return _WORD_V2_MODULE
    path = ROOT / "scripts" / "02g_load_word_v2_factors.py"
    spec = importlib.util.spec_from_file_location("word_v2_loader_for_audit", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _WORD_V2_MODULE = mod
    return mod


def _load_derived_loader():
    """Load the production derived-factor builders for audit parity."""
    global _DERIVED_MODULE
    if _DERIVED_MODULE is not None:
        return _DERIVED_MODULE
    path = ROOT / "scripts" / "02e_derived_factors.py"
    spec = importlib.util.spec_from_file_location("derived_loader_for_audit", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _DERIVED_MODULE = mod
    return mod


def _word_v2_source_dir(src_dir: str) -> Path:
    src = Path(src_dir)
    if not src.is_absolute():
        src = ROOT / src
    if (src / "valuation_ext.parquet").exists():
        return src
    nested = src / "word_only_factor_data_direct_only_processed" / "parquet"
    if (nested / "valuation_ext.parquet").exists():
        return nested
    return WORD_V2_DEFAULT_SRC


def _word_v2_missing_source_dir(src_dir: str) -> Path:
    src = Path(src_dir)
    if not src.is_absolute():
        src = ROOT / src
    if (src / "consensus_rolling_ext.parquet").exists() or (src / "ann_financial_indicator_ext.parquet").exists():
        return src
    nested = src / "word_only_factor_data_42_missing_processed" / "parquet"
    if (nested / "consensus_rolling_ext.parquet").exists() or (nested / "ann_financial_indicator_ext.parquet").exists():
        return nested
    return WORD_V2_MISSING_SRC


def _read_word_v2_parquet(src: Path, name: str, columns: list[str], stocks: set[str] | None = None) -> pl.DataFrame:
    path = src / f"{name}.parquet"
    if not path.exists():
        return pl.DataFrame()
    schema = pl.scan_parquet(path).collect_schema().names()
    cols = [c for c in columns if c in schema]
    if not cols:
        return pl.DataFrame()
    lf = pl.scan_parquet(path).select(cols)
    if stocks and "S_INFO_WINDCODE" in cols:
        lf = lf.filter(pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().is_in(sorted(stocks)))
    return lf.collect()


def _read_word_v2_parquet_preserve_order(src: Path, name: str, columns: list[str], stocks: set[str]) -> pl.DataFrame:
    df = _read_word_v2_parquet(src, name, columns, None)
    if df.is_empty() or "S_INFO_WINDCODE" not in df.columns:
        return df
    return df.filter(pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().is_in(sorted(stocks)))


def _all_month_keys(factor_raw: pl.DataFrame) -> set[str]:
    return set(factor_raw["trade_date"].unique().cast(pl.Utf8).str.replace_all("-", "").to_list())


def _word_v2_reference_code(code: str, factor_raw: pl.DataFrame, ctx: dict, src_dir: str,
                            units: list[tuple]) -> pl.DataFrame:
    src = _word_v2_source_dir(src_dir)
    missing_src = _word_v2_missing_source_dir(src_dir)
    if not src.exists() and not missing_src.exists():
        return pl.DataFrame({"trade_date": [], "stock_code": [], "factor_code": [], "raw_value": []})
    stocks = {stock for stock, _ in units}
    keep_dates = _all_month_keys(factor_raw)
    cache_key = ("word_v2_reference_code", code, str(src), str(missing_src), tuple(sorted(stocks)), tuple(sorted(keep_dates)))
    cache = ctx.setdefault("_word_v2_ref_cache", {})
    if cache_key in cache:
        return cache[cache_key]

    mod = _load_word_v2_loader()
    out = pl.DataFrame({"trade_date": [], "stock_code": [], "factor_code": [], "raw_value": []})
    if code == "FWDPE":
        consensus = _read_word_v2_parquet(missing_src, "consensus_rolling_ext", [
            "S_INFO_WINDCODE", "TRADE_DT", "EST_DT", "ROLLING_TYPE", "EST_PE",
        ], stocks)
        out = mod.build_forward_pe(consensus, keep_dates)
    elif code == "RDEXPRATIOCHG":
        rd = _read_word_v2_parquet(missing_src, "ann_financial_indicator_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "STATEMENT_TYPE", "RD_EXPENSE",
        ], stocks)
        if rd.is_empty():
            rd = _read_word_v2_parquet(missing_src, "financial_indicator_ext", [
                "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "RD_EXPENSE",
            ], stocks)
        income = _read_word_v2_parquet(src, "income_statement_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "TOT_OPER_REV", "OPER_REV",
        ], stocks)
        pit = _read_word_v2_parquet(src, "pit_financial_ext", [
            "S_INFO_WINDCODE", "TRADE_DT", "S_DFA_OR_TTM",
        ], stocks)
        out = mod.build_rd_exp_ratio_chg(rd, income, keep_dates, pit_revenue=pit)
    elif code == "PEPCTL":
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_PE_TTM"], stocks)
        out = mod.build_pepctl(valuation, keep_dates)
    elif code == "EV2EBIT":
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_EV"], stocks)
        pit = _read_word_v2_parquet(src, "pit_financial_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_DFA_EBIT_TTM"], stocks)
        out = mod.build_ev2ebit(valuation, pit, keep_dates)
    elif code == "ROEVOL":
        pit = _read_word_v2_parquet(src, "pit_financial_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_DFA_ROE_TTM"], stocks)
        out = mod.build_roevol(pit, keep_dates)
    elif code == "ORCAGR3Y":
        pit = _read_word_v2_parquet(src, "pit_financial_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_DFA_OR_TTM"], stocks)
        out = mod.build_orcagr3y(pit, keep_dates)
    elif code == "CAPEXGROWTH":
        cashflow = _read_word_v2_parquet(src, "cashflow_statement_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "CASH_PAY_ACQ_CONST_FIOLTA", "STOT_CASH_OUTFLOWS_INV_ACT",
        ], stocks)
        out = mod.build_capex_growth(cashflow, keep_dates)
    elif code in {"INTDEBTRATIO", "GOODWILLRATIO", "ARRATIO"}:
        balance = _read_word_v2_parquet(src, "balance_statement_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "TOT_ASSETS", "ST_BORROW",
            "NON_CUR_LIAB_DUE_WITHIN_1Y", "LT_BORROW", "BONDS_PAYABLE", "LEASE_LIAB", "INT_PAYABLE",
            "GOODWILL", "ACCT_RCV", "NOTES_RCV",
        ], stocks)
        pit = _read_word_v2_parquet(src, "pit_financial_ext", [
            "S_INFO_WINDCODE", "TRADE_DT", "S_DFA_OR_TTM", "S_DFA_TOTLIAB",
        ], stocks)
        balance_interest = _read_word_v2_parquet(
            FACTOR_GAP_SRC,
            "balance_sheet_interest_bearing",
            [
                "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "STATEMENT_TYPE",
                "ST_BORROW", "NON_CUR_LIAB_DUE_WITHIN_1Y", "LT_BORROW",
                "BONDS_PAYABLE", "LEASE_LIAB", "INT_PAYABLE",
            ],
            stocks,
        )
        out = mod.build_balance_quality_factors(
            balance, pit, keep_dates, balance_interest=balance_interest
        )
    elif code in {"DIVPAYOUT", "DIVSTREAK", "DIVGROWTH"}:
        dividend = _read_word_v2_parquet(src, "dividend_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "DVD_ANN_DT", "S_DIV_PRELANDATE", "EX_DT", "DVD_PAYOUT_DT",
            "REPORT_PERIOD", "TOT_CASH_DVD", "OTHER_TOT_CASH_DVD", "CASH_DVD_PER_SH_PRE_TAX", "TOT_SHR",
        ], stocks)
        pit = _read_word_v2_parquet(src, "pit_financial_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_DFA_NETPROFIT_TTM"], stocks)
        out = mod.build_dividend_factors(dividend, pit, keep_dates)
    elif code in {"SUSPENDDAYS", "LIMITUPDAYS", "LIMITDOWNDAYS", "ONEBOARDDAYS"}:
        price = _read_word_v2_parquet(src, "price_ext", [
            "S_INFO_WINDCODE", "TRADE_DT", "S_DQ_OPEN", "S_DQ_HIGH", "S_DQ_LOW",
            "S_DQ_CLOSE", "S_DQ_AMOUNT", "S_DQ_TRADESTATUS", "UP_DOWN_LIMIT_STATUS",
        ], stocks)
        out = mod.build_price_status_counts(price, keep_dates)
    elif code in {"HOLDERAVGCHG", "UNLOCKMVRATIO"}:
        price = _read_word_v2_parquet(src, "price_ext", ["S_INFO_WINDCODE", "TRADE_DT", "FREE_SHARES_TODAY"], stocks)
        if code == "HOLDERAVGCHG":
            holder = _read_word_v2_parquet(src, "holder_ext", ["S_INFO_WINDCODE", "ANN_DT", "S_HOLDER_NUM"], stocks)
            out = mod.build_holder_avg_chg(holder, price, keep_dates)
        else:
            unlock = _read_word_v2_parquet(src, "unlock_ext", ["S_INFO_WINDCODE", "S_INFO_LISTDATE", "S_SHARE_LST"], stocks)
            out = mod.build_unlock_mv_ratio(unlock, price, keep_dates)
    elif code == "NBNETBUY":
        northbound = _read_word_v2_parquet(src, "northbound_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_QUANTITY"], stocks)
        out = mod.build_north_netbuy(northbound, keep_dates)
    elif code == "INSTHOLD":
        institution = _read_word_v2_parquet(src, "institution_holding_ext", [
            "S_INFO_WINDCODE", "REPORT_PERIOD", "S_HOLDER_PCT", "ANN_DATE",
        ], stocks)
        out = mod.build_inst_hold(institution, keep_dates)
    elif code == "TOP10HOLD":
        inside_holder = _read_word_v2_parquet(src, "inside_holder_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "S_HOLDER_PCT",
        ], stocks)
        out = mod.build_top10_holder(inside_holder, keep_dates)
    elif code == "UNLOCKPRESS":
        unlock = _read_word_v2_parquet(src, "unlock_ext", ["S_INFO_WINDCODE", "S_INFO_LISTDATE", "S_SHARE_RATIO"], stocks)
        out = mod.build_unlock_pressure(unlock, keep_dates)
    elif code == "MARGINBALCHG":
        margin = _read_word_v2_parquet(src, "margin_trading_ext", [
            "S_INFO_WINDCODE", "TRADE_DT", "S_MARGIN_TRADINGBALANCE",
        ], stocks)
        out = mod.build_marginbalchg(margin, keep_dates)
    elif code == "MARGINBUYRATIO":
        margin = _read_word_v2_parquet(src, "margin_trading_ext", [
            "S_INFO_WINDCODE", "TRADE_DT", "S_MARGIN_PURCHWITHBORROWMONEY",
        ], stocks)
        price = _read_word_v2_parquet(src, "price_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_DQ_AMOUNT"], stocks)
        out = mod.build_marginbuyratio(margin, price, keep_dates)
    elif code == "ESTEARNREV":
        consensus = _read_word_v2_parquet(src, "consensus_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_WEST_NETPROFIT_FTM_1M"], stocks)
        out = mod.build_est_earn_rev(consensus, keep_dates)
    elif code in {"RATINGCHG", "ANALYSTCOVER", "TARGETPRICECHG"}:
        ratings = _read_word_v2_parquet(src, "analyst_rating_ext", [
            "S_INFO_WINDCODE", "RATING_DT", "S_WRATING_UPGRADE", "S_WRATING_DOWNGRADE",
            "S_WRATING_INSTNUM", "S_EST_PRICE",
        ], stocks)
        panel = ctx.get("_price_panel")
        trading_dates = (
            panel.get_column("trade_date").unique().sort().to_list()
            if isinstance(panel, pl.DataFrame) and "trade_date" in panel.columns
            else []
        )
        parts = [
            mod.build_ratingchg(ratings, keep_dates),
            mod.build_analystcover(ratings, keep_dates, trading_dates),
            mod.build_targetpricechg(ratings, keep_dates),
        ]
        out = pl.concat([p for p in parts if not p.is_empty()], how="vertical") if any(not p.is_empty() for p in parts) else out
    elif code == "SURVEYCNT":
        survey = _read_word_v2_parquet(src, "survey_ext", ["EVENT_ID", "S_INFO_WINDCODE", "S_SURVEYDATE"], stocks)
        out = mod.build_surveycnt(survey, keep_dates)
    elif code == "SURVEYINSTCNT":
        survey = _read_word_v2_parquet(src, "survey_ext", ["EVENT_ID", "S_INFO_WINDCODE", "S_SURVEYDATE"], stocks)
        participants = _read_word_v2_parquet(src, "survey_participant_ext", ["EVENT_ID", "S_INSTITUTIONCODE"], None)
        out = mod.build_surveyinstcnt(survey, participants, keep_dates)
    elif code == "BUYBACKRATIO":
        buyback = _read_word_v2_parquet(src, "buyback_ext", ["S_INFO_WINDCODE", "EVENT_ID", "ANN_DT", "AMT"], stocks)
        price = _read_word_v2_parquet(src, "price_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_DQ_MV"], stocks)
        out = mod.build_buybackratio(buyback, price, keep_dates)
    elif code == "PLACEDISCOUNT":
        placement = _read_word_v2_parquet(src, "placement_ext", ["S_INFO_WINDCODE", "ANN_DT", "S_FELLOW_DISCNTRATIO"], stocks)
        out = mod.build_placediscount(placement, keep_dates)
    elif code == "PLACEMENTSIZE":
        placement = _read_word_v2_parquet(src, "placement_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "S_FELLOW_COLLECTION", "EXP_COLLECTION",
        ], stocks)
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = mod.build_placement_size(placement, valuation, keep_dates)
    elif code == "MERGERSIZE":
        merger_event = _read_word_v2_parquet(src, "merger_event_ext", [
            "EVENT_ID", "ANN_DATE", "TRADE_VALUE", "CASH_PAYMENT", "EVALUE_VALUE", "CRNCY_CODE",
        ], None)
        merger_participant = _read_word_v2_parquet(src, "merger_participant_ext", ["EVENT_ID", "S_INFO_WINDCODE"], stocks)
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = mod.build_merger_size(merger_event, merger_participant, valuation, keep_dates)
    elif code == "INCENTIVESIZE":
        incentive = _read_word_v2_parquet(src, "equity_incentive_ext", ["S_INFO_WINDCODE", "ANN_DT", "INC_NUMBERS_RATE"], stocks)
        out = mod.build_incentivesize(incentive, keep_dates)
    elif code == "RISKINVESTCNT":
        investigation = _read_word_v2_parquet(src, "risk_investigation_ext", ["S_INFO_WINDCODE", "STR_ANNDATE"], stocks)
        out = mod.build_riskinvestcnt(investigation, keep_dates)
    elif code == "PUNISHAMT":
        illegality = _read_word_v2_parquet(src, "risk_illegality_ext", ["S_INFO_WINDCODE", "ANN_DT", "AMOUNT"], stocks)
        out = mod.build_punishamt(illegality, keep_dates)
    elif code == "LAWSUITAMT":
        lawsuit = _read_word_v2_parquet(src, "lawsuit_ext", ["S_INFO_WINDCODE", "ANN_DT", "AMOUNT", "RESULTAMOUNT"], stocks)
        out = mod.build_lawsuitamt(lawsuit, keep_dates)
    elif code == "AUDITQUAL":
        audit = _read_word_v2_parquet(src, "audit_opinion_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "S_STMNOTE_AUDIT_CATEGORY",
        ], stocks)
        out = mod.build_auditqual(audit, keep_dates)
    elif code in {"MAJORHOLDERCHG", "EXECHOLDERCHG"}:
        holder_trade = _read_word_v2_parquet(src, "holder_trade_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "HOLDER_TYPE", "TRANSACT_TYPE", "TRANSACT_QUANTITY", "AVG_PRICE",
        ], stocks)
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = mod.build_holder_trade_change(
            holder_trade,
            valuation,
            keep_dates,
            code,
            "major" if code == "MAJORHOLDERCHG" else "executive",
        )
    elif code == "FINRESTATEMENT":
        company_map = _read_word_v2_parquet(missing_src, "company_security_map_ext", [
            "S_INFO_COMPCODE", "S_INFO_WINDCODE",
        ], stocks)
        comp_codes = set(company_map["S_INFO_COMPCODE"].drop_nulls().cast(pl.Utf8).to_list()) if not company_map.is_empty() else set()
        accounting_change = _read_word_v2_parquet(src, "accounting_change_ext", [
            "S_INFO_COMPCODE", "ANN_DATE", "S_CHANGE_ITEMCODE",
        ], None)
        if comp_codes and not accounting_change.is_empty():
            accounting_change = accounting_change.filter(pl.col("S_INFO_COMPCODE").cast(pl.Utf8).is_in(sorted(comp_codes)))
        out = mod.build_fin_restatement(accounting_change, company_map, keep_dates)
    elif code in {"PROFITNOTICEBEAT", "REPORTSURPRISE"}:
        consensus = _read_word_v2_parquet(missing_src, "consensus_rolling_ext", [
            "S_INFO_WINDCODE", "TRADE_DT", "EST_DT", "ROLLING_TYPE", "NET_PROFIT", "EST_PE",
        ], stocks)
        if code == "PROFITNOTICEBEAT":
            notice = _read_word_v2_parquet(src, "profit_notice_ext", [
                "S_INFO_WINDCODE", "S_PROFITNOTICE_DATE", "S_PROFITNOTICE_PERIOD",
                "S_PROFITNOTICE_NETPROFITMIN", "S_PROFITNOTICE_NETPROFITMAX", "S_PROFITNOTICE_FIRSTANNDATE",
            ], stocks)
            out = mod.build_profit_notice_surprise(notice, consensus, keep_dates)
        else:
            income = _read_word_v2_parquet(src, "income_statement_ext", [
                "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "NET_PROFIT_EXCL_MIN_INT_INC",
            ], stocks)
            out = mod.build_report_surprise(income, consensus, keep_dates)
    elif code == "REFINPRESS":
        placement = _read_word_v2_parquet(src, "placement_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "S_FELLOW_COLLECTION", "EXP_COLLECTION",
        ], stocks)
        rights = _read_word_v2_parquet(src, "rights_issue_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "S_RIGHTSISSUE_NETCOLLECTION", "S_EXPECTED_FUND_RAISING",
        ], stocks)
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = mod.build_refinance_pressure(placement, rights, valuation, keep_dates)

    if not out.is_empty():
        out = out.filter(pl.col("factor_code") == code)
        if stocks:
            out = out.filter(pl.col("stock_code").is_in(sorted(stocks)))
    cache[cache_key] = out
    return out


def numpy_recon(code: str, factor_raw: pl.DataFrame, panel: pl.DataFrame, ctx: dict, k: int,
                panel_index: dict | None = None,
                candidate_units: pl.DataFrame | None = None) -> dict:
    rel_tol = REL_TOL_BY_CODE.get(code, REL_TOL)
    base = {"status": "no_ref", "method": "numpy_recompute", "n_checked": 0, "n_match": 0,
            "n_stored_only": 0, "n_ref_only": 0,
            "max_abs_diff": 0.0, "tol": rel_tol, "mismatches": []}
    fn = REF_IMPLS.get(code)
    if fn is None:
        return base
    win_n = WIN_N.get(code, DEFAULT_WIN)
    factor_slice = factor_raw.filter(pl.col("factor_code") == code)
    units = _merge_units(
        sample_units(factor_raw, code, k=k),
        sample_missing_units(candidate_units, factor_slice, k=k),
    )
    stored_lut = {
        (r["stock_code"], r["trade_date"]): r["raw_value"]
        for r in factor_slice.select(["stock_code", "trade_date", "raw_value"]).to_dicts()
    }
    n_check = n_match = n_stored_only = n_ref_only = 0
    max_diff = 0.0
    mism = []
    for stock, asof in units:
        stored = _finite_or_none(stored_lut.get((stock, asof)))
        win = price_window_upto(panel, stock, asof, win_n, panel_index=panel_index)
        ref_ctx = {**ctx, "_asof": asof, "_factor_raw": factor_raw}
        ref, _ = fn(win, ref_ctx)
        ref = _finite_or_none(ref)
        if ref is None and stored is None:
            continue
        n_check += 1
        if ref is None:
            n_stored_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": None, "stored": stored, "abs_diff": None})
        elif stored is None:
            n_ref_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref, "stored": None, "abs_diff": None})
        elif _close(ref, stored, rel_tol=rel_tol):
            n_match += 1
        else:
            d = abs(ref - stored)
            max_diff = max(max_diff, d)
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref, "stored": stored, "abs_diff": d})
    base.update(n_checked=n_check, n_match=n_match,
                n_stored_only=n_stored_only, n_ref_only=n_ref_only,
                max_abs_diff=max_diff, mismatches=mism)
    if n_check == 0:
        base["status"] = "na"
    elif n_match == n_check:
        base["status"] = "match"
    else:
        base["status"] = "mismatch"
    return base


def _industry_map() -> pl.DataFrame:
    from pathlib import Path

    for path in [
        Path("data/raw/stock_descriptors.parquet"),
        Path("frontend/data/stock_descriptors.parquet"),
    ]:
        if path.exists():
            return pl.read_parquet(path, columns=["stock_code", "industry_sw1"])
    return pl.DataFrame({"stock_code": [], "industry_sw1": []})


def _derived_grcagr3y(factor_raw: pl.DataFrame, src_dir: str) -> pl.DataFrame:
    from pathlib import Path

    src = Path(src_dir) / "pit_financial.csv"
    if not src.exists():
        return pl.DataFrame({"trade_date": [], "stock_code": [], "raw_value": []})
    month_ends = factor_raw["trade_date"].unique().sort()
    c = pl.read_csv(
        src,
        infer_schema_length=0,
        columns=["S_INFO_WINDCODE", "TRADE_DT", "S_DFA_GR_TTM"],
    )
    c = (
        c.with_columns(
            pl.col("S_INFO_WINDCODE").str.strip_chars().alias("stock_code"),
            pl.col("TRADE_DT").str.strptime(pl.Date, "%Y%m%d").alias("trade_date"),
            pl.col("S_DFA_GR_TTM").cast(pl.Float64, strict=False).alias("gr"),
        )
        .filter(pl.col("trade_date").is_in(month_ends))
        .with_columns((pl.col("trade_date").dt.year() * 12 + pl.col("trade_date").dt.month()).alias("_month_id"))
        .sort(["stock_code", "trade_date"])
    )
    lag = c.select([
        "stock_code",
        (pl.col("_month_id") + 36).alias("_month_id"),
        pl.col("gr").alias("gr_3y"),
    ])
    c = (
        c.join(lag, on=["stock_code", "_month_id"], how="inner")
        .filter((pl.col("gr_3y") > 0) & pl.col("gr").is_not_null())
        .with_columns(((pl.col("gr") / pl.col("gr_3y")) ** (1.0 / 3) - 1).alias("raw_value"))
        .filter(pl.col("raw_value").is_finite())
    )
    return c.select(["trade_date", "stock_code", "raw_value"])


def _derived_pbpctl(factor_raw: pl.DataFrame) -> pl.DataFrame:
    import math

    pb = (
        factor_raw.filter(pl.col("factor_code") == "PB")
        .with_columns((pl.col("trade_date").dt.year() * 12 + pl.col("trade_date").dt.month()).alias("_month_id"))
        .sort(["stock_code", "trade_date"])
    )

    def _rolling_rank(sub: pl.DataFrame) -> pl.DataFrame:
        vals = sub["raw_value"].to_list()
        month_ids = sub["_month_id"].to_list()
        pct = []
        for i, v in enumerate(vals):
            if v is None or not math.isfinite(float(v)):
                pct.append(None)
                continue
            lo = month_ids[i] - 35
            window = [
                float(x) for x, m in zip(vals, month_ids)
                if lo <= m <= month_ids[i] and x is not None and math.isfinite(float(x))
            ]
            n = len(window)
            less = sum(x < float(v) for x in window)
            equal = sum(x == float(v) for x in window)
            rank = less + (equal + 1) / 2
            pct.append(rank / n if n else None)
        return sub.with_columns(pl.Series("raw_value_ref", pct))

    if pb.is_empty():
        return pl.DataFrame({"trade_date": [], "stock_code": [], "raw_value": []})
    return (
        pb.group_by("stock_code", maintain_order=True)
        .map_groups(_rolling_rank)
        .select(["trade_date", "stock_code", pl.col("raw_value_ref").alias("raw_value")])
    )


def _relret_table(panel: pl.DataFrame, month_ends: list, by_industry: bool) -> pl.DataFrame:
    from datetime import timedelta

    desc = _industry_map() if by_industry else None
    parts = []
    px = panel.select(["stock_code", "trade_date", "adj_close"])
    for asof in month_ends:
        lo = asof - timedelta(days=120)
        w = (
            px.filter((pl.col("trade_date") <= asof) & (pl.col("trade_date") >= lo))
            .sort(["stock_code", "trade_date"])
            .with_columns(pl.col("trade_date").rank("ordinal", descending=True).over("stock_code").alias("rk"))
        )
        last = w.filter(pl.col("rk") == 1).select(["stock_code", pl.col("adj_close").alias("p1")])
        p60 = w.filter(pl.col("rk") == 61).select(["stock_code", pl.col("adj_close").alias("p60")])
        ret = last.join(p60, on="stock_code").with_columns((pl.col("p1") / pl.col("p60") - 1).alias("r"))
        if by_industry:
            ret = (
                ret.join(desc, on="stock_code", how="left")
                .filter(pl.col("industry_sw1").is_not_null())
                .with_columns((pl.col("r") - pl.col("r").mean().over("industry_sw1")).alias("raw_value"))
            )
        else:
            med = ret["r"].median()
            ret = ret.with_columns((pl.col("r") - med).alias("raw_value"))
        parts.append(ret.with_columns(pl.lit(asof).alias("trade_date")).select(["trade_date", "stock_code", "raw_value"]))
    if not parts:
        return pl.DataFrame({"trade_date": [], "stock_code": [], "raw_value": []})
    return pl.concat(parts).filter(pl.col("raw_value").is_not_null())


def _rel_valuation_table(factor_raw: pl.DataFrame, base_code: str) -> pl.DataFrame:
    desc = _industry_map()
    g = (
        factor_raw.filter(pl.col("factor_code") == base_code)
        .join(desc, on="stock_code", how="left")
        .filter(pl.col("industry_sw1").is_not_null() & pl.col("raw_value").is_not_null())
        .with_columns(
            (pl.col("raw_value") - pl.col("raw_value").median().over(["trade_date", "industry_sw1"]))
            .alias("raw_value_ref")
        )
    )
    return g.select(["trade_date", "stock_code", pl.col("raw_value_ref").alias("raw_value")])


def derived_reference_table(code: str, factor_raw: pl.DataFrame, panel: pl.DataFrame, ctx: dict, src_dir: str) -> pl.DataFrame:
    cache = ctx.setdefault("_derived_ref_cache", {})
    if code in cache:
        return cache[code]
    month_ends = factor_raw["trade_date"].unique().sort().to_list()
    if code == "GRCAGR3Y":
        out = _derived_grcagr3y(factor_raw, src_dir)
    elif code == "PBPCTL":
        out = _derived_pbpctl(factor_raw)
    elif code == "RELRET60":
        out = _relret_table(panel, month_ends, by_industry=False)
    elif code in {"RELRETIND", "RELPEIND", "RELPBIND"} and all(
        (FACTOR_GAP_SRC / name).exists()
        for name in [
            "sw_industry_history.parquet",
            "sw_industry_index_prices.parquet",
            "sw_industry_index_description.parquet",
        ]
    ):
        mod = _load_derived_loader()
        industry_map = mod.build_pit_industry_map(
            pl.read_parquet(FACTOR_GAP_SRC / "sw_industry_history.parquet"),
            month_ends,
        )
        if code == "RELRETIND":
            out = mod.build_relretind(
                panel,
                month_ends,
                industry_map,
                pl.read_parquet(FACTOR_GAP_SRC / "sw_industry_index_prices.parquet"),
                pl.read_parquet(FACTOR_GAP_SRC / "sw_industry_index_description.parquet"),
            ).select(["trade_date", "stock_code", "raw_value"])
        else:
            out = mod.build_rel_valuation(
                factor_raw,
                "PE" if code == "RELPEIND" else "PB",
                code,
                industry_map,
            ).select(["trade_date", "stock_code", "raw_value"])
    elif code == "RELRETIND":
        out = _relret_table(panel, month_ends, by_industry=True)
    elif code == "RELPEIND":
        out = _rel_valuation_table(factor_raw, "PE")
    elif code == "RELPBIND":
        out = _rel_valuation_table(factor_raw, "PB")
    else:
        out = pl.DataFrame({"trade_date": [], "stock_code": [], "raw_value": []})
    cache[code] = out
    return out


def derived_recon(code: str, factor_raw: pl.DataFrame, panel: pl.DataFrame,
                  ctx: dict, src_dir: str, k: int,
                  candidate_units: pl.DataFrame | None = None) -> dict:
    base = {"status": "no_ref", "method": "derived_recompute", "n_checked": 0, "n_match": 0,
            "n_stored_only": 0, "n_ref_only": 0,
            "max_abs_diff": 0.0, "tol": REL_TOL, "mismatches": []}
    ref_df = derived_reference_table(code, factor_raw, panel, ctx, src_dir)
    if ref_df.is_empty():
        return base
    factor_slice = factor_raw.filter(pl.col("factor_code") == code)
    units = _merge_units(
        sample_units(factor_raw, code, k=k),
        sample_missing_units(candidate_units, factor_slice, k=k),
    )
    stored = {
        (r["stock_code"], r["trade_date"]): r["raw_value"]
        for r in factor_raw.filter(pl.col("factor_code") == code)
        .select(["stock_code", "trade_date", "raw_value"])
        .to_dicts()
    }
    ref = {
        (r["stock_code"], r["trade_date"]): r["raw_value"]
        for r in ref_df.select(["stock_code", "trade_date", "raw_value"]).to_dicts()
    }
    n_check = n_match = n_stored_only = n_ref_only = 0
    max_diff = 0.0
    mism = []
    for stock, asof in units:
        stored_v = _finite_or_none(stored.get((stock, asof)))
        ref_v = _finite_or_none(ref.get((stock, asof)))
        if stored_v is None and ref_v is None:
            continue
        n_check += 1
        if ref_v is None:
            n_stored_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": None, "stored": stored_v, "abs_diff": None})
        elif stored_v is None:
            n_ref_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref_v, "stored": None, "abs_diff": None})
        elif _close(ref_v, stored_v):
            n_match += 1
        else:
            d = abs(ref_v - stored_v)
            max_diff = max(max_diff, d)
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref_v, "stored": stored_v, "abs_diff": d})
    base.update(n_checked=n_check, n_match=n_match,
                n_stored_only=n_stored_only, n_ref_only=n_ref_only,
                max_abs_diff=max_diff, mismatches=mism)
    if n_check == 0:
        base["status"] = "na"
    elif n_match == n_check:
        base["status"] = "match"
    else:
        base["status"] = "mismatch"
    return base


def word_v2_recon(code: str, factor_raw: pl.DataFrame, ctx: dict, src_dir: str, k: int,
                  candidate_units: pl.DataFrame | None = None) -> dict:
    base = {"status": "no_ref", "method": "word_v2_source_recompute", "n_checked": 0, "n_match": 0,
            "n_stored_only": 0, "n_ref_only": 0,
            "max_abs_diff": 0.0, "tol": REL_TOL, "mismatches": []}
    factor_slice = factor_raw.filter(pl.col("factor_code") == code)
    units = _merge_units(
        sample_units(factor_raw, code, k=k),
        sample_missing_units(candidate_units, factor_slice, k=k),
    )
    ref_df = _word_v2_reference_code(code, factor_raw, ctx, src_dir, units)
    if ref_df.is_empty():
        return base
    stored = {
        (r["stock_code"], r["trade_date"]): r["raw_value"]
        for r in factor_raw.filter(pl.col("factor_code") == code)
        .select(["stock_code", "trade_date", "raw_value"])
        .to_dicts()
    }
    ref = {
        (r["stock_code"], r["trade_date"]): r["raw_value"]
        for r in ref_df.select(["stock_code", "trade_date", "raw_value"]).to_dicts()
    }
    n_check = n_match = n_stored_only = n_ref_only = 0
    max_diff = 0.0
    mism = []
    for stock, asof in units:
        stored_v = _finite_or_none(stored.get((stock, asof)))
        ref_v = _finite_or_none(ref.get((stock, asof)))
        if stored_v is None and ref_v is None:
            continue
        n_check += 1
        if ref_v is None:
            n_stored_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": None, "stored": stored_v, "abs_diff": None})
        elif stored_v is None:
            n_ref_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref_v, "stored": None, "abs_diff": None})
        elif _close(ref_v, stored_v):
            n_match += 1
        else:
            d = abs(ref_v - stored_v)
            max_diff = max(max_diff, d)
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref_v, "stored": stored_v, "abs_diff": d})
    base.update(n_checked=n_check, n_match=n_match,
                n_stored_only=n_stored_only, n_ref_only=n_ref_only,
                max_abs_diff=max_diff, mismatches=mism)
    if n_check == 0:
        base["status"] = "na"
    elif n_match == n_check:
        base["status"] = "match"
    else:
        base["status"] = "mismatch"
    return base


def reconcile(code: str, meta: dict, factor_raw: pl.DataFrame, panel: pl.DataFrame,
              ctx: dict, src_dir: str = "资料", k: int = SAMPLE_K,
              panel_index: dict | None = None,
              candidate_units: pl.DataFrame | None = None) -> dict:
    if meta.get("source_file") == "word_v2":
        ctx.setdefault("_price_panel", panel)
        return word_v2_recon(code, factor_raw, ctx, src_dir, k, candidate_units=candidate_units)
    if meta.get("transform") == "derived" or code in DERIVED_CODES:
        return derived_recon(code, factor_raw, panel, ctx, src_dir, k, candidate_units=candidate_units)
    is_numpy = bool(meta.get("compute"))
    if is_numpy:
        return numpy_recon(
            code, factor_raw, panel, ctx, k,
            panel_index=panel_index,
            candidate_units=candidate_units,
        )
    return recheck_external(
        code, meta, factor_raw, src_dir=src_dir, k=k,
        candidate_units=candidate_units,
    )


def build_sample(code: str, meta: dict, factor_raw: pl.DataFrame, panel: pl.DataFrame,
                 ctx: dict, stock_names: dict, panel_index: dict | None = None) -> dict | None:
    """取 1 个代表样例的逐步过程（详情页用）。计算类展示重算过程；外部类展示源字段取值。"""
    unit = representative_unit(factor_raw, code)
    if unit is None:
        return None
    stock, asof = unit
    stored = factor_raw.filter(
        (pl.col("factor_code") == code) & (pl.col("stock_code") == stock) & (pl.col("trade_date") == asof)
    )["raw_value"]
    stored = stored[0] if not stored.is_empty() else None
    sample = {"stock_code": stock, "stock_name": stock_names.get(stock, ""),
              "trade_date": asof.isoformat(), "inputs": [], "steps": [],
              "recomputed": None, "stored": stored, "match": None}
    fn = REF_IMPLS.get(code)
    if fn is not None:
        win = price_window_upto(panel, stock, asof, WIN_N.get(code, DEFAULT_WIN), panel_index=panel_index)
        if not win.is_empty():
            ref_ctx = {**ctx, "_asof": asof}
            ref, steps = fn(win, ref_ctx)
            first = win.row(0, named=True)
            last = win.row(win.height - 1, named=True)
            sample["inputs"] = [
                {"label": "窗口起始日", "value": str(first["trade_date"])},
                {"label": "核对截面日(asof)", "value": asof.isoformat()},
                {"label": "窗口最后交易日", "value": str(last["trade_date"])},
                {"label": "窗口交易日数", "value": win.height},
                {"label": "末日复权收盘 adj_close", "value": last["adj_close"]},
            ]
            sample["steps"] = steps
            sample["recomputed"] = ref
            sample["match"] = _close(ref, stored)
    else:
        sample["steps"] = [f"外部字段直取/变换：{meta.get('formula','')}"]
        sample["inputs"] = [{"label": "Wind 源", "value": meta.get("wind_source", "")}]
    return sample
