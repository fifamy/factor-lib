from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ROOT = ROOT / "frontend" if (ROOT / "frontend" / "app.js").exists() else ROOT
APP_JS = FRONTEND_ROOT / "app.js"
STYLES_CSS = FRONTEND_ROOT / "styles.css"
INDEX_HTML = FRONTEND_ROOT / "index.html"


def _source_between(source: str, start: str, end: str) -> str:
    start_idx = source.index(start)
    end_idx = source.index(end, start_idx)
    return source[start_idx:end_idx]


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


def test_validation_panel_explicitly_warns_short_samples():
    source = APP_JS.read_text(encoding="utf-8")
    styles = STYLES_CSS.read_text(encoding="utf-8")

    assert "function validationShortSampleWarnings" in source
    assert "renderValidationShortSampleWarning" in source
    assert "样本不足" in source
    assert "建议降低结论权重" in source
    assert "validation-short-sample" in source
    assert ".validation-short-sample" in styles


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

    assert "<title>因子库 v1.3.6</title>" in index
    assert "<b>因子库 v1.3.6</b>" in index
    assert "v1.1.0" not in index


def test_publish_worktree_record_points_to_current_clone():
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")

    assert "/private/tmp/factor-lib-pages-publish-20260701/repo" in agents
    assert "不要再作为正式发布工作副本使用" in agents


def test_ci_workflow_runs_static_frontend_checks():
    workflow = ROOT / ".github" / "workflows" / "frontend-validation.yml"
    text = workflow.read_text(encoding="utf-8")

    assert "python3 -m pytest tests/test_frontend_validation_panel.py -q" in text
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
