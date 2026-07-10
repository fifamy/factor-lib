"""外部源类因子回查：从 资料/<source_file>.csv 取 source_field，按 transform 复算并与 factor_raw 比对。"""
from __future__ import annotations

from pathlib import Path

import polars as pl

from factor_lib.monthly_lag import with_strict_month_lag
from factor_lib.audit.sampling import sample_units

# 股票代码列名：valuation 用 STOCK_CODE，其余用 S_INFO_WINDCODE
_CODE_COL = {"valuation": "STOCK_CODE"}
ABS_TOL = 1e-9
REL_TOL = 1e-6


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


def recheck_external(code: str, meta: dict, factor_raw: pl.DataFrame, src_dir: str = "资料", k: int = 200) -> dict:
    field = meta["source_field"]
    sfile = meta["source_file"]
    transform = meta.get("transform", "level")
    extra = ["EXPRESS_AGE"] if transform == "event_first" else []
    src = _read_source(sfile, [field] + extra, src_dir)
    base = {"status": "na", "method": "source_recheck", "n_checked": 0, "n_match": 0,
            "max_abs_diff": 0.0, "tol": REL_TOL, "mismatches": []}
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
    elif transform == "event_first":
        s = src.filter(pl.col("EXPRESS_AGE").cast(pl.Float64, strict=False).is_not_null())
        s = s.with_columns(
            (pl.col("trade_date").dt.year() * 12 + pl.col("trade_date").dt.month()
             - pl.col("EXPRESS_AGE").cast(pl.Float64, strict=False)).alias("rp_idx")
        ).sort(["stock_code", "trade_date"])
        prev = pl.col("rp_idx").shift(1).over("stock_code")
        first = s.filter(prev.is_null() | (pl.col("rp_idx") > prev))
        ref_df = first.select(["stock_code", "trade_date", pl.col(field).alias("ref")])
    else:
        return base

    units = sample_units(factor_raw, code, k=k)
    if not units:
        base["status"] = "source_missing"
        return base
    unit_df = pl.DataFrame(
        {
            "stock_code": [stock for stock, _ in units],
            "trade_date": [asof for _, asof in units],
        },
        schema={"stock_code": pl.Utf8, "trade_date": pl.Date},
    )
    ref_df = (
        ref_df.filter(pl.col("ref").is_not_null() & pl.col("ref").is_finite())
        .join(unit_df, on=["stock_code", "trade_date"], how="inner")
        .select(["stock_code", "trade_date", "ref"])
    )
    stored_df = (
        factor_raw.filter(pl.col("factor_code") == code)
        .join(unit_df, on=["stock_code", "trade_date"], how="inner")
        .select(["stock_code", "trade_date", "raw_value"])
    )
    checked = stored_df.join(ref_df, on=["stock_code", "trade_date"], how="left")
    n_check = n_match = 0
    max_diff = 0.0
    mism = []
    for row in checked.to_dicts():
        stock = row["stock_code"]
        asof = row["trade_date"]
        stored = row["raw_value"]
        if stored is None:
            continue
        ref = row.get("ref")
        n_check += 1
        if _close(ref, stored):
            n_match += 1
        else:
            if ref is None:
                # 源中找不到该 (stock,date)：记为不符但不当作数值差
                if len(mism) < 5:
                    mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                                 "ref": None, "stored": stored, "abs_diff": None})
            else:
                d = abs(ref - stored)
                max_diff = max(max_diff, d)
                if len(mism) < 5:
                    mism.append({"stock_code": stock, "trade_date": asof.isoformat(),
                                 "ref": ref, "stored": stored, "abs_diff": d})
    base.update(n_checked=n_check, n_match=n_match, max_abs_diff=max_diff, mismatches=mism)
    if n_check == 0:
        base["status"] = "source_missing"
    elif n_match == n_check:
        base["status"] = "match"
    else:
        base["status"] = "mismatch"
    return base
