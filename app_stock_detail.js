// Pure presentation helpers for the stock "why selected" detail panel.
(function (root) {
"use strict";

function htmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Abramowitz-Stegun approximation of the standard normal CDF.
function normalCdf(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return 0.5;
  const t = 1 / (1 + 0.2316419 * Math.abs(value));
  const d = 0.3989423 * Math.exp(-value * value / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return value > 0 ? 1 - p : p;
}

function percentile(rawScore) {
  return Math.min(99, Math.max(1, Math.round(normalCdf(rawScore) * 100)));
}

function rawValueText(row) {
  if (row?.raw_value === null || row?.raw_value === undefined) return "—";
  const value = Number(row.raw_value);
  if (!Number.isFinite(value)) return "—";
  return String(row.name_cn || "").includes("分位")
    ? `${(value * 100).toFixed(2)}%`
    : value.toPrecision(4);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderBody(scoreRows, metaRow, options = {}) {
  const catalog = new Map((options.catalog || []).map(factor => [factor.code, factor]));
  const groups = new Map();
  for (const row of scoreRows || []) {
    const factor = catalog.get(row.factor_code);
    if (!factor) continue;
    if (!groups.has(factor.l1)) groups.set(factor.l1, []);
    groups.get(factor.l1).push({ ...row, name_cn: factor.name_cn, l2: factor.l2 });
  }

  const activeFactor = options.activeFactor;
  let head = '<div class="sd-meta">';
  if (metaRow) {
    const marketCap = finiteNumber(metaRow.market_cap);
    const marketCapText = marketCap !== null ? `${(marketCap / 1e4).toFixed(0)} 亿` : "—";
    const pe = finiteNumber(metaRow.pe);
    const pb = finiteNumber(metaRow.pb);
    head += `<span>申万：${htmlText(metaRow.industry_sw1 || "—")} / ${htmlText(metaRow.industry_sw2 || "—")}</span>`
      + `<span>市值 ${marketCapText}</span><span>PE ${pe !== null ? pe.toFixed(1) : "—"}</span>`
      + `<span>PB ${pb !== null ? pb.toFixed(2) : "—"}</span>`;
  }
  head += `</div><p class="sd-note">每行一个因子：<b>原始值</b>＝因子原始数值（分位类显示为 %）；`
    + `<b>得分z</b>＝横截面标准化（已统一方向，越大越好）；<b>百分位</b>＝该股强于全市场的比例。`
    + `${activeFactor && catalog.has(activeFactor) ? ` 当前因子 <b>${htmlText(catalog.get(activeFactor).name_cn)}</b> 已高亮。` : ""}</p>`;

  let body = "";
  for (const [level1, rows] of groups) {
    rows.sort((left, right) => Number(right.score) - Number(left.score));
    body += `<div class="sd-group"><h4>${htmlText(level1)}（${rows.length}）</h4><table class="sd-table">`
      + `<thead><tr><th class="sd-name">因子</th><th class="sd-raw">原始值</th>`
      + `<th class="sd-bar">强弱</th><th class="sd-z">得分z</th><th class="sd-pct">百分位</th></tr></thead><tbody>`;
    for (const row of rows) {
      const score = Number(row.score);
      const pct = percentile(score);
      const highlight = row.factor_code === activeFactor ? " sd-active" : "";
      body += `<tr class="sd-row${highlight}">`
        + `<td class="sd-name">${htmlText(row.name_cn || row.factor_code)}<span class="sd-l2">${htmlText(row.l2)}</span></td>`
        + `<td class="sd-raw">${rawValueText(row)}</td>`
        + `<td class="sd-bar"><div class="sd-barwrap"><div class="sd-barfill ${score >= 0 ? "pos" : "neg"}" style="width:${pct}%"></div></div></td>`
        + `<td class="sd-z">${Number.isFinite(score) ? score.toFixed(2) : "—"}</td>`
        + `<td class="sd-pct">${pct}%</td>`
        + `</tr>`;
    }
    body += `</tbody></table></div>`;
  }
  return head + body;
}

const api = Object.freeze({ htmlText, normalCdf, percentile, rawValueText, finiteNumber, renderBody });
root.FactorStockDetail = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
