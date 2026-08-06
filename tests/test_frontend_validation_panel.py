from pathlib import Path
import json
import math
import subprocess

import pytest

from factor_lib.validation import summarize_return_series


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ROOT = ROOT / "frontend" if (ROOT / "frontend" / "app.js").exists() else ROOT
APP_JS = FRONTEND_ROOT / "app.js"
APP_HOLDING_SCOPE_JS = FRONTEND_ROOT / "app_holding_scope.js"
STYLES_CSS = FRONTEND_ROOT / "styles.css"
INDEX_HTML = FRONTEND_ROOT / "index.html"
FRONTEND_DATA = FRONTEND_ROOT / "data"


def _skip_without_full_project_docs():
    if not (ROOT / "frontend" / "scripts" / "deploy_to_pages.sh").exists():
        pytest.skip("publish worktree ships only static frontend files")
    if not (ROOT / "docs" / "2026-06-10_标签规则与发布避坑记录.md").exists():
        pytest.skip("publish worktree ships only static frontend files")


def _source_between(source: str, start: str, end: str) -> str:
    start_idx = source.index(start)
    end_idx = source.index(end, start_idx)
    return source[start_idx:end_idx]


def _frontend_compute_metrics(rets: list[float]) -> dict:
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "function computeMetrics(rets, navs)", "function metricsFromReturns")
    script = "\n".join([
        body,
        f"const rets = {json.dumps(rets)};",
        "const navs = [1];",
        "for (const r of rets) navs.push(navs[navs.length - 1] * (1 + r));",
        "console.log(JSON.stringify(computeMetrics(rets, navs)));",
    ])
    result = subprocess.run(["node", "-e", script], check=True, text=True, capture_output=True)
    return json.loads(result.stdout)


def _frontend_eval_json(script_lines: list[str]) -> dict:
    result = subprocess.run(
        ["node", "-e", "\n".join(script_lines)],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def _assert_optional_close(actual, expected, tol=1e-12):
    if expected is None:
        assert actual is None
    else:
        assert actual is not None
        assert math.isclose(float(actual), float(expected), rel_tol=0, abs_tol=tol)


def test_frontend_data_snapshots_keep_factor_tags():
    catalog = json.loads((FRONTEND_DATA / "factor_catalog.json").read_text(encoding="utf-8"))
    ranking = json.loads((FRONTEND_DATA / "factor_ranking_snapshot.json").read_text(encoding="utf-8"))
    factors = ranking.get("factors") or []

    catalog_env = sum(1 for row in catalog if row.get("env_tag") and row.get("env_tag") != "—")
    catalog_time = sum(1 for row in catalog if row.get("time_tag") and row.get("time_tag") != "—")
    ranking_env = sum(1 for row in factors if row.get("env_tag") and row.get("env_tag") != "—")
    ranking_time = sum(1 for row in factors if row.get("time_tag") and row.get("time_tag") != "—")

    assert catalog_env == len(catalog)
    assert catalog_time == len(catalog)
    assert ranking_env == len(factors)
    assert ranking_time == len(factors)


def test_validation_horizon_win_rate_falls_back_to_ic_decay_series():
    source = APP_JS.read_text(encoding="utf-8")

    assert "winRate = clean.length ? clean.filter(v => v > 0).length / clean.length : null" in source
    assert "fromValidation.win !== null ? fromValidation.win : fromDecay.winRate" in source


def test_validation_summary_uses_current_snapshot_field_names():
    source = APP_JS.read_text(encoding="utf-8")

    assert "top30_ann_return" in source
    assert "top30_month_win_rate" in source
    assert "group10_ls_ann_return" in source


def test_validation_panel_renders_rolling_and_segment_tables():
    source = APP_JS.read_text(encoding="utf-8")

    assert "renderRollingValidationTable" in source
    assert "renderSegmentValidationTable" in source
    assert "renderSegmentPortfolioTable" in source
    assert "样本外 / 滚动" in source
    assert "分层 IC" in source
    assert "分层组合收益" in source
    assert "segment_portfolio" in source


def test_compare_fast_table_uses_effective_annualization_for_rank_ic_ir():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "async function renderCmpTableFast()", "function drawCmpTable")

    assert "function effectiveAnnualizationScale" in source
    assert "rankIcStats(" in body
    assert "scoreSnap.ic?.rank_ic" in body
    assert "Math.sqrt(12)" not in body
    assert "scoreSnap.ic?.ic_ir_12m" not in body
    assert "latestIcir" not in body


def test_ranking_fast_path_preserves_month_labels_for_rank_ic_ir():
    source = APP_JS.read_text(encoding="utf-8")
    ranking_body = _source_between(source, "async function computeRankingFast", "async function computeRanking(")
    stats_helpers = _source_between(source, "function monthIdFromLabel", "function memberForwardReturn")
    slice_helpers = _source_between(source, "function labelsByIndexes", "function sliceBacktestByRange")
    ranking = json.loads((FRONTEND_DATA / "factor_ranking_snapshot.json").read_text(encoding="utf-8"))
    sample = next(
        row for row in ranking["factors"]
        if row.get("rank_ic_ir_1m") is not None and abs(float(row["rank_ic_ir_1m"])) > 1e-6
    )

    assert "rankIcStats(labelsByIndexes(months, idxs)" in ranking_body
    assert "rankIcStats(sliceByIndexes(months, idxs)" not in ranking_body

    result = _frontend_eval_json([
        stats_helpers,
        slice_helpers,
        f"const months = {json.dumps(ranking['months'])};",
        f"const values = {json.dumps(sample['rank_ic'])};",
        "const idxs = rangeFilterIndexes(months, months[0], months[months.length - 1]);",
        "const stats = rankIcStats(labelsByIndexes(months, idxs), sliceByIndexes(values, idxs), 1, 1);",
        "console.log(JSON.stringify(stats));",
    ])

    assert result["ir"] is not None
    assert abs(float(result["ir"])) > 1e-6
    assert math.isclose(float(result["ir"]), float(sample["rank_ic_ir_1m"]), rel_tol=0, abs_tol=1e-4)


