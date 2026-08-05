"""外部源类因子回查：从 资料/<source_file>.csv 取 source_field，按 transform 复算并与 factor_raw 比对。"""
from __future__ import annotations

from pathlib import Path

import polars as pl

from factor_lib.monthly_lag import with_strict_month_lag
from factor_lib.audit.sampling import sample_missing_units, sample_units

# 股票代码列名：valuation 用 STOCK_CODE，其余用 S_INFO_WINDCODE
_CODE_COL = {"valuation": "STOCK_CODE"}
ABS_TOL = 1e-9
REL_TOL = 1e-6
EV2EBITDA_MAX_STALE_DAYS = 200


def _code_col(source_file: str) -> str:
    return _CODE_COL.get(source_file, "S_INFO_WINDCODE")


def _read_source(source_file: str, fields: list[str], src_dir: str) -> pl.DataFrame:
    path = Path(src_dir) / f"{source_file}.csv"
    if not path.exists():
        return pl.DataFrame()
    code_col = _code_col(source_file)
    want = [code_col, "TRADE_DT"] + fields
    df = pl.read_csv(path, infer_schema_length=0)
    cols = [c for c in want if c in df.columns]
    if code_col not in cols or "TRADE_DT" not in cols:
        return pl.DataFrame()
    df = df.select(cols).rename({code_col: "stock_code"})
    df = df.with_columns(
        pl.col("stock_code").str.strip_chars(),
        pl.col("TRADE_DT").str.strptime(pl.Date, "%Y%m%d", strict=False).alias("trade_date"),
    )
    for f in fields:
        if f in df.columns:
            df = df.with_columns(pl.col(f).cast(pl.Float64, strict=False))
    return df


def _close(ref, stored) -> bool:
    if ref is None or stored is None:
        return False
    return abs(ref - stored) <= ABS_TOL + REL_TOL * abs(stored)


