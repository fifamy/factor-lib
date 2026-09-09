from __future__ import annotations

import json
from pathlib import Path

import polars as pl

from scripts.build_factor_correlation_hints import build_payload


def _write_matrix(path: Path, values: list[tuple[str, str, float]]) -> None:
    pl.DataFrame(
        {
            "factor_a": [row[0] for row in values],
            "factor_b": [row[1] for row in values],
            "corr": [row[2] for row in values],
            "n_obs": [500] * len(values),
            "n_months": [120] * len(values),
        }
    ).write_parquet(path)


def test_build_payload_creates_stable_transitive_clusters(tmp_path: Path):
    raw = tmp_path / "factor_corr.parquet"
    neutral = tmp_path / "factor_corr_neutral.parquet"
    _write_matrix(
        raw,
        [
            ("A", "B", 0.95),
            ("B", "A", 0.95),
            ("B", "C", -0.92),
            ("C", "B", -0.92),
            ("A", "C", 0.20),
            ("D", "E", 0.89),
        ],
    )
    _write_matrix(neutral, [("A", "B", 0.91), ("B", "A", 0.91)])

    payload = build_payload(raw, neutral, 0.9)

    assert payload["threshold_abs_corr"] == 0.9
    assert payload["modes"]["raw"]["pair_count"] == 2
    assert payload["modes"]["raw"]["clusters"] == [
        {"cluster_id": "R01", "members": ["A", "B", "C"]}
    ]
    assert payload["modes"]["raw"]["by_factor"]["B"]["peers"] == [
        {"code": "A", "corr": 0.95, "n_obs": 500, "n_months": 120},
        {"code": "C", "corr": -0.92, "n_obs": 500, "n_months": 120},
    ]
    assert "D" not in payload["modes"]["raw"]["by_factor"]
    json.dumps(payload, ensure_ascii=False)


def test_published_hint_asset_discloses_amount20_mflow20_pair():
    root = Path(__file__).parents[1]
    frontend_root = root / "frontend" if (root / "frontend").is_dir() else root
    path = frontend_root / "data/factor_correlation_hints.json"
    payload = json.loads(path.read_text(encoding="utf-8"))

    for mode in ["raw", "neutral"]:
        hint = payload["modes"][mode]["by_factor"]["AMOUNT20"]
        pair = next(row for row in hint["peers"] if row["code"] == "MFLOW20")
        assert pair["corr"] > 0.999
        assert pair["n_months"] == 139
    assert "不会自动剔除" in payload["interpretation"]