def test_frontend_compute_metrics_uses_backend_sharpe_definition():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "function computeMetrics(rets, navs)", "function metricsFromReturns")

    assert "const vol = std !== null && Number.isFinite(std) ? std * Math.sqrt(12) : null" in body
    assert "const sharpe = vol !== null && Number.isFinite(vol) && vol > 0 ? annual / vol : null" in body
    assert "mean / std * Math.sqrt(12)" not in body
    assert "annual / vol : 0" not in body


def test_frontend_compute_metrics_matches_backend_validation_for_same_return_series():
    rets = [0.01, -0.02, 0.035, 0.005, -0.01, 0.025]
    frontend = _frontend_compute_metrics(rets)
    backend = summarize_return_series(rets)

    _assert_optional_close(frontend["annual"], backend["ann_return"])
    _assert_optional_close(frontend["vol"], backend["ann_vol"])
    _assert_optional_close(frontend["sharpe"], backend["sharpe"])
    _assert_optional_close(frontend["mdd"], backend["max_drawdown"])
    _assert_optional_close(frontend["winRate"], backend["month_win_rate"])


def test_frontend_compute_metrics_keeps_zero_vol_sharpe_missing_like_backend():
    rets = [0.01, 0.01, 0.01]
    frontend = _frontend_compute_metrics(rets)
    backend = summarize_return_series(rets)

    _assert_optional_close(frontend["annual"], backend["ann_return"])
    _assert_optional_close(frontend["vol"], backend["ann_vol"])
    assert backend["sharpe"] is None
    assert frontend["sharpe"] is None


def test_compare_table_labels_rank_ic_mean_explicitly():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "function drawCmpTable", "async function renderCmpNav")

    assert 'label: "RankIC 均值"' in body
    assert 'label: "IC 均值"' not in body


def test_compare_corr_tooltip_exposes_pairwise_sample_counts():
    source = APP_JS.read_text(encoding="utf-8")
    fallback = _source_between(source, "async function renderCmpCorr()", "async function renderCmpCorrFast()")
    fast = _source_between(source, "async function renderCmpCorrFast()", "function bindModeButtons")

    assert "SELECT factor_a, factor_b, corr, n_obs, n_months FROM factor_corr" in fallback
    assert "p.data[3]" in fallback
    assert "p.data[4]" in fallback
    assert "样本股票-月" in fallback
    assert "样本月份" in fallback
    assert "for (const [a, b, c, nObs, nMonths] of rawCorrSnap.rows || [])" in fast
    assert "for (const [a, b, c, nObs, nMonths] of neutralCorrSnap.rows || [])" in fast
    assert "p.data[3]" in fast
    assert "p.data[4]" in fast


def test_combo_ic_decay_sql_uses_average_ranks_for_ties():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "function composeIcDecaySql", "async function comboIcDecay")

    assert "AVG(score_pos) OVER (PARTITION BY trade_date, h, cs) AS score_rank" in body
    assert "AVG(return_pos) OVER (PARTITION BY trade_date, h, fwd_return) AS return_rank" in body
    assert "rank() OVER (PARTITION BY trade_date, h ORDER BY cs)" not in body
    assert "rank() OVER (PARTITION BY trade_date, h ORDER BY fwd_return)" not in body


def test_combo_ic_decay_sql_uses_calendar_month_self_join_not_physical_lead():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "function composeIcDecaySql", "async function comboIcDecay")

    assert "LEAD(" not in body
    assert "month_id" in body
    assert "month_id + 1" in body
    assert "month_id + 3" in body
    assert "month_id + 6" in body
    assert "month_id + 12" in body
    assert "WHERE m.fwd_return IS NOT NULL" not in body


def test_frontend_ranking_and_combo_validation_keep_missing_forward_returns_in_sample_space():
    source = APP_JS.read_text(encoding="utf-8")
    side_rank = _source_between(source, "async function factorSideRankedRows", "async function factorSideBacktest")
    group_validation = _source_between(source, "async function comboGroupValidation", "function renderComboContributionTable")
    optimizer = _source_between(source, "async function optimizeWeights", "function bindComposeButtons")

    assert "function forwardReturnSql" in source
    assert "WHERE score IS NOT NULL AND fwd_return IS NOT NULL" not in side_rank
    assert "WHERE fwd_return IS NOT NULL" not in group_validation
    assert "WHERE fwd_return IS NOT NULL" not in optimizer
    assert "missing_return_count" in group_validation
    assert "observed_return_count" in group_validation
    assert "GROUP BY trade_date, grp" in group_validation
    assert "GROUP BY trade_date, return_date, grp" not in group_validation
    assert "MAX(return_date)" in group_validation
    assert "HAVING COUNT(*) >= 5" in group_validation
    assert 'SUM(CASE WHEN ${validForwardReturnSql("fwd_return")} THEN 1 ELSE 0 END) > 0' in group_validation


def test_compare_respects_snapshot_capability_and_normalizes_duckdb_bigints():
    source = APP_JS.read_text(encoding="utf-8")
    compare = _source_between(source, "async function renderCompare", "function cmpPairCond")
    corr = _source_between(source, "async function renderCmpCorr()", "async function renderCmpCorrFast()")

    assert "state.dataManifest?.capabilities?.single_snapshots !== false" in compare
    assert "if (fastSnapshotsEnabled)" in compare
    assert "loadSingleSnapshot(code)" in compare
    assert "nObs: snapshotNumber(r.n_obs)" in corr
    assert "nMonths: snapshotNumber(r.n_months)" in corr


def test_compare_fallback_does_not_silently_downgrade_score_constraint_or_side_modes():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "async function renderCompare", "function cmpPairCond")
    fallback_reason = _source_between(source, "function compareFallbackBlockedReason", "async function renderCompare")

    assert "function compareFallbackBlockedReason" in source
    assert "compareFallbackBlockedReason(sel)" in body
    assert "不退回原始口径" in source
    assert "normalizeSide(offender.side)" in fallback_reason
    assert "scoreMode" in source
    assert "constraintMode" in source


