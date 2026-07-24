"""生成行业/市值中性化后的 factor_score_neutral。

口径：
  raw_value -> positive_only 过滤 -> 申万一级行业 + log(市值) 回归残差
  -> rank_to_normal -> 方向统一。

用法：
    python scripts/03b_neutralize.py [--raw ...] [--descriptors ...] [--out ...]
"""
import argparse
from pathlib import Path
from typing import Optional

import numpy as np
import polars as pl
import pyarrow.parquet as pq

from factor_lib.factors import momentum, volatility, liquidity, beta, company, market_extra, investor, derived, tech_event, word_v2  # noqa: F401
from factor_lib.industry import load_industry_map
from factor_lib.monthly_returns import month_end_panel
from factor_lib.registry import FACTOR_REGISTRY
from factor_lib.normalize import apply_direction, neutralize_by_industry_size, rank_to_normal
from factor_lib.universe import word_universe_for_scores


BATCH_GROUPS = 48
NEUTRAL_QUALITY_OK = "ok"
NEUTRAL_QUALITY_INSUFFICIENT = "insufficient_sample"
NEUTRAL_QUALITY_MISSING_INPUT = "missing_input"
NEUTRAL_QUALITY_REGRESSION_FAILED = "regression_failed"


def _valid_neutralization_mask(
    values: np.ndarray,
    industries: np.ndarray,
    market_caps: np.ndarray,
) -> np.ndarray:
    v = np.asarray(values, dtype=float)
    ind = np.asarray(industries, dtype=object)
    mv = np.asarray(market_caps, dtype=float)
    valid_ind = np.array([
        x is not None and str(x) != "" and str(x).lower() != "nan"
        for x in ind
    ])
    return (~np.isnan(v)) & valid_ind & (~np.isnan(mv)) & (mv > 0)


def _neutralization_quality(
    values: np.ndarray,
    industries: np.ndarray,
    market_caps: np.ndarray,
    resid: np.ndarray,
) -> tuple[list[str], int]:
    valid = _valid_neutralization_mask(values, industries, market_caps)
    valid_count = int(valid.sum())
    quality = np.full(len(values), NEUTRAL_QUALITY_MISSING_INPUT, dtype=object)
    if valid_count < 3:
        quality[valid] = NEUTRAL_QUALITY_INSUFFICIENT
        return quality.tolist(), valid_count

    resid = np.asarray(resid, dtype=float)
    finite_resid = np.isfinite(resid)
    quality[valid & finite_resid] = NEUTRAL_QUALITY_OK
    quality[valid & ~finite_resid] = NEUTRAL_QUALITY_REGRESSION_FAILED
    return quality.tolist(), valid_count


def _neutralize_group(group: pl.DataFrame) -> pl.DataFrame:
    code = group["factor_code"][0]
    entry = FACTOR_REGISTRY[code]
    direction = entry["direction"]
    vals = group["raw_value"].to_numpy().astype(float)
    industries = group["industry_sw1"].to_numpy()
    market_caps = group["market_cap"].to_numpy().astype(float)

    std_in = vals.copy()
    if entry.get("positive_only"):
        std_in[std_in <= 0] = np.nan

    resid = neutralize_by_industry_size(std_in, industries, market_caps)
    quality, valid_count = _neutralization_quality(std_in, industries, market_caps, resid)
    z = rank_to_normal(resid)
    score = apply_direction(z, direction)

    return group.select(["trade_date", "stock_code", "factor_code"]).with_columns([
        pl.Series("raw_value", vals, nan_to_null=True),
        pl.Series("score", score, nan_to_null=True),
        pl.Series("neutralization_quality", quality, dtype=pl.Utf8),
        pl.Series("neutralization_valid_count", np.full(len(vals), valid_count, dtype=np.int32)),
    ])


def _write_chunks(
    writer: Optional[pq.ParquetWriter],
    tmp: Path,
    chunks: list,
) -> tuple:
    out = pl.concat(chunks, rechunk=True)
    table = out.to_arrow()
    if writer is None:
        writer = pq.ParquetWriter(tmp, table.schema, compression="zstd")
    writer.write_table(table)
    return writer, out.height


def _apply_word_universe(raw: pl.DataFrame, panel_path: Optional[str], meta_path: Optional[str]) -> pl.DataFrame:
    if not panel_path or not meta_path:
        return raw
    panel_file = Path(panel_path)
    meta_file = Path(meta_path)
    if not panel_file.exists() or not meta_file.exists():
        raise FileNotFoundError(f"Word universe requires existing panel/meta: {panel_path}, {meta_path}")
    panel = pl.read_parquet(panel_file)
    meta = pl.read_parquet(meta_file)
    return word_universe_for_scores(raw, panel, meta, FACTOR_REGISTRY)


def _descriptor_for_neutralization(
    descriptors_path: str,
    panel_path: Optional[str],
    industry_history_path: Optional[str],
) -> pl.DataFrame:
    if not panel_path:
        return pl.read_parquet(descriptors_path, columns=["stock_code", "industry_sw1", "market_cap"])
    panel = pl.read_parquet(panel_path)
    month_end = month_end_panel(panel).select(["trade_date", "stock_code", "market_cap"])
    industry = (
        load_industry_map(
            month_end["trade_date"].unique().to_list(),
            history_path=industry_history_path,
            static_path=descriptors_path,
        )
        if industry_history_path
        else pl.read_parquet(descriptors_path, columns=["stock_code", "industry_sw1"]).unique("stock_code")
    )
    join_keys = ["trade_date", "stock_code"] if "trade_date" in industry.columns else ["stock_code"]
    return month_end.join(industry, on=join_keys, how="left").select(["trade_date", "stock_code", "industry_sw1", "market_cap"])


def main(raw_path: str, descriptors_path: str, out_path: str, panel_path: Optional[str] = None, meta_path: Optional[str] = None,
         industry_history_path: Optional[str] = None):
    raw = pl.read_parquet(raw_path)
    raw = _apply_word_universe(raw, panel_path, meta_path)
    desc = _descriptor_for_neutralization(descriptors_path, panel_path, industry_history_path)
    join_keys = ["trade_date", "stock_code"] if "trade_date" in desc.columns else ["stock_code"]
    raw = raw.join(desc, on=join_keys, how="left")

    out = Path(out_path)
    tmp = out.with_suffix(out.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()

    writer = None
    rows = 0
    chunks = []
    try:
        for _, group in raw.group_by(["trade_date", "factor_code"], maintain_order=True):
            chunks.append(_neutralize_group(group))
            if len(chunks) >= BATCH_GROUPS:
                writer, written = _write_chunks(writer, tmp, chunks)
                rows += written
                chunks.clear()

        if chunks:
            writer, written = _write_chunks(writer, tmp, chunks)
            rows += written
    finally:
        if writer is not None:
            writer.close()

    tmp.replace(out)
    print(f"Wrote {out_path}: {rows:,} rows")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="data/raw/factor_raw.parquet")
    parser.add_argument("--descriptors", default="frontend/data/stock_descriptors.parquet")
    parser.add_argument("--out", default="data/factor_score_neutral.parquet")
    parser.add_argument("--panel", default=None)
    parser.add_argument("--meta", default=None)
    parser.add_argument("--industry-history", default="资料/balance_sheet_interest_bearing_processed/parquet/sw_industry_history.parquet")
    args = parser.parse_args()
    main(args.raw, args.descriptors, args.out, args.panel, args.meta, args.industry_history)
