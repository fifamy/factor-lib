"""受控因子表达式候选与嵌套样本外检验。

本模块只接受结构化白名单操作，不解析或执行任意表达式文本。输入 ``score``
应已完成截面标准化和方向统一，高分代表预期更优。候选筛选只使用决策日前
已经实现的 ``return_date``；外层测试期不参与候选选择。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from itertools import combinations, permutations
import math
import re
from typing import Iterable, Mapping, Sequence

import numpy as np
import polars as pl

from factor_lib.monthly_returns import valid_forward_return_expr
from factor_lib.validation import (
    benjamini_hochberg_q_values,
    newey_west_t_stat,
    two_sided_t_p_value,
)


ALLOWED_OPERATIONS = frozenset({"mean", "minimum", "maximum", "spread"})
COMMUTATIVE_OPERATIONS = frozenset({"mean", "minimum", "maximum"})
OPERATION_COMPLEXITY = {
    "mean": 1,
    "minimum": 2,
    "maximum": 2,
    "spread": 2,
}
_FACTOR_CODE_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")


@dataclass(frozen=True)
class ExpressionCandidate:
    """一个不含可执行文本的二元表达式候选。"""

    code: str
    operation: str
    inputs: tuple[str, str]
    complexity: int

    def as_dict(self) -> dict[str, object]:
        return {
            "candidate_code": self.code,
            "operation": self.operation,
            "left_factor": self.inputs[0],
            "right_factor": self.inputs[1],
            "complexity": self.complexity,
        }


def _validated_factor_codes(base_factors: Iterable[str], max_base_factors: int) -> list[str]:
    codes = list(base_factors)
    if not codes:
        raise ValueError("base_factors cannot be empty")
    if len(codes) != len(set(codes)):
        raise ValueError("base_factors must be unique")
    if len(codes) > int(max_base_factors):
        raise ValueError(
            f"base_factors exceeds max_base_factors: {len(codes)} > {int(max_base_factors)}"
        )
    invalid = [code for code in codes if not _FACTOR_CODE_RE.fullmatch(str(code))]
    if invalid:
        raise ValueError(f"invalid factor codes: {invalid}")
    return sorted(str(code) for code in codes)


def generate_candidates(
    base_factors: Iterable[str],
    operations: Iterable[str],
    *,
    max_base_factors: int = 12,
    max_candidates: int = 500,
) -> list[ExpressionCandidate]:
    """按固定白名单生成确定性的候选集合，超限时直接失败而非静默截断。"""

    codes = _validated_factor_codes(base_factors, max_base_factors)
    operation_list = list(operations)
    if not operation_list:
        raise ValueError("operations cannot be empty")
    if len(operation_list) != len(set(operation_list)):
        raise ValueError("operations must be unique")
    unsupported = sorted(set(operation_list) - ALLOWED_OPERATIONS)
    if unsupported:
        raise ValueError(f"unsupported operations: {unsupported}")

    candidates: list[ExpressionCandidate] = []
    for operation in operation_list:
        pairs = (
            combinations(codes, 2)
            if operation in COMMUTATIVE_OPERATIONS
            else permutations(codes, 2)
        )
        for left, right in pairs:
            candidates.append(
                ExpressionCandidate(
                    code=f"EXPR__{operation.upper()}__{left}__{right}",
                    operation=operation,
                    inputs=(left, right),
                    complexity=OPERATION_COMPLEXITY[operation],
                )
            )

    if len(candidates) > int(max_candidates):
        raise ValueError(
            f"candidate count exceeds max_candidates: {len(candidates)} > {int(max_candidates)}"
        )
    return candidates


def _assert_columns(frame: pl.DataFrame, required: set[str], label: str) -> None:
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"{label} missing columns: {missing}")


def _assert_unique(frame: pl.DataFrame, keys: list[str], label: str) -> None:
    if frame.is_empty():
        return
    unique_count = int(frame.select(pl.struct(keys).n_unique()).item())
    if unique_count != frame.height:
        raise ValueError(f"{label} must be unique by {keys}")


def _expression(candidate: ExpressionCandidate) -> pl.Expr:
    left = pl.col(candidate.inputs[0])
    right = pl.col(candidate.inputs[1])
    if candidate.operation == "mean":
        return (left + right) / 2.0
    if candidate.operation == "minimum":
        return pl.min_horizontal(left, right)
    if candidate.operation == "maximum":
        return pl.max_horizontal(left, right)
    if candidate.operation == "spread":
        return left - right
    raise ValueError(f"unsupported operation: {candidate.operation}")


def candidate_monthly_rank_ic(
    scores: pl.DataFrame,
    returns: pl.DataFrame,
    candidates: Sequence[ExpressionCandidate],
    *,
    membership: pl.DataFrame | None = None,
    min_cross_section: int = 30,
) -> pl.DataFrame:
    """在候选各自的共同有效截面上计算月度RankIC。

    ``membership``可使用正式股票池分片格式（``signal_date``、``stock_code``）。
    每个候选在排序前先剔除任一输入缺失的股票，避免用更大样本的收益秩污染
    Spearman相关。
    """

    if int(min_cross_section) < 3:
        raise ValueError("min_cross_section must be at least 3")
    _assert_columns(
        scores,
        {"trade_date", "stock_code", "factor_code", "score"},
        "scores",
    )
    _assert_columns(
        returns,
        {"trade_date", "return_date", "stock_code", "fwd_return"},
        "returns",
    )
    _assert_unique(scores, ["trade_date", "stock_code", "factor_code"], "scores")
    _assert_unique(returns, ["trade_date", "stock_code"], "returns")

    if not candidates:
        return pl.DataFrame(
            schema={
                "signal_date": pl.Date,
                "return_date": pl.Date,
                "candidate_code": pl.Utf8,
                "n_stocks": pl.UInt32,
                "rank_ic": pl.Float64,
            }
        )

    candidate_codes = [candidate.code for candidate in candidates]
    if len(candidate_codes) != len(set(candidate_codes)):
        raise ValueError("candidate codes must be unique")
    required_factors = sorted({code for candidate in candidates for code in candidate.inputs})
    selected = (
        scores.filter(pl.col("factor_code").is_in(required_factors))
        .select(["trade_date", "stock_code", "factor_code", "score"])
        .filter(pl.col("score").is_not_null() & pl.col("score").is_finite())
    )
    present = set(selected["factor_code"].unique().to_list()) if not selected.is_empty() else set()
    missing_factors = sorted(set(required_factors) - present)
    if missing_factors:
        raise ValueError(f"scores missing requested factors: {missing_factors}")

    if membership is not None:
        _assert_columns(membership, {"signal_date", "stock_code"}, "membership")
        member_keys = membership.select(
            [pl.col("signal_date").alias("trade_date"), "stock_code"]
        )
        _assert_unique(member_keys, ["trade_date", "stock_code"], "membership")
        selected = selected.join(member_keys, on=["trade_date", "stock_code"], how="inner")

    completed_returns = (
        returns.filter(
            pl.col("return_date").is_not_null()
            & valid_forward_return_expr("fwd_return")
        )
        .select(["trade_date", "return_date", "stock_code", "fwd_return"])
    )
    invalid_timing = completed_returns.filter(pl.col("return_date") <= pl.col("trade_date"))
    if not invalid_timing.is_empty():
        raise ValueError("completed returns must have return_date after trade_date")
    schedule_conflicts = (
        completed_returns.group_by("trade_date")
        .agg(pl.col("return_date").n_unique().alias("n_return_dates"))
        .filter(pl.col("n_return_dates") != 1)
    )
    if not schedule_conflicts.is_empty():
        raise ValueError("each trade_date must map to exactly one return_date")

    wide = selected.pivot(
        values="score",
        index=["trade_date", "stock_code"],
        on="factor_code",
        aggregate_function=None,
    )
    panel = wide.join(completed_returns, on=["trade_date", "stock_code"], how="inner")
    frames: list[pl.DataFrame] = []
    for candidate in candidates:
        value_column = "_expression_value"
        left = pl.col(candidate.inputs[0])
        right = pl.col(candidate.inputs[1])
        common = (
            panel.filter(
                left.is_not_null()
                & left.is_finite()
                & right.is_not_null()
                & right.is_finite()
            )
            .with_columns(_expression(candidate).alias(value_column))
            .filter(pl.col(value_column).is_finite() & pl.col("fwd_return").is_finite())
        )
        if common.is_empty():
            continue
        monthly = (
            common.group_by("trade_date")
            .agg([
                pl.col("return_date").first(),
                pl.len().cast(pl.UInt32).alias("n_stocks"),
                pl.corr(
                    pl.col(value_column).rank("average"),
                    pl.col("fwd_return").rank("average"),
                ).alias("rank_ic"),
            ])
            .with_columns([
                pl.lit(candidate.code).alias("candidate_code"),
                pl.when(
                    (pl.col("n_stocks") >= int(min_cross_section))
                    & pl.col("rank_ic").is_finite()
                )
                .then(pl.col("rank_ic"))
                .otherwise(None)
                .alias("rank_ic"),
            ])
            .rename({"trade_date": "signal_date"})
            .select(["signal_date", "return_date", "candidate_code", "n_stocks", "rank_ic"])
        )
        frames.append(monthly)

    if not frames:
        return candidate_monthly_rank_ic(
            scores.head(0),
            returns.head(0),
            [],
            min_cross_section=min_cross_section,
        )
    return pl.concat(frames, how="vertical").sort(["candidate_code", "signal_date"])


def _finite_values_by_dates(
    rows: Sequence[Mapping[str, object]],
    allowed_dates: set[date],
) -> list[float]:
    values: list[float] = []
    for row in rows:
        if row["return_date"] not in allowed_dates:
            continue
        value = row.get("rank_ic")
        if value is None:
            continue
        numeric = float(value)
        if math.isfinite(numeric):
            values.append(numeric)
    return values


def _mean(values: Sequence[float]) -> float | None:
    return float(np.mean(values)) if values else None


def _positive_rate(values: Sequence[float]) -> float | None:
    return float(np.mean(np.asarray(values) > 0)) if values else None


def _empty_nested_frame() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            "fold": pl.Int32,
            "decision_date": pl.Date,
            "discovery_start_date": pl.Date,
            "discovery_end_date": pl.Date,
            "validation_start_date": pl.Date,
            "validation_end_date": pl.Date,
            "test_start_date": pl.Date,
            "test_end_date": pl.Date,
            "selection_rank": pl.Int32,
            "candidate_code": pl.Utf8,
            "operation": pl.Utf8,
            "left_factor": pl.Utf8,
            "right_factor": pl.Utf8,
            "complexity": pl.Int32,
            "discovery_n_months": pl.Int32,
            "discovery_rank_ic_mean": pl.Float64,
            "discovery_p_value": pl.Float64,
            "discovery_q_value": pl.Float64,
            "validation_n_months": pl.Int32,
            "validation_rank_ic_mean": pl.Float64,
            "validation_positive_rate": pl.Float64,
            "penalized_score": pl.Float64,
            "outer_test_n_months": pl.Int32,
            "outer_test_rank_ic_mean": pl.Float64,
            "outer_test_positive_rate": pl.Float64,
            "outer_test_status": pl.Utf8,
        }
    )


def nested_walk_forward_select(
    monthly: pl.DataFrame,
    candidates: Sequence[ExpressionCandidate],
    *,
    min_outer_train_months: int = 60,
    inner_validation_months: int = 12,
    test_months: int = 12,
    step_months: int = 12,
    min_discovery_months: int = 36,
    min_validation_months: int = 9,
    min_test_months: int = 6,
    fdr_alpha: float = 0.10,
    min_validation_positive_rate: float = 0.50,
    complexity_penalty: float = 0.001,
    top_k: int = 3,
) -> pl.DataFrame:
    """用发现期+内层验证期选参，并只在随后外层测试期报告结果。"""

    _assert_columns(
        monthly,
        {"signal_date", "return_date", "candidate_code", "rank_ic"},
        "monthly",
    )
    _assert_unique(monthly, ["candidate_code", "signal_date"], "monthly")
    if any(
        int(value) <= 0
        for value in [
            min_outer_train_months,
            inner_validation_months,
            test_months,
            step_months,
            min_discovery_months,
            min_validation_months,
            min_test_months,
            top_k,
        ]
    ):
        raise ValueError("month counts, step_months and top_k must be positive")
    if int(min_outer_train_months) <= int(inner_validation_months):
        raise ValueError("min_outer_train_months must exceed inner_validation_months")
    if not 0.0 < float(fdr_alpha) <= 1.0:
        raise ValueError("fdr_alpha must be in (0, 1]")
    if not 0.0 <= float(min_validation_positive_rate) <= 1.0:
        raise ValueError("min_validation_positive_rate must be in [0, 1]")
    if float(complexity_penalty) < 0.0:
        raise ValueError("complexity_penalty cannot be negative")

    candidate_map = {candidate.code: candidate for candidate in candidates}
    if len(candidate_map) != len(candidates):
        raise ValueError("candidate codes must be unique")
    unknown = sorted(set(monthly["candidate_code"].unique().to_list()) - set(candidate_map))
    if unknown:
        raise ValueError(f"monthly contains unknown candidates: {unknown}")
    invalid_timing = monthly.filter(pl.col("return_date") <= pl.col("signal_date"))
    if not invalid_timing.is_empty():
        raise ValueError("monthly return_date must be after signal_date")

    return_dates = sorted(
        value for value in monthly["return_date"].drop_nulls().unique().to_list()
    )
    if len(return_dates) < int(min_outer_train_months) + int(test_months):
        return _empty_nested_frame()

    rows_by_candidate = {
        code: group.sort("return_date").to_dicts()
        for (code,), group in monthly.partition_by("candidate_code", as_dict=True).items()
    }
    output: list[dict[str, object]] = []
    fold = 0
    train_end_index = int(min_outer_train_months) - 1
    while train_end_index + int(test_months) < len(return_dates):
        train_dates = return_dates[: train_end_index + 1]
        discovery_dates = train_dates[: -int(inner_validation_months)]
        validation_dates = train_dates[-int(inner_validation_months) :]
        test_dates_slice = return_dates[
            train_end_index + 1 : train_end_index + 1 + int(test_months)
        ]
        if len(discovery_dates) < int(min_discovery_months):
            train_end_index += int(step_months)
            continue
        fold += 1
        discovery_set = set(discovery_dates)
        validation_set = set(validation_dates)
        test_set = set(test_dates_slice)

        candidate_stats: list[dict[str, object]] = []
        p_values: list[float | None] = []
        for candidate in candidates:
            source_rows = rows_by_candidate.get(candidate.code, [])
            discovery_values = _finite_values_by_dates(source_rows, discovery_set)
            validation_values = _finite_values_by_dates(source_rows, validation_set)
            t_stat = newey_west_t_stat(discovery_values)
            p_value = two_sided_t_p_value(t_stat, len(discovery_values) - 1)
            p_values.append(p_value)
            candidate_stats.append(
                {
                    "candidate": candidate,
                    "discovery_values": discovery_values,
                    "validation_values": validation_values,
                    "discovery_p_value": p_value,
                }
            )

        q_values = benjamini_hochberg_q_values(p_values)
        eligible: list[dict[str, object]] = []
        for stats, q_value in zip(candidate_stats, q_values):
            discovery_values = stats["discovery_values"]
            validation_values = stats["validation_values"]
            discovery_mean = _mean(discovery_values)
            validation_mean = _mean(validation_values)
            validation_positive_rate = _positive_rate(validation_values)
            candidate = stats["candidate"]
            if not (
                len(discovery_values) >= int(min_discovery_months)
                and discovery_mean is not None
                and discovery_mean > 0.0
                and q_value is not None
                and q_value <= float(fdr_alpha)
                and len(validation_values) >= int(min_validation_months)
                and validation_mean is not None
                and validation_mean > 0.0
                and validation_positive_rate is not None
                and validation_positive_rate >= float(min_validation_positive_rate)
            ):
                continue
            eligible.append(
                {
                    **stats,
                    "discovery_mean": discovery_mean,
                    "discovery_q_value": q_value,
                    "validation_mean": validation_mean,
                    "validation_positive_rate": validation_positive_rate,
                    "penalized_score": (
                        validation_mean
                        - float(complexity_penalty) * int(candidate.complexity)
                    ),
                }
            )

        eligible.sort(
            key=lambda item: (
                -float(item["penalized_score"]),
                float(item["discovery_q_value"]),
                item["candidate"].code,
            )
        )
        for selection_rank, stats in enumerate(eligible[: int(top_k)], start=1):
            candidate = stats["candidate"]
            test_values = _finite_values_by_dates(
                rows_by_candidate.get(candidate.code, []), test_set
            )
            test_status = (
                "evaluated"
                if len(test_values) >= int(min_test_months)
                else "insufficient_test_months"
            )
            output.append(
                {
                    "fold": fold,
                    "decision_date": train_dates[-1],
                    "discovery_start_date": discovery_dates[0],
                    "discovery_end_date": discovery_dates[-1],
                    "validation_start_date": validation_dates[0],
                    "validation_end_date": validation_dates[-1],
                    "test_start_date": test_dates_slice[0],
                    "test_end_date": test_dates_slice[-1],
                    "selection_rank": selection_rank,
                    **candidate.as_dict(),
                    "discovery_n_months": len(stats["discovery_values"]),
                    "discovery_rank_ic_mean": stats["discovery_mean"],
                    "discovery_p_value": stats["discovery_p_value"],
                    "discovery_q_value": stats["discovery_q_value"],
                    "validation_n_months": len(stats["validation_values"]),
                    "validation_rank_ic_mean": stats["validation_mean"],
                    "validation_positive_rate": stats["validation_positive_rate"],
                    "penalized_score": stats["penalized_score"],
                    "outer_test_n_months": len(test_values),
                    "outer_test_rank_ic_mean": _mean(test_values),
                    "outer_test_positive_rate": _positive_rate(test_values),
                    "outer_test_status": test_status,
                }
            )
        train_end_index += int(step_months)

    if not output:
        return _empty_nested_frame()
    return pl.DataFrame(output).select(_empty_nested_frame().columns)
