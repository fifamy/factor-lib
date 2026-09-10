// Pure helpers for the single-factor holding-count scan.
(function (root) {
"use strict";

const METRIC_LABELS = Object.freeze({
  annual: "年化收益",
  vol: "年化波动率",
  sharpe: "夏普比率",
  mdd: "最大回撤",
});

function normalizeMetric(metric) {
  return Object.prototype.hasOwnProperty.call(METRIC_LABELS, metric) ? metric : "annual";
}

function metricValue(metrics, metric) {
  if (!metrics) return null;
  const normalized = normalizeMetric(metric);
  const value = Number(metrics[normalized]);
  if (!Number.isFinite(value)) return null;
  if (normalized === "sharpe") return +value.toFixed(3);
  return +(value * 100).toFixed(2);
}

function buildSeries(rawXs, rawSelectedNs, metric, metricsAt) {
  const xs = (rawXs || []).map(Number).filter(Number.isFinite);
  const ys = xs.map((n, index) => metricValue(metricsAt(n, index), metric));
  const marks = [...new Set((rawSelectedNs || []).map(Number).filter(Number.isFinite))]
    .map(n => {
      const index = xs.indexOf(n);
      return index >= 0 && ys[index] !== null ? { xAxis: n, yAxis: ys[index] } : null;
    })
    .filter(Boolean);
  return { xs, ys, marks };
}

function titleText(factorName, scoreLabel, constraintLabel, metric) {
  return `${factorName} · ${scoreLabel} / ${constraintLabel} ${METRIC_LABELS[normalizeMetric(metric)]} vs 持仓数（top-1 ~ top-100 全扫描）`;
}

function chartOption(series, metric) {
  const normalized = normalizeMetric(metric);
  return {
    grid: { left: 55, right: 20, top: 20, bottom: 36 },
    tooltip: {
      trigger: "axis",
      formatter: points => {
        const point = points?.[0];
        return point ? `top${point.axisValue}<br/>${METRIC_LABELS[normalized]}: ${point.data}` : "";
      },
    },
    xAxis: {
      type: "category",
      data: series.xs,
      name: "持仓数 N",
      nameLocation: "middle",
      nameGap: 24,
      axisLabel: { fontSize: 10 },
    },
    yAxis: { type: "value", scale: true },
    series: [{
      type: "line",
      data: series.ys,
      symbol: "none",
      smooth: true,
      lineStyle: { color: "#1a4d80", width: 1.8 },
      markPoint: {
        data: series.marks.map(mark => ({ coord: [String(mark.xAxis), mark.yAxis] })),
        symbol: "pin",
        symbolSize: 36,
        itemStyle: { color: "#e07b39" },
        label: { fontSize: 9, formatter: point => "N=" + point.data.coord[0] },
      },
    }],
  };
}

const api = Object.freeze({ METRIC_LABELS, normalizeMetric, metricValue, buildSeries, titleText, chartOption });
root.FactorSingleFactorScan = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
