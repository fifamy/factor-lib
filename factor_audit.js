const DIR_LABEL = { "1": ["+", "fa-dir-pos"], "-1": ["−", "fa-dir-neg"] };
const RECON_LABEL = {
  match: ["✓一致", "b-ok"], mismatch: ["✗重算不符", "b-error"],
  no_ref: ["—未对账", "b-warn"], source_missing: ["✗源缺失", "b-error"], na: ["—", "b-warn"],
};
const HEALTH_LABEL = { ok: ["●正常", "b-ok"], warn: ["●可疑", "b-warn"], error: ["●有误", "b-error"] };
const DOC_MISSING_TIP = "Word 技术文档未单列该因子或未给公式，属于系统新增/待补文档项。";
const FORMULA_MISMATCH_TIP = "Word 文档公式与当前系统实现的计算口径不一致，需要决定按 Word 改系统，或反向修订 Word。";
const UNIVERSE_MISMATCH_TIP = "Word 文档股票池/样本空间规则与当前系统实际回测、IC、选股域不完全一致。";
const ERROR_FLAGS = new Set(["nonfinite", "recon_mismatch", "recon_source_missing"]);
const FLAG_LABEL = {
  coverage_low: ["覆盖偏低", "有值的合格股不足 50%（多为业绩快报等事件因子、或数据源稀疏，通常正常）"],
  degenerate: ["常量截面", "某些月份该因子值几乎全相同，那个月没有区分度、排序无意义"],
  heavy_tail: ["厚尾", "存在极端值（稳健 z>50）。A股估值/成长/资金类因子天生厚尾，用前宜去极值；recon 一致即非计算错误"],
  outlier: ["量级异常", "|值|>100万（如比率分母接近 0 爆出大数、或资金流本就上亿）。recon 一致=真实极端值，非存储损坏"],
  nonfinite: ["非有限值", "存在 NaN/inf —— 几乎肯定计算有误（本工具的红灯目标，已全部修复）"],
  direction_ic_flip: ["方向疑反", "实测 RankIC 的方向与你声明的 +/− 系统性相反（|t|>2）。要么方向标反，要么该因子近年失效/反转，值得复核"],
  formula_mismatch: ["文档/系统不一致", FORMULA_MISMATCH_TIP],
  universe_mismatch: ["样本空间不一致", UNIVERSE_MISMATCH_TIP],
  recon_mismatch: ["对账不符", "独立重算 ≠ 系统存储值 —— 实现可能有 bug"],
  recon_source_missing: ["源缺失", "回查不到对应的 Wind 源数据"],
};
function flagInfo(f) {
  if (f.indexOf("coverage_late") === 0) {
    const m = (f.split(":")[1] || "");
    return ["数据起步晚" + (m ? ` (${m})` : ""), "该因子首个有效截面晚于 2016（数据源上线晚），早期月份没有值，属正常"];
  }
  return FLAG_LABEL[f] || [f, ""];
}
function flagChip(f) {
  const [lab, tip] = flagInfo(f);
  return `<span class="fa-flag ${ERROR_FLAGS.has(f) ? "err" : ""}" title="${esc(tip)}">${esc(lab)}</span>`;
}

