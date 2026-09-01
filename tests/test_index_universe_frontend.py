from __future__ import annotations

import json
import subprocess
from datetime import date
from pathlib import Path

import polars as pl


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" if (ROOT / "frontend").exists() else ROOT
HELPER = FRONTEND / "app_index_universe.js"


def run_helper(body: str) -> dict:
    script = f"""
const h = require({json.dumps(str(HELPER))});
{body}
"""
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_index_only_uses_point_in_time_members_and_preserves_ties():
    payload = run_helper("""
const rows = [
  {stock_code:'A', cs:3, index_available:true, is_index_member:false},
  {stock_code:'B', cs:2, index_available:true, is_index_member:true},
  {stock_code:'C', cs:1, index_available:true, is_index_member:true},
  {stock_code:'D', cs:1, index_available:true, is_index_member:true},
];
console.log(JSON.stringify(h.selectRowsByIndexUniverse(
  rows, 2, {mode:'index_only', indexAlias:'HS300', minShare:.8}
)));
""")

    assert [row["stock_code"] for row in payload["rows"]] == ["B", "C", "D"]
    assert payload["stats"]["index_member_share"] == 1
    assert payload["stats"]["requirement_met"] is True


def test_minimum_index_share_reserves_required_member_slots_by_holding_count():
    payload = run_helper("""
const rows = [
  {stock_code:'N1', cs:10, index_available:true, is_index_member:false},
  {stock_code:'N2', cs:9, index_available:true, is_index_member:false},
  {stock_code:'M1', cs:8, index_available:true, is_index_member:true},
  {stock_code:'M2', cs:7, index_available:true, is_index_member:true},
  {stock_code:'M3', cs:6, index_available:true, is_index_member:true},
  {stock_code:'M4', cs:5, index_available:true, is_index_member:true},
  {stock_code:'M5', cs:4, index_available:true, is_index_member:true},
];
console.log(JSON.stringify(h.selectRowsByIndexUniverse(
  rows, 5, {mode:'min_share', indexAlias:'CSI800', minShare:.8}
)));
""")

    assert len(payload["rows"]) == 5
    assert payload["stats"]["required_index_member_n"] == 4
    assert payload["stats"]["index_member_n"] == 4
    assert payload["stats"]["index_member_share"] == 0.8
    assert payload["stats"]["requirement_met"] is True


def test_prelaunch_a500_period_fails_closed_instead_of_using_full_market():
    payload = run_helper("""
const rows = [
  {stock_code:'A', cs:2, index_available:false, is_index_member:false},
  {stock_code:'B', cs:1, index_available:false, is_index_member:false},
];
console.log(JSON.stringify(h.selectRowsByIndexUniverse(
  rows, 1, {mode:'index_only', indexAlias:'CSIA500', minShare:.8}
)));
""")

    assert payload["rows"] == []
    assert payload["stats"]["index_available"] is False
    assert payload["stats"]["requirement_met"] is False


def test_frontend_contract_exposes_six_indices_and_persists_universe_config():
    helper = HELPER.read_text(encoding="utf-8")
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")

    for alias in ["HS300", "CSI500", "CSI800", "CSI1000", "CSI2000", "CSIA500"]:
        assert alias in helper
    assert "2023-08-14" in helper
    assert "2024-09-24" in helper
    assert "index_weight_monthly.parquet" in app
    assert "cps-universe-mode" in app
    assert "universe: normalizeIndexUniverseConfig" in app
    assert "options.universe || null" in app
    assert "optimizerAvailabilityJoin" in app
    assert "optimizerWeightJoin" in app
    assert app.count("ORDER BY comp_score DESC, m.stock_code") >= 2
    assert "app_index_universe.js" in index


def test_monthly_index_weights_keep_independent_index_histories():
    path = FRONTEND / "data" / "index_weight_monthly.parquet"
    assert path.exists()
    coverage = (
        pl.scan_parquet(path)
        .group_by("index_alias")
        .agg(
            pl.col("signal_date").min().alias("first_signal_date"),
            pl.col("signal_date").n_unique().alias("signal_count"),
        )
        .collect()
    )
    rows = {row["index_alias"]: row for row in coverage.iter_rows(named=True)}

    assert rows["HS300"]["first_signal_date"] == date(2015, 1, 30)
    assert rows["CSI1000"]["signal_count"] == 139
    assert rows["CSI2000"]["first_signal_date"] == date(2023, 8, 31)
    assert rows["CSI2000"]["signal_count"] == 36
    assert rows["CSIA500"]["first_signal_date"] == date(2024, 9, 30)
    assert rows["CSIA500"]["signal_count"] == 23
