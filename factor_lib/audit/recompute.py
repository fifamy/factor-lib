"""对账驱动：按因子类型选 numpy 重算或源回查，产出统一 recon 结构 + 代表样例。"""
from __future__ import annotations

import importlib.util
import math
from datetime import date, timedelta
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
    "REV1M": 22, "REV5D": 6, "MOM20": 21, "MOM60": 61, "MOM12_1": 253, "RSTR252": 253, "DASTD": 253,
    "DOWNVOL": 520, "MAXDD1Y": 252, "RETSKEW": 520, "RETKURT": 520, "BIGDOWN": 61,
    "AMOUNT20": 20, "VOLUME20": 20, "TURN20": 20, "STOM": 21, "AMTVOL": 20,
    "TURNVOL": 60, "TURNPCTL": 120, "PVCORR": 61, "UPVOLRATIO": 21, "PRICEZ": 20,
    "MA20BIAS": 20, "HLPOS": 60, "ABTURN": 60, "HIGHMOMTURN": 61, "BETA": 253, "DOWNBETA": 253,
    "AROON": 25, "MFLOW20": 20, "RVI": 1, "VR": 25,
}
DEFAULT_WIN = 260
DERIVED_CODES = {"GRCAGR3Y", "PBPCTL", "RELRET60", "RELPEIND", "RELPBIND", "RELRETIND"}
ROOT = Path(__file__).resolve().parents[2]
WORD_V2_DEFAULT_SRC = ROOT / "资料" / "word_only_factor_data_direct_only_processed" / "parquet"
WORD_V2_MISSING_SRC = ROOT / "资料" / "word_only_factor_data_42_missing_processed" / "parquet"
FACTOR_GAP_SRC = ROOT / "资料" / "balance_sheet_interest_bearing_processed" / "parquet"
FACTOR_UNLOCK_SRC = (
    ROOT
    / "资料"
    / "unlock_monthly_pit_90d_from_free_float_calendar_processed"
    / "parquet"
)
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


def _parse_month_key(value: str) -> date | None:
    key = str(value).replace("-", "")
    if len(key) != 8:
        return None
    try:
        return date(int(key[:4]), int(key[4:6]), int(key[6:8]))
    except ValueError:
        return None


def _reference_monthly_value(
    frame: pl.DataFrame,
    date_col: str,
    value_col: str,
    keep_dates: set[str],
    output_col: str,
) -> pl.DataFrame:
    if frame.is_empty():
        return pl.DataFrame()
    return (
        frame.select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col(date_col).cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("trade_date"),
            pl.col(value_col).cast(pl.Float64, strict=False).alias(output_col),
        ])
        .filter(
            pl.col("trade_date").dt.strftime("%Y%m%d").is_in(sorted(keep_dates))
            & pl.col("stock_code").is_not_null()
        )
    )


def _reference_latest_event_amounts(
    events: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
    aggregation: str = "sum",
) -> pl.DataFrame:
    """Independently select one latest PIT row per stock-event before aggregation."""
    if events.is_empty():
        return pl.DataFrame()
    events = events.with_row_index("_rowid")
    parts = []
    for asof in sorted(filter(None, (_parse_month_key(value) for value in keep_dates))):
        start = asof - timedelta(days=window_days - 1)
        window = events.filter(
            (pl.col("event_date") >= start) & (pl.col("event_date") <= asof)
        )
        has_event_id = pl.col("event_id").fill_null("") != ""
        keyed = (
            window.filter(has_event_id)
            .sort(["stock_code", "event_id", "event_date", "_rowid"])
            .group_by(["stock_code", "event_id"])
            .last()
            .select(window.columns)
        )
        unkeyed = (
            window.filter(~has_event_id)
            .unique(
                subset=["stock_code", "event_date", "event_amount"],
                keep="first",
                maintain_order=True,
            )
        )
        latest = pl.concat([keyed, unkeyed], how="vertical")
        if aggregation == "sum":
            value_agg = pl.col("event_amount").sum().alias("event_amount")
        elif aggregation == "mean":
            value_agg = pl.col("event_amount").mean().alias("event_amount")
        else:
            raise ValueError(f"unsupported aggregation: {aggregation}")
        part = latest.group_by("stock_code").agg(value_agg).with_columns(
            pl.lit(asof).alias("trade_date")
        )
        if not part.is_empty():
            parts.append(part)
    return pl.concat(parts, how="vertical") if parts else pl.DataFrame()