def test_rank_ic_stats_from_series_uses_effective_annualization_scale():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "function rankIcStatsFromSeries", "function comboBacktestRowsForMonths")

    assert "effectiveAnnualizationScale" in body
    assert "horizonMonths" in body
    assert "Math.sqrt(12)" not in body


def test_compose_backtest_keeps_missing_returns_and_charges_initial_single_side_cost():
    source = APP_JS.read_text(encoding="utf-8")
    build = _source_between(source, "function buildBacktestFromRows", "function industryNeutralPickRows")
    weighted = _source_between(source, "function buildWeightedBacktestFromRows", "function matrixBacktestSql")
    matrix_sql = _source_between(source, "function matrixBacktestSql", "async function comboBacktest")
    optimizer = _source_between(source, "function backtestWeights", "async function optimizeWeights")

    assert "function memberForwardReturn" in source
    assert "function tradingCostForTurnover" in source
    assert "function weightedTurnover" in source
    assert "isValidForwardReturn(h.ret)" in build
    assert "memberForwardReturn(h.ret)" in build
    assert "memberForwardReturn(h.ret)" in weighted
    assert "tradingCostForTurnover(turnover, !prev)" in build
    assert "tradingCostForTurnover(turnover, !prev)" in weighted
    assert "tradingCostForTurnover(turnover, !prev)" in optimizer
    assert "if (r.fwd_return != null) o.rets.push" not in build
    assert "WHERE fwd_return IS NOT NULL" not in matrix_sql


def test_compose_backtest_excludes_only_periods_with_no_valid_forward_return():
    source = APP_JS.read_text(encoding="utf-8")
    helpers = _source_between(source, "function memberForwardReturn", "function medianNumber")
    build = _source_between(source, "function buildBacktestFromRows", "function industryNeutralPickRows")

    result = _frontend_eval_json([
        "const COST_PER_SIDE = 0.002;",
        "const MIN_VALID_FORWARD_RETURN = -0.95;",
        "const MAX_VALID_FORWARD_RETURN = 5.0;",
        helpers,
        build,
        "const rows = [",
        "  { signal_dt: '2026-05', dt: '2026-06-30', stock_code: 'A', fwd_return: 0.10 },",
        "  { signal_dt: '2026-05', dt: '2026-06-30', stock_code: 'B', fwd_return: null },",
        "  { signal_dt: '2026-06', dt: '2026-07-31', stock_code: 'A', fwd_return: null },",
        "  { signal_dt: '2026-06', dt: '2026-07-31', stock_code: 'B', fwd_return: null },",
        "];",
        "const bt = buildBacktestFromRows(rows, 2);",
        "console.log(JSON.stringify({ returns: bt.retArr, x: bt.x }));",
    ])

    assert result["returns"] == pytest.approx([-0.452])
    assert result["x"] == ["2026-05", "2026-06-30"]


def test_compose_ic_and_portfolio_sql_share_valid_forward_return_rule():
    source = APP_JS.read_text(encoding="utf-8")
    helpers = _source_between(source, "function memberForwardReturn", "function tradingCostForTurnover")
    ic_sql = _source_between(source, "function composeIcDecaySql", "async function renderComposeIcDecay")

    assert "function validForwardReturnSql" in source
    assert "validForwardReturnSql(column)" in helpers
    assert ic_sql.count('validForwardReturnSql("fwd_return")') >= 2
    assert "WHERE fwd_return > ${MIN_VALID_FORWARD_RETURN}" not in ic_sql
    assert "fwd_return < ${MAX_VALID_FORWARD_RETURN}" not in ic_sql


def test_optimal_weight_backtest_matches_compose_kpi_turnover_cost_and_tie_break():
    source = APP_JS.read_text(encoding="utf-8")
    helpers = _source_between(source, "function memberForwardReturn", "function medianNumber")
    metrics = _source_between(source, "function computeMetrics(rets, navs)", "function metricsFromReturns")
    compose_backtest = _source_between(source, "function buildBacktestFromRows", "function industryNeutralPickRows")
    optimizer_backtest = _source_between(source, "function backtestWeights", "async function optimizeWeights")

    result = _frontend_eval_json([
        "const COST_PER_SIDE = 0.002;",
        "const MIN_VALID_FORWARD_RETURN = -0.95;",
        "const MAX_VALID_FORWARD_RETURN = 5.0;",
        helpers,
        metrics,
        compose_backtest,
        optimizer_backtest,
        "const composeRows = [",
        "  { signal_dt: '2026-01', dt: '2026-02-28', stock_code: '000001.SZ', fwd_return: 0.10 },",
        "  { signal_dt: '2026-02', dt: '2026-03-31', stock_code: '000001.SZ', fwd_return: 0.05 },",
        "];",
        "const monthsArr = [",
        "  { stocks: [",
        "    { code: '000002.SZ', scores: [1], ret: -0.20 },",
        "    { code: '000001.SZ', scores: [1], ret: 0.10 },",
        "  ] },",
        "  { stocks: [",
        "    { code: '000002.SZ', scores: [1], ret: -0.10 },",
        "    { code: '000001.SZ', scores: [1], ret: 0.05 },",
        "  ] },",
        "];",
        "const compose = buildBacktestFromRows(composeRows, 1);",
        "const composeMetrics = computeMetrics(compose.retArr, compose.navArr);",
        "const optimizedMetrics = backtestWeights(monthsArr, [1], 1, []);",
        "console.log(JSON.stringify({",
        "  composeNavEnd: composeMetrics.navEnd,",
        "  optimizedNavEnd: optimizedMetrics.navEnd,",
        "  composeAnnual: composeMetrics.annual,",
        "  optimizedAnnual: optimizedMetrics.annual,",
        "}));",
    ])

    assert math.isclose(result["optimizedNavEnd"], result["composeNavEnd"], rel_tol=0, abs_tol=1e-12)
    assert math.isclose(result["optimizedAnnual"], result["composeAnnual"], rel_tol=0, abs_tol=1e-12)


