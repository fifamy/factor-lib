import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" if (ROOT / "frontend" / "app.js").exists() else ROOT


def run_node(script: str) -> None:
    subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)


def test_single_factor_scan_module_builds_metric_series_and_chart_contract():
    module = json.dumps(str(FRONTEND / "app_single_factor_scan.js"))
    run_node("\n".join([
        "const assert = require('node:assert/strict');",
        f"const scan = require({module});",
        "assert.equal(scan.normalizeMetric('bad'), 'annual');",
        "assert.equal(scan.metricValue({annual:.12345}, 'annual'), 12.35);",
        "assert.equal(scan.metricValue({vol:.23456}, 'vol'), 23.46);",
        "assert.equal(scan.metricValue({sharpe:1.23456}, 'sharpe'), 1.235);",
        "assert.equal(scan.metricValue({mdd:-.45678}, 'mdd'), -45.68);",
        "assert.equal(scan.metricValue({annual:Infinity}, 'annual'), null);",
        "const data = scan.buildSeries([1, 2, 3], [2, 3, 3, 4], 'annual', n => n === 3 ? null : {annual:n/100});",
        "assert.deepEqual(data, {xs:[1,2,3], ys:[1,2,null], marks:[{xAxis:2,yAxis:2}]});",
        "assert.equal(scan.titleText('ROE', '原始分', '无约束', 'sharpe'), 'ROE · 原始分 / 无约束 夏普比率 vs 持仓数（top-1 ~ top-100 全扫描）');",
        "const option = scan.chartOption(data, 'annual');",
        "assert.deepEqual(option.xAxis.data, [1,2,3]);",
        "assert.deepEqual(option.series[0].data, [1,2,null]);",
        "assert.deepEqual(option.series[0].markPoint.data, [{coord:['2',2]}]);",
        "assert.equal(option.tooltip.formatter([{axisValue:2,data:2}]), 'top2<br/>年化收益: 2');",
    ]))


def test_stock_detail_module_formats_content_and_escapes_catalog_text():
    module = json.dumps(str(FRONTEND / "app_stock_detail.js"))
    run_node("\n".join([
        "const assert = require('node:assert/strict');",
        f"const detail = require({module});",
        "assert(Math.abs(detail.normalCdf(0) - 0.5) < 1e-6);",
        "assert(detail.normalCdf(1) > detail.normalCdf(0));",
        "assert.equal(detail.rawValueText({name_cn:'估值分位',raw_value:.1234}), '12.34%');",
        "assert.equal(detail.rawValueText({name_cn:'ROE',raw_value:12.3456}), '12.35');",
        "assert.equal(detail.rawValueText({name_cn:'ROE',raw_value:NaN}), '—');",
        "assert.equal(detail.finiteNumber(null), null);",
        "assert.equal(detail.finiteNumber(''), null);",
        "const html = detail.renderBody([",
        " {factor_code:'SAFE',score:1,raw_value:.42},",
        " {factor_code:'LOW',score:-1,raw_value:3.5}",
        "], {industry_sw1:'银行<script>',industry_sw2:'全国',market_cap:120000,pe:8,pb:1.2}, {",
        " activeFactor:'SAFE',",
        " catalog:[",
        "  {code:'SAFE',name_cn:'安全<因子>',l1:'质量&成长',l2:'盈利'},",
        "  {code:'LOW',name_cn:'低分',l1:'质量&成长',l2:'风险'}",
        " ]",
        "});",
        "assert(html.includes('安全&lt;因子&gt;'));",
        "assert(html.includes('质量&amp;成长（2）'));",
        "assert(html.includes('银行&lt;script&gt;'));",
        "assert(!html.includes('<script>'));",
        "assert(html.includes('sd-row sd-active'));",
        "assert(html.includes('sd-barfill pos'));",
        "assert(html.includes('sd-barfill neg'));",
        "assert(html.includes('市值 12 亿'));",
    ]))


def test_frontend_loads_extracted_modules_before_main_application():
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    app = (FRONTEND / "app.js").read_text(encoding="utf-8")

    scan_pos = index.index('src="app_single_factor_scan.js')
    detail_pos = index.index('src="app_stock_detail.js')
    app_pos = index.index('src="app.js')
    assert scan_pos < app_pos
    assert detail_pos < app_pos
    assert "FactorSingleFactorScan.buildSeries" in app
    assert "FactorSingleFactorScan.chartOption" in app
    assert "FactorStockDetail.renderBody" in app
    assert "function _ncdf(" not in app


def test_extracted_modules_are_in_release_hashes_and_pages_integrity_gate():
    if not (ROOT / "frontend" / "scripts" / "deploy_to_pages.sh").exists():
        return
    deploy = (ROOT / "frontend" / "scripts" / "deploy_to_pages.sh").read_text(encoding="utf-8")
    manifest_builder = (ROOT / "scripts" / "build_release_manifest.py").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "frontend-validation.yml").read_text(encoding="utf-8")

    for name in ["app_single_factor_scan.js", "app_stock_detail.js"]:
        assert f'"$SRC/{name}"' in deploy
        assert f"--required {name}" in deploy
        assert f'"{name}"' in manifest_builder
        assert f"node --check frontend/{name}" in workflow
