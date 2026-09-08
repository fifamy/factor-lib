"""在一个既有股票池内运行受控表达式挖掘与嵌套样本外检验。

示例：
    python3 scripts/17_mine_factor_expressions.py

输出仅是研究候选证据，不会自动写入因子注册表或生产分数。
"""
from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
from typing import Any

import polars as pl

from factor_lib.expression_mining import (
    candidate_monthly_rank_ic,
    generate_candidates,
    nested_walk_forward_select,
)


CONFIG_KEYS = {
    "schema_version",
    "research_only",
    "base_factors",
    "operations",
    "max_base_factors",
    "max_candidates",
    "min_cross_section",
    "min_outer_train_months",
    "inner_validation_months",
    "test_months",
    "step_months",
    "min_discovery_months",
    "min_validation_months",
    "min_test_months",
    "fdr_alpha",
    "min_validation_positive_rate",
    "complexity_penalty",
    "top_k",
}


def load_config(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    config = json.loads(raw)
    if not isinstance(config, dict):
        raise ValueError("expression mining config must be a JSON object")
    unknown = sorted(set(config) - CONFIG_KEYS)
    if unknown:
        raise ValueError(f"unknown config keys: {unknown}")
    required = CONFIG_KEYS - {"schema_version", "research_only"}
    missing = sorted(required - set(config))
    if missing:
        raise ValueError(f"missing config keys: {missing}")
    if config.get("schema_version", 1) != 1:
        raise ValueError("unsupported config schema_version")
    if config.get("research_only", True) is not True:
        raise ValueError("expression mining output must remain research_only")
    return config, hashlib.sha256(raw).hexdigest()


def _write_parquet_atomic(frame: pl.DataFrame, path: Path) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    frame.write_parquet(temporary, compression="zstd", compression_level=9)
    temporary.replace(path)


def _write_json_atomic(payload: dict[str, Any], path: Path) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _parse_as_of(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"invalid --as-of date: {value!r}") from exc


def run(args: argparse.Namespace) -> dict[str, Any]:
    config_path = Path(args.config)
    config, config_sha256 = load_config(config_path)
    as_of = _parse_as_of(args.as_of)
    candidates = generate_candidates(
        config["base_factors"],
        config["operations"],
        max_base_factors=int(config["max_base_factors"]),
        max_candidates=int(config["max_candidates"]),
    )

    membership_path = Path(args.membership)
    membership = pl.read_parquet(membership_path)
    required_membership = {"signal_date", "pool_id", "pool_type", "pool_name", "stock_code"}
    missing_membership = sorted(required_membership - set(membership.columns))
    if missing_membership:
        raise ValueError(f"membership missing columns: {missing_membership}")
    pool_rows = membership.select(["pool_id", "pool_type", "pool_name"]).unique()
    if pool_rows.height != 1:
        raise ValueError("membership must contain exactly one stock pool")
    pool = pool_rows.row(0, named=True)

    base_factors = list(config["base_factors"])
    score_scan = (
        pl.scan_parquet(args.score)
        .filter(pl.col("factor_code").is_in(base_factors))
        .select(["trade_date", "stock_code", "factor_code", "score"])
    )
    scores = score_scan.collect(engine="streaming")
    returns_scan = pl.scan_parquet(args.returns).select(
        ["trade_date", "return_date", "stock_code", "fwd_return"]
    )
    if as_of is not None:
        returns_scan = returns_scan.filter(pl.col("return_date") <= pl.lit(as_of))
    returns = returns_scan.collect(engine="streaming")

    monthly = candidate_monthly_rank_ic(
        scores,
        returns,
        candidates,
        membership=membership,
        min_cross_section=int(config["min_cross_section"]),
    )
    nested = nested_walk_forward_select(
        monthly,
        candidates,
        min_outer_train_months=int(config["min_outer_train_months"]),
        inner_validation_months=int(config["inner_validation_months"]),
        test_months=int(config["test_months"]),
        step_months=int(config["step_months"]),
        min_discovery_months=int(config["min_discovery_months"]),
        min_validation_months=int(config["min_validation_months"]),
        min_test_months=int(config["min_test_months"]),
        fdr_alpha=float(config["fdr_alpha"]),
        min_validation_positive_rate=float(config["min_validation_positive_rate"]),
        complexity_penalty=float(config["complexity_penalty"]),
        top_k=int(config["top_k"]),
    )

    pool_columns = [
        pl.lit(pool["pool_id"]).alias("pool_id"),
        pl.lit(pool["pool_type"]).alias("pool_type"),
        pl.lit(pool["pool_name"]).alias("pool_name"),
    ]
    monthly = monthly.with_columns(pool_columns).select(
        ["pool_id", "pool_type", "pool_name"] + monthly.columns
    )
    nested = nested.with_columns(pool_columns).select(
        ["pool_id", "pool_type", "pool_name"] + nested.columns
    )
    candidate_frame = pl.DataFrame([candidate.as_dict() for candidate in candidates])

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_parquet_atomic(candidate_frame, out_dir / "candidates.parquet")
    _write_parquet_atomic(monthly, out_dir / "candidate_monthly_rank_ic.parquet")
    _write_parquet_atomic(nested, out_dir / "nested_walk_forward.parquet")

    finite_monthly = monthly.filter(pl.col("rank_ic").is_finite())
    evaluated = nested.filter(pl.col("outer_test_status") == "evaluated")
    return_end = returns["return_date"].drop_nulls().max()
    metadata = {
        "schema_version": 1,
        "status": "research_candidates_only",
        "production_registration": False,
        "pool": pool,
        "as_of_return_date": return_end.isoformat() if return_end is not None else None,
        "config_path": str(config_path),
        "config_sha256": config_sha256,
        "score_path": str(args.score),
        "returns_path": str(args.returns),
        "membership_path": str(membership_path),
        "counts": {
            "base_factors": len(base_factors),
            "candidates": len(candidates),
            "score_rows_loaded": scores.height,
            "return_rows_loaded": returns.height,
            "membership_rows": membership.height,
            "monthly_rows": monthly.height,
            "finite_monthly_rows": finite_monthly.height,
            "selection_rows": nested.height,
            "evaluated_outer_test_rows": evaluated.height,
            "folds_with_selection": nested["fold"].n_unique() if not nested.is_empty() else 0,
        },
        "methodology": {
            "candidate_generation": "仅使用配置中的结构化白名单操作；不执行任意表达式文本",
            "common_sample": "每个表达式只在两个输入分数与远期收益均有效的股票共同样本上计算RankIC",
            "timing": "按真实return_date切分；选择只使用决策日已经实现的收益",
            "selection": "发现期HAC显著性经BH-FDR校正，内层验证要求均值与符号一致，再扣复杂度惩罚",
            "outer_test": "候选选定后的未来测试期只用于报告，不参与选择",
        },
        "limitations": [
            "结果只是研究候选，不会自动登记为正式因子",
            "还需经济含义、数据可得时点、稳健性、交易成本和独立复算复核",
            "更换基础因子、操作白名单或股票池属于新的假设族，必须重新执行FDR与嵌套样本外检验",
        ],
    }
    _write_json_atomic(metadata, out_dir / "run_meta.json")
    return metadata


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config/expression_mining_hs300_v1.json")
    parser.add_argument("--score", default="data/factor_score.parquet")
    parser.add_argument("--returns", default="frontend/data/monthly_return.parquet")
    parser.add_argument(
        "--membership",
        default="frontend/data/stock_pool_research/membership/HS300.parquet",
    )
    parser.add_argument("--as-of", default=None, help="仅使用不晚于该日期实现的收益，YYYY-MM-DD")
    parser.add_argument("--out-dir", default="data/research/expression_mining_hs300_v1")
    return parser.parse_args()


if __name__ == "__main__":
    result = run(parse_args())
    print(json.dumps(result, ensure_ascii=False, indent=2))