def test_optimal_weight_backtest_rounds_composite_score_like_compose_kpi_sql():
    source = APP_JS.read_text(encoding="utf-8")
    helpers = _source_between(source, "function memberForwardReturn", "function medianNumber")
    metrics = _source_between(source, "function computeMetrics(rets, navs)", "function metricsFromReturns")
    compose_backtest = _source_between(source, "function buildBacktestFromRows", "function industryNeutralPickRows")
    optimizer_backtest = _source_between(source, "function backtestWeights", "async function optimizeWeights")

    result = _frontend_eval_json([
        "const COST_PER_SIDE = 0.002;",
        "const MIN_VALID_FORWARD_RETURN = -0.95;",
        "const MAX_VALID_FORWARD_RETURN = 5.0;",
        helpers,
        metrics,
        compose_backtest,
        optimizer_backtest,
        "const composeRows = [",
        "  { signal_dt: '2026-01', dt: '2026-02-28', stock_code: '000001.SZ', fwd_return: 0.10 },",
        "  { signal_dt: '2026-02', dt: '2026-03-31', stock_code: '000001.SZ', fwd_return: 0.05 },",
        "];",
        "const monthsArr = [",
        "  { stocks: [",
        "    { code: '000002.SZ', scores: [1.00000042], ret: -0.20 },",
        "    { code: '000001.SZ', scores: [1.00000041], ret: 0.10 },",
        "  ] },",
        "  { stocks: [",
        "    { code: '000002.SZ', scores: [1.00000042], ret: -0.10 },",
        "    { code: '000001.SZ', scores: [1.00000041], ret: 0.05 },",
        "  ] },",
        "];",
        "const compose = buildBacktestFromRows(composeRows, 1);",
        "const composeMetrics = computeMetrics(compose.retArr, compose.navArr);",
        "const optimizedMetrics = backtestWeights(monthsArr, [1], 1, []);",
        "console.log(JSON.stringify({",
        "  composeNavEnd: composeMetrics.navEnd,",
        "  optimizedNavEnd: optimizedMetrics.navEnd,",
        "  composeAnnual: composeMetrics.annual,",
        "  optimizedAnnual: optimizedMetrics.annual,",
        "}));",
    ])

    assert math.isclose(result["optimizedNavEnd"], result["composeNavEnd"], rel_tol=0, abs_tol=1e-12)
    assert math.isclose(result["optimizedAnnual"], result["composeAnnual"], rel_tol=0, abs_tol=1e-12)


def test_validation_panel_explains_new_validation_metrics():
    source = APP_JS.read_text(encoding="utf-8")

    assert "指标怎么看" in source
    assert "先看 RankIC 与 IC_IR" in source
    assert "RankIC均值衡量因子排序与未来收益排序的一致性" in source
    assert "IC_IR衡量IC序列的稳定性" in source
    assert "月度胜率看正收益月份占比" in source
    assert "前瞻期用于观察信号衰减" in source
    assert "样本外 / 滚动用于检查结论是否依赖某一段行情" in source
    assert "分层 IC 用于判断因子是否只在某类股票中有效" in source
    assert "本次新增内容" in source
    assert "validation-guide" in source
    assert "阅读顺序" in source
    assert "核心信号" in source
    assert "组合表现" in source
    assert "稳健性检查" in source
    assert "新增图表和排序列" in source
    assert "经验参考区间" in source
    assert "排行榜新增 IC胜率、超额年化、超额回撤、10组单调性、月均换手等排序列" in source
    assert "Top30超额年化" in source
    assert "Top30超额回撤" in source
    assert "月均换手和年化换手" in source
    assert "10组收益柱状图" in source
    assert "36个月滚动 IC_IR 曲线" in source
    assert "分层 IC 热力图" in source
    assert "分层组合收益表" in source
    assert "同一分层内的 Top/Bottom" in source
    assert "HAC t值" in source
    assert "FDR q值" in source
    assert "Newey-West" in source


def test_validation_panel_discloses_pit_industry_classification():
    source = APP_JS.read_text(encoding="utf-8")

    assert "INDUSTRY_CLASSIFICATION_DEFAULT" in source
    assert "industry_classification_limitation" in source
    assert "按月末时点有效的申万一级行业归属计算" in source
    assert "当前使用静态申万行业" not in source
    assert "renderValidationIndustryLimitation" in source


def test_validation_panel_includes_reference_ranges_for_metrics():
    source = APP_JS.read_text(encoding="utf-8")

    assert "经验参考区间，不是硬性标准" in source
    assert "|RankIC| < 1%" in source
    assert "1%-3% 有一定信息" in source
    assert "3%-5% 较有价值" in source
    assert ">5% 较强" in source
    assert ">10% 需排查数据泄露或样本偏差" in source
    assert "IC_IR <0.3 不稳定" in source
    assert "0.3-0.5 初步可用" in source
    assert "0.5-1.0 稳定性较好" in source
    assert ">1.0 较强" in source
    assert "IC胜率 / 月度胜率" in source
    assert "55%-60% 可接受" in source
    assert ">60% 较稳定" in source
    assert "样本月数 <36 参考意义有限" in source


def test_validation_panel_uses_signal_lights_for_metric_judgement():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")

    assert "function metricSignal(metric, value" in source
    assert "function signalValue(metric, value" in source
    assert "signal-dot" in source
    assert "▲" in source
    assert "●" in source
    assert 'metric === "rank_ic"' in source
    assert 'metric === "ic_ir"' in source
    assert 'metric === "win_rate"' in source
    assert 'metric === "sample_months"' in source
    assert 'signalValue("rank_ic", adjustedRankIcMean' in source
    assert "signalValue(\"ann_return\", top30Annual" in source
    assert "signalValue(\"sharpe\", top30Sharpe" in source
    assert "signalValue(\"monotonicity\", adjustedGroupMono" in source
    assert "signalValue(\"rank_ic\", mean" in source
    assert "signalValue(\"rank_ic\", r.rank_ic_mean" in source
    assert "signalValue(\"ann_return\", r.ls_ann_return" in source
    assert "signalValue(\"ann_return\", r.top30_ann_return" in source
    assert ".validation-signal" in styles
    assert ".signal-strong" in styles
    assert ".signal-watch" in styles
    assert ".signal-alert" in styles


