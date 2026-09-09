(function () {
  "use strict";

  const OPERATION_LABELS = {
    mean: "均值",
    minimum: "较小值",
    maximum: "较大值",
    spread: "差值",
  };
  const GATE_STATUS = {
    not_evaluated: { label: "未完成", className: "pending" },
    pending: { label: "复核中", className: "pending" },
    passed: { label: "已通过", className: "passed" },
    failed: { label: "未通过", className: "failed" },
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function numberText(value, digits = 3) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "—";
  }

  function signedNumberText(value, digits = 3) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`;
  }

  function percentText(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(0)}%` : "—";
  }

  function expressionText(row) {
    const left = row.left_factor || "A";
    const right = row.right_factor || "B";
    if (row.operation === "mean") return `(${left} + ${right}) / 2`;
    if (row.operation === "minimum") return `min(${left}, ${right})`;
    if (row.operation === "maximum") return `max(${left}, ${right})`;
    if (row.operation === "spread") return `${left} − ${right}`;
    return row.candidate_code || "—";
  }

  function statusClass(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "neutral";
    return number >= 0 ? "positive" : "negative";
  }

  function selectionRowsHtml(rows) {
    return (rows || []).map(row => `
      <tr>
        <td class="expression-left">第${escapeHtml(row.fold)}折 · #${escapeHtml(row.selection_rank)}</td>
        <td class="expression-left">
          <b>${escapeHtml(expressionText(row))}</b>
          <small>${escapeHtml(OPERATION_LABELS[row.operation] || row.operation)} · ${escapeHtml(row.candidate_code)}</small>
        </td>
        <td>${escapeHtml(row.decision_date)}</td>
        <td>${escapeHtml(row.test_start_date)}～${escapeHtml(row.test_end_date)}</td>
        <td>${numberText(row.discovery_rank_ic_mean)}</td>
        <td>${numberText(row.discovery_q_value)}</td>
        <td>${numberText(row.validation_rank_ic_mean)}</td>
        <td class="expression-value ${statusClass(row.outer_test_rank_ic_mean)}">${signedNumberText(row.outer_test_rank_ic_mean)}</td>
        <td>${percentText(row.outer_test_positive_rate)}</td>
      </tr>`).join("");
  }

  function recurrenceRowsHtml(rows) {
    return (rows || []).map(row => `
      <tr>
        <td class="expression-left"><b>${escapeHtml(expressionText(row))}</b><small>${escapeHtml(row.candidate_code)}</small></td>
        <td>${escapeHtml(row.selected_folds)}</td>
        <td>${escapeHtml(row.evaluated_folds)}</td>
        <td class="expression-value ${statusClass(row.outer_test_rank_ic_mean)}">${signedNumberText(row.outer_test_rank_ic_mean)}</td>
        <td>${percentText(row.outer_test_positive_rate)}</td>
      </tr>`).join("");
  }

  function gatesHtml(gates) {
    return (gates || []).map(gate => {
      const status = GATE_STATUS[gate.status] || GATE_STATUS.not_evaluated;
      return `
      <li>
        <span class="expression-gate-status ${status.className}">${status.label}</span>
        <div><b>${escapeHtml(gate.label)}</b><span>${escapeHtml(gate.requirement)}</span></div>
      </li>`;
    }).join("");
  }

  function renderPayload(payload) {
    const counts = payload.counts || {};
    const config = payload.config || {};
    const pool = payload.pool || {};
    const selectionCount = (payload.selections || []).length;
    const gates = payload.promotion_gates || [];
    const passedGates = gates.filter(gate => gate.status === "passed").length;
    const gateSummary = passedGates === gates.length && gates.length
      ? "五项门槛均已通过数据复核，但仍需独立审批后才能登记生产因子。"
      : `当前通过${passedGates}/${gates.length}项；未全部通过，因此页面不提供“加入因子库”或“加入组合”操作。`;
    const operationText = (config.operations || []).map(item => OPERATION_LABELS[item] || item).join("、");
    return `
      <div class="expression-status" role="status">
        <span class="expression-status-badge">研究候选 · 只读</span>
        <div>
          <b>本页不注册因子，也不触发生产计算</b>
          <span>当前结果只用于查看嵌套样本外证据；任何候选进入因子库前仍需逐项通过人工晋级门槛。</span>
        </div>
      </div>

      <div class="expression-overview-grid" aria-label="表达式研究摘要">
        <div><span>研究股票池</span><strong>${escapeHtml(pool.pool_name || pool.pool_id || "—")}</strong><small>${escapeHtml(pool.pool_id || "—")}</small></div>
        <div><span>基础因子</span><strong>${escapeHtml(counts.base_factors ?? "—")}</strong><small>${escapeHtml((config.base_factors || []).join("、"))}</small></div>
        <div><span>结构化候选</span><strong>${escapeHtml(counts.candidates ?? "—")}</strong><small>${escapeHtml(operationText || "—")}</small></div>
        <div><span>外层测试折</span><strong>${escapeHtml(counts.folds_with_selection ?? "—")}</strong><small>每折最多选${escapeHtml(config.top_k ?? "—")}个</small></div>
        <div><span>已评估外层记录</span><strong>${escapeHtml(counts.evaluated_outer_test_rows ?? selectionCount)}</strong><small>测试窗${escapeHtml(config.test_months ?? "—")}个月</small></div>
        <div><span>收益实现截止</span><strong>${escapeHtml(payload.as_of_return_date || "—")}</strong><small>按真实return_date切分</small></div>
      </div>

      <section class="expression-section" aria-labelledby="expression-recurrence-title">
        <div class="expression-section-head">
          <div><h3 id="expression-recurrence-title">候选重复入选摘要</h3><p>仅按已完成的外层测试折做描述性汇总；均值为正不等于已达到生产准入条件。</p></div>
        </div>
        <div class="expression-table-scroll" role="region" aria-label="表达式候选重复入选摘要，可横向滚动" tabindex="0">
          <table class="expression-table">
            <thead><tr><th class="expression-left" scope="col">表达式</th><th scope="col">入选折数</th><th scope="col">已评估折数</th><th scope="col">外层测试平均RankIC</th><th scope="col">外层测试平均正IC占比</th></tr></thead>
            <tbody>${recurrenceRowsHtml(payload.candidate_recurrence)}</tbody>
          </table>
        </div>
      </section>

      <section class="expression-section" aria-labelledby="expression-fold-title">
        <div class="expression-section-head">
          <div><h3 id="expression-fold-title">逐折选择与未来测试</h3><p>发现期先做HAC检验与BH-FDR校正，内层验证通过后锁定候选，后续测试期不参与选择。</p></div>
        </div>
        <div class="expression-table-scroll expression-fold-scroll" role="region" aria-label="表达式逐折样本外结果，可横向和纵向滚动" tabindex="0">
          <table class="expression-table">
            <thead><tr><th class="expression-left" scope="col">折次</th><th class="expression-left" scope="col">表达式</th><th scope="col">决策日</th><th scope="col">外层测试期</th><th scope="col">发现期RankIC</th><th scope="col">发现期FDR q</th><th scope="col">验证期RankIC</th><th scope="col">外层RankIC</th><th scope="col">外层正IC占比</th></tr></thead>
            <tbody>${selectionRowsHtml(payload.selections)}</tbody>
          </table>
        </div>
      </section>

      <section class="expression-section expression-gates" aria-labelledby="expression-gates-title">
        <div class="expression-section-head">
          <div><h3 id="expression-gates-title">人工晋级门槛</h3><p>${escapeHtml(gateSummary)}</p></div>
          <a href="docs/2026-09-08_因子表达式挖掘研究框架.md" target="_blank" rel="noopener">查看完整研究口径</a>
        </div>
        <ol>${gatesHtml(gates)}</ol>
      </section>

      <details class="expression-methodology">
        <summary>数据口径、限制与证据文件</summary>
        <div class="expression-methodology-grid">
          <div><b>共同样本</b><span>${escapeHtml(payload.methodology?.common_sample || "—")}</span></div>
          <div><b>防泄漏</b><span>${escapeHtml(payload.methodology?.timing || "—")}</span></div>
          <div><b>候选选择</b><span>${escapeHtml(payload.methodology?.selection || "—")}</span></div>
          <div><b>外层测试</b><span>${escapeHtml(payload.methodology?.outer_test || "—")}</span></div>
        </div>
        <ul>${(payload.limitations || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        <div class="expression-assets">${(payload.assets || []).map(name => `<a href="data/expression_mining/HS300/${encodeURIComponent(name)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`).join("")}</div>
      </details>`;
  }

  function create(options = {}) {
    const root = document.querySelector(options.root || "#expression-research-content");
    if (!root) throw new Error("表达式研究容器不存在");
    const dataDir = options.dataDir || new URL("data/", document.baseURI).toString();
    const version = options.version || "";
    let payload = null;
    let loading = null;

    async function load() {
      const response = await fetch(`${dataDir}expression_mining/HS300/summary.json${version}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      if (next.production_registration !== false || next.status !== "research_candidates_only") {
        throw new Error("研究证据状态不符合只读展示约束");
      }
      const allowedGateStatuses = new Set(Object.keys(GATE_STATUS));
      if (!(next.promotion_gates || []).every(gate => allowedGateStatuses.has(gate.status))) {
        throw new Error("研究证据包含未知的晋级门槛状态");
      }
      return next;
    }

    async function render(force = false) {
      if (payload && !force) return;
      if (loading && !force) return loading;
      root.setAttribute("aria-busy", "true");
      root.innerHTML = `<div class="expression-loading" aria-live="polite"><span></span><span></span><span></span><span></span></div>`;
      loading = load()
        .then(next => {
          payload = next;
          root.innerHTML = renderPayload(payload);
        })
        .catch(error => {
          root.innerHTML = `<div class="expression-error" role="alert"><b>表达式研究证据加载失败</b><span>${escapeHtml(error.message || error)}</span><button type="button">重试</button></div>`;
          root.querySelector("button")?.addEventListener("click", () => render(true));
        })
        .finally(() => {
          root.removeAttribute("aria-busy");
          loading = null;
        });
      return loading;
    }

    return { render };
  }

  window.FactorExpressionResearch = { create };
})();
