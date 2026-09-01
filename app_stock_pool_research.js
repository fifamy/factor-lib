(function () {
  "use strict";

  const STATUS = {
    robust: { label: "稳健有效", className: "robust" },
    provisional: { label: "观察期有效", className: "provisional" },
    not_passed: { label: "未通过", className: "not-passed" },
  };
  const ALPHA_SOURCE = {
    both: "多头 + 剔除",
    long: "多头端",
    short: "空头剔除",
    weak: "贡献不明显",
  };

  function text(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function number(value) {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function decimal(value, digits = 2, signed = false) {
    const parsed = number(value);
    if (parsed === null) return "—";
    const prefix = signed && parsed > 0 ? "+" : "";
    return prefix + parsed.toFixed(digits);
  }

  function percent(value, digits = 1, signed = false) {
    const parsed = number(value);
    if (parsed === null) return "—";
    const prefix = signed && parsed > 0 ? "+" : "";
    return prefix + (parsed * 100).toFixed(digits) + "%";
  }

  function median(values) {
    const clean = values.map(number).filter(value => value !== null).sort((a, b) => a - b);
    if (!clean.length) return null;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  }

  function sqlLiteral(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  function safeId(value) {
    const normalized = String(value || "");
    if (!/^[A-Z0-9_]+$/.test(normalized)) throw new Error(`无效股票池或因子代码：${normalized}`);
    return normalized;
  }

  function create(options) {
    const config = options || {};
    const local = {
      ready: false,
      loading: null,
      meta: null,
      poolType: "broad_index",
      poolId: "HS300",
      scoreMode: "raw",
      l1: "all",
      status: "all",
      search: "",
      rows: [],
      filteredRows: [],
      sortKey: "rank_ic_mean",
      sortDirection: "desc",
      renderSequence: 0,
      detailSequence: 0,
      selectedFactor: null,
      quantileChart: null,
      monthlyChart: null,
    };

    const rootPath = `${config.dataDir}stock_pool_research/`;

    function element(id) {
      return document.getElementById(id);
    }

    function poolMeta() {
      return local.meta?.pools?.find(pool => pool.pool_id === local.poolId) || null;
    }

    async function ensureReady() {
      if (local.ready) return;
      if (local.loading) return local.loading;
      local.loading = (async () => {
        const response = await fetch(`${rootPath}meta.json${config.version}`);
        if (!response.ok) throw new Error(`股票池元数据加载失败（HTTP ${response.status}）`);
        local.meta = await response.json();
        await config.ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: false });
        await config.dbState.db.query(`
          CREATE OR REPLACE TABLE stock_pool_factor_summary AS
          SELECT * FROM read_parquet('${rootPath}summary.parquet${config.version}')
        `);
        bindControls();
        renderMethodology();
        local.ready = true;
      })();
      try {
        await local.loading;
      } finally {
        local.loading = null;
      }
    }

    function bindControls() {
      document.querySelectorAll("[data-pool-type]").forEach(button => {
        button.onclick = () => {
          local.poolType = button.dataset.poolType;
          document.querySelectorAll("[data-pool-type]").forEach(candidate => {
            const active = candidate.dataset.poolType === local.poolType;
            candidate.classList.toggle("active", active);
            candidate.setAttribute("aria-pressed", String(active));
          });
          populatePoolSelector(true);
          render();
        };
      });
      element("pool-selector").onchange = event => {
        local.poolId = event.target.value;
        closeDetail();
        render();
      };
      element("pool-score-mode").onchange = event => {
        local.scoreMode = event.target.value;
        closeDetail();
        render();
      };
      element("pool-l1-filter").onchange = event => {
        local.l1 = event.target.value;
        applyFiltersAndRender();
      };
      element("pool-status-filter").onchange = event => {
        local.status = event.target.value;
        applyFiltersAndRender();
      };
      element("pool-factor-search").oninput = event => {
        local.search = event.target.value.trim().toLowerCase();
        applyFiltersAndRender();
      };
      document.querySelectorAll("[data-pool-sort]").forEach(header => {
        header.tabIndex = 0;
        const activate = () => {
          const key = header.dataset.poolSort;
          if (local.sortKey === key) local.sortDirection = local.sortDirection === "desc" ? "asc" : "desc";
          else {
            local.sortKey = key;
            local.sortDirection = key === "rank_ic_q_value" || key === "factor_code" ? "asc" : "desc";
          }
          renderTable();
        };
        header.onclick = activate;
        header.onkeydown = event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        };
      });
      populatePoolSelector(false);
    }

    function populatePoolSelector(reset) {
      const select = element("pool-selector");
      const pools = (local.meta?.pools || []).filter(pool => pool.pool_type === local.poolType);
      if (reset || !pools.some(pool => pool.pool_id === local.poolId)) local.poolId = pools[0]?.pool_id || "";
      select.innerHTML = pools.map(pool => (
        `<option value="${text(pool.pool_id)}"${pool.pool_id === local.poolId ? " selected" : ""}>${text(pool.pool_name)}</option>`
      )).join("");
      closeDetail();
    }

    async function loadRows() {
      const poolId = safeId(local.poolId);
      const mode = safeId(local.scoreMode.toUpperCase()).toLowerCase();
      const result = await config.dbState.db.query(`
        SELECT *
        FROM stock_pool_factor_summary
        WHERE pool_id = ${sqlLiteral(poolId)} AND score_mode = ${sqlLiteral(mode)}
      `);
      return result.toArray();
    }

    async function render() {
      const sequence = ++local.renderSequence;
      showLoading();
      try {
        await ensureReady();
        if (sequence !== local.renderSequence) return;
        local.rows = await loadRows();
        if (sequence !== local.renderSequence) return;
        populateL1Filter();
        renderScopeNote();
        applyFiltersAndRender();
      } catch (error) {
        console.error("stock pool research render failed:", error);
        showError(error);
      }
    }

    function showLoading() {
      const overview = element("pool-overview");
      const style = element("pool-style-summary");
      const body = element("pool-factor-table-body");
      if (overview) overview.innerHTML = '<div class="pool-skeleton" aria-label="加载研究概览"></div>';
      if (style) style.innerHTML = '<div class="pool-skeleton pool-skeleton-wide" aria-label="加载因子大类"></div>';
      if (body) body.innerHTML = '<tr><td colspan="14" class="empty">加载股票池研究结果…</td></tr>';
    }

    function showError(error) {
      const message = text(error?.message || error || "未知错误");
      element("pool-overview").innerHTML = `<div class="pool-error"><b>股票池研究数据加载失败</b><span>${message}</span><button id="pool-retry" type="button">重试</button></div>`;
      element("pool-style-summary").innerHTML = '<div class="empty">等待数据恢复</div>';
      element("pool-factor-table-body").innerHTML = '<tr><td colspan="14" class="empty">暂无可显示结果</td></tr>';
      const retry = element("pool-retry");
      if (retry) retry.onclick = () => render();
    }

    function populateL1Filter() {
      const select = element("pool-l1-filter");
      const categories = [...new Set(local.rows.map(row => row.l1).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
      if (local.l1 !== "all" && !categories.includes(local.l1)) local.l1 = "all";
      select.innerHTML = '<option value="all">全部大类</option>' + categories.map(category => (
        `<option value="${text(category)}"${category === local.l1 ? " selected" : ""}>${text(category)}</option>`
      )).join("");
    }

    function renderScopeNote() {
      const pool = poolMeta();
      if (!pool) return;
      const benchmark = pool.pool_type === "broad_index" ? "官方指数精确持有期收益" : "当期行业股票池等权收益";
      element("pool-scope-note").innerHTML = `
        <b>${text(pool.pool_name)}</b>
        <span>${text(pool.first_membership_date)} 至 ${text(pool.last_membership_date)}，${Number(pool.membership_months)} 个成分时点，历史涉及 ${Number(pool.historical_stock_count).toLocaleString("zh-CN")} 只股票。</span>
        <span>超额基准：${benchmark}；各股票池从自身成分数据起点开始，不强行统一日期。</span>`;
    }

    function applyFiltersAndRender() {
      local.filteredRows = local.rows.filter(row => {
        if (local.l1 !== "all" && row.l1 !== local.l1) return false;
        if (local.status !== "all" && row.effective_status !== local.status) return false;
        if (!local.search) return true;
        return `${row.factor_code || ""} ${row.name_cn || ""} ${row.l1 || ""} ${row.l2 || ""}`.toLowerCase().includes(local.search);
      });
      renderOverview();
      renderStyleSummary();
      renderTable();
    }

    function renderOverview() {
      const rows = local.rows;
      const robust = rows.filter(row => row.effective_status === "robust").length;
      const provisional = rows.filter(row => row.effective_status === "provisional").length;
      const shortDriven = rows.filter(row => row.alpha_source === "short").length;
      const coverage = median(rows.map(row => row.avg_score_coverage));
      const rankIc = median(rows.map(row => row.rank_ic_mean));
      const pool = poolMeta();
      element("pool-overview").innerHTML = `
        <div class="pool-overview-grid">
          <div class="pool-overview-item"><span>股票池</span><strong>${text(pool?.pool_name || local.poolId)}</strong><small>${text(local.scoreMode === "raw" ? "原始得分" : "行业市值中性化")}</small></div>
          <div class="pool-overview-item"><span>稳健有效</span><strong>${robust}</strong><small>满足 36 月与 FDR 规则</small></div>
          <div class="pool-overview-item"><span>观察期有效</span><strong>${provisional}</strong><small>样本较短或仅通过未校正检验</small></div>
          <div class="pool-overview-item"><span>中位 RankIC</span><strong>${decimal(rankIc, 3, true)}</strong><small>当前股票池全部因子</small></div>
          <div class="pool-overview-item"><span>中位得分覆盖</span><strong>${percent(coverage, 1)}</strong><small>因子得分 / 时点成分数</small></div>
          <div class="pool-overview-item"><span>空头剔除型</span><strong>${shortDriven}</strong><small>收益主要来自避开 Q1</small></div>
        </div>`;
    }

    function renderStyleSummary() {
      const grouped = new Map();
      for (const row of local.filteredRows) {
        const key = row.l1 || "未分类";
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }
      const styles = [...grouped.entries()].map(([name, rows]) => {
        const effective = rows.filter(row => row.effective_status !== "not_passed").length;
        const robust = rows.filter(row => row.effective_status === "robust").length;
        const best = rows.slice().sort((a, b) => (number(b.rank_ic_mean) ?? -Infinity) - (number(a.rank_ic_mean) ?? -Infinity))[0];
        return {
          name,
          count: rows.length,
          effective,
          robust,
          share: rows.length ? effective / rows.length : 0,
          medianIc: median(rows.map(row => row.rank_ic_mean)),
          best,
        };
      }).sort((a, b) => b.share - a.share || (b.medianIc ?? -Infinity) - (a.medianIc ?? -Infinity));
      if (!styles.length) {
        element("pool-style-summary").innerHTML = '<div class="empty empty-guidance"><b>没有匹配的因子大类</b><span>请清除搜索词或放宽有效性筛选。</span></div>';
        return;
      }
      element("pool-style-summary").innerHTML = `<div class="pool-style-list">${styles.map(style => `
        <div class="pool-style-row">
          <div class="pool-style-name"><b>${text(style.name)}</b><span>${style.count} 个因子 · 稳健 ${style.robust}</span></div>
          <div class="pool-style-track" aria-label="${text(style.name)}有效比例 ${percent(style.share, 0)}"><span style="width:${Math.max(2, style.share * 100).toFixed(1)}%"></span></div>
          <div class="pool-style-value"><b>${percent(style.share, 0)}</b><span>中位 IC ${decimal(style.medianIc, 3, true)}</span></div>
          <div class="pool-style-best">领先：${style.best ? `${text(style.best.factor_code)} · ${text(style.best.name_cn || "")}` : "—"}</div>
        </div>`).join("")}</div>`;
    }

    function compareRows(a, b) {
      const key = local.sortKey;
      const aValue = a[key];
      const bValue = b[key];
      const direction = local.sortDirection === "desc" ? -1 : 1;
      if (aValue === null || aValue === undefined || !Number.isFinite(Number(aValue)) && typeof aValue !== "string") return 1;
      if (bValue === null || bValue === undefined || !Number.isFinite(Number(bValue)) && typeof bValue !== "string") return -1;
      if (key === "factor_code") return direction * String(aValue).localeCompare(String(bValue));
      return direction * (Number(aValue) - Number(bValue));
    }

    function renderTable() {
      const sorted = local.filteredRows.slice().sort(compareRows);
      const body = element("pool-factor-table-body");
      element("pool-result-count").textContent = `显示 ${sorted.length} / ${local.rows.length} 个因子`;
      document.querySelectorAll("[data-pool-sort]").forEach(header => {
        const active = header.dataset.poolSort === local.sortKey;
        header.classList.toggle("sorted", active);
        header.setAttribute("aria-sort", active ? (local.sortDirection === "asc" ? "ascending" : "descending") : "none");
      });
      if (!sorted.length) {
        body.innerHTML = '<tr><td colspan="14" class="empty">没有匹配结果，请调整筛选条件。</td></tr>';
        return;
      }
      body.innerHTML = sorted.map(row => {
        const status = STATUS[row.effective_status] || STATUS.not_passed;
        const alpha = ALPHA_SOURCE[row.alpha_source] || "—";
        return `<tr data-factor-code="${text(row.factor_code)}">
          <td class="pool-left"><span class="pool-status ${status.className}">${status.label}</span></td>
          <td class="pool-left"><button class="pool-factor-open" type="button" data-factor-code="${text(row.factor_code)}"><b>${text(row.factor_code)}</b><span>${text(row.name_cn || "")}</span></button></td>
          <td class="pool-left"><span>${text(row.l1 || "—")}</span><small>${text(row.l2 || "")}</small></td>
          <td>${Number(row.n_months || 0)}</td>
          <td>${decimal(row.rank_ic_mean, 3, true)}</td>
          <td>${decimal(row.rank_ic_t, 2, true)}</td>
          <td>${percent(row.rank_ic_q_value, 1)}</td>
          <td>${decimal(row.monotonicity, 2, true)}</td>
          <td>${percent(row.long_excess_ann_return, 1, true)}</td>
          <td>${decimal(row.long_excess_sharpe, 2, true)}</td>
          <td>${percent(row.long_short_ann_return, 1, true)}</td>
          <td>${decimal(row.long_short_sharpe, 2, true)}</td>
          <td><span class="pool-alpha-source ${text(row.alpha_source || "weak")}">${text(alpha)}</span></td>
          <td>${percent(row.avg_score_coverage, 1)}</td>
        </tr>`;
      }).join("");
      body.querySelectorAll(".pool-factor-open").forEach(button => {
        button.onclick = () => openDetail(button.dataset.factorCode);
      });
    }

    function closeDetail() {
      local.selectedFactor = null;
      local.detailSequence++;
      if (local.quantileChart) local.quantileChart.dispose();
      if (local.monthlyChart) local.monthlyChart.dispose();
      local.quantileChart = null;
      local.monthlyChart = null;
      const panel = element("pool-factor-detail");
      if (panel) panel.hidden = true;
    }

    async function openDetail(code) {
      const row = local.rows.find(item => item.factor_code === code);
      if (!row) return;
      local.selectedFactor = code;
      const sequence = ++local.detailSequence;
      const panel = element("pool-factor-detail");
      const content = element("pool-factor-detail-content");
      panel.hidden = false;
      content.innerHTML = renderDetailHtml(row);
      element("pool-detail-close").onclick = closeDetail;
      element("pool-detail-single").onclick = () => config.openSingleFactor(code);
      renderQuantileChart(row);
      panel.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      try {
        const monthly = await loadMonthlyDetail(row);
        if (sequence !== local.detailSequence) return;
        renderMonthlyChart(monthly);
      } catch (error) {
        if (sequence !== local.detailSequence) return;
        element("pool-monthly-chart").innerHTML = `<div class="pool-error-inline">月度明细加载失败：${text(error?.message || error)}</div>`;
      }
    }

    function renderDetailHtml(row) {
      const status = STATUS[row.effective_status] || STATUS.not_passed;
      const pool = poolMeta();
      const benchmark = row.benchmark_source === "official_index_exact_period" ? "官方指数" : "股票池等权";
      return `
        <div class="pool-detail-head">
          <div>
            <div class="pool-detail-title-line"><h3 id="pool-detail-title">${text(row.factor_code)} · ${text(row.name_cn || "")}</h3><span class="pool-status ${status.className}">${status.label}</span></div>
            <p>${text(row.l1 || "—")} → ${text(row.l2 || "—")}；${text(pool?.pool_name || local.poolId)}；${local.scoreMode === "raw" ? "原始得分" : "行业市值中性化"}。</p>
          </div>
          <div class="pool-detail-actions"><button id="pool-detail-single" type="button">进入单因子分析</button><button id="pool-detail-close" type="button">关闭详情</button></div>
        </div>
        <div class="pool-evidence-strip">
          <div><span>有效月数</span><b>${Number(row.n_months || 0)}</b></div>
          <div><span>平均 RankIC</span><b>${decimal(row.rank_ic_mean, 3, true)}</b></div>
          <div><span>HAC t / FDR q</span><b>${decimal(row.rank_ic_t, 2, true)} / ${percent(row.rank_ic_q_value, 1)}</b></div>
          <div><span>Q5 超额夏普</span><b>${decimal(row.long_excess_sharpe, 2, true)}</b></div>
          <div><span>多空夏普</span><b>${decimal(row.long_short_sharpe, 2, true)}</b></div>
          <div><span>主要来源</span><b>${text(ALPHA_SOURCE[row.alpha_source] || "—")}</b></div>
        </div>
        <div class="pool-detail-grid">
          <section><h4>五分组平均月收益</h4><div id="pool-quantile-chart" class="pool-chart"></div></section>
          <section class="pool-alpha-explain"><h4>Alpha 贡献拆分</h4>
            <dl>
              <div><dt>多头端</dt><dd>Q5 相对${benchmark}的年化超额 <b>${percent(row.long_excess_ann_return, 1, true)}</b>，夏普 <b>${decimal(row.long_excess_sharpe, 2, true)}</b></dd></div>
              <div><dt>空头剔除</dt><dd>${benchmark}减 Q1 的年化贡献 <b>${percent(row.short_avoid_ann_return, 1, true)}</b>，夏普 <b>${decimal(row.short_avoid_sharpe, 2, true)}</b></dd></div>
              <div><dt>分层结构</dt><dd>Q1→Q5 单调性 <b>${decimal(row.monotonicity, 2, true)}</b>；Q5−Q1 年化 <b>${percent(row.long_short_ann_return, 1, true)}</b></dd></div>
            </dl>
            <p>“空头剔除”表示因子更适合排除潜在负 Alpha 股票，不等同于适合实际做空。</p>
          </section>
        </div>
        <section class="pool-monthly-section"><h4>月度 RankIC 与累计毛收益</h4><p>累计曲线分别复合 Q5 相对基准超额和 Q5−Q1 多空收益；未计交易成本。</p><div id="pool-monthly-chart" class="pool-chart pool-chart-wide"><div class="pool-skeleton"></div></div></section>`;
    }

    function renderQuantileChart(row) {
      if (!window.echarts) return;
      const node = element("pool-quantile-chart");
      if (!node) return;
      if (local.quantileChart) local.quantileChart.dispose();
      local.quantileChart = window.echarts.init(node);
      const values = [1, 2, 3, 4, 5].map(index => {
        const value = number(row[`q${index}_mean_return`]);
        return value === null ? null : +(value * 100).toFixed(2);
      });
      local.quantileChart.setOption({
        animationDuration: 180,
        grid: { left: 48, right: 18, top: 16, bottom: 34 },
        tooltip: { trigger: "axis", formatter: params => `${params[0].axisValue}<br>平均月收益：${params[0].data == null ? "—" : params[0].data.toFixed(2) + "%"}` },
        xAxis: { type: "category", data: ["Q1 低分", "Q2", "Q3", "Q4", "Q5 高分"], axisLabel: { fontSize: 10 } },
        yAxis: { type: "value", axisLabel: { formatter: "{value}%" }, splitLine: { lineStyle: { color: "#edf0f3" } } },
        series: [{ type: "bar", data: values, barMaxWidth: 34, itemStyle: { color: params => params.dataIndex === 4 ? "#1a4d80" : (params.dataIndex === 0 ? "#b9655a" : "#8ba7c0") } }],
      });
    }

    async function loadMonthlyDetail(row) {
      const poolId = safeId(local.poolId);
      const factorCode = safeId(row.factor_code);
      const path = `${rootPath}monthly/${poolId}.parquet${config.version}`;
      const result = await config.dbState.db.query(`
        SELECT strftime(signal_date, '%Y-%m') AS month,
               rank_ic, long_excess_return, long_short_return
        FROM read_parquet('${path}')
        WHERE score_mode = ${sqlLiteral(local.scoreMode)}
          AND factor_code = ${sqlLiteral(factorCode)}
          AND is_usable = TRUE
        ORDER BY signal_date
      `);
      return result.toArray();
    }

    function cumulative(rows, key) {
      let nav = 1;
      return rows.map(row => {
        const value = number(row[key]);
        if (value === null || value <= -1) return null;
        nav *= 1 + value;
        return +((nav - 1) * 100).toFixed(2);
      });
    }

    function renderMonthlyChart(rows) {
      const node = element("pool-monthly-chart");
      if (!node) return;
      if (!rows.length || !window.echarts) {
        node.innerHTML = '<div class="empty">该因子没有满足最小截面要求的月度明细。</div>';
        return;
      }
      node.innerHTML = "";
      if (local.monthlyChart) local.monthlyChart.dispose();
      local.monthlyChart = window.echarts.init(node);
      local.monthlyChart.setOption({
        animationDuration: 180,
        legend: { data: ["月度 RankIC", "累计 Q5 超额", "累计 Q5−Q1"], top: 0, textStyle: { fontSize: 11 } },
        grid: { left: 52, right: 58, top: 36, bottom: 46 },
        tooltip: { trigger: "axis", valueFormatter: value => value == null ? "—" : Number(value).toFixed(2) },
        dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 8 }],
        xAxis: { type: "category", data: rows.map(row => row.month), axisLabel: { fontSize: 10 } },
        yAxis: [
          { type: "value", name: "RankIC", nameTextStyle: { fontSize: 10 }, splitLine: { lineStyle: { color: "#edf0f3" } } },
          { type: "value", name: "累计收益 %", nameTextStyle: { fontSize: 10 }, axisLabel: { formatter: "{value}%" }, splitLine: { show: false } },
        ],
        series: [
          { name: "月度 RankIC", type: "bar", yAxisIndex: 0, data: rows.map(row => number(row.rank_ic)), itemStyle: { color: "#a9bac9" }, barMaxWidth: 12 },
          { name: "累计 Q5 超额", type: "line", yAxisIndex: 1, data: cumulative(rows, "long_excess_return"), showSymbol: false, lineStyle: { width: 2, color: "#1a4d80" }, itemStyle: { color: "#1a4d80" } },
          { name: "累计 Q5−Q1", type: "line", yAxisIndex: 1, data: cumulative(rows, "long_short_return"), showSymbol: false, lineStyle: { width: 1.6, color: "#ba6f37" }, itemStyle: { color: "#ba6f37" } },
        ],
      });
    }

    function renderMethodology() {
      const methodology = local.meta?.methodology || {};
      element("pool-methodology-content").innerHTML = `
        <dl>
          <div><dt>历史股票池</dt><dd>指数使用月末已公布成分；行业按历史纳入/剔除日期生成 PIT 申万一级分类，不用当前归属倒填。</dd></div>
          <div><dt>信号与收益</dt><dd>${text(methodology.signal_timing || "—")}；${text(methodology.cost_assumption || "—")}。</dd></div>
          <div><dt>分组</dt><dd>${text(methodology.score_direction || "—")}；${text(methodology.quantile_method || "—")}。</dd></div>
          <div><dt>超额基准</dt><dd>宽基：${text(methodology.index_benchmark || "—")}；行业：${text(methodology.industry_benchmark || "—")}。</dd></div>
          <div><dt>稳健有效</dt><dd>${text(methodology.robust_rule || "—")}。${text(methodology.multiple_testing || "")}</dd></div>
          <div><dt>观察期有效</dt><dd>${text(methodology.provisional_rule || "—")}；该状态只表示初步证据，不能与稳健有效等同。</dd></div>
        </dl>`;
    }

    function resize() {
      if (local.quantileChart) local.quantileChart.resize();
      if (local.monthlyChart) local.monthlyChart.resize();
    }

    return { render, resize, closeDetail };
  }

  window.FactorStockPoolResearch = { create };
})();