def test_frontend_copy_uses_gaussian_rank_score_and_precise_cost_wording():
    source = APP_JS.read_text(encoding="utf-8")

    assert "z-score" not in source
    assert "0.2%双边成本" not in source
    assert "0.2% 双边成本" not in source
    assert "高斯秩标准化分数" in source
    assert "单边 0.2%" in source
    assert "按换手扣成本" in source


def test_positive_only_factor_handling_is_visible_in_catalog_and_detail_copy():
    catalog = json.loads((FRONTEND_DATA / "factor_catalog.json").read_text(encoding="utf-8"))
    by_code = {row["code"]: row for row in catalog}
    source = APP_JS.read_text(encoding="utf-8")

    assert by_code["PE"]["positive_only"] is True
    assert by_code["FWDPE"]["positive_only"] is True
    assert "function positiveOnlyNote" in source
    assert "负值或零值不参与排序" in source


def test_latest_holdings_copy_distinguishes_display_pool_from_historical_backtest_pool():
    source = APP_JS.read_text(encoding="utf-8")
    helper = APP_HOLDING_SCOPE_JS.read_text(encoding="utf-8")
    index_html = INDEX_HTML.read_text(encoding="utf-8")
    deploy_script_path = ROOT / "frontend" / "scripts" / "deploy_to_pages.sh"
    single_rows = _source_between(source, "function renderTopStocksRows", "async function renderNavChart")
    compose_rows = _source_between(source, "async function renderComposeStocks", "async function renderComposeBacktest")

    assert "function latestHoldingScopeNote" in helper
    assert "function holdingAsOfDate" in helper
    assert "function holdingPoolDate" in helper
    assert "当前最新持仓展示" in helper
    assert "不是历史回测持仓" in helper
    assert "历史回测股票池" in helper
    assert "app_holding_scope.js?v=" in index_html
    assert index_html.index("app_holding_scope.js?v=") < index_html.index("app.js?v=")
    if "DEPLOY_VERSION" in index_html:
        assert "app_holding_scope.js?v=DEPLOY_VERSION" in index_html
    if deploy_script_path.exists():
        deploy_script = deploy_script_path.read_text(encoding="utf-8")
        assert '"$SRC/app_holding_scope.js"' in deploy_script
    assert "function latestHoldingScopeNote" not in source
    assert "as_of_date" in single_rows
    assert "pool_date" in single_rows
    assert "as_of_date" in compose_rows
    assert "pool_date" in compose_rows


def test_supabase_permission_errors_are_separated_from_network_failures():
    source = APP_JS.read_text(encoding="utf-8")
    audit_js = (FRONTEND_ROOT / "factor_audit.js").read_text(encoding="utf-8")

    for text in [source, audit_js]:
        assert "401" in text
        assert "403" in text
        assert "RLS" in text
        assert "supabase/schema.sql" in text
        assert "不是普通网络失败" in text

    assert "supabaseUserMessage" in source
    assert "humanReviewError" in audit_js


def test_validation_panel_explicitly_warns_short_samples():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")

    assert "function validationShortSampleWarnings" in source
    assert "renderValidationShortSampleWarning" in source
    assert "样本不足" in source
    assert "建议降低结论权重" in source
    assert "validation-short-sample" in source
    assert ".validation-short-sample" in styles


def test_validation_panel_warns_sparse_neutralization_quality():
    source = APP_JS.read_text(encoding="utf-8")

    assert "function neutralizationQualityWarnings" in source
    assert "function renderNeutralizationQualityWarning" in source
    assert "state.dataManifest?.neutralization_quality" in source
    assert "insufficient_sample" in source
    assert "中性化质量" in source
    assert "有效样本不足" in source


def test_validation_panel_renders_planned_visual_charts_and_extra_metrics():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")

    assert "renderGroup10ValidationChart" in source
    assert "group10-validation-chart" in source
    assert "type: \"bar\"" in source
    assert "renderRolling36mChart" in source
    assert "rolling-36m-chart" in source
    assert "rolling_36m" in source
    assert "renderSegmentHeatmap" in source
    assert "segment-heatmap" in source
    assert "type: \"heatmap\"" in source
    assert "renderSegmentPortfolioChart" in source
    assert "segment-portfolio-chart" in source
    assert "分层组合收益图" in source
    assert "多空年化" in source
    assert "多空回撤" in source
    assert "validation-segment-portfolio-chart" in styles
    assert "renderSegmentPortfolioMethodNote" in source
    assert "分层组合收益数据说明" in source
    assert "每个行业-月份至少有 20 只有效股票" in source
    assert "行业仅保留多空年化最高 3 个和最低 3 个" in source
    assert "与最新 Top 股票列表中的行业数量不是同一口径" in source
    assert "validation-method-note" in styles
    assert "top30_excess_ann_return" in source
    assert "top30_excess_max_drawdown" in source
    assert "top30_avg_turnover" in source
    assert "top30_ann_turnover" in source
    assert "finite(" not in source


def test_ranking_table_exposes_validation_sort_fields():
    source = APP_JS.read_text(encoding="utf-8")

    assert 'key: "rankIcWinRate"' in source
    assert 'key: "top30ExcessAnnual"' in source
    assert 'key: "top30ExcessMdd"' in source
    assert 'key: "group10Mono"' in source
    assert 'key: "top30Turnover"' in source
    assert "rank_ic_win_rate_1m" in source
    assert "top30_excess_ann_return" in source
    assert "top30_excess_max_drawdown" in source
    assert "top30_avg_turnover" in source
    assert "rank_ic_hac_t_stat_1m" in source
    assert "rank_ic_p_value_1m" in source
    assert "rank_ic_q_value_1m" in source
    assert 'key: "rankIcP"' in source


def test_ranking_view_explains_metric_reading_order_and_column_meanings():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")
    index = INDEX_HTML.read_text(encoding="utf-8")

    assert "排行榜怎么看" in index
    assert "先筛稳定性" in index
    assert "再看收益质量" in index
    assert "再看排序结构" in index
    assert "最后看落地成本" in index
    assert "表头可悬停查看口径" in index
    assert "点击列头排序" in index
    assert "function htmlAttr" in source
    assert "综合分综合收益、风险、IC与稳定性" in source
    assert "Top30月收益减基准月收益后的年化收益" in source
    assert "10组收益排序单调性" in source
    assert "Top30持仓月均换手" in source