let ALL = [];
let filter = "all";
let query = "";

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
function matchRow(f) {
  if (filter === "suspect" && f.health === "ok") return false;
  if (filter === "error" && f.health !== "error") return false;
  if (filter === "doc_missing" && !f.doc_missing) return false;
  if (filter === "formula_mismatch" && !f.formula_mismatch) return false;
  if (filter === "universe_mismatch" && !f.universe_mismatch) return false;
  if (query) {
    const hay = `${f.code} ${f.name_cn} ${f.l1} ${f.l2}`.toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}
function rowHtml(f) {
  return `
    <tr class="fa-row lv-${f.health}" data-code="${f.code}">
      <td><span class="fa-code">${esc(f.code)}</span><span class="fa-name">${esc(f.name_cn)}</span>${f.doc_missing ? `<span class="fa-doc-missing" title="${esc(DOC_MISSING_TIP)}">Word缺</span>` : ""}${f.formula_mismatch ? `<span class="fa-formula-mismatch" title="${esc(FORMULA_MISMATCH_TIP)}">口径异</span>` : ""}${f.universe_mismatch ? `<span class="fa-formula-mismatch" title="${esc(UNIVERSE_MISMATCH_TIP)}">样本异</span>` : ""}</td>
      <td>${esc(f.l1)} / ${esc(f.l2)}</td>
      <td class="fa-help" title="真实覆盖 ${(Math.max(Number(f.coverage) || 0, 0) * 100).toFixed(0)}%${f.coverage > 1.001 ? '（含可投资域外新股）' : ''}">${pct(f.coverage).toFixed(0)}%</td>
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
      html += `<tr class="fa-group"><td colspan="7">${esc(f.l1)} <span class="fa-group-sub">› ${esc(f.l2)}</span>` +
        `<span class="fa-group-n">${catCount[cat]} 个${warn ? ` · ${warn} 可疑` : ""}</span></td></tr>`;
    }
    html += rowHtml(f);
  }
  document.getElementById("fa-tbody").innerHTML = html || `<tr><td colspan="7" style="padding:16px;color:#8a94a6">无匹配因子</td></tr>`;
  document.getElementById("fa-stat").textContent =
    `${rows.length}/${ALL.length} 个因子 · 可疑 ${ALL.filter(f => f.health === "warn").length} · 错误 ${ALL.filter(f => f.health === "error").length} · Word未收录 ${ALL.filter(f => f.doc_missing).length} · 口径不一致 ${ALL.filter(f => f.formula_mismatch).length} · 样本空间不一致 ${ALL.filter(f => f.universe_mismatch).length}`;
  document.querySelectorAll(".fa-row").forEach(tr =>
    tr.addEventListener("click", () => openDetail(tr.dataset.code)));
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
    <div class="fa-detail-sub">${esc(d.l1)} / ${esc(d.l2)} · 方向 ${dirCell(d.direction)} · 体检 ${badge(HEALTH_LABEL, d.health.level)}${d.doc_missing ? ` · <span class="fa-doc-missing" title="${esc(DOC_MISSING_TIP)}">Word缺</span>` : ""}${d.formula_mismatch && d.formula_mismatch.level === "warn" ? ` · <span class="fa-formula-mismatch" title="${esc(FORMULA_MISMATCH_TIP)}">口径异</span>` : ""}${d.universe_mismatch && d.universe_mismatch.level === "warn" ? ` · <span class="fa-formula-mismatch" title="${esc(UNIVERSE_MISMATCH_TIP)}">样本异</span>` : ""}</div>
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
    <div class="fa-block"><h3>样本空间对照</h3>
      ${d.universe_mismatch && d.universe_mismatch.level === "warn" ? `<div class="fa-formula-alert"><b>文档/系统样本空间不一致：</b>${esc(d.universe_mismatch.reason || "")}</div>` : ""}
      <table class="fa-kv">
        <tr><td>Word 股票池</td><td>${esc((d.universe_mismatch && d.universe_mismatch.word_scope) || (d.doc_missing ? "Word 未单列该因子，暂无可对照股票池规则。" : "—"))}</td></tr>
        <tr><td>系统实际样本空间</td><td>${esc((d.universe_mismatch && d.universe_mismatch.system_scope) || "—")}</td></tr>
      </table></div>
    <div class="fa-block"><h3>样例核对 ${s.stock_code ? `· ${esc(s.stock_code)} ${esc(s.stock_name || "")} @ ${esc(s.trade_date)}` : ""}</h3>
      ${(s.inputs || []).length ? `<table class="fa-kv">${s.inputs.map(i =>
        `<tr><td>${esc(i.label)}</td><td class="fa-mono">${fmt(i.value)}</td></tr>`).join("")}</table>` : ""}
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
      <p>覆盖 ${(Math.max(Number(d.dist.coverage) || 0, 0) * 100).toFixed(0)}%${d.dist.coverage > 1.001 ? '（含可投资域外股票）' : ''} · 中位 ${fmt(d.dist.median)} · 区间 [${fmt(d.dist.min)}, ${fmt(d.dist.max)}]</p>
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
}
function pct(x) { return Math.min(Math.max(Number(x) || 0, 0), 1) * 100; }
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
document.getElementById("fa-search").addEventListener("input", e => {
  query = e.target.value.trim().toLowerCase();
  render();
});
(async function init() {
  try {
    const idx = await (await fetch(`data/factor_audit/index.json?v=${Date.now()}`)).json();
    ALL = idx.factors;
    render();
  } catch (e) {
    document.getElementById("fa-stat").textContent = "加载 index.json 失败";
  }
})();
