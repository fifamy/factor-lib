from __future__ import annotations

from datetime import date
import json
from pathlib import Path

import polars as pl
import pytest

from factor_lib.expression_mining import (
    ExpressionCandidate,
    candidate_monthly_rank_ic,
    generate_candidates,
    nested_walk_forward_select,
)


def test_candidate_generation_is_structured_deterministic_and_capped():
    candidates = generate_candidates(
        ["B", "A", "C"],
        ["mean", "spread"],
        max_candidates=20,
    )

    assert len(candidates) == 9
    assert candidates[0] == ExpressionCandidate(
        code="EXPR__MEAN__A__B",
        operation="mean",
        inputs=("A", "B"),
        complexity=1,
    )
    assert len({candidate.code for candidate in candidates}) == len(candidates)
    with pytest.raises(ValueError, match="unsupported operations"):
        generate_candidates(["A", "B"], ["__import__"])
    with pytest.raises(ValueError, match="exceeds max_candidates"):
        generate_candidates(["A", "B", "C"], ["mean", "spread"], max_candidates=8)
    with pytest.raises(ValueError, match="invalid factor codes"):
        generate_candidates(["A", "B + arbitrary_code()"], ["mean"])


def test_monthly_rank_ic_uses_membership_and_candidate_common_sample():
    signal = date(2025, 1, 31)
    realized = date(2025, 3, 3)
    scores = pl.DataFrame(
        {
            "trade_date": [signal] * 7,
            "stock_code": ["1", "2", "3", "4", "1", "2", "3"],
            "factor_code": ["A"] * 4 + ["B"] * 3,
            "score": [1.0, 2.0, 3.0, 100.0, 1.0, 2.0, 3.0],
        }
    )
    returns = pl.DataFrame(
        {
            "trade_date": [signal] * 4,
            "return_date": [realized] * 4,
            "stock_code": ["1", "2", "3", "4"],
            "fwd_return": [0.01, 0.02, 0.03, -0.50],
        }
    )
    membership = pl.DataFrame(
        {
            "signal_date": [signal] * 4,
            "stock_code": ["1", "2", "3", "4"],
        }
    )
    candidates = generate_candidates(["A", "B"], ["mean", "minimum"])

    got = candidate_monthly_rank_ic(
        scores,
        returns,
        candidates,
        membership=membership,
        min_cross_section=3,
    )

    assert got["n_stocks"].to_list() == [3, 3]
    assert got["rank_ic"].to_list() == pytest.approx([1.0, 1.0])
    assert set(got["signal_date"].to_list()) == {signal}
    assert set(got["return_date"].to_list()) == {realized}


def _candidate(code: str, complexity: int) -> ExpressionCandidate:
    return ExpressionCandidate(
        code=code,
        operation="mean",
        inputs=("A", "B"),
        complexity=complexity,
    )


