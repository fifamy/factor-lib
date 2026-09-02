(function () {
  "use strict";

  const STATUS = {
    robust: { label: "稳健有效", className: "robust" },
    provisional: { label: "观察期有效", className: "provisional" },
    not_passed: { label: "未通过", className: "not-passed" },
    no_data: { label: "无有效样本", className: "no-data" },
  };
  const STABILITY = {
    stable: { label: "长期稳定", rank: 7 },
    strengthening: { label: "近期增强", rank: 6 },
    emerging: { label: "短期新生", rank: 5 },
    cyclical: { label: "周期波动", rank: 3 },
    decaying: { label: "近期衰减", rank: 2 },
    reversal: { label: "方向反转", rank: 1 },
    weak: { label: "稳定无效", rank: 0 },
    insufficient: { label: "样本不足", rank: -1 },
  };

  function text(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function number(value) {
    const parsed = value === null || value === undefined ? NaN : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function decimal(value, digits = 2, signed = false) {
    const parsed = number(value);
    if (parsed === null) return "—";
    return `${signed && parsed > 0 ? "+" : ""}${parsed.toFixed(digits)}`;
  }
  function percent(value, digits = 1, signed = false) {
    const parsed = number(value);
    if (parsed === null) return "—";
    return `${signed && parsed > 0 ? "+" : ""}${(parsed * 100).toFixed(digits)}%`;
  }
  function mean(values) {
    const clean = values.map(number).filter(value => value !== null);
    return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
  }
  function median(values) {
    const clean = values.map(number).filter(value => value !== null).sort((a, b) => a - b);
    if (!clean.length) return null;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  }
  function sampleStd(values) {
    const clean = values.map(number).filter(value => value !== null);
    if (clean.length < 2) return null;
    const average = mean(clean);
    return Math.sqrt(clean.reduce((sum, value) => sum + (value - average) ** 2, 0) / (clean.length - 1));
  }
  function sqlLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }
  function safeId(value) {
    const normalized = String(value || "");
    if (!/^[A-Z0-9_]+$/.test(normalized)) throw new Error(`无效股票池或因子代码：${normalized}`);
    return normalized;
  }
  function addMonths(value, months) {
    const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    parsed.setUTCMonth(parsed.getUTCMonth() + months);
    return parsed.toISOString().slice(0, 10);
  }
  function erf(value) {
    const sign = value < 0 ? -1 : 1, x = Math.abs(value), t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
  }
  function normalP(t) {
    const parsed = number(t);
    return parsed === null ? null : Math.max(0, Math.min(1, 1 - erf(Math.abs(parsed) / Math.sqrt(2))));
  }
  function neweyWestT(values) {
    const clean = values.map(number).filter(value => value !== null), n = clean.length;
    if (n < 2) return null;
    const average = mean(clean), centered = clean.map(value => value - average);
    const lag = Math.floor(4 * (n / 100) ** (2 / 9));
    let longRun = centered.reduce((sum, value) => sum + value * value, 0) / n;
    for (let k = 1; k <= lag; k++) {
      let covariance = 0;
      for (let index = k; index < n; index++) covariance += centered[index] * centered[index - k];
      longRun += 2 * (1 - k / (lag + 1)) * covariance / n;
    }
    return longRun > 0 ? average / Math.sqrt(longRun / n) : null;
  }
  function annualStats(values) {
    const clean = values.map(number).filter(value => value !== null && value > -1);
    if (!clean.length) return { annReturn: null, sharpe: null, maxDrawdown: null };
    let nav = 1, peak = 1, maxDrawdown = 0;
    clean.forEach(value => { nav *= 1 + value; peak = Math.max(peak, nav); maxDrawdown = Math.min(maxDrawdown, nav / peak - 1); });
    const annReturn = nav > 0 ? nav ** (12 / clean.length) - 1 : null;
    const volatility = sampleStd(clean), annVolatility = volatility === null ? null : volatility * Math.sqrt(12);
    return { annReturn, sharpe: annVolatility && annReturn !== null ? annReturn / annVolatility : null, maxDrawdown };
  }
  function ranks(values) {
    const indexed = values.map((value, index) => ({ value: number(value), index })).filter(item => item.value !== null).sort((a, b) => a.value - b.value);
    const result = Array(values.length).fill(null);
    for (let start = 0; start < indexed.length;) {
      let end = start + 1;
      while (end < indexed.length && indexed[end].value === indexed[start].value) end++;
      const rank = (start + 1 + end) / 2;
      for (let index = start; index < end; index++) result[indexed[index].index] = rank;
      start = end;
    }
    return result;
  }
  function correlation(left, right) {
    const pairs = left.map((value, index) => [number(value), number(right[index])]).filter(pair => pair[0] !== null && pair[1] !== null);
    if (pairs.length < 2) return null;
    const leftMean = mean(pairs.map(pair => pair[0])), rightMean = mean(pairs.map(pair => pair[1]));
    const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) * (pair[1] - rightMean), 0);
    const denominator = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) ** 2, 0) * pairs.reduce((sum, pair) => sum + (pair[1] - rightMean) ** 2, 0));
    return denominator ? numerator / denominator : null;
  }
  function fdr(rows) {
    const valid = rows.map((row, index) => ({ index, p: number(row.rank_ic_p_value) })).filter(item => item.p !== null).sort((a, b) => a.p - b.p);
    let running = 1;
    for (let position = valid.length - 1; position >= 0; position--) {
      running = Math.min(running, valid[position].p * valid.length / (position + 1));
      rows[valid[position].index].rank_ic_q_value = running;
    }
  }
  function percentileMap(rows, key) {
    const valid = rows.filter(row => number(row[key]) !== null).sort((a, b) => Number(a[key]) - Number(b[key]));
    const map = new Map();
    valid.forEach((row, index) => map.set(row.factor_code, valid.length === 1 ? 1 : index / (valid.length - 1)));
    return map;
  }

  function create(options) {
    const config = options || {};
    const local = {
      ready: false, loading: null, meta: null, poolType: "broad_index", poolId: "HS300", scoreMode: "raw",
      l1: "all", status: "all", search: "", asOf: "", window: "full", customStart: "", customEnd: "",
      costBps: 10, trainWindow: 36, forwardHorizon: 3, summary: [], monthly: [], forward: [], redundancy: [],
      rows: [], filteredRows: [], sortKey: "candidate_score", sortDirection: "desc", selected: new Set(),
      renderSequence: 0, selectedFactor: null, quantileChart: null, monthlyChart: null,
    };
    const rootPath = `${config.dataDir}stock_pool_research/`;
    const element = id => document.getElementById(id);
    const poolMeta = () => local.meta?.pools?.find(pool => pool.pool_id === local.poolId) || null;

    async function ensureReady() {
      if (local.ready) return;
      if (local.loading) return local.loading;
      local.loading = (async () => {
        const response = await fetch(`${rootPath}meta.json${config.version}`);
        if (!response.ok) throw new Error(`股票池元数据加载失败（HTTP ${response.status}）`);
        local.meta = await response.json();
        await config.ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: false });
        await config.dbState.db.query(`CREATE OR REPLACE TABLE stock_pool_factor_summary AS SELECT * FROM read_parquet('${rootPath}summary.parquet${config.version}')`);
        await config.dbState.db.query(`CREATE OR REPLACE TABLE stock_pool_factor_redundancy AS SELECT * FROM read_parquet('${rootPath}redundancy.parquet${config.version}')`);
        bindControls(); populatePoolSelector(false); renderMethodology(); local.ready = true;
      })();
      try { await local.loading; } finally { local.loading = null; }
    }

    function bindControls() {
      document.querySelectorAll("[data-pool-type]").forEach(button => {
        button.onclick = () => {
          local.poolType = button.dataset.poolType;
          document.querySelectorAll("[data-pool-type]").forEach(candidate => { const active = candidate.dataset.poolType === local.poolType; candidate.classList.toggle("active", active); candidate.setAttribute("aria-pressed", String(active)); });
          populatePoolSelector(true); closeDetail(); render();
        };
      });
      element("pool-selector").onchange = event => { local.poolId = event.target.value; local.selected.clear(); closeDetail(); render(); };
      element("pool-score-mode").onchange = event => { local.scoreMode = event.target.value; local.selected.clear(); closeDetail(); render(); };
      element("pool-l1-filter").onchange = event => { local.l1 = event.target.value; applyFiltersAndRender(); };
      element("pool-status-filter").onchange = event => { local.status = event.target.value; applyFiltersAndRender(); };
      element("pool-factor-search").oninput = event => { local.search = event.target.value.trim().toLowerCase(); applyFiltersAndRender(); };
      element("pool-as-of").onchange = event => { local.asOf = event.target.value; rebuildRows(); };
      element("pool-window").onchange = event => { local.window = event.target.value; element("pool-custom-range").hidden = local.window !== "custom"; rebuildRows(); };
      element("pool-custom-start").onchange = event => { local.customStart = event.target.value; rebuildRows(); };
      element("pool-custom-end").onchange = event => { local.customEnd = event.target.value; rebuildRows(); };
      element("pool-cost-bps").onchange = event => { local.costBps = Number(event.target.value); rebuildRows(); };
      element("pool-train-window").onchange = event => { local.trainWindow = Number(event.target.value); rebuildRows(); };
      element("pool-forward-horizon").onchange = event => { local.forwardHorizon = Number(event.target.value); rebuildRows(); };
      element("pool-select-top").onclick = () => {
        local.selected.clear();
        const clusters = new Set();
        for (const row of local.rows.filter(item => number(item.candidate_score) !== null).sort((a, b) => b.candidate_score - a.candidate_score)) {
          const cluster = row.correlation_cluster || `single_${row.factor_code}`;
          if (clusters.has(cluster)) continue;
          clusters.add(cluster); local.selected.add(row.factor_code);
          if (local.selected.size >= 10) break;
        }
        renderTable();
      };
      element("pool-clear-selection").onclick = () => { local.selected.clear(); renderTable(); };
      element("pool-send-compose").onclick = () => {
        const codes = [...local.selected];
        if (!codes.length) return alert("请先选择至少一个候选因子");
        if (codes.length > 12) return alert("一次最多带入 12 个因子，请先缩小选择范围");
        config.openComposeFactors(codes, local.scoreMode);
      };
      document.querySelectorAll("[data-pool-sort]").forEach(header => {
        const activate = () => { const key = header.dataset.poolSort; if (local.sortKey === key) local.sortDirection = local.sortDirection === "desc" ? "asc" : "desc"; else { local.sortKey = key; local.sortDirection = key === "factor_code" || key === "rank_ic_q_value" ? "asc" : "desc"; } renderTable(); };
        header.onclick = activate; header.tabIndex = 0; header.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } };
      });
    }

    function populatePoolSelector(reset) {
      const pools = (local.meta?.pools || []).filter(pool => pool.pool_type === local.poolType);
      if (reset || !pools.some(pool => pool.pool_id === local.poolId)) local.poolId = pools[0]?.pool_id || "";
      element("pool-selector").innerHTML = pools.map(pool => `<option value="${text(pool.pool_id)}"${pool.pool_id === local.poolId ? " selected" : ""}>${text(pool.pool_name)}</option>`).join("");
    }

    async function loadData() {
      const poolId = safeId(local.poolId), mode = safeId(local.scoreMode.toUpperCase()).toLowerCase();
      const summary = await config.dbState.db.query(`SELECT * FROM stock_pool_factor_summary WHERE pool_id=${sqlLiteral(poolId)} AND score_mode=${sqlLiteral(mode)}`);
      const monthlyPath = `${rootPath}monthly/${poolId}.parquet${config.version}`;
      const monthly = await config.dbState.db.query(`SELECT strftime(signal_date,'%Y-%m-%d') signal_date, strftime(return_date,'%Y-%m-%d') return_date, * EXCLUDE(signal_date,return_date) FROM read_parquet('${monthlyPath}') WHERE score_mode=${sqlLiteral(mode)} ORDER BY signal_date`);
      const forwardPath = `${rootPath}forward/${poolId}.parquet${config.version}`;
      const forward = await config.dbState.db.query(`SELECT strftime(selection_date,'%Y-%m-%d') selection_date, strftime(test_end_date,'%Y-%m-%d') test_end_date, * EXCLUDE(selection_date,test_end_date) FROM read_parquet('${forwardPath}') WHERE score_mode=${sqlLiteral(mode)}`);
      const redundancy = await config.dbState.db.query(`SELECT strftime(as_of_date,'%Y-%m-%d') as_of_date, * EXCLUDE(as_of_date) FROM stock_pool_factor_redundancy WHERE pool_id=${sqlLiteral(poolId)} AND score_mode=${sqlLiteral(mode)}`);
      local.summary = summary.toArray(); local.monthly = monthly.toArray(); local.forward = forward.toArray(); local.redundancy = redundancy.toArray();
    }

    function populateDates() {
      const dates = [...new Set([
        ...local.monthly.map(row => row.return_date == null ? null : String(row.return_date)),
        ...local.redundancy.map(row => row.as_of_date == null ? null : String(row.as_of_date)),
      ].filter(Boolean))].sort();
      if (!dates.includes(local.asOf)) local.asOf = dates.at(-1) || "";
      element("pool-as-of").innerHTML = dates.slice().reverse().map(value => `<option value="${value}"${value === local.asOf ? " selected" : ""}>${value}</option>`).join("");
      const signals = local.monthly.map(row => String(row.signal_date)).sort();
      if (!local.customStart) local.customStart = signals[0]?.slice(0, 7) || "";
      if (!local.customEnd) local.customEnd = signals.at(-1)?.slice(0, 7) || "";
      element("pool-custom-start").value = local.customStart; element("pool-custom-end").value = local.customEnd;
    }

    async function render() {
      const sequence = ++local.renderSequence; showLoading();
      try {
        await ensureReady(); await loadData();
        if (sequence !== local.renderSequence) return;
        populateDates(); populateL1Filter(); rebuildRows();
      } catch (error) { console.error("stock pool research render failed:", error); showError(error); }
    }

    function rangeRows(rows, windowValue) {
      let start = "0000-01-01", end = local.asOf;
      if (windowValue !== "full" && windowValue !== "custom") start = addMonths(local.asOf, -Number(windowValue));
      if (windowValue === "custom") { start = `${local.customStart || "0000-01"}-01`; end = `${local.customEnd || local.asOf.slice(0, 7)}-31`; }
      return rows.filter(row => row.is_usable && String(row.return_date) <= local.asOf && String(row.signal_date) >= start && String(row.signal_date) <= end);
    }

    function aggregate(meta, rows) {
      const usable = rangeRows(rows, local.window), rankIcs = usable.map(row => row.rank_ic), t = neweyWestT(rankIcs), cost = local.costBps / 10000;
      const netLong = usable.map(row => number(row.long_excess_return) === null ? null : Number(row.long_excess_return) - (number(row.q5_turnover) || 0) * cost);
      const netLongShort = usable.map(row => number(row.long_short_return) === null ? null : Number(row.long_short_return) - (number(row.long_short_turnover) || 0) * cost);
      const longStats = annualStats(netLong), longShortStats = annualStats(netLongShort), qMeans = [1, 2, 3, 4, 5].map(index => mean(usable.map(row => row[`q${index}_return`])));
      return { ...meta, _months: usable, n_months: usable.length, start_date: usable[0]?.signal_date || null, end_date: usable.at(-1)?.signal_date || null,
        rank_ic_mean: mean(rankIcs), rank_ic_t: t, rank_ic_p_value: normalP(t), rank_ic_q_value: null,
        rank_ic_positive_rate: mean(rankIcs.map(value => number(value) === null ? null : Number(value) > 0 ? 1 : 0)),
        ...Object.fromEntries(qMeans.map((value, index) => [`q${index + 1}_mean_return`, value])), monotonicity: correlation([1, 2, 3, 4, 5], ranks(qMeans)),
        net_long_excess_ann_return: longStats.annReturn, net_long_excess_sharpe: longStats.sharpe,
        net_long_short_ann_return: longShortStats.annReturn, net_long_short_sharpe: longShortStats.sharpe,
        avg_q5_turnover: mean(usable.map(row => row.q5_turnover)), avg_score_coverage: mean(usable.map(row => row.score_coverage)),
      };
    }

    function fixedEvidence(rows, months) {
      const usable = rangeRows(rows, String(months)), values = usable.map(row => row.rank_ic), t = neweyWestT(values);
      return { n: usable.length, mean: mean(values), p: normalP(t) };
    }
    function classifyStability(evidence) {
      const short = evidence[12], middle = evidence[36], long = evidence[60];
      if (short.n < 9) return "insufficient";
      if (middle.n >= 27 && number(short.mean) !== null && number(middle.mean) !== null && short.mean * middle.mean < 0 && Math.max(Math.abs(short.mean), Math.abs(middle.mean)) >= 0.01) return "reversal";
      if (long.n >= 45 && long.mean > 0 && middle.mean > 0 && short.mean > 0 && long.p <= 0.10) return short.mean >= middle.mean * 1.25 ? "strengthening" : "stable";
      if (middle.n >= 27 && middle.mean > 0 && short.mean <= middle.mean * 0.5) return "decaying";
      if (short.mean > 0 && short.p <= 0.10 && (middle.mean === null || middle.mean <= 0 || middle.p > 0.20)) return "emerging";
      if (long.n >= 45 && [short.mean, middle.mean, long.mean].some(value => number(value) !== null && value > 0) && [short.mean, middle.mean, long.mean].some(value => number(value) !== null && value < 0)) return "cyclical";
      return "weak";
    }

    function forwardEvidence(code) {
      const folds = local.forward.filter(row => row.factor_code === code && Number(row.train_window_months) === local.trainWindow && Number(row.forward_horizon_months) === local.forwardHorizon && String(row.test_end_date) <= local.asOf);
      return { oos_fold_count: folds.length, oos_rank_ic_mean: mean(folds.map(row => row.oos_rank_ic_mean)),
        oos_ic_positive_rate: mean(folds.map(row => row.oos_rank_ic_positive === null ? null : row.oos_rank_ic_positive ? 1 : 0)),
        oos_long_positive_rate: mean(folds.map(row => row.oos_long_excess_positive === null ? null : row.oos_long_excess_positive ? 1 : 0)),
        selected_fold_count: folds.filter(row => row.selected_top20).length,
        selected_hit_rate: mean(folds.filter(row => row.selected_top20).map(row => row.oos_rank_ic_positive ? 1 : 0)),
      };
    }

    function rebuildRows() {
      const byFactor = new Map();
      local.monthly.forEach(row => { if (!byFactor.has(row.factor_code)) byFactor.set(row.factor_code, []); byFactor.get(row.factor_code).push(row); });
      const redundancy = new Map(local.redundancy.filter(row => String(row.as_of_date) <= local.asOf).map(row => [row.factor_code, row]));
      local.rows = local.summary.map(meta => {
        const months = byFactor.get(meta.factor_code) || [], row = aggregate(meta, months);
        const fixed = { 12: fixedEvidence(months, 12), 36: fixedEvidence(months, 36), 60: fixedEvidence(months, 60) };
        const stability = classifyStability(fixed), related = redundancy.get(meta.factor_code) || {};
        return { ...row, ...forwardEvidence(meta.factor_code), ...related, _fixed: fixed, stability, stability_rank: STABILITY[stability].rank };
      });
      fdr(local.rows);
      local.rows.forEach(row => {
        const positive = number(row.rank_ic_mean) !== null && row.rank_ic_mean > 0 && number(row.net_long_short_sharpe) !== null && row.net_long_short_sharpe > 0;
        row.effective_status = row.n_months === 0 ? "no_data" : row.n_months >= 36 && row.rank_ic_q_value <= 0.10 && positive ? "robust" : row.n_months >= 12 && row.rank_ic_p_value <= 0.10 && positive ? "provisional" : "not_passed";
        row._recent_metric = row._fixed[12].mean;
        row._implement_metric = number(row.net_long_excess_sharpe) === null ? null : row.net_long_excess_sharpe - (number(row.avg_q5_turnover) || 0) * 0.2;
      });
      const oos = percentileMap(local.rows, "oos_rank_ic_mean"), recency = percentileMap(local.rows, "_recent_metric"), implement = percentileMap(local.rows, "_implement_metric"), unique = percentileMap(local.rows, "uniqueness_score");
      local.rows.forEach(row => {
        const stabilityScore = Math.max(0, STABILITY[row.stability].rank) / 7;
        const eligible = row.oos_fold_count >= 4 && row.n_months >= 12 && row.stability !== "reversal" && row.combo_policy !== "block" && row.usage_status !== "historical_only";
        row.candidate_score = eligible ? 100 * (0.35 * (oos.get(row.factor_code) ?? 0) + 0.25 * stabilityScore + 0.15 * (recency.get(row.factor_code) ?? 0) + 0.15 * (implement.get(row.factor_code) ?? 0) + 0.10 * (unique.get(row.factor_code) ?? 0)) : null;
      });
      renderScopeNote(); applyFiltersAndRender();
    }

    function populateL1Filter() {
      const categories = [...new Set(local.summary.map(row => row.l1).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
      if (local.l1 !== "all" && !categories.includes(local.l1)) local.l1 = "all";
      element("pool-l1-filter").innerHTML = '<option value="all">全部大类</option>' + categories.map(category => `<option value="${text(category)}"${category === local.l1 ? " selected" : ""}>${text(category)}</option>`).join("");
    }
    function applyFiltersAndRender() {
      local.filteredRows = local.rows.filter(row => (local.l1 === "all" || row.l1 === local.l1) && (local.status === "all" || row.effective_status === local.status) && (!local.search || `${row.factor_code} ${row.name_cn || ""} ${row.l1 || ""} ${row.l2 || ""}`.toLowerCase().includes(local.search)));
      renderOverview(); renderStyleSummary(); renderTable();
    }

    function renderScopeNote() {
      const pool = poolMeta(); if (!pool) return;
      const windowLabel = local.window === "full" ? "全部可见历史" : local.window === "custom" ? `${local.customStart} 至 ${local.customEnd}` : `最近 ${local.window} 月`;
      element("pool-scope-note").innerHTML = `<b>${text(pool.pool_name)}</b><span>信息截止 ${text(local.asOf)}，观察窗口：${text(windowLabel)}；只使用截止日以前已实现的收益。</span><span>样本外：过去 ${local.trainWindow} 月训练、未来 ${local.forwardHorizon} 月验证；单边成本 ${local.costBps} bp。</span><span>历史成分：${text(pool.first_membership_date)} 至 ${text(pool.last_membership_date)}；各股票池不强行统一起点。</span>`;
    }
    function renderOverview() {
      const robust = local.rows.filter(row => row.effective_status === "robust").length, provisional = local.rows.filter(row => row.effective_status === "provisional").length;
      const candidates = local.rows.filter(row => number(row.candidate_score) !== null), best = candidates.slice().sort((a, b) => b.candidate_score - a.candidate_score)[0];
      element("pool-overview").innerHTML = `<div class="pool-overview-grid"><div class="pool-overview-item"><span>股票池</span><strong>${text(poolMeta()?.pool_name || local.poolId)}</strong><small>${local.scoreMode === "raw" ? "原始得分" : "行业市值中性化"}</small></div><div class="pool-overview-item"><span>稳健 / 观察</span><strong>${robust} / ${provisional}</strong><small>按当前窗口重新判定</small></div><div class="pool-overview-item"><span>中位 RankIC</span><strong>${decimal(median(local.rows.map(row => row.rank_ic_mean)), 3, true)}</strong><small>只含截止日可见收益</small></div><div class="pool-overview-item"><span>样本外可评估</span><strong>${local.rows.filter(row => row.oos_fold_count >= 4).length}</strong><small>至少 4 个季度折</small></div><div class="pool-overview-item"><span>候选因子</span><strong>${candidates.length}</strong><small>通过时点、方向和使用门槛</small></div><div class="pool-overview-item"><span>候选第一</span><strong>${text(best?.factor_code || "—")}</strong><small>${best ? `${text(best.name_cn || "")} · ${decimal(best.candidate_score, 1)} 分` : "证据不足"}</small></div></div>`;
    }
    function renderStyleSummary() {
      const grouped = new Map(); local.filteredRows.forEach(row => { const key = row.l1 || "未分类"; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row); });
      const styles = [...grouped.entries()].map(([name, rows]) => { const candidates = rows.filter(row => number(row.candidate_score) !== null); const best = candidates.sort((a, b) => b.candidate_score - a.candidate_score)[0]; return { name, count: rows.length, candidates: candidates.length, best, median: median(rows.map(row => row.rank_ic_mean)) }; }).sort((a, b) => b.candidates - a.candidates || (b.median ?? -Infinity) - (a.median ?? -Infinity));
      element("pool-style-summary").innerHTML = styles.length ? `<div class="pool-style-list">${styles.map(style => `<div class="pool-style-row"><div class="pool-style-name"><b>${text(style.name)}</b><span>${style.count} 个因子</span></div><div class="pool-style-track"><span style="width:${Math.max(2, style.candidates / Math.max(1, style.count) * 100).toFixed(1)}%"></span></div><div class="pool-style-value"><b>${style.candidates} 个候选</b><span>中位 IC ${decimal(style.median, 3, true)}</span></div><div class="pool-style-best">领先：${style.best ? `${text(style.best.factor_code)} · ${decimal(style.best.candidate_score, 1)} 分` : "—"}</div></div>`).join("")}</div>` : '<div class="empty">没有匹配的因子大类。</div>';
    }
    function compareRows(a, b) {
      const av = a[local.sortKey], bv = b[local.sortKey], direction = local.sortDirection === "desc" ? -1 : 1;
      if (av === null || av === undefined || (typeof av !== "string" && !Number.isFinite(Number(av)))) return 1;
      if (bv === null || bv === undefined || (typeof bv !== "string" && !Number.isFinite(Number(bv)))) return -1;
      return local.sortKey === "factor_code" ? direction * String(av).localeCompare(String(bv)) : direction * (Number(av) - Number(bv));
    }
    function renderTable() {
      const sorted = local.filteredRows.slice().sort(compareRows), body = element("pool-factor-table-body");
      element("pool-result-count").textContent = `显示 ${sorted.length} / ${local.rows.length} · 已选 ${local.selected.size}`;
      document.querySelectorAll("[data-pool-sort]").forEach(header => { const active = header.dataset.poolSort === local.sortKey; header.classList.toggle("sorted", active); header.setAttribute("aria-sort", active ? (local.sortDirection === "asc" ? "ascending" : "descending") : "none"); });
      if (!sorted.length) { body.innerHTML = '<tr><td colspan="14" class="empty">没有匹配结果，请调整筛选条件。</td></tr>'; return; }
      body.innerHTML = sorted.map(row => { const status = STATUS[row.effective_status] || STATUS.not_passed, stability = STABILITY[row.stability]; return `<tr><td class="pool-left"><input class="pool-row-check" data-code="${text(row.factor_code)}" type="checkbox" aria-label="选择 ${text(row.factor_code)}"${local.selected.has(row.factor_code) ? " checked" : ""}></td><td class="pool-left"><span class="pool-status ${status.className}">${status.label}</span></td><td class="pool-left"><button class="pool-factor-open" type="button" data-code="${text(row.factor_code)}"><b>${text(row.factor_code)}</b><span>${text(row.name_cn || "")}</span></button></td><td class="pool-left"><span>${text(row.l1 || "—")}</span><small>${text(row.l2 || "")}</small></td><td><span class="pool-stability ${text(row.stability)}">${stability.label}</span></td><td>${row.n_months}</td><td>${decimal(row.rank_ic_mean, 3, true)}</td><td>${percent(row.rank_ic_q_value, 1)}</td><td>${percent(row.net_long_excess_ann_return, 1, true)}</td><td>${percent(row.avg_q5_turnover, 0)}</td><td>${decimal(row.oos_rank_ic_mean, 3, true)}<small>${row.oos_fold_count || 0} 折</small></td><td>${percent(row.oos_ic_positive_rate, 0)}</td><td>${percent(row.uniqueness_score, 0)}<small>${row.top_related_factor ? `近似 ${text(row.top_related_factor)}` : ""}</small></td><td><b class="pool-candidate-score">${decimal(row.candidate_score, 1)}</b></td></tr>`; }).join("");
      body.querySelectorAll(".pool-row-check").forEach(input => input.onchange = () => { input.checked ? local.selected.add(input.dataset.code) : local.selected.delete(input.dataset.code); renderTable(); });
      body.querySelectorAll(".pool-factor-open").forEach(button => button.onclick = () => openDetail(button.dataset.code));
      const all = element("pool-check-all"); if (all) { all.checked = sorted.length > 0 && sorted.every(row => local.selected.has(row.factor_code)); all.onchange = () => { sorted.forEach(row => all.checked ? local.selected.add(row.factor_code) : local.selected.delete(row.factor_code)); renderTable(); }; }
    }

    function openDetail(code) {
      const row = local.rows.find(item => item.factor_code === code); if (!row) return;
      local.selectedFactor = code; const panel = element("pool-factor-detail"); panel.hidden = false;
      panel.innerHTML = `<div class="pool-detail-head"><div><div class="pool-detail-title-line"><h3>${text(code)} · ${text(row.name_cn || "")}</h3><span class="pool-stability ${text(row.stability)}">${STABILITY[row.stability].label}</span></div><p>${text(poolMeta()?.pool_name || local.poolId)}；${row.start_date || "—"} 至 ${row.end_date || "—"}；单边成本 ${local.costBps} bp。</p></div><div class="pool-detail-actions"><button id="pool-detail-single" type="button">进入单因子分析</button><button id="pool-detail-close" type="button">关闭详情</button></div></div><div class="pool-evidence-strip"><div><span>当前窗口 IC</span><b>${decimal(row.rank_ic_mean, 3, true)}</b></div><div><span>12 / 36 / 60 月 IC</span><b>${decimal(row._fixed[12].mean, 3, true)} / ${decimal(row._fixed[36].mean, 3, true)} / ${decimal(row._fixed[60].mean, 3, true)}</b></div><div><span>成本后 Q5 超额</span><b>${percent(row.net_long_excess_ann_return, 1, true)}</b></div><div><span>样本外 IC / 命中</span><b>${decimal(row.oos_rank_ic_mean, 3, true)} / ${percent(row.oos_ic_positive_rate, 0)}</b></div><div><span>独特性</span><b>${percent(row.uniqueness_score, 0)}</b></div><div><span>候选分</span><b>${decimal(row.candidate_score, 1)}</b></div></div><div class="pool-detail-grid"><section><h4>五分组平均月收益</h4><div id="pool-quantile-chart" class="pool-chart"></div></section><section class="pool-alpha-explain"><h4>能否用于未来候选</h4><dl><div><dt>样本外证据</dt><dd>${row.oos_fold_count} 个已完成季度折；IC 为正比例 ${percent(row.oos_ic_positive_rate, 0)}，多头超额为正比例 ${percent(row.oos_long_positive_rate, 0)}。</dd></div><div><dt>交易成本</dt><dd>Q5 平均单边换手 ${percent(row.avg_q5_turnover, 0)}；当前成本情景后的年化超额 ${percent(row.net_long_excess_ann_return, 1, true)}。</dd></div><div><dt>冗余</dt><dd>${row.top_related_factor ? `与 ${text(row.top_related_factor)} 最接近，相关系数 ${decimal(row.top_related_corr, 2, true)}，同簇 ${row.cluster_size || 1} 个因子。` : "暂无同截面可比相关性。"}</dd></div></dl><p>候选分用于缩小研究范围，不等同于未来有效性的保证；仍需进入组合页检查暴露和持仓。</p></section></div><section class="pool-monthly-section"><h4>月度 RankIC、12/36/60 月滚动均值与成本后累计收益</h4><div id="pool-monthly-chart" class="pool-chart pool-chart-wide"></div></section>`;
      element("pool-detail-close").onclick = closeDetail; element("pool-detail-single").onclick = () => config.openSingleFactor(code); renderQuantileChart(row); renderMonthlyChart(row);
      panel.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    }
    function closeDetail() { local.selectedFactor = null; if (local.quantileChart) local.quantileChart.dispose(); if (local.monthlyChart) local.monthlyChart.dispose(); local.quantileChart = null; local.monthlyChart = null; const panel = element("pool-factor-detail"); if (panel) panel.hidden = true; }
    function renderQuantileChart(row) {
      if (!window.echarts) return; const node = element("pool-quantile-chart"); local.quantileChart = window.echarts.init(node);
      local.quantileChart.setOption({ animationDuration: 180, grid: { left: 48, right: 18, top: 16, bottom: 34 }, tooltip: { trigger: "axis" }, xAxis: { type: "category", data: ["Q1 低分", "Q2", "Q3", "Q4", "Q5 高分"] }, yAxis: { type: "value", axisLabel: { formatter: "{value}%" } }, series: [{ type: "bar", data: [1, 2, 3, 4, 5].map(index => number(row[`q${index}_mean_return`]) === null ? null : row[`q${index}_mean_return`] * 100), itemStyle: { color: params => params.dataIndex === 4 ? "#1a4d80" : params.dataIndex === 0 ? "#b9655a" : "#8ba7c0" } }] });
    }
    function rolling(rows, size) { return rows.map((_, index) => index + 1 < size ? null : mean(rows.slice(index + 1 - size, index + 1).map(row => row.rank_ic))); }
    function cumulative(rows, key, turnoverKey) { let nav = 1; const cost = local.costBps / 10000; return rows.map(row => { const value = number(row[key]); if (value === null) return null; nav *= 1 + value - (number(row[turnoverKey]) || 0) * cost; return (nav - 1) * 100; }); }
    function renderMonthlyChart(row) {
      if (!window.echarts) return; const rows = row._months, node = element("pool-monthly-chart"); if (!rows.length) { node.innerHTML = '<div class="empty">当前窗口没有有效月度结果。</div>'; return; }
      local.monthlyChart = window.echarts.init(node); local.monthlyChart.setOption({ animationDuration: 180, legend: { data: ["月度 IC", "12 月 IC", "36 月 IC", "60 月 IC", "累计成本后 Q5 超额"], top: 0 }, grid: { left: 52, right: 58, top: 44, bottom: 46 }, tooltip: { trigger: "axis" }, dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 8 }], xAxis: { type: "category", data: rows.map(item => String(item.signal_date).slice(0, 7)) }, yAxis: [{ type: "value", name: "RankIC" }, { type: "value", name: "累计收益 %", axisLabel: { formatter: "{value}%" } }], series: [{ name: "月度 IC", type: "bar", data: rows.map(item => number(item.rank_ic)), itemStyle: { color: "#bac6d0" }, barMaxWidth: 10 }, { name: "12 月 IC", type: "line", data: rolling(rows, 12), showSymbol: false }, { name: "36 月 IC", type: "line", data: rolling(rows, 36), showSymbol: false }, { name: "60 月 IC", type: "line", data: rolling(rows, 60), showSymbol: false }, { name: "累计成本后 Q5 超额", type: "line", yAxisIndex: 1, data: cumulative(rows, "long_excess_return", "q5_turnover"), showSymbol: false, lineStyle: { width: 2.2, color: "#1a4d80" } }] });
    }

    function showLoading() { element("pool-overview").innerHTML = '<div class="pool-skeleton"></div>'; element("pool-style-summary").innerHTML = '<div class="pool-skeleton pool-skeleton-wide"></div>'; element("pool-factor-table-body").innerHTML = '<tr><td colspan="14" class="empty">加载月度、样本外与冗余证据…</td></tr>'; }
    function showError(error) { const message = text(error?.message || error || "未知错误"); element("pool-overview").innerHTML = `<div class="pool-error"><b>股票池研究数据加载失败</b><span>${message}</span><button id="pool-retry" type="button">重试</button></div>`; element("pool-style-summary").innerHTML = '<div class="empty">等待数据恢复</div>'; element("pool-factor-table-body").innerHTML = '<tr><td colspan="14" class="empty">暂无可显示结果</td></tr>'; element("pool-retry").onclick = render; }
    function renderMethodology() {
      element("pool-methodology-content").innerHTML = `<dl><div><dt>严格时点</dt><dd>信息截止日只纳入 return_date 已经到达的结果；样本外训练在选择日 T 仅使用 return_date≤T 的历史，杜绝未来收益泄漏。</dd></div><div><dt>时间窗口</dt><dd>全部、60/36/12 月和自定义窗口都会重新计算 IC、HAC t、FDR、分层与成本后收益；12/36/60 月同时用于判断长期稳定、近期增强、衰减或方向反转。</dd></div><div><dt>样本外</dt><dd>每季度滚动选因子，训练覆盖和未来覆盖均须至少 75%；未来 3/6/12 月折可切换，历史截止视图只展示当时已经完成的折。</dd></div><div><dt>成本与冗余</dt><dd>成本按 Q5/Q1 实际等权换手率逐月扣减；冗余基于股票池最新同一截面因子得分的 Spearman 相关，|ρ|≥0.75 归为同簇。</dd></div><div><dt>候选分</dt><dd>样本外 35%、稳定性 25%、近期强度 15%、成本后可实施性 15%、独特性 10%；少于 4 个样本外折、少于 12 个有效月、方向反转或禁止组合的因子不评分。</dd></div><div><dt>统计边界</dt><dd>动态窗口的 p 值采用 HAC t 的双侧正态近似，再在当前股票池内执行 BH-FDR；候选分用于研究排序，不是未来收益承诺。</dd></div></dl>`;
    }
    function resize() { if (local.quantileChart) local.quantileChart.resize(); if (local.monthlyChart) local.monthlyChart.resize(); }
    return { render, resize, closeDetail };
  }

  window.FactorStockPoolResearch = { create };
})();