def _mv_ebitda_asof_reference(
    src_dir: str,
    factor_raw: pl.DataFrame,
    candidate_units: pl.DataFrame | None,
) -> pl.DataFrame:
    """独立复算历史代码 EV2EBITDA 的当前总市值/EBITDA 口径。"""
    root = Path(src_dir)
    valuation_path = root / "valuation.csv"
    pit_path = root / "pit_financial.csv"
    if not valuation_path.exists() or not pit_path.exists():
        return pl.DataFrame()

    keys = factor_raw.select(["stock_code", "trade_date"])
    if candidate_units is not None and not candidate_units.is_empty():
        keys = pl.concat(
            [keys, candidate_units.select(["stock_code", "trade_date"])],
            how="vertical",
        )
    keys = keys.drop_nulls().unique()
    if keys.is_empty():
        return pl.DataFrame()
    stocks = keys.get_column("stock_code").unique().to_list()
    date_keys = keys.get_column("trade_date").unique().dt.strftime("%Y%m%d").to_list()

    market_value = (
        pl.read_csv(
            valuation_path,
            infer_schema_length=0,
            columns=["STOCK_CODE", "TRADE_DT", "S_VAL_MV_ARD"],
        )
        .filter(
            pl.col("STOCK_CODE").cast(pl.Utf8).str.strip_chars().is_in(stocks)
            & pl.col("TRADE_DT").cast(pl.Utf8).is_in(date_keys)
        )
        .with_columns([
            pl.col("STOCK_CODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("TRADE_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d").alias("trade_date"),
            pl.col("S_VAL_MV_ARD").cast(pl.Float64, strict=False).alias("market_value"),
        ])
        .select(["stock_code", "trade_date", "market_value"])
    )
    ebitda = (
        pl.read_csv(
            pit_path,
            infer_schema_length=0,
            columns=["S_INFO_WINDCODE", "TRADE_DT", "S_DFA_EBITDA_TTM"],
        )
        .filter(
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().is_in(stocks)
            & pl.col("TRADE_DT").cast(pl.Utf8).is_in(date_keys)
        )
        .with_columns([
            pl.col("S_INFO_WINDCODE").cast(pl.Utf8).str.strip_chars().alias("stock_code"),
            pl.col("TRADE_DT").cast(pl.Utf8).str.strptime(pl.Date, "%Y%m%d").alias("trade_date"),
            pl.col("S_DFA_EBITDA_TTM").cast(pl.Float64, strict=False).alias("ebitda"),
        ])
        .select(["stock_code", "trade_date", "ebitda"])
        .sort(["stock_code", "trade_date"])
        .with_columns(
            pl.when(pl.col("ebitda").is_not_null())
            .then(pl.col("trade_date"))
            .otherwise(None)
            .alias("ebitda_observed_date")
        )
        .with_columns([
            pl.col("ebitda").forward_fill().over("stock_code"),
            pl.col("ebitda_observed_date").forward_fill().over("stock_code"),
        ])
        .filter(
            (pl.col("trade_date") - pl.col("ebitda_observed_date")).dt.total_days()
            <= EV2EBITDA_MAX_STALE_DAYS
        )
    )
    return (
        market_value.join(ebitda, on=["stock_code", "trade_date"], how="left")
        .with_columns((pl.col("market_value") / pl.col("ebitda")).alias("ref"))
        .select(["stock_code", "trade_date", "ref"])
        .filter(pl.col("ref").is_not_null() & pl.col("ref").is_finite())
        .unique(subset=["stock_code", "trade_date"], keep="last")
    )


def recheck_external(
    code: str,
    meta: dict,
    factor_raw: pl.DataFrame,
    src_dir: str = "资料",
    k: int = 200,
    candidate_units: pl.DataFrame | None = None,
) -> dict:
    field = meta["source_field"]
    sfile = meta["source_file"]
    transform = meta.get("transform", "level")
    base = {"status": "na", "method": "source_recheck", "n_checked": 0, "n_match": 0,
            "n_stored_only": 0, "n_ref_only": 0,
            "max_abs_diff": 0.0, "tol": REL_TOL, "mismatches": []}
    if transform == "mv_ebitda_asof":
        ref_df = _mv_ebitda_asof_reference(src_dir, factor_raw, candidate_units)
        if ref_df.is_empty():
            base["status"] = "source_missing"
            return base
    else:
        extra = ["EXPRESS_AGE"] if transform == "event_first" else []
        src = _read_source(sfile, [field] + extra, src_dir)
        if src.is_empty() or field not in src.columns:
            base["status"] = "source_missing"
            return base

    if transform == "level":
        ref_df = src.select(["stock_code", "trade_date", pl.col(field).alias("ref")])
    elif transform in ("mom_diff", "mom_pct"):
        s = (
            src.with_columns(
                [
                    pl.col("trade_date").dt.year().alias("_year"),
                    pl.col("trade_date").dt.month().alias("_month"),
                ]
            )
            .sort(["stock_code", "trade_date"])
            .group_by(["stock_code", "_year", "_month"], maintain_order=True)
            .agg([pl.col("trade_date").last().alias("trade_date"), pl.col(field).last().alias(field)])
            .sort(["stock_code", "trade_date"])
        )
        s = with_strict_month_lag(s, field)
        if transform == "mom_diff":
            ref_expr = (pl.col(field) - pl.col("_prev"))
        else:
            ref_expr = pl.when(pl.col("_prev") > 0).then(pl.col(field) / pl.col("_prev") - 1).otherwise(None)
        ref_df = s.with_columns(ref_expr.alias("ref")).select(["stock_code", "trade_date", "ref"])
    elif transform == "yoy_diff_12m":
        s = src.with_columns(
            (pl.col("trade_date").dt.year() * 12 + pl.col("trade_date").dt.month()).alias("_month_id")
        )
        lag = s.select([
            "stock_code",
            (pl.col("_month_id") + 12).alias("_month_id"),
            pl.col(field).alias("_lag12"),
        ])
        ref_df = (
            s.join(lag, on=["stock_code", "_month_id"], how="left")
            .with_columns((pl.col(field) - pl.col("_lag12")).alias("ref"))
            .select(["stock_code", "trade_date", "ref"])
        )
    elif transform == "event_first":
        s = src.filter(pl.col("EXPRESS_AGE").cast(pl.Float64, strict=False).is_not_null())
        s = s.with_columns(
            (pl.col("trade_date").dt.year() * 12 + pl.col("trade_date").dt.month()
             - pl.col("EXPRESS_AGE").cast(pl.Float64, strict=False)).alias("rp_idx")
        ).sort(["stock_code", "trade_date"])
        prev = pl.col("rp_idx").shift(1).over("stock_code")
        first = s.filter(prev.is_null() | (pl.col("rp_idx") > prev))
        ref_df = first.select(["stock_code", "trade_date", pl.col(field).alias("ref")])
    elif transform != "mv_ebitda_asof":
        return base

    ref_df = (
        ref_df.filter(pl.col("ref").is_not_null() & pl.col("ref").is_finite())
        .unique(subset=["stock_code", "trade_date"], keep="last")
    )
    factor_slice = factor_raw.filter(pl.col("factor_code") == code)
    units = sample_units(factor_slice, code, k=k)
    ref_candidates = ref_df.select(["stock_code", "trade_date"])
    if candidate_units is not None and not candidate_units.is_empty():
        ref_candidates = ref_candidates.join(
            candidate_units.select(["stock_code", "trade_date"]).unique(),
            on=["stock_code", "trade_date"],
            how="inner",
        )
    units.extend(sample_missing_units(ref_candidates, factor_slice, k=k))
    units = list(dict.fromkeys(units))
    if not units:
        base["status"] = "source_missing"
        return base
    stored = {
        (r["stock_code"], r["trade_date"]): r["raw_value"]
        for r in factor_slice.select(["stock_code", "trade_date", "raw_value"]).to_dicts()
    }
    ref = {
        (r["stock_code"], r["trade_date"]): r["ref"]
        for r in ref_df.select(["stock_code", "trade_date", "ref"]).to_dicts()
    }
    n_check = n_match = n_stored_only = n_ref_only = 0
    max_diff = 0.0
    mism = []
    for stock, asof in units:
        stored_v = stored.get((stock, asof))
        ref_v = ref.get((stock, asof))
        if stored_v is None and ref_v is None:
            continue
        n_check += 1
        if stored_v is None:
            n_ref_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref_v, "stored": None, "abs_diff": None})
            continue
        if ref_v is None:
            n_stored_only += 1
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": None, "stored": stored_v, "abs_diff": None})
            continue
        if _close(ref_v, stored_v):
            n_match += 1
        else:
            d = abs(ref_v - stored_v)
            max_diff = max(max_diff, d)
            if len(mism) < 5:
                mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                             "ref": ref_v, "stored": stored_v, "abs_diff": d})
    base.update(n_checked=n_check, n_match=n_match, n_stored_only=n_stored_only,
                n_ref_only=n_ref_only, max_abs_diff=max_diff, mismatches=mism)
    if n_check == 0:
        base["status"] = "source_missing"
    elif n_match == n_check:
        base["status"] = "match"
    else:
        base["status"] = "mismatch"
    return base