def test_compose_validation_static_contract():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")
    docs = (Path(__file__).resolve().parents[1] / "docs" / "2026-06-26_因子检验口径说明.md").read_text(encoding="utf-8")

    assert "function comboValidationPayload" in source
    assert "function renderComposeValidation" in source
    assert "function comboGroupValidation" in source
    assert "function comboRollingValidation" in source
    assert "function comboCorrelationWarnings" in source
    assert "function loadComboForValidation" in source
    assert "多因子检验" in source
    assert "组合内相关性" in source
    assert "与最佳单因子对比" in source
    assert "因子贡献" in source
    assert "样本切片" in source
    assert "多因子检验先看合成分数的 RankIC 与 IC_IR" in source


def test_release_manifest_matches_factor_catalog_and_audit_index_when_present():
    manifest_path = FRONTEND_DATA / "release_manifest.json"
    if not manifest_path.exists():
        return

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    catalog = json.loads((FRONTEND_DATA / "factor_catalog.json").read_text(encoding="utf-8"))
    audit = json.loads((FRONTEND_DATA / "factor_audit" / "index.json").read_text(encoding="utf-8"))

    assert manifest["factor_count"] == len(catalog)
    assert manifest["audit_factor_count"] == audit["n_factors"] == len(audit["factors"])
    assert manifest["source_root"].endswith("因子库")
    assert manifest["pages_worktree"] == "/private/tmp/factor-lib-pages-publish-20260701/repo"


def test_frontend_error_paths_escape_dynamic_error_text():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")
    docs = (Path(__file__).resolve().parents[1] / "docs" / "2026-06-26_因子检验口径说明.md").read_text(encoding="utf-8")

    assert "${htmlText(msg)}" in source
    assert "排行榜失败：${htmlText(fallbackErr.message || fallbackErr)}" in source
    assert "对比计算失败：${htmlText(e.message || e)}" in source
    assert "最优权重失败：${htmlText(e.message || e)}" in source
    assert "查询失败：${htmlText(fallbackErr.message || fallbackErr)}" in source
    assert "ic_n_months" in source
    assert "bt_n_months" in source
    assert "IC月数" in source
    assert "收益月数" in source
    assert "combo-validation" in source
    assert "combo-validation-chart" in source
    assert ".combo-validation" in styles
    assert ".combo-correlation-warning" in styles
    assert "多因子检验" in docs
    assert "组合内相关性" in docs
    assert "与最佳单因子对比" in docs
    assert "htmlAttr(c.help || c.label)" in source
    assert "rank-help" in source
    assert ".rank-guide" in styles
    assert ".rank-guide-grid" in styles
    assert "table.rank-table th.rank-help" in styles


def test_combo_ranking_static_contract():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")
    index = INDEX_HTML.read_text(encoding="utf-8")
    docs = (Path(__file__).resolve().parents[1] / "docs" / "2026-06-26_因子检验口径说明.md").read_text(encoding="utf-8")

    assert "combo-ranking-panel" in index
    assert "多因子组合排行榜" in index
    assert "function comboRankingCandidates" in source
    assert "function comboRankingRowFromPayload" in source
    assert "function runComboRanking" in source
    assert "function renderComboRanking" in source
    assert "comboRankingSortKey" in source
    assert "最高相关性" in source
    assert "相对最佳单因子" in source
    assert "计算排行榜" in source
    assert "点击列头排序" in source
    assert 'metric === "correlation"' in source
    assert 'signalValue("correlation", r.max_abs_corr' in source
    assert ".combo-ranking-toolbar" in styles
    assert ".combo-ranking-table" in styles
    assert "多因子组合排行榜" in docs
    assert "综合分只用于排序提示" in docs


def test_combo_ablation_static_contract():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")
    docs = (Path(__file__).resolve().parents[1] / "docs" / "2026-06-26_因子检验口径说明.md").read_text(encoding="utf-8")

    assert "function comboAblationRows" in source
    assert "function runComboAblation" in source
    assert "function renderComboAblationShell" in source
    assert "function renderComboAblationTable" in source
    assert "剔除实验 / 边际贡献" in source
    assert "运行剔除实验" in source
    assert "完整组合 - 剔除后组合" in source
    assert "增益" in source
    assert "冗余" in source
    assert "拖累" in source
    assert "combo-ablation" in source
    assert ".combo-ablation-actions" in styles
    assert ".combo-ablation-table" in styles
    assert "组合归因与剔除实验" in docs
    assert "完整组合 - 剔除后组合" in docs


def test_combo_correlation_crowding_static_contract():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")
    docs = (Path(__file__).resolve().parents[1] / "docs" / "2026-06-26_因子检验口径说明.md").read_text(encoding="utf-8")

    assert "function comboCorrelationSummary" in source
    assert "async function comboCrowdingDiagnostics" in source
    assert "function renderComboCorrelationCrowdingDiagnostics" in source
    assert "function renderComboCrowdingExposureValue" in source
    assert "function crowdingHoldingValuesSql" in source
    assert "JOIN holdings h USING(stock_code)" in source
    assert "AVG(score) AS mean" in source
    assert "暂无有效覆盖" in source
    assert "相关性 / 拥挤度诊断" in source
    assert "有效因子数估算" in source
    assert "低流动性占比" in source
    assert "高拥挤因子暴露" in source
    assert "ABTURN" in source
    assert "TURNPCTL" in source
    assert "HIGHMOMTURN" in source
    assert "TURN20D120" in source
    assert ".combo-crowding-grid" in styles
    assert ".combo-crowding-risk" in styles
    assert "多因子相关性 / 拥挤度诊断" in docs


