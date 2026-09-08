import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" if (ROOT / "frontend/app.js").exists() else ROOT


def test_extracted_grid_matches_existing_implementation():
    source = (FRONTEND / "app.js").read_text()
    def section(start, end):
        return source[source.index(start):source.index(end, source.index(start))]
    original = "\n".join([
        section("function weightGrid(", "function optimizerPortfolioLedgerOptions"),
        section("function uniqueWeightGrid(", "function walkForwardWeightLabel"),
        section("function walkForwardTopNCandidates(", "function walkForwardThresholdLabel"),
        section("function walkForwardParameterCandidates(", "function walkForwardMetricsFromRows"),
    ])
    script = "\n".join([
        "const assert = require('node:assert/strict');",
        f"const extracted = require({json.dumps(str(FRONTEND / 'app_optimizer_grid.js'))});",
        original,
        "for (const [n,step] of [[1,.1],[2,.05],[3,.1],[4,.2]]) {",
        "  const grid = weightGrid(n,step);",
        "  assert.deepEqual(extracted.weightGrid(n,step),grid);",
        "  for (const w of grid) assert(Math.abs(w.reduce((a,b)=>a+b,0)-1)<1e-12);",
        "  for (const topN of [1,10,30,75,100]) {",
        "    const options = {topNCandidates:walkForwardTopNCandidates(topN)};",
        "    assert.deepEqual(extracted.walkForwardTopNCandidates(topN),options.topNCandidates);",
        "    assert.deepEqual(extracted.walkForwardParameterCandidates(grid,[],topN,[],options),",
        "      walkForwardParameterCandidates(grid,[],topN,[],options));",
        "  }",
        "}",
        "assert.deepEqual(extracted.uniqueWeightGrid([[1,1],[.5,.5],[-1,2]], [2,2]),[[.5,.5],[0,1]]);",
        "assert.equal(extracted.medianFinite([1,3,2]),2);",
        "assert.equal(extracted.medianFinite([1,4]),2.5);",
        "assert.equal(extracted.medianFinite([null,undefined,NaN,Infinity,-Infinity,false,'', '2']),null);",
        "assert.equal(extracted.medianFinite([null,-2,-4]),-3);",
        "assert.equal(extracted.medianFinite([null,0]),0);",
        "assert.equal(extracted.weightGrid(2,.05).length,21);",
        "assert.equal(extracted.weightGrid(3,.1).length,66);",
        "assert.equal(extracted.weightGrid(4,.2).length,56);",
        "assert.deepEqual(extracted.walkForwardTopNCandidates(30),[20,30,50]);",
    ])
    subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
