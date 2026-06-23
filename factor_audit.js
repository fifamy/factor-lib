const DIR_LABEL = { "1": ["+", "fa-dir-pos"], "-1": ["−", "fa-dir-neg"] };
const RECON_LABEL = {
  match: ["✓一致", "b-ok"], mismatch: ["✗重算不符", "b-error"],
  no_ref: ["—未对账", "b-warn"], source_missing: ["✗源缺失", "b-error"], na: ["—", "b-warn"],
};
const HEALTH_LABEL = { ok: ["●正常", "b-ok"], warn: ["●可疑", "b-warn"], error: ["●有误", "b-error"] };
const DOC_MISSING_TIP = "Word 技术文档未单列该因子或未给公式，属于系统新增/待补文档项。";
const FORMULA_MISMATCH_TIP = "Word 文档公式与当前系统实现的计算口径不一致，需要决定按 Word 改系统，或反向修订 Word。";
const UNIVERSE_MISMATCH_TIP = "Word 文档股票池/样本空间规则与当前系统实际回测、IC、选股域不完全一致。";
const PARAMETER_MISMATCH_TIP = "Word 参数/窗口/子口径未被系统完整覆盖，需要判断是否补充实现或修订 Word 口径。";
const DATA_HISTORY_TIP = "该因子有效数据起步晚，历史回测只覆盖 Wind 当前可用期；早期月份为空通常不是页面漏算。";
const UNIVERSE_ALIGNED_TIP = "系统已按 Word 股票池/样本空间规则执行。";
const UNIVERSE_PROFILE_TIP = "Word 未单列该因子时，系统按分类映射的 Word 公共股票池执行。";
const ERROR_FLAGS = new Set(["nonfinite", "recon_mismatch", "recon_source_missing"]);
const SUPABASE_URL = "https://tsyplhfshxzoduynzixk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6osvaEI8pookLkmkzBUbHQ_kyUU2SKn";
const REVIEW_TABLE = "factor_reviews";
const REVIEW_UPSERT_CONFLICT = "on_conflict=factor_code,reviewer_name";
const REVIEWER_STORAGE_KEY = "fa_reviewer_name";
const REVIEW_STATUS_LABEL = {
  unreviewed: ["未复核", "rs-none", "还没有任何复核记录"],
  in_progress: ["进行中", "rs-pending", "已有复核记录，但尚未全部通过"],
  issue: ["有问题", "rs-issue", "至少一条复核记录标记为有问题或打回"],
  passed: ["通过", "rs-pass", "已有复核记录，且未发现问题"],
  unavailable: ["—", "rs-offline", "无法连接复核库，仅离线查看因子数据"],
};
const VERDICT_LABEL = {
  pass: "通过",
  issue: "有问题",
  unsure: "存疑",
};
const OVERALL_LABEL = {
  pass: "通过",
  reject: "打回",
  pending: "待定",
};
const FLAG_LABEL = {
  coverage_low: ["覆盖偏低", "有值的合格股不足 50%（多为业绩快报等事件因子、或数据源稀疏，通常正常）"],
  degenerate: ["常量截面", "某些月份该因子值几乎全相同，那个月没有区分度、排序无意义"],
  heavy_tail: ["厚尾", "存在极端值（稳健 z>50）。A股估值/成长/资金类因子天生厚尾，用前宜去极值；recon 一致即非计算错误"],
  outlier: ["量级异常", "|值|>100万（如比率分母接近 0 爆出大数、或资金流本就上亿）。recon 一致=真实极端值，非存储损坏"],
  nonfinite: ["非有限值", "存在 NaN/inf —— 几乎肯定计算有误（本工具的红灯目标，已全部修复）"],
  direction_ic_flip: ["方向疑反", "实测 RankIC 的方向与你声明的 +/− 系统性相反（|t|>2）。要么方向标反，要么该因子近年失效/反转，值得复核"],
  formula_mismatch: ["文档/系统不一致", FORMULA_MISMATCH_TIP],
  universe_mismatch: ["样本空间不一致", UNIVERSE_MISMATCH_TIP],
  parameter_mismatch: ["参数待补", PARAMETER_MISMATCH_TIP],
  recon_mismatch: ["对账不符", "独立重算 ≠ 系统存储值 —— 实现可能有 bug"],
  recon_source_missing: ["源缺失", "回查不到对应的 Wind 源数据"],
};
function flagInfo(f) {
  if (f.indexOf("coverage_late") === 0) {
    const m = (f.split(":")[1] || "");
    return ["数据起步晚" + (m ? ` (${m})` : ""), "该因子首个有效截面晚于 2016；请按 Wind 字段可用期理解早期缺失。"];
  }
  return FLAG_LABEL[f] || [f, ""];
}
function rowFlags(row) {
  return row?.flags || row?.health?.flags || [];
}
function coverageLateFlag(row) {
  return (rowFlags(row) || []).find(f => String(f).indexOf("coverage_late:") === 0) || "";
}
function hasCoverageLateFlag(row) {
  return Boolean(coverageLateFlag(row));
}
function monthLabel(value) {
  if (!value) return "";
  return String(value).slice(0, 7);
}
function dataHistoryText(row) {
  const flag = coverageLateFlag(row);
  if (!flag) return "";
  const metrics = row.health?.metrics || {};
  const start = monthLabel(row.coverage_period || metrics.coverage_period || flag.split(":")[1]);
  const end = monthLabel(row.coverage_last_period || metrics.coverage_last_period);
  const months = row.coverage_months || metrics.coverage_months;
  const coverage = row.coverage ?? row.dist?.coverage ?? metrics.coverage;
  const spanText = months ? `，约 ${months} 个月` : "";
  const endText = end ? `，截至 ${end}` : "";
  const coverageText = coverage !== null && coverage !== undefined ? `；当前覆盖率约 ${pct(coverage).toFixed(0)}%` : "";
  return `有效数据从 ${start || "较晚月份"} 起${endText}${spanText}${coverageText}。${DATA_HISTORY_TIP}`;
}
function flagChip(f) {
  const [lab, tip] = flagInfo(f);
  return `<span class="fa-flag ${ERROR_FLAGS.has(f) ? "err" : ""}" title="${esc(tip)}">${esc(lab)}</span>`;
}