def _monthly_rows(test_override: dict[str, list[float]] | None = None) -> pl.DataFrame:
    returns = [date(2020 + index // 12, index % 12 + 1, 28) for index in range(10)]
    series = {
        "SIMPLE": [0.03, 0.05, 0.04, 0.06, 0.035, 0.045, 0.050, 0.040, 0.020, 0.030],
        "COMPLEX": [0.04, 0.05, 0.045, 0.055, 0.040, 0.050, 0.052, 0.050, 0.90, 0.80],
        "NEGATIVE": [-0.03, -0.04, -0.05, -0.02, -0.04, -0.03, -0.02, -0.01, 0.50, 0.50],
    }
    for code, values in (test_override or {}).items():
        series[code][-2:] = values
    rows = []
    for code, values in series.items():
        for index, (return_date, value) in enumerate(zip(returns, values)):
            signal_month = return_date.month - 1 or 12
            signal_year = return_date.year if return_date.month > 1 else return_date.year - 1
            rows.append(
                {
                    "signal_date": date(signal_year, signal_month, 20),
                    "return_date": return_date,
                    "candidate_code": code,
                    "n_stocks": 300,
                    "rank_ic": value,
                }
            )
    return pl.DataFrame(rows)


def _nested(monthly: pl.DataFrame) -> pl.DataFrame:
    candidates = [
        _candidate("SIMPLE", 1),
        _candidate("COMPLEX", 3),
        _candidate("NEGATIVE", 1),
    ]
    return nested_walk_forward_select(
        monthly,
        candidates,
        min_outer_train_months=8,
        inner_validation_months=2,
        test_months=2,
        step_months=2,
        min_discovery_months=4,
        min_validation_months=2,
        min_test_months=2,
        fdr_alpha=1.0,
        min_validation_positive_rate=0.5,
        complexity_penalty=0.004,
        top_k=1,
    )


def test_nested_selection_penalizes_complexity_and_excludes_negative_sign():
    got = _nested(_monthly_rows())

    assert got.height == 1
    row = got.row(0, named=True)
    assert row["candidate_code"] == "SIMPLE"
    assert row["decision_date"] < row["test_start_date"]
    assert row["validation_end_date"] == row["decision_date"]
    assert row["outer_test_status"] == "evaluated"
    assert row["discovery_q_value"] <= 1.0


def test_outer_test_values_cannot_change_candidate_selection():
    original = _nested(_monthly_rows())
    mutated = _nested(
        _monthly_rows(
            {
                "SIMPLE": [-0.99, -0.98],
                "COMPLEX": [0.99, 0.98],
                "NEGATIVE": [0.99, 0.98],
            }
        )
    )

    selection_columns = [
        "candidate_code",
        "decision_date",
        "discovery_rank_ic_mean",
        "discovery_q_value",
        "validation_rank_ic_mean",
        "penalized_score",
    ]
    assert original.select(selection_columns).to_dicts() == mutated.select(selection_columns).to_dicts()
    assert (
        original["outer_test_rank_ic_mean"].item()
        != mutated["outer_test_rank_ic_mean"].item()
    )


def test_duplicate_score_keys_and_invalid_return_timing_fail_closed():
    signal = date(2025, 1, 31)
    scores = pl.DataFrame(
        {
            "trade_date": [signal, signal, signal],
            "stock_code": ["1", "1", "1"],
            "factor_code": ["A", "A", "B"],
            "score": [1.0, 2.0, 1.0],
        }
    )
    returns = pl.DataFrame(
        {
            "trade_date": [signal],
            "return_date": [signal],
            "stock_code": ["1"],
            "fwd_return": [0.01],
        }
    )
    candidate = generate_candidates(["A", "B"], ["mean"])[0]

    with pytest.raises(ValueError, match="scores must be unique"):
        candidate_monthly_rank_ic(scores, returns, [candidate], min_cross_section=3)

    unique_scores = scores.unique(subset=["trade_date", "stock_code", "factor_code"])
    with pytest.raises(ValueError, match="return_date after trade_date"):
        candidate_monthly_rank_ic(unique_scores, returns, [candidate], min_cross_section=3)


def test_read_only_research_summary_is_synced_for_local_preview():
    root = Path(__file__).parents[1]
    research_path = root / "data/research/expression_mining_hs300_v1/summary.json"
    frontend_root = root / "frontend" if (root / "frontend").is_dir() else root
    frontend_path = frontend_root / "data/expression_mining/HS300/summary.json"
    if not research_path.is_file():
        pytest.skip("Pages精简包不包含源码侧研究目录")
    research = json.loads(research_path.read_text(encoding="utf-8"))
    frontend = json.loads(frontend_path.read_text(encoding="utf-8"))

    assert frontend == research
    assert research["status"] == "research_candidates_only"
    assert research["production_registration"] is False
    assert research["counts"]["candidates"] == 75
    assert research["counts"]["folds_with_selection"] == 6
    assert len(research["selections"]) == 18
    assert len(research["promotion_gates"]) == 5
    assert {gate["status"] for gate in research["promotion_gates"]} == {"not_evaluated"}


def test_expression_research_has_read_only_frontend_entry():
    root = Path(__file__).parents[1]
    frontend_root = root / "frontend" if (root / "frontend").is_dir() else root
    index = (frontend_root / "index.html").read_text(encoding="utf-8")
    app = (frontend_root / "app.js").read_text(encoding="utf-8")
    module = (frontend_root / "app_expression_research.js").read_text(encoding="utf-8")

    assert 'data-mode="expression"' in index
    assert 'id="expression-view"' in index
    assert "ensureExpressionResearchController().render()" in app
    assert "production_registration !== false" in module
    assert "不提供“加入因子库”或“加入组合”操作" in module
    assert "gate.status === \"passed\"" in module
    assert "GATE_STATUS[gate.status]" in module
    assert "未知的晋级门槛状态" in module