def test_combo_parameter_sensitivity_static_contract():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")
    docs = (Path(__file__).resolve().parents[1] / "docs" / "2026-06-26_因子检验口径说明.md").read_text(encoding="utf-8")

    assert "async function comboParameterSensitivity" in source
    assert "function comboParameterSensitivityScenarios" in source
    assert "function renderComboParameterSensitivity" in source
    assert "function comboParameterSensitivityJudgement" in source
    assert "参数敏感性" in source
    assert "TopN 敏感性" in source
    assert "约束敏感性" in source
    assert "权重扰动敏感性" in source
    assert "稳健" in source
    assert "敏感" in source
    assert "需复核" in source
    assert "关键指标缺失" in source
    assert "{ includeCrowding: false, includeParameterSensitivity: false }" in source
    assert ".combo-parameter-sensitivity" in styles
    assert ".combo-parameter-card" in styles
    assert "多因子参数敏感性" in docs


def test_combo_best_single_comparison_uses_current_factor_configuration():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "async function comboBestSingleComparison", "async function comboValidationPayload")

    assert "async function comboBestSingleComparison(factors, N, constraintMode, startMonth, endMonth)" in source
    assert "comboIcDecay([singleFactor], startMonth, endMonth)" in body
    assert 'comboBacktest([singleFactor], N, "cps_matrix", constraintMode)' in body
    assert "rankIcStatsFromSeries(ic?.series?.[\"1\"] || [])" in body
    assert "thr: null" in body
    assert "loadActiveSingleSnapshot" not in body


def test_combo_correlation_uses_neutral_matrix_for_neutral_score_mode():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "async function comboCorrelationWarnings", "function comboRiskLabel")

    assert "hasCorrNeutral" in source
    assert "factor_corr_neutral" in source
    assert "function comboCorrelationTableChoice" in source
    assert "comboCorrelationTableChoice(factors)" in body
    assert "state.hasCorrNeutral" in body
    assert "混合分数口径" in body


def test_combo_parameter_sensitivity_does_not_mutate_global_compose_state():
    source = APP_JS.read_text(encoding="utf-8")
    body = _source_between(source, "async function comboParameterSensitivity", "function renderComboContributionTable")

    assert "state.composeFactors =" not in body
    assert "state.composeN =" not in body
    assert "state.composeConstraintMode =" not in body
    assert "restoreComposeContext(original)" not in body
    assert "await ensureComposeBase()" not in body


def test_combo_library_and_admin_rendering_escape_user_supplied_text():
    source = APP_JS.read_text(encoding="utf-8")

    assert "function htmlText" in source
    assert "htmlText(emptyText)" in source
    assert "htmlText(t)" in source
    assert "htmlText(combo.name)" in source
    assert "htmlText(combo.description)" in source
    assert "htmlText(combo.invalidReason)" in source
    assert "htmlText(state.publishedComboErrors.join(\"；\"))" in source
    assert "htmlText(JSON.stringify(payload, null, 2))" in source
    assert "htmlAttr(combo.id)" in source


def test_admin_auth_and_rls_static_contract():
    source = APP_JS.read_text(encoding="utf-8")

    for needle in [
        'supabaseFetch("/auth/v1/token?grant_type=password"',
        "Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`",
        "async function loadAdminRequests()",
        "async function approvePublishRequest",
        "async function deletePublishedComboByAdmin",
    ]:
        assert needle in source

    schema_path = ROOT / "supabase" / "schema.sql"
    if not schema_path.exists():
        return
    schema = schema_path.read_text(encoding="utf-8")
    for needle in [
        "alter table public.combo_publish_requests enable row level security",
        'create policy "Admins can read publish requests"',
        'create policy "Admins can update publish requests"',
        'create policy "Admins can publish combos"',
        'create policy "Admins can delete published combos"',
        "public.is_combo_admin()",
    ]:
        assert needle in schema
    assert "htmlAttr(r.id)" in source
    assert "htmlText(r.error)" in source


def test_combo_crowding_low_liquidity_label_is_relative_to_holdings():
    source = APP_JS.read_text(encoding="utf-8")
    docs = (Path(__file__).resolve().parents[1] / "docs" / "2026-06-26_因子检验口径说明.md").read_text(encoding="utf-8")

    assert "组合内相对低流动性占比" in source
    assert "组合内相对低流动性持仓占比较高" in source
    assert "组合内相对低流动性占比" in docs
    assert "不是全市场低流动性股票占比" in docs


def test_compose_validation_e2e_covers_current_modules():
    e2e = (Path(__file__).resolve().parents[1] / "e2e" / "compose_validation.mjs").read_text(encoding="utf-8")
    runner = (Path(__file__).resolve().parents[1] / "e2e" / "run_compose_validation.mjs").read_text(encoding="utf-8")

    assert "IC月数" in e2e
    assert "收益月数" in e2e
    assert "参数敏感性" in e2e
    assert "剔除实验 / 边际贡献" in e2e
    assert "组合内相对低流动性占比" in e2e
    assert ".combo-ablation-run" in e2e
    assert "existsSync(resolve(sourceFrontendDir, \"app.js\"))" in runner
    assert "\"-m\", \"http.server\"" in runner
    assert "相关性 / 拥挤度诊断" in e2e
    assert "TopN 敏感性" in e2e
    assert "约束敏感性" in e2e
    assert "权重扰动敏感性" in e2e


def test_compose_validation_e2e_has_self_hosted_runner_and_browser_diagnostic():
    root = Path(__file__).resolve().parents[1]
    runner = (root / "e2e" / "run_compose_validation.mjs").read_text(encoding="utf-8")
    e2e = (root / "e2e" / "compose_validation.mjs").read_text(encoding="utf-8")
    package = (root / "e2e" / "package.json").read_text(encoding="utf-8")

    assert "frontend/serve.py" in runner
    assert "compose_validation.mjs" in runner
    assert "waitForHttp" in runner
    assert "SIGTERM" in runner
    assert '"compose-validation": "node run_compose_validation.mjs"' in package
    assert "launchValidationBrowser" in e2e
    assert "浏览器进程启动失败" in e2e
    assert "非沙箱权限" in e2e


