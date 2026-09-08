// Pure optimizer grid utilities. No DOM, database, or portfolio state dependencies.
(function (root) {
"use strict";
function weightGrid(nF, step) {
  const steps = Math.round(1 / step);
  const res = [];
  function rec(idx, rem, acc) {
    if (idx === nF - 1) { res.push([...acc, rem / steps]); return; }
    for (let k = 0; k <= rem; k++) rec(idx + 1, rem - k, [...acc, k / steps]);
  }
  rec(0, steps, []);
  return res;
}

function uniqueWeightGrid(grid, currentWeights = []) {
  const rows = [];
  const seen = new Set();
  const add = raw => {
    const values = (raw || []).map(Number);
    const total = values.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
    if (!values.length || total <= 0) return;
    const normalized = values.map(value => (Number.isFinite(value) && value > 0 ? value / total : 0));
    const key = normalized.map(value => value.toFixed(8)).join("|");
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(normalized);
  };
  (grid || []).forEach(add);
  add(currentWeights);
  return rows;
}

function medianFinite(values) {
  const clean = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}
function walkForwardTopNCandidates(currentN) {
  const current = Math.min(100, Math.max(1, Math.round(Number(currentN) || 30)));
  const anchors = [10, 20, 30, 50, 100];
  const lower = anchors.filter(value => value < current).at(-1)
    ?? (current > 1 ? Math.max(1, Math.floor(current / 2)) : null);
  const upper = anchors.find(value => value > current)
    ?? (current < 100 ? Math.min(100, Math.ceil(current * 1.5)) : null);
  return [...new Set([lower, current, upper].filter(value => Number.isInteger(value) && value >= 1 && value <= 100))]
    .sort((left, right) => left - right);
}

function walkForwardParameterCandidates(grid, currentWeights, N, conds, options = {}) {
  const weights = uniqueWeightGrid(grid, currentWeights);
  const topNs = (options.topNCandidates || [N])
    .map(value => Math.min(100, Math.max(1, Math.round(Number(value) || Number(N) || 30))));
  const thresholdProfiles = (options.thresholdProfiles || [{ name: "当前阈值", conds }])
    .map(profile => ({ name: String(profile?.name || "阈值方案"), conds: profile?.conds || [] }));
  const candidates = [];
  const seen = new Set();
  for (const candidateWeights of weights) {
    for (const topN of topNs) {
      for (const profile of thresholdProfiles) {
        const normalizedConds = profile.conds
          .map(cond => ({ idx: Number(cond.idx), op: cond.op === "<=" ? "<=" : ">=", thr: Number(cond.thr) }))
          .filter(cond => Number.isInteger(cond.idx) && cond.idx >= 0 && Number.isFinite(cond.thr));
        const key = `${candidateWeights.map(value => value.toFixed(8)).join("|")}::${topN}::${normalizedConds.map(cond => `${cond.idx}:${cond.op}:${cond.thr.toFixed(6)}`).join("|")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ weights: candidateWeights.slice(), topN, thresholdName: profile.name, conds: normalizedConds });
      }
    }
  }
  return {
    candidates,
    weightCandidateCount: weights.length,
    topNCandidateCount: new Set(topNs).size,
    thresholdProfileCount: thresholdProfiles.length,
  };
}

const api = Object.freeze({weightGrid, uniqueWeightGrid, medianFinite, walkForwardTopNCandidates, walkForwardParameterCandidates});
root.FactorOptimizerGrid = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
