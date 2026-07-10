"""把 factor_raw 转成 factor_score（rank → 正态分位数标准化 + 方向统一）。

标准化用 rank_to_normal（rank-based 高斯）而非 mean/std z-score：
重尾右偏因子（如 ROE）用 z-score 时，少数极值拉高均值/方差，缩尾后大量样本
顶到边界、并列同一 z 值，导致 Top-N 选股在并列中无法区分、排序退化。

注意：rank 路径【不缩尾】。rank 对极值天然免疫，无需缩尾；而缩尾反而会把一批
极值压成完全相同的数，rank 平均法给它们同一分位 → 重新制造并列。直接对原始值
做 rank 即严格保序、Top-N 全可区分。winsorize_3mad 仍保留供其它分析按需调用。

用法：
    python scripts/03_normalize.py [--raw ...] [--out ...]
"""
import argparse
from pathlib import Path
from typing import Optional
import polars as pl
import numpy as np
import pyarrow.parquet as pq

from factor_lib.factors import momentum, volatility, liquidity, beta, company, market_extra, investor, derived, tech_event, word_v2  # noqa: F401
from factor_lib.registry import FACTOR_REGISTRY
from factor_lib.normalize import rank_to_normal, apply_direction
from factor_lib.universe import word_universe_for_scores

BATCH_GROUPS = 64


def _normalize_group(group: pl.DataFrame) -> pl.DataFrame:
    code = group["factor_code"][0]
    entry = FACTOR_REGISTRY[code]
    direction = entry["direction"]
    vals = group["raw_value"].to_numpy().astype(float)

    # 估值比率 positive_only：分母为负时比率无"便宜"含义（负 PE = 亏损，不是低估值）。
    # 把 ≤0 的值置 NaN，使其不参与排序、score 为空、不被选进 top（raw_value 仍保留供查看）。
    std_in = vals.copy()
    if entry.get("positive_only"):
        std_in[std_in <= 0] = np.nan

    z = rank_to_normal(std_in)        # rank 标准化不缩尾（对极值免疫）
    score = apply_direction(z, direction)

    return group.select(["trade_date", "stock_code", "factor_code"]).with_columns([
        pl.Series("raw_value", vals, nan_to_null=True),
        pl.Series("score", score, nan_to_null=True),
    ])


def _write_chunks(
    writer: Optional[pq.ParquetWriter],
    tmp: Path,
    chunks: list[pl.DataFrame],
) -> tuple[pq.ParquetWriter, int]:
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


def main(raw_path: str, out_path: str, panel_path: Optional[str] = None, meta_path: Optional[str] = None):
    raw = pl.read_parquet(raw_path)
    raw = _apply_word_universe(raw, panel_path, meta_path)
    out = Path(out_path)
    tmp = out.with_suffix(out.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()

    writer = None
    rows = 0
    chunks = []
    try:
        for _, group in raw.group_by(["trade_date", "factor_code"], maintain_order=True):
            chunks.append(_normalize_group(group))
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
    parser.add_argument("--out", default="data/factor_score.parquet")
    parser.add_argument("--panel", default=None)
    parser.add_argument("--meta", default=None)
    args = parser.parse_args()
    main(args.raw, args.out, args.panel, args.meta)