def test_validation_panel_supports_benchmark_switch_and_cost_sensitivity():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")

    assert "validationBenchmark" in source
    assert "validation-benchmark-select" in source
    assert "基准选择" in source
    assert "沪深300" in source
    assert "中证500" in source
    assert "中证800" in source
    assert "computeTop30ExcessForBenchmark" in source
    assert "renderCostSensitivityTable" in source
    assert "estimateCostAdjustedReturns" in source
    assert "成本敏感性" in source
    assert "0bp" in source
    assert "10bp" in source
    assert "20bp" in source
    assert "50bp" in source
    assert "基于月均换手估算" in source
    assert "validation-control-row" in styles
    assert ".cost-sensitivity-table" in styles


def test_frontend_visible_version_is_current_after_validation_upgrade():
    index = INDEX_HTML.read_text(encoding="utf-8")

    assert "<title>因子库 v2.0</title>" in index
    assert "<b>因子库 v2.0</b>" in index
    assert "v1.1.0" not in index


def test_optional_snapshot_prefetch_and_admin_login_do_not_emit_browser_warnings():
    source = APP_JS.read_text(encoding="utf-8")
    index = INDEX_HTML.read_text(encoding="utf-8")

    assert "state.dataManifest?.capabilities?.single_snapshots === false" in source
    assert '<form id="admin-login-form" class="admin-login-row">' in index
    assert 'id="admin-login-btn" class="cpsn-btn" type="submit"' in index
    assert 'rel="icon" href="favicon.svg"' in index
    assert 'document.getElementById("admin-login-form")' in source
    assert "event.preventDefault()" in source


def test_publish_worktree_record_points_to_current_clone():
    _skip_without_full_project_docs()
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")

    assert "/private/tmp/factor-lib-pages-publish-20260701/repo" in agents
    assert "不要再作为正式发布工作副本使用" in agents
    assert "是旧 demo 脚本" not in agents
    assert "factor-lib-demo" not in agents


def test_deploy_script_targets_formal_factor_lib_pages_repo():
    script = ROOT / "frontend" / "scripts" / "deploy_to_pages.sh"
    if not script.exists():
        return
    text = script.read_text(encoding="utf-8")

    assert "factor-lib-pages-publish-20260701/repo" in text
    assert "factor-lib-demo" not in text
    assert "bash scripts/pre_publish_validation.sh" in text
    assert "--exclude='data/single_snapshots/'" in text
    assert "--exclude='data/monthly_return.parquet'" in text
    assert "--exclude='data/compose_scores_neutral/'" in text
    assert "--exclude='data/backtests_neutral/'" in text
    assert "--exclude='data/factor_scores_latest_neutral/'" in text
    assert "--exclude='data/quantile_backtests/'" in text
    assert '"compose_scores_raw"' in text
    assert '"has_compose_scores_neutral"' in text
    assert '"segment_validation_parquet"' in text
    assert '"rolling_validation_parquet"' in text
    assert "--filter='P .git/***'" in text
    assert '"$ROOT/e2e/compose_validation.mjs"' in text
    assert '"$ROOT/e2e/package-lock.json"' in text
    assert 'touch "$DEPLOY/.nojekyll"' in text
    assert '"$SRC/favicon.svg"' in text
    assert '"single_snapshots"' in text
    assert 'cp "$ROOT/docs/2026-06-26_因子检验口径说明.md" "$DEPLOY/docs/"' in text
    pre_publish = (ROOT / "scripts" / "pre_publish_validation.sh").read_text(encoding="utf-8")
    assert "scripts/test_frontend_sql.py" in pre_publish


def test_compose_neutral_scores_can_be_disabled_for_slim_pages_artifact():
    source = APP_JS.read_text(encoding="utf-8")

    assert "function hasComposeNeutralScores()" in source
    assert "has_compose_scores_neutral !== false" in source
    assert "function normalizeComposeScoreMode(mode)" in source
    assert 'scoreMode: normalizeComposeScoreMode(f.scoreMode)' in source
    assert 'const neutralDisabled = hasComposeNeutralScores() ? "" : " disabled"' in source
    assert "线上版本未发布 neutral 多因子合成分片；本地完整数据可用。" in source


def test_publish_runbook_uses_current_pages_worktree():
    _skip_without_full_project_docs()
    docs = [
        ROOT / "docs" / "2026-06-10_标签规则与发布避坑记录.md",
        ROOT / "docs" / "2026-06-29_因子检验扩展端到端验收记录.md",
        ROOT / "docs" / "superpowers" / "specs" / "2026-06-29-multi-factor-validation-design.md",
        ROOT / "docs" / "superpowers" / "plans" / "2026-06-29-multi-factor-parameter-sensitivity.md",
        ROOT / "docs" / "superpowers" / "plans" / "2026-06-23-factor-audit-parameter-coverage.md",
    ]
    for path in docs:
        text = path.read_text(encoding="utf-8")
        assert "/private/tmp/factor-lib-pages-publish-20260701/repo" in text, path
        assert "factor-lib-pages-publish-120d/repo" not in text, path
        assert "factor-lib-demo" not in text, path


def test_ci_workflow_runs_static_frontend_checks():
    workflow = ROOT / ".github" / "workflows" / "frontend-validation.yml"
    text = workflow.read_text(encoding="utf-8")

    assert "python3 -m pytest tests/test_frontend_validation_panel.py -q" in text
    assert "Core Python smoke tests" not in text
    assert "tests/test_monthly_returns.py tests/test_backtest.py tests/test_calendar_windows.py tests/test_normalize.py" not in text
    assert "node --check frontend/app.js" in text
    assert "node --check app.js" in text
    assert "node --check e2e/run_compose_validation.mjs" in text
    assert "push" in text
    assert "pull_request" in text


def test_online_compose_validation_script_exists_and_checks_live_site():
    script = ROOT / "e2e" / "online_compose_validation.mjs"
    package_json = (ROOT / "e2e" / "package.json").read_text(encoding="utf-8")
    text = script.read_text(encoding="utf-8")

    assert "https://fifamy.github.io/factor-lib/" in text
    assert "组合内相对低流动性占比" in text
    assert "comboBestSingleComparison(factors, N, constraintMode, startMonth, endMonth)" in text
    assert "factor_corr_neutral" in text
    assert '"online-compose-validation": "node online_compose_validation.mjs"' in package_json