let ALL = [];
let filter = "all";
let query = "";
let currentView = "list";
let reviewerName = "";
let reviewRecords = [];
let reviewAgg = {};
let reviewLoadError = "";
let auditGeneratedAt = "";

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}
async function supabaseFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, opts);
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch (_) { payload = text; }
  }
  if (!res.ok) {
    const msg = payload?.message || payload?.error || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload || [];
}
async function supabaseSelect(table, queryText = "") {
  return supabaseFetch(`/rest/v1/${table}${queryText}`, {
    headers: supabaseHeaders(),
  });
}
async function supabaseUpsert(table, rows, conflictColumns) {
  return supabaseFetch(`/rest/v1/${table}?on_conflict=${conflictColumns}`, {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(rows),
  });
}
function inferOverallVerdict(formulaVerdict, universeVerdict) {
  const formula = formulaVerdict || "unsure";
  const universe = universeVerdict || "unsure";
  if (formula === "issue" || universe === "issue") return "reject";
  if (formula === "unsure" || universe === "unsure") return "pending";
  return "pass";
}
function reviewRecordHasIssue(r) {
  return r?.formula_verdict === "issue" || r?.universe_verdict === "issue" || r?.overall_verdict === "reject";
}
function reviewRecordIsPassed(r) {
  const overall = r?.overall_verdict || inferOverallVerdict(r?.formula_verdict, r?.universe_verdict);
  return r?.formula_verdict === "pass" && r?.universe_verdict === "pass" && overall === "pass";
}
function deriveReviewStatus(records) {
  const rows = (records || []).filter(Boolean);
  if (!rows.length) return "unreviewed";
  if (rows.some(reviewRecordHasIssue)) return "issue";
  if (rows.every(reviewRecordIsPassed)) return "passed";
  return "in_progress";
}
function aggregateReviews(records) {
  const grouped = {};
  (records || []).forEach(r => {
    const code = r.factor_code || "";
    if (!code) return;
    if (!grouped[code]) grouped[code] = { records: [], status: "unreviewed" };
    grouped[code].records.push(r);
  });
  Object.keys(grouped).forEach(code => {
    grouped[code].status = deriveReviewStatus(grouped[code].records);
  });
  return grouped;
}
async function loadAllReviews() {
  const cols = "id,factor_code,reviewer_name,category,formula_verdict,universe_verdict,overall_verdict,problem,suggestion,system_version,created_at,updated_at";
  return supabaseSelect(REVIEW_TABLE, `?select=${cols}&order=updated_at.desc`);
}
async function loadFactorReviews(code) {
  const cols = "id,factor_code,reviewer_name,category,formula_verdict,universe_verdict,overall_verdict,problem,suggestion,system_version,created_at,updated_at";
  return supabaseSelect(REVIEW_TABLE, `?select=${cols}&factor_code=eq.${encodeURIComponent(code)}&order=updated_at.desc`);
}
function humanReviewError(error) {
  const raw = String(error?.message || error || "");
  if (raw.includes("factor_reviews") && raw.includes("schema cache")) {
    return "复核库尚未初始化：需要先在 Supabase 执行 supabase/schema.sql 中的 factor_reviews 建表 SQL。";
  }
  if (raw.includes("Failed to fetch") || raw.includes("NetworkError")) {
    return "无法连接复核库，请确认当前网络可访问 Supabase。";
  }
  return raw || "无法连接复核库";
}
async function saveMyReview(factor, values) {
  const name = currentReviewerName();
  if (!name) throw new Error("请先填写姓名");
  const formulaVerdict = values.formula_verdict || "unsure";
  const universeVerdict = values.universe_verdict || "unsure";
  const row = {
    factor_code: factor.code,
    reviewer_name: name,
    category: factor.doc_missing ? "no_word" : "with_word",
    formula_verdict: formulaVerdict,
    universe_verdict: universeVerdict,
    overall_verdict: values.overall_verdict || inferOverallVerdict(formulaVerdict, universeVerdict),
    problem: values.problem || "",
    suggestion: values.suggestion || "",
    system_version: values.system_version || "",
  };
  const saved = await supabaseUpsert(REVIEW_TABLE, [row], REVIEW_UPSERT_CONFLICT.replace("on_conflict=", ""));
  return Array.isArray(saved) ? saved[0] : saved;
}
function currentReviewerName() {
  return reviewerName.trim();
}
function reviewStatusForFactor(code) {
  if (reviewLoadError) return "unavailable";
  return reviewAgg[code]?.status || "unreviewed";
}
function factorByCode(code) {
  return ALL.find(f => f.code === code);
}
function formatTime(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("zh-CN", { hour12: false });
}
function setReviewerName(name) {
  reviewerName = String(name || "").trim();
  try { localStorage.setItem(REVIEWER_STORAGE_KEY, reviewerName); }
  catch (_) {}
  const input = document.getElementById("fa-reviewer-name");
  const badgeEl = document.getElementById("fa-reviewer-badge");
  if (input && input.value !== reviewerName) input.value = reviewerName;
  if (badgeEl) {
    badgeEl.textContent = reviewerName ? `当前：${reviewerName}` : "未填写";
    badgeEl.classList.toggle("empty", !reviewerName);
  }
}
function initReviewerIdentity() {
  let stored = "";
  try { stored = localStorage.getItem(REVIEWER_STORAGE_KEY) || ""; }
  catch (_) {}
  setReviewerName(stored);
  const input = document.getElementById("fa-reviewer-name");
  if (input) {
    input.addEventListener("input", e => {
      setReviewerName(e.target.value);
      const openCode = document.getElementById("fa-review-panel")?.dataset.code;
      const factor = openCode ? factorByCode(openCode) : null;
      if (factor) {
        const detailFactor = { ...factor, code: openCode };
        const records = reviewAgg[openCode]?.records || [];
        const root = document.getElementById("fa-review-root");
        if (root) {
          root.innerHTML = renderReviewPanelHtml(detailFactor, records, reviewLoadError);
          wireReviewPanel(detailFactor);
        }
      }
    });
  }
}
function segmentedGroup(field, options, current, disabled) {
  return `<div class="fa-segmented" data-field="${esc(field)}">${options.map(([value, label]) =>
    `<button type="button" data-value="${esc(value)}" class="${value === current ? "active" : ""}"${disabled ? " disabled" : ""}>${esc(label)}</button>`
  ).join("")}</div>`;
}
function reviewBadge(value, labels) {
  const cls = value === "pass" ? "rs-pass" : value === "issue" || value === "reject" ? "rs-issue" : "rs-pending";
  return `<span class="fa-review-status ${cls}">${esc(labels[value] || value || "—")}</span>`;
}
function renderReviewRecords(records) {
  const rows = (records || []).slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  if (!rows.length) return `<div class="fa-empty">暂无复核记录</div>`;
  return rows.map(r => `
    <div class="fa-review-record">
      <div class="fa-review-record-head">
        <b>${esc(r.reviewer_name || "未命名")}</b>
        <span>${reviewBadge(r.formula_verdict, VERDICT_LABEL)} ${reviewBadge(r.universe_verdict, VERDICT_LABEL)} ${reviewBadge(r.overall_verdict, OVERALL_LABEL)}</span>
      </div>
      <div class="fa-review-record-time">${esc(formatTime(r.updated_at || r.created_at))}</div>
      ${r.problem ? `<div class="fa-review-text"><b>问题：</b>${esc(r.problem)}</div>` : ""}
      ${r.suggestion ? `<div class="fa-review-text"><b>建议：</b>${esc(r.suggestion)}</div>` : ""}
    </div>`).join("");
}
function renderReviewPanelHtml(factor, records, errorText) {
  const name = currentReviewerName();
  const disabled = !name;
  const mine = (records || []).find(r => (r.reviewer_name || "").trim() === name);
  const formulaVerdict = mine?.formula_verdict || "unsure";
  const universeVerdict = mine?.universe_verdict || "unsure";
  const overallVerdict = mine?.overall_verdict || inferOverallVerdict(formulaVerdict, universeVerdict);
  const formulaLabel = factor.doc_missing ? "系统公式是否正确" : "公式核对";
  const categoryTip = factor.doc_missing
    ? `<div class="fa-doc-alert"><b>Word 无对应，请判断系统实现是否正确。</b> 该记录保存为 no_word 类别。</div>`
    : "";
  const disabledTip = disabled ? `<div class="fa-doc-alert">请先在顶部「我是谁」填写姓名，再保存复核。</div>` : "";
  const errorTip = errorText ? `<div class="fa-formula-alert">复核记录加载失败：${esc(errorText)}。因子展示仍可离线查看；保存需要联网。</div>` : "";
  return `
    <div id="fa-review-panel" class="fa-review-panel" data-code="${esc(factor.code)}">
      <h3>人工复核 / 签字确认</h3>
      ${categoryTip}
      ${disabledTip}
      ${errorTip}
      <div class="fa-review-grid">
        <label><span>${esc(formulaLabel)}</span>${segmentedGroup("formula_verdict", [["pass", "通过"], ["issue", "有问题"], ["unsure", "存疑"]], formulaVerdict, disabled)}</label>
        <label><span>样本空间核对</span>${segmentedGroup("universe_verdict", [["pass", "通过"], ["issue", "有问题"], ["unsure", "存疑"]], universeVerdict, disabled)}</label>
        <label><span>总体结论</span>${segmentedGroup("overall_verdict", [["pass", "通过"], ["reject", "打回"], ["pending", "待定"]], overallVerdict, disabled)}</label>
      </div>
      <label class="fa-review-field">问题描述
        <textarea id="fa-review-problem" rows="3"${disabled ? " disabled" : ""}>${esc(mine?.problem || "")}</textarea>
      </label>
      <label class="fa-review-field">建议如何改
        <textarea id="fa-review-suggestion" rows="3"${disabled ? " disabled" : ""}>${esc(mine?.suggestion || "")}</textarea>
      </label>
      <div class="fa-review-actions">
        <button id="fa-save-review" type="button"${disabled ? " disabled" : ""}>保存复核</button>
        <span id="fa-review-save-status">${mine ? `我的复核已保存于 ${esc(formatTime(mine.updated_at || mine.created_at))}` : ""}</span>
      </div>
      <div class="fa-review-others">
        <h4>所有人的复核</h4>
        ${renderReviewRecords(records)}
      </div>
    </div>`;
}
function getSegmentedValue(field) {
  return document.querySelector(`#fa-review-panel .fa-segmented[data-field="${field}"] button.active`)?.dataset.value || "";
}
function wireReviewPanel(factor) {
  const panel = document.getElementById("fa-review-panel");
  if (!panel) return;
  panel.querySelectorAll(".fa-segmented button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const group = btn.closest(".fa-segmented");
      group.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      if (group.dataset.field === "formula_verdict" || group.dataset.field === "universe_verdict") {
        const overall = inferOverallVerdict(getSegmentedValue("formula_verdict"), getSegmentedValue("universe_verdict"));
        const overallBtn = panel.querySelector(`.fa-segmented[data-field="overall_verdict"] button[data-value="${overall}"]`);
        if (overallBtn) {
          overallBtn.closest(".fa-segmented").querySelectorAll("button").forEach(x => x.classList.remove("active"));
          overallBtn.classList.add("active");
        }
      }
    });
  });
  const saveBtn = document.getElementById("fa-save-review");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const status = document.getElementById("fa-review-save-status");
      const values = {
        formula_verdict: getSegmentedValue("formula_verdict"),
        universe_verdict: getSegmentedValue("universe_verdict"),
        overall_verdict: getSegmentedValue("overall_verdict"),
        problem: document.getElementById("fa-review-problem")?.value || "",
        suggestion: document.getElementById("fa-review-suggestion")?.value || "",
        system_version: auditGeneratedAt || "",
      };
      saveBtn.disabled = true;
      if (status) {
        status.textContent = "保存中…";
        status.className = "";
      }
      try {
        await saveMyReview(factor, values);
        await refreshAllReviews();
        const records = await loadFactorReviews(factor.code);
        reviewRecords = reviewRecords.filter(r => r.factor_code !== factor.code).concat(records);
        reviewAgg = aggregateReviews(reviewRecords);
        const root = document.getElementById("fa-review-root");
        if (root) {
          root.innerHTML = renderReviewPanelHtml(factor, records, "");
          wireReviewPanel(factor);
          const ok = document.getElementById("fa-review-save-status");
          if (ok) {
            ok.textContent = "已保存";
            ok.className = "fa-recon-ok";
          }
        }
        render();
      } catch (e) {
        saveBtn.disabled = false;
        if (status) {
          status.textContent = `保存失败：${humanReviewError(e)}`;
          status.className = "fa-recon-bad";
        }
      }
    });
  }
}
async function refreshFactorReviewPanel(factor) {
  const root = document.getElementById("fa-review-root");
  if (!root) return;
  if (reviewLoadError) {
    root.innerHTML = renderReviewPanelHtml(factor, reviewAgg[factor.code]?.records || [], reviewLoadError);
    wireReviewPanel(factor);
    return;
  }
  try {
    const records = await loadFactorReviews(factor.code);
    reviewRecords = reviewRecords.filter(r => r.factor_code !== factor.code).concat(records);
    reviewAgg = aggregateReviews(reviewRecords);
    root.innerHTML = renderReviewPanelHtml(factor, records, "");
    wireReviewPanel(factor);
    render();
  } catch (e) {
    root.innerHTML = renderReviewPanelHtml(factor, reviewAgg[factor.code]?.records || [], humanReviewError(e));
    wireReviewPanel(factor);
  }
}
async function refreshAllReviews() {
  try {
    reviewLoadError = "";
    reviewRecords = await loadAllReviews();
    reviewAgg = aggregateReviews(reviewRecords);
  } catch (e) {
    reviewLoadError = humanReviewError(e);
    reviewRecords = [];
    reviewAgg = {};
  }
}
function statusCounts() {
  const counts = { unreviewed: 0, in_progress: 0, issue: 0, passed: 0, unavailable: 0 };
  ALL.forEach(f => {
    const status = reviewStatusForFactor(f.code);
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}
function renderMiniProgress(counts) {
  if (reviewLoadError) {
    return `
      <div class="fa-progress-top">
        <div><b>无法统计</b></div>
        <div>复核库未连接</div>
      </div>
      <div class="fa-formula-alert">无法连接复核库：${esc(reviewLoadError)}。当前仅离线查看因子数据，复核进度需要联网读取。</div>`;
  }
  const total = Math.max(ALL.length, 1);
  const reviewed = counts.in_progress + counts.issue + counts.passed;
  const pctDone = Math.round((reviewed / total) * 100);
  return `
    <div class="fa-progress-top">
      <div><b>${reviewed}</b> / ${ALL.length} 已复核</div>
      <div>有问题 ${counts.issue} · 未复核 ${counts.unreviewed}</div>
    </div>
    <div class="fa-progress"><i style="width:${pctDone}%"></i></div>`;
}
function renderReviewDashboard() {
  const dashboard = document.getElementById("fa-dashboard");
  if (!dashboard || !ALL.length) return;
  const counts = statusCounts();
  const progressEl = document.getElementById("fa-review-progress");
  if (progressEl) progressEl.innerHTML = renderMiniProgress(counts);

  const reviewerMap = {};
  reviewRecords.forEach(r => {
    const name = r.reviewer_name || "未命名";
    if (!reviewerMap[name]) reviewerMap[name] = { reviewed: new Set(), issues: 0 };
    reviewerMap[name].reviewed.add(r.factor_code);
    if (reviewRecordHasIssue(r)) reviewerMap[name].issues += 1;
  });
  const reviewerRows = Object.entries(reviewerMap)
    .sort((a, b) => b[1].reviewed.size - a[1].reviewed.size || a[0].localeCompare(b[0], "zh"))
    .map(([name, stat]) => `<button type="button" class="fa-review-list-row"><b>${esc(name)}</b><span>${stat.reviewed.size} 个 · 问题 ${stat.issues}</span></button>`)
    .join("");
  document.getElementById("fa-reviewer-summary").innerHTML = reviewerRows || `<div class="fa-empty">暂无复核人</div>`;

  const issueRows = reviewRecords
    .filter(reviewRecordHasIssue)
    .map(r => {
      const factor = factorByCode(r.factor_code);
      const summary = r.problem || r.suggestion || "未填写问题摘要";
      return `<button type="button" class="fa-review-list-row" data-code="${esc(r.factor_code)}">
        <b>${esc(r.factor_code)} ${factor ? `· ${esc(factor.name_cn)}` : ""}</b>
        <span>${esc(r.reviewer_name || "")}：${esc(summary).slice(0, 80)}</span>
      </button>`;
    })
    .join("");
  document.getElementById("fa-review-issue-list").innerHTML = reviewLoadError
    ? `<div class="fa-empty">复核库未连接，暂不能统计有问题记录</div>`
    : (issueRows || `<div class="fa-empty">暂无有问题记录</div>`);

  const unreviewedRows = reviewLoadError ? "" : ALL
    .filter(f => reviewStatusForFactor(f.code) === "unreviewed")
    .map(f => `<button type="button" class="fa-review-list-row" data-code="${esc(f.code)}"><b>${esc(f.code)} · ${esc(f.name_cn)}</b><span>${esc(f.l1)} / ${esc(f.l2)}</span></button>`)
    .join("");
  document.getElementById("fa-review-unreviewed-list").innerHTML = reviewLoadError
    ? `<div class="fa-empty">复核库未连接，暂不能统计未复核清单</div>`
    : (unreviewedRows || `<div class="fa-empty">所有因子已有复核记录</div>`);

  dashboard.querySelectorAll("[data-code]").forEach(btn =>
    btn.addEventListener("click", () => openDetail(btn.dataset.code)));
}
function csvCell(value) {
  const s = String(value === null || value === undefined ? "" : value);
  return `"${s.replace(/"/g, '""')}"`;
}
function exportReviewsCsv() {
  const columns = [
    "factor_code", "reviewer_name", "category", "formula_verdict", "universe_verdict",
    "overall_verdict", "problem", "suggestion", "system_version", "created_at", "updated_at",
  ];
  const rows = [columns.join(",")].concat(reviewRecords.map(r => columns.map(c => csvCell(r[c])).join(",")));
  const blob = new Blob([`\ufeff${rows.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `factor_reviews_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function setView(view) {
  currentView = view === "dashboard" ? "dashboard" : "list";
  document.querySelectorAll(".fa-view-toggle button").forEach(btn =>
    btn.classList.toggle("active", btn.dataset.view === currentView));
  document.getElementById("fa-table").classList.toggle("hidden", currentView !== "list");
  document.getElementById("fa-dashboard").classList.toggle("hidden", currentView !== "dashboard");
  renderReviewDashboard();
}

function spark(hist) {
  const max = Math.max(1, ...hist);
  return `<span class="fa-spark">${hist.map(h =>
    `<i style="height:${Math.round((h / max) * 22)}px"></i>`).join("")}</span>`;
}
function dirCell(d) {
  const [t, cls] = DIR_LABEL[String(d)] || ["?", ""];
  return `<span class="${cls}">${t}</span>`;
}
function badge(map, key) {
  const [t, cls] = map[key] || ["—", ""];
  return `<span class="fa-badge ${cls}">${t}</span>`;
}
function issueBadge(text, cls, tip) {
  return `<span class="fa-badge ${cls}" title="${esc(tip)}">${esc(text)}</span>`;
}
function formulaStatusCell(f) {
  if (f.doc_missing) return issueBadge("Word未收录", "b-warn", DOC_MISSING_TIP);
  if (f.formula_mismatch) return issueBadge("口径不一致", "b-warn", FORMULA_MISMATCH_TIP);
  return issueBadge("公式一致", "b-ok", "Word 公式与系统实现未发现口径冲突。");
}
function universeStatusCell(f) {
  if (f.universe_mismatch) return issueBadge("样本不一致", "b-warn", UNIVERSE_MISMATCH_TIP);
  if (f.doc_missing) return issueBadge("按分类执行", "b-ok", UNIVERSE_PROFILE_TIP);
  return issueBadge("已按Word", "b-ok", UNIVERSE_ALIGNED_TIP);
}
function parameterStatusCell(f) {
  if (f.parameter_mismatch) return issueBadge("参数待补", "b-warn", PARAMETER_MISMATCH_TIP);
  if (f.doc_missing) return issueBadge("Word未列", "b-warn", DOC_MISSING_TIP);
  return issueBadge("参数覆盖", "b-ok", "未发现 Word 参数与系统实现存在明显覆盖缺口。");
}
function reviewStatusCell(f) {
  const status = reviewStatusForFactor(f.code);
  const [text, cls, tip] = REVIEW_STATUS_LABEL[status] || REVIEW_STATUS_LABEL.unreviewed;
  const count = reviewAgg[f.code]?.records?.length || 0;
  const label = count ? `${text} · ${count}` : text;
  return `<span class="fa-review-status ${cls}" title="${esc(tip)}">${esc(label)}</span>`;
}
function renderParamList(items) {
  const rows = (items || []).filter(Boolean);
  if (!rows.length) return `<span class="fa-empty">—</span>`;
  return `<div class="fa-param-list">${rows.map(x => `<span>${esc(x)}</span>`).join("")}</div>`;
}
function renderParameterCoverageBlock(d) {
  const pc = d.parameter_coverage || {};
  const level = pc.level || "none";
  const alertCls = level === "warn" ? "fa-param-alert" : "fa-doc-alert";
  const title = pc.needs_supplement ? "建议补充：" : "状态：";
  const reason = pc.reason || (level === "none" ? "Word 技术文档未单列该因子，暂无 Word 参数可比。" : "未发现明显参数覆盖缺口。");
  return `
    <div class="fa-block"><h3>参数覆盖</h3>
      <div class="${alertCls}"><b>${title}</b>${esc(reason)}</div>
      <table class="fa-kv">
        <tr><td>Word 参数</td><td>${renderParamList(pc.word_parameters || [])}</td></tr>
        <tr><td>系统已实现参数</td><td>${renderParamList(pc.system_parameters || [])}</td></tr>
        <tr><td>补充建议</td><td>${esc(pc.suggestion || "—")}</td></tr>
      </table></div>`;
}
function renderDataHistoryWarning(d) {
  const text = dataHistoryText(d);
  if (!text) return "";
  return `<div class="fa-data-alert"><b>数据历史提示：</b>${esc(text)}</div>`;
}
function matchRow(f) {
  if (filter === "suspect" && f.health === "ok") return false;
  if (filter === "error" && f.health !== "error") return false;
  if (filter === "data_late" && !hasCoverageLateFlag(f)) return false;
  if (filter === "doc_missing" && !f.doc_missing) return false;
  if (filter === "formula_mismatch" && !f.formula_mismatch) return false;
  if (filter === "universe_mismatch" && !f.universe_mismatch) return false;
  if (filter === "parameter_mismatch" && !f.parameter_mismatch) return false;
  if (filter.indexOf("review_") === 0) {
    const status = filter.replace("review_", "");
    const normalized = status === "pass" ? "passed" : status;
    if (reviewStatusForFactor(f.code) !== normalized) return false;
  }
  if (query) {
    const hay = `${f.code} ${f.name_cn} ${f.l1} ${f.l2}`.toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}
function rowHtml(f) {
  const dataHistoryBadge = hasCoverageLateFlag(f)
    ? `<span class="fa-data-late" title="${esc(dataHistoryText(f))}">数据短</span>`
    : "";
  return `
    <tr class="fa-row lv-${f.health}" data-code="${f.code}">
      <td><span class="fa-code">${esc(f.code)}</span><span class="fa-name">${esc(f.name_cn)}</span>${dataHistoryBadge}${f.doc_missing ? `<span class="fa-doc-missing" title="${esc(DOC_MISSING_TIP)}">Word缺</span>` : ""}${f.formula_mismatch ? `<span class="fa-formula-mismatch" title="${esc(FORMULA_MISMATCH_TIP)}">口径异</span>` : ""}${f.universe_mismatch ? `<span class="fa-formula-mismatch" title="${esc(UNIVERSE_MISMATCH_TIP)}">样本异</span>` : ""}${f.parameter_mismatch ? `<span class="fa-formula-mismatch" title="${esc(PARAMETER_MISMATCH_TIP)}">参数待补</span>` : ""}</td>
      <td>${esc(f.l1)} / ${esc(f.l2)}</td>
      <td>${formulaStatusCell(f)}</td>
      <td>${universeStatusCell(f)}</td>
      <td>${parameterStatusCell(f)}</td>
      <td>${reviewStatusCell(f)}</td>
      <td class="fa-help" title="真实覆盖 ${(Math.max(Number(f.coverage) || 0, 0) * 100).toFixed(0)}%${f.coverage > 1.001 ? '（含超出 Word 股票池样本）' : ''}">${pct(f.coverage).toFixed(0)}%</td>
      <td>${spark(f.hist)}</td>
      <td>${dirCell(f.direction)}</td>
      <td>${badge(RECON_LABEL, f.recon)}</td>
      <td class="fa-help" title="${esc((f.flags || []).map(x => flagInfo(x)[0]).join("、") || "无异常")}">${badge(HEALTH_LABEL, f.health)}</td>
    </tr>`;
}
function render() {
  // 按 一级/二级分类 分组：每组前插一行分类标题
  const rows = ALL.filter(matchRow).slice().sort((a, b) =>
    `${a.l1}${a.l2}${a.code}`.localeCompare(`${b.l1}${b.l2}${b.code}`, "zh"));
  const catCount = {};
  rows.forEach(f => { const k = `${f.l1} › ${f.l2}`; catCount[k] = (catCount[k] || 0) + 1; });
  let html = "", curCat = null;
  for (const f of rows) {
    const cat = `${f.l1} › ${f.l2}`;
    if (cat !== curCat) {
      curCat = cat;
      const warn = rows.filter(x => `${x.l1} › ${x.l2}` === cat && x.health !== "ok").length;
      html += `<tr class="fa-group"><td colspan="11">${esc(f.l1)} <span class="fa-group-sub">› ${esc(f.l2)}</span>` +
        `<span class="fa-group-n">${catCount[cat]} 个${warn ? ` · ${warn} 可疑` : ""}</span></td></tr>`;
    }
    html += rowHtml(f);
  }
  document.getElementById("fa-tbody").innerHTML = html || `<tr><td colspan="11" style="padding:16px;color:#8a94a6">无匹配因子</td></tr>`;
  const reviewed = ALL.filter(f => reviewStatusForFactor(f.code) !== "unreviewed" && reviewStatusForFactor(f.code) !== "unavailable").length;
  const issue = ALL.filter(f => reviewStatusForFactor(f.code) === "issue").length;
  const reviewText = reviewLoadError ? "复核库离线" : `已复核 ${reviewed} · 有问题 ${issue}`;
  document.getElementById("fa-stat").textContent =
    `${rows.length}/${ALL.length} 个因子 · 可疑 ${ALL.filter(f => f.health === "warn").length} · 错误 ${ALL.filter(f => f.health === "error").length} · 数据起步晚 ${ALL.filter(hasCoverageLateFlag).length} · Word未收录 ${ALL.filter(f => f.doc_missing).length} · 口径不一致 ${ALL.filter(f => f.formula_mismatch).length} · 样本空间不一致 ${ALL.filter(f => f.universe_mismatch).length} · 参数待补 ${ALL.filter(f => f.parameter_mismatch).length} · ${reviewText}`;
  document.querySelectorAll(".fa-row").forEach(tr =>
    tr.addEventListener("click", () => openDetail(tr.dataset.code)));
  renderReviewDashboard();
}
async function openDetail(code) {
  const drawer = document.getElementById("fa-drawer");
  const box = document.getElementById("fa-detail");
  box.innerHTML = `<p class="fa-detail-sub">加载 ${code} …</p>`;
  drawer.classList.remove("hidden");
  let d;
  try {
    d = await (await fetch(`data/factor_audit/${code}.json?v=${Date.now()}`)).json();
  } catch (e) {
    box.innerHTML = `<p class="fa-recon-bad">加载失败：${code}</p>`;
    return;
  }
  const s = d.sample || {};
  const recon = d.recon || {};
  const reconOk = recon.status === "match";
  const sampleLine = (s.recomputed !== null && s.recomputed !== undefined)
    ? `重算 ${fmt(s.recomputed)} vs 存储 ${fmt(s.stored)} → <span class="${s.match ? "fa-recon-ok" : "fa-recon-bad"}">${s.match ? "✓一致" : "✗不符"}</span>`
    : `存储值 ${fmt(s.stored)}（外部源类，见对账）`;
  box.innerHTML = `
    <h2 class="fa-detail-h">${esc(d.code)} · ${esc(d.name_cn)}</h2>
    <div class="fa-detail-sub">${esc(d.l1)} / ${esc(d.l2)} · 方向 ${dirCell(d.direction)} · 体检 ${badge(HEALTH_LABEL, d.health.level)}${d.doc_missing ? ` · <span class="fa-doc-missing" title="${esc(DOC_MISSING_TIP)}">Word缺</span>` : ""}${d.formula_mismatch && d.formula_mismatch.level === "warn" ? ` · <span class="fa-formula-mismatch" title="${esc(FORMULA_MISMATCH_TIP)}">口径异</span>` : ""}${d.universe_mismatch && d.universe_mismatch.level === "warn" ? ` · <span class="fa-formula-mismatch" title="${esc(UNIVERSE_MISMATCH_TIP)}">样本异</span>` : ""}${d.parameter_coverage && d.parameter_coverage.level === "warn" ? ` · <span class="fa-formula-mismatch" title="${esc(PARAMETER_MISMATCH_TIP)}">参数待补</span>` : ""}</div>
    ${renderDataHistoryWarning(d)}
    <div class="fa-block"><h3>公式对照</h3>
      ${d.doc_missing ? `<div class="fa-doc-alert">Word 技术文档未单列该因子或未给公式；下方“系统实现/Wind 字段”可作为补文档依据。</div>` : ""}
      ${d.formula_mismatch && d.formula_mismatch.level === "warn" ? `<div class="fa-formula-alert"><b>文档/系统口径不一致：</b>${esc(d.formula_mismatch.reason || "")}${d.formula_mismatch.word_scope ? `<br>Word：${esc(d.formula_mismatch.word_scope)}` : ""}${d.formula_mismatch.system_scope ? `<br>系统：${esc(d.formula_mismatch.system_scope)}` : ""}</div>` : ""}
      <table class="fa-kv">
        <tr><td>文档公式</td><td>${d.formula.doc_tex
          ? `<div id="fa-doc-eq" class="fa-eq"></div>${d.formula.doc_note ? `<div class="fa-note">其中：${esc(d.formula.doc_note)}</div>` : ""}`
          : `<span class="fa-mono">${esc(d.formula.doc) || "—"}</span>`}</td></tr>
        <tr><td>系统实现</td><td class="fa-mono">${esc(d.formula.system) || "—"}</td></tr>
        <tr><td>Wind 字段</td><td class="fa-mono">${esc(d.formula.wind) || "—"}</td></tr>
      </table></div>
    ${renderParameterCoverageBlock(d)}
    <div class="fa-block"><h3>样本空间对照</h3>
      ${d.universe_mismatch && d.universe_mismatch.level === "warn" ? `<div class="fa-formula-alert"><b>文档/系统样本空间不一致：</b>${esc(d.universe_mismatch.reason || "")}</div>` : ""}
      ${d.universe_mismatch && d.universe_mismatch.level === "ok" && d.universe_mismatch.reason ? `<div class="fa-doc-alert"><b>样本空间状态：</b>${esc(d.universe_mismatch.reason || "")}</div>` : ""}
      <table class="fa-kv">
        <tr><td>Word 样本空间是否统一</td><td>${esc((d.universe_mismatch && d.universe_mismatch.word_uniformity) || "—")}</td></tr>
        <tr><td>当前因子样本空间类别</td><td>${esc((d.universe_mismatch && d.universe_mismatch.word_profile_label) || "—")}</td></tr>
        <tr><td>Word 股票池</td><td>${esc((d.universe_mismatch && d.universe_mismatch.word_scope) || (d.doc_missing ? "Word 未单列该因子，暂无可对照股票池规则。" : "—"))}</td></tr>
        <tr><td>系统实际样本空间</td><td>${esc((d.universe_mismatch && d.universe_mismatch.system_scope) || "—")}</td></tr>
      </table></div>
    <div id="fa-review-root">${renderReviewPanelHtml(d, reviewAgg[d.code]?.records || [], reviewLoadError)}</div>
    <div class="fa-block"><h3>样例核对 ${s.stock_code ? `· ${esc(s.stock_code)} ${esc(s.stock_name || "")} @ ${esc(s.trade_date)}` : ""}</h3>
      ${(s.inputs || []).length ? `<table class="fa-kv">${s.inputs.map(i =>
        `<tr><td>${esc(i.label)}</td><td class="fa-mono">${sampleInputValue(i.value)}</td></tr>`).join("")}</table>` : ""}
      ${(s.steps || []).length ? `<div class="fa-steps">${s.steps.map(esc).join("<br>")}</div>` : ""}
      <p class="fa-mono" style="margin-top:8px">${sampleLine}</p></div>
    <div class="fa-block"><h3>对账（抽样 ${recon.n_checked || 0} 个单元）</h3>
      <p>方式 ${recon.method === "numpy_recompute" ? "独立 numpy 重算" : "回查 Wind 源字段"} ·
      结果 <span class="${reconOk ? "fa-recon-ok" : "fa-recon-bad"}">${(RECON_LABEL[recon.status] || ["—"])[0]}</span> ·
      一致 ${recon.n_match || 0}/${recon.n_checked || 0} · 最大绝对差 ${fmt(recon.max_abs_diff)}</p>
      ${(recon.mismatches || []).length ? `<table class="fa-kv">
        <tr><td>股票</td><td>重算 / 存储 / 差</td></tr>
        ${recon.mismatches.map(m => `<tr><td>${esc(m.stock_code)} @ ${esc(m.trade_date)}</td>
          <td class="fa-mono">${fmt(m.ref)} / ${fmt(m.stored)} / ${fmt(m.abs_diff)}</td></tr>`).join("")}
      </table>` : ""}</div>
    <div class="fa-block"><h3>分布体检</h3>
      <p>覆盖 ${(Math.max(Number(d.dist.coverage) || 0, 0) * 100).toFixed(0)}%${d.dist.coverage > 1.001 ? '（含超出 Word 股票池样本）' : ''} · 中位 ${fmt(d.dist.median)} · 区间 [${fmt(d.dist.min)}, ${fmt(d.dist.max)}]</p>
      ${spark(d.dist.hist)}
      <p style="margin-top:8px">近12月 RankIC 均值 ${fmt(d.ic.mean_rank_ic)}${
        d.ic.mean_rank_ic === null ? '（暂无 IC）'
          : ' · ' + (d.ic.consistent_with_direction === false
              ? '<span class="fa-recon-bad">与方向不一致</span>' : '与方向一致')}</p>
      <div>${(d.health.flags || []).map(flagChip).join("") || '<span class="b-ok">无异常标签</span>'}</div></div>`;
  if (d.formula.doc_tex && window.katex) {
    const el = document.getElementById("fa-doc-eq");
    if (el) {
      try { katex.render(d.formula.doc_tex, el, { displayMode: true, throwOnError: false }); }
      catch (e) { el.textContent = d.formula.doc; }
    }
  }
  wireReviewPanel(d);
  refreshFactorReviewPanel(d);
}
function pct(x) { return Math.min(Math.max(Number(x) || 0, 0), 1) * 100; }
function sampleInputValue(x) {
  if (x === null || x === undefined) return "—";
  if (typeof x === "string") return esc(x) || "—";
  if (typeof x === "number") return fmt(x);
  return esc(x);
}
function fmt(x) {
  if (x === null || x === undefined) return "—";
  const n = Number(x);
  if (!isFinite(n)) return "—";
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return n.toExponential(3);
  return n.toFixed(a >= 100 ? 2 : a >= 1 ? 4 : 6);
}
function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

document.getElementById("fa-close").addEventListener("click", () =>
  document.getElementById("fa-drawer").classList.add("hidden"));
document.getElementById("fa-drawer").addEventListener("click", e => {
  if (e.target.id === "fa-drawer") document.getElementById("fa-drawer").classList.add("hidden");
});
document.querySelectorAll(".fa-filters button").forEach(b =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".fa-filters button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    filter = b.dataset.filter;
    render();
  }));
document.querySelectorAll(".fa-view-toggle button").forEach(b =>
  b.addEventListener("click", () => setView(b.dataset.view)));
document.getElementById("fa-search").addEventListener("input", e => {
  query = e.target.value.trim().toLowerCase();
  render();
});
document.getElementById("fa-export-reviews").addEventListener("click", exportReviewsCsv);
(async function init() {
  initReviewerIdentity();
  setView("list");
  try {
    const idx = await (await fetch(`data/factor_audit/index.json?v=${Date.now()}`)).json();
    auditGeneratedAt = idx.generated_at || "";
    ALL = idx.factors;
    render();
    await refreshAllReviews();
    render();
  } catch (e) {
    document.getElementById("fa-stat").textContent = "加载 index.json 失败";
  }
})();
