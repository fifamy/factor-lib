#!/usr/bin/env python3
"""从既有全样本相关矩阵生成排行榜使用的轻量相关簇提示。"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import polars as pl


REQUIRED_COLUMNS = {"factor_a", "factor_b", "corr", "n_obs", "n_months"}


class _DisjointSet:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        if self.parent[item] != item:
            self.parent[item] = self.find(self.parent[item])
        return self.parent[item]

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def _mode_payload(path: Path, threshold: float, prefix: str) -> dict[str, Any]:
    frame = pl.read_parquet(path)
    missing = sorted(REQUIRED_COLUMNS - set(frame.columns))
    if missing:
        raise ValueError(f"{path} missing columns: {missing}")
    pairs = (
        frame.filter(
            (pl.col("factor_a") < pl.col("factor_b"))
            & pl.col("corr").is_finite()
            & (pl.col("corr").abs() >= threshold)
        )
        .select(["factor_a", "factor_b", "corr", "n_obs", "n_months"])
        .sort(
            [pl.col("corr").abs(), "factor_a", "factor_b"],
            descending=[True, False, False],
        )
    )

    disjoint = _DisjointSet()
    pair_rows = pairs.to_dicts()
    for row in pair_rows:
        disjoint.union(str(row["factor_a"]), str(row["factor_b"]))

    components: dict[str, list[str]] = {}
    for factor in sorted(disjoint.parent):
        components.setdefault(disjoint.find(factor), []).append(factor)
    ordered_components = sorted(
        (sorted(members) for members in components.values() if len(members) >= 2),
        key=lambda members: (-len(members), members),
    )
    cluster_by_factor: dict[str, tuple[str, list[str]]] = {}
    clusters = []
    for index, members in enumerate(ordered_components, start=1):
        cluster_id = f"{prefix}{index:02d}"
        clusters.append({"cluster_id": cluster_id, "members": members})
        for factor in members:
            cluster_by_factor[factor] = (cluster_id, members)

    peers: dict[str, list[dict[str, Any]]] = {}
    for row in pair_rows:
        left = str(row["factor_a"])
        right = str(row["factor_b"])
        corr = float(row["corr"])
        if not math.isfinite(corr):
            continue
        common = {
            "corr": round(corr, 6),
            "n_obs": int(row["n_obs"]),
            "n_months": int(row["n_months"]),
        }
        peers.setdefault(left, []).append({"code": right, **common})
        peers.setdefault(right, []).append({"code": left, **common})

    by_factor = {}
    for factor, direct_peers in peers.items():
        direct_peers.sort(key=lambda row: (-abs(row["corr"]), row["code"]))
        cluster_id, members = cluster_by_factor[factor]
        by_factor[factor] = {
            "cluster_id": cluster_id,
            "cluster_members": members,
            "peers": direct_peers,
        }
    return {
        "source": f"data/{path.name}",
        "pair_count": len(pair_rows),
        "cluster_count": len(clusters),
        "clusters": clusters,
        "by_factor": dict(sorted(by_factor.items())),
    }


def build_payload(raw_path: Path, neutral_path: Path, threshold: float) -> dict[str, Any]:
    if not 0 < threshold <= 1:
        raise ValueError("threshold must be in (0, 1]")
    return {
        "schema_version": 1,
        "threshold_abs_corr": threshold,
        "scope": "全样本月末横截面得分相关性",
        "interpretation": "相关簇仅提示潜在重复暴露，不表示因果关系，也不会自动剔除或改变排行榜得分。",
        "modes": {
            "raw": _mode_payload(raw_path, threshold, "R"),
            "neutral": _mode_payload(neutral_path, threshold, "N"),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", default="frontend/data/factor_corr.parquet")
    parser.add_argument("--neutral", default="frontend/data/factor_corr_neutral.parquet")
    parser.add_argument("--threshold", type=float, default=0.9)
    parser.add_argument("--out", default="frontend/data/factor_correlation_hints.json")
    args = parser.parse_args()

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = build_payload(Path(args.raw), Path(args.neutral), args.threshold)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temporary.replace(output)
    print(
        json.dumps(
            {
                "output": str(output),
                "threshold_abs_corr": args.threshold,
                "raw_pairs": payload["modes"]["raw"]["pair_count"],
                "neutral_pairs": payload["modes"]["neutral"]["pair_count"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