def _reference_funding_events(
    frame: pl.DataFrame,
    actual_col: str,
    expected_col: str,
    event_id_col: str | None,
) -> pl.DataFrame:
    if frame.is_empty():
        return pl.DataFrame()
    actual = pl.col(actual_col).cast(pl.Float64, strict=False)
    expected = pl.col(expected_col).cast(pl.Float64, strict=False)
    event_id = (
        pl.col(event_id_col).cast(pl.Utf8).str.strip_chars()
        if event_id_col and event_id_col in frame.columns
        else pl.lit(None, dtype=pl.Utf8)
    )
    return (
        frame.select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            event_id.alias("event_id"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            (
                pl.when(actual.is_not_null() & actual.is_finite() & (actual > 0))
                .then(actual)
                .when(expected.is_not_null() & expected.is_finite() & (expected > 0))
                .then(expected)
                .otherwise(None)
            ).alias("event_amount"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_amount").is_not_null()
            & pl.col("event_amount").is_finite()
            & (pl.col("event_amount") > 0)
        )
    )


def _reference_placement_size(
    placement: pl.DataFrame,
    valuation: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    if placement.is_empty() or valuation.is_empty():
        return pl.DataFrame()
    events = _reference_funding_events(
        placement,
        "S_FELLOW_COLLECTION",
        "EXP_COLLECTION",
        "EVENT_ID",
    )
    raised = _reference_latest_event_amounts(events, keep_dates, window_days)
    mv = _reference_monthly_value(
        valuation, "TRADE_DT", "S_VAL_MV_ARD", keep_dates, "mv"
    )
    return (
        raised.join(mv, on=["trade_date", "stock_code"], how="left")
        .with_columns(
            pl.when(pl.col("mv") > 0)
            .then(pl.col("event_amount") / pl.col("mv"))
            .otherwise(None)
            .alias("raw_value")
        )
        .filter((pl.col("raw_value") >= 0) & (pl.col("raw_value") <= 5.0))
        .select([
            "trade_date",
            "stock_code",
            pl.lit("PLACEMENTSIZE").alias("factor_code"),
            "raw_value",
        ])
    )


def _reference_placediscount(
    placement: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    """Independent PIT reference: one latest discount per EVENT_ID, then mean."""
    if placement.is_empty():
        return pl.DataFrame()
    events = (
        placement.select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("EVENT_ID").cast(pl.Utf8).str.strip_chars().alias("event_id"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.col("S_FELLOW_DISCNTRATIO").cast(pl.Float64, strict=False).alias("event_amount"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_amount").is_not_null()
            & pl.col("event_amount").is_finite()
        )
    )
    values = _reference_latest_event_amounts(
        events,
        keep_dates,
        window_days,
        aggregation="mean",
    )
    if values.is_empty():
        return pl.DataFrame()
    return values.select([
        "trade_date",
        "stock_code",
        pl.lit("PLACEDISCOUNT").alias("factor_code"),
        pl.col("event_amount").alias("raw_value"),
    ])


def _reference_incentivesize(
    incentive: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    """Independent PIT reference at plan-and-sequence event grain."""
    required = {
        "S_INFO_WINDCODE", "EQINC_PLAN_EVENT_ID", "S_INC_SEQUENCE",
        "ANN_DT", "INC_NUMBERS_RATE",
    }
    if incentive.is_empty() or not required.issubset(incentive.columns):
        return pl.DataFrame()
    plan_id = pl.col("EQINC_PLAN_EVENT_ID").cast(pl.Utf8).str.strip_chars()
    sequence = pl.col("S_INC_SEQUENCE").cast(pl.Utf8).str.strip_chars().fill_null("")
    events = (
        incentive.select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.when(plan_id.is_not_null() & (plan_id != ""))
            .then(pl.concat_str([plan_id, sequence], separator="::"))
            .otherwise(None)
            .alias("event_id"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.col("INC_NUMBERS_RATE").cast(pl.Float64, strict=False).fill_null(0.0).alias("event_amount"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_amount").is_finite()
        )
    )
    values = _reference_latest_event_amounts(events, keep_dates, window_days)
    if values.is_empty():
        return pl.DataFrame()
    return values.select([
        "trade_date",
        "stock_code",
        pl.lit("INCENTIVESIZE").alias("factor_code"),
        pl.col("event_amount").alias("raw_value"),
    ])


def _reference_punishamt(
    illegality: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    """Independent window sum after exact full-row source deduplication."""
    if illegality.is_empty():
        return pl.DataFrame()
    base = (
        illegality.unique(keep="first", maintain_order=True)
        .select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.col("AMOUNT").cast(pl.Float64, strict=False).fill_null(0.0).alias("event_amount"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_amount").is_finite()
        )
    )
    return _reference_plain_window_sum(base, keep_dates, "PUNISHAMT", window_days)


def _reference_lawsuitamt(
    lawsuit: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    """Independent absolute-amount sum after exact full-row source deduplication."""
    if lawsuit.is_empty():
        return pl.DataFrame()
    amount = pl.col("AMOUNT").cast(pl.Float64, strict=False)
    result_amount = pl.col("RESULTAMOUNT").cast(pl.Float64, strict=False)
    base = (
        lawsuit.unique(keep="first", maintain_order=True)
        .select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.when(result_amount > 0)
            .then(result_amount)
            .when(amount > 0)
            .then(amount)
            .otherwise(None)
            .alias("event_amount"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_amount").is_not_null()
            & pl.col("event_amount").is_finite()
        )
    )
    return _reference_plain_window_sum(base, keep_dates, "LAWSUITAMT", window_days)


def _reference_holder_trade_change(
    holder_trade: pl.DataFrame,
    valuation: pl.DataFrame,
    keep_dates: set[str],
    factor_code: str,
    holder_type: str,
    window_days: int = 365,
) -> pl.DataFrame:
    """Independent PIT reference for holder trade changes.

    The source has no stable transaction id.  Full-row exact duplicates are
    removed, while distinct trade details on the same announcement date are
    retained and summed.
    """
    if holder_trade.is_empty() or valuation.is_empty():
        return pl.DataFrame()
    deduped = holder_trade.unique(keep="first", maintain_order=True)
    htype = deduped.get_column("HOLDER_TYPE") if "HOLDER_TYPE" in deduped.columns else None
    if htype is None:
        return pl.DataFrame()
    htype_num = htype.cast(pl.Float64, strict=False)
    if holder_type == "major":
        deduped = deduped.filter(htype_num.is_in([1.0, 2.0]))
    elif holder_type == "executive":
        deduped = deduped.filter(htype_num == 3.0)
    else:
        raise ValueError(f"unknown holder_type: {holder_type}")
    transact_type = pl.col("TRANSACT_TYPE").cast(pl.Utf8)
    sign = (
        pl.when(transact_type.str.contains("增", literal=True)).then(1.0)
        .when(transact_type.str.contains("减", literal=True)).then(-1.0)
        .otherwise(None)
    )
    events = (
        deduped.select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            (sign * pl.col("TRANSACT_QUANTITY").cast(pl.Float64, strict=False)
             * pl.col("AVG_PRICE").cast(pl.Float64, strict=False)).alias("event_amount"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_amount").is_not_null()
            & pl.col("event_amount").is_finite()
        )
    )
    changed = _reference_plain_window_sum(events, keep_dates, factor_code, window_days)
    if changed.is_empty():
        return pl.DataFrame()
    mv = _reference_monthly_value(valuation, "TRADE_DT", "S_VAL_MV_ARD", keep_dates, "mv")
    return (
        changed.join(mv, on=["trade_date", "stock_code"], how="left")
        .with_columns(
            pl.when(pl.col("mv") > 0)
            .then(pl.col("raw_value") / pl.col("mv"))
            .otherwise(None)
            .alias("raw_value")
        )
        .filter(pl.col("raw_value").abs() <= 5.0)
        .select(["trade_date", "stock_code", "factor_code", "raw_value"])
    )


def _reference_riskinvestcnt(
    investigation: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 60,
) -> pl.DataFrame:
    """Independent count of exact-distinct investigation source records."""
    if investigation.is_empty():
        return pl.DataFrame()
    base = (
        investigation.unique(keep="first", maintain_order=True)
        .select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("STR_ANNDATE").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.lit(1.0).alias("event_amount"),
        ])
        .filter(pl.col("stock_code").is_not_null() & pl.col("event_date").is_not_null())
    )
    return _reference_plain_window_sum(base, keep_dates, "RISKINVESTCNT", window_days)


def _reference_insthold(
    institution: pl.DataFrame,
    keep_dates: set[str],
) -> pl.DataFrame:
    """Independent latest-report-period institutional holding reference."""
    if institution.is_empty():
        return pl.DataFrame()
    base = (
        institution.unique(keep="first", maintain_order=True)
        .select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("ANN_DATE").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.col("REPORT_PERIOD").cast(pl.Int64, strict=False).alias("report_period"),
            pl.col("S_HOLDER_PCT").cast(pl.Float64, strict=False).alias("holder_pct"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("report_period").is_not_null()
            & pl.col("holder_pct").is_not_null()
            & pl.col("holder_pct").is_finite()
        )
    )
    parts = []
    for asof in sorted(filter(None, (_parse_month_key(value) for value in keep_dates))):
        visible = base.filter(pl.col("event_date") <= asof)
        if visible.is_empty():
            continue
        latest_period = visible.group_by("stock_code").agg(
            pl.col("report_period").max().alias("_latest_period")
        )
        part = (
            visible.join(latest_period, on="stock_code", how="inner")
            .filter(pl.col("report_period") == pl.col("_latest_period"))
            .group_by("stock_code")
            .agg(pl.col("holder_pct").sum().clip(0.0, 100.0).alias("raw_value"))
            .with_columns([
                pl.lit(asof).alias("trade_date"),
                pl.lit("INSTHOLD").alias("factor_code"),
            ])
            .select(["trade_date", "stock_code", "factor_code", "raw_value"])
        )
        if not part.is_empty():
            parts.append(part)
    return pl.concat(parts, how="vertical") if parts else pl.DataFrame()


def _reference_top10hold(
    inside_holder: pl.DataFrame,
    keep_dates: set[str],
) -> pl.DataFrame:
    """Independent latest disclosed top-ten holding reference."""
    if inside_holder.is_empty():
        return pl.DataFrame()
    snapshots = (
        inside_holder.unique(keep="first", maintain_order=True)
        .with_row_index("_rowid")
        .select([
            "_rowid",
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.col("REPORT_PERIOD").cast(pl.Int64, strict=False).alias("report_period"),
            pl.col("S_HOLDER_PCT").cast(pl.Float64, strict=False).alias("holder_pct"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("report_period").is_not_null()
            & pl.col("holder_pct").is_not_null()
            & pl.col("holder_pct").is_finite()
        )
        .group_by(["stock_code", "event_date", "report_period"])
        .agg([
            pl.col("holder_pct").sum().clip(0.0, 100.0).alias("raw_value"),
            pl.col("_rowid").max().alias("_rowid"),
        ])
    )
    parts = []
    for asof in sorted(filter(None, (_parse_month_key(value) for value in keep_dates))):
        latest = (
            snapshots.filter(pl.col("event_date") <= asof)
            .sort(["stock_code", "event_date", "report_period", "_rowid"])
            .group_by("stock_code", maintain_order=True)
            .last()
            .with_columns([
                pl.lit(asof).alias("trade_date"),
                pl.lit("TOP10HOLD").alias("factor_code"),
            ])
            .select(["trade_date", "stock_code", "factor_code", "raw_value"])
        )
        if not latest.is_empty():
            parts.append(latest)
    return pl.concat(parts, how="vertical") if parts else pl.DataFrame()


def _reference_dividend_factors(
    dividend: pl.DataFrame,
    pit_financial: pl.DataFrame,
    keep_dates: set[str],
) -> pl.DataFrame:
    """Independent annual dividend reference after exact full-row deduplication."""
    if dividend.is_empty():
        return pl.DataFrame()
    required = [
        "ANN_DT", "DVD_ANN_DT", "S_DIV_PRELANDATE", "EX_DT", "DVD_PAYOUT_DT",
        "TOT_CASH_DVD", "OTHER_TOT_CASH_DVD", "CASH_DVD_PER_SH_PRE_TAX", "TOT_SHR",
    ]
    missing = [column for column in required if column not in dividend.columns]
    if missing:
        dividend = dividend.with_columns([pl.lit(None).alias(column) for column in missing])

    def positive(expr: pl.Expr) -> pl.Expr:
        return pl.when(expr.is_not_null() & expr.is_finite() & (expr > 0)).then(expr).otherwise(None)

    total = pl.col("TOT_CASH_DVD").cast(pl.Float64, strict=False)
    other = pl.col("OTHER_TOT_CASH_DVD").cast(pl.Float64, strict=False)
    per_share = pl.col("CASH_DVD_PER_SH_PRE_TAX").cast(pl.Float64, strict=False)
    shares = pl.col("TOT_SHR").cast(pl.Float64, strict=False)
    events = (
        dividend.unique(keep="first", maintain_order=True)
        .select([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.coalesce([
                pl.col(column).cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False)
                for column in ["ANN_DT", "DVD_ANN_DT", "S_DIV_PRELANDATE", "EX_DT", "DVD_PAYOUT_DT"]
            ]).alias("event_date"),
            pl.col("REPORT_PERIOD").cast(pl.Int64, strict=False).alias("report_period"),
            pl.coalesce([
                positive(total), positive(other), positive(per_share * shares),
            ]).alias("cash_div"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("report_period").is_not_null()
            & (pl.col("cash_div") > 0)
            & pl.col("cash_div").is_finite()
        )
        .with_columns((pl.col("report_period") // 10000).cast(pl.Int64).alias("report_year"))
        .group_by(["stock_code", "report_year"])
        .agg([
            pl.col("cash_div").sum().alias("cash_div"),
            pl.col("event_date").max().alias("event_date"),
            pl.col("report_period").max().alias("report_period"),
        ])
        .sort(["stock_code", "report_year"])
    )
    annual_rows = []
    for stock, group in events.group_by("stock_code", maintain_order=True):
        stock_code = stock[0] if isinstance(stock, tuple) else stock
        streak = 0
        previous_year = None
        previous_cash = None
        for row in group.sort("report_year").iter_rows(named=True):
            year = int(row["report_year"])
            cash = float(row["cash_div"])
            streak = streak + 1 if previous_year is not None and year == previous_year + 1 else 1
            growth = cash / previous_cash - 1.0 if previous_cash and previous_year == year - 1 else None
            annual_rows.append({
                "stock_code": stock_code,
                "event_date": row["event_date"],
                "report_period": row["report_period"],
                "cash_div": cash,
                "div_streak": float(streak),
                "div_growth": growth,
            })
            previous_year = year
            previous_cash = cash
    if not annual_rows:
        return pl.DataFrame()
    annual = pl.DataFrame(annual_rows)
    latest_parts = []
    for asof in sorted(filter(None, (_parse_month_key(value) for value in keep_dates))):
        latest = (
            annual.filter(pl.col("event_date") <= asof)
            .sort(["stock_code", "event_date", "report_period"])
            .group_by("stock_code", maintain_order=True)
            .last()
            .with_columns(pl.lit(asof).alias("trade_date"))
        )
        if not latest.is_empty():
            latest_parts.append(latest)
    if not latest_parts:
        return pl.DataFrame()
    latest = pl.concat(latest_parts, how="vertical")
    outputs = [
        latest.select([
            "trade_date", "stock_code", pl.lit("DIVSTREAK").alias("factor_code"),
            pl.col("div_streak").alias("raw_value"),
        ]),
        latest.filter(pl.col("div_growth").abs() <= 20.0).select([
            "trade_date", "stock_code", pl.lit("DIVGROWTH").alias("factor_code"),
            pl.col("div_growth").alias("raw_value"),
        ]),
    ]
    if not pit_financial.is_empty():
        profit = _reference_monthly_value(
            pit_financial, "TRADE_DT", "S_DFA_NETPROFIT_TTM", keep_dates, "net_profit_ttm"
        )
        payout = (
            latest.select(["trade_date", "stock_code", "cash_div"])
            .join(profit, on=["trade_date", "stock_code"], how="left")
            .with_columns(
                pl.when(pl.col("net_profit_ttm") > 0)
                .then(pl.col("cash_div") / pl.col("net_profit_ttm"))
                .otherwise(None)
                .alias("raw_value")
            )
            .filter((pl.col("raw_value") >= 0) & (pl.col("raw_value") <= 5.0))
            .select([
                "trade_date", "stock_code", pl.lit("DIVPAYOUT").alias("factor_code"), "raw_value",
            ])
        )
        outputs.append(payout)
    return pl.concat(outputs, how="vertical")


def _reference_plain_window_sum(
    events: pl.DataFrame,
    keep_dates: set[str],
    factor_code: str,
    window_days: int,
) -> pl.DataFrame:
    """Aggregate already-prepared events without calling a production builder."""
    parts = []
    for asof in sorted(filter(None, (_parse_month_key(value) for value in keep_dates))):
        start = asof - timedelta(days=window_days - 1)
        part = (
            events.filter(
                (pl.col("event_date") >= start) & (pl.col("event_date") <= asof)
            )
            .group_by("stock_code")
            .agg(pl.col("event_amount").sum().alias("raw_value"))
            .with_columns([
                pl.lit(asof).alias("trade_date"),
                pl.lit(factor_code).alias("factor_code"),
            ])
            .select(["trade_date", "stock_code", "factor_code", "raw_value"])
        )
        if not part.is_empty():
            parts.append(part)
    return pl.concat(parts, how="vertical") if parts else pl.DataFrame()


def _reference_ratingchg(
    ratings: pl.DataFrame,
    keep_dates: set[str],
    cycle: str = "263002000",
    window_days: int = 90,
) -> pl.DataFrame:
    """Independent reference for the latest snapshot in 90 calendar dates."""
    required = {
        "S_INFO_WINDCODE", "RATING_DT", "S_WRATING_CYCLE",
        "S_WRATING_UPGRADE", "S_WRATING_DOWNGRADE",
    }
    if ratings.is_empty() or not required.issubset(ratings.columns):
        return pl.DataFrame()
    base = (
        ratings.with_row_index("_rowid")
        .select([
            "_rowid",
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("RATING_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("snapshot_date"),
            pl.col("S_WRATING_CYCLE").cast(pl.Utf8).str.strip_chars().alias("cycle"),
            pl.col("S_WRATING_UPGRADE").cast(pl.Float64, strict=False).alias("upgrade"),
            pl.col("S_WRATING_DOWNGRADE").cast(pl.Float64, strict=False).alias("downgrade"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("snapshot_date").is_not_null()
            & (pl.col("cycle") == cycle)
        )
    )
    parts = []
    for asof in sorted(filter(None, (_parse_month_key(value) for value in keep_dates))):
        start = asof - timedelta(days=window_days - 1)
        latest = (
            base.filter(
                (pl.col("snapshot_date") >= start)
                & (pl.col("snapshot_date") <= asof)
            )
            .sort(["stock_code", "snapshot_date", "_rowid"])
            .group_by("stock_code")
            .last()
            .filter(pl.col("upgrade").is_not_null() | pl.col("downgrade").is_not_null())
            .select([
                pl.lit(asof).alias("trade_date"),
                "stock_code",
                pl.lit("RATINGCHG").alias("factor_code"),
                (pl.col("upgrade").fill_null(0.0) - pl.col("downgrade").fill_null(0.0)).alias("raw_value"),
            ])
        )
        if not latest.is_empty():
            parts.append(latest)
    return pl.concat(parts, how="vertical") if parts else pl.DataFrame()


def _reference_refinpress(
    placement: pl.DataFrame,
    rights: pl.DataFrame,
    valuation: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    if valuation.is_empty():
        return pl.DataFrame()
    events = [
        _reference_funding_events(
            placement,
            "S_FELLOW_COLLECTION",
            "EXP_COLLECTION",
            "EVENT_ID",
        ),
        _reference_funding_events(
            rights,
            "S_RIGHTSISSUE_NETCOLLECTION",
            "S_EXPECTED_FUND_RAISING",
            None,
        ),
    ]
    events = [frame for frame in events if not frame.is_empty()]
    if not events:
        return pl.DataFrame()
    raised = _reference_latest_event_amounts(
        pl.concat(events, how="vertical"), keep_dates, window_days
    )
    mv = _reference_monthly_value(
        valuation, "TRADE_DT", "S_VAL_MV_ARD", keep_dates, "mv"
    )
    return (
        raised.join(mv, on=["trade_date", "stock_code"], how="left")
        .with_columns(
            pl.when(pl.col("mv") > 0)
            .then(pl.col("event_amount") / pl.col("mv"))
            .otherwise(None)
            .alias("raw_value")
        )
        .filter((pl.col("raw_value") >= 0) & (pl.col("raw_value") <= 5.0))
        .select([
            "trade_date",
            "stock_code",
            pl.lit("REFINPRESS").alias("factor_code"),
            "raw_value",
        ])
    )


def _reference_buybackratio(
    buyback: pl.DataFrame,
    price: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    """Independent audit implementation of the latest-positive-amount rule."""
    if buyback.is_empty() or price.is_empty():
        return pl.DataFrame()
    events = (
        buyback.with_row_index("_rowid")
        .select([
            "_rowid",
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("EVENT_ID").cast(pl.Utf8).str.strip_chars().alias("event_id"),
            pl.col("ANN_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            pl.col("AMT").cast(pl.Float64, strict=False).alias("event_amount"),
        ])
        .filter(
            pl.col("stock_code").is_not_null()
            & pl.col("event_id").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_amount").is_not_null()
            & pl.col("event_amount").is_finite()
            & (pl.col("event_amount") > 0)
        )
    )
    parts = []
    for asof in sorted(filter(None, (_parse_month_key(value) for value in keep_dates))):
        start = asof - timedelta(days=window_days - 1)
        part = (
            events.filter((pl.col("event_date") >= start) & (pl.col("event_date") <= asof))
            .sort(["stock_code", "event_id", "event_date", "_rowid"])
            .group_by(["stock_code", "event_id"])
            .last()
            .group_by("stock_code")
            .agg(pl.col("event_amount").sum().alias("buyback_amount"))
            .with_columns(pl.lit(asof).alias("trade_date"))
        )
        if not part.is_empty():
            parts.append(part)
    if not parts:
        return pl.DataFrame()
    amount = pl.concat(parts, how="vertical")
    float_mv = _reference_monthly_value(
        price, "TRADE_DT", "S_DQ_MV", keep_dates, "float_mv_10k"
    )
    return (
        amount.join(float_mv, on=["trade_date", "stock_code"], how="left")
        .with_columns(
            pl.when(pl.col("float_mv_10k") > 0)
            .then(pl.col("buyback_amount") / (pl.col("float_mv_10k") * 10000.0))
            .otherwise(None)
            .alias("raw_value")
        )
        .filter((pl.col("raw_value") >= 0) & (pl.col("raw_value") <= 5.0))
        .select([
            "trade_date",
            "stock_code",
            pl.lit("BUYBACKRATIO").alias("factor_code"),
            "raw_value",
        ])
    )


def _reference_mergersize(
    merger_event: pl.DataFrame,
    merger_participant: pl.DataFrame,
    valuation: pl.DataFrame,
    keep_dates: set[str],
    window_days: int = 365,
) -> pl.DataFrame:
    """Independent audit implementation of the buyer-only PIT merger rule."""
    if merger_event.is_empty() or merger_participant.is_empty() or valuation.is_empty():
        return pl.DataFrame()
    trade_value = pl.col("TRADE_VALUE").cast(pl.Float64, strict=False)
    cash_payment = pl.col("CASH_PAYMENT").cast(pl.Float64, strict=False)
    event_value = (
        merger_event.filter(
            pl.col("CRNCY_CODE").cast(pl.Utf8).str.strip_chars().str.to_uppercase() == "CNY"
        )
        .select([
            pl.col("EVENT_ID").cast(pl.Utf8),
            pl.coalesce([
                pl.col("UPDATE_DATE").cast(pl.Utf8),
                pl.col("ANN_DATE").cast(pl.Utf8),
            ]).str.strptime(pl.Date, "%Y%m%d", strict=False).alias("event_date"),
            (
                pl.when(trade_value.is_not_null() & trade_value.is_finite() & (trade_value > 0))
                .then(trade_value)
                .when(cash_payment.is_not_null() & cash_payment.is_finite() & (cash_payment > 0))
                .then(cash_payment)
                .otherwise(None)
                * 10000.0
            ).alias("event_value"),
        ])
        .filter(
            pl.col("EVENT_ID").is_not_null()
            & pl.col("event_date").is_not_null()
            & pl.col("event_value").is_not_null()
            & pl.col("event_value").is_finite()
            & (pl.col("event_value") > 0)
        )
    )
    buyers = (
        merger_participant.filter(
            pl.col("PARTY_ROLE_CODE").cast(pl.Utf8).str.strip_chars() == "325001000"
        )
        .select([
            pl.col("EVENT_ID").cast(pl.Utf8),
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
        ])
        .filter(pl.col("EVENT_ID").is_not_null() & pl.col("stock_code").is_not_null())
        .unique()
    )
    events = (
        buyers.join(event_value, on="EVENT_ID", how="inner")
        .rename({"EVENT_ID": "event_id", "event_value": "event_amount"})
    )
    raised = _reference_latest_event_amounts(events, keep_dates, window_days)
    if raised.is_empty():
        return pl.DataFrame()
    mv = _reference_monthly_value(
        valuation, "TRADE_DT", "S_VAL_MV_ARD", keep_dates, "mv"
    )
    return (
        raised.join(mv, on=["trade_date", "stock_code"], how="left")
        .with_columns(
            pl.when(pl.col("mv") > 0)
            .then(pl.col("event_amount") / pl.col("mv"))
            .otherwise(None)
            .alias("raw_value")
        )
        .filter((pl.col("raw_value") >= 0) & (pl.col("raw_value") <= 20.0))
        .select([
            "trade_date",
            "stock_code",
            pl.lit("MERGERSIZE").alias("factor_code"),
            "raw_value",
        ])
    )


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
            "S_INFO_WINDCODE", "S_DIV_PROGRESS", "STK_DVD_PER_SH",
            "CASH_DVD_PER_SH_PRE_TAX", "CASH_DVD_PER_SH_AFTER_TAX", "EX_DT",
            "DVD_PAYOUT_DT", "S_DIV_PRELANDATE", "DVD_ANN_DT", "ANN_DT", "REPORT_PERIOD",
            "IS_TRANSFER", "TOT_CASH_DVD", "OTHER_TOT_CASH_DVD", "TOT_SHR",
            "DIVIDEND_BATCH", "IS_SPEC_DIVIDEND",
        ], stocks)
        pit = _read_word_v2_parquet(src, "pit_financial_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_DFA_NETPROFIT_TTM"], stocks)
        out = _reference_dividend_factors(dividend, pit, keep_dates)
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
            unlock_monthly = _read_word_v2_parquet(
                FACTOR_UNLOCK_SRC,
                "unlock_monthly_pit_90d",
                [
                    "TRADE_DT", "S_INFO_WINDCODE", "UNLOCK_SHARES_90D",
                    "UNLOCK_RATIO_90D",
                ],
                stocks,
            )
            out = mod.build_unlock_mv_ratio_monthly(
                unlock_monthly, price, keep_dates
            )
    elif code == "INSTHOLD":
        institution = _read_word_v2_parquet(src, "institution_holding_ext", [
            "S_INFO_WINDCODE", "REPORT_PERIOD", "S_HOLDER_COMPCODE", "S_HOLDER_NAME",
            "S_HOLDER_HOLDERCATEGORY", "S_HOLDER_QUANTITY", "S_HOLDER_PCT", "ANN_DATE",
            "S_FLOAT_A_SHR",
        ], stocks)
        out = _reference_insthold(institution, keep_dates)
    elif code == "TOP10HOLD":
        inside_holder = _read_word_v2_parquet(src, "inside_holder_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "S_HOLDER_ENDDATE", "REPORT_PERIOD",
            "S_HOLDER_NAME", "S_HOLDER_ANAME", "S_HOLDER_HOLDERCATEGORY", "S_HOLDER_NAT",
            "S_HOLDER_QUANTITY", "S_HOLDER_PCT", "S_HOLDER_RESTRICTEDQUANTITY",
            "S_HOLDER_SHARECATEGORY", "S_HOLDER_SHARECATEGORYNAME", "S_HOLDER_SEQUENCE",
            "S_HOLDER_MEMO", "S_INFO_COMPCODE",
        ], stocks)
        out = _reference_top10hold(inside_holder, keep_dates)
    elif code == "UNLOCKPRESS":
        unlock_monthly = _read_word_v2_parquet(
            FACTOR_UNLOCK_SRC,
            "unlock_monthly_pit_90d",
            [
                "TRADE_DT", "S_INFO_WINDCODE", "UNLOCK_SHARES_90D",
                "UNLOCK_RATIO_90D",
            ],
            stocks,
        )
        out = mod.build_unlock_pressure_monthly(unlock_monthly, keep_dates)
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
    elif code == "RATINGCHG":
        ratings = _read_word_v2_parquet(src, "analyst_rating_ext", [
            "S_INFO_WINDCODE", "RATING_DT", "S_WRATING_UPGRADE", "S_WRATING_DOWNGRADE",
            "S_WRATING_CYCLE",
        ], stocks)
        out = _reference_ratingchg(ratings, keep_dates)
    elif code in {"ANALYSTCOVER", "TARGETPRICECHG"}:
        ratings = _read_word_v2_parquet(src, "analyst_rating_ext", [
            "S_INFO_WINDCODE", "RATING_DT", "S_WRATING_INSTNUM", "S_EST_PRICE",
        ], stocks)
        panel = ctx.get("_price_panel")
        trading_dates = (
            panel.get_column("trade_date").unique().sort().to_list()
            if isinstance(panel, pl.DataFrame) and "trade_date" in panel.columns
            else []
        )
        parts = [
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
        out = _reference_buybackratio(buyback, price, keep_dates)
    elif code == "PLACEDISCOUNT":
        placement = _read_word_v2_parquet(src, "placement_ext", [
            "S_INFO_WINDCODE", "EVENT_ID", "ANN_DT", "S_FELLOW_DISCNTRATIO",
        ], stocks)
        out = _reference_placediscount(placement, keep_dates)
    elif code == "PLACEMENTSIZE":
        placement = _read_word_v2_parquet(src, "placement_ext", [
            "S_INFO_WINDCODE", "EVENT_ID", "ANN_DT", "S_FELLOW_COLLECTION", "EXP_COLLECTION",
        ], stocks)
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = _reference_placement_size(placement, valuation, keep_dates)
    elif code == "MERGERSIZE":
        merger_event = _read_word_v2_parquet(src, "merger_event_ext", [
            "EVENT_ID", "ANN_DATE", "UPDATE_DATE", "TRADE_VALUE", "CASH_PAYMENT", "CRNCY_CODE",
        ], None)
        merger_participant = _read_word_v2_parquet(
            src,
            "merger_participant_ext",
            ["EVENT_ID", "S_INFO_WINDCODE", "PARTY_ROLE_CODE"],
            stocks,
        )
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = _reference_mergersize(
            merger_event,
            merger_participant,
            valuation,
            keep_dates,
        )
    elif code == "INCENTIVESIZE":
        incentive = _read_word_v2_parquet(src, "equity_incentive_ext", [
            "S_INFO_WINDCODE", "EQINC_PLAN_EVENT_ID", "S_INC_SEQUENCE", "ANN_DT", "INC_NUMBERS_RATE",
        ], stocks)
        out = _reference_incentivesize(incentive, keep_dates)
    elif code == "RISKINVESTCNT":
        investigation = _read_word_v2_parquet(src, "risk_investigation_ext", [
            "S_INFO_WINDCODE", "COMP_ID", "STR_ANNDATE", "END_ANNDATE", "STR_DATE",
            "SUR_INSTITUTE", "SUR_REASONS",
        ], stocks)
        out = _reference_riskinvestcnt(investigation, keep_dates)
    elif code == "PUNISHAMT":
        illegality = _read_word_v2_parquet(src, "risk_illegality_ext", [
            "S_INFO_WINDCODE", "S_INFO_COMPCODE", "ANN_DT", "ILLEG_TYPE", "SUBJECT_TYPE", "SUBJECT",
            "RELATION_TYPE", "DISPOSAL_DT", "DISPOSAL_TYPE", "METHOD", "AMOUNT", "BAN_YEAR",
        ], stocks)
        out = _reference_punishamt(illegality, keep_dates)
    elif code == "LAWSUITAMT":
        lawsuit = _read_word_v2_parquet(src, "lawsuit_ext", [
            "S_INFO_WINDCODE", "S_INFO_COMPCODE", "ANN_DT", "TITLE", "ACCUSER", "DEFENDANT", "PRO_TYPE",
            "AMOUNT", "CRNCY_CODE", "PROSECUTE_DT", "COURT", "JUDGE_DT", "RESULT", "RESULTAMOUNT", "BRIEFRESULT",
        ], stocks)
        out = _reference_lawsuitamt(lawsuit, keep_dates)
    elif code == "AUDITQUAL":
        audit = _read_word_v2_parquet(src, "audit_opinion_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD", "S_STMNOTE_AUDIT_CATEGORY",
        ], stocks)
        out = mod.build_auditqual(audit, keep_dates)
    elif code in {"MAJORHOLDERCHG", "EXECHOLDERCHG"}:
        holder_trade = _read_word_v2_parquet(src, "holder_trade_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "TRANSACT_STARTDATE", "TRANSACT_ENDDATE",
            "HOLDER_NAME", "HOLDER_TYPE", "TRANSACT_TYPE", "TRANSACT_QUANTITY",
            "TRANSACT_QUANTITY_RATIO", "HOLDER_QUANTITY_NEW", "HOLDER_QUANTITY_NEW_RATIO",
            "AVG_PRICE", "IS_RESTRICTED", "TRADE_DETAIL",
        ], stocks)
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = _reference_holder_trade_change(
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
            "S_INFO_WINDCODE", "EVENT_ID", "ANN_DT", "S_FELLOW_COLLECTION", "EXP_COLLECTION",
        ], stocks)
        rights = _read_word_v2_parquet(src, "rights_issue_ext", [
            "S_INFO_WINDCODE", "ANN_DT", "S_RIGHTSISSUE_NETCOLLECTION", "S_EXPECTED_FUND_RAISING",
        ], stocks)
        valuation = _read_word_v2_parquet(src, "valuation_ext", ["S_INFO_WINDCODE", "TRADE_DT", "S_VAL_MV_ARD"], stocks)
        out = _reference_refinpress(placement, rights, valuation, keep_dates)

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
