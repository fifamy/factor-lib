// 因子库前端入口。M1 范围：目录树 + 单因子选中 → 表格 + 净值图 + KPI。

// DuckDB-Wasm runs in a Worker with no notion of the page's "data/" relative path.
// Use absolute URLs (resolved against page origin) for every read_parquet() call.
const DATA_DIR = new URL("data/", document.baseURI).toString();
// Cache-busting 版本号。部署时 deploy 脚本会把 "DEPLOY_VERSION" 替换成提交版本号：
//   - 本地（serve.py，未替换）→ 用 Date.now() 每次刷新强制重下，重跑流水线换数据后立即生效；
//   - 部署后（已替换成稳定版本号）→ 浏览器可缓存 parquet，刷新/再访问秒开，只有重新部署才重下。
// 用 "DEPLOY"+"_VERSION" 拼接判断，避免这行自己被替换。
const _DEPLOY = "DEPLOY_VERSION";
const V = _DEPLOY === ("DEPLOY" + "_VERSION") ? `?v=${Date.now()}` : `?v=${_DEPLOY}`;
const STATIC_INDUSTRY_LIMITATION = "行业分层、行业中性组合和行业市值中性化当前使用静态申万行业，不是历史申万行业 PIT；补齐历史行业归属表前，相关分层归因只作为辅助复核。";
const F_META  = DATA_DIR + "stock_meta.parquet" + V;
const SAVED_COMBOS = DATA_DIR + "saved_combos.json" + V;
const SINGLE_SNAPSHOT_DIR = DATA_DIR + "single_snapshots/";
const SINGLE_SLIM_SNAPSHOT_DIR = DATA_DIR + "single_slim_snapshots/";
const STOCK_FACTOR_DETAIL_DIR = DATA_DIR + "stock_factor_details/";
const STOCK_META_SNAPSHOT = DATA_DIR + "stock_meta_snapshot.json" + V;
const BENCHMARK_SNAPSHOT = DATA_DIR + "benchmark_snapshot.json" + V;
const RANKING_SNAPSHOT = DATA_DIR + "factor_ranking_snapshot.json" + V;
const CORR_SNAPSHOT = DATA_DIR + "factor_corr_snapshot.json" + V;
const CORR_NEUTRAL_SNAPSHOT = DATA_DIR + "factor_corr_neutral_snapshot.json" + V;
const DATA_MANIFEST = DATA_DIR + "data_manifest.json" + V;
const SCORE_LATEST_DIR = DATA_DIR + "factor_scores_latest/";
const BACKTEST_DIR = DATA_DIR + "backtests/";
const FACTOR_IC_DIR = DATA_DIR + "factor_ics/";
const COMPOSE_SCORE_DIR = DATA_DIR + "compose_scores/";
const COMPOSE_SCORE_NEUTRAL_DIR = DATA_DIR + "compose_scores_neutral/";
const MY_COMBOS_KEY = "factorlib.compose.myCombos.v1";
const COST_PER_SIDE = 0.002;
const MIN_VALID_FORWARD_RETURN = -0.95;
const MAX_VALID_FORWARD_RETURN = 5.0;
const SUPABASE_URL = "https://tsyplhfshxzoduynzixk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6osvaEI8pookLkmkzBUbHQ_kyUU2SKn";
let _myComboIdSeq = 0;

const state = {
  catalog: [],
  activeFactor: null,
  singleSide: 1,           // 单因子方向：1=默认方向，-1=反向
  singleScoreMode: "raw",  // raw | neutral：单因子分数口径
  singleConstraintMode: "none", // none | industry：单因子组合约束
  validationBenchmark: "HS300", // 单因子检验摘要中的超额收益基准
  selectedNs: [30],        // 单因子模式：要对比的持仓数集合（至少 1 个）
  scanMetric: "annual",    // 指标-N 曲线的纵轴：annual / sharpe / mdd / vol
  singleStart: null,       // 单因子回测区间起/止月（YYYY-MM）；null=不限
  singleEnd: null,
  mode: "single",          // single | compare | compose | library | ranking
  compareFactors: [],      // 对比模式：[{code, n, side}]，每个因子可设不同持仓数/方向
  compareDefaultN: 30,     // 新加入因子的默认持仓数
  compareStart: null,      // 多因子对比回测区间；null=不限
  compareEnd: null,
  // 合成模式：[{code, weight, side, op:'>='|'<=', thr:number|null}]，thr=null 表示该因子不参与过滤
  composeFactors: [],
  composeN: 30,
  composeConstraintMode: "none", // none | industry：合成组合最终持仓约束
  composeStart: null,       // 多因子合成回测区间；null=不限
  composeEnd: null,
  // 暂存的合成组合快照：[{name, factors:[...], N, color}]，供多组合对比
  savedCombos: [],
  publishedCombos: [],
  publishedComboErrors: [],
  publishedCombosLoaded: false,
  publishedComboOpen: new Set(),
  myCombos: [],
  myComboOpen: new Set(),
  comboLibraryTab: "published",
  comboRankingRows: [],
  comboRankingSortKey: "score",
  comboRankingSortDir: "desc",
  comboRankingSource: "all",
  comboRankingRunning: false,
  adminSession: null,
  adminRequests: [],
  adminPublishedCombos: [],
  singleSnapshots: new Map(),
  singleSlimSnapshots: new Map(),
  stockFactorDetailBuckets: new Map(),
  stockMetaSnapshot: null,
  benchmarkSnapshot: null,
  rankingSnapshot: null,
  corrSnapshot: null,
  corrNeutralSnapshot: null,
  dataManifest: null,
  hasStockMeta: false,
  hasDescriptors: false,
  hasBenchmarks: false,
  hasCorr: false,
  hasCorrNeutral: false,
  duckdb: null,
  db: null,
};

let navChart = null;
let quantileChart = null;
let icDecayChart = null;
let group10ValidationChart = null;
let rolling36mChart = null;
let segmentHeatmapChart = null;
let segmentPortfolioChart = null;
let scanChart = null;
let cmpNavChart = null, cmpIcChart = null, cmpCorrChart = null;
let cpsNavChart = null;
let cpsIcDecayChart = null;
let comboGroup10Chart = null;
let comboRolling36mChart = null;

// 多条策略线的配色（按 selectedNs 顺序取）
const STRAT_COLORS = ["#1a4d80", "#e07b39", "#3a9d6e", "#9b59b6", "#c0392b", "#16a085"];
const BENCHMARK_OPTIONS = [
  { code: "HS300", label: "沪深300" },
  { code: "CSI500", label: "中证500" },
  { code: "CSI800", label: "中证800" },
];
const COST_SCENARIOS = [
  { bps: 0, label: "0bp" },
  { bps: 10, label: "10bp" },
  { bps: 20, label: "20bp" },
  { bps: 50, label: "50bp" },
];

async function init() {
  await loadCatalog();
  await loadDataManifest();
  await loadPublishedCombos();
  loadMyCombos();
  renderTree();
  bindFactorSearch();
  renderTopMeta();
  runWhenIdle(() => scheduleDuckDbWarmup(0), 5000, 3000);
}

async function loadCatalog() {
  const res = await fetch("data/factor_catalog.json" + V);
  state.catalog = await res.json();
}

async function loadDataManifest() {
  try {
    state.dataManifest = await fetchJson(DATA_MANIFEST);
  } catch (err) {
    console.warn("data_manifest not available:", err.message || err);
    state.dataManifest = null;
  }
}

async function ensureDataManifest() {
  if (!state.dataManifest) await loadDataManifest();
  return state.dataManifest;
}

function renderTopMeta() {
  const m = state.dataManifest || {};
  const asOf = m.return_end_date || m.backtest_end_month;
  const universe = m.stock_universe_rule === "word_v2" ? "Word股票池" : "历史股票池";
  const countLabel = document.getElementById("factor-count-label");
  if (countLabel) countLabel.textContent = `${state.catalog.length}因子`;
  document.getElementById("meta").textContent = asOf
    ? `${state.catalog.length} 因子 · 数据截至 ${asOf} · ${universe}`
    : `${state.catalog.length} 因子可用`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function singleSnapshotUrl(code) {
  return `${SINGLE_SNAPSHOT_DIR}${code}.json${V}`;
}

function singleSlimSnapshotMode(scoreMode = state.singleScoreMode, constraintMode = state.singleConstraintMode) {
  return `${normalizeScoreMode(scoreMode)}_${normalizeConstraintMode(constraintMode) === "industry" ? "industry" : "none"}`;
}

function singleSlimSnapshotUrl(code, scoreMode = state.singleScoreMode, constraintMode = state.singleConstraintMode) {
  return `${SINGLE_SLIM_SNAPSHOT_DIR}${singleSlimSnapshotMode(scoreMode, constraintMode)}/${code}.json${V}`;
}

async function loadSingleSnapshot(code) {
  if (!state.singleSnapshots.has(code)) {
    const promise = fetchJson(singleSnapshotUrl(code))
      .then(payload => {
        state.singleSnapshots.set(code, payload);
        return payload;
      })
      .catch(err => {
        state.singleSnapshots.delete(code);
        throw err;
      });
    state.singleSnapshots.set(code, promise);
  }
  return state.singleSnapshots.get(code);
}

async function loadActiveSingleSnapshot(code) {
  const mode = singleSlimSnapshotMode();
  const key = `${mode}|${code}`;
  if (!state.singleSlimSnapshots.has(key)) {
    const promise = fetchJson(singleSlimSnapshotUrl(code))
      .then(payload => {
        state.singleSlimSnapshots.set(key, payload);
        return payload;
      })
      .catch(err => {
        state.singleSlimSnapshots.delete(key);
        throw err;
      });
    state.singleSlimSnapshots.set(key, promise);
  }
  try {
    return await state.singleSlimSnapshots.get(key);
  } catch (err) {
    console.warn("single slim snapshot unavailable, using full snapshot:", err.message || err);
    return activePortfolioSnapshot(await loadSingleSnapshot(code));
  }
}

function snapshotNumber(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
}

function stockBucket(code) {
  const digits = String(code || "").replace(/\D/g, "");
  return digits.length >= 2 ? digits.slice(-2) : "xx";
}

function isListedStockCode(code) {
  return /^\d{6}\.(SZ|SH|BJ)$/i.test(String(code || ""));
}

async function loadStockFactorDetails(code) {
  if (!isListedStockCode(code)) return [];
  const bucket = stockBucket(code);
  if (!state.stockFactorDetailBuckets.has(bucket)) {
    state.stockFactorDetailBuckets.set(
      bucket,
      fetchJson(`${STOCK_FACTOR_DETAIL_DIR}${bucket}.json${V}`),
    );
  }
  const payload = await state.stockFactorDetailBuckets.get(bucket);
  const rows = payload?.stocks?.[code] || [];
  return rows
    .filter(row => row && row[0] && row[1] !== null && row[1] !== undefined)
    .map(row => ({
      factor_code: row[0],
      score: Number(row[1]),
      raw_value: snapshotNumber(row[2]),
      dt: row[3] || "",
    }))
    .filter(row => Number.isFinite(row.score));
}

async function ensureBenchmarkSnapshot() {
  if (!state.benchmarkSnapshot) state.benchmarkSnapshot = await fetchJson(BENCHMARK_SNAPSHOT);
  return state.benchmarkSnapshot;
}

async function ensureStockMetaSnapshot() {
  if (!state.stockMetaSnapshot) {
    const payload = await fetchJson(STOCK_META_SNAPSHOT);
    const byCode = new Map();
    for (const row of payload.rows || []) {
      byCode.set(row[0], {
        name: row[1] || "",
        is_st: !!row[2],
        is_active_latest: row[3] !== false,
        industry_sw1: row[4] || null,
        industry_sw2: row[5] || null,
        market_cap: snapshotNumber(row[6]),
        pe: snapshotNumber(row[7]),
        pb: snapshotNumber(row[8]),
        avg_amount: snapshotNumber(row[9]),
      });
    }
    state.stockMetaSnapshot = byCode;
  }
  return state.stockMetaSnapshot;
}

async function ensureRankingSnapshot() {
  if (!state.rankingSnapshot) state.rankingSnapshot = await fetchJson(RANKING_SNAPSHOT);
  return state.rankingSnapshot;
}

async function ensureCorrSnapshot() {
  if (!state.corrSnapshot) state.corrSnapshot = await fetchJson(CORR_SNAPSHOT);
  return state.corrSnapshot;
}

async function ensureCorrSnapshotFor(scoreMode = "raw") {
  if (normalizeScoreMode(scoreMode) !== "neutral") return ensureCorrSnapshot();
  if (!state.corrNeutralSnapshot) {
    try {
      state.corrNeutralSnapshot = await fetchJson(CORR_NEUTRAL_SNAPSHOT);
    } catch (err) {
      console.warn("neutral factor corr snapshot not available, using raw corr:", err.message || err);
      state.corrNeutralSnapshot = await ensureCorrSnapshot();
    }
  }
  return state.corrNeutralSnapshot;
}

function normalizeSide(side) {
  return Number(side) === -1 || side === "reverse" || side === "反向" ? -1 : 1;
}

function sideLabel(side) {
  return normalizeSide(side) === -1 ? "反向" : "默认";
}

function sideSuffix(side) {
  return normalizeSide(side) === -1 ? "（反向）" : "";
}

function factorSideName(code, side) {
  return `${code}${sideSuffix(side)}`;
}

function factorParamName(code, side = 1, scoreMode = "raw", constraintMode = null) {
  const parts = [factorSideName(code, side), scoreModeLabel(scoreMode)];
  if (constraintMode !== null && constraintMode !== undefined) parts.push(constraintModeLabel(constraintMode));
  return parts.join(" · ");
}

function effectiveScoreSql(col, side) {
  return normalizeSide(side) === -1 ? `(-1 * ${col})` : col;
}

function sideRawDirection(meta, side) {
  const defaultHighGood = Number(meta?.direction) === 1;
  const highGood = normalizeSide(side) === 1 ? defaultHighGood : !defaultHighGood;
  return highGood ? "原始值越高越好" : "原始值越低越好";
}

function normalizeScoreMode(mode) {
  return mode === "neutral" ? "neutral" : "raw";
}

function hasComposeNeutralScores() {
  return state.dataManifest?.has_compose_scores_neutral !== false;
}

function composeNeutralUnavailableMessage() {
  return "线上版本未发布 neutral 多因子合成分片；本地完整数据可用。";
}

function normalizeComposeScoreMode(mode) {
  const scoreMode = normalizeScoreMode(mode);
  return scoreMode === "neutral" && !hasComposeNeutralScores() ? "raw" : scoreMode;
}

function scoreModeLabel(mode = state.singleScoreMode) {
  return normalizeScoreMode(mode) === "neutral" ? "行业市值中性" : "原始口径";
}

function normalizeConstraintMode(mode) {
  return mode === "industry" ? "industry" : "none";
}

function constraintModeLabel(mode = state.singleConstraintMode) {
  return normalizeConstraintMode(mode) === "industry" ? "行业中性" : "无约束等权";
}

function constraintHoldText(mode = state.singleConstraintMode) {
  return normalizeConstraintMode(mode) === "industry"
    ? "按申万一级行业目标权重持有"
    : "Top 股票等权持有";
}

function activeScoreSnapshot(snap) {
  if (normalizeScoreMode(state.singleScoreMode) === "neutral" && snap?.neutral) return snap.neutral;
  return snap;
}

function activePortfolioSnapshot(snap) {
  const scoreSnap = activeScoreSnapshot(snap);
  if (normalizeConstraintMode(state.singleConstraintMode) === "industry" && scoreSnap?.industry_neutral) {
    return scoreSnap.industry_neutral;
  }
  return scoreSnap;
}

function activeSingleSnapshot(snap) {
  return activePortfolioSnapshot(snap);
}

function hasNeutralSnapshot(snap) {
  if (state.dataManifest?.has_neutralized_scores) return true;
  return !!(snap?.neutral && Array.isArray(snap.neutral.months) && snap.neutral.months.length);
}

function hasIndustryNeutralSnapshot(snap) {
  if (state.dataManifest?.has_industry_neutral_portfolio) return true;
  const scoreSnap = activeScoreSnapshot(snap);
  return !!(scoreSnap?.industry_neutral && Array.isArray(scoreSnap.industry_neutral.months) && scoreSnap.industry_neutral.months.length);
}

function activeScoreSnapshotFor(snap, scoreMode = "raw") {
  return normalizeScoreMode(scoreMode) === "neutral" && snap?.neutral ? snap.neutral : snap;
}

function activePortfolioSnapshotFor(snap, scoreMode = "raw", constraintMode = "none") {
  const scoreSnap = activeScoreSnapshotFor(snap, scoreMode);
  return normalizeConstraintMode(constraintMode) === "industry" && scoreSnap?.industry_neutral
    ? scoreSnap.industry_neutral
    : scoreSnap;
}

function normalizeCompareFactor(f) {
  return {
    code: f.code,
    n: Number.isInteger(Number(f.n)) ? Math.min(100, Math.max(1, Number(f.n))) : state.compareDefaultN,
    side: normalizeSide(f.side),
    scoreMode: normalizeScoreMode(f.scoreMode),
    constraintMode: normalizeConstraintMode(f.constraintMode),
  };
}

function normalizeComposeFactor(f) {
  return {
    code: f.code,
    weight: Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0,
    side: normalizeSide(f.side),
    scoreMode: normalizeComposeScoreMode(f.scoreMode),
    op: f.op === "<=" ? "<=" : ">=",
    thr: f.thr !== null && Number.isFinite(Number(f.thr)) ? Number(f.thr) : null,
  };
}

function cloneComposeFactors(factors) {
  return (factors || []).map(normalizeComposeFactor);
}

function supabaseHeaders(accessToken = null, extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
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
    const msg = payload?.message || payload?.error_description || payload?.error || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload;
}

async function supabaseSelect(table, query = "", accessToken = null) {
  return supabaseFetch(`/rest/v1/${table}${query}`, {
    headers: supabaseHeaders(accessToken),
  });
}

async function supabaseInsert(table, rows, accessToken = null) {
  return supabaseFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders(accessToken, { Prefer: "return=representation" }),
    body: JSON.stringify(rows),
  });
}

async function supabaseInsertMinimal(table, rows, accessToken = null) {
  return supabaseFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders(accessToken, { Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
}

async function supabasePatch(table, query, payload, accessToken) {
  return supabaseFetch(`/rest/v1/${table}${query}`, {
    method: "PATCH",
    headers: supabaseHeaders(accessToken, { Prefer: "return=representation" }),
    body: JSON.stringify(payload),
  });
}

async function supabaseDelete(table, query, accessToken) {
  return supabaseFetch(`/rest/v1/${table}${query}`, {
    method: "DELETE",
    headers: supabaseHeaders(accessToken, { Prefer: "return=minimal" }),
  });
}

async function supabaseSignIn(email, password) {
  return supabaseFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ email, password }),
  });
}

function validatePublishedCombo(raw, idx, validCodes) {
  const reasons = [];
  const combo = {
    id: typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : `invalid-${idx + 1}`,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : `未命名组合 ${idx + 1}`,
    description: typeof raw?.description === "string" ? raw.description.trim() : "",
    N: Number(raw?.N),
    constraintMode: normalizeConstraintMode(raw?.constraintMode),
    factors: [],
    tags: Array.isArray(raw?.tags) ? raw.tags.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()) : [],
    created_at: typeof raw?.created_at === "string" ? raw.created_at.trim() : "",
    source: typeof raw?.source === "string" ? raw.source : "",
    published_id: typeof raw?.published_id === "string" ? raw.published_id : "",
    remote_combo_id: typeof raw?.remote_combo_id === "string" ? raw.remote_combo_id : "",
    valid: true,
    invalidReason: "",
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) reasons.push("组合必须是对象");
  if (!raw?.id || typeof raw.id !== "string" || !raw.id.trim()) reasons.push("缺少 id");
  if (!raw?.name || typeof raw.name !== "string" || !raw.name.trim()) reasons.push("缺少名称");
  if (!Number.isInteger(combo.N) || combo.N < 1 || combo.N > 100) reasons.push("topN 必须在 1-100");
  if (!Array.isArray(raw?.factors) || raw.factors.length === 0) {
    reasons.push("缺少因子");
  } else {
    const seen = new Set();
    combo.factors = raw.factors.map((f, j) => {
      const nf = normalizeComposeFactor(f || {});
      if (!nf.code || typeof nf.code !== "string") reasons.push(`第 ${j + 1} 个因子缺少代码`);
      else if (!validCodes.has(nf.code)) reasons.push(`因子不存在：${nf.code}`);
      if (seen.has(nf.code)) reasons.push(`因子重复：${nf.code}`);
      seen.add(nf.code);
      if (!Number.isFinite(Number(f?.weight)) || typeof f?.weight === "boolean") reasons.push(`${nf.code || "未知因子"} 权重无效`);
      if (f?.op !== undefined && f.op !== ">=" && f.op !== "<=") reasons.push(`${nf.code || "未知因子"} 过滤方向无效`);
      if (f?.thr !== null && f?.thr !== undefined && (!Number.isFinite(Number(f.thr)) || typeof f.thr === "boolean")) reasons.push(`${nf.code || "未知因子"} 阈值无效`);
      return nf;
    });
  }
  combo.valid = reasons.length === 0;
  combo.invalidReason = reasons.join("；");
  return combo;
}

async function loadPublishedCombos() {
  state.publishedCombos = [];
  state.publishedComboErrors = [];
  state.publishedCombosLoaded = false;
  state.publishedComboOpen = new Set();
  const validCodes = new Set(state.catalog.map(f => f.code));
  const rawCombos = [];
  try {
    const res = await fetch(SAVED_COMBOS);
    if (!res.ok) {
      if (res.status !== 404) state.publishedComboErrors.push(`读取组合库失败：HTTP ${res.status}`);
    } else {
      const raw = await res.json();
      if (!Array.isArray(raw)) {
        state.publishedComboErrors.push("saved_combos.json 必须是数组");
      } else {
        rawCombos.push(...raw);
      }
    }
  } catch (err) {
    state.publishedComboErrors.push(`内置组合库配置有误：${err.message || err}`);
    console.error("load local published combos failed:", err);
  }

  try {
    const remote = await supabaseSelect(
      "published_combos",
      "?select=id,combo_id,combo_payload,created_at&order=created_at.desc&limit=200",
    );
    if (Array.isArray(remote)) {
      rawCombos.push(...remote.map(row => ({
        ...(row.combo_payload || {}),
        source: "supabase",
        published_id: row.id,
        remote_combo_id: row.combo_id,
        created_at: row.combo_payload?.created_at || (row.created_at || "").slice(0, 10),
      })));
    }
  } catch (err) {
    console.warn("load remote published combos failed:", err);
  }

  try {
    const validCodes = new Set(state.catalog.map(f => f.code));
    const ids = new Set();
    state.publishedCombos = rawCombos.map((combo, idx) => {
      const normalized = validatePublishedCombo(combo, idx, validCodes);
      if (ids.has(normalized.id)) {
        normalized.valid = false;
        normalized.invalidReason = normalized.invalidReason
          ? normalized.invalidReason + "；id 重复"
          : "id 重复";
      }
      ids.add(normalized.id);
      return normalized;
    });
    state.publishedCombosLoaded = true;
  } catch (err) {
    state.publishedCombosLoaded = true;
    state.publishedComboErrors.push(`组合库配置有误：${err.message || err}`);
    console.error("loadPublishedCombos failed:", err);
  }
  state.publishedCombosLoaded = true;
}

function createMyComboId(existingIds = new Set()) {
  let id = "";
  do {
    _myComboIdSeq += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    id = `mine-${Date.now()}-${_myComboIdSeq}-${rand}`;
  } while (existingIds.has(id));
  return id;
}

function rawComboFromCurrent(name = "我的组合", existingIds = new Set()) {
  return {
    id: createMyComboId(existingIds),
    name,
    description: "",
    N: state.composeN,
    constraintMode: normalizeConstraintMode(state.composeConstraintMode),
    factors: cloneComposeFactors(state.composeFactors),
    tags: [],
    created_at: new Date().toISOString().slice(0, 10),
  };
}

function rawComboFromSavedCombo(combo, existingIds = new Set()) {
  return {
    id: createMyComboId(existingIds),
    name: combo.name || "我的组合",
    description: "",
    N: combo.N,
    constraintMode: normalizeConstraintMode(combo.constraintMode),
    factors: cloneComposeFactors(combo.factors),
    tags: [],
    created_at: new Date().toISOString().slice(0, 10),
  };
}

function uniqueComboName(baseName, existingNames = new Set()) {
  const base = (baseName || "我的组合").trim() || "我的组合";
  if (!existingNames.has(base)) return base;
  let i = 2;
  let name = `${base} (${i})`;
  while (existingNames.has(name)) {
    i += 1;
    name = `${base} (${i})`;
  }
  return name;
}

function loadMyCombos() {
  state.myCombos = [];
  state.myComboOpen = new Set();
  try {
    const rawText = localStorage.getItem(MY_COMBOS_KEY);
    if (!rawText) return;
    const raw = JSON.parse(rawText);
    if (!Array.isArray(raw)) throw new Error("我的组合数据不是数组");
    const validCodes = new Set(state.catalog.map(f => f.code));
    const seenIds = new Set();
    let repaired = false;
    state.myCombos = raw.map((combo, idx) => validatePublishedCombo(combo, idx, validCodes))
      .map(c => {
        const next = { ...c, source: "mine" };
        if (!next.id || seenIds.has(next.id)) {
          next.id = createMyComboId(seenIds);
          repaired = true;
        }
        seenIds.add(next.id);
        return next;
      });
    if (repaired) persistMyCombos();
  } catch (err) {
    console.error("loadMyCombos failed:", err);
    state.myCombos = [];
  }
}

function persistMyCombos() {
  const rows = state.myCombos.filter(c => c.valid).map(c => ({
    id: c.id,
    name: c.name,
    description: c.description || "",
    N: c.N,
    constraintMode: normalizeConstraintMode(c.constraintMode),
    factors: cloneComposeFactors(c.factors),
    tags: c.tags || [],
    created_at: c.created_at || new Date().toISOString().slice(0, 10),
  }));
  localStorage.setItem(MY_COMBOS_KEY, JSON.stringify(rows, null, 2));
}

const _treeCollapsed = new Set();   // 记住被折叠的一级/二级（键 "L1:xx" / "L2:xx/yy"）
function renderTree(filter) {
  const tree = document.getElementById("factor-tree");
  tree.innerHTML = "";
  tree.className = "";

  const q = (filter || "").trim().toLowerCase();
  const searching = !!q;
  const match = f => !q
    || f.code.toLowerCase().includes(q)
    || (f.name_cn || "").toLowerCase().includes(q)
    || (f.l1 + f.l2).toLowerCase().includes(q);

  const byL1 = {};
  for (const f of state.catalog) {
    if (!match(f)) continue;
    (byL1[f.l1] ||= {});
    (byL1[f.l1][f.l2] ||= []).push(f);
  }
  if (!Object.keys(byL1).length) {
    tree.innerHTML = `<div class="empty" style="font-size:12px;padding:10px">无匹配因子</div>`;
    return;
  }

  // 折叠头：点击切换下方容器显隐 + 箭头方向；搜索时一律展开
  const makeHead = (cls, key, label, body) => {
    const collapsed = !searching && _treeCollapsed.has(key);
    const head = document.createElement("div");
    head.className = cls;
    head.innerHTML = `<span class="tw">${collapsed ? "▶" : "▼"}</span>${label}`;
    if (collapsed) body.style.display = "none";
    head.onclick = () => {
      const nowCollapsed = body.style.display !== "none";
      body.style.display = nowCollapsed ? "none" : "";
      head.querySelector(".tw").textContent = nowCollapsed ? "▶" : "▼";
      if (nowCollapsed) _treeCollapsed.add(key); else _treeCollapsed.delete(key);
    };
    return head;
  };

  for (const [l1, l2map] of Object.entries(byL1)) {
    const l1Body = document.createElement("div");
    l1Body.className = "tree-children";
    tree.appendChild(makeHead("tree-l1", "L1:" + l1, l1, l1Body));
    tree.appendChild(l1Body);

    for (const [l2, factors] of Object.entries(l2map)) {
      const l2Body = document.createElement("div");
      l2Body.className = "tree-children";
      l1Body.appendChild(makeHead("tree-l2", "L2:" + l1 + "/" + l2, l2, l2Body));
      l1Body.appendChild(l2Body);

      for (const f of factors) {
        const l3Div = document.createElement("div");
        l3Div.className = "tree-l3";
        l3Div.innerHTML = `${f.code}<span class="tree-cn">${f.name_cn || ""}</span>`;
        l3Div.dataset.code = f.code;
        l3Div.title = `${f.code} · ${f.name_cn || ""}`;
        l3Div.onclick = () => onTreeClick(f.code);
        l2Body.appendChild(l3Div);
      }
    }
  }
  updateTreeHighlight();   // 重建后恢复选中高亮
}

// 绑定搜索框（只绑一次）
let _searchBound = false;
function bindFactorSearch() {
  if (_searchBound) return;
  const inp = document.getElementById("factor-search");
  if (!inp) return;
  inp.addEventListener("input", () => renderTree(inp.value));
  _searchBound = true;
}

let _dbPromise = null;
let _optionalDataLoad = Promise.resolve();
const _optionalReady = { stockMeta: false, descriptors: false, benchmarks: false, corr: false };
let _warmupScheduled = false;
let _singleRenderSeq = 0;
let _singlePrefetchSeq = 0;

function scheduleDuckDbWarmup(delay = 0) {
  if (_dbPromise || _warmupScheduled) return;
  _warmupScheduled = true;
  const run = () => {
    _warmupScheduled = false;
    if (_dbPromise) return;
    ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: false })
      .catch(err => console.warn("DuckDB warmup failed:", err.message || err));
  };
  const launch = () => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 0);
  };
  if (delay > 0) setTimeout(launch, delay);
  else launch();
}

function runWhenIdle(fn, delay = 0, timeout = 1200) {
  const launch = () => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(() => fn(), { timeout });
    else setTimeout(fn, 0);
  };
  if (delay > 0) setTimeout(launch, delay);
  else launch();
}

function ensureDB(opts = {}) {
  // promise 锁：并发调用（快速连点）共享同一次初始化，避免重复 instantiate / 重复建表
  if (!_dbPromise) _dbPromise = _initDB();
  return _dbPromise.then(async (db) => {
    await ensureOptionalTables(opts);
    return db;
  });
}

async function ensureOptionalTables(opts = {}) {
  if (!state.db) return;
  const needStockMeta = opts.stockMeta !== false;
  const needDescriptors = opts.descriptors !== false;
  const needBenchmarks = opts.benchmarks !== false;
  const needCorr = opts.corr !== false;
  _optionalDataLoad = _optionalDataLoad.then(async () => {
    if (needStockMeta && !_optionalReady.stockMeta) {
      state.hasStockMeta = await tryLoadOptional("stock_meta", `
          CREATE OR REPLACE TABLE stock_meta AS
          SELECT * FROM read_parquet('${F_META}')
        `, `
          CREATE OR REPLACE TABLE stock_meta (
            stock_code VARCHAR, name VARCHAR, is_st BOOLEAN,
            is_main_board BOOLEAN, is_active_latest BOOLEAN
          )
        `);
      _optionalReady.stockMeta = true;
    }
    if (needDescriptors && !_optionalReady.descriptors) {
      state.hasDescriptors = await tryLoadOptional("stock_descriptors", `
          CREATE OR REPLACE TABLE stock_descriptors AS
          SELECT * FROM read_parquet('${DATA_DIR}stock_descriptors.parquet${V}')
        `, `
          CREATE OR REPLACE TABLE stock_descriptors (
            stock_code VARCHAR, industry_sw1 VARCHAR, industry_sw2 VARCHAR,
            market_cap DOUBLE, pe DOUBLE, pb DOUBLE, avg_amount DOUBLE
          )
        `);
      _optionalReady.descriptors = true;
    }
    if (needBenchmarks && !_optionalReady.benchmarks) {
      state.hasBenchmarks = await tryLoadOptional("benchmarks", `
          CREATE OR REPLACE TABLE benchmarks AS
          SELECT * FROM read_parquet('${DATA_DIR}benchmarks.parquet${V}')
        `, `
          CREATE OR REPLACE TABLE benchmarks (
            trade_date DATE, index_code VARCHAR, nav DOUBLE
          )
        `);
      _optionalReady.benchmarks = true;
    }
    if (needCorr && !_optionalReady.corr) {
      state.hasCorr = await tryLoadOptional("factor_corr", `
          CREATE OR REPLACE TABLE factor_corr AS
          SELECT * FROM read_parquet('${DATA_DIR}factor_corr.parquet${V}')
        `, `
          CREATE OR REPLACE TABLE factor_corr (
            factor_a VARCHAR, factor_b VARCHAR, corr DOUBLE, n_obs INTEGER, n_months INTEGER
          )
        `);
      state.hasCorrNeutral = await tryLoadOptional("factor_corr_neutral", `
          CREATE OR REPLACE TABLE factor_corr_neutral AS
          SELECT * FROM read_parquet('${DATA_DIR}factor_corr_neutral.parquet${V}')
        `, `
          CREATE OR REPLACE TABLE factor_corr_neutral (
            factor_a VARCHAR, factor_b VARCHAR, corr DOUBLE, n_obs INTEGER, n_months INTEGER
          )
        `);
      _optionalReady.corr = true;
    }
    console.log(`Optional: stockMeta=${state.hasStockMeta}, descriptors=${state.hasDescriptors}, benchmarks=${state.hasBenchmarks}, corr=${state.hasCorr}, corrNeutral=${state.hasCorrNeutral}`);
  });
  return _optionalDataLoad;
}

async function _initDB() {
  try {
    const duckdb = await import("./vendor/duckdb-browser.mjs");
    const mainModule = new URL("vendor/duckdb-mvp.wasm", document.baseURI).toString();
    const workerUrl = new URL("vendor/duckdb-browser-mvp.worker.js", document.baseURI).toString();
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(mainModule);
    state.duckdb = db;
    state.db = await db.connect();
    console.log("DuckDB-Wasm ready, loading tables…");

    // 串行加载小表。因子得分 / 预置回测 / IC 改为按因子分片懒加载，
    // 避免单因子首次点击就下载全量大文件。
    const t0 = performance.now();
    await state.db.query(`
      CREATE TABLE stock_meta (
        stock_code VARCHAR, name VARCHAR, is_st BOOLEAN,
        is_main_board BOOLEAN, is_active_latest BOOLEAN
      )
    `);
    await state.db.query(`
      CREATE TABLE factor_score (
        trade_date DATE, stock_code VARCHAR, factor_code VARCHAR, raw_value DOUBLE, score DOUBLE
      )
    `);
    await state.db.query(`
      CREATE TABLE preset_backtest (
        trade_date DATE, return_date DATE, port_ret DOUBLE, nav DOUBLE, factor_code VARCHAR, top_n INTEGER
      )
    `);
    await state.db.query(`
      CREATE TABLE factor_ic (
        month DATE, return_month DATE, factor_code VARCHAR, ic DOUBLE, rank_ic DOUBLE, ic_ir_12m DOUBLE
      )
    `);
    await state.db.query(`
      CREATE TABLE stock_descriptors (
        stock_code VARCHAR, industry_sw1 VARCHAR, industry_sw2 VARCHAR,
        market_cap DOUBLE, pe DOUBLE, pb DOUBLE, avg_amount DOUBLE
      )
    `);
    await state.db.query(`
      CREATE TABLE benchmarks (
        trade_date DATE, index_code VARCHAR, nav DOUBLE
      )
    `);
    await state.db.query(`
      CREATE TABLE factor_corr (
        factor_a VARCHAR, factor_b VARCHAR, corr DOUBLE, n_obs INTEGER, n_months INTEGER
      )
    `);
    await state.db.query(`
      CREATE TABLE factor_corr_neutral (
        factor_a VARCHAR, factor_b VARCHAR, corr DOUBLE, n_obs INTEGER, n_months INTEGER
      )
    `);
    console.log(`核心表加载 ${(performance.now() - t0).toFixed(0)}ms`);

    return state.db;
  } catch (err) {
    console.error("DuckDB init failed:", err);
    showError(`DuckDB 初始化失败: ${err.message || err}`);
    _dbPromise = null;   // 允许重试
    throw err;
  }
}

const _loadedScores = new Set();
const _loadedBacktests = new Set();
const _loadedIcs = new Set();
let _factorDataLoad = Promise.resolve();

function factorFilePath(dir, code) {
  return `${dir}${code}.parquet${V}`;
}

function factorReadExpr(dir, codes) {
  const paths = codes.map(code => `'${factorFilePath(dir, code)}'`).join(",");
  return `read_parquet([${paths}])`;
}

function uniqueValidCodes(codes) {
  const valid = new Set(state.catalog.map(f => f.code));
  return [...new Set((codes || []).filter(code => valid.has(code)))].sort();
}

async function ensureFactorData(codes, opts = {}) {
  const need = {
    score: opts.score !== false,
    backtest: opts.backtest !== false,
    ic: opts.ic !== false,
  };
  const wanted = uniqueValidCodes(codes);
  if (!wanted.length) return;
  _factorDataLoad = _factorDataLoad.then(async () => {
    const missingScores = need.score ? wanted.filter(code => !_loadedScores.has(code)) : [];
    const missingBacktests = need.backtest ? wanted.filter(code => !_loadedBacktests.has(code)) : [];
    const missingIcs = need.ic ? wanted.filter(code => !_loadedIcs.has(code)) : [];

    if (missingScores.length) {
      await state.db.query(`
        INSERT INTO factor_score
        SELECT trade_date, stock_code, factor_code, raw_value, score
        FROM ${factorReadExpr(SCORE_LATEST_DIR, missingScores)}
      `);
      missingScores.forEach(code => _loadedScores.add(code));
    }
    if (missingBacktests.length) {
      await state.db.query(`
        INSERT INTO preset_backtest
        SELECT trade_date,
               COALESCE(return_date, trade_date) AS return_date,
               port_ret, nav, factor_code, top_n
        FROM ${factorReadExpr(BACKTEST_DIR, missingBacktests)}
      `);
      missingBacktests.forEach(code => _loadedBacktests.add(code));
    }
    if (missingIcs.length) {
      await state.db.query(`
        INSERT INTO factor_ic
        SELECT month, return_month, factor_code, ic, rank_ic, ic_ir_12m
        FROM ${factorReadExpr(FACTOR_IC_DIR, missingIcs)}
      `);
      missingIcs.forEach(code => _loadedIcs.add(code));
    }
    console.log(`Factor shards ready: score=${_loadedScores.size}, backtest=${_loadedBacktests.size}, ic=${_loadedIcs.size}`);
  });
  return _factorDataLoad;
}

function ensureAllFactorData(opts = {}) {
  return ensureFactorData(state.catalog.map(f => f.code), opts);
}

// 合成专用数据懒加载。历史因子得分按因子分片加载，且分片已带 fwd_return，
// 避免首次合成额外下载 monthly_return.parquet 并在浏览器里做大 join。
let _composePromise = null;
function ensureComposeData() {
  // promise 锁：并发调用共享同一次加载，避免重复 CREATE TABLE 竞态
  if (!_composePromise) {
    _composePromise = (async () => {
      state.hasComposeData = true;
      console.log(`Compose data loaded: ${state.hasComposeData}`);
      return state.hasComposeData;
    })();
  }
  return _composePromise;
}

async function tryLoadOptional(tableName, loadSql, emptySql) {
  try {
    await state.db.query(loadSql);
    return true;
  } catch (err) {
    console.warn(`optional data ${tableName} not available, creating empty table:`, err.message);
    await state.db.query(emptySql);
    return false;
  }
}

function showError(msg) {
  const detail = document.getElementById("factor-detail");
  detail.innerHTML = `<h3 style="color:#c00">错误</h3><pre style="color:#c00;white-space:pre-wrap;font-size:11px">${htmlText(msg)}</pre>`;
}

async function selectFactor(code, opts = {}) {
  const seq = ++_singleRenderSeq;
  if (code !== state.activeFactor && !opts.preserveParams) state.singleSide = 1;
  state.activeFactor = code;
  document.querySelectorAll(".tree-l3").forEach(el => {
    el.classList.toggle("active", el.dataset.code === code);
  });
  const meta = state.catalog.find(f => f.code === code);
  try {
    const tAll = performance.now();
    const [snap] = await Promise.all([
      loadActiveSingleSnapshot(code),
      ensureBenchmarkSnapshot(),
      ensureDataManifest(),
    ]);
    if (seq !== _singleRenderSeq) return;
    if (normalizeConstraintMode(state.singleConstraintMode) === "industry" && !hasIndustryNeutralSnapshot(snap)) {
      state.singleConstraintMode = "none";
    }
    const scoreSnap = snap;
    const portfolioSnap = snap;
    await initSingleRangeControlsFast(portfolioSnap);
    renderFactorDetail(meta, snap);
    renderValidationPanel(code, scoreSnap);
    const tQ = performance.now();
    if (state.singleSide === 1) {
      await Promise.all([
        (async () => { const t = performance.now(); await renderTopStocksFast(code, portfolioSnap); console.log(`  top table: ${(performance.now()-t).toFixed(0)}ms`); })(),
        (async () => { const t = performance.now(); await renderKpiTableFast(code, portfolioSnap, scoreSnap); console.log(`  kpi: ${(performance.now()-t).toFixed(0)}ms`); })(),
        (async () => { const t = performance.now(); await renderNavChartFast(code, portfolioSnap); console.log(`  nav chart: ${(performance.now()-t).toFixed(0)}ms`); })(),
      ]);
    } else {
      await Promise.all([
        (async () => { const t = performance.now(); await renderTopStocksFromSnapshotSide(code, portfolioSnap, state.singleSide); console.log(`  top table(reverse): ${(performance.now()-t).toFixed(0)}ms`); })(),
        (async () => { const t = performance.now(); await renderKpiTableSide(code, state.singleSide, portfolioSnap, scoreSnap); console.log(`  kpi(reverse): ${(performance.now()-t).toFixed(0)}ms`); })(),
        (async () => { const t = performance.now(); await renderNavChartSide(code, state.singleSide, portfolioSnap); console.log(`  nav chart(reverse): ${(performance.now()-t).toFixed(0)}ms`); })(),
      ]);
    }
    if (seq !== _singleRenderSeq) return;
    console.log(`selectFactor(${code}, N=[${state.selectedNs}]) fast critical ${(performance.now()-tAll).toFixed(0)}ms (render ${(performance.now()-tQ).toFixed(0)}ms)`);
    renderSingleDeferredCharts(code, portfolioSnap, scoreSnap, seq);
    prefetchNearbySingleSnapshots(code);
    scheduleDuckDbWarmup(1800);
  } catch (err) {
    if (seq !== _singleRenderSeq) return;
    console.warn("fast selectFactor failed, falling back to DuckDB:", err);
    try {
      const tAll = performance.now();
      await ensureDB();
      await ensureFactorData([code]);
      if (seq !== _singleRenderSeq) return;
      await initSingleRangeControls();
      renderFactorDetail(meta);
      renderQuantileUnavailable("分位多空需要快照数据，请重新导出 frontend/data 后刷新。");
      renderIcDecayUnavailable("IC 衰减需要快照数据，请重新导出 frontend/data 后刷新。");
      renderValidationUnavailable("因子检验摘要需要快照数据，请重新导出 frontend/data 后刷新。");
      const tQ = performance.now();
      if (state.singleSide === 1) {
        await Promise.all([
          (async () => { const t = performance.now(); await renderTopStocks(code); console.log(`  top table: ${(performance.now()-t).toFixed(0)}ms`); })(),
          (async () => { const t = performance.now(); await renderNavChart(code); console.log(`  nav chart: ${(performance.now()-t).toFixed(0)}ms`); })(),
          (async () => { const t = performance.now(); await renderNScan(code); console.log(`  N-scan:    ${(performance.now()-t).toFixed(0)}ms`); })(),
          (async () => { const t = performance.now(); await renderKpiTable(code); console.log(`  kpi: ${(performance.now()-t).toFixed(0)}ms`); })(),
        ]);
      } else {
        await Promise.all([
          (async () => { const t = performance.now(); await renderTopStocksDynamic(code); console.log(`  top table(reverse): ${(performance.now()-t).toFixed(0)}ms`); })(),
          (async () => { const t = performance.now(); await renderNavChartSide(code, state.singleSide); console.log(`  nav chart(reverse): ${(performance.now()-t).toFixed(0)}ms`); })(),
          (async () => { const t = performance.now(); await renderNScanSide(code, state.singleSide); console.log(`  N-scan(reverse):    ${(performance.now()-t).toFixed(0)}ms`); })(),
          (async () => { const t = performance.now(); await renderKpiTableSide(code, state.singleSide); console.log(`  kpi(reverse): ${(performance.now()-t).toFixed(0)}ms`); })(),
        ]);
      }
      console.log(`selectFactor(${code}, N=[${state.selectedNs}]) fallback total ${(performance.now()-tAll).toFixed(0)}ms (queries ${(performance.now()-tQ).toFixed(0)}ms)`);
    } catch (fallbackErr) {
      if (seq !== _singleRenderSeq) return;
      console.error("selectFactor failed:", fallbackErr);
      showError(`选择因子 ${code} 失败: ${fallbackErr.message || fallbackErr}\n\n${fallbackErr.stack || ""}`);
    }
  }
}

function renderSingleDeferredCharts(code, portfolioSnap, scoreSnap, seq) {
  setTimeout(async () => {
    if (seq !== _singleRenderSeq || state.activeFactor !== code) return;
    const t = performance.now();
    try {
      await renderQuantileChartFast(code, scoreSnap);
      console.log(`  quantile:     ${(performance.now() - t).toFixed(0)}ms`);
    } catch (err) {
      console.warn("deferred quantile chart failed:", err);
    }
  }, 40);
  setTimeout(async () => {
    if (seq !== _singleRenderSeq || state.activeFactor !== code) return;
    const t = performance.now();
    try {
      await renderIcDecayChartFast(code, scoreSnap);
      console.log(`  IC decay:     ${(performance.now() - t).toFixed(0)}ms`);
    } catch (err) {
      console.warn("deferred IC decay chart failed:", err);
    }
  }, 70);
  runWhenIdle(async () => {
    if (seq !== _singleRenderSeq || state.activeFactor !== code) return;
    const t = performance.now();
    try {
      if (state.singleSide === 1) await renderNScanFast(code, portfolioSnap);
      else await renderNScanSide(code, state.singleSide, portfolioSnap);
      console.log(`  N-scan:    ${(performance.now() - t).toFixed(0)}ms`);
      if (seq === _singleRenderSeq) {
        console.log(`selectFactor(${code}, N=[${state.selectedNs}]) fast complete`);
      }
    } catch (err) {
      console.warn("deferred N-scan failed:", err);
    }
  }, 80, 900);
}

const _singleSideBtCache = new Map();
const _singleSideBtBuilds = new Map();
const _singleSideRankCache = new Map();
const _singleSideRankBuilds = new Map();

function singleSideBtKey(code, side, n) {
  return `${composeShardKey(code, state.singleScoreMode)}|${normalizeSide(side)}|${n}`;
}

function singleSideRankKey(code, side, maxRank = 100) {
  return `${composeShardKey(code, state.singleScoreMode)}|${normalizeSide(side)}|${maxRank}`;
}

async function factorSideRankedRows(code, side, maxRank = 100) {
  const key = singleSideRankKey(code, side, maxRank);
  if (_singleSideRankCache.has(key)) return _singleSideRankCache.get(key);
  if (_singleSideRankBuilds.has(key)) return _singleSideRankBuilds.get(key);
  const build = (async () => {
    await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
    await ensureComposeData();
    const item = { code, scoreMode: normalizeScoreMode(state.singleScoreMode), key: composeShardKey(code, state.singleScoreMode) };
    await ensureComposeFiles([item]);
    const path = _composeFilePaths.get(item.key);
    if (!path) throw new Error(`缺少合成分片：${code}`);
    const sideN = normalizeSide(side);
    const res = await state.db.query(`
      WITH ranked AS (
        SELECT trade_date, return_date, stock_code, fwd_return,
               ROW_NUMBER() OVER (
                 PARTITION BY trade_date
                 ORDER BY score * ${sideN} DESC, stock_code
               ) AS rk
        FROM read_parquet('${path}')
        WHERE score IS NOT NULL
      )
      SELECT strftime(trade_date, '%Y-%m') AS signal_dt,
             strftime(COALESCE(return_date, trade_date), '%Y-%m-%d') AS dt,
             stock_code, fwd_return, rk
      FROM ranked
      WHERE rk <= ${maxRank}
      ORDER BY trade_date, rk
    `);
    const rows = res.toArray();
    _singleSideRankCache.set(key, rows);
    while (_singleSideRankCache.size > 8) _singleSideRankCache.delete(_singleSideRankCache.keys().next().value);
    return rows;
  })();
  _singleSideRankBuilds.set(key, build);
  try {
    return await build;
  } finally {
    _singleSideRankBuilds.delete(key);
  }
}

async function factorSideBacktest(code, side, N) {
  const key = singleSideBtKey(code, side, N);
  if (_singleSideBtCache.has(key)) return cloneBacktest(_singleSideBtCache.get(key));
  if (_singleSideBtBuilds.has(key)) return cloneBacktest(await _singleSideBtBuilds.get(key));
  const build = (async () => {
    const rows = await factorSideRankedRows(code, side, Math.max(100, N));
    const bt = buildBacktestFromRows(rows.filter(r => r.rk <= N), N);
    _singleSideBtCache.set(key, cloneBacktest(bt));
    while (_singleSideBtCache.size > 24) _singleSideBtCache.delete(_singleSideBtCache.keys().next().value);
    return bt;
  })();
  _singleSideBtBuilds.set(key, build);
  try {
    return cloneBacktest(await build);
  } finally {
    _singleSideBtBuilds.delete(key);
  }
}

function nearbySingleCodes(code, limit = 4) {
  const idx = state.catalog.findIndex(f => f.code === code);
  if (idx < 0) return [];
  const out = [];
  for (let i = idx + 1; i < state.catalog.length && out.length < limit; i++) out.push(state.catalog[i].code);
  return out.filter(c => c && !state.singleSnapshots.has(c));
}

function prefetchNearbySingleSnapshots(code) {
  const seq = ++_singlePrefetchSeq;
  const codes = nearbySingleCodes(code, 4);
  if (!codes.length) return;
  let i = 0;
  const step = () => {
    if (seq !== _singlePrefetchSeq || state.mode !== "single" || i >= codes.length) return;
    const c = codes[i++];
    loadSingleSnapshot(c)
      .catch(err => console.warn(`single snapshot prefetch failed ${c}:`, err.message || err))
      .finally(() => runWhenIdle(step, 180, 1400));
  };
  runWhenIdle(step, 900, 1600);
}

const PRESET_NS = Array.from({ length: 100 }, (_, i) => i + 1);  // 1..100 全档位
const QUICK_NS = [5, 10, 20, 30, 50, 100];                       // UI 快捷按钮

function maxN() { return Math.max(...state.selectedNs); }

function toggleN(n) {
  const i = state.selectedNs.indexOf(n);
  if (i >= 0) {
    if (state.selectedNs.length === 1) return;   // 至少保留 1 个
    state.selectedNs.splice(i, 1);
  } else {
    state.selectedNs.push(n);
  }
  state.selectedNs.sort((a, b) => a - b);
  selectFactor(state.activeFactor);
}

function positiveOnlyNote(meta) {
  if (!meta?.positive_only) return "";
  return `<div class="method-note" style="margin-top:8px">
    <div><b>无效值处理</b>：该因子标记为 positive_only，原始值小于等于 0 时缺少可比较的经济含义，负值或零值不参与排序，raw_value 仍保留用于追溯。</div>
  </div>`;
}

function renderFactorDetail(meta, snap = null) {
  const dirArrow = meta.direction === 1 ? "↑（越高越好）" : "↓（越低越好）";
  const side = normalizeSide(state.singleSide);
  const scoreMode = normalizeScoreMode(state.singleScoreMode);
  const constraintMode = normalizeConstraintMode(state.singleConstraintMode);
  const viewSnap = activePortfolioSnapshot(snap);
  const manifest = state.dataManifest || {};
  const snapMonths = monthsFromSnapshot(viewSnap);
  const snapReturns = returnDatesFromSnapshot(viewSnap);
  const coverageStart = snapMonths[0] || manifest.backtest_start_month || "—";
  const coverageEnd = snapReturns[snapReturns.length - 1] || manifest.return_end_date || manifest.backtest_end_month || "—";
  const universeText = manifest.backtest_universe || (
    "每月末按因子对应股票池排序选股；历史回测不按最新 active 过滤，最新股票表仅展示当前 active 非 ST 股票。"
  );
  const coverageText = snapMonths.length
    ? `${coverageStart} ~ ${coverageEnd}（${snapMonths.length} 期）`
    : `${coverageStart} ~ ${coverageEnd}`;
  const sideBtns = `
    <button id="single-side-default" class="topn-btn single-side-btn${side === 1 ? " active" : ""}" data-side="1">默认方向</button>
    <button id="single-side-reverse" class="topn-btn single-side-btn${side === -1 ? " active" : ""}" data-side="-1">反向</button>`;
  const neutralDisabled = hasNeutralSnapshot(snap) ? "" : " disabled";
  const scoreModeBtns = `
    <button id="single-score-raw" class="topn-btn single-score-btn${scoreMode === "raw" ? " active" : ""}" data-mode="raw">原始口径</button>
    <button id="single-score-neutral" class="topn-btn single-score-btn${scoreMode === "neutral" ? " active" : ""}" data-mode="neutral"${neutralDisabled}>行业市值中性</button>`;
  const constraintDisabled = hasIndustryNeutralSnapshot(snap) ? "" : " disabled";
  const constraintModeBtns = `
    <button id="single-constraint-none" class="topn-btn single-constraint-btn${constraintMode === "none" ? " active" : ""}" data-mode="none">无约束等权</button>
    <button id="single-constraint-industry" class="topn-btn single-constraint-btn${constraintMode === "industry" ? " active" : ""}" data-mode="industry"${constraintDisabled}>行业中性</button>`;
  const presetTags = QUICK_NS.map(n =>
    `<button class="topn-btn${state.selectedNs.includes(n) ? ' active' : ''}" data-n="${n}">${n}</button>`
  ).join("");
  // 已选 N 的 chips（带 × 移除）
  const chips = state.selectedNs.map(n =>
    `<span class="n-chip" data-n="${n}">top${n} ${state.selectedNs.length > 1 ? '×' : ''}</span>`
  ).join("");
  const formulaBlock = meta.formula ? `
    <div style="margin-top:8px">
      <div class="label" style="color:#888;font-size:11px">计算公式</div>
      <pre style="background:#fff;border:1px solid #e0e0e0;border-radius:4px;padding:8px 10px;
                  font-size:12px;line-height:1.5;white-space:pre-wrap;margin-top:3px;color:#333">${meta.formula}</pre>
    </div>` : "";
  const sourceBlock = meta.wind_source ? `
    <div style="margin-top:8px">
      <div class="label" style="color:#888;font-size:11px">数据来源（Wind 表.字段）</div>
      <p style="font-size:12px;color:#444;margin-top:3px">${meta.wind_source}</p>
    </div>` : "";
  const tagBlock = (meta.env_tag && meta.env_tag !== "—") ? `
    <p style="margin-top:4px">
      <span class="ftag ftag-${meta.env_tag}">${meta.env_tag}</span>
      <span class="ftag ftag-${meta.time_tag}">${meta.time_tag}</span>
      <span style="color:#aaa;font-size:11px;margin-left:6px">基于全样本回测/IC 自动判定</span>
    </p>` : "";
  document.getElementById("factor-detail").innerHTML = `
    <h3>${meta.code}　·　${meta.name_cn}</h3>
    <p><b>${meta.l1} → ${meta.l2}</b>　默认方向：${dirArrow}　当前：<b>${sideLabel(side)}</b>（${sideRawDirection(meta, side)}）</p>
    ${tagBlock}
    <p>${meta.description}</p>
    ${positiveOnlyNote(meta)}
    ${formulaBlock}
    ${sourceBlock}
    <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="color:#666;font-size:11px">分析方向：</span>
      <div>${sideBtns}</div>
    </div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="color:#666;font-size:11px">分数口径：</span>
      <div>${scoreModeBtns}</div>
      <span style="color:#888;font-size:11px">行业市值中性 = 申万一级行业 + log(市值) 回归残差</span>
    </div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="color:#666;font-size:11px">组合约束：</span>
      <div>${constraintModeBtns}</div>
      <span style="color:#888;font-size:11px">行业中性 = 按当月可投资池申万一级行业占比分配行业权重</span>
    </div>
    <div class="method-note">
      <div><b>分数口径</b>决定怎么排名：原始口径直接按因子分数排；行业市值中性先剔除申万一级行业和市值暴露，再按残差分数排。</div>
      <div><b>组合约束</b>决定怎么买：无约束等权是 Top 股票等权；行业中性先给各申万一级行业分配目标权重，行业内再按分数选股并等权。</div>
      <div class="method-note-muted">因此可以组合成四种口径：原始/中性化分数 × 无约束/行业中性持仓；行业中性持仓下每只股票权重会显示在股票表中。</div>
    </div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="color:#666;font-size:11px">选股数（可多选对比）：</span>
      <div>${presetTags}</div>
      <span style="color:#666;font-size:11px">或加入</span>
      <input id="topn-input" type="number" min="1" max="100" placeholder="1-100"
             style="width:64px;padding:3px 6px;border:1px solid #ccc;border-radius:3px;font-size:12px" />
      <button id="topn-add" class="topn-btn">+ 加入</button>
    </div>
    <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <span style="color:#666;font-size:11px">已选：</span>${chips}
    </div>
    <p style="color:#666;font-size:11px;margin-top:8px">
      下方股票表显示 <b>top${maxN()}</b>（小 N 是其子集）；净值图 / 指标表叠加对比所选各 N。
      覆盖期：${coverageText}。
      口径：每月末按 <b>${meta.code}</b> ${scoreModeLabel()} 高斯秩标准化分数在 Word 股票池内排序选股，组合约束：${constraintModeLabel()}（${constraintHoldText()}），单边 0.2%，按换手扣成本；${universeText}
    </p>
  `;
  document.querySelectorAll(".single-side-btn").forEach(btn => {
    btn.onclick = () => {
      const next = normalizeSide(btn.dataset.side);
      if (state.singleSide === next) return;
      state.singleSide = next;
      selectFactor(state.activeFactor);
    };
  });
  document.querySelectorAll(".single-score-btn").forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled) return;
      const next = normalizeScoreMode(btn.dataset.mode);
      if (state.singleScoreMode === next) return;
      state.singleScoreMode = next;
      selectFactor(state.activeFactor);
    };
  });
  document.querySelectorAll(".single-constraint-btn").forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled) return;
      const next = normalizeConstraintMode(btn.dataset.mode);
      if (state.singleConstraintMode === next) return;
      state.singleConstraintMode = next;
      selectFactor(state.activeFactor);
    };
  });
  document.querySelectorAll(".topn-btn[data-n]").forEach(btn => {
    btn.onclick = () => toggleN(parseInt(btn.dataset.n, 10));
  });
  document.querySelectorAll(".n-chip").forEach(chip => {
    chip.onclick = () => toggleN(parseInt(chip.dataset.n, 10));
  });
  const inp = document.getElementById("topn-input");
  const addN = () => {
    const n = parseInt(inp.value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) { inp.value = ""; return; }
    if (!state.selectedNs.includes(n)) toggleN(n);
    else inp.value = "";
  };
  document.getElementById("topn-add").onclick = addN;
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addN(); });
}

async function renderTopStocks(code) {
  const N = maxN();
  const target = document.getElementById("top-stocks");
  // 事件因子（业绩快报）：成分按「近6个快报月池、每股取最近一期」取，避免年末快报稀少时只剩个位数。
  const isEvent = !!(state.catalog.find(f => f.code === code) || {}).is_event;
  target.innerHTML = `<h3>${code} · Top ${N} 股票（${isEvent ? "近6月快报池" : "最新月末截面"}）</h3><div class="loading">查询中…</div>`;

  // LEFT JOIN stock_descriptors（可能为空）：行业/市值/PE/PB/成交量
  const sql = isEvent ? `
    WITH recent AS (
      SELECT DISTINCT trade_date FROM factor_score
      WHERE factor_code = '${code}' AND score IS NOT NULL
      ORDER BY trade_date DESC LIMIT 6
    ),
    pooled AS (
      SELECT s.stock_code, s.score, s.raw_value, s.trade_date,
             ROW_NUMBER() OVER (PARTITION BY s.stock_code ORDER BY s.trade_date DESC) AS rn
      FROM factor_score s
      WHERE s.factor_code = '${code}' AND s.score IS NOT NULL
        AND s.trade_date IN (SELECT trade_date FROM recent)
    )
    SELECT p.stock_code, m.name, p.score, p.raw_value, CAST(p.trade_date AS VARCHAR) AS dt,
           d.industry_sw1, d.industry_sw2, d.market_cap, d.pe, d.pb, d.avg_amount
    FROM pooled p
    LEFT JOIN stock_meta m USING(stock_code)
    LEFT JOIN stock_descriptors d USING(stock_code)
    WHERE p.rn = 1
      AND COALESCE(m.is_st, FALSE) = FALSE
      AND COALESCE(m.is_active_latest, FALSE) = TRUE
    ORDER BY p.score DESC
    LIMIT ${N}
  ` : `
    WITH latest AS (
      SELECT MAX(trade_date) AS d FROM factor_score WHERE factor_code = '${code}'
    )
    SELECT
      s.stock_code, m.name, s.score, s.raw_value,
      CAST(s.trade_date AS VARCHAR) AS dt,
      d.industry_sw1, d.industry_sw2,
      d.market_cap, d.pe, d.pb, d.avg_amount
    FROM factor_score s
    LEFT JOIN stock_meta m USING(stock_code)
    LEFT JOIN stock_descriptors d USING(stock_code)
    WHERE s.factor_code = '${code}'
      AND s.trade_date = (SELECT d FROM latest)
      AND s.score IS NOT NULL
      AND COALESCE(m.is_st, FALSE) = FALSE
      AND COALESCE(m.is_active_latest, FALSE) = TRUE
    ORDER BY s.score DESC
    LIMIT ${N}
  `;
  const res = await state.db.query(sql);

  const rows = res.toArray();
  if (rows.length === 0) {
    target.innerHTML = `<h3>${code} · Top ${N} 股票</h3><div class="empty">无数据（该因子该截面无有效得分）</div>`;
    return;
  }

  const descNote = state.hasDescriptors ? "" :
    " <span style='color:#aaa;font-size:11px'>(行业/市值/PE/PB/成交额待数据)</span>";
  let head;
  if (isEvent) {
    const dts = rows.map(r => r.dt).sort();
    const lo = dts[0], hi = dts[dts.length - 1];
    head = `<h3>${code} · Top ${N} 股票（近6月快报池，按高斯秩标准化分数降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
      <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">
        事件因子：每股取其<b>最近一期业绩快报</b>（池含 ${lo} ~ ${hi} 的快报月，去重后取最高一期）；
        年末三季报快报稀少，故按近 6 个快报月汇总。申万行业 / 市值 / PE / PB 为最新快照。
      </p>`;
  } else {
    const dt = rows[0].dt;
    head = `<h3>${code} · Top ${N} 股票（截面日 ${dt}，按高斯秩标准化分数降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
      <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">
        指标口径：得分/原始值基于因子截面 ${dt}；申万行业 / 市值 / PE / PB 为 ${dt} 当日快照；
        近一年日均成交额为截至 ${dt} 往前 252 个交易日的日均。
      </p>`;
  }
  let html = head + `
    <table class="stock-table">
      <thead><tr>
        <th>#</th><th>代码</th><th>名称</th>
        <th>申万一级</th><th>申万二级</th>
        <th>市值(亿)</th><th>PE</th><th>PB</th><th>近一年日均成交额(亿)</th>
        <th>得分</th><th>原始值</th>
      </tr></thead>
      <tbody>`;
  const fmt = (v, dp = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(dp));
  const fmtMV = (v) => (v === null || v === undefined ? "—" : (Number(v) / 1e4).toFixed(0));  // 万元 → 亿元
  const fmtAmt = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));  // 已是亿元
  rows.forEach((r, i) => {
    html += `<tr class="stock-row" data-stock="${r.stock_code}" data-name="${r.name || ""}" title="点击看该股各因子打分（为什么入选）">
      <td>${i + 1}</td>
      <td>${r.stock_code}</td>
      <td>${r.name || ""}</td>
      <td>${r.industry_sw1 || "—"}</td>
      <td>${r.industry_sw2 || "—"}</td>
      <td>${fmtMV(r.market_cap)}</td>
      <td>${fmt(r.pe, 1)}</td>
      <td>${fmt(r.pb, 2)}</td>
      <td>${fmtAmt(r.avg_amount)}</td>
      <td>${fmt(r.score, 3)}</td>
      <td>${r.raw_value !== null && r.raw_value !== undefined ? Number(r.raw_value).toFixed(4) : "—"}</td>
    </tr>`;
  });
  html += "</tbody></table>";
  // 行业分布图容器（用同一份 rows 的申万一级行业聚合，直观看选股集中在哪些行业）
  html += `<div style="margin-top:14px">
      <h4 style="font-size:12px;color:#444;margin:0 0 4px 0">选出股票的行业分布（申万一级，按只数降序）</h4>
      <div id="top-industry-chart" style="width:100%"></div>
    </div>`;
  // 市值分布图容器（按市值分档，直观看选股偏大盘还是小盘）
  html += `<div style="margin-top:14px">
      <h4 style="font-size:12px;color:#444;margin:0 0 4px 0">选出股票的市值分布（按总市值分档）</h4>
      <div id="top-mktcap-chart" style="width:100%;height:170px"></div>
    </div>`;
  target.innerHTML = html;
  renderTopIndustryChart(rows, N);
  renderTopMarketCapChart(rows);
}

async function renderTopStocksDynamic(code) {
  const N = maxN();
  const target = document.getElementById("top-stocks");
  const side = normalizeSide(state.singleSide);
  const meta = state.catalog.find(f => f.code === code) || {};
  const isEvent = !!meta.is_event;
  target.innerHTML = `<h3>${factorSideName(code, side)} · Top ${N} 股票（${isEvent ? "近6月快报池" : "最新月末截面"}）</h3><div class="loading">查询中…</div>`;
  await ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: false });
  await ensureFactorData([code], { backtest: false, ic: false });
  const metaMap = await ensureStockMetaSnapshot();
  const scoreExpr = effectiveScoreSql("s.score", side);
  const sql = isEvent ? `
    WITH recent AS (
      SELECT DISTINCT trade_date FROM factor_score
      WHERE factor_code = '${code}' AND score IS NOT NULL
      ORDER BY trade_date DESC LIMIT 6
    ),
    pooled AS (
      SELECT s.stock_code, ${scoreExpr} AS score, s.raw_value, s.trade_date,
             ROW_NUMBER() OVER (PARTITION BY s.stock_code ORDER BY s.trade_date DESC) AS rn
      FROM factor_score s
      WHERE s.factor_code = '${code}' AND s.score IS NOT NULL
        AND s.trade_date IN (SELECT trade_date FROM recent)
    )
    SELECT p.stock_code, p.score, p.raw_value, CAST(p.trade_date AS VARCHAR) AS dt
    FROM pooled p
    WHERE p.rn = 1
    ORDER BY p.score DESC, p.stock_code
    LIMIT ${Math.min(Math.max(N * 4, N + 180), 700)}
  ` : `
    WITH latest AS (
      SELECT MAX(trade_date) AS d FROM factor_score WHERE factor_code = '${code}'
    )
    SELECT s.stock_code, ${scoreExpr} AS score, s.raw_value, CAST(s.trade_date AS VARCHAR) AS dt
    FROM factor_score s
    WHERE s.factor_code = '${code}'
      AND s.trade_date = (SELECT d FROM latest)
      AND s.score IS NOT NULL
    ORDER BY score DESC, s.stock_code
    LIMIT ${Math.min(Math.max(N * 4, N + 180), 700)}
  `;
  const res = await state.db.query(sql);
  const rows = res.toArray()
    .map(r => ({ ...r, meta: metaMap.get(r.stock_code) }))
    .filter(r => r.meta && !r.meta.is_st && r.meta.is_active_latest)
    .slice(0, N)
    .map(r => ({
      ...r,
      name: r.meta.name,
      industry_sw1: r.meta.industry_sw1,
      industry_sw2: r.meta.industry_sw2,
      market_cap: r.meta.market_cap,
      pe: r.meta.pe,
      pb: r.meta.pb,
      avg_amount: r.meta.avg_amount,
    }));
  renderTopStocksRows(code, rows, { isEvent, side, snapshot: false });
}

async function renderTopStocksFast(code, snap) {
  const N = maxN();
  const target = document.getElementById("top-stocks");
  const meta = state.catalog.find(f => f.code === code) || {};
  const isEvent = !!meta.is_event;
  const rows = (snap.top_stocks_by_n?.[String(N)] || snap.top_stocks_by_n?.["100"] || snap.top_stocks || []).slice(0, N);
  renderTopStocksRows(code, rows, { isEvent, side: 1, snapshot: true });
}

async function renderTopStocksFromSnapshotSide(code, snap, side) {
  const N = maxN();
  const meta = state.catalog.find(f => f.code === code) || {};
  const isEvent = !!meta.is_event;
  const sideN = normalizeSide(side);
  const baseRows = snap.top_stocks_by_n?.[String(N)] || snap.top_stocks_by_n?.["100"] || snap.top_stocks || [];
  const rows = baseRows
    .map(r => ({ ...r, score: r.score == null ? r.score : Number(r.score) * sideN }))
    .filter(r => r.score !== null && r.score !== undefined && Number.isFinite(Number(r.score)))
    .sort((a, b) => Number(b.score) - Number(a.score) || String(a.stock_code).localeCompare(String(b.stock_code)))
    .slice(0, N);
  renderTopStocksRows(code, rows, { isEvent, side, snapshot: true });
}

function renderTopStocksRows(code, rows, opts = {}) {
  const N = maxN();
  const target = document.getElementById("top-stocks");
  const meta = state.catalog.find(f => f.code === code) || {};
  const isEvent = opts.isEvent ?? !!meta.is_event;
  const side = normalizeSide(opts.side);
  const sideText = sideSuffix(side);
  if (!rows.length) {
    target.innerHTML = `<h3>${factorSideName(code, side)} · Top ${N} 股票</h3><div class="empty">无数据（该因子该截面无有效得分）</div>`;
    return;
  }
  const hasWeight = rows.some(r => r.weight !== null && r.weight !== undefined && Number.isFinite(Number(r.weight)));
  const descNote = opts.snapshot
    ? ` <span style='color:#aaa;font-size:11px'>(${scoreModeLabel()} / ${constraintModeLabel()}快照)</span>`
    : " <span style='color:#aaa;font-size:11px'>(按当前方向即时排序)</span>";
  let head;
  if (isEvent) {
    const dts = rows.map(r => r.dt).filter(Boolean).sort();
    const lo = dts[0] || "—", hi = dts[dts.length - 1] || "—";
    head = `<h3>${code}${sideText} · Top ${N} 股票（近6月快报池，按有效高斯秩标准化分数降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
      <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">
        事件因子：每股取其<b>最近一期业绩快报</b>（池含 ${lo} ~ ${hi} 的快报月，去重后取最高一期）；
        年末三季报快报稀少，故按近 6 个快报月汇总。申万行业 / 市值 / PE / PB 为最新快照。
      </p>`;
  } else {
    const dt = rows[0].dt || "—";
    head = `<h3>${code}${sideText} · Top ${N} 股票（截面日 ${dt}，按有效高斯秩标准化分数降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
      <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">
        指标口径：得分/原始值基于因子截面 ${dt}；申万行业 / 市值 / PE / PB 为 ${dt} 当日快照；
        近一年日均成交额为截至 ${dt} 往前 252 个交易日的日均。
      </p>`;
  }
  let html = head + `
    <table class="stock-table">
      <thead><tr>
        <th>#</th><th>代码</th><th>名称</th>
        <th>申万一级</th><th>申万二级</th>
        <th>市值(亿)</th><th>PE</th><th>PB</th><th>近一年日均成交额(亿)</th>
        ${hasWeight ? "<th>权重</th>" : ""}
        <th>得分</th><th>原始值</th>
      </tr></thead>
      <tbody>`;
  const fmt = (v, dp = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(dp));
  const fmtMV = (v) => (v === null || v === undefined ? "—" : (Number(v) / 1e4).toFixed(0));
  const fmtAmt = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));
  rows.forEach((r, i) => {
    html += `<tr class="stock-row" data-stock="${r.stock_code}" data-name="${r.name || ""}" title="点击看该股各因子打分（为什么入选）">
      <td>${i + 1}</td>
      <td>${r.stock_code}</td>
      <td>${r.name || ""}</td>
      <td>${r.industry_sw1 || "—"}</td>
      <td>${r.industry_sw2 || "—"}</td>
      <td>${fmtMV(r.market_cap)}</td>
      <td>${fmt(r.pe, 1)}</td>
      <td>${fmt(r.pb, 2)}</td>
      <td>${fmtAmt(r.avg_amount)}</td>
      ${hasWeight ? `<td>${pctText(Number(r.weight))}</td>` : ""}
      <td>${fmt(r.score, 3)}</td>
      <td>${r.raw_value !== null && r.raw_value !== undefined ? Number(r.raw_value).toFixed(4) : "—"}</td>
    </tr>`;
  });
  html += "</tbody></table>";
  html += `<div style="margin-top:14px">
      <h4 style="font-size:12px;color:#444;margin:0 0 4px 0">选出股票的行业分布（申万一级，按只数降序）</h4>
      <div id="top-industry-chart" style="width:100%"></div>
    </div>`;
  html += `<div style="margin-top:14px">
      <h4 style="font-size:12px;color:#444;margin:0 0 4px 0">选出股票的市值分布（按总市值分档）</h4>
      <div id="top-mktcap-chart" style="width:100%;height:170px"></div>
    </div>`;
  target.innerHTML = html;
  renderTopIndustryChart(rows, N);
  renderTopMarketCapChart(rows);
}

// 市值分档（亿元）：小盘 <50 / 中盘 50-200 / 大盘 200-1000 / 超大盘 >1000
const MKTCAP_BINS = [
  { label: "小盘 <50亿", lo: 0, hi: 50 },
  { label: "中盘 50-200亿", lo: 50, hi: 200 },
  { label: "大盘 200-1000亿", lo: 200, hi: 1000 },
  { label: "超大盘 >1000亿", lo: 1000, hi: Infinity },
];
let topMktcapChart = null;
function renderTopMarketCapChart(rows) {
  const div = document.getElementById("top-mktcap-chart");
  if (!div) return;
  if (topMktcapChart) { topMktcapChart.dispose(); topMktcapChart = null; }
  // market_cap 单位万元 → 亿元
  const counts = MKTCAP_BINS.map(() => 0);
  let known = 0;
  for (const r of rows) {
    if (r.market_cap === null || r.market_cap === undefined) continue;
    const yi = Number(r.market_cap) / 1e4;
    const i = MKTCAP_BINS.findIndex(b => yi >= b.lo && yi < b.hi);
    if (i >= 0) { counts[i]++; known++; }
  }
  const total = known || 1;
  topMktcapChart = echarts.init(div);
  topMktcapChart.setOption({
    grid: { left: 110, right: 44, top: 8, bottom: 24 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
               formatter: p => `${p[0].name}：${p[0].value} 只（占 ${(p[0].value / total * 100).toFixed(0)}%）` },
    xAxis: { type: "value", minInterval: 1, axisLabel: { fontSize: 10 } },
    // 倒序让"小盘"在最上方，符合从小到大阅读
    yAxis: { type: "category", data: MKTCAP_BINS.map(b => b.label).reverse(), axisLabel: { fontSize: 11 } },
    series: [{
      type: "bar", data: counts.slice().reverse(), barMaxWidth: 22,
      itemStyle: { color: "#3a7d44", borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", fontSize: 10, color: "#666",
               formatter: p => p.value ? `${p.value}（${(p.value / total * 100).toFixed(0)}%）` : "" },
    }],
  });
}

let topIndustryChart = null;
function renderTopIndustryChart(rows, N) {
  const div = document.getElementById("top-industry-chart");
  if (!div) return;
  if (topIndustryChart) { topIndustryChart.dispose(); topIndustryChart = null; }
  // 按申万一级行业聚合只数
  const cnt = {};
  for (const r of rows) {
    const ind = r.industry_sw1 || "未分类";
    cnt[ind] = (cnt[ind] || 0) + 1;
  }
  const items = Object.entries(cnt).sort((a, b) => a[1] - b[1]);   // 升序，横向条形图从下往上=多在上
  const inds = items.map(x => x[0]);
  const vals = items.map(x => x[1]);
  const total = rows.length;
  // 自适应高度：每个行业一行，约 22px
  div.style.height = Math.max(120, inds.length * 22 + 50) + "px";
  topIndustryChart = echarts.init(div);
  topIndustryChart.setOption({
    grid: { left: 70, right: 40, top: 8, bottom: 24 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
               formatter: p => `${p[0].name}：${p[0].value} 只（占 ${(p[0].value / total * 100).toFixed(0)}%）` },
    xAxis: { type: "value", minInterval: 1, axisLabel: { fontSize: 10 } },
    yAxis: { type: "category", data: inds, axisLabel: { fontSize: 11 } },
    series: [{
      type: "bar", data: vals, barMaxWidth: 18,
      itemStyle: { color: "#1a4d80", borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", fontSize: 10, color: "#666",
               formatter: p => `${p.value}（${(p.value / total * 100).toFixed(0)}%）` },
    }],
  });
}

async function renderNavChart(code) {
  const ns = state.selectedNs;
  const rng = (state.singleStart || state.singleEnd)
    ? `${state.singleStart || "起"}~${state.singleEnd || "今"}` : "全样本";
  document.getElementById("nav-title").textContent =
    `${code} · ${scoreModeLabel()} / ${constraintModeLabel()}组合净值对比 top-[${ns.join(", ")}]（起点=1.0；${rng}，${constraintHoldText()}，单边 0.2%，按换手扣成本）`;

  const chartDiv = document.getElementById("nav-chart");
  if (navChart) { navChart.dispose(); navChart = null; }
  chartDiv.innerHTML = "";

  // 查所选各 N 在区间内的月度收益，区间内从 1.0 重建净值（口径对齐所选区间）
  const inList = ns.join(",");
  const res = await state.db.query(`
    SELECT top_n, strftime(COALESCE(return_date, trade_date), '%Y-%m-%d') AS dt, port_ret
    FROM preset_backtest
    WHERE factor_code = '${code}' AND top_n IN (${inList})
      ${backtestRangeWhere(state.singleStart, state.singleEnd)}
    ORDER BY top_n, trade_date
  `);
  const byN = {};
  for (const r of res.toArray()) {
    if (!byN[r.top_n]) byN[r.top_n] = { dt: [], nav: [], _pr: null };
    const o = byN[r.top_n];
    if (!o.dt.length) {
      o.dt.push(monthOfLabel(r.dt));
      o.nav.push(1.0);
    }
    o._pr = r.port_ret;
    o.dt.push(r.dt);
    o.nav.push(o.nav[o.nav.length - 1] * (1 + (o._pr ?? 0)));
  }
  // x 轴用第一个 N 的月份（各 N 月份一致）
  const x = (byN[ns[0]] || { dt: [] }).dt;

  const series = [];
  ns.forEach((n, i) => {
    const s = byN[n];
    if (!s) return;
    series.push({
      name: `top${n}`,
      type: "line",
      data: s.nav,   // 已从 1.0 重建
      symbol: "none",
      color: STRAT_COLORS[i % STRAT_COLORS.length],   // legend 标记与线同色
      lineStyle: { width: 2 },
    });
  });

  // 基准：单 N 时画全部 3 条；多 N 对比时只留沪深300 一条灰线作参照（避免太挤）
  if (state.hasBenchmarks && x.length) {
    const bmRes = await state.db.query(`
      SELECT index_code, strftime(trade_date, '%Y-%m') AS dt, nav
      FROM benchmarks
      WHERE strftime(trade_date, '%Y-%m') >= '${monthOfLabel(x[0])}'
        AND strftime(trade_date, '%Y-%m') <= '${monthOfLabel(x[x.length - 1])}'
      ORDER BY index_code, trade_date
    `);
    const byIndex = {};
    for (const r of bmRes.toArray()) {
      if (!byIndex[r.index_code]) byIndex[r.index_code] = {};
      byIndex[r.index_code][r.dt] = r.nav;
    }
    const colors = { "HS300": "#c14545", "CSI800": "#6e9a4f", "CSI500": "#c89c2b" };
    const cnNames = { "HS300": "沪深300", "CSI800": "中证800", "CSI500": "中证500" };
    const wantIdx = ["HS300", "CSI800", "CSI500"];
    for (const idxCode of wantIdx) {
      const monthMap = byIndex[idxCode];
      if (!monthMap) continue;
      const aligned = x.map(m => (monthOfLabel(m) in monthMap ? monthMap[monthOfLabel(m)] : null));
      const b = aligned.find(v => v !== null);
      const rebased = b ? aligned.map(v => (v === null ? null : v / b)) : aligned;
      series.push({
        name: `${cnNames[idxCode] || idxCode}(基准)`,
        type: "line", data: rebased, symbol: "none", connectNulls: true,
        color: colors[idxCode] || "#888",
        lineStyle: { width: 1.2, type: "dashed" },
      });
    }
  }

  navChart = echarts.init(chartDiv);
  navChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 32 },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true },
    series,
  });
}

async function renderNavChartFast(code, snap) {
  const ns = state.selectedNs;
  const rng = (state.singleStart || state.singleEnd)
    ? `${state.singleStart || "起"}~${state.singleEnd || "今"}` : "全样本";
  document.getElementById("nav-title").textContent =
    `${code} · ${scoreModeLabel()} / ${constraintModeLabel()}组合净值对比 top-[${ns.join(", ")}]（起点=1.0；${rng}，${constraintHoldText()}，单边 0.2%，按换手扣成本）`;

  const chartDiv = document.getElementById("nav-chart");
  if (navChart) { navChart.dispose(); navChart = null; }
  chartDiv.innerHTML = "";

  const months = monthsFromSnapshot(snap);
  const returnDates = returnDatesFromSnapshot(snap);
  const idxs = rangeFilterIndexes(months, state.singleStart, state.singleEnd);
  const periodLabels = labelsByIndexes(returnDates, idxs);
  const signalLabels = labelsByIndexes(signalMonthsFromSnapshot(snap), idxs);
  const x = labelsFromReturnDates(periodLabels, signalLabels);
  const series = [];
  ns.forEach((n, i) => {
    const bt = snap.backtests?.[String(n)];
    if (!bt) return;
    const rets = sliceByIndexes(bt.ret, idxs);
    series.push({
      name: `top${n}`,
      type: "line",
      data: alignReturnsToChart(rets, x),
      symbol: "none",
      color: STRAT_COLORS[i % STRAT_COLORS.length],
      lineStyle: { width: 2 },
    });
  });

  const bm = await ensureBenchmarkSnapshot();
  const colors = { "HS300": "#c14545", "CSI800": "#6e9a4f", "CSI500": "#c89c2b" };
  const cnNames = { "HS300": "沪深300", "CSI800": "中证800", "CSI500": "中证500" };
  for (const idxCode of ["HS300", "CSI800", "CSI500"]) {
    const rebased = rebaseNav(benchmarkSeries(bm, x.map(monthOfLabel), idxCode));
    if (!rebased.some(v => v !== null)) continue;
    series.push({
      name: `${cnNames[idxCode] || idxCode}(基准)`,
      type: "line", data: rebased, symbol: "none", connectNulls: true,
      color: colors[idxCode] || "#888",
      lineStyle: { width: 1.2, type: "dashed" },
    });
  }

  navChart = echarts.init(chartDiv);
  navChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 32 },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true },
    series,
  });
}

// 从月度收益/净值序列算各项指标
function computeMetrics(rets, navs) {
  if (navs.length < 2) return null;
  const n = rets.length;
  const totalRet = navs[navs.length - 1] / navs[0] - 1;
  const annual = Math.pow(1 + totalRet, 12 / n) - 1;
  const mean = rets.reduce((s, v) => s + v, 0) / n;
  const std = n >= 2 ? Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : null;
  const vol = std !== null && Number.isFinite(std) ? std * Math.sqrt(12) : null;   // 年化波动率
  const sharpe = vol !== null && Number.isFinite(vol) && vol > 0 ? annual / vol : null;
  let peak = navs[0], mdd = 0;
  for (const v of navs) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  const winRate = rets.filter(r => r > 0).length / n;
  const navEnd = navs[navs.length - 1] / navs[0];
  return { annual, sharpe, mdd, winRate, navEnd, vol };
}

function metricsFromReturns(rets) {
  const clean = (rets || []).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  if (!clean.length) return null;
  const navs = [1];
  for (const r of clean) navs.push(navs[navs.length - 1] * (1 + r));
  return computeMetrics(clean, navs);
}

function monthIdFromLabel(label) {
  const s = String(label || "").slice(0, 7);
  const parts = s.split("-").map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return parts[0] * 12 + parts[1];
}

function effectiveAnnualizationScale(months, horizonMonths = 1) {
  const ids = (months || [])
    .map(monthIdFromLabel)
    .filter(v => v !== null)
    .sort((a, b) => a - b);
  if (ids.length < 2 || horizonMonths <= 0) return null;
  const spanMonths = Math.max(1, ids[ids.length - 1] - ids[0] + 1);
  const observationsPerYear = Math.min(12, ids.length * 12 / spanMonths);
  const independentFrequency = observationsPerYear / horizonMonths;
  return independentFrequency > 0 ? Math.sqrt(independentFrequency) : null;
}

function rankIcStats(months, values, side = 1, horizonMonths = 1) {
  const pairs = [];
  (values || []).forEach((value, i) => {
    const n = Number(value);
    if (Number.isFinite(n)) pairs.push({ month: months?.[i], value: n * side });
  });
  if (!pairs.length) return { mean: null, ir: null, winRate: null, n: 0 };
  const vals = pairs.map(p => p.value);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const winRate = vals.filter(v => v > 0).length / vals.length;
  if (vals.length < 2) return { mean, ir: null, winRate, n: vals.length };
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1));
  const scale = effectiveAnnualizationScale(pairs.map(p => p.month), horizonMonths);
  return { mean, ir: std > 0 && scale !== null ? mean / std * scale : null, winRate, n: vals.length };
}

function memberForwardReturn(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : -1.0;
}

function forwardReturnSql(column = "fwd_return") {
  return `CASE
    WHEN ${column} IS NULL THEN -1.0
    WHEN ${column} <= ${MIN_VALID_FORWARD_RETURN} OR ${column} >= ${MAX_VALID_FORWARD_RETURN} THEN -1.0
    ELSE CAST(${column} AS DOUBLE)
  END`;
}

function tradingCostForTurnover(turnover, isInitialPosition) {
  const t = Number.isFinite(Number(turnover)) ? Math.max(0, Number(turnover)) : 0;
  return (isInitialPosition ? COST_PER_SIDE : 2 * COST_PER_SIDE) * t;
}

function weightedTurnover(currentWeights, previousWeights) {
  if (!previousWeights) return 1.0;
  const keys = new Set([...currentWeights.keys(), ...previousWeights.keys()]);
  let diff = 0;
  for (const key of keys) diff += Math.abs((currentWeights.get(key) || 0) - (previousWeights.get(key) || 0));
  return diff * 0.5;
}

function medianNumber(values) {
  const clean = (values || []).map(snapshotNumber).filter(v => v !== null).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function alignedBenchmarkReturns(snapshot, months, indexCode) {
  const bmMonths = snapshot?.months || [];
  const nav = snapshot?.nav?.[indexCode] || [];
  const returns = new Map();
  for (let i = 1; i < bmMonths.length; i++) {
    const prev = nav[i - 1];
    const cur = nav[i];
    if (prev === null || cur === null || prev === undefined || cur === undefined) continue;
    const p = Number(prev);
    const c = Number(cur);
    if (Number.isFinite(p) && Number.isFinite(c) && p > 0) returns.set(bmMonths[i], c / p - 1);
  }
  return months.map(m => {
    const v = returns.get(m);
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  });
}

function computeTop30ExcessForBenchmark(snap, benchmarkSnapshot, indexCode, side = state.singleSide) {
  const bt = sideBacktestFromSnapshot(snap, side, 30);
  if (!bt.retArr.length) return { annual: null, mdd: null, n: 0 };
  const idxs = rangeFilterIndexes(monthsFromSnapshot(snap), state.singleStart, state.singleEnd);
  const months = labelsByIndexes(returnDatesFromSnapshot(snap), idxs).map(monthOfLabel);
  const bmRets = alignedBenchmarkReturns(benchmarkSnapshot, months, indexCode);
  const excess = [];
  for (let i = 0; i < bt.retArr.length; i++) {
    const r = bt.retArr[i];
    const b = bmRets[i];
    if (r === null || b === null || r === undefined || b === undefined) continue;
    if (Number.isFinite(Number(r)) && Number.isFinite(Number(b))) excess.push(Number(r) - Number(b));
  }
  const m = metricsFromReturns(excess);
  return { annual: m?.annual ?? null, mdd: m?.mdd ?? null, n: excess.length };
}

function estimateCostAdjustedReturns(rets, avgTurnover, baseSingleSideCost = 0.002, scenarioBps = 20) {
  const clean = (rets || []).map(v => v === null || v === undefined ? null : Number(v));
  const turnover = Number.isFinite(Number(avgTurnover)) ? Number(avgTurnover) : null;
  const scenarioCost = scenarioBps / 10000;
  const delta = turnover === null ? 0 : 2 * (scenarioCost - baseSingleSideCost) * turnover;
  return clean.map(v => Number.isFinite(v) ? v - delta : null);
}

function renderBenchmarkSelect() {
  const current = state.validationBenchmark;
  const options = BENCHMARK_OPTIONS.map(b =>
    `<option value="${b.code}" ${b.code === current ? "selected" : ""}>${b.label}</option>`
  ).join("");
  return `
    <div class="validation-control-row">
      <label for="validation-benchmark-select">基准选择</label>
      <select id="validation-benchmark-select">${options}</select>
      <span>超额年化 / 超额回撤随基准重算；排行榜仍使用离线默认基准。</span>
    </div>
  `;
}

function renderCostSensitivityTable(snap, avgTurnover, side = state.singleSide) {
  const bt = sideBacktestFromSnapshot(snap, side, 30);
  const rows = COST_SCENARIOS.map(s => {
    const adjusted = estimateCostAdjustedReturns(bt.retArr, avgTurnover, 0.002, s.bps);
    const m = metricsFromReturns(adjusted);
    return `<tr><td>${s.label}</td><td>${signalValue("ann_return", m?.annual, pctText(m?.annual))}</td><td>${signalValue("sharpe", m?.sharpe, signedNumText(m?.sharpe, 2))}</td><td>${pctText(m?.mdd)}</td><td>${pctText(m?.winRate)}</td></tr>`;
  }).join("");
  return `
    <h4 class="validation-subtitle">成本敏感性</h4>
    <table class="validation-table cost-sensitivity-table">
      <thead><tr><th>单边成本</th><th>Top30年化</th><th>夏普</th><th>最大回撤</th><th>月度胜率</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="validation-note">成本敏感性基于月均换手估算：以当前 Top30 月收益序列为基础，按不同单边交易成本调整收益，主要用于观察换手较高因子对成本的敏感程度。</p>
  `;
}

function monthsFromSnapshot(snap) {
  return (snap && Array.isArray(snap.months)) ? snap.months : [];
}

function returnDatesFromSnapshot(snap) {
  return (snap && Array.isArray(snap.return_dates) && snap.return_dates.length === monthsFromSnapshot(snap).length)
    ? snap.return_dates
    : monthsFromSnapshot(snap);
}

function signalMonthsFromSnapshot(snap) {
  return (snap && Array.isArray(snap.signal_months) && snap.signal_months.length === monthsFromSnapshot(snap).length)
    ? snap.signal_months
    : monthsFromSnapshot(snap);
}

function labelsByIndexes(labels, idxs) {
  return idxs.map(i => labels?.[i]).filter(v => v !== null && v !== undefined);
}

function monthOfLabel(label) {
  return String(label || "").slice(0, 7);
}

function rangeFilterIndexes(months, startMonth, endMonth) {
  const out = [];
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    if (startMonth && m < startMonth) continue;
    if (endMonth && m > endMonth) continue;
    out.push(i);
  }
  return out;
}

function sliceByIndexes(arr, idxs) {
  return idxs.map(i => arr?.[i]).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
}

function sliceBacktestByRange(bt, startMonth, endMonth) {
  if (!bt || !Array.isArray(bt.x) || !Array.isArray(bt.retArr)) return { x: [], navArr: [], retArr: [] };
  const hasStartAnchor = bt.x.length === bt.retArr.length + 1;
  const x = [], retArr = [];
  for (let i = 0; i < bt.retArr.length; i++) {
    const retLabel = hasStartAnchor ? bt.x[i + 1] : bt.x[i];
    const m = monthOfLabel(retLabel);
    if (startMonth && m < startMonth) continue;
    if (endMonth && m > endMonth) continue;
    const r = bt.retArr[i];
    if (r === null || r === undefined || !Number.isFinite(Number(r))) continue;
    if (!x.length) x.push(hasStartAnchor ? bt.x[i] : m);
    x.push(retLabel);
    retArr.push(Number(r));
  }
  return { x, retArr, navArr: navFromReturnsForChart(retArr) };
}

function sideBacktestFromSnapshot(snap, side, n) {
  const bt = snap?.backtests?.[String(n)];
  if (!bt) return { x: [], retArr: [], navArr: [] };
  const months = monthsFromSnapshot(snap);
  const returnDates = returnDatesFromSnapshot(snap);
  const idxs = rangeFilterIndexes(months, state.singleStart, state.singleEnd);
  const returnLabels = labelsByIndexes(returnDates, idxs);
  const signalLabels = labelsByIndexes(signalMonthsFromSnapshot(snap), idxs);
  const x = labelsFromReturnDates(returnLabels, signalLabels);
  const sideN = normalizeSide(side);
  const retArr = sliceByIndexes(bt.ret, idxs).map(v => v * sideN);
  return { x, retArr, navArr: alignReturnsToChart(retArr, x) };
}

function navFromReturnsForChart(rets) {
  const out = [1];
  let nav = 1;
  for (const r of rets) {
    const value = Number(r);
    if (r === null || r === undefined || !Number.isFinite(value)) {
      out.push(null);
      continue;
    }
    nav *= 1 + value;
    out.push(+nav.toFixed(6));
  }
  return out;
}

function labelsFromReturnDates(returnDates, signalMonths) {
  if (!returnDates || !returnDates.length) return [];
  const first = signalMonths?.[0] || monthOfLabel(returnDates?.[0]);
  return [first, ...returnDates];
}

function alignReturnsToChart(rets, labels) {
  const navs = navFromReturnsForChart(rets);
  return labels.map((_, i) => navs[i] ?? null);
}

function quantilePayloadForSide(snap, side) {
  const q = snap?.quantile;
  if (!q || !q.ret) return null;
  const sideN = normalizeSide(side);
  const ret = {};
  for (let i = 1; i <= 5; i++) {
    const src = sideN === 1 ? `Q${i}` : `Q${6 - i}`;
    ret[`Q${i}`] = q.ret[src] || [];
  }
  ret.LS = sideN === 1
    ? (q.ret.LS || [])
    : (q.ret.LS || []).map(v => v === null || v === undefined ? v : -Number(v));
  return {
    months: q.months || [],
    signal_months: q.signal_months || q.months || [],
    return_dates: q.return_dates || q.months || [],
    ret,
  };
}

function renderQuantileUnavailable(message) {
  const chartDiv = document.getElementById("quantile-chart");
  const kpiDiv = document.getElementById("quantile-kpi");
  if (quantileChart) { quantileChart.dispose(); quantileChart = null; }
  if (chartDiv) chartDiv.innerHTML = `<div class="empty">${message}</div>`;
  if (kpiDiv) kpiDiv.innerHTML = "";
}

function renderIcDecayUnavailable(message) {
  const chartDiv = document.getElementById("ic-decay-chart");
  const tableDiv = document.getElementById("ic-decay-table");
  if (icDecayChart) { icDecayChart.dispose(); icDecayChart = null; }
  if (chartDiv) chartDiv.innerHTML = `<div class="empty">${message}</div>`;
  if (tableDiv) tableDiv.innerHTML = "";
}

async function renderQuantileChartFast(code, snap) {
  const payload = quantilePayloadForSide(snap, state.singleSide);
  if (!payload || !payload.months.length) {
    renderQuantileUnavailable("暂无分位组合数据");
    return;
  }
  const rng = (state.singleStart || state.singleEnd)
    ? `${state.singleStart || "起"}~${state.singleEnd || "今"}` : "全样本";
  document.getElementById("quantile-title").textContent =
    `${code} · ${scoreModeLabel()} 5 分位净值 + 多空（起点=1.0；${rng}；${sideLabel(state.singleSide)}方向）`;

  const chartDiv = document.getElementById("quantile-chart");
  if (quantileChart) { quantileChart.dispose(); quantileChart = null; }
  chartDiv.innerHTML = "";

  const idxs = rangeFilterIndexes(payload.months, state.singleStart, state.singleEnd);
  const returnLabels = labelsByIndexes(payload.return_dates, idxs);
  const signalLabels = labelsByIndexes(payload.signal_months, idxs);
  const x = labelsFromReturnDates(returnLabels, signalLabels);
  if (!x.length) {
    renderQuantileUnavailable("所选区间没有分位组合数据");
    return;
  }

  const colors = {
    Q1: "#b8b8b8",
    Q2: "#8aa6c1",
    Q3: "#6e9a4f",
    Q4: "#e0a23a",
    Q5: "#1a4d80",
    LS: "#c0392b",
  };
  const cn = { Q1: "Q1 低分", Q2: "Q2", Q3: "Q3", Q4: "Q4", Q5: "Q5 高分", LS: "多空 Q5-Q1" };
  const series = [];
  for (const p of ["Q1", "Q2", "Q3", "Q4", "Q5", "LS"]) {
    const arr = payload.ret[p];
    if (!arr) continue;
    const rets = sliceByIndexes(arr, idxs);
    if (!rets.length) continue;
    series.push({
      name: cn[p],
      type: "line",
      data: alignReturnsToChart(rets, x),
      symbol: "none",
      color: colors[p],
      lineStyle: { width: p === "LS" ? 2.6 : 1.4, type: p === "LS" ? "solid" : "dashed" },
      z: p === "LS" ? 5 : 2,
    });
  }

  quantileChart = echarts.init(chartDiv);
  quantileChart.setOption({
    grid: { left: 50, right: 20, top: 34, bottom: 30 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 28 },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true },
    series,
  });
  renderQuantileKpi(payload, idxs);
}

function renderQuantileKpi(payload, idxs) {
  const target = document.getElementById("quantile-kpi");
  const rows = ["Q1", "Q2", "Q3", "Q4", "Q5", "LS"].map(p => {
    const m = metricsFromReturns(sliceByIndexes(payload.ret[p], idxs));
    const label = p === "LS" ? "多空 Q5-Q1" : p;
    if (!m) return `<tr><td>${label}</td><td colspan="6">无数据</td></tr>`;
    return `<tr${p === "LS" ? ' style="font-weight:700;border-top:2px solid #ddd"' : ""}>
      <td>${label}</td>
      <td>${pctText(m.annual)}</td>
      <td>${pctText(m.vol)}</td>
      <td>${numText(m.sharpe, 2)}</td>
      <td>${pctText(m.mdd)}</td>
      <td>${(m.winRate * 100).toFixed(0)}%</td>
      <td>${m.navEnd.toFixed(2)}</td>
    </tr>`;
  }).join("");
  target.innerHTML = `
    <table class="kpi-table">
      <thead><tr>
        <th>分位</th><th>年化收益</th><th>年化波动率</th><th>夏普</th><th>最大回撤</th><th>月度胜率</th><th>期末净值</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">Q5 为当前分析方向下的高分组；反向时 Q1-Q5 会按有效分数重排，多空同步翻向。</p>
  `;
}

function filteredIcDecayStats(decay, side = state.singleSide, startMonth = state.singleStart, endMonth = state.singleEnd) {
  const horizons = (decay?.horizons || [1, 3, 6, 12]).map(Number);
  const sideN = normalizeSide(side);
  return horizons.map((h, idx) => {
    const series = decay?.series?.[String(h)];
    const months = Array.isArray(series?.months) ? series.months : [];
    const vals = Array.isArray(series?.rank_ic) ? series.rank_ic : [];
    let clean = [];
    const hasSeries = months.length && vals.length;
    if (hasSeries) {
      const idxs = rangeFilterIndexes(months, startMonth, endMonth);
      clean = idxs.map(i => vals[i]).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(v => Number(v) * sideN);
    } else {
      const mean = decay?.rank_ic_mean?.[idx];
      if (mean !== null && mean !== undefined && Number.isFinite(Number(mean))) clean = [Number(mean) * sideN];
    }
    const mean = clean.length ? clean.reduce((s, v) => s + v, 0) / clean.length : null;
    const std = clean.length > 1
      ? Math.sqrt(clean.reduce((s, v) => s + (v - mean) ** 2, 0) / (clean.length - 1))
      : null;
    const ir = std && std > 0 ? mean / std * Math.sqrt(12 / h) : null;
    const winRate = clean.length ? clean.filter(v => v > 0).length / clean.length : null;
    const hacT = clean.length > 1
      ? neweyWestTStat(clean, h - 1)
      : snapshotNumber(decay?.hac_t?.[idx]);
    return { h, mean, ir, hacT, winRate, n: hasSeries ? clean.length : (clean.length || decay?.n?.[idx] || 0) };
  });
}

async function renderIcDecayChartFast(code, snap) {
  const target = document.getElementById("ic-decay-table");
  const chartDiv = document.getElementById("ic-decay-chart");
  if (!target || !chartDiv) return;
  if (icDecayChart) { icDecayChart.dispose(); icDecayChart = null; }
  const decay = snap?.ic_decay;
  const stats = filteredIcDecayStats(decay, state.singleSide);
  const hasData = stats.some(s => s.mean !== null && Number.isFinite(Number(s.mean)));
  const rng = (state.singleStart || state.singleEnd)
    ? `${state.singleStart || "起"}~${state.singleEnd || "今"}` : "全样本";
  document.getElementById("ic-decay-title").textContent =
    `${code} · ${scoreModeLabel()} IC 衰减 / 多前瞻期（${rng}；${sideLabel(state.singleSide)}方向）`;
  if (!hasData) {
    chartDiv.innerHTML = `<div class="empty">暂无多前瞻期 IC 数据</div>`;
    target.innerHTML = "";
    return;
  }
  chartDiv.innerHTML = "";
  const labels = stats.map(s => `${s.h}M`);
  icDecayChart = echarts.init(chartDiv);
  icDecayChart.setOption({
    grid: { left: 54, right: 54, top: 34, bottom: 32 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: "category", data: labels, axisLabel: { fontSize: 11 } },
    yAxis: [
      { type: "value", name: "RankIC", scale: true },
      { type: "value", name: "IC_IR", scale: true },
    ],
    series: [
      {
        name: "RankIC均值",
        type: "bar",
        data: stats.map(s => s.mean == null ? null : +s.mean.toFixed(4)),
        itemStyle: { color: "#1a4d80" },
      },
      {
        name: "IC_IR",
        type: "line",
        yAxisIndex: 1,
        data: stats.map(s => s.ir == null ? null : +s.ir.toFixed(3)),
        symbol: "circle",
        lineStyle: { width: 2, color: "#e07b39" },
        itemStyle: { color: "#e07b39" },
      },
    ],
  });
  const rows = stats.map(s => `
    <tr>
      <td>${s.h}个月</td>
      <td>${numText(s.mean, 4)}</td>
      <td>${numText(s.ir, 2)}</td>
      <td>${signedNumText(s.hacT, 2)}</td>
      <td>${s.n}</td>
    </tr>`).join("");
  target.innerHTML = `
    <table class="kpi-table">
      <thead><tr><th>前瞻期</th><th>RankIC均值</th><th>IC_IR</th><th>HAC t值</th><th>样本月数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">前瞻期表示用当前月末因子分数预测未来 1/3/6/12 个月持有收益；IC_IR 按前瞻期年化，HAC t值采用 Newey-West 口径修正 IC 序列自相关。</p>
  `;
}

function pctText(v) {
  return v == null || !Number.isFinite(Number(v)) ? "—" : (Number(v) * 100).toFixed(1) + "%";
}

function signedPctText(v) {
  return v == null || !Number.isFinite(Number(v)) ? "—" : (Number(v) >= 0 ? "+" : "") + (Number(v) * 100).toFixed(1) + "%";
}

function numText(v, d = 2) {
  return v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(d);
}

function signedNumText(v, d = 2) {
  return v == null || !Number.isFinite(Number(v)) ? "—" : (Number(v) >= 0 ? "+" : "") + Number(v).toFixed(d);
}

function htmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlText(s) {
  return htmlAttr(s);
}

function firstSnapshotNumber(...values) {
  for (const value of values) {
    const n = snapshotNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function defaultNeweyWestLags(n) {
  if (!Number.isFinite(Number(n)) || Number(n) < 2) return 0;
  return Math.max(0, Math.floor(4 * Math.pow(Number(n) / 100, 2 / 9)));
}

function neweyWestTStat(values, minLags = 0) {
  const clean = (values || []).map(Number).filter(v => Number.isFinite(v));
  const n = clean.length;
  if (n < 2) return null;
  const mean = clean.reduce((s, v) => s + v, 0) / n;
  const demeaned = clean.map(v => v - mean);
  const maxLag = n - 1;
  const lagCount = Math.min(maxLag, Math.max(defaultNeweyWestLags(n), Number(minLags) || 0));
  let longRunVar = demeaned.reduce((s, v) => s + v * v, 0) / n;
  for (let lag = 1; lag <= lagCount; lag++) {
    let gamma = 0;
    for (let i = lag; i < n; i++) gamma += demeaned[i] * demeaned[i - lag];
    gamma /= n;
    const weight = 1 - lag / (lagCount + 1);
    longRunVar += 2 * weight * gamma;
  }
  if (!Number.isFinite(longRunVar) || longRunVar <= 0) return null;
  return mean / Math.sqrt(longRunVar / n);
}

function metricSignal(metric, value) {
  const n = snapshotNumber(value);
  if (n === null) return { level: "muted", icon: "●", label: "缺失", title: "暂无可判定数据" };
  if (metric === "rank_ic") {
    if (n > 0.10) return { level: "alert", icon: "▲", label: "需核查", title: "RankIC 异常偏高，需排查数据泄露、样本偏差或过拟合" };
    if (n >= 0.05) return { level: "strong", icon: "●", label: "较强", title: "RankIC 大于 5%，排序信息较强" };
    if (n >= 0.03) return { level: "strong", icon: "●", label: "较好", title: "RankIC 位于 3%-5%，较有价值" };
    if (n >= 0.01) return { level: "watch", icon: "●", label: "可观察", title: "RankIC 位于 1%-3%，有一定信息" };
    if (n <= -0.01) return { level: "alert", icon: "▲", label: "反向", title: "当前方向下 RankIC 为负，需检查因子方向" };
    return { level: "weak", icon: "●", label: "偏弱", title: "RankIC 绝对值小于 1%，排序信息偏弱" };
  }
  if (metric === "ic_ir") {
    if (n > 2.0) return { level: "alert", icon: "▲", label: "需核查", title: "IC_IR 异常偏高，需排查过拟合或口径问题" };
    if (n >= 1.0) return { level: "strong", icon: "●", label: "较强", title: "IC_IR 大于 1，稳定性较强" };
    if (n >= 0.5) return { level: "strong", icon: "●", label: "稳定", title: "IC_IR 位于 0.5-1.0，稳定性较好" };
    if (n >= 0.3) return { level: "watch", icon: "●", label: "初步可用", title: "IC_IR 位于 0.3-0.5，需结合其他指标" };
    if (n < 0) return { level: "alert", icon: "▲", label: "反向", title: "IC_IR 为负，需检查因子方向" };
    return { level: "weak", icon: "●", label: "不稳定", title: "IC_IR 小于 0.3，稳定性偏弱" };
  }
  if (metric === "win_rate") {
    if (n >= 0.70) return { level: "alert", icon: "▲", label: "需核查", title: "胜率异常偏高，需确认样本和口径" };
    if (n >= 0.60) return { level: "strong", icon: "●", label: "较稳定", title: "胜率大于 60%，方向较稳定" };
    if (n >= 0.55) return { level: "watch", icon: "●", label: "可接受", title: "胜率位于 55%-60%，可接受" };
    if (n >= 0.50) return { level: "weak", icon: "●", label: "一般", title: "胜率位于 50%-55%，方向优势偏弱" };
    return { level: "weak", icon: "●", label: "偏弱", title: "胜率低于 50%，方向不稳定" };
  }
  if (metric === "sample_months") {
    if (n < 36) return { level: "alert", icon: "▲", label: "样本短", title: "样本月数小于 36，参考意义有限" };
    if (n < 60) return { level: "watch", icon: "●", label: "观察", title: "样本月数 36-60，可初步观察" };
    return { level: "strong", icon: "●", label: "充分", title: "样本月数大于 60，更适合做稳健性判断" };
  }
  if (metric === "q_value") {
    if (n <= 0.05) return { level: "strong", icon: "●", label: "显著", title: "FDR q值不高于 5%，多重检验调整后仍较显著" };
    if (n <= 0.10) return { level: "watch", icon: "●", label: "观察", title: "FDR q值位于 5%-10%，可作为观察信号" };
    return { level: "weak", icon: "●", label: "不显著", title: "FDR q值较高，多重检验调整后证据不足" };
  }
  if (metric === "ann_return") {
    if (n >= 0.15) return { level: "strong", icon: "●", label: "较强", title: "年化收益较高，仍需结合回撤和成本" };
    if (n >= 0.08) return { level: "watch", icon: "●", label: "可用", title: "年化收益为正且有一定幅度" };
    if (n > 0) return { level: "weak", icon: "●", label: "一般", title: "年化收益为正但幅度有限" };
    return { level: "weak", icon: "●", label: "偏弱", title: "年化收益不占优" };
  }
  if (metric === "sharpe") {
    if (n >= 1.5) return { level: "strong", icon: "●", label: "很强", title: "夏普大于 1.5，需加入交易成本后再判断" };
    if (n >= 1.0) return { level: "strong", icon: "●", label: "较好", title: "夏普位于 1.0-1.5，风险调整后表现较好" };
    if (n >= 0.5) return { level: "watch", icon: "●", label: "可用", title: "夏普位于 0.5-1.0，可用但需结合回撤" };
    if (n > 0) return { level: "weak", icon: "●", label: "偏弱", title: "夏普小于 0.5，风险调整后表现偏弱" };
    return { level: "weak", icon: "●", label: "偏弱", title: "夏普不占优" };
  }
  if (metric === "monotonicity") {
    if (n >= 0.8) return { level: "strong", icon: "●", label: "清晰", title: "10 组单调性大于 0.8，分组排序较清晰" };
    if (n >= 0.6) return { level: "watch", icon: "●", label: "较好", title: "10 组单调性大于 0.6，分组排序较好" };
    if (n >= 0.3) return { level: "weak", icon: "●", label: "一般", title: "10 组单调性一般" };
    return { level: "weak", icon: "●", label: "偏弱", title: "分组收益无明显排序" };
  }
  if (metric === "correlation") {
    const a = Math.abs(n);
    if (a >= 0.7) return { level: "alert", icon: "▲", label: "高相关", title: "组合内最高相关性大于 0.7，需核查信号冗余" };
    if (a >= 0.5) return { level: "watch", icon: "●", label: "偏高", title: "组合内相关性偏高，需关注因子冗余" };
    return { level: "weak", icon: "●", label: "观察", title: "组合内相关性未触发高相关提示" };
  }
  return { level: "muted", icon: "●", label: "观察", title: "暂无该指标的判定阈值" };
}

function signalValue(metric, value, text) {
  const signal = metricSignal(metric, value);
  return `<span class="validation-signal signal-${signal.level}" title="${signal.title}">
    <span class="signal-dot">${signal.icon}</span><span class="signal-value">${text}</span><span class="signal-label">${signal.label}</span>
  </span>`;
}

function validationShortSampleWarnings(v, group10Months, segmentRows = [], segmentPortfolioRows = []) {
  const warnings = [];
  const horizonShort = [1, 3, 6, 12]
    .map(h => {
      const n = firstSnapshotNumber(v?.[`rank_ic_n_${h}m`], h === 1 ? v?.n_months : null);
      return n !== null && n < 36 ? `${h}M ${numText(n, 0)} 个月` : null;
    })
    .filter(Boolean);
  if (horizonShort.length) warnings.push(`前瞻期 RankIC 样本较短：${horizonShort.join("、")}`);

  const groupN = snapshotNumber(group10Months);
  if (groupN !== null && groupN < 36) warnings.push(`10 分组样本 ${numText(groupN, 0)} 个月`);

  const shortSegments = (Array.isArray(segmentRows) ? segmentRows : [])
    .filter(r => Number(r?.n_months) > 0 && Number(r.n_months) < 36)
    .slice(0, 3);
  if (shortSegments.length) {
    warnings.push(`分层 IC 存在短样本：${shortSegments.map(r => segmentLabel(r.segment_type, r.segment_value)).join("、")}`);
  }

  const shortPortfolios = (Array.isArray(segmentPortfolioRows) ? segmentPortfolioRows : [])
    .filter(r => Number(r?.n_months) > 0 && Number(r.n_months) < 36)
    .slice(0, 3);
  if (shortPortfolios.length) {
    warnings.push(`分层组合收益存在短样本：${shortPortfolios.map(r => segmentLabel(r.segment_type, r.segment_value)).join("、")}`);
  }

  return [...new Set(warnings)];
}

function renderValidationShortSampleWarning(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return "";
  return `<div class="validation-short-sample"><b>样本不足</b><span>${warnings.join("；")}。样本月数不足 36 时建议降低结论权重，优先结合前瞻期、滚动/样本外和分层结果复核。</span></div>`;
}

function renderValidationIndustryLimitation() {
  return `<div class="validation-short-sample"><b>行业口径</b><span>${STATIC_INDUSTRY_LIMITATION}</span></div>`;
}

function neutralizationQualityWarnings(snap) {
  const mode = normalizeScoreMode(snap?.score_mode || state.singleScoreMode);
  if (mode !== "neutral") return [];
  const manifestQuality = state.dataManifest?.neutralization_quality || null;
  const quality = snap?.neutralization_quality || manifestQuality;
  if (!quality) return [];
  if (quality.has_quality_column === false) {
    return ["当前中性化快照尚未携带 neutralization_quality 字段，请重跑中性化与快照导出后再使用中性口径结论"];
  }
  const sparseRows = Number(quality.insufficient_sample_rows || 0);
  const failedRows = Number(quality.regression_failed_rows || 0);
  const warnings = [];
  if (sparseRows > 0) {
    const months = Number(quality.affected_factor_months || 0);
    const scope = months > 0 ? `${numText(months, 0)} 个因子-月份` : "部分因子-月份";
    warnings.push(`${scope}中性化有效样本不足 3 个，对应中性化分数为空`);
  }
  if (failedRows > 0) warnings.push(`存在 ${numText(failedRows, 0)} 条中性化回归失败记录`);
  if (!warnings.length && quality.warning_level === "warning" && quality.warning) warnings.push(quality.warning);
  return [...new Set(warnings)];
}

function renderNeutralizationQualityWarning(snap) {
  const warnings = neutralizationQualityWarnings(snap);
  if (!warnings.length) return "";
  return `<div class="validation-short-sample"><b>中性化质量</b><span>${warnings.map(htmlText).join("；")}。稀疏截面下的 RankIC、回测和分层结论应降低权重，并结合原始口径复核。</span></div>`;
}

function renderValidationUnavailable(message) {
  const target = document.getElementById("validation-summary");
  if (target) target.innerHTML = `<div class="empty">${message}</div>`;
}

function validationValueBlock(rows) {
  return `<div class="validation-metrics">${rows.map(([label, value]) => `
    <div class="validation-metric"><span>${label}</span><b>${value}</b></div>
  `).join("")}</div>`;
}

function renderValidationInterpretationNote() {
  return `
    <div class="validation-note validation-guide">
      <div class="guide-title">指标怎么看</div>
      <div class="guide-section guide-flow">
        <b>阅读顺序</b>
        <span>先看 RankIC 与 IC_IR 判断排序信号是否稳定，再看 Top30 与 10 分组多空确认组合收益，最后看前瞻期、样本外 / 滚动、分层 IC 和分层组合收益验证结论是否稳健。</span>
      </div>
      <div class="guide-grid">
        <div class="guide-section">
          <b>核心信号</b>
          <ul>
            <li>RankIC均值衡量因子排序与未来收益排序的一致性，绝对值越大说明排序信息越强。</li>
            <li>IC_IR衡量IC序列的稳定性，越高说明信号越不依赖少数月份。</li>
            <li>HAC t值采用 Newey-West 自相关修正，FDR q值用于控制多因子同时检验下的偶然显著。</li>
            <li>胜率看正 IC 月份占比，月度胜率看正收益月份占比，主要反映方向持续性。</li>
          </ul>
        </div>
	        <div class="guide-section">
	          <b>组合表现</b>
	          <ul>
	            <li>Top30超额年化表示 Top30 组合相对基准月收益的年化结果，主要看因子是否提供市场之外的增量收益。</li>
	            <li>Top30超额回撤表示超额收益曲线的最大回撤，数值越低说明相对基准的回撤压力越小。</li>
	            <li>月均换手和年化换手用于衡量交易频率，收益接近时优先关注换手较低、成本压力较小的因子。</li>
	            <li>基准选择用于观察超额收益是否依赖某一个指数，若切换沪深300、中证500、中证800后结论差异很大，需要结合因子市值风格解释。</li>
	            <li>成本敏感性基于月均换手估算不同单边成本下的 Top30 表现，若成本提高后收益明显消失，说明因子对交易摩擦更敏感。</li>
	          </ul>
	        </div>
        <div class="guide-section">
          <b>稳健性检查</b>
          <ul>
            <li>前瞻期用于观察信号衰减，若 1M 有效但 6M/12M 明显转弱，说明信号偏短期。</li>
            <li>样本外 / 滚动用于检查结论是否依赖某一段行情；训练、验证、测试段越一致，越能说明结果不是单纯过拟合。</li>
            <li>分层 IC 用于判断因子是否只在某类股票中有效，若只在单一市值、流动性或行业分层显著，使用时应控制适用范围。</li>
            <li>分层组合收益用于判断同一分层内的 Top/Bottom 排序是否能转化为组合收益；若分层 IC 显著但多空收益不稳定，需要结合换手、行业集中和样本月数复核。</li>
          </ul>
        </div>
        <div class="guide-section">
          <b>新增图表和排序列</b>
          <ul>
            <li>本次新增内容：排行榜新增 IC胜率、超额年化、超额回撤、10组单调性、月均换手等排序列，便于直接按稳定性、相对收益、回撤控制和交易拥挤度筛选因子。</li>
            <li>10组收益柱状图用于观察从低分组到高分组的收益排序是否清晰，柱子越接近单调递增或递减，因子排序越有经济含义。</li>
            <li>36个月滚动 IC_IR 曲线用于观察信号稳定性是否随时间衰退或阶段性失效，若长期在 0 附近或频繁转负，需要谨慎使用。</li>
            <li>分层 IC 热力图用于比较因子在市值、流动性、行业等分层中的有效性，若颜色只集中在少数分层，说明因子更适合限定适用范围或配合约束使用。</li>
            <li>分层组合收益表展示同一分层内 Top/Bottom 与多空收益，重点看多空年化、回撤、胜率和换手是否同时可接受。</li>
            <li>分层组合收益图按多空年化展示各分层收益强弱，并在提示中同步展示多空回撤、胜率、换手和样本月数，用于快速识别收益是否只集中在少数分层。</li>
          </ul>
        </div>
      </div>
      <div class="guide-section guide-thresholds">
        <b>经验参考区间，不是硬性标准</b>
        <span>|RankIC| < 1% 通常偏弱，1%-3% 有一定信息，3%-5% 较有价值，>5% 较强，>10% 需排查数据泄露或样本偏差；IC_IR <0.3 不稳定，0.3-0.5 初步可用，0.5-1.0 稳定性较好，>1.0 较强，>2.0 需排查过拟合或口径问题；FDR q值 ≤5% 说明多重检验调整后仍较显著，5%-10% 可观察；IC胜率 / 月度胜率 55%-60% 可接受，>60% 较稳定；样本月数 <36 参考意义有限，36-60 可初步观察，>60 更适合做稳健性判断。</span>
      </div>
      <div class="guide-foot">页面中的 ● 为经验等级提示，▲ 表示异常偏高、方向反向、样本过短或其他需核查情况。完整基准、分层、样本切片和交易成本口径记录在 docs/2026-06-26_因子检验口径说明.md。</div>
    </div>`;
}

function group10PayloadForSide(snap, side) {
  const g = snap?.group10;
  if (!g || !g.returns) return null;
  const groups = Array.isArray(g.groups) && g.groups.length ? g.groups : Array.from({ length: 10 }, (_, i) => `G${i + 1}`);
  const sideN = normalizeSide(side);
  const visibleGroups = sideN === 1 ? groups : [...groups].reverse();
  const returns = {};
  const nav = {};
  const annReturns = {};
  visibleGroups.forEach((label, idx) => {
    const dst = `G${idx + 1}`;
    returns[dst] = g.returns[label] || [];
    nav[dst] = g.nav?.[label] || [];
    annReturns[dst] = snapshotNumber(g.annReturns?.[label]);
  });
  returns.LS = sideN === 1
    ? (g.returns.LS || [])
    : (g.returns.LS || []).map(v => v === null || v === undefined ? v : -Number(v));
  nav.LS = navFromReturnsForChart(returns.LS || []).slice(1);
  return {
    groups,
    months: g.months || [],
    signal_months: g.signal_months || g.months || [],
    return_dates: g.return_dates || g.months || [],
    returns,
    nav,
    annReturns,
  };
}

function renderGroup10ValidationTable(snap) {
  const payload = group10PayloadForSide(snap, state.singleSide);
  if (!payload || !payload.months.length) {
    return `<div class="empty">暂无 10 分组回测数据</div>`;
  }
  const idxs = rangeFilterIndexes(payload.months, state.singleStart, state.singleEnd);
  const groups = Array.from({ length: 10 }, (_, i) => `G${i + 1}`);
  const rows = groups.map(g => {
    const arr = sliceByIndexes(payload.returns[g], idxs);
    const m = metricsFromReturns(arr);
    return `<tr>
      <td>${g}${g === "G10" ? " 高分" : (g === "G1" ? " 低分" : "")}</td>
      <td>${signalValue("ann_return", m?.annual, pctText(m?.annual))}</td>
      <td>${signalValue("sharpe", m?.sharpe, m ? numText(m.sharpe, 2) : "—")}</td>
      <td>${pctText(m?.mdd)}</td>
      <td>${m ? numText(m.navEnd, 2) : "—"}</td>
    </tr>`;
  }).join("");
  const ls = metricsFromReturns(sliceByIndexes(payload.returns.LS, idxs));
  return `
    <table class="validation-table">
      <thead><tr><th>分组</th><th>年化收益</th><th>夏普</th><th>最大回撤</th><th>期末净值</th></tr></thead>
      <tbody>
        ${rows}
        <tr style="border-top:2px solid #d8dee6;font-weight:700">
          <td>LS 高-低</td><td>${signalValue("ann_return", ls?.annual, pctText(ls?.annual))}</td><td>${signalValue("sharpe", ls?.sharpe, ls ? numText(ls.sharpe, 2) : "—")}</td><td>${pctText(ls?.mdd)}</td><td>${ls ? numText(ls.navEnd, 2) : "—"}</td>
        </tr>
      </tbody>
    </table>`;
}

function renderGroup10ValidationChart(snap) {
  const div = document.getElementById("group10-validation-chart");
  if (!div) return;
  if (group10ValidationChart) { group10ValidationChart.dispose(); group10ValidationChart = null; }
  const payload = group10PayloadForSide(snap, state.singleSide);
  if (!payload || !payload.months.length) {
    div.innerHTML = `<div class="empty">暂无 10 分组柱状图数据</div>`;
    return;
  }
  const groups = Array.from({ length: 10 }, (_, i) => `G${i + 1}`);
  const data = groups.map(g => snapshotNumber(payload.annReturns?.[g]));
  if (!data.some(v => v !== null)) {
    div.innerHTML = `<div class="empty">暂无 10 分组柱状图数据</div>`;
    return;
  }
  div.innerHTML = "";
  group10ValidationChart = echarts.init(div);
  group10ValidationChart.setOption({
    grid: { left: 54, right: 20, top: 24, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: v => pctText(v) },
    xAxis: { type: "category", data: groups, axisLabel: { fontSize: 11 } },
    yAxis: { type: "value", axisLabel: { formatter: v => `${(v * 100).toFixed(0)}%` } },
    series: [{
      name: "分组年化收益",
      type: "bar",
      data,
      barMaxWidth: 22,
      itemStyle: { color: "#1a4d80" },
    }],
  });
}

function renderRollingValidationTable(snap) {
  const rows = Array.isArray(snap?.rolling?.windows) ? snap.rolling.windows : [];
  if (!rows.length) return `<div class="empty">暂无滚动/样本外检验数据</div>`;
  const labels = {
    full: "全样本",
    recent_5y: "近5年",
    recent_3y: "近3年",
    train: "训练段",
    validation: "验证段",
    test: "测试段",
  };
  const order = ["full", "recent_5y", "recent_3y", "train", "validation", "test"];
  const byType = new Map(rows.map(r => [r.window_type, r]));
  const body = order.filter(t => byType.has(t)).map(t => {
    const r = byType.get(t);
    return `<tr>
      <td>${labels[t] || t}</td>
      <td>${r.window_start || "—"} ~ ${r.window_end || "—"}</td>
      <td>${signalValue("sample_months", r.n_months, numText(r.n_months, 0))}</td>
      <td>${signalValue("rank_ic", r.rank_ic_mean, signedPctText(r.rank_ic_mean))}</td>
      <td>${signalValue("ic_ir", r.rank_ic_ir, signedNumText(r.rank_ic_ir, 2))}</td>
      <td>${signalValue("win_rate", r.rank_ic_win_rate, pctText(r.rank_ic_win_rate))}</td>
      <td>${signalValue("ann_return", r.top30_ann_return, pctText(r.top30_ann_return))}</td>
      <td>${signalValue("sharpe", r.top30_sharpe, signedNumText(r.top30_sharpe, 2))}</td>
    </tr>`;
  }).join("");
  return `
    <h4 style="margin-top:12px;color:#1a4d80;font-size:12px">样本外 / 滚动</h4>
    <table class="validation-table">
      <thead><tr><th>窗口</th><th>区间</th><th>月数</th><th>RankIC均值</th><th>IC_IR</th><th>胜率</th><th>Top30年化</th><th>Top30夏普</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderRolling36mChart(snap) {
  const div = document.getElementById("rolling-36m-chart");
  if (!div) return;
  if (rolling36mChart) { rolling36mChart.dispose(); rolling36mChart = null; }
  const rows = Array.isArray(snap?.rolling?.rolling_36m) ? snap.rolling.rolling_36m : [];
  const clean = rows.filter(r => r.window_end && Number.isFinite(Number(r.rank_ic_ir)));
  if (!clean.length) {
    div.innerHTML = `<div class="empty">暂无 36 个月滚动 IC_IR 数据</div>`;
    return;
  }
  div.innerHTML = "";
  rolling36mChart = echarts.init(div);
  rolling36mChart.setOption({
    grid: { left: 46, right: 20, top: 24, bottom: 34 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: clean.map(r => String(r.window_end).slice(0, 7)), axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", name: "IC_IR", scale: true },
    series: [{
      name: "rolling_36m IC_IR",
      type: "line",
      data: clean.map(r => +Number(r.rank_ic_ir).toFixed(3)),
      symbol: "none",
      lineStyle: { width: 2, color: "#19734d" },
      areaStyle: { color: "rgba(25,115,77,0.10)" },
    }],
  });
}

function segmentLabel(type, value) {
  if (type === "all") return "全市场";
  if (type === "market_cap_bucket") return `市值-${value}`;
  if (type === "liquidity_bucket") return `流动性-${value}`;
  if (type === "industry_sw1") return `行业-${value}`;
  return `${type}-${value}`;
}

function renderSegmentValidationTable(snap) {
  const rows = Array.isArray(snap?.segments?.rows) ? snap.segments.rows : [];
  if (!rows.length) return `<div class="empty">暂无分层 IC 数据</div>`;
  const body = rows.map(r => `<tr>
    <td>${segmentLabel(r.segment_type, r.segment_value)}</td>
    <td>${r.horizon_months}M</td>
    <td>${signalValue("sample_months", r.n_months, numText(r.n_months, 0))}</td>
    <td>${numText(r.avg_n_stocks, 0)}</td>
    <td>${signalValue("rank_ic", r.rank_ic_mean, signedPctText(r.rank_ic_mean))}</td>
    <td>${signalValue("ic_ir", r.rank_ic_ir, signedNumText(r.rank_ic_ir, 2))}</td>
    <td>${signalValue("win_rate", r.rank_ic_win_rate, pctText(r.rank_ic_win_rate))}</td>
  </tr>`).join("");
  return `
    <h4 style="margin-top:12px;color:#1a4d80;font-size:12px">分层 IC</h4>
    <table class="validation-table">
      <thead><tr><th>分层</th><th>前瞻期</th><th>月数</th><th>平均股票数</th><th>RankIC均值</th><th>IC_IR</th><th>胜率</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderSegmentPortfolioTable(snap) {
  const rows = Array.isArray(snap?.segment_portfolio?.rows) ? snap.segment_portfolio.rows : [];
  if (!rows.length) return `<div class="empty">暂无分层组合收益数据</div>`;
  const body = rows.map(r => `<tr>
    <td>${segmentLabel(r.segment_type, r.segment_value)}</td>
    <td>${signalValue("sample_months", r.n_months, numText(r.n_months, 0))}</td>
    <td>${numText(r.avg_n_stocks, 0)}</td>
    <td>${signalValue("ann_return", r.top_ann_return, pctText(r.top_ann_return))}</td>
    <td>${signalValue("ann_return", r.bottom_ann_return, pctText(r.bottom_ann_return))}</td>
    <td>${signalValue("ann_return", r.ls_ann_return, signedPctText(r.ls_ann_return))}</td>
    <td>${pctText(r.ls_max_drawdown)}</td>
    <td>${signalValue("win_rate", r.ls_month_win_rate, pctText(r.ls_month_win_rate))}</td>
    <td>${pctText(r.ls_avg_turnover)}</td>
  </tr>`).join("");
  return `
    <h4 style="margin-top:12px;color:#1a4d80;font-size:12px">分层组合收益</h4>
    <table class="validation-table">
      <thead><tr><th>分层</th><th>月数</th><th>平均股票数</th><th>Top年化</th><th>Bottom年化</th><th>多空年化</th><th>多空回撤</th><th>多空胜率</th><th>多空换手</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderSegmentPortfolioChart(snap) {
  const div = document.getElementById("segment-portfolio-chart");
  if (!div) return;
  if (segmentPortfolioChart) { segmentPortfolioChart.dispose(); segmentPortfolioChart = null; }
  const rows = Array.isArray(snap?.segment_portfolio?.rows) ? snap.segment_portfolio.rows : [];
  const clean = rows
    .filter(r => Number.isFinite(Number(r.ls_ann_return)))
    .sort((a, b) => Math.abs(Number(b.ls_ann_return)) - Math.abs(Number(a.ls_ann_return)))
    .slice(0, 18)
    .reverse();
  if (!clean.length) {
    div.innerHTML = `<div class="empty">暂无分层组合收益图数据</div>`;
    return;
  }
  div.innerHTML = "";
  segmentPortfolioChart = echarts.init(div);
  segmentPortfolioChart.setOption({
    grid: { left: 118, right: 28, top: 28, bottom: 34 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: params => {
        const p = params && params[0];
        const r = clean[p?.dataIndex || 0] || {};
        return [
          `<b>${segmentLabel(r.segment_type, r.segment_value)}</b>`,
          `多空年化：${signedPctText(r.ls_ann_return)}`,
          `多空回撤：${pctText(r.ls_max_drawdown)}`,
          `多空胜率：${pctText(r.ls_month_win_rate)}`,
          `多空换手：${pctText(r.ls_avg_turnover)}`,
          `样本月数：${numText(r.n_months, 0)}`,
        ].join("<br>");
      },
    },
    xAxis: { type: "value", axisLabel: { formatter: v => `${(v * 100).toFixed(0)}%` } },
    yAxis: { type: "category", data: clean.map(r => segmentLabel(r.segment_type, r.segment_value)), axisLabel: { fontSize: 10 } },
    series: [{
      name: "分层组合收益图 多空年化",
      type: "bar",
      data: clean.map(r => +Number(r.ls_ann_return).toFixed(6)),
      barMaxWidth: 16,
      itemStyle: { color: p => Number(p.value) >= 0 ? "#19734d" : "#ad3b32" },
      markLine: { symbol: "none", lineStyle: { color: "#9aa4b2", type: "dashed", width: 1 }, data: [{ xAxis: 0 }] },
    }],
  });
}

function renderSegmentHeatmap(snap) {
  const div = document.getElementById("segment-heatmap");
  if (!div) return;
  if (segmentHeatmapChart) { segmentHeatmapChart.dispose(); segmentHeatmapChart = null; }
  const rows = Array.isArray(snap?.segments?.rows) ? snap.segments.rows : [];
  const clean = rows.filter(r => Number(r.horizon_months) === 1 && Number.isFinite(Number(r.rank_ic_ir)));
  if (!clean.length) {
    div.innerHTML = `<div class="empty">暂无分层 RankIC_IR 热力图数据</div>`;
    return;
  }
  const xLabels = [...new Set(clean.map(r => `${r.segment_type}`))];
  const yLabels = [...new Set(clean.map(r => segmentLabel(r.segment_type, r.segment_value)))];
  const xMap = new Map(xLabels.map((v, i) => [v, i]));
  const yMap = new Map(yLabels.map((v, i) => [v, i]));
  const data = clean.map(r => [
    xMap.get(r.segment_type),
    yMap.get(segmentLabel(r.segment_type, r.segment_value)),
    +Number(r.rank_ic_ir).toFixed(3),
  ]);
  div.innerHTML = "";
  segmentHeatmapChart = echarts.init(div);
  segmentHeatmapChart.setOption({
    grid: { left: 110, right: 28, top: 24, bottom: 34 },
    tooltip: { position: "top", formatter: p => `${xLabels[p.value[0]]}<br>${yLabels[p.value[1]]}: ${numText(p.value[2], 2)}` },
    xAxis: { type: "category", data: xLabels, axisLabel: { fontSize: 10 } },
    yAxis: { type: "category", data: yLabels, axisLabel: { fontSize: 10 } },
    visualMap: { min: -1, max: 1, calculable: false, orient: "horizontal", left: "center", bottom: 0,
      inRange: { color: ["#ad3b32", "#f2f4f7", "#19734d"] } },
    series: [{ name: "分层 RankIC_IR", type: "heatmap", data }],
  });
}

function renderValidationPanel(code, snap) {
  const target = document.getElementById("validation-summary");
  if (!target) return;
  const v = snap?.validation || {};
  const hasValidation = Object.keys(v).length > 0;
  const hasGroup10 = !!(snap?.group10?.months?.length);
  if (!hasValidation && !hasGroup10) {
    renderValidationUnavailable("暂无因子检验摘要。请先运行新版因子检验流水线。");
    return;
  }
  const side = normalizeSide(state.singleSide);
  const rankIcMean = snapshotNumber(v.rank_ic_mean_1m);
  const rankIcIr = snapshotNumber(v.rank_ic_ir_1m);
  const rankIcWin = snapshotNumber(v.rank_ic_win_rate_1m);
  const rankIcHacT = snapshotNumber(v.rank_ic_hac_t_stat_1m);
  const rankIcP = snapshotNumber(v.rank_ic_p_value_1m);
  const rankIcQ = snapshotNumber(v.rank_ic_q_value_1m);
  const groupMono = snapshotNumber(v.group10_monotonicity);
  const top30Sharpe = snapshotNumber(v.top30_sharpe);
  const top30Annual = firstSnapshotNumber(v.top30_ann_return, v.top30_annual_return);
  const top30Mdd = snapshotNumber(v.top30_max_drawdown);
  const top30Win = firstSnapshotNumber(v.top30_month_win_rate, v.top30_win_rate);
  const top30Turnover = snapshotNumber(v.top30_avg_turnover);
  const top30AnnTurnover = snapshotNumber(v.top30_ann_turnover);
  const benchmarkCode = BENCHMARK_OPTIONS.some(b => b.code === state.validationBenchmark) ? state.validationBenchmark : "HS300";
  state.validationBenchmark = benchmarkCode;
  const selectedBenchmark = BENCHMARK_OPTIONS.find(b => b.code === benchmarkCode);
  const excessByBenchmark = computeTop30ExcessForBenchmark(snap, state.benchmarkSnapshot, benchmarkCode, state.singleSide);
  const top30ExcessAnnual = excessByBenchmark.annual ?? snapshotNumber(v.top30_excess_ann_return);
  const top30ExcessMdd = excessByBenchmark.mdd ?? snapshotNumber(v.top30_excess_max_drawdown);
  const fullGroup10 = group10PayloadForSide(snap, state.singleSide);
  const fullLsReturns = (fullGroup10?.returns?.LS || [])
    .filter(x => x !== null && x !== undefined && Number.isFinite(Number(x)))
    .map(Number);
  const fullLsMetrics = metricsFromReturns(fullLsReturns);
  const lsAnnual = fullLsMetrics?.annual ?? firstSnapshotNumber(v.group10_ls_ann_return, v.group10_ls_annual_return);
  const lsSharpe = fullLsMetrics?.sharpe ?? snapshotNumber(v.group10_ls_sharpe);
  const lsMonths = fullLsReturns.length || snapshotNumber(v.group10_ls_n);
  const segmentRows = Array.isArray(snap?.segments?.rows) ? snap.segments.rows : [];
  const segmentPortfolioRows = Array.isArray(snap?.segment_portfolio?.rows) ? snap.segment_portfolio.rows : [];
  const shortSampleWarnings = validationShortSampleWarnings(v, lsMonths, segmentRows, segmentPortfolioRows);
  const decayStats = filteredIcDecayStats(snap?.ic_decay, state.singleSide, null, null);
  const adjustedRankIcMean = rankIcMean === null ? null : rankIcMean * side;
  const adjustedRankIcIr = rankIcIr === null ? null : rankIcIr * side;
  const adjustedRankIcHacT = rankIcHacT === null ? null : rankIcHacT * side;
  const adjustedGroupMono = groupMono === null ? null : groupMono * side;
  const decayRows = [1, 3, 6, 12].map(h => {
    const fromValidation = {
      mean: snapshotNumber(v[`rank_ic_mean_${h}m`]),
      ir: snapshotNumber(v[`rank_ic_ir_${h}m`]),
      win: snapshotNumber(v[`rank_ic_win_rate_${h}m`]),
      n: snapshotNumber(v[`rank_ic_n_${h}m`]),
    };
    const fromDecay = decayStats.find(s => s.h === h) || {};
    const mean = fromValidation.mean !== null ? fromValidation.mean * side : fromDecay.mean;
    const ir = fromValidation.ir !== null ? fromValidation.ir * side : fromDecay.ir;
    const winRate = fromValidation.win !== null ? fromValidation.win : fromDecay.winRate;
    const n = fromValidation.n !== null ? fromValidation.n : fromDecay.n;
    return `
      <tr>
        <td>${h}M</td>
        <td>${signalValue("rank_ic", mean, signedPctText(mean))}</td>
        <td>${signalValue("ic_ir", ir, signedNumText(ir, 2))}</td>
        <td>${signedNumText(fromDecay.hacT, 2)}</td>
        <td>${signalValue("win_rate", winRate, pctText(winRate))}</td>
        <td>${signalValue("sample_months", n, numText(n, 0))}</td>
      </tr>`;
  }).join("");

  target.innerHTML = `
    ${renderValidationInterpretationNote()}
    ${renderValidationIndustryLimitation()}
    ${renderNeutralizationQualityWarning(snap)}
    ${renderBenchmarkSelect()}
    ${renderValidationShortSampleWarning(shortSampleWarnings)}
    <div class="validation-grid">
      <div class="validation-block">
        <h4>有效性</h4>
        ${validationValueBlock([
          ["1M RankIC均值", signalValue("rank_ic", adjustedRankIcMean, signedPctText(adjustedRankIcMean))],
          ["1M IC_IR", signalValue("ic_ir", adjustedRankIcIr, signedNumText(adjustedRankIcIr, 2))],
          ["1M HAC t值", signedNumText(adjustedRankIcHacT, 2)],
          ["原始 p值", numText(rankIcP, 3)],
          ["FDR q值", signalValue("q_value", rankIcQ, numText(rankIcQ, 3))],
          ["IC胜率", signalValue("win_rate", rankIcWin, pctText(rankIcWin))],
          ["10组单调性", signalValue("monotonicity", adjustedGroupMono, signedNumText(adjustedGroupMono, 2))],
        ])}
      </div>
      <div class="validation-block">
        <h4>Top30 默认表现</h4>
        ${validationValueBlock([
          ["年化收益", signalValue("ann_return", top30Annual, pctText(top30Annual))],
          ["夏普", signalValue("sharpe", top30Sharpe, signedNumText(top30Sharpe, 2))],
          ["最大回撤", pctText(top30Mdd)],
          ["月度胜率", signalValue("win_rate", top30Win, pctText(top30Win))],
          [`超额年化(${selectedBenchmark?.label || benchmarkCode})`, signalValue("ann_return", top30ExcessAnnual, signedPctText(top30ExcessAnnual))],
          ["超额回撤", pctText(top30ExcessMdd)],
          ["月均换手", pctText(top30Turnover)],
          ["年化换手", numText(top30AnnTurnover, 1)],
        ])}
      </div>
      <div class="validation-block">
        <h4>10 分组多空</h4>
        ${validationValueBlock([
          ["LS年化收益", signalValue("ann_return", lsAnnual, pctText(lsAnnual))],
          ["LS夏普", signalValue("sharpe", lsSharpe, signedNumText(lsSharpe, 2))],
          ["样本月数", signalValue("sample_months", lsMonths, numText(lsMonths, 0))],
          ["展示方向", sideLabel(state.singleSide)],
        ])}
      </div>
    </div>
    <table class="validation-table">
      <thead><tr><th>前瞻期</th><th>RankIC均值</th><th>IC_IR</th><th>HAC t值</th><th>胜率</th><th>样本月数</th></tr></thead>
      <tbody>${decayRows}</tbody>
    </table>
    ${renderCostSensitivityTable(snap, top30Turnover, state.singleSide)}
    ${renderGroup10ValidationTable(snap)}
    <div id="group10-validation-chart" class="validation-chart"></div>
    ${renderRollingValidationTable(snap)}
    <div id="rolling-36m-chart" class="validation-chart"></div>
    ${renderSegmentValidationTable(snap)}
    <h4 class="validation-subtitle">分层组合收益图</h4>
    <div id="segment-portfolio-chart" class="validation-chart validation-segment-portfolio-chart"></div>
    ${renderSegmentPortfolioTable(snap)}
    <div id="segment-heatmap" class="validation-chart validation-heatmap"></div>
    <p class="validation-note">${code} · ${scoreModeLabel()}。摘要指标为离线全样本统计；Top30 摘要和超额指标随当前分析方向、区间和基准选择重算；10 分组是无行业约束的排序有效性检验，表格随当前回测区间重算展示。</p>
  `;
  const bmSelect = document.getElementById("validation-benchmark-select");
  if (bmSelect) {
    bmSelect.onchange = () => {
      state.validationBenchmark = bmSelect.value;
      renderValidationPanel(code, snap);
    };
  }
  renderGroup10ValidationChart(snap);
  renderRolling36mChart(snap);
  renderSegmentPortfolioChart(snap);
  renderSegmentHeatmap(snap);
}

function benchmarkSeries(snapshot, months, indexCode) {
  const bmMonths = snapshot?.months || [];
  const arr = snapshot?.nav?.[indexCode] || [];
  const mp = new Map(bmMonths.map((m, i) => [m, arr[i]]));
  return months.map(m => {
    const v = mp.get(m);
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  });
}

function rebaseNav(arr) {
  const base = arr.find(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
  return base ? arr.map(v => v === null || v === undefined ? null : +(Number(v) / base).toFixed(6)) : arr;
}

function benchmarkMetrics(snapshot, startMonth = null, endMonth = null) {
  const out = {};
  const months = snapshot?.months || [];
  const idxs = rangeFilterIndexes(months, startMonth, endMonth);
  for (const [code, arr] of Object.entries(snapshot?.nav || {})) {
    const navs = idxs.map(i => arr[i]).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    if (navs.length < 2) continue;
    const rets = navs.slice(1).map((v, i) => v / navs[i] - 1);
    out[code] = computeMetrics(rets, navs);
  }
  return out;
}

async function renderNavChartSide(code, side, snap = null) {
  const ns = state.selectedNs;
  const rng = (state.singleStart || state.singleEnd)
    ? `${state.singleStart || "起"}~${state.singleEnd || "今"}` : "全样本";
  document.getElementById("nav-title").textContent =
    `${factorSideName(code, side)} · ${scoreModeLabel()} / ${constraintModeLabel()}组合净值对比 top-[${ns.join(", ")}]（起点=1.0；${rng}，${constraintHoldText()}，单边 0.2%，按换手扣成本）`;

  const chartDiv = document.getElementById("nav-chart");
  if (navChart) { navChart.dispose(); navChart = null; }
  chartDiv.innerHTML = "";

  const series = [];
  let x = [];
  for (const [i, n] of ns.entries()) {
    const bt = snap
      ? sideBacktestFromSnapshot(snap, side, n)
      : sliceBacktestByRange(await factorSideBacktest(code, side, n), state.singleStart, state.singleEnd);
    if (!x.length && bt.x.length) x = bt.x;
    series.push({
      name: `top${n}${sideSuffix(side)}`,
      type: "line",
      data: bt.navArr,
      symbol: "none",
      color: STRAT_COLORS[i % STRAT_COLORS.length],
      lineStyle: { width: 2 },
    });
  }

  if (x.length) {
    const bm = snap ? await ensureBenchmarkSnapshot() : await ensureBenchmarkSnapshot();
    const colors = { "HS300": "#c14545", "CSI800": "#6e9a4f", "CSI500": "#c89c2b" };
    const cnNames = { "HS300": "沪深300", "CSI800": "中证800", "CSI500": "中证500" };
    for (const idxCode of ["HS300", "CSI800", "CSI500"]) {
      const rebased = rebaseNav(benchmarkSeries(bm, x.map(monthOfLabel), idxCode));
      if (!rebased.some(v => v !== null)) continue;
      series.push({
        name: `${cnNames[idxCode] || idxCode}(基准)`,
        type: "line", data: rebased, symbol: "none", connectNulls: true,
        color: colors[idxCode] || "#888",
        lineStyle: { width: 1.2, type: "dashed" },
      });
    }
  }

  navChart = echarts.init(chartDiv);
  navChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 32 },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true },
    series,
  });
}

// 基准年化（用于超额计算），按当前选定区间对齐（区间变 → 重算，不缓存跨区间）
async function benchAnnuals() {
  if (state.benchmarkSnapshot) {
    const ms = benchmarkMetrics(state.benchmarkSnapshot, state.singleStart, state.singleEnd);
    return Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, v.annual]));
  }
  const out = {};
  if (state.hasBenchmarks) {
    const r = await state.db.query(`
      SELECT index_code, nav FROM benchmarks
      WHERE index_code IN ('HS300','CSI800')
        ${rangeWhere(state.singleStart, state.singleEnd)}
      ORDER BY index_code, trade_date
    `);
    const g = {};
    for (const row of r.toArray()) { (g[row.index_code] ||= []).push(row.nav); }
    for (const [k, arr] of Object.entries(g)) {
      if (arr.length >= 2) out[k] = Math.pow(arr[arr.length - 1] / arr[0], 12 / arr.length) - 1;
    }
  }
  return out;
}

async function renderKpiTable(code) {
  const target = document.getElementById("kpi");
  // 查所选各 N 在区间内的月收益，区间内重建净值（mdd/年化口径对齐区间）
  const res = await state.db.query(`
    SELECT top_n, port_ret FROM preset_backtest
    WHERE factor_code = '${code}' AND top_n IN (${state.selectedNs.join(",")})
      ${backtestRangeWhere(state.singleStart, state.singleEnd)}
    ORDER BY top_n, trade_date
  `);
  const byN = {};
  for (const r of res.toArray()) {
    if (!byN[r.top_n]) byN[r.top_n] = { rets: [], navs: [1] };   // navs 以真实起点 1.0 开头，确保首月收益计入
    if (r.port_ret !== null) {
      const o = byN[r.top_n];
      o.rets.push(r.port_ret);
      o.navs.push(o.navs[o.navs.length - 1] * (1 + r.port_ret));
    }
  }
  const ba = await benchAnnuals();

  // 因子级 IC_IR（与 N 无关）：区间内 RankIC 均值 / 标准差，按有效观测频率年化。
  const icRes = await state.db.query(`
    SELECT strftime(COALESCE(return_month, month), '%Y-%m') AS ym, rank_ic FROM factor_ic
    WHERE factor_code = '${code}' AND NOT ISNAN(rank_ic)
      ${icRangeWhere(state.singleStart, state.singleEnd)}
    ORDER BY ym
  `);
  const icRows = icRes.toArray();
  const icStats = rankIcStats(icRows.map(r => r.ym), icRows.map(r => r.rank_ic), 1, 1);
  const icir = icStats.ir == null ? "—" : icStats.ir.toFixed(2);

  const pct = (v) => (v * 100).toFixed(1) + "%";
  const signed = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
  let rows = "";
  for (const n of state.selectedNs) {
    const d = byN[n];
    const m = d ? computeMetrics(d.rets, d.navs) : null;
    if (!m) { rows += `<tr><td>top${n}</td><td colspan="7">无数据</td></tr>`; continue; }
    const ex300 = ("HS300" in ba) ? signed(m.annual - ba.HS300) : "—";
    const ex800 = ("CSI800" in ba) ? signed(m.annual - ba.CSI800) : "—";
    rows += `<tr>
      <td>top${n}</td>
      <td>${pct(m.annual)}</td>
      <td>${pct(m.vol)}</td>
      <td>${numText(m.sharpe, 2)}</td>
      <td>${pct(m.mdd)}</td>
      <td>${(m.winRate * 100).toFixed(0)}%</td>
      <td>${ex300}</td>
      <td>${ex800}</td>
    </tr>`;
  }

  // 基准行：从月末 nav 序列算绝对指标（超额列对基准自身无意义，留 —）
  if (state.hasBenchmarks) {
    const cnNames = { "HS300": "沪深300", "CSI800": "中证800", "CSI500": "中证500" };
    const bRes = await state.db.query(`
      SELECT index_code, nav FROM benchmarks
      WHERE index_code IN ('HS300','CSI800','CSI500')
        ${rangeWhere(state.singleStart, state.singleEnd)}
      ORDER BY index_code, trade_date
    `);
    const bg = {};
    for (const r of bRes.toArray()) { (bg[r.index_code] ||= []).push(r.nav); }
    for (const idx of ["HS300", "CSI800", "CSI500"]) {
      const navs = bg[idx];
      if (!navs || navs.length < 2) continue;
      const rets = navs.slice(1).map((v, i) => v / navs[i] - 1);
      const m = computeMetrics(rets, navs);
      rows += `<tr style="color:#888;border-top:2px solid #ddd">
        <td style="color:#888">${cnNames[idx]}</td>
        <td>${pct(m.annual)}</td>
        <td>${pct(m.vol)}</td>
        <td>${numText(m.sharpe, 2)}</td>
        <td>${pct(m.mdd)}</td>
        <td>${(m.winRate * 100).toFixed(0)}%</td>
        <td>—</td><td>—</td>
      </tr>`;
    }
  }

  target.innerHTML = `
    <table class="kpi-table">
      <thead><tr>
        <th>组合 / 基准</th><th>年化收益</th><th>年化波动率</th><th>夏普</th><th>最大回撤</th>
        <th>月度胜率</th><th>超额 vs 300</th><th>超额 vs 800</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">区间内 RankIC IC_IR：${icir}（与持仓数无关）</p>
  `;
}

async function renderKpiTableFast(code, snap, scoreSnap = snap) {
  const target = document.getElementById("kpi");
  const months = monthsFromSnapshot(snap);
  const idxs = rangeFilterIndexes(months, state.singleStart, state.singleEnd);
  const bm = await ensureBenchmarkSnapshot();
  const bmMetrics = benchmarkMetrics(bm, state.singleStart, state.singleEnd);
  const icMonths = scoreSnap.ic?.months || [];
  const icIdxs = rangeFilterIndexes(icMonths, state.singleStart, state.singleEnd);
  const rankStats = rankIcStats(sliceByIndexes(icMonths, icIdxs), sliceByIndexes(scoreSnap.ic?.rank_ic, icIdxs), 1, 1);
  const icir = rankStats.ir == null ? "—" : rankStats.ir.toFixed(2);

  let rows = "";
  for (const n of state.selectedNs) {
    const bt = snap.backtests?.[String(n)];
    const m = bt ? metricsFromReturns(sliceByIndexes(bt.ret, idxs)) : null;
    if (!m) { rows += `<tr><td>top${n}</td><td colspan="7">无数据</td></tr>`; continue; }
    rows += `<tr>
      <td>top${n} · ${constraintModeLabel()}</td>
      <td>${pctText(m.annual)}</td>
      <td>${pctText(m.vol)}</td>
      <td>${numText(m.sharpe, 2)}</td>
      <td>${pctText(m.mdd)}</td>
      <td>${(m.winRate * 100).toFixed(0)}%</td>
      <td>${bmMetrics.HS300 ? signedPctText(m.annual - bmMetrics.HS300.annual) : "—"}</td>
      <td>${bmMetrics.CSI800 ? signedPctText(m.annual - bmMetrics.CSI800.annual) : "—"}</td>
    </tr>`;
  }

  const cnNames = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
  for (const idx of ["HS300", "CSI800", "CSI500"]) {
    const m = bmMetrics[idx];
    if (!m) continue;
    rows += `<tr style="color:#888;border-top:2px solid #ddd">
      <td style="color:#888">${cnNames[idx]}</td>
      <td>${pctText(m.annual)}</td>
      <td>${pctText(m.vol)}</td>
      <td>${numText(m.sharpe, 2)}</td>
      <td>${pctText(m.mdd)}</td>
      <td>${(m.winRate * 100).toFixed(0)}%</td>
      <td>—</td><td>—</td>
    </tr>`;
  }

  target.innerHTML = `
    <table class="kpi-table">
      <thead><tr>
        <th>组合 / 基准</th><th>年化收益</th><th>年化波动率</th><th>夏普</th><th>最大回撤</th>
        <th>月度胜率</th><th>超额 vs 300</th><th>超额 vs 800</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">区间内 RankIC IC_IR：${icir}（跟随分数口径，与持仓数和组合约束无关）</p>
  `;
}

async function renderKpiTableSide(code, side, snap = null, scoreSnap = snap) {
  const target = document.getElementById("kpi");
  const bm = await ensureBenchmarkSnapshot();
  const bmMetrics = benchmarkMetrics(bm, state.singleStart, state.singleEnd);
  const sideN = normalizeSide(side);
  const icMonths = scoreSnap?.ic?.months || [];
  const icIdxs = rangeFilterIndexes(icMonths, state.singleStart, state.singleEnd);
  const rankStats = scoreSnap
    ? rankIcStats(sliceByIndexes(icMonths, icIdxs), sliceByIndexes(scoreSnap.ic?.rank_ic, icIdxs), sideN, 1)
    : { ir: null };
  const icir = rankStats.ir == null ? "—" : rankStats.ir.toFixed(2);

  let rows = "";
  for (const n of state.selectedNs) {
    const bt = snap
      ? sideBacktestFromSnapshot(snap, side, n)
      : sliceBacktestByRange(await factorSideBacktest(code, side, n), state.singleStart, state.singleEnd);
    const m = bt.retArr.length ? computeMetrics(bt.retArr, bt.navArr) : null;
    if (!m) { rows += `<tr><td>top${n}${sideSuffix(side)}</td><td colspan="7">无数据</td></tr>`; continue; }
    rows += `<tr>
      <td>top${n}${sideSuffix(side)} · ${constraintModeLabel()}</td>
      <td>${pctText(m.annual)}</td>
      <td>${pctText(m.vol)}</td>
      <td>${numText(m.sharpe, 2)}</td>
      <td>${pctText(m.mdd)}</td>
      <td>${(m.winRate * 100).toFixed(0)}%</td>
      <td>${bmMetrics.HS300 ? signedPctText(m.annual - bmMetrics.HS300.annual) : "—"}</td>
      <td>${bmMetrics.CSI800 ? signedPctText(m.annual - bmMetrics.CSI800.annual) : "—"}</td>
    </tr>`;
  }

  const cnNames = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
  for (const idx of ["HS300", "CSI800", "CSI500"]) {
    const m = bmMetrics[idx];
    if (!m) continue;
    rows += `<tr style="color:#888;border-top:2px solid #ddd">
      <td style="color:#888">${cnNames[idx]}</td>
      <td>${pctText(m.annual)}</td>
      <td>${pctText(m.vol)}</td>
      <td>${numText(m.sharpe, 2)}</td>
      <td>${pctText(m.mdd)}</td>
      <td>${(m.winRate * 100).toFixed(0)}%</td>
      <td>—</td><td>—</td>
    </tr>`;
  }

  target.innerHTML = `
    <table class="kpi-table">
      <thead><tr>
        <th>组合 / 基准</th><th>年化收益</th><th>年化波动率</th><th>夏普</th><th>最大回撤</th>
        <th>月度胜率</th><th>超额 vs 300</th><th>超额 vs 800</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">区间内 RankIC IC_IR：${icir}（跟随分数口径，与持仓数和组合约束无关）</p>
  `;
}

// 指标-N 曲线：横轴持仓数 1-100，纵轴当前选定指标
async function renderNScan(code) {
  const metricLabels = { annual: "年化收益", vol: "年化波动率", sharpe: "夏普比率", mdd: "最大回撤" };
  document.getElementById("scan-title").textContent =
    `${code} · ${scoreModeLabel()} / ${constraintModeLabel()} ${metricLabels[state.scanMetric]} vs 持仓数（top-1 ~ top-100 全扫描）`;
  const chartDiv = document.getElementById("scan-chart");
  if (scanChart) { scanChart.dispose(); scanChart = null; }
  chartDiv.innerHTML = "";

  const res = await state.db.query(`
    SELECT top_n, port_ret FROM preset_backtest
    WHERE factor_code = '${code}'
      ${backtestRangeWhere(state.singleStart, state.singleEnd)}
    ORDER BY top_n, trade_date
  `);
  const byN = {};
  for (const r of res.toArray()) {
    if (!byN[r.top_n]) byN[r.top_n] = { rets: [], navs: [1] };   // navs 以起点 1.0 开头
    if (r.port_ret !== null) {
      const o = byN[r.top_n];
      o.rets.push(r.port_ret);
      o.navs.push(o.navs[o.navs.length - 1] * (1 + r.port_ret));
    }
  }
  const xs = Object.keys(byN).map(Number).sort((a, b) => a - b);
  const ys = xs.map(n => {
    const m = computeMetrics(byN[n].rets, byN[n].navs);
    if (!m) return null;
    if (state.scanMetric === "annual") return +(m.annual * 100).toFixed(2);
    if (state.scanMetric === "sharpe") return Number.isFinite(Number(m.sharpe)) ? +Number(m.sharpe).toFixed(3) : null;
    if (state.scanMetric === "mdd") return +(m.mdd * 100).toFixed(2);
    return +(m.vol * 100).toFixed(2);   // 波动率（年化，%）
  });
  // 标出当前所选的 N
  const marks = state.selectedNs.map(n => {
    const idx = xs.indexOf(n);
    return idx >= 0 ? { xAxis: n, yAxis: ys[idx] } : null;
  }).filter(Boolean);

  scanChart = echarts.init(chartDiv);
  scanChart.setOption({
    grid: { left: 55, right: 20, top: 20, bottom: 36 },
    tooltip: { trigger: "axis", formatter: p => `top${p[0].axisValue}<br/>${metricLabels[state.scanMetric]}: ${p[0].data}` },
    xAxis: { type: "category", data: xs, name: "持仓数 N", nameLocation: "middle", nameGap: 24, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true },
    series: [{
      type: "line", data: ys, symbol: "none", smooth: true,
      lineStyle: { color: "#1a4d80", width: 1.8 },
      markPoint: { data: marks.map(m => ({ coord: [String(m.xAxis), m.yAxis] })), symbol: "pin", symbolSize: 36,
                   itemStyle: { color: "#e07b39" }, label: { fontSize: 9, formatter: p => "N=" + p.data.coord[0] } },
    }],
  });
}

async function renderNScanFast(code, snap) {
  const metricLabels = { annual: "年化收益", vol: "年化波动率", sharpe: "夏普比率", mdd: "最大回撤" };
  document.getElementById("scan-title").textContent =
    `${code} · ${scoreModeLabel()} / ${constraintModeLabel()} ${metricLabels[state.scanMetric]} vs 持仓数（top-1 ~ top-100 全扫描）`;
  const chartDiv = document.getElementById("scan-chart");
  if (scanChart) { scanChart.dispose(); scanChart = null; }
  chartDiv.innerHTML = "";

  const months = monthsFromSnapshot(snap);
  const idxs = rangeFilterIndexes(months, state.singleStart, state.singleEnd);
  const xs = Object.keys(snap.backtests || {}).map(Number).sort((a, b) => a - b);
  const ys = xs.map(n => {
    const bt = snap.backtests?.[String(n)];
    const m = bt ? metricsFromReturns(sliceByIndexes(bt.ret, idxs)) : null;
    if (!m) return null;
    if (state.scanMetric === "annual") return +(m.annual * 100).toFixed(2);
    if (state.scanMetric === "sharpe") return Number.isFinite(Number(m.sharpe)) ? +Number(m.sharpe).toFixed(3) : null;
    if (state.scanMetric === "mdd") return +(m.mdd * 100).toFixed(2);
    return +(m.vol * 100).toFixed(2);
  });
  const marks = state.selectedNs.map(n => {
    const idx = xs.indexOf(n);
    return idx >= 0 ? { xAxis: n, yAxis: ys[idx] } : null;
  }).filter(Boolean);

  scanChart = echarts.init(chartDiv);
  scanChart.setOption({
    grid: { left: 55, right: 20, top: 20, bottom: 36 },
    tooltip: { trigger: "axis", formatter: p => `top${p[0].axisValue}<br/>${metricLabels[state.scanMetric]}: ${p[0].data}` },
    xAxis: { type: "category", data: xs, name: "持仓数 N", nameLocation: "middle", nameGap: 24, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true },
    series: [{
      type: "line", data: ys, symbol: "none", smooth: true,
      lineStyle: { color: "#1a4d80", width: 1.8 },
      markPoint: { data: marks.map(m => ({ coord: [String(m.xAxis), m.yAxis] })), symbol: "pin", symbolSize: 36,
                   itemStyle: { color: "#e07b39" }, label: { fontSize: 9, formatter: p => "N=" + p.data.coord[0] } },
    }],
  });
}

async function renderNScanSide(code, side, snap = null) {
  const metricLabels = { annual: "年化收益", vol: "年化波动率", sharpe: "夏普比率", mdd: "最大回撤" };
  document.getElementById("scan-title").textContent =
    `${factorSideName(code, side)} · ${scoreModeLabel()} / ${constraintModeLabel()} ${metricLabels[state.scanMetric]} vs 持仓数（top-1 ~ top-100 全扫描）`;
  const chartDiv = document.getElementById("scan-chart");
  if (scanChart) { scanChart.dispose(); scanChart = null; }
  chartDiv.innerHTML = "";

  const xs = PRESET_NS.slice();
  const rows = snap ? null : await factorSideRankedRows(code, side, 100);
  const ys = xs.map(n => {
    const sliced = snap
      ? sideBacktestFromSnapshot(snap, side, n)
      : sliceBacktestByRange(buildBacktestFromRows(rows.filter(r => r.rk <= n), n), state.singleStart, state.singleEnd);
    const m = sliced.retArr.length ? computeMetrics(sliced.retArr, sliced.navArr) : null;
    if (!m) return null;
    if (state.scanMetric === "annual") return +(m.annual * 100).toFixed(2);
    if (state.scanMetric === "sharpe") return Number.isFinite(Number(m.sharpe)) ? +Number(m.sharpe).toFixed(3) : null;
    if (state.scanMetric === "mdd") return +(m.mdd * 100).toFixed(2);
    return +(m.vol * 100).toFixed(2);
  });
  const marks = state.selectedNs.map(n => {
    const idx = xs.indexOf(n);
    return idx >= 0 ? { xAxis: n, yAxis: ys[idx] } : null;
  }).filter(Boolean);

  scanChart = echarts.init(chartDiv);
  scanChart.setOption({
    grid: { left: 55, right: 20, top: 20, bottom: 36 },
    tooltip: { trigger: "axis", formatter: p => `top${p[0].axisValue}<br/>${metricLabels[state.scanMetric]}: ${p[0].data}` },
    xAxis: { type: "category", data: xs, name: "持仓数 N", nameLocation: "middle", nameGap: 24, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true },
    series: [{
      type: "line", data: ys, symbol: "none", smooth: true,
      lineStyle: { color: "#1a4d80", width: 1.8 },
      markPoint: { data: marks.map(m => ({ coord: [String(m.xAxis), m.yAxis] })), symbol: "pin", symbolSize: 36,
                   itemStyle: { color: "#e07b39" }, label: { fontSize: 9, formatter: p => "N=" + p.data.coord[0] } },
    }],
  });
}

// ===================== 模式切换 + 多因子对比 =====================

function onTreeClick(code) {
  if (state.mode === "single") selectFactor(code);
  else if (state.mode === "compare") addCompareFactor(code);   // 对比：每次点击加一行（允许重复）
  else if (state.mode === "compose") toggleComposeFactor(code);  // 合成：toggle
  else {
    switchMode("single");
    selectFactor(code, { preserveParams: true });
  }
}

function cmpHas(code) { return state.compareFactors.some(f => f.code === code); }
function cpsHas(code) { return state.composeFactors.some(f => f.code === code); }

function updateTreeHighlight() {
  document.querySelectorAll(".tree-l3").forEach(el => {
    const c = el.dataset.code;
    let on = false;
    if (state.mode === "single") on = (c === state.activeFactor);
    else if (state.mode === "compare") on = cmpHas(c);
    else if (state.mode === "compose") on = cpsHas(c);
    el.classList.toggle("active", on);
  });
}

function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("single-view").style.display = mode === "single" ? "flex" : "none";
  document.getElementById("compare-view").style.display = mode === "compare" ? "flex" : "none";
  document.getElementById("compose-view").style.display = mode === "compose" ? "flex" : "none";
  document.getElementById("combo-library-view").style.display = mode === "library" ? "flex" : "none";
  document.getElementById("admin-view").style.display = mode === "admin" ? "flex" : "none";
  document.getElementById("ranking-view").style.display = mode === "ranking" ? "flex" : "none";
  updateTreeHighlight();
  if (mode === "compare") {
    initCompareRangeControls().catch(e => console.warn("compare range init failed:", e));
    renderCompare();
  }
  if (mode === "compose") {
    initComposeRangeControls().catch(e => console.warn("compose range init failed:", e));
    renderCompose();
  }
  if (mode === "library") renderComboLibrary();
  if (mode === "admin") {
    renderAdminView();
    if (state.adminSession?.access_token) {
      loadAdminData().catch(e => console.error("refresh admin data failed:", e));
    }
  }
  if (mode === "ranking") renderRanking();
}

function addCompareFactor(code) {
  state.compareFactors.push({
    code,
    n: state.compareDefaultN,
    side: 1,
    scoreMode: "raw",
    constraintMode: "none",
  });
  updateTreeHighlight();
  renderCompare();
}

function removeCompareAt(i) {
  state.compareFactors.splice(i, 1);
  updateTreeHighlight();
  renderCompare();
}

// 渲染每个已选因子 + 各自持仓数选择器
function renderCmpControls() {
  const box = document.getElementById("cmp-controls");
  if (state.compareFactors.length === 0) {
    box.innerHTML = `<div class="empty">未选因子</div>`;
    return;
  }
  // 用 index 标识每一行（同因子可重复，不能用 code）
  box.innerHTML = state.compareFactors.map((raw, i) => {
    const f = normalizeCompareFactor(raw);
    state.compareFactors[i] = f;
    return `
    <span class="cmp-frow" style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 6px 0;flex-wrap:wrap">
      <span style="width:10px;height:10px;border-radius:50%;background:${STRAT_COLORS[i % STRAT_COLORS.length]};display:inline-block"></span>
      <b style="font-size:12px">${f.code}</b>
      <select class="cmp-side" data-idx="${i}" style="font-size:12px;padding:2px;border:1px solid #ccc;border-radius:3px">
        <option value="1"${normalizeSide(f.side) === 1 ? " selected" : ""}>默认</option>
        <option value="-1"${normalizeSide(f.side) === -1 ? " selected" : ""}>反向</option>
      </select>
      <select class="cmp-score-mode" data-idx="${i}" style="font-size:12px;padding:2px;border:1px solid #ccc;border-radius:3px">
        <option value="raw"${normalizeScoreMode(f.scoreMode) === "raw" ? " selected" : ""}>原始口径</option>
        <option value="neutral"${normalizeScoreMode(f.scoreMode) === "neutral" ? " selected" : ""}>行业市值中性</option>
      </select>
      <select class="cmp-constraint-mode" data-idx="${i}" style="font-size:12px;padding:2px;border:1px solid #ccc;border-radius:3px">
        <option value="none"${normalizeConstraintMode(f.constraintMode) === "none" ? " selected" : ""}>无约束等权</option>
        <option value="industry"${normalizeConstraintMode(f.constraintMode) === "industry" ? " selected" : ""}>行业中性</option>
      </select>
      <span style="color:#888;font-size:11px">top</span>
      <input class="cmp-n-input" data-idx="${i}" type="number" min="1" max="100" value="${f.n}"
             style="width:52px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:12px" />
      <span class="cmp-remove" data-idx="${i}"
            style="cursor:pointer;color:#c14545;font-size:13px;padding:0 2px">×</span>
    </span>
  `; }).join("");
  box.querySelectorAll(".cmp-n-input").forEach(inp => {
    inp.addEventListener("change", () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const f = state.compareFactors[idx];
      if (!f) return;
      const n = parseInt(inp.value, 10);
      if (!Number.isFinite(n) || n < 1 || n > 100) { inp.value = f.n; return; }
      f.n = n;
      renderCmpTable(); renderCmpNav();   // IC/相关性与 N 无关，不重画
    });
  });
  box.querySelectorAll(".cmp-side").forEach(sel => {
    sel.onchange = () => {
      const f = state.compareFactors[parseInt(sel.dataset.idx, 10)];
      if (!f) return;
      f.side = normalizeSide(sel.value);
      renderCompare();
    };
  });
  box.querySelectorAll(".cmp-score-mode").forEach(sel => {
    sel.onchange = () => {
      const f = state.compareFactors[parseInt(sel.dataset.idx, 10)];
      if (!f) return;
      f.scoreMode = normalizeScoreMode(sel.value);
      renderCompare();
    };
  });
  box.querySelectorAll(".cmp-constraint-mode").forEach(sel => {
    sel.onchange = () => {
      const f = state.compareFactors[parseInt(sel.dataset.idx, 10)];
      if (!f) return;
      f.constraintMode = normalizeConstraintMode(sel.value);
      renderCompare();
    };
  });
  box.querySelectorAll(".cmp-remove").forEach(x => {
    x.onclick = () => removeCompareAt(parseInt(x.dataset.idx, 10));
  });
}

function compareFallbackBlockedReason(sel) {
  const offender = (sel || []).find(f =>
    normalizeSide(f.side) !== 1
    || normalizeScoreMode(f.scoreMode) !== "raw"
    || normalizeConstraintMode(f.constraintMode) !== "none"
  );
  if (!offender) return "";
  return `当前对比包含方向、分数口径或组合约束的非默认设置（${offender.code}：scoreMode=${normalizeScoreMode(offender.scoreMode)}，constraintMode=${normalizeConstraintMode(offender.constraintMode)}）。快速快照加载失败时不退回原始口径，避免把不同口径结果画成同一口径。`;
}

async function renderCompare() {
  const sel = state.compareFactors;
  document.getElementById("cmp-selected").textContent = sel.length ? `（已选 ${sel.length} 个）` : "";
  renderCmpControls();
  try {
    await initCompareRangeControls();
    if (sel.length === 0) {
      document.getElementById("cmp-table").innerHTML = `<div class="empty">从左侧选 1 个以上因子开始对比</div>`;
      return;
    }
    await Promise.all([
      Promise.all([...new Set(sel.map(f => f.code))].map(code => loadSingleSnapshot(code))),
      ensureBenchmarkSnapshot(),
      ensureCorrSnapshot(),
    ]);
    await Promise.all([renderCmpTableFast(), renderCmpNavFast(), renderCmpIcFast(), renderCmpCorrFast()]);
  } catch (err) {
    console.warn("fast renderCompare failed, falling back to DuckDB:", err);
    const blockedReason = compareFallbackBlockedReason(sel);
    if (blockedReason) {
      const msg = `${blockedReason}\n\n原始错误：${err.message || err}`;
      document.getElementById("cmp-table").innerHTML =
        `<pre style="color:#c00;white-space:pre-wrap;font-size:11px">${htmlText(msg)}</pre>`;
      document.getElementById("cmp-nav").innerHTML = `<div class="empty">对比净值未渲染：${htmlText(blockedReason)}</div>`;
      document.getElementById("cmp-ic").innerHTML = `<div class="empty">IC 对比未渲染：${htmlText(blockedReason)}</div>`;
      document.getElementById("cmp-corr").innerHTML = `<div class="empty">相关性未渲染：${htmlText(blockedReason)}</div>`;
      return;
    }
    try {
      await ensureDB();
      await ensureFactorData(sel.map(f => f.code), { score: false });
      await Promise.all([renderCmpTable(), renderCmpNav(), renderCmpIc(), renderCmpCorr()]);
    } catch (fallbackErr) {
      console.error("renderCompare failed:", fallbackErr);
      document.getElementById("cmp-table").innerHTML =
        `<pre style="color:#c00;white-space:pre-wrap;font-size:11px">对比渲染失败：${fallbackErr.message || fallbackErr}\n\n${fallbackErr.stack || ""}</pre>`;
    }
  }
}

// 每因子用各自 n 拼 OR 条件： (factor_code='A' AND top_n=10) OR ...
function cmpPairCond() {
  return state.compareFactors.map(f => `(factor_code='${f.code}' AND top_n=${f.n})`).join(" OR ");
}

async function renderCmpTable() {
  const target = document.getElementById("cmp-table");
  document.getElementById("cmp-table-title").textContent = `因子指标对比表（各因子可设不同持仓数）`;
  if (state.compareFactors.length === 0) {
    target.innerHTML = `<div class="empty">从左侧选 1 个以上因子开始对比</div>`;
    return;
  }
  const inList = [...new Set(state.compareFactors.map(f => `'${f.code}'`))].join(",");
  // 各因子用各自 n 取月收益；按 (code,n) 分组（同因子可重复用不同 N）
  const res = await state.db.query(`
    SELECT factor_code, top_n, port_ret, nav FROM preset_backtest
    WHERE ${cmpPairCond()}
      ${backtestRangeWhere(state.compareStart, state.compareEnd)}
    ORDER BY factor_code, top_n, trade_date
  `);
  const byKey = {};
  for (const r of res.toArray()) {
    const k = `${r.factor_code}_${r.top_n}`;
    if (!byKey[k]) byKey[k] = { rets: [] };
    if (r.port_ret !== null) byKey[k].rets.push(r.port_ret);
  }
  // 各因子 IC 统计（与 N 无关）：区间内 RankIC 均值 + 年化 IC_IR。
  const icRes = await state.db.query(`
    SELECT factor_code,
           strftime(COALESCE(return_month, month), '%Y-%m') AS ym,
           rank_ic
    FROM factor_ic WHERE factor_code IN (${inList}) AND NOT ISNAN(rank_ic)
      ${icRangeWhere(state.compareStart, state.compareEnd)}
    ORDER BY factor_code, ym
  `);
  const icMap = {};
  for (const r of icRes.toArray()) {
    if (!icMap[r.factor_code]) icMap[r.factor_code] = { months: [], values: [] };
    icMap[r.factor_code].months.push(r.ym);
    icMap[r.factor_code].values.push(r.rank_ic);
  }

  const ba = await benchAnnuals();
  const pct = (v) => (v * 100).toFixed(1) + "%";
  const num = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v).toFixed(d));

  // 收集成行对象（数值留原始值，渲染时再格式化），供点表头排序用
  const factors = [];
  for (const f of state.compareFactors) {
    const code = f.code;
    f.side = normalizeSide(f.side);
    let m = null;
    if (f.side === 1) {
      const d = byKey[`${code}_${f.n}`];
      m = d ? metricsFromReturns(d.rets) : null;
    } else {
      const fullBt = await factorSideBacktest(code, f.side, f.n);
      const sliced = sliceBacktestByRange(fullBt, state.compareStart, state.compareEnd);
      m = sliced.retArr.length ? computeMetrics(sliced.retArr, sliced.navArr) : null;
    }
    const ic = icMap[code] || { months: [], values: [] };
    const icStats = rankIcStats(ic.months, ic.values, f.side, 1);
    const label = `${factorSideName(code, f.side)} <span style="color:#888;font-weight:400">top${f.n}</span>`;
    if (!m) { factors.push({ label, noData: true }); continue; }
    factors.push({
      label, annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      ex300: ("HS300" in ba) ? (m.annual - ba.HS300) : null,
      ic_mean: icStats.mean,
      icir: icStats.ir,
    });
  }
  // 基准行（固定排在底部，不参与排序）
  const benches = [];
  if (state.hasBenchmarks) {
    const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
    const bRes = await state.db.query(`
      SELECT index_code, nav FROM benchmarks
      WHERE index_code IN ('HS300','CSI800','CSI500')
        ${rangeWhere(state.compareStart, state.compareEnd)}
      ORDER BY index_code, trade_date
    `);
    const bg = {};
    for (const r of bRes.toArray()) (bg[r.index_code] ||= []).push(r.nav);
    for (const idx of ["HS300", "CSI800", "CSI500"]) {
      const navs = bg[idx]; if (!navs || navs.length < 2) continue;
      const rets = navs.slice(1).map((v, i) => v / navs[i] - 1);
      const m = computeMetrics(rets, navs);
      benches.push({ label: cn[idx], annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd,
                     winRate: m.winRate, ex300: null, ic_mean: null, icir: null });
    }
  }
  _cmpRows = { factors, benches };
  drawCmpTable();
}

async function renderCmpTableFast() {
  const target = document.getElementById("cmp-table");
  document.getElementById("cmp-table-title").textContent = `因子指标对比表（方向 / 分数口径 / 组合约束均可单独设置）`;
  if (state.compareFactors.length === 0) {
    target.innerHTML = `<div class="empty">从左侧选 1 个以上因子开始对比</div>`;
    return;
  }
  const bm = await ensureBenchmarkSnapshot();
  const ba = benchmarkMetrics(bm, state.compareStart, state.compareEnd);
  const factors = [];
  for (const f of state.compareFactors) {
    Object.assign(f, normalizeCompareFactor(f));
    const snap = await loadSingleSnapshot(f.code);
    const scoreSnap = activeScoreSnapshotFor(snap, f.scoreMode);
    const portSnap = activePortfolioSnapshotFor(snap, f.scoreMode, f.constraintMode);
    const months = monthsFromSnapshot(portSnap);
    const idxs = rangeFilterIndexes(months, state.compareStart, state.compareEnd);
    let m = null;
    if (f.side === 1) {
      const bt = portSnap.backtests?.[String(f.n)];
      m = bt ? metricsFromReturns(sliceByIndexes(bt.ret, idxs)) : null;
    } else {
      const sliced = sideBacktestFromSnapshot(portSnap, f.side, f.n);
      m = sliced.retArr.length ? computeMetrics(sliced.retArr, sliced.navArr) : null;
    }
    const icMonths = scoreSnap.ic?.months || [];
    const icIdxs = rangeFilterIndexes(icMonths, state.compareStart, state.compareEnd);
    const rankStats = rankIcStats(
      sliceByIndexes(icMonths, icIdxs),
      sliceByIndexes(scoreSnap.ic?.rank_ic, icIdxs),
      f.side,
      1,
    );
    const label = `${factorParamName(f.code, f.side, f.scoreMode, f.constraintMode)} <span style="color:#888;font-weight:400">top${f.n}</span>`;
    if (!m) { factors.push({ label, noData: true }); continue; }
    factors.push({
      label, annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      ex300: ba.HS300 ? (m.annual - ba.HS300.annual) : null,
      ic_mean: rankStats.mean, icir: rankStats.ir,
    });
  }

  const benches = [];
  const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
  for (const idx of ["HS300", "CSI800", "CSI500"]) {
    const m = ba[idx];
    if (!m) continue;
    benches.push({ label: cn[idx], annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd,
                   winRate: m.winRate, ex300: null, ic_mean: null, icir: null });
  }
  _cmpRows = { factors, benches };
  drawCmpTable();
}

// 对比表列定义 + 排序状态。点表头排序（因子行排序，基准行始终在底部）。
let _cmpRows = null;
let _cmpSort = { key: null, dir: -1 };
function drawCmpTable() {
  const target = document.getElementById("cmp-table");
  if (!target || !_cmpRows) return;
  const pct = v => (v == null || !Number.isFinite(v)) ? "—" : (v * 100).toFixed(1) + "%";
  const num = (v, d = 2) => (v == null || !Number.isFinite(v)) ? "—" : Number(v).toFixed(d);
  const COLS = [
    { key: "label",   label: "因子 / 基准", sortable: false, cell: r => r.label },
    { key: "annual",  label: "年化收益",   cell: r => pct(r.annual) },
    { key: "vol",     label: "年化波动率", cell: r => pct(r.vol) },
    { key: "sharpe",  label: "夏普",       cell: r => num(r.sharpe, 2) },
    { key: "mdd",     label: "最大回撤",   cell: r => pct(r.mdd) },
    { key: "winRate", label: "月度胜率",   cell: r => r.winRate == null ? "—" : (r.winRate * 100).toFixed(0) + "%" },
    { key: "ex300",   label: "超额 vs 300", cell: r => pct(r.ex300) },
    { key: "ic_mean", label: "RankIC 均值", cell: r => num(r.ic_mean, 3) },
    { key: "icir",    label: "IC_IR",      cell: r => num(r.icir, 2) },
  ];
  const factors = _cmpRows.factors.slice();
  const sk = _cmpSort.key;
  if (sk) {
    factors.sort((a, b) => {
      const va = a[sk], vb = b[sk];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;            // 无值（含 noData）永远排末尾
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * _cmpSort.dir;
    });
  }
  const arrow = k => _cmpSort.key === k ? (_cmpSort.dir < 0 ? " ▼" : " ▲") : "";
  const thead = COLS.map(c => c.sortable === false
    ? `<th>${c.label}</th>`
    : `<th class="cmp-sort" data-key="${c.key}">${c.label}${arrow(c.key)}</th>`).join("");
  const rowHtml = (r, bench) => {
    if (r.noData) return `<tr><td>${r.label}</td><td colspan="${COLS.length - 1}">无数据</td></tr>`;
    const tds = COLS.map(c => `<td>${c.cell(r)}</td>`).join("");
    return `<tr${bench ? ' style="color:#888;border-top:2px solid #ddd"' : ''}>${tds}</tr>`;
  };
  const body = factors.map(r => rowHtml(r, false)).join("") + _cmpRows.benches.map(r => rowHtml(r, true)).join("");
  target.innerHTML = `<table class="kpi-table"><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table>`;
  target.querySelectorAll("th.cmp-sort").forEach(th => th.onclick = () => {
    const k = th.dataset.key;
    if (_cmpSort.key === k) _cmpSort.dir = -_cmpSort.dir;
    else { _cmpSort.key = k; _cmpSort.dir = -1; }   // 首次点某列默认降序
    drawCmpTable();
  });
}

async function renderCmpNav() {
  const rng = (state.compareStart || state.compareEnd)
    ? `${state.compareStart || "起"}~${state.compareEnd || "今"}` : "全样本";
  document.getElementById("cmp-nav-title").textContent = `组合净值叠加（各因子按各自持仓数，起点=1.0；${rng}）`;
  const div = document.getElementById("cmp-nav-chart");
  if (cmpNavChart) { cmpNavChart.dispose(); cmpNavChart = null; }
  div.innerHTML = "";
  if (state.compareFactors.length === 0) { div.innerHTML = `<div class="empty">选因子后显示</div>`; return; }

  const res = await state.db.query(`
    SELECT factor_code, top_n,
           strftime(trade_date,'%Y-%m') AS signal_dt,
           strftime(COALESCE(return_date, trade_date),'%Y-%m-%d') AS dt,
           port_ret
    FROM preset_backtest WHERE ${cmpPairCond()}
      ${backtestRangeWhere(state.compareStart, state.compareEnd)}
    ORDER BY factor_code, top_n, trade_date
  `);
  const byKey = {};
  for (const r of res.toArray()) {
    const k = `${r.factor_code}_${r.top_n}`;
    const s = (byKey[k] ||= { dt: [], nav: [] });
    if (!s.dt.length) {
      s.dt.push(r.signal_dt);
      s.nav.push(1.0);
    }
    s.dt.push(r.dt);
    s.nav.push(s.nav[s.nav.length - 1] * (1 + (r.port_ret ?? 0)));
  }
  const first = state.compareFactors[0];
  const x = (byKey[`${first.code}_${first.n}`] || { dt: [] }).dt;
  const series = state.compareFactors.map((f, i) => {
    const s = byKey[`${f.code}_${f.n}`]; if (!s) return null;
    return { name: `${f.code} top${f.n}`, type: "line", symbol: "none",
             data: s.nav,
             color: STRAT_COLORS[i % STRAT_COLORS.length],
             lineStyle: { width: 2 } };
  }).filter(Boolean);

  if (state.hasBenchmarks && x.length) {
    const bmRes = await state.db.query(`
      SELECT index_code, strftime(trade_date,'%Y-%m') AS dt, nav FROM benchmarks
      WHERE strftime(trade_date,'%Y-%m') >= '${monthOfLabel(x[0])}'
        AND strftime(trade_date,'%Y-%m') <= '${monthOfLabel(x[x.length-1])}'
      ORDER BY index_code, trade_date
    `);
    const byIdx = {};
    for (const r of bmRes.toArray()) { (byIdx[r.index_code] ||= {})[r.dt] = r.nav; }
    const colors = { HS300: "#c14545", CSI800: "#6e9a4f", CSI500: "#c89c2b" };
    const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
    for (const idx of ["HS300", "CSI800", "CSI500"]) {
      const mm = byIdx[idx]; if (!mm) continue;
      const aligned = x.map(m => (monthOfLabel(m) in mm ? mm[monthOfLabel(m)] : null));
      const b = aligned.find(v => v !== null);
      series.push({ name: `${cn[idx]}(基准)`, type: "line", symbol: "none", connectNulls: true,
        data: b ? aligned.map(v => v === null ? null : v / b) : aligned,
        color: colors[idx],
        lineStyle: { width: 1.2, type: "dashed" } });
    }
  }
  cmpNavChart = echarts.init(div);
  cmpNavChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" }, legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 32 },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true }, series,
  });
}

async function renderCmpNavFast() {
  const rng = (state.compareStart || state.compareEnd)
    ? `${state.compareStart || "起"}~${state.compareEnd || "今"}` : "全样本";
  const paramSummary = [...new Set(state.compareFactors.map(raw => {
    const f = normalizeCompareFactor(raw);
    return `${scoreModeLabel(f.scoreMode)}/${constraintModeLabel(f.constraintMode)}`;
  }))].join("、");
  document.getElementById("cmp-nav-title").textContent =
    `组合净值叠加（${paramSummary || "各因子按各自方向/口径/约束"}，起点=1.0；${rng}）`;
  const div = document.getElementById("cmp-nav-chart");
  if (cmpNavChart) { cmpNavChart.dispose(); cmpNavChart = null; }
  div.innerHTML = "";
  if (state.compareFactors.length === 0) { div.innerHTML = `<div class="empty">选因子后显示</div>`; return; }

  const snaps = await Promise.all(state.compareFactors.map(f => loadSingleSnapshot(f.code)));
  let x = [];
  const series = [];
  for (const [i, f] of state.compareFactors.entries()) {
    Object.assign(f, normalizeCompareFactor(f));
    const snap = snaps[i];
    const portSnap = activePortfolioSnapshotFor(snap, f.scoreMode, f.constraintMode);
    let data = null;
    if (f.side === 1) {
      const months = monthsFromSnapshot(portSnap || {});
      const returnDates = returnDatesFromSnapshot(portSnap || {});
      const idxs = rangeFilterIndexes(months, state.compareStart, state.compareEnd);
      const labels = labelsFromReturnDates(
        labelsByIndexes(returnDates, idxs),
        labelsByIndexes(signalMonthsFromSnapshot(portSnap || {}), idxs)
      );
      if (!x.length && labels.length) x = labels;
      const bt = portSnap.backtests?.[String(f.n)];
      if (!bt) continue;
      data = alignReturnsToChart(sliceByIndexes(bt.ret, idxs), x);
    } else {
      const bt = sideBacktestFromSnapshot(portSnap, f.side, f.n);
      if (!x.length && bt.x.length) x = bt.x;
      data = bt.navArr;
    }
    series.push({ name: `${factorParamName(f.code, f.side, f.scoreMode, f.constraintMode)} top${f.n}`, type: "line", symbol: "none",
             data,
             color: STRAT_COLORS[i % STRAT_COLORS.length],
             lineStyle: { width: 2 } });
  }

  const bm = await ensureBenchmarkSnapshot();
  const colors = { HS300: "#c14545", CSI800: "#6e9a4f", CSI500: "#c89c2b" };
  const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
  for (const idx of ["HS300", "CSI800", "CSI500"]) {
    const rebased = rebaseNav(benchmarkSeries(bm, x.map(monthOfLabel), idx));
    if (!rebased.some(v => v !== null)) continue;
    series.push({ name: `${cn[idx]}(基准)`, type: "line", symbol: "none", connectNulls: true,
      data: rebased, color: colors[idx], lineStyle: { width: 1.2, type: "dashed" } });
  }
  cmpNavChart = echarts.init(div);
  cmpNavChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" }, legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 32 },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true }, series,
  });
}

async function renderCmpIc() {
  const div = document.getElementById("cmp-ic-chart");
  if (cmpIcChart) { cmpIcChart.dispose(); cmpIcChart = null; }
  div.innerHTML = "";
  if (state.compareFactors.length === 0) { div.innerHTML = `<div class="empty">选因子后显示</div>`; return; }

  // IC 与持仓数无关，但方向会改变符号 → 按因子+方向去重
  const uniqItems = [];
  const seen = new Set();
  for (const f of state.compareFactors) {
    const item = { code: f.code, side: normalizeSide(f.side), scoreMode: normalizeScoreMode(f.scoreMode) };
    const key = `${item.code}|${item.side}|${item.scoreMode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqItems.push(item);
  }
  const uniqCodes = [...new Set(uniqItems.map(item => item.code))];
  const inList = uniqCodes.map(c => `'${c}'`).join(",");
  // 12 月滚动 IC 均值，平滑噪声，更易对比
  const res = await state.db.query(`
    SELECT factor_code, strftime(month,'%Y-%m') AS dt,
           AVG(ic) OVER (PARTITION BY factor_code ORDER BY month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS ic12
    FROM factor_ic WHERE factor_code IN (${inList}) AND NOT ISNAN(ic)
      ${icRangeWhere(state.compareStart, state.compareEnd)}
    ORDER BY factor_code, month
  `);
  const byF = {};
  for (const r of res.toArray()) { (byF[r.factor_code] ||= { dt: [], ic: [] }); byF[r.factor_code].dt.push(r.dt); byF[r.factor_code].ic.push(r.ic12); }
  const x = (byF[uniqCodes[0]] || { dt: [] }).dt;
  const series = uniqItems.map((item, i) => {
    const s = byF[item.code]; if (!s) return null;
    return { name: factorSideName(item.code, item.side), type: "line", symbol: "none", data: s.ic.map(v => v == null ? null : Number(v) * item.side),
             color: STRAT_COLORS[i % STRAT_COLORS.length],
             lineStyle: { width: 1.6 } };
  }).filter(Boolean);

  cmpIcChart = echarts.init(div);
  cmpIcChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" }, legend: { top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", name: "12月滚动IC" },
    series,
    visualMap: undefined,
    markLine: undefined,
  });
}

async function renderCmpIcFast() {
  const div = document.getElementById("cmp-ic-chart");
  if (cmpIcChart) { cmpIcChart.dispose(); cmpIcChart = null; }
  div.innerHTML = "";
  if (state.compareFactors.length === 0) { div.innerHTML = `<div class="empty">选因子后显示</div>`; return; }

  const uniqItems = [];
  const seen = new Set();
  for (const f of state.compareFactors) {
    const item = { code: f.code, side: normalizeSide(f.side) };
    const key = `${item.code}|${item.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqItems.push(item);
  }
  const snaps = await Promise.all(uniqItems.map(item => loadSingleSnapshot(item.code)));
  const firstScoreSnap = activeScoreSnapshotFor(snaps[0], uniqItems[0]?.scoreMode);
  const icMonths = firstScoreSnap?.ic?.months || [];
  const idxs = rangeFilterIndexes(icMonths, state.compareStart, state.compareEnd);
  const x = idxs.map(i => icMonths[i]);
  const series = snaps.map((snap, i) => {
    const item = uniqItems[i];
    const scoreSnap = activeScoreSnapshotFor(snap, item.scoreMode);
    const vals = scoreSnap.ic?.ic || [];
    const rolling = vals.map((_, idx) => {
      const win = vals.slice(Math.max(0, idx - 11), idx + 1)
        .filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
      return win.length ? +(win.reduce((s, v) => s + v, 0) / win.length * item.side).toFixed(6) : null;
    });
    return { name: factorParamName(item.code, item.side, item.scoreMode), type: "line", symbol: "none", data: idxs.map(idx => rolling[idx]),
             color: STRAT_COLORS[i % STRAT_COLORS.length],
             lineStyle: { width: 1.6 } };
  });

  cmpIcChart = echarts.init(div);
  cmpIcChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" }, legend: { top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", name: "12月滚动IC" },
    series,
  });
}

async function renderCmpCorr() {
  const div = document.getElementById("cmp-corr-chart");
  if (cmpCorrChart) { cmpCorrChart.dispose(); cmpCorrChart = null; }
  div.innerHTML = "";
  if (!state.hasCorr) { div.innerHTML = `<div class="empty">相关性数据未生成（需跑 scripts/08_factor_corr.py）</div>`; return; }
  // 选中因子去重（同因子可重复加入不同 N，但相关性与 N 无关）；<2 个时显示全部
  const uniq = [...new Set(state.compareFactors.map(f => f.code))];
  const isAll = uniq.length < 2;
  // 全量模式：按一级/二级分类排序，让同类因子在热力图上聚成块，红/蓝色块一眼可辨
  let codes;
  if (isAll) {
    codes = [...state.catalog]
      .sort((a, b) => (a.l1 + a.l2).localeCompare(b.l1 + b.l2) || a.code.localeCompare(b.code))
      .map(f => f.code);
  } else {
    codes = uniq;
  }
  const inList = codes.map(c => `'${c}'`).join(",");
  const res = await state.db.query(`
    SELECT factor_a, factor_b, corr, n_obs, n_months FROM factor_corr
    WHERE factor_a IN (${inList}) AND factor_b IN (${inList})
  `);
  const cmap = {};
  for (const r of res.toArray()) {
    cmap[`${r.factor_a}|${r.factor_b}`] = {
      corr: r.corr,
      nObs: r.n_obs,
      nMonths: r.n_months,
    };
  }
  const data = [];
  codes.forEach((a, i) => codes.forEach((b, j) => {
    const item = cmap[`${a}|${b}`] || {};
    const c = item.corr;
    data.push([
      j,
      i,
      c === null || c === undefined ? "-" : +c.toFixed(2),
      item.nObs ?? null,
      item.nMonths ?? null,
    ]);
  }));

  const n = codes.length;
  // 自适应尺寸：每格约 18px，让格子接近正方形、字够清。
  // 全量 46 → ~830px 见方，超出面板宽度时由外层容器横向滚动（见下方 overflow）。
  // 自适应方形尺寸：宽=高。少量因子时按面板可用宽放大格子（封顶 110px，避免过大），
  // 因子多时格子缩小、超 16 个横向滚动。既不被横向拉伸，也不会缩成一点点。
  div.style.width = "";
  const panelW = (div.parentElement && div.parentElement.clientWidth) || 560;
  const target = Math.min(560, Math.max(300, panelW - 8));     // 目标边长
  const cell = n > 20 ? 17 : Math.min(110, Math.max(30, Math.floor((target - 110) / n)));
  const plotH = n * cell + 110;          // 上下留刻度 + 图例
  const plotW = n * cell + 110;          // 左右留 y 轴标签
  div.style.height = plotH + "px";
  div.style.width = plotW + "px";
  div.style.minWidth = "0";
  div.parentElement.style.overflowX = (n > 16 ? "auto" : "visible");
  // 格子里的数字：因子多了必糊，>16 个时关掉，靠颜色 + 悬停 tooltip；少量因子才标数值
  const showLabel = n <= 16;
  const labelFont = n <= 10 ? 11 : 9;
  const axisFont = n > 30 ? 9 : (n > 16 ? 10 : 11);

  cmpCorrChart = echarts.init(div);
  cmpCorrChart.setOption({
    grid: { left: 90, right: 20, top: 16, bottom: 70 },
    tooltip: {
      position: "top",
      formatter: p => `${codes[p.data[1]]} × ${codes[p.data[0]]}<br/>corr: ${p.data[2]}<br/>样本股票-月：${p.data[3] ?? "—"}<br/>样本月份：${p.data[4] ?? "—"}`,
    },
    xAxis: { type: "category", data: codes, axisLabel: { fontSize: axisFont, rotate: 90, interval: 0 } },
    yAxis: { type: "category", data: codes, axisLabel: { fontSize: axisFont, interval: 0 } },
    visualMap: { min: -1, max: 1, calculable: true, orient: "horizontal", left: "center", bottom: 0,
                 inRange: { color: ["#c14545", "#ffffff", "#1a4d80"] }, textStyle: { fontSize: 10 } },
    series: [{ type: "heatmap", data,
               label: { show: showLabel, fontSize: labelFont, formatter: p => p.data[2] },
               itemStyle: { borderColor: "#fff", borderWidth: n > 20 ? 0.5 : 1 },
               emphasis: { itemStyle: { shadowBlur: 6, borderColor: "#333", borderWidth: 1 } } }],
  });
}

async function renderCmpCorrFast() {
  const div = document.getElementById("cmp-corr-chart");
  if (cmpCorrChart) { cmpCorrChart.dispose(); cmpCorrChart = null; }
  div.innerHTML = "";
  const rawCorrSnap = await ensureCorrSnapshotFor("raw");
  const neutralCorrSnap = await ensureCorrSnapshotFor("neutral");
  if (!rawCorrSnap.rows || !rawCorrSnap.rows.length) {
    div.innerHTML = `<div class="empty">相关性数据未生成（需跑 scripts/08_factor_corr.py）</div>`;
    return;
  }
  const selectedItems = [];
  const seen = new Set();
  for (const f of state.compareFactors) {
    const item = { code: f.code, side: normalizeSide(f.side), scoreMode: normalizeScoreMode(f.scoreMode) };
    const key = `${item.code}|${item.side}|${item.scoreMode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectedItems.push(item);
  }
  const isAll = selectedItems.length < 2;
  let items;
  if (isAll) {
    items = [...state.catalog]
      .sort((a, b) => (a.l1 + a.l2).localeCompare(b.l1 + b.l2) || a.code.localeCompare(b.code))
      .map(f => ({ code: f.code, side: 1, scoreMode: "raw" }));
  } else {
    items = selectedItems;
  }
  const codes = items.map(item => item.code);
  const labels = items.map(item => factorParamName(item.code, item.side, item.scoreMode));
  const want = new Set(codes);
  const cmapByMode = { raw: {}, neutral: {} };
  for (const [a, b, c, nObs, nMonths] of rawCorrSnap.rows || []) {
    if (want.has(a) && want.has(b)) cmapByMode.raw[`${a}|${b}`] = { corr: c, nObs, nMonths };
  }
  for (const [a, b, c, nObs, nMonths] of neutralCorrSnap.rows || []) {
    if (want.has(a) && want.has(b)) cmapByMode.neutral[`${a}|${b}`] = { corr: c, nObs, nMonths };
  }
  const data = [];
  items.forEach((a, i) => items.forEach((b, j) => {
    const mode = normalizeScoreMode(a.scoreMode) === "neutral" && normalizeScoreMode(b.scoreMode) === "neutral"
      ? "neutral"
      : "raw";
    const item = cmapByMode[mode][`${a.code}|${b.code}`] || {};
    const c = item.corr;
    data.push([
      j,
      i,
      c === null || c === undefined ? "-" : +(Number(c) * a.side * b.side).toFixed(2),
      item.nObs ?? null,
      item.nMonths ?? null,
    ]);
  }));

  const n = items.length;
  div.style.width = "";
  const panelW = (div.parentElement && div.parentElement.clientWidth) || 560;
  const target = Math.min(560, Math.max(300, panelW - 8));
  const cell = n > 20 ? 17 : Math.min(110, Math.max(30, Math.floor((target - 110) / n)));
  const plotH = n * cell + 110;
  const plotW = n * cell + 110;
  div.style.height = plotH + "px";
  div.style.width = plotW + "px";
  div.style.minWidth = "0";
  div.parentElement.style.overflowX = (n > 16 ? "auto" : "visible");
  const showLabel = n <= 16;
  const labelFont = n <= 10 ? 11 : 9;
  const axisFont = n > 30 ? 9 : (n > 16 ? 10 : 11);

  cmpCorrChart = echarts.init(div);
  cmpCorrChart.setOption({
    grid: { left: 90, right: 20, top: 16, bottom: 70 },
    tooltip: {
      position: "top",
      formatter: p => `${labels[p.data[1]]} × ${labels[p.data[0]]}<br/>corr: ${p.data[2]}<br/>样本股票-月：${p.data[3] ?? "—"}<br/>样本月份：${p.data[4] ?? "—"}`,
    },
    xAxis: { type: "category", data: labels, axisLabel: { fontSize: axisFont, rotate: 90, interval: 0 } },
    yAxis: { type: "category", data: labels, axisLabel: { fontSize: axisFont, interval: 0 } },
    visualMap: { min: -1, max: 1, calculable: true, orient: "horizontal", left: "center", bottom: 0,
                 inRange: { color: ["#c14545", "#ffffff", "#1a4d80"] }, textStyle: { fontSize: 10 } },
    series: [{ type: "heatmap", data,
               label: { show: showLabel, fontSize: labelFont, formatter: p => p.data[2] },
               itemStyle: { borderColor: "#fff", borderWidth: n > 20 ? 0.5 : 1 },
               emphasis: { itemStyle: { shadowBlur: 6, borderColor: "#333", borderWidth: 1 } } }],
  });
}

function bindModeButtons() {
  document.querySelectorAll(".mode-btn").forEach(b => {
    b.onclick = () => switchMode(b.dataset.mode);
  });
  const comboBtn = document.getElementById("combo-manager-btn");
  if (comboBtn) comboBtn.onclick = () => switchMode("library");
  const adminBtn = document.getElementById("admin-manager-btn");
  if (adminBtn) adminBtn.onclick = () => switchMode("admin");
}

function bindCmpDefaultButtons() {
  // 默认持仓数（仅影响之后新加入的因子）
  document.querySelectorAll(".cmpdef-btn[data-n]").forEach(b => {
    b.onclick = () => {
      state.compareDefaultN = parseInt(b.dataset.n, 10);
      document.querySelectorAll(".cmpdef-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
    };
  });
}

let _cmpRangeBound = false;
let _cmpMonths = null;
async function initCompareRangeControls() {
  let months = [];
  if (state.compareFactors[0]) {
    months = monthsFromSnapshot(await loadSingleSnapshot(state.compareFactors[0].code));
  }
  if (!months.length) {
    months = state.rankingSnapshot?.months || state.benchmarkSnapshot?.months || [];
  }
  if (!months.length) {
    const bm = await ensureBenchmarkSnapshot();
    months = bm?.months || [];
  }
  if (_cmpRangeBound && JSON.stringify(_cmpMonths) === JSON.stringify(months)) return;
  setupCompareRangeControls(months);
}

function setupCompareRangeControls(months) {
  const startSel = document.getElementById("cmp-start");
  const endSel = document.getElementById("cmp-end");
  if (!startSel || !endSel || !months.length) return;
  startSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  endSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  startSel.value = months[0];
  endSel.value = months[months.length - 1];
  state.compareStart = null;
  state.compareEnd = null;
  updateCompareRangeInfo(months[0], months[months.length - 1]);
  document.querySelectorAll(".cmprange-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll(".cmprange-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      const [s, e] = rangeToBounds(b.dataset.range, months);
      startSel.value = s; endSel.value = e;
      state.compareStart = (b.dataset.range === "all") ? null : s;
      state.compareEnd = (b.dataset.range === "all") ? null : e;
      updateCompareRangeInfo(s, e);
      if (state.compareFactors.length) renderCompare();
    };
  });
  const onCustom = () => {
    document.querySelectorAll(".cmprange-btn").forEach(x => x.classList.remove("active"));
    let s = startSel.value, e = endSel.value;
    if (s > e) { e = s; endSel.value = s; }
    state.compareStart = s; state.compareEnd = e;
    updateCompareRangeInfo(s, e);
    if (state.compareFactors.length) renderCompare();
  };
  startSel.onchange = onCustom;
  endSel.onchange = onCustom;
  _cmpMonths = months.slice();
  _cmpRangeBound = true;
}

function updateCompareRangeInfo(s, e) {
  const el = document.getElementById("cmp-range-info");
  if (el) el.textContent = `${s} ~ ${e}`;
}

let _cpsRangeBound = false;
let _cpsMonths = null;
async function initComposeRangeControls() {
  let months = state.rankingSnapshot?.months || state.benchmarkSnapshot?.months || [];
  if (!months.length) {
    const bm = await ensureBenchmarkSnapshot();
    months = bm?.months || [];
  }
  if (_cpsRangeBound && JSON.stringify(_cpsMonths) === JSON.stringify(months)) return;
  setupComposeRangeControls(months);
}

function setupComposeRangeControls(months) {
  const startSel = document.getElementById("cps-start");
  const endSel = document.getElementById("cps-end");
  if (!startSel || !endSel || !months.length) return;
  startSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  endSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  startSel.value = months[0];
  endSel.value = months[months.length - 1];
  state.composeStart = null;
  state.composeEnd = null;
  updateComposeRangeInfo(months[0], months[months.length - 1]);
  document.querySelectorAll(".cpsrange-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll(".cpsrange-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      const [s, e] = rangeToBounds(b.dataset.range, months);
      startSel.value = s; endSel.value = e;
      state.composeStart = (b.dataset.range === "all") ? null : s;
      state.composeEnd = (b.dataset.range === "all") ? null : e;
      updateComposeRangeInfo(s, e);
      clearComposeOptimization();
      if (state.composeFactors.length) renderComposeSoon(0);
      if (state.savedCombos.length) renderComboCompare();
    };
  });
  const onCustom = () => {
    document.querySelectorAll(".cpsrange-btn").forEach(x => x.classList.remove("active"));
    let s = startSel.value, e = endSel.value;
    if (s > e) { e = s; endSel.value = s; }
    state.composeStart = s; state.composeEnd = e;
    updateComposeRangeInfo(s, e);
    clearComposeOptimization();
    if (state.composeFactors.length) renderComposeSoon(0);
    if (state.savedCombos.length) renderComboCompare();
  };
  startSel.onchange = onCustom;
  endSel.onchange = onCustom;
  _cpsMonths = months.slice();
  _cpsRangeBound = true;
}

function updateComposeRangeInfo(s, e) {
  const el = document.getElementById("cps-range-info");
  if (el) el.textContent = `${s} ~ ${e}`;
}

function composeRangeLabel() {
  return (state.composeStart || state.composeEnd)
    ? `${state.composeStart || "起"}~${state.composeEnd || "今"}`
    : "全样本";
}

function clearComposeOptimization() {
  const box = document.getElementById("cps-opt");
  if (box) box.innerHTML = "";
}

// ===================== 因子排行榜 =====================

// 排行榜列定义：key 用于排序，label 表头，fmt 格式化，good=+1 表示越大越好（综合分方向用）
const RANK_COLS = [
  { key: "rank",      label: "#",       lcol: true,  fmt: v => v, help: "当前排序条件下的名次。" },
  { key: "code",      label: "因子",    lcol: true,  fmt: v => v, help: "因子代码，点击因子行可进入单因子检验。" },
  { key: "name_cn",   label: "名称",    lcol: true,  fmt: v => v, help: "因子中文名称。" },
  { key: "score",     label: "综合分",  fmt: v => v.toFixed(2), cls: "score-cell", help: "综合分综合收益、风险、IC与稳定性，适合做第一轮排序，不代表单独买入结论。" },
  { key: "annual",    label: "年化收益", fmt: v => (v * 100).toFixed(1) + "%", help: "Top30组合年化收益，反映绝对收益能力。" },
  { key: "vol",       label: "年化波动率", fmt: v => (v * 100).toFixed(1) + "%", help: "Top30组合收益波动率，越低说明组合收益起伏越小。" },
  { key: "sharpe",    label: "夏普",    fmt: v => v.toFixed(2), help: "Top30组合风险调整后收益，越高越好。" },
  { key: "mdd",       label: "最大回撤", fmt: v => (v * 100).toFixed(1) + "%", help: "Top30组合最大回撤，越接近0回撤越小。" },
  { key: "winRate",   label: "月胜率",  fmt: v => (v * 100).toFixed(0) + "%", help: "Top30组合正收益月份占比，反映收益持续性。" },
  { key: "rankIC",    label: "RankIC均值", fmt: v => v.toFixed(3), help: "因子排序与未来收益排序的一致性，绝对值越大排序信息越强。" },
  { key: "rankIC3M",  label: "IC3M", fmt: v => numText(v, 3), help: "3个月前瞻期RankIC，用于观察中短期信号是否延续。" },
  { key: "rankIC6M",  label: "IC6M", fmt: v => numText(v, 3), help: "6个月前瞻期RankIC，用于观察信号衰减和持有期适配。" },
  { key: "rankIC12M", label: "IC12M", fmt: v => numText(v, 3), help: "12个月前瞻期RankIC，用于观察信号是否具有更长期解释力。" },
  { key: "icir",      label: "IC_IR",   fmt: v => v.toFixed(2), help: "RankIC均值除以波动后的稳定性指标，越高越稳定。" },
  { key: "rankIcHacT", label: "HAC t值", fmt: v => signedNumText(v, 2), help: "RankIC均值的 Newey-West 修正 t 值，用于降低自相关对显著性的影响。" },
  { key: "rankIcP", label: "p值", fmt: v => numText(v, 3), help: "RankIC均值 HAC t 检验对应的原始双侧 p 值，未做多重检验调整。" },
  { key: "rankIcQ", label: "FDR q值", fmt: v => numText(v, 3), help: "RankIC显著性的多重检验调整结果，用于降低多因子筛选中的偶然显著风险。" },
  { key: "rankIcWinRate", label: "IC胜率", fmt: v => pctText(v), help: "RankIC为正的月份占比，反映排序方向持续性。" },
  { key: "top30ExcessAnnual", label: "超额年化", fmt: v => signedPctText(v), help: "Top30月收益减基准月收益后的年化收益，反映相对基准的增量收益。" },
  { key: "top30ExcessMdd", label: "超额回撤", fmt: v => pctText(v), help: "Top30超额收益曲线最大回撤，越接近0相对回撤压力越小。" },
  { key: "group10Mono", label: "10组单调性", fmt: v => numText(v, 2), help: "10组收益排序单调性，越高说明分组排序越清晰。" },
  { key: "top30Turnover", label: "月均换手", fmt: v => pctText(v), help: "Top30持仓月均换手，越高交易成本压力越大。" },
  { key: "medCap",    label: "中位市值(亿)", fmt: v => v === null ? "—" : Math.round(v).toLocaleString(), help: "最新Top30持仓的中位市值，用于判断因子偏大盘或小盘。" },
  { key: "capStyle",  label: "市值风格", lcol: true, fmt: v => v, help: "按最新Top30持仓市值分布归纳的风格标签。" },
  { key: "tags",      label: "标签", lcol: true, sortable: false,
    fmt: (_, r) => `<span class="ftag ftag-${r.env_tag}">${r.env_tag}</span> <span class="ftag ftag-${r.time_tag}">${r.time_tag}</span>`,
    help: "按市场环境和近12个月RankIC变化自动生成的辅助标签。" },
  { key: "top3ind",   label: "前三行业(最新选股)", lcol: true, fmt: v => v, help: "最新Top30持仓中权重靠前的三个行业，用于观察行业集中度。" },
];

let _rankState = { rows: null, sortKey: "score", desc: true, checked: new Set(),
                   range: "all", start: null, end: null, tagFilters: new Set(),
                   side: 1, scoreMode: "raw", constraintMode: "none" };
let _rankRenderSeq = 0;

const ENV_TAGS = ["牛市进攻型", "熊市防御型", "全天候型", "震荡占优型"];
const TIME_TAGS = ["长期稳定型", "近期转强", "近期转弱", "近期失效", "持续低效"];

// 构建标签筛选 chip（点击切换；多选为「与」关系）。绑定一次。
let _tagFilterBound = false;
function buildTagFilters() {
  if (_tagFilterBound) return;
  const box = document.getElementById("rank-tag-filters");
  box.innerHTML = [...ENV_TAGS, ...TIME_TAGS]
    .map(t => `<span class="ftag ftag-${t} tagfilter" data-tag="${t}">${t}</span>`).join(" ");
  box.querySelectorAll(".tagfilter").forEach(el => {
    el.onclick = () => {
      const t = el.dataset.tag;
      if (_rankState.tagFilters.has(t)) _rankState.tagFilters.delete(t);
      else _rankState.tagFilters.add(t);
      el.classList.toggle("on", _rankState.tagFilters.has(t));
      document.getElementById("rank-tag-clear").style.display =
        _rankState.tagFilters.size ? "inline" : "none";
      drawRankTable();
    };
  });
  document.getElementById("rank-tag-clear").onclick = () => {
    _rankState.tagFilters.clear();
    document.querySelectorAll("#rank-tag-filters .tagfilter").forEach(e => e.classList.remove("on"));
    document.getElementById("rank-tag-clear").style.display = "none";
    drawRankTable();
  };
  _tagFilterBound = true;
}

let _rankParamBound = false;
let _rankParamTimer = null;
function updateRankParamInfo() {
  const el = document.getElementById("rank-param-info");
  if (!el) return;
  el.textContent = `${sideLabel(_rankState.side)} / ${scoreModeLabel(_rankState.scoreMode)} / ${constraintModeLabel(_rankState.constraintMode)} / top30`;
}

function bindRankParamControls() {
  if (_rankParamBound) return;
  const sideSel = document.getElementById("rank-param-side");
  const scoreSel = document.getElementById("rank-param-score");
  const constraintSel = document.getElementById("rank-param-constraint");
  if (!sideSel || !scoreSel || !constraintSel) return;
  sideSel.value = String(normalizeSide(_rankState.side));
  scoreSel.value = normalizeScoreMode(_rankState.scoreMode);
  constraintSel.value = normalizeConstraintMode(_rankState.constraintMode);
  const onParamChange = async () => {
    _rankState.side = normalizeSide(sideSel.value);
    _rankState.scoreMode = normalizeScoreMode(scoreSel.value);
    _rankState.constraintMode = normalizeConstraintMode(constraintSel.value);
    updateRankParamInfo();
    if (_rankParamTimer) clearTimeout(_rankParamTimer);
    _rankParamTimer = setTimeout(() => {
      _rankParamTimer = null;
      recomputeRank(true).catch(err => console.error("ranking param recompute failed:", err));
    }, 80);
  };
  sideSel.onchange = onParamChange;
  scoreSel.onchange = onParamChange;
  constraintSel.onchange = onParamChange;
  updateRankParamInfo();
  _rankParamBound = true;
}

let _rankBarBound = false;
async function renderRanking() {
  const box = document.getElementById("rank-table");
  try {
    if (!_rankBarBound) {
      document.getElementById("rank-to-single").onclick = () => rankSendTo("single");
      document.getElementById("rank-to-compare").onclick = () => rankSendTo("compare");
      document.getElementById("rank-to-compose").onclick = () => rankSendTo("compose");
      document.getElementById("rank-clear-sel").onclick = () => { _rankState.checked.clear(); drawRankTable(); };
      buildTagFilters();
      bindRankParamControls();
      await initRankRangeControlsFast();
      _rankBarBound = true;
    }
    if (!_rankState.rows) {
      box.innerHTML = `<div class="empty">计算中…</div>`;
      _rankState.rows = await computeRankingFast(_rankState.start, _rankState.end);
    }
    drawRankTable();
  } catch (err) {
    console.warn("fast renderRanking failed, falling back to DuckDB:", err);
    try {
      await ensureDB();
      await ensureAllFactorData();
      if (!_rankBarBound) {
        document.getElementById("rank-to-single").onclick = () => rankSendTo("single");
        document.getElementById("rank-to-compare").onclick = () => rankSendTo("compare");
        document.getElementById("rank-to-compose").onclick = () => rankSendTo("compose");
        document.getElementById("rank-clear-sel").onclick = () => { _rankState.checked.clear(); drawRankTable(); };
        buildTagFilters();
        bindRankParamControls();
        await initRankRangeControls();
        _rankBarBound = true;
      }
      if (!_rankState.rows) {
        box.innerHTML = `<div class="empty">计算中…</div>`;
        _rankState.rows = await computeRanking(_rankState.start, _rankState.end);
      }
      drawRankTable();
    } catch (fallbackErr) {
      console.error("renderRanking failed:", fallbackErr);
      box.innerHTML = `<pre style="color:#c00;white-space:pre-wrap;font-size:11px">排行榜失败：${htmlText(fallbackErr.message || fallbackErr)}</pre>`;
    }
  }
}

// 所有可选月份（YYYY-MM），升序。用于自定义起止下拉 + 区间预设换算。
let _rankMonths = null;
async function rankMonths() {
  if (_rankMonths) return _rankMonths;
  if (state.rankingSnapshot?.months) {
    _rankMonths = state.rankingSnapshot.months;
    return _rankMonths;
  }
  const res = await state.db.query(
    `SELECT DISTINCT strftime(COALESCE(return_date, trade_date),'%Y-%m') m FROM preset_backtest ORDER BY m`);
  _rankMonths = res.toArray().map(r => r.m);
  return _rankMonths;
}

// 把预设区间换算成 [startMonth, endMonth]（含端点，YYYY-MM）
function rangeToBounds(range, months) {
  const last = months[months.length - 1];
  if (range === "all") return [months[0], last];
  if (range === "1y") return [months[Math.max(0, months.length - 12)], last];
  if (range === "3y") return [months[Math.max(0, months.length - 36)], last];
  if (range === "5y") return [months[Math.max(0, months.length - 60)], last];
  if (/^\d{4}$/.test(range)) {
    const ys = months.filter(m => m.startsWith(`${range}-`));
    return ys.length ? [ys[0], ys[ys.length - 1]] : [months[0], last];
  }
  return [months[0], last];
}

// 生成回测区间的 SQL WHERE 片段（作用于 trade_date 列）。两端含端点；null 不限。
function rangeWhere(startMonth, endMonth, col = "trade_date") {
  const parts = [];
  if (startMonth) parts.push(`strftime(${col},'%Y-%m') >= '${startMonth}'`);
  if (endMonth) parts.push(`strftime(${col},'%Y-%m') <= '${endMonth}'`);
  return parts.length ? " AND " + parts.join(" AND ") : "";
}

function backtestRangeWhere(startMonth, endMonth) {
  return rangeWhere(startMonth, endMonth, "COALESCE(return_date, trade_date)");
}

function icRangeWhere(startMonth, endMonth) {
  return rangeWhere(startMonth, endMonth, "COALESCE(return_month, month)");
}

// 单因子回测区间选择器（与排行榜同款逻辑，作用于 state.singleStart/End）
let _sgBound = false;
let _sgMonths = null;
let _singleRangeFast = false;
async function initSingleRangeControls() {
  if (_sgBound) return;
  const months = await rankMonths();
  setupSingleRangeControls(months, false);
}

async function initSingleRangeControlsFast(snap) {
  const months = monthsFromSnapshot(snap);
  if (!months.length) return initSingleRangeControls();
  if (_sgBound && _singleRangeFast && JSON.stringify(_sgMonths) === JSON.stringify(months)) return;
  setupSingleRangeControls(months, true);
}

function setupSingleRangeControls(months, fastMode) {
  const startSel = document.getElementById("sg-start");
  const endSel = document.getElementById("sg-end");
  startSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  endSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  startSel.value = months[0];
  endSel.value = months[months.length - 1];
  state.singleStart = null;   // 'all' 用 null 表示不限，避免无谓过滤
  state.singleEnd = null;
  document.querySelectorAll(".sgrange-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll(".sgrange-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      const [s, e] = rangeToBounds(b.dataset.range, months);
      startSel.value = s; endSel.value = e;
      state.singleStart = (b.dataset.range === "all") ? null : s;
      state.singleEnd = (b.dataset.range === "all") ? null : e;
      updateSingleRangeInfo(s, e);
      if (state.activeFactor) selectFactor(state.activeFactor);
    };
  });
  const onCustom = () => {
    document.querySelectorAll(".sgrange-btn").forEach(x => x.classList.remove("active"));
    let s = startSel.value, e = endSel.value;
    if (s > e) { e = s; endSel.value = s; }
    state.singleStart = s; state.singleEnd = e;
    updateSingleRangeInfo(s, e);
    if (state.activeFactor) selectFactor(state.activeFactor);
  };
  startSel.onchange = onCustom;
  endSel.onchange = onCustom;
  _sgMonths = months.slice();
  _singleRangeFast = fastMode;
  _sgBound = true;
}

function updateSingleRangeInfo(s, e) {
  const el = document.getElementById("sg-range-info");
  if (el) el.textContent = `${s} ~ ${e}`;
}

async function initRankRangeControls() {
  const months = await rankMonths();
  // 填充自定义起止下拉
  const startSel = document.getElementById("rk-start");
  const endSel = document.getElementById("rk-end");
  startSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  endSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  startSel.value = months[0];
  endSel.value = months[months.length - 1];
  _rankState.start = months[0];
  _rankState.end = months[months.length - 1];
  // 预设区间按钮
  document.querySelectorAll(".rkrange-btn").forEach(b => {
    b.onclick = async () => {
      document.querySelectorAll(".rkrange-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      _rankState.range = b.dataset.range;
      const [s, e] = rangeToBounds(b.dataset.range, months);
      _rankState.start = s; _rankState.end = e;
      startSel.value = s; endSel.value = e;
      await recomputeRank();
    };
  });
  // 自定义下拉
  const onCustom = async () => {
    document.querySelectorAll(".rkrange-btn").forEach(x => x.classList.remove("active"));
    _rankState.range = "custom";
    let s = startSel.value, e = endSel.value;
    if (s > e) { e = s; endSel.value = s; }   // 防起点晚于终点
    _rankState.start = s; _rankState.end = e;
    await recomputeRank();
  };
  startSel.onchange = onCustom;
  endSel.onchange = onCustom;
}

async function initRankRangeControlsFast() {
  const snap = await ensureRankingSnapshot();
  _rankMonths = snap.months || [];
  return setupRankRangeControls(_rankMonths, true);
}

function setupRankRangeControls(months, fastMode) {
  const startSel = document.getElementById("rk-start");
  const endSel = document.getElementById("rk-end");
  startSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  endSel.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join("");
  startSel.value = months[0];
  endSel.value = months[months.length - 1];
  _rankState.start = months[0];
  _rankState.end = months[months.length - 1];
  document.querySelectorAll(".rkrange-btn").forEach(b => {
    b.onclick = async () => {
      document.querySelectorAll(".rkrange-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      _rankState.range = b.dataset.range;
      const [s, e] = rangeToBounds(b.dataset.range, months);
      _rankState.start = s; _rankState.end = e;
      startSel.value = s; endSel.value = e;
      await recomputeRank(fastMode);
    };
  });
  const onCustom = async () => {
    document.querySelectorAll(".rkrange-btn").forEach(x => x.classList.remove("active"));
    _rankState.range = "custom";
    let s = startSel.value, e = endSel.value;
    if (s > e) { e = s; endSel.value = s; }
    _rankState.start = s; _rankState.end = e;
    await recomputeRank(fastMode);
  };
  startSel.onchange = onCustom;
  endSel.onchange = onCustom;
}

async function recomputeRank(fastMode = !!state.rankingSnapshot) {
  const seq = ++_rankRenderSeq;
  const box = document.getElementById("rank-table");
  updateRankParamInfo();
  if (!_rankState.rows) box.innerHTML = `<div class="empty">按区间重新计算中…</div>`;
  const rows = fastMode
    ? await computeRankingFast(_rankState.start, _rankState.end)
    : await computeRanking(_rankState.start, _rankState.end);
  if (seq !== _rankRenderSeq) return;
  _rankState.rows = rows;
  drawRankTable();
}

// 每因子 top-30 选股的前三大申万一级行业（最新截面）。与排行榜时间区间无关，缓存只查一次。
// 返回 Map: factor_code → "行业A 12、行业B 7、行业C 5"
let _top3IndCache = null;
async function factorTop3Industries() {
  if (_top3IndCache) return _top3IndCache;
  const res = await state.db.query(`
    WITH dedup AS (
      SELECT s.factor_code, s.stock_code, s.score,
             ROW_NUMBER() OVER (PARTITION BY s.factor_code, s.stock_code ORDER BY s.trade_date DESC) AS srn
      FROM factor_score s
      JOIN stock_meta m USING(stock_code)
      WHERE s.score IS NOT NULL
        AND COALESCE(m.is_st,FALSE)=FALSE AND COALESCE(m.is_active_latest,FALSE)=TRUE
    ),
    ranked AS (
      SELECT e.factor_code, COALESCE(d.industry_sw1,'未分类') AS ind,
             ROW_NUMBER() OVER (PARTITION BY e.factor_code ORDER BY e.score DESC) AS rk
      FROM dedup e
      LEFT JOIN stock_descriptors d USING(stock_code)
      WHERE e.srn = 1
    ),
    top30 AS (SELECT factor_code, ind FROM ranked WHERE rk <= 30),
    cnt AS (SELECT factor_code, ind, COUNT(*) c FROM top30 GROUP BY factor_code, ind),
    r2 AS (SELECT factor_code, ind, c,
                  ROW_NUMBER() OVER (PARTITION BY factor_code ORDER BY c DESC, ind) rk FROM cnt)
    SELECT factor_code, string_agg(ind || ' ' || c, '、' ORDER BY rk) AS top3
    FROM r2 WHERE rk <= 3 GROUP BY factor_code
  `);
  _top3IndCache = new Map(res.toArray().map(r => [r.factor_code, r.top3]));
  return _top3IndCache;
}

// 每因子 top-30 选股的市值特征（最新截面）：中位市值（亿）+ 主导分档。缓存只查一次。
// 返回 Map: factor_code → { medCap:亿, style:"大盘"/... }
let _mktCapCache = null;
async function factorMarketCap() {
  if (_mktCapCache) return _mktCapCache;
  // 取每因子 top-30 的市值（万元），JS 端算中位 + 分档（market_cap 单位万元 → 亿元）
  const res = await state.db.query(`
    WITH dedup AS (
      SELECT s.factor_code, s.stock_code, s.score,
             ROW_NUMBER() OVER (PARTITION BY s.factor_code, s.stock_code ORDER BY s.trade_date DESC) AS srn
      FROM factor_score s
      JOIN stock_meta m USING(stock_code)
      WHERE s.score IS NOT NULL
        AND COALESCE(m.is_st,FALSE)=FALSE AND COALESCE(m.is_active_latest,FALSE)=TRUE
    ),
    ranked AS (
      SELECT e.factor_code, d.market_cap AS mc,
             ROW_NUMBER() OVER (PARTITION BY e.factor_code ORDER BY e.score DESC) AS rk
      FROM dedup e
      LEFT JOIN stock_descriptors d USING(stock_code)
      WHERE e.srn = 1
    )
    SELECT factor_code, mc FROM ranked WHERE rk <= 30 AND mc IS NOT NULL
  `);
  const byF = new Map();
  for (const r of res.toArray()) {
    if (!byF.has(r.factor_code)) byF.set(r.factor_code, []);
    byF.get(r.factor_code).push(Number(r.mc) / 1e4);   // → 亿元
  }
  const styleOf = (yi) => yi < 50 ? "小盘" : yi < 200 ? "中盘" : yi < 1000 ? "大盘" : "超大盘";
  _mktCapCache = new Map();
  for (const [code, arr] of byF) {
    arr.sort((a, b) => a - b);
    const med = arr[Math.floor(arr.length / 2)];
    _mktCapCache.set(code, { medCap: med, style: styleOf(med) });
  }
  return _mktCapCache;
}

// startMonth/endMonth: 'YYYY-MM'（含端点）；null 表示不限。
async function computeRankingFast(startMonth, endMonth) {
  const snap = await ensureRankingSnapshot();
  const months = snap.months || [];
  const side = normalizeSide(_rankState.side);
  const retKey = normalizeScoreMode(_rankState.scoreMode) === "neutral"
    ? (normalizeConstraintMode(_rankState.constraintMode) === "industry" ? "neutral_industry_neutral_top30_ret" : "neutral_top30_ret")
    : (normalizeConstraintMode(_rankState.constraintMode) === "industry" ? "industry_neutral_top30_ret" : "top30_ret");
  const icKey = normalizeScoreMode(_rankState.scoreMode) === "neutral" ? "neutral_rank_ic" : "rank_ic";
  const decayKey = normalizeScoreMode(_rankState.scoreMode) === "neutral" ? "neutral_ic_decay" : "ic_decay";
  const idxs = rangeFilterIndexes(months, startMonth, endMonth);
  const rows = [];
  for (const f of snap.factors || []) {
    const rets = sliceByIndexes(f[retKey] || f.top30_ret, idxs).map(v => Number(v) * side);
    const rankStats = rankIcStats(sliceByIndexes(months, idxs), sliceByIndexes(f[icKey] || f.rank_ic, idxs), side, 1);
    const decayStats = filteredIcDecayStats(f[decayKey], side, startMonth, endMonth);
    const decayMean = (h) => {
      const item = decayStats.find(s => s.h === h);
      const val = item?.mean;
      return val === null || val === undefined || !Number.isFinite(Number(val)) ? 0 : Number(val);
    };
    const m = metricsFromReturns(rets);
    if (!m) continue;
    const rankIC = rankStats.mean ?? 0;
    const icir = rankStats.ir ?? 0;
    rows.push({
      code: f.code, name_cn: f.name_cn, l1: f.l1, l2: f.l2,
      annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      rankIC, rankIC3M: decayMean(3), rankIC6M: decayMean(6), rankIC12M: decayMean(12), icir,
      rankIcHacT: f.rank_ic_hac_t_stat_1m ?? null,
      rankIcP: f.rank_ic_p_value_1m ?? null,
      rankIcQ: f.rank_ic_q_value_1m ?? null,
      rankIcWinRate: f.rank_ic_win_rate_1m ?? null,
      top30ExcessAnnual: f.top30_excess_ann_return ?? null,
      top30ExcessMdd: f.top30_excess_max_drawdown ?? null,
      group10Mono: f.group10_monotonicity ?? null,
      top30Turnover: f.top30_avg_turnover ?? null,
      nMonths: rets.length,
      top3ind: f.top3ind || "—",
      medCap: f.medCap ?? null,
      capStyle: f.capStyle || "—",
      env_tag: f.env_tag || "—",
      time_tag: f.time_tag || "—",
    });
  }
  const zget = makeZScorer(rows);
  const W = { rankIC: .25, icir: .25, annual: .15, sharpe: .15, mdd: .10, winRate: .10 };
  for (const r of rows) {
    r.score =
      W.rankIC * zget("rankIC", r.rankIC) +
      W.icir   * zget("icir", r.icir) +
      W.annual * zget("annual", r.annual) +
      W.sharpe * zget("sharpe", r.sharpe) +
      W.mdd    * (-zget("mdd", r.mdd)) +
      W.winRate * zget("winRate", r.winRate);
  }
  return rows;
}

async function computeRanking(startMonth, endMonth) {
  // 区间过滤条件：回测和 IC 都按“收益结束月”筛选。
  const btWhere = ["top_n = 30"];
  // 剔除 NaN 的 RankIC 月（稀疏因子在某些月份截面 <3 只票，04 算 IC 得 NaN）。
  // 否则 AVG/STDDEV 遇 NaN 会传染成 NaN → 排行榜 RankIC/IC_IR 显示 0。与 602/856/993 行其它 IC 查询口径一致。
  const icWhere = ["NOT ISNAN(rank_ic)"];
  if (startMonth) {
    btWhere.push(`strftime(COALESCE(return_date, trade_date),'%Y-%m') >= '${startMonth}'`);
    icWhere.push(`strftime(COALESCE(return_month, month),'%Y-%m') >= '${startMonth}'`);
  }
  if (endMonth) {
    btWhere.push(`strftime(COALESCE(return_date, trade_date),'%Y-%m') <= '${endMonth}'`);
    icWhere.push(`strftime(COALESCE(return_month, month),'%Y-%m') <= '${endMonth}'`);
  }
  const icWhereSql = icWhere.length ? "WHERE " + icWhere.join(" AND ") : "";

  // 1) top-30 区间内的月度收益 → 在区间内重建 NAV（从 1.0 起），再算年化/夏普/回撤/胜率
  const btRes = await state.db.query(`
    SELECT factor_code, port_ret FROM preset_backtest
    WHERE ${btWhere.join(" AND ")} ORDER BY factor_code, trade_date
  `);
  const series = new Map();   // code → {rets, navs}
  for (const r of btRes.toArray()) {
    if (!series.has(r.factor_code)) series.set(r.factor_code, { rets: [], navs: [1] });
    const o = series.get(r.factor_code);
    o.rets.push(r.port_ret);
    const prev = o.navs[o.navs.length - 1];
    o.navs.push(prev * (1 + r.port_ret));   // 区间内重建净值，保证回撤/年化口径对齐区间
  }
  // 2) IC 统计：区间内 RankIC 均值 + IC_IR（按有效观测频率年化）
  const icRes = await state.db.query(`
    SELECT factor_code,
           strftime(COALESCE(return_month, month), '%Y-%m') AS ym,
           rank_ic
    FROM factor_ic ${icWhereSql}
    ORDER BY factor_code, ym
  `);
  const icStat = new Map();
  for (const r of icRes.toArray()) {
    if (!icStat.has(r.factor_code)) icStat.set(r.factor_code, { months: [], values: [] });
    const item = icStat.get(r.factor_code);
    item.months.push(r.ym);
    item.values.push(r.rank_ic);
  }
  // 2.5) 每因子 top-30 选股的前三行业 + 市值特征（最新截面，与时间区间无关，缓存只查一次）
  const ind3 = await factorTop3Industries();
  const mcap = await factorMarketCap();

  // 3) 每因子汇总指标
  const rows = [];
  for (const f of state.catalog) {
    const s = series.get(f.code);
    const m = s ? computeMetrics(s.rets, s.navs) : null;
    const icSeries = icStat.get(f.code) || { months: [], values: [] };
    const ic = rankIcStats(icSeries.months, icSeries.values, 1, 1);
    if (!m) continue;
    const mc = mcap.get(f.code);
    rows.push({
      code: f.code, name_cn: f.name_cn, l1: f.l1, l2: f.l2,
      annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      rankIC: ic.mean ?? 0, rankIC3M: 0, rankIC6M: 0, rankIC12M: 0, icir: ic.ir ?? 0,
      rankIcHacT: null,
      rankIcP: null,
      rankIcQ: null,
      rankIcWinRate: null,
      top30ExcessAnnual: null,
      top30ExcessMdd: null,
      group10Mono: null,
      top30Turnover: null,
      nMonths: s.rets.length,
      top3ind: ind3.get(f.code) || "—",
      medCap: mc ? mc.medCap : null,
      capStyle: mc ? mc.style : "—",
      env_tag: f.env_tag || "—",
      time_tag: f.time_tag || "—",
    });
  }
  // 4) 综合分：各分项在全因子截面标准化后加权。
  //    有效性(50%)：RankIC均值 25% + IC_IR 25%
  //    业绩(50%)：年化 15% + 夏普 15% + 最大回撤 10%(取负，回撤越小越好) + 月胜率 10%
  const zget = makeZScorer(rows);
  const W = { rankIC: .25, icir: .25, annual: .15, sharpe: .15, mdd: .10, winRate: .10 };
  for (const r of rows) {
    r.score =
      W.rankIC * zget("rankIC", r.rankIC) +
      W.icir   * zget("icir", r.icir) +
      W.annual * zget("annual", r.annual) +
      W.sharpe * zget("sharpe", r.sharpe) +
      W.mdd    * (-zget("mdd", r.mdd)) +     // 回撤是负数，越接近0越好 → z 越大越好，但方向上"大回撤"=更负，故取负使"小回撤"得高分
      W.winRate * zget("winRate", r.winRate);
  }
  return rows;
}

// 返回一个 (key, value) → 标准化分数 的函数（基于 rows 中该 key 的均值/标准差）
function makeZScorer(rows) {
  const stats = {};
  return (key, val) => {
    if (!stats[key]) {
      const xs = rows.map(r => r[key]).filter(v => Number.isFinite(v));
      const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
      const std = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length) || 1;
      stats[key] = { mean, std };
    }
    return (val - stats[key].mean) / stats[key].std;
  };
}

function drawRankTable() {
  const box = document.getElementById("rank-table");
  const { sortKey, desc } = _rankState;
  updateRankParamInfo();
  // 区间提示 + 样本月数
  const info = document.getElementById("rk-range-info");
  if (info) {
    const nMonths = _rankState.rows[0]?.nMonths;
    info.textContent = `区间 ${_rankState.start} ~ ${_rankState.end}` + (nMonths ? `（${nMonths} 个月）` : "");
  }
  // 标签筛选：多个标签为「与」关系（行的 env_tag/time_tag 须命中所有已选标签）
  const tf = _rankState.tagFilters;
  const base = tf.size
    ? _rankState.rows.filter(r => [...tf].every(t => r.env_tag === t || r.time_tag === t))
    : _rankState.rows;
  // mdd 排序特殊：值是负数，"越大(越接近0)越好"，默认降序即可；其它指标同理降序=好在前
  const sorted = [...base].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string") return desc ? bv.localeCompare(av) : av.localeCompare(bv);
    const af = Number.isFinite(Number(av));
    const bf = Number.isFinite(Number(bv));
    if (!af && !bf) return 0;
    if (!af) return 1;
    if (!bf) return -1;
    return desc ? bv - av : av - bv;
  });
  const ths = RANK_COLS.map(c => {
    const cls = `${c.lcol ? "lcol " : ""}${c.key === sortKey ? "sorted " : ""}${c.help ? "rank-help" : ""}`.trim();
    return `<th class="${cls}" data-key="${c.key}" title="${htmlAttr(c.help || c.label)}">${c.label}${c.key === sortKey ? (desc ? " ▼" : " ▲") : ""}</th>`;
  }).join("");
  // 首列：勾选框（含全选）
  const allChecked = sorted.length > 0 && sorted.every(r => _rankState.checked.has(r.code));
  let html = `<table class="rank-table"><thead><tr>` +
    `<th class="lcol" style="cursor:default"><input type="checkbox" id="rank-check-all" ${allChecked ? "checked" : ""}></th>` +
    `${ths}</tr></thead><tbody>`;
  sorted.forEach((r, i) => {
    r._rank = i + 1;
    const topCls = (sortKey === "score" && desc && i < 5) ? "top-rank" : "";
    const chk = `<td class="lcol"><input type="checkbox" class="rank-chk" data-code="${r.code}" ${_rankState.checked.has(r.code) ? "checked" : ""}></td>`;
    const tds = RANK_COLS.map(c => {
      const cls = (c.lcol ? "lcol " : "") + (c.cls || "");
      let val;
      if (c.key === "rank") val = r._rank;
      else val = c.fmt(r[c.key], r);
      return `<td class="${cls.trim()}">${val}</td>`;
    }).join("");
    html += `<tr class="${topCls}">${chk}${tds}</tr>`;
  });
  html += `</tbody></table>`;
  box.innerHTML = html;
  // 列头点击排序（勾选列除外）
  box.querySelectorAll("th[data-key]").forEach(th => {
    th.onclick = () => {
      const k = th.dataset.key;
      if (k === "rank" || k === "tags") return;   // 标签列不参与排序
      if (_rankState.sortKey === k) _rankState.desc = !_rankState.desc;
      else { _rankState.sortKey = k; _rankState.desc = true; }
      drawRankTable();
    };
  });
  // 勾选框
  box.querySelectorAll(".rank-chk").forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) _rankState.checked.add(cb.dataset.code);
      else _rankState.checked.delete(cb.dataset.code);
      updateRankSelCount();
    };
  });
  const all = document.getElementById("rank-check-all");
  if (all) all.onchange = () => {
    if (all.checked) sorted.forEach(r => _rankState.checked.add(r.code));
    else sorted.forEach(r => _rankState.checked.delete(r.code));
    drawRankTable();
  };
  updateRankSelCount();
}

function updateRankSelCount() {
  const el = document.getElementById("rank-sel-count");
  if (el) el.textContent = `已选 ${_rankState.checked.size} 个`;
}

// 把排行榜勾选的因子带入 对比 / 合成，并切到对应 tab
function rankSendTo(mode) {
  const codes = [..._rankState.checked];
  if (codes.length === 0) { alert("请先勾选至少一个因子"); return; }
  const side = normalizeSide(_rankState.side);
  const scoreMode = normalizeScoreMode(_rankState.scoreMode);
  const constraintMode = normalizeConstraintMode(_rankState.constraintMode);
  if (mode === "single") {
    const code = codes[0];
    if (codes.length > 1) alert(`已选择多个因子，将打开第一个：${code}`);
    state.singleSide = side;
    state.singleScoreMode = scoreMode;
    state.singleConstraintMode = constraintMode;
    switchMode("single");
    selectFactor(code, { preserveParams: true });
    return;
  }
  if (mode === "compare") {
    state.compareFactors = codes.map(code => ({ code, n: state.compareDefaultN, side, scoreMode, constraintMode }));
  } else {
    let composeScoreMode = scoreMode;
    if (scoreMode === "neutral" && !hasComposeNeutralScores()) {
      alert(composeNeutralUnavailableMessage());
      composeScoreMode = "raw";
    }
    state.composeFactors = codes.map(code => ({ code, weight: 1, side, scoreMode: composeScoreMode, op: ">=", thr: null }));
    state.composeConstraintMode = constraintMode;
  }
  switchMode(mode);
}

// ===================== 多因子合成 =====================

// 按"当前所选因子集"缓存一张宽表 cps_matrix，避免每次调权重/阈值都重扫历史分片。
// cps_matrix 只含选中因子的 (trade_date, stock_code, f0..fn, fwd_return)，因子集变化
// 才重建；权重、阈值、N 改变只查内存宽表。
let _cpsBaseKey = null;
let _cpsBaseBuild = null;     // 进行中的重建 promise（串行锁）
let _cpsMatrixCodes = [];
const _composeFilePaths = new Map();
const _composeFileLoads = new Map();
let _latestComposeBtKey = null;
let _latestComposeBt = null;
const _composeBtCache = new Map();
const _composeBtBuilds = new Map();
const _composeIcDecayCache = new Map();
const _composeIcDecayBuilds = new Map();

function composeScorePath(code, scoreMode = "raw") {
  const dir = normalizeScoreMode(scoreMode) === "neutral" ? COMPOSE_SCORE_NEUTRAL_DIR : COMPOSE_SCORE_DIR;
  return `${dir}${code}.parquet${V}`;
}

function composeShardKey(code, scoreMode = "raw") {
  return `${normalizeScoreMode(scoreMode)}|${code}`;
}

function composeFactorShards(factors = state.composeFactors) {
  const items = [];
  const seen = new Set();
  for (const f of cloneComposeFactors(factors)) {
    const key = composeShardKey(f.code, f.scoreMode);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ code: f.code, scoreMode: normalizeScoreMode(f.scoreMode), key });
  }
  return items.sort((a, b) => a.key.localeCompare(b.key));
}

async function ensureComposeFiles(items) {
  await Promise.all(items.map(async (item) => {
    const key = item.key || composeShardKey(item.code, item.scoreMode);
    if (_composeFilePaths.has(key)) return;
    if (!_composeFileLoads.has(key)) {
      _composeFileLoads.set(key, (async () => {
        const url = composeScorePath(item.code, item.scoreMode);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const path = `/${normalizeScoreMode(item.scoreMode) === "neutral" ? "compose_scores_neutral" : "compose_scores"}/${item.code}.parquet`;
        await state.duckdb.registerFileBuffer(path, bytes);
        _composeFilePaths.set(key, path);
      })());
    }
    await _composeFileLoads.get(key);
  }));
}

function composeScoreReadExpr(items) {
  const paths = items.map(item => {
    const key = item.key || composeShardKey(item.code, item.scoreMode);
    return `'${_composeFilePaths.get(key) || composeScorePath(item.code, item.scoreMode)}'`;
  }).join(",");
  return `read_parquet([${paths}])`;
}

function composeConfigKey(factors = state.composeFactors, N = state.composeN, constraintMode = state.composeConstraintMode) {
  const norm = cloneComposeFactors(factors).sort((a, b) => a.code.localeCompare(b.code));
  return JSON.stringify({ N, constraintMode: normalizeConstraintMode(constraintMode), factors: norm });
}

function composeScoreConfigKey(factors = state.composeFactors, startMonth = state.composeStart, endMonth = state.composeEnd) {
  const norm = cloneComposeFactors(factors).sort((a, b) => {
    const ka = `${composeShardKey(a.code, a.scoreMode)}|${a.side}|${a.weight}|${a.op}|${a.thr}`;
    const kb = `${composeShardKey(b.code, b.scoreMode)}|${b.side}|${b.weight}|${b.op}|${b.thr}`;
    return ka.localeCompare(kb);
  });
  return JSON.stringify({ startMonth: startMonth || null, endMonth: endMonth || null, factors: norm });
}

function cloneBacktest(bt) {
  return bt ? { x: bt.x.slice(), navArr: bt.navArr.slice(), retArr: bt.retArr.slice() } : null;
}

function rememberComposeBacktest(key, bt) {
  _composeBtCache.set(key, cloneBacktest(bt));
  while (_composeBtCache.size > 12) _composeBtCache.delete(_composeBtCache.keys().next().value);
}

function matrixCondSql(factors = state.composeFactors) {
  const idxMap = new Map(_cpsMatrixCodes.map((key, i) => [key, i]));
  const parts = [];
  for (const f of factors) {
    if (f.thr === null || !Number.isFinite(Number(f.thr))) continue;
    const idx = idxMap.get(composeShardKey(f.code, f.scoreMode));
    if (idx === undefined) return null;
    parts.push(`${effectiveScoreSql(`f${idx}`, f.side)} ${f.op} ${Number(f.thr)}`);
  }
  return parts.length ? "AND " + parts.join(" AND ") : "";
}

function matrixScoreSql(factors = state.composeFactors) {
  const idxMap = new Map(_cpsMatrixCodes.map((key, i) => [key, i]));
  const terms = [];
  for (const f of factors) {
    const idx = idxMap.get(composeShardKey(f.code, f.scoreMode));
    if (idx === undefined) return null;
    const weight = Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0;
    terms.push(`${effectiveScoreSql(`f${idx}`, f.side)} * ${weight}`);
  }
  return terms.length ? terms.join(" + ") : "0";
}

async function ensureComposeBase() {
  const shards = composeFactorShards(state.composeFactors);
  const key = shards.map(item => item.key).join(",");
  // 若已有重建在跑，先等它结束（快速连点多个因子时，多次 renderCompose 并发调用本函数；
  // 不串行化会让 DROP/CREATE 交错 → "Table cps_base already exists"）。等完后用最新 key 复判。
  if (_cpsBaseBuild) { try { await _cpsBaseBuild; } catch (_) {} }
  if (key === _cpsBaseKey) return;          // 因子集未变，复用缓存
  _cpsBaseBuild = (async () => {
    // DROP→CREATE 用 CREATE OR REPLACE 保证幂等；先置 key 失效，建好再写回。
    _cpsBaseKey = null;
    if (shards.length === 0) {
      await state.db.query(`DROP TABLE IF EXISTS cps_matrix`);
      await state.db.query(`DROP TABLE IF EXISTS cps_latest_matrix`);
      _cpsMatrixCodes = [];
    } else {
      await ensureComposeFiles(shards);
      // 只读取选中因子的历史分片。后续所有合成查询不再碰远程 parquet。
      const scoreCols = shards.map((item, i) =>
        `MAX(CASE WHEN factor_code = '${item.code}' AND score_mode = '${item.scoreMode}' THEN score END) AS f${i}`
      ).join(",\n               ");
      const matrixCols = shards.map((_, i) => `w.f${i}`).join(", ");
      await state.db.query(`
        CREATE OR REPLACE TABLE cps_matrix AS
        WITH src AS (
          SELECT trade_date, return_date, stock_code, factor_code, score, fwd_return,
                 CASE WHEN filename LIKE '%compose_scores_neutral/%' THEN 'neutral' ELSE 'raw' END AS score_mode
          FROM read_parquet([${shards.map(item => {
            const key = item.key || composeShardKey(item.code, item.scoreMode);
            return `'${_composeFilePaths.get(key) || composeScorePath(item.code, item.scoreMode)}'`;
          }).join(",")}], filename=true)
          WHERE score IS NOT NULL
        ),
        wide AS (
          SELECT trade_date, stock_code,
                 ${scoreCols},
                 MAX(return_date) AS return_date,
                 MAX(fwd_return) AS fwd_return,
                 COUNT(DISTINCT factor_code || '|' || score_mode) AS factor_count
          FROM src
          GROUP BY trade_date, stock_code
        )
        SELECT w.trade_date, w.return_date, w.stock_code, ${matrixCols}, w.fwd_return
        FROM wide w
        WHERE w.factor_count = ${shards.length}
      `);
      await state.db.query(`
        CREATE OR REPLACE TABLE cps_latest_matrix AS
        SELECT * FROM cps_matrix WHERE trade_date = (SELECT MAX(trade_date) FROM cps_matrix)
      `);
      _cpsMatrixCodes = shards.map(item => item.key);
    }
    _latestComposeBtKey = null;
    _latestComposeBt = null;
    _composeBtCache.clear();
    _composeBtBuilds.clear();
    _composeIcDecayCache.clear();
    _composeIcDecayBuilds.clear();
    _cpsBaseKey = key;
  })();
  try { await _cpsBaseBuild; } finally { _cpsBaseBuild = null; }
}

function toggleComposeFactor(code) {
  const i = state.composeFactors.findIndex(f => f.code === code);
  if (i >= 0) state.composeFactors.splice(i, 1);
  else state.composeFactors.push({ code, weight: 1, side: 1, scoreMode: "raw", op: ">=", thr: null });
  updateTreeHighlight();
  renderComposeSoon(20);
}

// 参数化版过滤条件 SQL 片段。基于设了阈值(thr非null)的因子。
function composeCondFor(factors, baseTable) {
  const conds = cloneComposeFactors(factors).filter(f => f.thr !== null && Number.isFinite(f.thr));
  if (conds.length === 0) return { cte: "", join: "", nConds: 0 };
  const hasScoreMode = baseTable === "cps_cmp_base";
  const orC = conds.map(f => {
    const modeCond = hasScoreMode ? ` AND score_mode='${normalizeScoreMode(f.scoreMode)}'` : "";
    return `(factor_code='${f.code}'${modeCond} AND score * ${normalizeSide(f.side)} ${f.op} ${f.thr})`;
  }).join(" OR ");
  return {
    cte: `cond AS (SELECT trade_date, stock_code, COUNT(*) AS p FROM ${baseTable}
            WHERE score IS NOT NULL AND (${orC}) GROUP BY trade_date, stock_code),`,
    join: `JOIN cond cd ON cd.trade_date = c.trade_date AND cd.stock_code = c.stock_code AND cd.p = ${conds.length}`,
    nConds: conds.length,
  };
}

// 过滤条件 SQL 片段：返回 {cte, join, nConds}。基于设了阈值(thr非null)的因子。
function composeCond() {
  return composeCondFor(state.composeFactors, "cps_base");
}

function removeComposeAt(i) {
  state.composeFactors.splice(i, 1);
  updateTreeHighlight();
  renderComposeSoon();
}

// 合成 SQL 的 VALUES 子句： (VALUES ('PE',0.4),('ROE',0.6)) w(code,weight)
function composeValues() {
  return state.composeFactors.map(f => `('${f.code}',${f.weight})`).join(",");
}

function comboSummary(combo) {
  const constraintMode = normalizeConstraintMode(combo.constraintMode);
  return cloneComposeFactors(combo.factors)
    .map(f => `${factorParamName(f.code, f.side, f.scoreMode)}×${f.weight}${f.thr !== null ? `(${f.op}${f.thr})` : ""}`)
    .join(" + ") + `，top${combo.N}，${constraintModeLabel(constraintMode)}`;
}

function comboDetailHtml(combo) {
  const rows = cloneComposeFactors(combo.factors).map(f => {
    const meta = state.catalog.find(x => x.code === f.code);
    const thr = f.thr === null ? "不过滤" : `得分 ${f.op} ${f.thr}`;
    return `<tr><td>${htmlText(f.code)}</td><td>${htmlText(meta?.name_cn || "")}</td><td>${htmlText(sideLabel(f.side))}</td><td>${htmlText(scoreModeLabel(f.scoreMode))}</td><td>${htmlText(f.weight)}</td><td>${htmlText(thr)}</td></tr>`;
  }).join("");
  return `<div class="published-detail">
    ${combo.description ? `<p>${htmlText(combo.description)}</p>` : ""}
    <p class="published-meta">组合约束：${constraintModeLabel(normalizeConstraintMode(combo.constraintMode))}</p>
    <table class="published-detail-table"><thead><tr><th>因子</th><th>名称</th><th>方向</th><th>口径</th><th>权重</th><th>过滤</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="published-meta">${combo.created_at ? "创建：" + htmlText(combo.created_at) + " · " : ""}ID：${htmlText(combo.id)}</p>
  </div>`;
}

function comboToTempCompare(combo) {
  return {
    name: combo.name,
    factors: cloneComposeFactors(combo.factors),
    N: combo.N,
    constraintMode: normalizeConstraintMode(combo.constraintMode),
    color: STRAT_COLORS[state.savedCombos.length % STRAT_COLORS.length],
    bt: null,
  };
}

function syncComposeNButtons() {
  document.querySelectorAll(".cpsn-btn[data-n]").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.n) === state.composeN);
  });
  const inp = document.getElementById("cpsn-input");
  if (inp) inp.value = [10, 30, 50].includes(state.composeN) ? "" : state.composeN;
}

function getLibraryCombo(source, id) {
  const list = source === "mine" ? state.myCombos : state.publishedCombos;
  return list.find(c => c.id === id && c.valid);
}

function loadLibraryCombo(source, id) {
  const combo = getLibraryCombo(source, id);
  if (!combo) return;
  state.composeFactors = cloneComposeFactors(combo.factors);
  state.composeN = combo.N;
  state.composeConstraintMode = normalizeConstraintMode(combo.constraintMode);
  syncComposeNButtons();
  switchMode("compose");
}

function loadComboForValidation(source, id) {
  loadLibraryCombo(source, id);
  setTimeout(() => {
    const el = document.getElementById("combo-validation-panel");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 250);
}

async function compareLibraryCombo(source, id) {
  const combo = getLibraryCombo(source, id);
  if (!combo) return;
  state.savedCombos.push(comboToTempCompare(combo));
  renderSavedCombos();
  await renderComboCompare();
}

function toggleLibraryDetail(source, id) {
  const openSet = source === "mine" ? state.myComboOpen : state.publishedComboOpen;
  if (openSet.has(id)) openSet.delete(id);
  else openSet.add(id);
  renderComboLibrary();
}

function renderComboCards(box, combos, source, emptyText) {
  if (!box) return;
  if (!combos.length) {
    box.innerHTML = `<div class="empty">${htmlText(emptyText)}</div>`;
    return;
  }
  const openSet = source === "mine" ? state.myComboOpen : state.publishedComboOpen;
  const cardClass = source === "mine" ? "my-combo-card" : "published-combo-card";
  box.innerHTML = combos.map(combo => {
    const safeId = htmlAttr(combo.id);
    const safeSource = htmlAttr(source);
    const tags = combo.tags.length
      ? combo.tags.map(t => `<span class="published-tag">${htmlText(t)}</span>`).join("")
      : "";
    const detail = openSet.has(combo.id) ? comboDetailHtml(combo) : "";
    const disabled = combo.valid ? "" : " disabled";
    const invalid = combo.valid ? "" : `<div class="published-invalid">配置无效：${htmlText(combo.invalidReason)}</div>`;
    const deleteBtn = source === "mine"
      ? `<button class="cpsn-btn my-delete" data-source="${safeSource}" data-id="${safeId}"${disabled}>删除</button>`
      : "";
    const renameBtn = source === "mine"
      ? `<button class="cpsn-btn my-rename" data-source="${safeSource}" data-id="${safeId}"${disabled}>改名</button>`
      : "";
    const publishBtn = source === "mine"
      ? `<button class="cpsn-btn my-publish" data-source="${safeSource}" data-id="${safeId}"${disabled}>申请发布</button>`
      : "";
    const deleteRequestBtn = source === "published" && combo.source === "supabase"
      ? `<button class="cpsn-btn published-delete-request" data-id="${safeId}"${disabled}>申请删除</button>`
      : "";
    return `<div class="published-combo-card ${cardClass}${combo.valid ? "" : " invalid"}" data-id="${safeId}">
      <div class="published-combo-head">
        <div>
          <b class="published-combo-name">${htmlText(combo.name)}</b>
          <span class="published-n">top${htmlText(combo.N)}</span>
          ${tags}
        </div>
        <div class="published-actions">
          <button class="cpsn-btn library-load" data-source="${safeSource}" data-id="${safeId}"${disabled}>载入</button>
          <button class="cpsn-btn library-validate" data-source="${safeSource}" data-id="${safeId}"${disabled}>检验</button>
          <button class="cpsn-btn library-compare" data-source="${safeSource}" data-id="${safeId}"${disabled}>加入对比</button>
          <button class="cpsn-btn library-detail-toggle" data-source="${safeSource}" data-id="${safeId}">${openSet.has(combo.id) ? "收起" : "详情"}</button>
          ${renameBtn}
          ${publishBtn}
          ${deleteRequestBtn}
          ${deleteBtn}
        </div>
      </div>
      <div class="published-summary">${htmlText(comboSummary(combo))}</div>
      ${combo.description ? `<div class="published-desc">${htmlText(combo.description)}</div>` : ""}
      ${invalid}
      ${detail}
    </div>`;
  }).join("");
  box.querySelectorAll(".library-load").forEach(btn => {
    btn.onclick = () => loadLibraryCombo(btn.dataset.source, btn.dataset.id);
  });
  box.querySelectorAll(".library-validate").forEach(btn => {
    btn.onclick = () => loadComboForValidation(btn.dataset.source, btn.dataset.id);
  });
  box.querySelectorAll(".library-compare").forEach(btn => {
    btn.onclick = () => compareLibraryCombo(btn.dataset.source, btn.dataset.id).catch(e => console.error("compare library combo failed:", e));
  });
  box.querySelectorAll(".library-detail-toggle").forEach(btn => {
    btn.onclick = () => toggleLibraryDetail(btn.dataset.source, btn.dataset.id);
  });
  box.querySelectorAll(".my-delete").forEach(btn => {
    btn.onclick = () => deleteMyCombo(btn.dataset.id);
  });
  box.querySelectorAll(".my-rename").forEach(btn => {
    btn.onclick = () => renameMyCombo(btn.dataset.id);
  });
  box.querySelectorAll(".my-publish").forEach(btn => {
    btn.onclick = () => copyMyComboPublishRequest(btn.dataset.id, btn).catch(e => console.error("copy my combo publish request failed", e));
  });
  box.querySelectorAll(".published-delete-request").forEach(btn => {
    btn.onclick = () => submitDeleteRequestForPublished(btn.dataset.id, btn).catch(e => console.error("submit delete request failed", e));
  });
}

function renderPublishedCombos() {
  const box = document.getElementById("cps-published-list");
  if (!box) return;
  if (!state.publishedCombosLoaded) {
    box.innerHTML = `<div class="empty">组合库加载中…</div>`;
    return;
  }
  if (state.publishedComboErrors.length && !state.publishedCombos.length) {
    box.innerHTML = `<div class="empty" style="color:#c14545">${htmlText(state.publishedComboErrors.join("；"))}</div>`;
    return;
  }
  renderComboCards(box, state.publishedCombos, "published", "暂无已发布组合");
  if (state.publishedComboErrors.length) {
    box.insertAdjacentHTML("afterbegin", `<div class="empty" style="margin-bottom:8px;color:#c14545">${htmlText(state.publishedComboErrors.join("；"))}</div>`);
  }
}

function renderMyCombos() {
  renderComboCards(document.getElementById("cps-my-list"), state.myCombos, "mine", "还没有我的组合。可在多因子合成里保存当前组合，或先加入临时对比后一次保存全部。");
}

function renderComboLibrary() {
  document.querySelectorAll(".combo-tab").forEach(btn => {
    const active = btn.dataset.tab === state.comboLibraryTab;
    btn.classList.toggle("active", active);
  });
  const pub = document.getElementById("cps-published-list");
  const mine = document.getElementById("cps-my-list");
  if (pub) pub.style.display = state.comboLibraryTab === "published" ? "" : "none";
  if (mine) mine.style.display = state.comboLibraryTab === "mine" ? "" : "none";
  renderComboRanking();
  renderPublishedCombos();
  renderMyCombos();
  document.querySelectorAll(".combo-tab").forEach(btn => {
    btn.onclick = () => {
      state.comboLibraryTab = btn.dataset.tab === "mine" ? "mine" : "published";
      renderComboLibrary();
    };
  });
}

function comboRankingCandidates() {
  const source = state.comboRankingSource || "all";
  const rows = [];
  if (source === "all" || source === "published") {
    rows.push(...state.publishedCombos.filter(c => c.valid).map(c => ({ source: "published", combo: c })));
  }
  if (source === "all" || source === "mine") {
    rows.push(...state.myCombos.filter(c => c.valid).map(c => ({ source: "mine", combo: c })));
  }
  return rows;
}

function comboRankingSourceLabel(source) {
  return source === "mine" ? "我的组合" : "已发布";
}

function comboRankingScore(row) {
  if (row.error) return -999;
  const rankIc = snapshotNumber(row.rank_ic) ?? 0;
  const icIr = snapshotNumber(row.ic_ir) ?? 0;
  const annual = snapshotNumber(row.ann_return) ?? 0;
  const mono = snapshotNumber(row.monotonicity) ?? 0;
  const mdd = Math.abs(snapshotNumber(row.max_drawdown) ?? 0);
  const corr = snapshotNumber(row.max_abs_corr) ?? 0;
  const singleGain = snapshotNumber(row.best_single_ic_ir_gap) ?? 0;
  const samplePenalty = (snapshotNumber(row.n_months) ?? 0) < 36 ? 0.8 : 0;
  const corrPenalty = corr >= 0.7 ? (corr - 0.6) * 1.5 : 0;
  return icIr + rankIc * 10 + annual * 1.5 + mono * 0.35 + singleGain * 0.45 - mdd * 0.45 - corrPenalty - samplePenalty;
}

function comboRankingRowFromPayload(source, combo, payload) {
  const m = payload.metrics || {};
  const rank = payload.rankStats || {};
  const bm = payload.benchmarkMetrics || {};
  const corrRows = payload.correlation?.rows || [];
  const maxAbsCorr = corrRows.length ? Math.max(...corrRows.map(r => Math.abs(Number(r.corr) || 0))) : null;
  const best = payload.singleComparison?.best || null;
  const row = {
    id: combo.id,
    source,
    source_label: comboRankingSourceLabel(source),
    name: combo.name,
    N: combo.N,
    constraintMode: normalizeConstraintMode(combo.constraintMode),
    factors: cloneComposeFactors(combo.factors),
    rank_ic: rank.mean,
    ic_ir: rank.ir,
    ic_win_rate: rank.winRate,
    n_months: rank.n,
    ann_return: m.annual ?? null,
    sharpe: m.sharpe ?? null,
    max_drawdown: m.mdd ?? null,
    win_rate: m.winRate ?? null,
    excess_300: (m.annual !== null && m.annual !== undefined && bm.HS300) ? m.annual - bm.HS300.annual : null,
    excess_800: (m.annual !== null && m.annual !== undefined && bm.CSI800) ? m.annual - bm.CSI800.annual : null,
    monotonicity: payload.group10?.monotonicity ?? null,
    ls_ann_return: payload.group10?.ls?.annual ?? null,
    max_abs_corr: maxAbsCorr,
    best_single: best?.label || best?.code || "",
    best_single_ic_ir: best?.ic_ir ?? null,
    best_single_ic_ir_gap: (rank.ir !== null && rank.ir !== undefined && best?.ic_ir !== null && best?.ic_ir !== undefined) ? rank.ir - best.ic_ir : null,
    error: "",
  };
  row.score = comboRankingScore(row);
  return row;
}

function comboRankingErrorRow(source, combo, err) {
  return {
    id: combo.id,
    source,
    source_label: comboRankingSourceLabel(source),
    name: combo.name,
    N: combo.N,
    constraintMode: normalizeConstraintMode(combo.constraintMode),
    factors: cloneComposeFactors(combo.factors),
    error: err?.message || String(err || "计算失败"),
    score: -999,
  };
}

function restoreComposeContext(snapshot) {
  state.composeFactors = cloneComposeFactors(snapshot.factors);
  state.composeN = snapshot.N;
  state.composeConstraintMode = normalizeConstraintMode(snapshot.constraintMode);
  state.composeStart = snapshot.start;
  state.composeEnd = snapshot.end;
  syncComposeNButtons();
  updateTreeHighlight();
}

async function comboRankingPayloadFor(combo) {
  state.composeFactors = cloneComposeFactors(combo.factors);
  state.composeN = Number(combo.N);
  state.composeConstraintMode = normalizeConstraintMode(combo.constraintMode);
  state.composeStart = null;
  state.composeEnd = null;
  await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
  await ensureComposeBase();
  return comboValidationPayload(state.composeFactors, state.composeN, state.composeConstraintMode, state.composeStart, state.composeEnd, { includeCrowding: false, includeParameterSensitivity: false });
}

async function runComboRanking() {
  if (state.comboRankingRunning) return;
  const candidates = comboRankingCandidates();
  state.comboRankingRows = [];
  state.comboRankingRunning = true;
  renderComboRanking(`准备计算 ${candidates.length} 个组合…`);
  const snapshot = {
    factors: cloneComposeFactors(state.composeFactors),
    N: state.composeN,
    constraintMode: state.composeConstraintMode,
    start: state.composeStart,
    end: state.composeEnd,
  };
  try {
    for (let i = 0; i < candidates.length; i += 1) {
      const { source, combo } = candidates[i];
      renderComboRanking(`正在计算 ${i + 1}/${candidates.length}：${combo.name}`);
      try {
        const payload = await comboRankingPayloadFor(combo);
        state.comboRankingRows.push(comboRankingRowFromPayload(source, combo, payload));
      } catch (err) {
        console.error("combo ranking failed:", combo.name, err);
        state.comboRankingRows.push(comboRankingErrorRow(source, combo, err));
      }
      renderComboRanking(`已计算 ${i + 1}/${candidates.length}`);
    }
  } finally {
    restoreComposeContext(snapshot);
    state.comboRankingRunning = false;
    renderComboRanking(candidates.length ? `已完成 ${state.comboRankingRows.length} 个组合。点击列头排序，综合分只用于排序提示。` : "没有可计算的有效组合");
  }
}

function sortedComboRankingRows() {
  const key = state.comboRankingSortKey || "score";
  const dir = state.comboRankingSortDir === "asc" ? 1 : -1;
  return state.comboRankingRows.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "string" || typeof bv === "string") return String(av || "").localeCompare(String(bv || "")) * dir;
    const an = snapshotNumber(av);
    const bn = snapshotNumber(bv);
    if (an === null && bn === null) return 0;
    if (an === null) return 1;
    if (bn === null) return -1;
    return (an - bn) * dir;
  });
}

function renderComboRanking(statusText = null) {
  const box = document.getElementById("combo-ranking-table");
  const status = document.getElementById("combo-ranking-status");
  const runBtn = document.getElementById("combo-ranking-run");
  const sourceSel = document.getElementById("combo-ranking-source");
  if (!box) return;
  if (sourceSel) sourceSel.value = state.comboRankingSource || "all";
  if (runBtn) {
    runBtn.disabled = state.comboRankingRunning;
    runBtn.textContent = state.comboRankingRunning ? "计算中…" : "计算排行榜";
  }
  if (status) status.textContent = statusText || (state.comboRankingRows.length ? `已计算 ${state.comboRankingRows.length} 个组合。点击列头排序。` : "尚未计算");
  if (!state.comboRankingRows.length) {
    box.innerHTML = `<div class="empty">点击“计算排行榜”后显示</div>`;
    bindComboRankingHandlers();
    return;
  }
  const cols = [
    { key: "name", label: "组合" },
    { key: "source_label", label: "来源" },
    { key: "score", label: "综合分" },
    { key: "rank_ic", label: "RankIC" },
    { key: "ic_ir", label: "IC_IR" },
    { key: "ic_win_rate", label: "IC胜率" },
    { key: "ann_return", label: "TopN年化" },
    { key: "sharpe", label: "夏普" },
    { key: "max_drawdown", label: "最大回撤" },
    { key: "excess_300", label: "超额vs300" },
    { key: "excess_800", label: "超额vs800" },
    { key: "monotonicity", label: "10组单调性" },
    { key: "ls_ann_return", label: "LS年化" },
    { key: "n_months", label: "样本月数" },
    { key: "max_abs_corr", label: "最高相关性" },
    { key: "best_single_ic_ir_gap", label: "相对最佳单因子" },
  ];
  const rows = sortedComboRankingRows();
  const th = cols.map(c => `<th class="${state.comboRankingSortKey === c.key ? "sorted" : ""}" data-key="${c.key}">${c.label}${state.comboRankingSortKey === c.key ? (state.comboRankingSortDir === "asc" ? " ↑" : " ↓") : ""}</th>`).join("");
  const body = rows.map(r => {
    const warn = (snapshotNumber(r.n_months) ?? 99) < 36 ? `<span class="combo-ranking-warn">样本短</span>` : ((snapshotNumber(r.max_abs_corr) ?? 0) >= 0.7 ? `<span class="combo-ranking-warn">高相关</span>` : "");
    if (r.error) {
      return `<tr class="failed"><td class="combo-ranking-name">${htmlText(r.name)}</td><td>${htmlText(r.source_label)}</td><td colspan="${cols.length - 2}">计算失败：${htmlText(r.error)}</td><td><button class="cpsn-btn combo-ranking-validate" data-source="${htmlAttr(r.source)}" data-id="${htmlAttr(r.id)}">检验</button></td></tr>`;
    }
    return `<tr>
      <td class="combo-ranking-name" title="${htmlAttr(comboSummary(r))}">${htmlText(r.name)}${warn}</td>
      <td>${htmlText(r.source_label)}</td>
      <td>${signalValue("ic_ir", r.score, signedNumText(r.score, 2))}</td>
      <td>${signalValue("rank_ic", r.rank_ic, signedPctText(r.rank_ic))}</td>
      <td>${signalValue("ic_ir", r.ic_ir, signedNumText(r.ic_ir, 2))}</td>
      <td>${signalValue("win_rate", r.ic_win_rate, pctText(r.ic_win_rate))}</td>
      <td>${signalValue("ann_return", r.ann_return, pctText(r.ann_return))}</td>
      <td>${signalValue("sharpe", r.sharpe, signedNumText(r.sharpe, 2))}</td>
      <td>${pctText(r.max_drawdown)}</td>
      <td>${signalValue("ann_return", r.excess_300, signedPctText(r.excess_300))}</td>
      <td>${signalValue("ann_return", r.excess_800, signedPctText(r.excess_800))}</td>
      <td>${signalValue("monotonicity", r.monotonicity, numText(r.monotonicity, 2))}</td>
      <td>${signalValue("ann_return", r.ls_ann_return, pctText(r.ls_ann_return))}</td>
      <td>${signalValue("sample_months", r.n_months, numText(r.n_months, 0))}</td>
      <td>${r.max_abs_corr === null || r.max_abs_corr === undefined ? "—" : signalValue("correlation", r.max_abs_corr, numText(r.max_abs_corr, 2))}</td>
      <td>${signalValue("ic_ir", r.best_single_ic_ir_gap, signedNumText(r.best_single_ic_ir_gap, 2))}${r.best_single ? `<span class="combo-ranking-warn">${htmlText(r.best_single)}</span>` : ""}</td>
      <td><button class="cpsn-btn combo-ranking-validate" data-source="${htmlAttr(r.source)}" data-id="${htmlAttr(r.id)}">检验</button></td>
    </tr>`;
  }).join("");
  box.innerHTML = `<div class="combo-ranking-scroll"><table class="combo-ranking-table">
    <thead><tr>${th}<th>操作</th></tr></thead><tbody>${body}</tbody>
  </table></div>`;
  bindComboRankingHandlers();
}

function bindComboRankingHandlers() {
  const runBtn = document.getElementById("combo-ranking-run");
  if (runBtn) runBtn.onclick = () => runComboRanking().catch(e => {
    console.error("run combo ranking failed:", e);
    state.comboRankingRunning = false;
    renderComboRanking(`计算失败：${e.message || e}`);
  });
  const sourceSel = document.getElementById("combo-ranking-source");
  if (sourceSel) sourceSel.onchange = () => {
    state.comboRankingSource = sourceSel.value || "all";
    state.comboRankingRows = [];
    renderComboRanking("来源已切换，点击“计算排行榜”重新计算");
  };
  document.querySelectorAll(".combo-ranking-table th[data-key]").forEach(th => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (state.comboRankingSortKey === key) state.comboRankingSortDir = state.comboRankingSortDir === "asc" ? "desc" : "asc";
      else {
        state.comboRankingSortKey = key;
        state.comboRankingSortDir = key === "name" || key === "source_label" ? "asc" : "desc";
      }
      renderComboRanking();
    };
  });
  document.querySelectorAll(".combo-ranking-validate").forEach(btn => {
    btn.onclick = () => loadComboForValidation(btn.dataset.source, btn.dataset.id);
  });
}

function saveCurrentComboToMine() {
  if (!state.composeFactors.length) {
    alert("先选至少一个因子并设好权重，再保存当前组合");
    return;
  }
  const name = prompt("组合名", `我的组合${state.myCombos.length + 1}`);
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  if (state.myCombos.some(c => c.name === trimmedName)) {
    alert(`“${trimmedName}”已存在，请换一个名称`);
    return;
  }
  const validCodes = new Set(state.catalog.map(f => f.code));
  const existingIds = new Set(state.myCombos.map(c => c.id));
  const combo = validatePublishedCombo(rawComboFromCurrent(trimmedName, existingIds), state.myCombos.length, validCodes);
  combo.source = "mine";
  state.myCombos.push(combo);
  persistMyCombos();
  state.comboLibraryTab = "mine";
  renderComboLibrary();
}

function saveAllTempCombosToMine() {
  const validSaved = state.savedCombos.filter(c => c && c.factors && c.factors.length);
  if (!validSaved.length) {
    alert("先把要保存的组合加入临时对比，再一键保存");
    return;
  }
  const validCodes = new Set(state.catalog.map(f => f.code));
  const existingIds = new Set(state.myCombos.map(c => c.id));
  const existingNames = new Set(state.myCombos.map(c => c.name));
  const startIdx = state.myCombos.length;
  const combos = validSaved.map((saved, i) => {
    const raw = rawComboFromSavedCombo(saved, existingIds);
    raw.name = uniqueComboName(raw.name, existingNames);
    const combo = validatePublishedCombo(raw, startIdx + i, validCodes);
    existingIds.add(combo.id);
    existingNames.add(combo.name);
    combo.source = "mine";
    return combo;
  });
  state.myCombos.push(...combos);
  persistMyCombos();
  state.comboLibraryTab = "mine";
  renderComboLibrary();
}

function renameMyCombo(id) {
  const combo = state.myCombos.find(c => c.id === id);
  if (!combo) return;
  const name = prompt("组合名", combo.name);
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  if (state.myCombos.some(c => c.id !== id && c.name === trimmedName)) {
    alert(`“${trimmedName}”已存在，请换一个名称`);
    return;
  }
  combo.name = trimmedName;
  persistMyCombos();
  renderComboLibrary();
}

function deleteMyCombo(id) {
  const combo = state.myCombos.find(c => c.id === id);
  if (!combo) return;
  if (!confirm(`删除“${combo.name}”？`)) return;
  state.myCombos = state.myCombos.filter(c => c.id !== id);
  state.myComboOpen.delete(id);
  persistMyCombos();
  renderComboLibrary();
}

function setAdminStatus(msg, danger = false) {
  const el = document.getElementById("admin-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = danger ? "#c14545" : "#888";
}

function renderAdminView() {
  const loginBox = document.getElementById("admin-login-box");
  const sessionBox = document.getElementById("admin-session-box");
  const list = document.getElementById("admin-request-list");
  const publishedPanel = document.getElementById("admin-published-panel");
  if (!loginBox || !sessionBox || !list) return;
  const loggedIn = !!state.adminSession?.access_token;
  loginBox.style.display = loggedIn ? "none" : "";
  sessionBox.style.display = loggedIn ? "" : "none";
  if (publishedPanel) publishedPanel.style.display = loggedIn ? "" : "none";
  document.getElementById("admin-user").textContent = loggedIn
    ? `已登录：${state.adminSession.user?.email || "管理员"}`
    : "";
  if (!loggedIn) {
    list.innerHTML = `<div class="empty">登录后显示待审核申请</div>`;
    const publishedList = document.getElementById("admin-published-list");
    if (publishedList) publishedList.innerHTML = `<div class="empty">登录后显示已发布组合</div>`;
  } else {
    renderAdminRequests();
    renderAdminPublishedCombos();
  }
  bindAdminControls();
}

function bindAdminControls() {
  const login = document.getElementById("admin-login-btn");
  if (login) login.onclick = () => adminLogin().catch(e => console.error("admin login failed:", e));
  const refresh = document.getElementById("admin-refresh-btn");
  if (refresh) refresh.onclick = () => loadAdminData().catch(e => console.error("load admin data failed:", e));
  const logout = document.getElementById("admin-logout-btn");
  if (logout) logout.onclick = () => {
    state.adminSession = null;
    state.adminRequests = [];
    state.adminPublishedCombos = [];
    setAdminStatus("");
    renderAdminView();
  };
}

async function adminLogin() {
  const email = document.getElementById("admin-email").value.trim();
  const password = document.getElementById("admin-password").value;
  if (!email || !password) {
    setAdminStatus("请输入管理员邮箱和密码", true);
    return;
  }
  setAdminStatus("登录中…");
  try {
    state.adminSession = await supabaseSignIn(email, password);
    document.getElementById("admin-password").value = "";
    setAdminStatus("登录成功，正在加载待审核申请…");
    renderAdminView();
    await loadAdminData();
  } catch (err) {
    setAdminStatus(`登录失败：${err.message || err}`, true);
  }
}

async function loadAdminData() {
  await loadAdminRequests();
  await loadAdminPublishedCombos();
}

async function loadAdminRequests() {
  if (!state.adminSession?.access_token) return;
  setAdminStatus("加载申请中…");
  try {
    const q = "?select=*&status=eq.pending&order=created_at.desc&limit=100";
    state.adminRequests = await supabaseSelect("combo_publish_requests", q, state.adminSession.access_token);
    renderAdminRequests();
    setAdminStatus(`已加载 ${state.adminRequests.length} 条待审核申请`);
  } catch (err) {
    setAdminStatus(`加载失败：${err.message || err}`, true);
  }
}

async function loadAdminPublishedCombos() {
  if (!state.adminSession?.access_token) return;
  try {
    const q = "?select=id,combo_id,name,combo_payload,created_at&order=created_at.desc&limit=200";
    state.adminPublishedCombos = await supabaseSelect("published_combos", q, state.adminSession.access_token);
    renderAdminPublishedCombos();
  } catch (err) {
    const list = document.getElementById("admin-published-list");
    if (list) list.innerHTML = `<div class="empty" style="color:#c14545">已发布组合加载失败：${htmlText(err.message || err)}</div>`;
  }
}

function renderAdminPublishedCombos() {
  const list = document.getElementById("admin-published-list");
  if (!list) return;
  if (!state.adminSession?.access_token) {
    list.innerHTML = `<div class="empty">登录后显示已发布组合</div>`;
    return;
  }
  if (!state.adminPublishedCombos.length) {
    list.innerHTML = `<div class="empty">暂无 Supabase 已发布组合</div>`;
    return;
  }
  list.innerHTML = state.adminPublishedCombos.map(row => {
    const payload = row.combo_payload || {};
    const created = row.created_at ? new Date(row.created_at).toLocaleString() : "";
    const combo = payload.factors ? validatePublishedCombo(payload, 0, new Set(state.catalog.map(f => f.code))) : null;
    const title = payload.name || row.name || row.combo_id;
    return `<div class="admin-published-card" data-id="${htmlAttr(row.id)}">
      <div>
        <b>${htmlText(title)}</b>
        <span class="published-n">top${htmlText(payload.N || "?")}</span>
        <div class="admin-request-meta">${htmlText(created)}</div>
        <div class="published-summary">${combo ? htmlText(comboSummary(combo)) : "无组合配置"}</div>
      </div>
      <button class="cpsn-btn admin-published-delete" data-id="${htmlAttr(row.id)}" data-name="${htmlAttr(title)}">删除</button>
    </div>`;
  }).join("");
  list.querySelectorAll(".admin-published-delete").forEach(btn => {
    btn.onclick = () => deletePublishedComboByAdmin(btn.dataset.id, btn.dataset.name)
      .catch(e => console.error("delete published combo failed:", e));
  });
}

function renderAdminRequests() {
  const list = document.getElementById("admin-request-list");
  if (!list) return;
  if (!state.adminSession?.access_token) {
    list.innerHTML = `<div class="empty">登录后显示待审核申请</div>`;
    return;
  }
  if (!state.adminRequests.length) {
    list.innerHTML = `<div class="empty">暂无申请</div>`;
    return;
  }
  list.innerHTML = state.adminRequests.map(req => {
    const payload = req.combo_payload || {};
    const isDelete = req.request_type === "delete";
    const pending = req.status === "pending";
    const statusText = req.status === "approved" ? "已同意" : (req.status === "rejected" ? "已拒绝" : "待审核");
    const created = req.created_at ? new Date(req.created_at).toLocaleString() : "";
    const validated = payload.factors ? validatePublishedCombo(payload, 0, new Set(state.catalog.map(f => f.code))) : null;
    const summary = validated ? comboSummary(validated) : `目标组合：${req.combo_name || req.combo_id}`;
    return `<div class="admin-request-card ${pending ? "" : "reviewed"}" data-id="${htmlAttr(req.id)}">
      <div class="admin-request-head">
        <div>
          <div class="admin-request-kind">${isDelete ? "申请删除" : "申请发布"}</div>
          <b class="admin-request-title">${htmlText(payload.name || req.combo_name || "未命名组合")}</b>
          <span class="published-n">top${htmlText(payload.N || "?")}</span>
          <div class="admin-request-meta">状态：${htmlText(statusText)} · ${htmlText(created)}</div>
          <div class="published-summary">${htmlText(summary)}</div>
        </div>
        <div class="admin-request-actions">
          <button class="cpsn-btn admin-approve" data-id="${htmlAttr(req.id)}"${pending ? "" : " disabled"}>同意</button>
          <button class="cpsn-btn admin-reject" data-id="${htmlAttr(req.id)}"${pending ? "" : " disabled"}>拒绝</button>
        </div>
      </div>
      <pre class="admin-request-json">${htmlText(JSON.stringify(payload, null, 2))}</pre>
    </div>`;
  }).join("");
  list.querySelectorAll(".admin-approve").forEach(btn => {
    btn.onclick = () => approvePublishRequest(btn.dataset.id).catch(e => console.error("approve request failed:", e));
  });
  list.querySelectorAll(".admin-reject").forEach(btn => {
    btn.onclick = () => rejectPublishRequest(btn.dataset.id).catch(e => console.error("reject request failed:", e));
  });
}

function requestById(id) {
  return state.adminRequests.find(r => String(r.id) === String(id));
}

async function approvePublishRequest(id) {
  const req = requestById(id);
  if (!req || !state.adminSession?.access_token) return;
  if (req.request_type === "delete") {
    await approveDeleteRequest(req);
    return;
  }
  const payload = req.combo_payload;
  if (!payload || !Array.isArray(payload.factors) || !payload.factors.length) {
    alert("这个申请没有有效组合配置");
    return;
  }
  if (!confirm(`同意发布“${payload.name || req.combo_name}”？`)) return;
  setAdminStatus("正在发布…");
  try {
    await supabaseInsert("published_combos", [{
      combo_id: payload.id,
      name: payload.name,
      description: payload.description || "",
      combo_payload: payload,
      source_request_id: req.id,
    }], state.adminSession.access_token);
    await supabasePatch("combo_publish_requests", `?id=eq.${encodeURIComponent(req.id)}`, {
      status: "approved",
      reviewed_at: new Date().toISOString(),
    }, state.adminSession.access_token);
    await loadAdminRequests();
    await loadAdminPublishedCombos();
    await loadPublishedCombos();
    renderComboLibrary();
    setAdminStatus("已同意并发布");
  } catch (err) {
    setAdminStatus(`发布失败：${err.message || err}`, true);
  }
}

async function approveDeleteRequest(req) {
  const name = req.combo_payload?.name || req.combo_name || req.combo_id;
  if (!confirm(`同意删除“${name}”？`)) return;
  setAdminStatus("正在删除…");
  try {
    const targetId = req.target_published_id;
    const q = targetId
      ? `?id=eq.${encodeURIComponent(targetId)}`
      : `?combo_id=eq.${encodeURIComponent(req.combo_id)}`;
    await supabaseDelete("published_combos", q, state.adminSession.access_token);
    await supabasePatch("combo_publish_requests", `?id=eq.${encodeURIComponent(req.id)}`, {
      status: "approved",
      reviewed_at: new Date().toISOString(),
    }, state.adminSession.access_token);
    window.__lastApprovedDeleteRequestId = req.id;
    await loadAdminRequests();
    await loadAdminPublishedCombos();
    await loadPublishedCombos();
    renderComboLibrary();
    setAdminStatus("已同意并删除");
  } catch (err) {
    setAdminStatus(`删除失败：${err.message || err}`, true);
  }
}

async function deletePublishedComboByAdmin(id, name) {
  if (!state.adminSession?.access_token || !id) return;
  if (!confirm(`删除已发布组合“${name || id}”？`)) return;
  setAdminStatus("正在删除已发布组合…");
  try {
    await supabaseDelete("published_combos", `?id=eq.${encodeURIComponent(id)}`, state.adminSession.access_token);
    window.__adminPublishedDeleteCount = (window.__adminPublishedDeleteCount || 0) + 1;
    await loadAdminPublishedCombos();
    await loadPublishedCombos();
    renderComboLibrary();
    setAdminStatus("已删除已发布组合");
  } catch (err) {
    setAdminStatus(`删除失败：${err.message || err}`, true);
  }
}

async function rejectPublishRequest(id) {
  const req = requestById(id);
  if (!req || !state.adminSession?.access_token) return;
  if (!confirm(`拒绝“${req.combo_payload?.name || req.combo_name}”？`)) return;
  setAdminStatus("正在拒绝…");
  try {
    await supabasePatch("combo_publish_requests", `?id=eq.${encodeURIComponent(req.id)}`, {
      status: "rejected",
      reviewed_at: new Date().toISOString(),
    }, state.adminSession.access_token);
    await loadAdminRequests();
    setAdminStatus("已拒绝");
  } catch (err) {
    setAdminStatus(`拒绝失败：${err.message || err}`, true);
  }
}

function currentComboPublishPayload() {
  const name = state.composeFactors.length
    ? "自定义组合"
    : "未命名组合";
  return {
    id: `custom-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`,
    name,
    description: "",
    N: state.composeN,
    constraintMode: normalizeConstraintMode(state.composeConstraintMode),
    factors: cloneComposeFactors(state.composeFactors),
    tags: [],
    created_at: new Date().toISOString().slice(0, 10),
  };
}

function comboPublishPayload(combo) {
  return {
    id: combo.id,
    name: combo.name,
    description: combo.description || "",
    N: combo.N,
    constraintMode: normalizeConstraintMode(combo.constraintMode),
    factors: cloneComposeFactors(combo.factors),
    tags: combo.tags || [],
    created_at: combo.created_at || new Date().toISOString().slice(0, 10),
  };
}

function comboPublishRequestText(payload) {
  const factorLines = cloneComposeFactors(payload.factors).map(f => {
    const meta = state.catalog.find(x => x.code === f.code);
    const thr = f.thr === null ? "不过滤" : `过滤：得分 ${f.op} ${f.thr}`;
    return `- ${f.code}${meta?.name_cn ? `（${meta.name_cn}）` : ""}：方向 ${sideLabel(f.side)}，口径 ${scoreModeLabel(f.scoreMode)}，权重 ${f.weight}，${thr}`;
  }).join("\n");
  return [
    "申请发布组合",
    "",
    "请发给管理员审核。审核通过后，管理员会发布到全站组合库，其他人打开页面也能看到。",
    "",
    `组合名称：${payload.name}`,
    `选股数：top${payload.N}`,
    `组合约束：${constraintModeLabel(payload.constraintMode)}`,
    "因子：",
    factorLines,
    "",
    "发布配置(JSON)：",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function currentComboPublishRequestText() {
  return comboPublishRequestText(currentComboPublishPayload());
}

async function copyTextWithFallback(text, promptTitle) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else prompt(promptTitle, text);
}

async function submitPublishRequest(payload, submitter = {}) {
  const row = {
    request_type: "publish",
    combo_id: payload.id,
    combo_name: payload.name,
    combo_payload: payload,
    status: "pending",
  };
  return supabaseInsertMinimal("combo_publish_requests", [row]);
}

async function submitDeleteRequest(combo) {
  const row = {
    request_type: "delete",
    combo_id: combo.remote_combo_id || combo.id,
    combo_name: combo.name,
    combo_payload: comboPublishPayload(combo),
    target_published_id: combo.published_id || null,
    status: "pending",
  };
  return supabaseInsertMinimal("combo_publish_requests", [row]);
}

async function submitPublishRequestFromButton(payload, btn) {
  const old = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "提交中…";
  }
  try {
    await submitPublishRequest(payload);
    window.__lastPublishRequestPayload = payload;
    if (btn) btn.textContent = "已提交申请";
    alert("申请已提交，等待管理员审核。审核通过后会出现在已发布组合。");
  } catch (err) {
    console.error("submit publish request failed:", err);
    alert(`提交失败：${err.message || err}`);
    if (btn) btn.textContent = old;
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = old || "申请发布";
      }, 1400);
    }
  }
}

async function submitDeleteRequestForPublished(id, btn) {
  const combo = state.publishedCombos.find(c => c.id === id && c.valid && c.source === "supabase");
  if (!combo) {
    alert("这个组合不是线上发布组合，不能申请删除");
    return;
  }
  if (!confirm(`申请删除“${combo.name}”？管理员同意后会从全站组合库移除。`)) return;
  const old = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "提交中…";
  }
  try {
    await submitDeleteRequest(combo);
    window.__lastDeleteRequestPayload = comboPublishPayload(combo);
    if (btn) btn.textContent = "已申请删除";
    alert("删除申请已提交，等待管理员审核。");
  } catch (err) {
    console.error("submit delete request failed:", err);
    alert(`提交失败：${err.message || err}`);
    if (btn) btn.textContent = old;
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = old || "申请删除";
      }, 1400);
    }
  }
}

async function copyPublishRequest() {
  if (!state.composeFactors.length) {
    alert("先选至少一个因子并设好权重，再申请发布组合");
    return;
  }
  const btn = document.getElementById("cps-copy-json");
  await submitPublishRequestFromButton(currentComboPublishPayload(), btn);
}

async function copyMyComboPublishRequest(id, btn) {
  const combo = state.myCombos.find(c => c.id === id && c.valid);
  if (!combo) {
    alert("这个组合配置无效，不能申请发布");
    return;
  }
  await submitPublishRequestFromButton(comboPublishPayload(combo), btn);
}

function renderComposeSoon(delay = 80) {
  _composeRenderSeq++;
  clearTimeout(renderComposeSoon._timer);
  renderComposeSoon._timer = setTimeout(() => {
    renderComposeSoon._timer = null;
    renderCompose();
  }, delay);
}

function renderComposeControls() {
  const box = document.getElementById("cps-controls");
  if (state.composeFactors.length === 0) { box.innerHTML = `<div class="empty">未选因子</div>`; return; }
  const wsum = state.composeFactors.reduce((s, f) => s + Math.abs(f.weight), 0) || 1;
  const constraint = normalizeConstraintMode(state.composeConstraintMode);
  const neutralDisabled = hasComposeNeutralScores() ? "" : " disabled";
  const neutralNotice = hasComposeNeutralScores()
    ? ""
    : `<div style="margin:0 0 8px 0;color:#8a5a00;font-size:11px">${composeNeutralUnavailableMessage()}</div>`;
  const constraintBtns = `
    <div style="margin:0 0 8px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="color:#666;font-size:11px">组合约束：</span>
      <button id="cps-constraint-none" class="cpsn-btn cps-constraint-btn${constraint === "none" ? " active" : ""}" data-mode="none">无约束等权</button>
      <button id="cps-constraint-industry" class="cpsn-btn cps-constraint-btn${constraint === "industry" ? " active" : ""}" data-mode="industry">行业中性</button>
      <span style="color:#888;font-size:11px">先按合成分数选股，再按申万一级行业目标权重配权</span>
    </div>`;
  box.innerHTML = constraintBtns + neutralNotice + state.composeFactors.map((raw, i) => {
    const f = normalizeComposeFactor(raw);
    state.composeFactors[i] = f;
    const pctw = (f.weight / wsum * 100).toFixed(0);
    return `<div class="cps-frow" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
      <span style="width:10px;height:10px;border-radius:50%;background:${STRAT_COLORS[i % STRAT_COLORS.length]};display:inline-block"></span>
      <b style="font-size:12px;min-width:72px">${f.code}</b>
      <select class="cps-side" data-idx="${i}" style="font-size:12px;padding:2px;border:1px solid #ccc;border-radius:3px">
        <option value="1"${normalizeSide(f.side) === 1 ? " selected" : ""}>默认</option>
        <option value="-1"${normalizeSide(f.side) === -1 ? " selected" : ""}>反向</option>
      </select>
      <select class="cps-score-mode" data-idx="${i}" style="font-size:12px;padding:2px;border:1px solid #ccc;border-radius:3px">
        <option value="raw"${normalizeScoreMode(f.scoreMode) === "raw" ? " selected" : ""}>原始口径</option>
        <option value="neutral"${normalizeScoreMode(f.scoreMode) === "neutral" ? " selected" : ""}${neutralDisabled}>行业市值中性</option>
      </select>
      <span style="color:#888;font-size:11px">权重</span>
      <input class="cps-w-input" data-idx="${i}" type="number" step="0.1" value="${f.weight}"
             style="width:50px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:12px" />
      <span style="color:#888;font-size:11px">(${pctw}%)</span>
      <span style="color:#bbb">|</span>
      <span style="color:#888;font-size:11px">过滤 得分</span>
      <select class="cps-op" data-idx="${i}" style="font-size:12px;padding:2px;border:1px solid #ccc;border-radius:3px">
        <option value=">="${f.op === ">=" ? " selected" : ""}>≥</option>
        <option value="<="${f.op === "<=" ? " selected" : ""}>≤</option>
      </select>
      <input class="cps-thr" data-idx="${i}" type="number" step="0.5" placeholder="不限"
             value="${f.thr === null ? "" : f.thr}"
             style="width:54px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:12px" />
      <span class="cps-remove" data-idx="${i}" style="cursor:pointer;color:#c14545;font-size:13px;padding:0 4px">×</span>
    </div>`;
  }).join("");
  box.querySelectorAll(".cps-w-input").forEach(inp => {
    inp.addEventListener("change", () => {
      const f = state.composeFactors[parseInt(inp.dataset.idx, 10)];
      if (!f) return;
      const w = parseFloat(inp.value);
      if (!Number.isFinite(w)) { inp.value = f.weight; return; }
      f.weight = w; renderComposeSoon();
    });
  });
  box.querySelectorAll(".cps-side").forEach(sel => {
    sel.onchange = () => {
      const f = state.composeFactors[parseInt(sel.dataset.idx, 10)];
      if (!f) return;
      f.side = normalizeSide(sel.value);
      clearComposeOptimization();
      renderComposeSoon();
    };
  });
  box.querySelectorAll(".cps-score-mode").forEach(sel => {
    sel.onchange = () => {
      const f = state.composeFactors[parseInt(sel.dataset.idx, 10)];
      if (!f) return;
      f.scoreMode = normalizeScoreMode(sel.value);
      clearComposeOptimization();
      renderComposeSoon();
    };
  });
  box.querySelectorAll(".cps-constraint-btn").forEach(btn => {
    btn.onclick = () => {
      const next = normalizeConstraintMode(btn.dataset.mode);
      if (state.composeConstraintMode === next) return;
      state.composeConstraintMode = next;
      clearComposeOptimization();
      renderComposeSoon();
    };
  });
  box.querySelectorAll(".cps-op").forEach(sel => sel.onchange = () => {
    state.composeFactors[parseInt(sel.dataset.idx, 10)].op = sel.value;
    if (state.composeFactors[parseInt(sel.dataset.idx, 10)].thr !== null) renderComposeSoon();
  });
  box.querySelectorAll(".cps-thr").forEach(inp => {
    inp.addEventListener("change", () => {
      const f = state.composeFactors[parseInt(inp.dataset.idx, 10)];
      if (!f) return;
      const v = inp.value.trim();
      f.thr = v === "" ? null : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
      renderComposeSoon();
    });
  });
  box.querySelectorAll(".cps-remove").forEach(x => {
    x.onclick = () => removeComposeAt(parseInt(x.dataset.idx, 10));
  });
}

let _composeLoadedOnce = false;
let _composeRenderSeq = 0;

function isComposeRenderStale(seq) {
  return seq !== _composeRenderSeq;
}

async function renderCompose() {
  const renderSeq = ++_composeRenderSeq;
  document.getElementById("cps-selected").textContent =
    state.composeFactors.length ? `（已选 ${state.composeFactors.length} 个因子）` : "";
  await initComposeRangeControls();
  if (isComposeRenderStale(renderSeq)) return;
  renderComposeControls();
  renderSavedCombos();
  // 首次进入合成需按选中因子加载历史分片，给明确提示（避免误以为卡死）。
  if (!_composeLoadedOnce && state.composeFactors.length > 0) {
    document.getElementById("cps-stocks").innerHTML =
      `<h3>合成 Top 股票</h3><div class="empty">首次加载所选因子的历史数据，请稍候…</div>`;
  }
  try {
    await ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: false });
    if (isComposeRenderStale(renderSeq)) return;
    await ensureComposeData();   // 懒加载合成专用大表
    if (isComposeRenderStale(renderSeq)) return;
    _composeLoadedOnce = true;
    if (!state.hasComposeData) {
      document.getElementById("cps-stocks").innerHTML =
        `<h3>合成 Top 股票</h3><div class="empty">合成数据未生成（需跑 scripts/09_export_compose_data.py）</div>`;
      return;
    }
    // 注：暂存组合对比只在「暂存/删除/改名」时更新（各自调用 renderComboCompare），
    // 不在每次 renderCompose 重画，避免切因子/改权重时对比图频繁 dispose+重画闪烁。
    if (state.composeFactors.length === 0) {
      await ensureComposeBase();   // 清掉缓存窄表
      document.getElementById("cps-stocks").innerHTML = `<h3>合成 Top 股票</h3><div class="empty">选因子后显示</div>`;
      document.getElementById("cps-kpi").innerHTML = `<div class="empty">选因子后显示</div>`;
      if (cpsNavChart) { cpsNavChart.dispose(); cpsNavChart = null; }
      document.getElementById("cps-nav-chart").innerHTML = "";
      renderComposeIcDecayUnavailable("选因子后显示");
      renderComposeValidationUnavailable("选因子后显示");
      return;
    }
    await ensureComposeBase();   // 因子集变了才重建窄表；权重/阈值/N 变则复用缓存
    if (isComposeRenderStale(renderSeq)) return;
    await Promise.all([
      renderComposeStocks(renderSeq),
      renderComposeBacktest(renderSeq),
      renderComposeIcDecay(renderSeq),
      renderComposeValidation(renderSeq),
    ]);
  } catch (err) {
    if (isComposeRenderStale(renderSeq)) return;
    console.error("renderCompose failed:", err);
    document.getElementById("cps-stocks").innerHTML =
      `<pre style="color:#c00;white-space:pre-wrap;font-size:11px">合成失败：${err.message || err}\n\n${err.stack || ""}</pre>`;
  }
}

async function renderComposeStocks(renderSeq) {
  if (isComposeRenderStale(renderSeq) || state.composeFactors.length === 0) return;
  const target = document.getElementById("cps-stocks");
  const metaMap = await ensureStockMetaSnapshot();
  if (isComposeRenderStale(renderSeq)) return;
  const scoreExpr = matrixScoreSql(state.composeFactors);
  const condSql = matrixCondSql(state.composeFactors);
  if (scoreExpr === null || condSql === null) return;
  const constraint = normalizeConstraintMode(state.composeConstraintMode);
  const candidateLimit = constraint === "industry"
    ? Math.max(900, state.composeN * 30)
    : Math.min(Math.max(state.composeN + 180, state.composeN * 4), 700);
  const res = await state.db.query(`
    SELECT stock_code,
           ROUND(${scoreExpr}, 6) AS comp_score,
           CAST(trade_date AS VARCHAR) AS dt
    FROM cps_latest_matrix
    WHERE TRUE ${condSql}
    ORDER BY comp_score DESC, stock_code
    LIMIT ${candidateLimit}
  `);
  if (isComposeRenderStale(renderSeq)) return;
  const candidateRows = res.toArray()
    .map(r => ({ ...r, meta: metaMap.get(r.stock_code) }))
    .filter(r => r.meta && !r.meta.is_st && r.meta.is_active_latest)
    .map(r => ({
      ...r,
      cs: Number(r.comp_score),
      name: r.meta.name,
      industry_sw1: r.meta.industry_sw1,
      industry_sw2: r.meta.industry_sw2,
      market_cap: r.meta.market_cap,
      pe: r.meta.pe,
      pb: r.meta.pb,
      avg_amount: r.meta.avg_amount,
    }));
  const rows = (constraint === "industry"
    ? industryNeutralPickRows(candidateRows, state.composeN)
    : candidateRows.slice(0, state.composeN));
  const condDesc = state.composeFactors.filter(f => f.thr !== null && Number.isFinite(f.thr))
    .map(f => `${factorParamName(f.code, f.side, f.scoreMode)}得分${f.op}${f.thr}`).join(" 且 ");
  if (rows.length === 0) {
    target.innerHTML = `<h3>合成 Top 股票</h3><div class="empty">无股票满足条件${condDesc ? "：" + condDesc : ""}（过滤可能过严，放宽阈值）</div>`;
    return;
  }
  const dt = rows[0].dt;
  const wdesc = state.composeFactors.map(f => `${factorParamName(f.code, f.side, f.scoreMode)}×${f.weight}`).join(" + ");
  const fmt = (v, dp = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(dp));
  const fmtMV = (v) => (v === null || v === undefined ? "—" : (Number(v) / 1e4).toFixed(0));
  let html = `<h3>合成 Top ${state.composeN} 股票（当前仍在市成分展示，截面日 ${dt}）<span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
    <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">合成得分 = ${wdesc}（高斯秩标准化分数加权和）${condDesc ? "；过滤：" + condDesc : ""}；组合约束：${constraintModeLabel(constraint)}（当前展示剔除 ST/停牌/非 active 股票；历史回测不按最新 active 过滤）</p>
    <table class="stock-table"><thead><tr>
      <th>#</th><th>代码</th><th>名称</th><th>申万一级</th><th>市值(亿)</th><th>PE</th><th>PB</th>${constraint === "industry" ? "<th>权重</th>" : ""}<th>合成得分</th>
    </tr></thead><tbody>`;
  rows.forEach((r, i) => {
    html += `<tr class="stock-row" data-stock="${r.stock_code}" data-name="${r.name || ""}" title="点击看该股各因子打分（为什么入选）"><td>${i + 1}</td><td>${r.stock_code}</td><td>${r.name || ""}</td>
      <td>${r.industry_sw1 || "—"}</td><td>${fmtMV(r.market_cap)}</td>
      <td>${fmt(r.pe, 1)}</td><td>${fmt(r.pb, 2)}</td>${constraint === "industry" ? `<td>${pctText(Number(r.weight))}</td>` : ""}<td>${fmt(r.comp_score, 3)}</td></tr>`;
  });
  target.innerHTML = html + "</tbody></table>";
}

async function renderComposeBacktest(renderSeq) {
  if (isComposeRenderStale(renderSeq) || state.composeFactors.length === 0) return;
  const constraint = normalizeConstraintMode(state.composeConstraintMode);
  document.getElementById("cps-nav-title").textContent =
    `合成组合净值（top-${state.composeN}，${constraintModeLabel(constraint)}，${constraintHoldText(constraint)}，单边 0.2%，按换手扣成本，起点=1.0；${composeRangeLabel()}）`;
  const key = composeConfigKey(state.composeFactors, state.composeN, constraint);
  const fullBt = await comboBacktest(state.composeFactors, state.composeN, "cps_matrix", constraint);
  if (isComposeRenderStale(renderSeq)) return;
  _latestComposeBtKey = key;
  _latestComposeBt = cloneBacktest(fullBt);
  rememberComposeBacktest(key, fullBt);
  const bt = sliceBacktestByRange(fullBt, state.composeStart, state.composeEnd);
  const { x, navArr, retArr } = bt;

  // 画净值 + 基准
  const div = document.getElementById("cps-nav-chart");
  if (cpsNavChart) { cpsNavChart.dispose(); cpsNavChart = null; }
  div.innerHTML = "";
  const series = [{ name: "合成组合", type: "line", symbol: "none", data: navArr,
                    color: "#1a4d80", lineStyle: { width: 2 } }];
  if (x.length) {
    const bm = await ensureBenchmarkSnapshot();
    if (isComposeRenderStale(renderSeq)) return;
    const colors = { HS300: "#c14545", CSI800: "#6e9a4f", CSI500: "#c89c2b" };
    const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
    for (const idx of ["HS300", "CSI800", "CSI500"]) {
      const aligned = benchmarkSeries(bm, x.map(monthOfLabel), idx);
      const b = aligned.find(v => v !== null);
      series.push({ name: `${cn[idx]}(基准)`, type: "line", symbol: "none", connectNulls: true,
        data: b ? aligned.map(v => v === null ? null : v / b) : aligned,
        color: colors[idx], lineStyle: { width: 1.2, type: "dashed" } });
    }
  }
  cpsNavChart = echarts.init(div);
  cpsNavChart.setOption({
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: "axis" }, legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 32 },
    xAxis: { type: "category", data: x, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", scale: true }, series,
  });

  // KPI（合成组合行 + 三基准行）
  const m = computeMetrics(retArr, navArr);
  if (isComposeRenderStale(renderSeq)) return;
  const kdiv = document.getElementById("cps-kpi");
  if (!m) { kdiv.innerHTML = `<div class="empty">数据不足</div>`; return; }
  const pct = v => (v * 100).toFixed(1) + "%";
  const signed = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
  const bmSnapForKpi = await ensureBenchmarkSnapshot();
  if (isComposeRenderStale(renderSeq)) return;
  const bg = benchmarkMetrics(bmSnapForKpi, state.composeStart, state.composeEnd);
  const ex300 = bg.HS300 ? signed(m.annual - bg.HS300.annual) : "—";
  const ex800 = bg.CSI800 ? signed(m.annual - bg.CSI800.annual) : "—";
  let krows = `<tr><td><b>合成组合</b></td><td>${pct(m.annual)}</td><td>${pct(m.vol)}</td><td>${numText(m.sharpe, 2)}</td><td>${pct(m.mdd)}</td>
      <td>${(m.winRate*100).toFixed(0)}%</td><td>${ex300}</td><td>${ex800}</td></tr>`;
  // 三基准行（绝对指标）
  {
    const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
    for (const idx of ["HS300", "CSI800", "CSI500"]) {
      const bm = bg[idx]; if (!bm) continue;
      krows += `<tr style="color:#888;border-top:2px solid #ddd">
        <td style="color:#888">${cn[idx]}</td><td>${pct(bm.annual)}</td><td>${pct(bm.vol)}</td><td>${numText(bm.sharpe, 2)}</td>
        <td>${pct(bm.mdd)}</td><td>${(bm.winRate*100).toFixed(0)}%</td><td>—</td><td>—</td></tr>`;
    }
  }
  kdiv.innerHTML = `<table class="kpi-table">
    <thead><tr><th>组合 / 基准</th><th>年化收益</th><th>年化波动率</th><th>夏普</th><th>最大回撤</th><th>月度胜率</th><th>超额vs300</th><th>超额vs800</th></tr></thead>
    <tbody>${krows}</tbody></table>`;
}

function renderComposeIcDecayUnavailable(message) {
  const chartDiv = document.getElementById("cps-ic-decay-chart");
  const tableDiv = document.getElementById("cps-ic-decay-table");
  if (cpsIcDecayChart) { cpsIcDecayChart.dispose(); cpsIcDecayChart = null; }
  if (chartDiv) chartDiv.innerHTML = `<div class="empty">${message}</div>`;
  if (tableDiv) tableDiv.innerHTML = "";
}

function composeIcDecaySql(factors = state.composeFactors, startMonth = state.composeStart, endMonth = state.composeEnd) {
  const scoreExpr = matrixScoreSql(factors);
  const condSql = matrixCondSql(factors);
  if (!scoreExpr || condSql === null) return null;
  const rangeConds = [];
  if (startMonth) rangeConds.push(`strftime(m.trade_date, '%Y-%m') >= '${startMonth}'`);
  if (endMonth) rangeConds.push(`strftime(m.trade_date, '%Y-%m') <= '${endMonth}'`);
  const rangeSql = rangeConds.length ? `AND ${rangeConds.join(" AND ")}` : "";
  return `
    WITH ret_base AS (
      SELECT trade_date,
             ANY_VALUE(return_date) AS return_date,
             stock_code,
             CAST(strftime(trade_date, '%Y') AS INTEGER) * 12 + CAST(strftime(trade_date, '%m') AS INTEGER) AS month_id,
             CAST(strftime(ANY_VALUE(return_date), '%Y') AS INTEGER) * 12 + CAST(strftime(ANY_VALUE(return_date), '%m') AS INTEGER) AS return_month_id,
             ANY_VALUE(fwd_return) AS r1
      FROM cps_matrix
      WHERE fwd_return > ${MIN_VALID_FORWARD_RETURN} AND fwd_return < ${MAX_VALID_FORWARD_RETURN}
      GROUP BY trade_date, stock_code
    ),
    score_base AS (
      SELECT m.trade_date,
             m.stock_code,
             CAST(strftime(m.trade_date, '%Y') AS INTEGER) * 12 + CAST(strftime(m.trade_date, '%m') AS INTEGER) AS month_id,
             ROUND(${scoreExpr}, 6) AS cs
      FROM cps_matrix m
      WHERE (${scoreExpr}) IS NOT NULL ${condSql || ""} ${rangeSql}
    ),
    horizon_returns AS (
      SELECT b1.trade_date, b1.stock_code, 1 AS h, b1.r1 AS fwd_return, b1.return_date
      FROM ret_base b1
      WHERE b1.return_month_id = b1.month_id + 1
      UNION ALL
      SELECT b1.trade_date, b1.stock_code, 3 AS h, (1+b1.r1)*(1+b2.r1)*(1+b3.r1)-1 AS fwd_return, b3.return_date
      FROM ret_base b1
      JOIN ret_base b2 ON b2.stock_code = b1.stock_code AND b2.month_id = b1.month_id + 1
      JOIN ret_base b3 ON b3.stock_code = b1.stock_code AND b3.month_id = b1.month_id + 2 AND b3.return_month_id = b1.month_id + 3
      UNION ALL
      SELECT b1.trade_date, b1.stock_code, 6 AS h,
             (1+b1.r1)*(1+b2.r1)*(1+b3.r1)*(1+b4.r1)*(1+b5.r1)*(1+b6.r1)-1 AS fwd_return,
             b6.return_date
      FROM ret_base b1
      JOIN ret_base b2 ON b2.stock_code = b1.stock_code AND b2.month_id = b1.month_id + 1
      JOIN ret_base b3 ON b3.stock_code = b1.stock_code AND b3.month_id = b1.month_id + 2
      JOIN ret_base b4 ON b4.stock_code = b1.stock_code AND b4.month_id = b1.month_id + 3
      JOIN ret_base b5 ON b5.stock_code = b1.stock_code AND b5.month_id = b1.month_id + 4
      JOIN ret_base b6 ON b6.stock_code = b1.stock_code AND b6.month_id = b1.month_id + 5 AND b6.return_month_id = b1.month_id + 6
      UNION ALL
      SELECT b1.trade_date, b1.stock_code, 12 AS h,
             (1+b1.r1)*(1+b2.r1)*(1+b3.r1)*(1+b4.r1)*(1+b5.r1)*(1+b6.r1)*
             (1+b7.r1)*(1+b8.r1)*(1+b9.r1)*(1+b10.r1)*(1+b11.r1)*(1+b12.r1)-1 AS fwd_return,
             b12.return_date
      FROM ret_base b1
      JOIN ret_base b2 ON b2.stock_code = b1.stock_code AND b2.month_id = b1.month_id + 1
      JOIN ret_base b3 ON b3.stock_code = b1.stock_code AND b3.month_id = b1.month_id + 2
      JOIN ret_base b4 ON b4.stock_code = b1.stock_code AND b4.month_id = b1.month_id + 3
      JOIN ret_base b5 ON b5.stock_code = b1.stock_code AND b5.month_id = b1.month_id + 4
      JOIN ret_base b6 ON b6.stock_code = b1.stock_code AND b6.month_id = b1.month_id + 5
      JOIN ret_base b7 ON b7.stock_code = b1.stock_code AND b7.month_id = b1.month_id + 6
      JOIN ret_base b8 ON b8.stock_code = b1.stock_code AND b8.month_id = b1.month_id + 7
      JOIN ret_base b9 ON b9.stock_code = b1.stock_code AND b9.month_id = b1.month_id + 8
      JOIN ret_base b10 ON b10.stock_code = b1.stock_code AND b10.month_id = b1.month_id + 9
      JOIN ret_base b11 ON b11.stock_code = b1.stock_code AND b11.month_id = b1.month_id + 10
      JOIN ret_base b12 ON b12.stock_code = b1.stock_code AND b12.month_id = b1.month_id + 11 AND b12.return_month_id = b1.month_id + 12
    ),
    joined AS (
      SELECT s.trade_date, s.stock_code, s.cs, h, fwd_return, return_date
      FROM score_base s
      JOIN horizon_returns r ON s.trade_date = r.trade_date AND s.stock_code = r.stock_code
      WHERE fwd_return > ${MIN_VALID_FORWARD_RETURN} AND fwd_return < ${MAX_VALID_FORWARD_RETURN}
    ),
    ranked_positions AS (
      SELECT trade_date, h, cs, fwd_return,
             ROW_NUMBER() OVER (PARTITION BY trade_date, h ORDER BY cs) AS score_pos,
             ROW_NUMBER() OVER (PARTITION BY trade_date, h ORDER BY fwd_return) AS return_pos
      FROM joined
    ),
    ranked AS (
      SELECT trade_date, h, cs, fwd_return,
             AVG(score_pos) OVER (PARTITION BY trade_date, h, cs) AS score_rank,
             AVG(return_pos) OVER (PARTITION BY trade_date, h, fwd_return) AS return_rank
      FROM ranked_positions
    ),
    monthly AS (
      SELECT strftime(trade_date, '%Y-%m') AS month, h,
             corr(score_rank, return_rank) AS rank_ic,
             COUNT(*) AS n
      FROM ranked
      GROUP BY trade_date, h
      HAVING COUNT(*) >= 30
    )
    SELECT month, h, rank_ic, n FROM monthly ORDER BY h, month
  `;
}

async function comboIcDecay(factors = state.composeFactors, startMonth = state.composeStart, endMonth = state.composeEnd) {
  const cacheKey = composeScoreConfigKey(factors, startMonth, endMonth);
  if (_composeIcDecayCache.has(cacheKey)) return _composeIcDecayCache.get(cacheKey);
  if (_composeIcDecayBuilds.has(cacheKey)) return _composeIcDecayBuilds.get(cacheKey);
  const build = (async () => {
    const sql = composeIcDecaySql(factors, startMonth, endMonth);
    if (!sql) return { horizons: [1, 3, 6, 12], stats: [], series: {} };
    const res = await state.db.query(sql);
    const rows = res.toArray();
    const horizons = [1, 3, 6, 12];
    const series = {};
    const stats = horizons.map(h => {
      const vals = rows
        .filter(r => Number(r.h) === h && r.rank_ic !== null && Number.isFinite(Number(r.rank_ic)))
        .map(r => Number(r.rank_ic));
      series[String(h)] = rows
        .filter(r => Number(r.h) === h)
        .map(r => ({ month: r.month, rank_ic: Number(r.rank_ic), n: Number(r.n) || 0 }));
      const stats = rankIcStatsFromSeries(series[String(h)], h);
      return { h, mean: stats.mean, ir: stats.ir, n: stats.n };
    });
    return { horizons, stats, series };
  })();
  _composeIcDecayBuilds.set(cacheKey, build);
  try {
    const out = await build;
    _composeIcDecayCache.set(cacheKey, out);
    while (_composeIcDecayCache.size > 12) _composeIcDecayCache.delete(_composeIcDecayCache.keys().next().value);
    return out;
  } finally {
    _composeIcDecayBuilds.delete(cacheKey);
  }
}

async function renderComposeIcDecay(renderSeq) {
  if (isComposeRenderStale(renderSeq) || state.composeFactors.length === 0) return;
  const chartDiv = document.getElementById("cps-ic-decay-chart");
  const tableDiv = document.getElementById("cps-ic-decay-table");
  if (!chartDiv || !tableDiv) return;
  const rng = composeRangeLabel();
  document.getElementById("cps-ic-decay-title").textContent =
    `合成分数 IC 衰减 / 多前瞻期（${rng}；按当前方向、权重、口径和阈值）`;
  const payload = await comboIcDecay(state.composeFactors, state.composeStart, state.composeEnd);
  if (isComposeRenderStale(renderSeq)) return;
  const stats = payload.stats || [];
  const hasData = stats.some(s => s.mean !== null && Number.isFinite(Number(s.mean)));
  if (!hasData) {
    renderComposeIcDecayUnavailable("所选组合没有足够的多前瞻期 IC 数据");
    return;
  }
  if (cpsIcDecayChart) { cpsIcDecayChart.dispose(); cpsIcDecayChart = null; }
  chartDiv.innerHTML = "";
  cpsIcDecayChart = echarts.init(chartDiv);
  cpsIcDecayChart.setOption({
    grid: { left: 54, right: 54, top: 34, bottom: 32 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: "category", data: stats.map(s => `${s.h}M`), axisLabel: { fontSize: 11 } },
    yAxis: [
      { type: "value", name: "RankIC", scale: true },
      { type: "value", name: "IC_IR", scale: true },
    ],
    series: [
      {
        name: "RankIC均值",
        type: "bar",
        data: stats.map(s => s.mean == null ? null : +s.mean.toFixed(4)),
        itemStyle: { color: "#1a4d80" },
      },
      {
        name: "IC_IR",
        type: "line",
        yAxisIndex: 1,
        data: stats.map(s => s.ir == null ? null : +s.ir.toFixed(3)),
        symbol: "circle",
        lineStyle: { width: 2, color: "#e07b39" },
        itemStyle: { color: "#e07b39" },
      },
    ],
  });
  tableDiv.innerHTML = `
    <table class="kpi-table">
      <thead><tr><th>前瞻期</th><th>RankIC均值</th><th>IC_IR</th><th>样本月数</th></tr></thead>
      <tbody>${stats.map(s => `
        <tr><td>${s.h}个月</td><td>${numText(s.mean, 4)}</td><td>${numText(s.ir, 2)}</td><td>${s.n}</td></tr>
      `).join("")}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">这里衡量的是当前合成分数排序对未来 1/3/6/12 个月收益的预测力；行业中性约束只影响持仓，不改变合成分数 IC。</p>
  `;
}

function renderComposeValidationUnavailable(message) {
  const target = document.getElementById("combo-validation");
  if (comboGroup10Chart) { comboGroup10Chart.dispose(); comboGroup10Chart = null; }
  if (comboRolling36mChart) { comboRolling36mChart.dispose(); comboRolling36mChart = null; }
  if (target) target.innerHTML = `<div class="empty">${message}</div>`;
}

function rankIcStatsFromSeries(series, horizonMonths = 1) {
  const pairs = (series || [])
    .map(r => ({ month: String(r?.month || "").slice(0, 7), value: snapshotNumber(r?.rank_ic) }))
    .filter(r => r.month && r.value !== null);
  if (!pairs.length) return { mean: null, ir: null, winRate: null, n: 0 };
  const vals = pairs.map(r => r.value);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const winRate = vals.filter(v => v > 0).length / vals.length;
  if (vals.length < 2) return { mean, ir: null, winRate, n: vals.length };
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1));
  const scale = effectiveAnnualizationScale(pairs.map(r => r.month), horizonMonths);
  return { mean, ir: std > 0 && scale !== null ? mean / std * scale : null, winRate, n: vals.length };
}

function comboBacktestRowsForMonths(backtest) {
  if (!backtest || !Array.isArray(backtest.retArr)) return [];
  const hasStartAnchor = Array.isArray(backtest.x) && backtest.x.length === backtest.retArr.length + 1;
  return backtest.retArr.map((ret, i) => {
    const label = hasStartAnchor ? backtest.x[i + 1] : backtest.x?.[i];
    return {
      month: monthOfLabel(label),
      label,
      ret: snapshotNumber(ret),
    };
  }).filter(r => r.month && r.ret !== null);
}

function monthsWindowEnd(months, count) {
  if (!months.length) return null;
  return months[Math.max(0, months.length - count)];
}

function comboWindowStats(label, start, end, rankSeries, backtestRows) {
  const icRows = (rankSeries || []).filter(r => {
    const m = String(r.month || "").slice(0, 7);
    return (!start || m >= start) && (!end || m <= end);
  });
  const btRows = (backtestRows || []).filter(r => (!start || r.month >= start) && (!end || r.month <= end));
  const icStats = rankIcStatsFromSeries(icRows);
  const metrics = metricsFromReturns(btRows.map(r => r.ret));
  const icMonths = icStats.n;
  const btMonths = btRows.length;
  return {
    window_type: label,
    window_start: start || (icRows[0]?.month || btRows[0]?.month || null),
    window_end: end || (icRows[icRows.length - 1]?.month || btRows[btRows.length - 1]?.month || null),
    n_months: Math.max(icMonths, btMonths),
    ic_n_months: icMonths,
    bt_n_months: btMonths,
    rank_ic_mean: icStats.mean,
    rank_ic_ir: icStats.ir,
    rank_ic_win_rate: icStats.winRate,
    top30_ann_return: metrics?.annual ?? null,
    top30_sharpe: metrics?.sharpe ?? null,
    top30_max_drawdown: metrics?.mdd ?? null,
  };
}

function comboRollingValidation(rankIcSeries, backtest) {
  const cleanIc = (rankIcSeries || [])
    .map(r => ({ month: String(r.month || "").slice(0, 7), rank_ic: snapshotNumber(r.rank_ic), n: snapshotNumber(r.n) }))
    .filter(r => r.month && r.rank_ic !== null)
    .sort((a, b) => a.month.localeCompare(b.month));
  const btRows = comboBacktestRowsForMonths(backtest);
  const months = [...new Set(cleanIc.map(r => r.month))].sort();
  const last = months[months.length - 1] || null;
  const windows = [
    comboWindowStats("full", null, null, cleanIc, btRows),
    comboWindowStats("recent_5y", monthsWindowEnd(months, 60), last, cleanIc, btRows),
    comboWindowStats("recent_3y", monthsWindowEnd(months, 36), last, cleanIc, btRows),
    comboWindowStats("train", "2015-01", "2019-12", cleanIc, btRows),
    comboWindowStats("validation", "2020-01", "2022-12", cleanIc, btRows),
    comboWindowStats("test", "2023-01", last, cleanIc, btRows),
  ].filter(r => Number(r.n_months) > 0);
  const rolling_36m = [];
  if (cleanIc.length >= 36) {
    for (let i = 35; i < cleanIc.length; i++) {
      const slice = cleanIc.slice(i - 35, i + 1);
      const stats = rankIcStatsFromSeries(slice);
      rolling_36m.push({
        window_type: "rolling_36m",
        window_start: slice[0].month,
        window_end: slice[slice.length - 1].month,
        n_months: stats.n,
        rank_ic_mean: stats.mean,
        rank_ic_ir: stats.ir,
        rank_ic_win_rate: stats.winRate,
      });
    }
  }
  return { windows, rolling_36m };
}

function monotonicityFromReturns(values) {
  const arr = (values || []).map(v => snapshotNumber(v));
  if (arr.length < 2 || arr.some(v => v === null)) return null;
  const xs = arr.map((_, i) => i + 1);
  const rank = vals => {
    const sorted = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
    const out = Array(vals.length);
    for (let i = 0; i < sorted.length; i++) out[sorted[i].i] = i + 1;
    return out;
  };
  const rx = rank(xs), ry = rank(arr);
  const mx = rx.reduce((s, v) => s + v, 0) / rx.length;
  const my = ry.reduce((s, v) => s + v, 0) / ry.length;
  const cov = rx.reduce((s, v, i) => s + (v - mx) * (ry[i] - my), 0);
  const sx = Math.sqrt(rx.reduce((s, v) => s + (v - mx) ** 2, 0));
  const sy = Math.sqrt(ry.reduce((s, v) => s + (v - my) ** 2, 0));
  return sx > 0 && sy > 0 ? cov / (sx * sy) : null;
}

async function comboGroupValidation(factors, startMonth = null, endMonth = null) {
  const scoreExpr = matrixScoreSql(factors);
  const condSql = matrixCondSql(factors);
  if (!scoreExpr || condSql === null) return { groups: [], rows: [], monotonicity: null, ls: null };
  const rangeConds = [];
  if (startMonth) rangeConds.push(`strftime(trade_date, '%Y-%m') >= '${startMonth}'`);
  if (endMonth) rangeConds.push(`strftime(trade_date, '%Y-%m') <= '${endMonth}'`);
  const rangeSql = rangeConds.length ? `AND ${rangeConds.join(" AND ")}` : "";
  const res = await state.db.query(`
    WITH scored AS (
      SELECT trade_date, return_date, stock_code, fwd_return, ROUND(${scoreExpr}, 6) AS cs
      FROM cps_matrix
      WHERE (${scoreExpr}) IS NOT NULL ${condSql} ${rangeSql}
    ),
    ranked AS (
      SELECT trade_date, return_date, stock_code, fwd_return, cs,
             NTILE(10) OVER (PARTITION BY trade_date ORDER BY cs ASC, stock_code) AS grp
      FROM scored
    ),
    monthly AS (
      SELECT strftime(trade_date, '%Y-%m') AS signal_month,
             strftime(COALESCE(return_date, trade_date), '%Y-%m-%d') AS return_date,
             grp,
             AVG(${forwardReturnSql("fwd_return")}) AS port_ret,
             COUNT(*) AS n,
             COUNT(fwd_return) AS observed_return_count,
             SUM(CASE WHEN fwd_return IS NULL THEN 1 ELSE 0 END) AS missing_return_count
      FROM ranked
      GROUP BY trade_date, return_date, grp
      HAVING COUNT(*) >= 5
    )
    SELECT signal_month, return_date, grp, port_ret, n, observed_return_count, missing_return_count
    FROM monthly
    ORDER BY signal_month, grp
  `);
  const rows = res.toArray().map(r => ({
    signal_month: String(r.signal_month || "").slice(0, 7),
    return_date: String(r.return_date || ""),
    group: `G${Number(r.grp)}`,
    port_ret: snapshotNumber(r.port_ret),
    n: snapshotNumber(r.n),
    observed_return_count: snapshotNumber(r.observed_return_count),
    missing_return_count: snapshotNumber(r.missing_return_count),
  })).filter(r => r.port_ret !== null);
  const groups = Array.from({ length: 10 }, (_, i) => `G${i + 1}`);
  const groupStats = groups.map(g => {
    const rets = rows.filter(r => r.group === g).map(r => r.port_ret);
    const m = metricsFromReturns(rets);
    return { group: g, ann_return: m?.annual ?? null, sharpe: m?.sharpe ?? null, max_drawdown: m?.mdd ?? null, n_months: rets.length };
  });
  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.signal_month)) byMonth.set(r.signal_month, {});
    byMonth.get(r.signal_month)[r.group] = r.port_ret;
  }
  const lsReturns = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([_, g]) => (Number.isFinite(g.G10) && Number.isFinite(g.G1)) ? g.G10 - g.G1 : null)
    .filter(v => v !== null);
  return {
    groups,
    rows: groupStats,
    monotonicity: monotonicityFromReturns(groupStats.map(r => r.ann_return)),
    ls: metricsFromReturns(lsReturns),
    months: [...byMonth.keys()].sort(),
  };
}

function comboCorrelationTableChoice(factors) {
  const modes = new Set(cloneComposeFactors(factors).map(f => normalizeScoreMode(f.scoreMode)));
  const allNeutral = modes.size > 0 && modes.size === 1 && modes.has("neutral");
  return {
    table: allNeutral ? "factor_corr_neutral" : "factor_corr",
    mode: allNeutral ? "neutral" : (modes.size > 1 ? "mixed" : "raw"),
    mixed: modes.size > 1,
  };
}

async function comboCorrelationWarnings(factors) {
  const rows = [];
  const warnings = [];
  try {
    await ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: true });
    const choice = comboCorrelationTableChoice(factors);
    const useNeutral = choice.table === "factor_corr_neutral";
    const tableName = useNeutral && state.hasCorrNeutral ? "factor_corr_neutral" : "factor_corr";
    if (choice.mixed) warnings.push("组合含混合分数口径，相关性暂按原始口径近似。");
    if (useNeutral && !state.hasCorrNeutral) warnings.push("行业市值中性相关矩阵缺失，暂按原始相关矩阵近似。");
    if (tableName === "factor_corr" && !state.hasCorr) {
      return { rows, warnings: warnings.length ? warnings : ["暂无组合内相关性数据"], table: tableName, mode: choice.mode };
    }
    const codes = [...new Set(cloneComposeFactors(factors).map(f => f.code))];
    if (codes.length < 2) return { rows, warnings, table: tableName, mode: choice.mode };
    const quoted = codes.map(c => `'${String(c).replace(/'/g, "''")}'`).join(",");
    const res = await state.db.query(`
      SELECT factor_a, factor_b, corr
      FROM ${tableName}
      WHERE factor_a IN (${quoted}) AND factor_b IN (${quoted}) AND factor_a < factor_b
      ORDER BY ABS(corr) DESC
      LIMIT 20
    `);
    rows.push(...res.toArray().map(r => ({
      factor_a: r.factor_a,
      factor_b: r.factor_b,
      corr: snapshotNumber(r.corr),
    })).filter(r => r.corr !== null));
  } catch (err) {
    console.warn("combo correlation warning failed:", err);
  }
  const high = rows.filter(r => Math.abs(Number(r.corr)) >= 0.7).slice(0, 5);
  if (high.length) {
    warnings.push(`组合内相关性偏高：${high.map(r => `${r.factor_a}/${r.factor_b}=${numText(r.corr, 2)}`).join("，")}。高相关因子可能重复表达同一类信号。`);
  }
  return { rows, warnings };
}

function comboRiskLabel(level) {
  const map = {
    low: "低",
    watch: "观察",
    high: "偏高",
    alert: "高风险",
  };
  return map[level] || "观察";
}

function comboCorrelationRiskLevel(maxAbsCorr) {
  const v = snapshotNumber(maxAbsCorr);
  if (v === null) return "watch";
  if (v >= 0.85) return "alert";
  if (v >= 0.70) return "high";
  if (v >= 0.50) return "watch";
  return "low";
}

function comboCorrelationSummary(correlation, factorCount) {
  const rows = Array.isArray(correlation?.rows) ? correlation.rows : [];
  const vals = rows.map(r => Math.abs(Number(r.corr))).filter(Number.isFinite);
  const n = Number(factorCount) || 0;
  const pairCount = n >= 2 ? n * (n - 1) / 2 : 0;
  const maxAbsCorr = vals.length ? Math.max(...vals) : null;
  const avgAbsCorr = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  const highPairCount = vals.filter(v => v >= 0.70).length;
  const effectiveFactorCount = n > 0 && avgAbsCorr !== null
    ? n / (1 + Math.max(0, n - 1) * avgAbsCorr)
    : (n || null);
  return {
    factorCount: n,
    pairCount,
    observedPairCount: vals.length,
    maxAbsCorr,
    avgAbsCorr,
    highPairCount,
    effectiveFactorCount,
    risk: comboCorrelationRiskLevel(maxAbsCorr),
  };
}

async function comboLatestHoldingRows(factors, N, constraintMode) {
  const metaMap = await ensureStockMetaSnapshot();
  const scoreExpr = matrixScoreSql(factors);
  const condSql = matrixCondSql(factors);
  if (scoreExpr === null || condSql === null) return [];
  const constraint = normalizeConstraintMode(constraintMode);
  const candidateLimit = constraint === "industry"
    ? Math.max(900, N * 30)
    : Math.min(Math.max(N + 180, N * 4), 700);
  const res = await state.db.query(`
    SELECT stock_code,
           ROUND(${scoreExpr}, 6) AS comp_score,
           CAST(trade_date AS VARCHAR) AS dt
    FROM cps_latest_matrix
    WHERE TRUE ${condSql}
    ORDER BY comp_score DESC, stock_code
    LIMIT ${candidateLimit}
  `);
  const candidateRows = res.toArray()
    .map(r => ({ ...r, meta: metaMap.get(r.stock_code) }))
    .filter(r => r.meta && !r.meta.is_st && r.meta.is_active_latest)
    .map(r => ({
      stock_code: r.stock_code,
      comp_score: snapshotNumber(r.comp_score),
      cs: snapshotNumber(r.comp_score),
      dt: String(r.dt || ""),
      name: r.meta.name,
      industry_sw1: r.meta.industry_sw1,
      industry_sw2: r.meta.industry_sw2,
      market_cap: r.meta.market_cap,
      avg_amount: r.meta.avg_amount,
    }));
  const picked = constraint === "industry"
    ? industryNeutralPickRows(candidateRows, N)
    : candidateRows.slice(0, N).map(r => ({ ...r, weight: 1 / Math.max(1, Math.min(N, candidateRows.length)) }));
  return picked.map(r => ({ ...r, weight: snapshotNumber(r.weight) ?? 0 }));
}

function comboBacktestAvgTurnover(backtest, N) {
  if (!backtest || !Array.isArray(backtest.holdings)) return null;
  let prev = null;
  const turns = [];
  for (const h of backtest.holdings) {
    const cur = new Set(h?.stocks || []);
    if (!cur.size) continue;
    if (!prev) {
      turns.push(1);
    } else {
      let diff = 0;
      for (const s of cur) if (!prev.has(s)) diff += 1;
      for (const s of prev) if (!cur.has(s)) diff += 1;
      turns.push(diff / (2 * Math.max(1, Number(N) || cur.size)));
    }
    prev = cur;
  }
  return turns.length ? turns.reduce((s, v) => s + v, 0) / turns.length : null;
}

async function comboHistoricalAvgTurnover(factors, N, constraintMode) {
  const sql = matrixBacktestSql(factors, N, "cps_matrix", constraintMode);
  if (!sql) return null;
  const res = await state.db.query(sql);
  const rows = res.toArray();
  const pickedRows = normalizeConstraintMode(constraintMode) === "industry"
    ? groupIndustryNeutralRowsByMonth(rows, N)
    : rows;
  const byMonth = new Map();
  for (const r of pickedRows) {
    const key = String(r.dt || "");
    if (!key) continue;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  let prev = null;
  const turns = [];
  for (const [_, arr] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const curWeights = new Map();
    if (normalizeConstraintMode(constraintMode) === "industry") {
      const sumW = arr.reduce((s, r) => s + (snapshotNumber(r.weight) ?? 0), 0) || 1;
      arr.forEach(r => curWeights.set(r.stock_code, (snapshotNumber(r.weight) ?? 0) / sumW));
    } else {
      const w = 1 / Math.max(1, arr.length);
      arr.forEach(r => curWeights.set(r.stock_code, w));
    }
    if (!curWeights.size) continue;
    if (!prev) {
      turns.push(1);
    } else {
      const codes = new Set([...prev.keys(), ...curWeights.keys()]);
      let diff = 0;
      for (const code of codes) diff += Math.abs((curWeights.get(code) || 0) - (prev.get(code) || 0));
      turns.push(diff * 0.5);
    }
    prev = curWeights;
  }
  return turns.length ? turns.reduce((s, v) => s + v, 0) / turns.length : null;
}

function comboCrowdingRiskLevel(metrics) {
  let score = 0;
  if ((metrics.avgTurnover ?? 0) >= 0.80) score += 1;
  if ((metrics.top3IndustryShare ?? 0) >= 0.60) score += 1;
  if ((metrics.lowLiquidityShare ?? 0) >= 0.30) score += 1;
  if ((metrics.highCrowdingExposureCount ?? 0) >= 2) score += 1;
  if (score >= 3) return "alert";
  if (score === 2) return "high";
  if (score === 1) return "watch";
  return "low";
}

function crowdingHoldingValuesSql(codes) {
  const rows = [...new Set(codes || [])]
    .filter(Boolean)
    .map(code => String(code).replace(/'/g, "''"))
    .map(code => `('${code}')`);
  return rows.length ? rows.join(",") : "('__NO_HOLDINGS__')";
}

async function comboCrowdingFactorExposures(holdings) {
  const factorDefs = [
    { code: "ABTURN", label: "异常换手率", high: 0.5 },
    { code: "TURNPCTL", label: "换手率历史分位", high: 0.7 },
    { code: "HIGHMOMTURN", label: "高动量+高换手", high: 0.5 },
    { code: "TURN20D120", label: "短长换手比", high: 0.5 },
  ];
  const holdingSql = crowdingHoldingValuesSql((holdings || []).map(r => r.stock_code));
  const rows = [];
  for (const def of factorDefs) {
    try {
      await ensureFactorData([def.code], { score: true, backtest: false, ic: false });
      const res = await state.db.query(`
        WITH holdings(stock_code) AS (
          VALUES ${holdingSql}
        ),
        latest AS (
          SELECT MAX(trade_date) AS d
          FROM factor_score
          WHERE factor_code = '${def.code}'
        )
        SELECT AVG(score) AS mean,
               COUNT(*) AS n
        FROM factor_score
        JOIN holdings h USING(stock_code)
        WHERE factor_code = '${def.code}'
          AND trade_date = (SELECT d FROM latest)
          AND score IS NOT NULL
      `);
      const row = res.toArray()[0] || {};
      const mean = snapshotNumber(row.mean);
      const n = snapshotNumber(row.n) || 0;
      rows.push({
        code: def.code,
        label: def.label,
        mean,
        n,
        threshold: def.high,
        risk: mean !== null && mean >= def.high ? "high" : "low",
      });
    } catch (err) {
      rows.push({
        code: def.code,
        label: def.label,
        mean: null,
        n: 0,
        threshold: def.high,
        risk: "watch",
        error: err.message || String(err),
      });
    }
  }
  return rows;
}

async function comboCrowdingDiagnostics(payload) {
  const holdings = await comboLatestHoldingRows(payload.factors, payload.N, payload.constraintMode);
  let avgTurnover = comboBacktestAvgTurnover(payload.backtest, payload.N);
  if (avgTurnover === null) {
    avgTurnover = await comboHistoricalAvgTurnover(payload.factors, payload.N, payload.constraintMode);
  }
  const amounts = holdings.map(r => r.avg_amount).filter(v => snapshotNumber(v) !== null);
  const caps = holdings.map(r => r.market_cap).filter(v => snapshotNumber(v) !== null);
  const medianAmount = medianNumber(amounts);
  const medianMarketCap = medianNumber(caps);
  const industryWeights = new Map();
  holdings.forEach(r => {
    const industry = r.industry_sw1 || "未知";
    const w = snapshotNumber(r.weight) ?? (1 / Math.max(1, holdings.length));
    industryWeights.set(industry, (industryWeights.get(industry) || 0) + w);
  });
  const topIndustries = [...industryWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([industry, weight]) => ({ industry, weight }));
  const top3IndustryShare = topIndustries.reduce((s, r) => s + r.weight, 0);
  const lowLiquidityRows = holdings.filter(r => {
    const amt = snapshotNumber(r.avg_amount);
    const cap = snapshotNumber(r.market_cap);
    return medianAmount !== null && medianMarketCap !== null && amt !== null && cap !== null && amt < medianAmount && cap < medianMarketCap;
  });
  const exposures = await comboCrowdingFactorExposures(holdings);
  const highCrowdingExposureCount = exposures.filter(r => r.risk === "high").length;
  const metrics = {
    holdingCount: holdings.length,
    avgTurnover,
    medianAmount,
    medianMarketCap,
    topIndustries,
    top3IndustryShare,
    lowLiquidityShare: holdings.length ? lowLiquidityRows.length / holdings.length : null,
    highCrowdingExposureCount,
    exposures,
  };
  metrics.risk = comboCrowdingRiskLevel(metrics);
  return metrics;
}

async function comboBestSingleComparison(factors, N, constraintMode, startMonth, endMonth) {
  const normFactors = cloneComposeFactors(factors);
  if (!normFactors.length) return null;
  const rows = [];
  const seen = new Set();
  for (const raw of normFactors) {
    const singleFactor = { ...raw, weight: 1, thr: null };
    const key = `${singleFactor.code}|${singleFactor.side}|${singleFactor.scoreMode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const ic = await comboIcDecay([singleFactor], startMonth, endMonth);
      const rank = rankIcStatsFromSeries(ic?.series?.["1"] || []);
      const fullBt = await comboBacktest([singleFactor], N, "cps_matrix", constraintMode);
      const bt = sliceBacktestByRange(fullBt, startMonth, endMonth);
      const metrics = computeMetrics(bt.retArr, bt.navArr);
      rows.push({
        code: singleFactor.code,
        name: state.catalog.find(f => f.code === singleFactor.code)?.name_cn || "",
        label: factorParamName(singleFactor.code, singleFactor.side, singleFactor.scoreMode),
        side: normalizeSide(singleFactor.side),
        scoreMode: normalizeScoreMode(singleFactor.scoreMode),
        constraintMode: normalizeConstraintMode(constraintMode),
        rank_ic: rank.mean,
        ic_ir: rank.ir,
        ann_return: metrics?.annual ?? null,
        max_drawdown: metrics?.mdd ?? null,
      });
    } catch (err) {
      console.warn("single comparison load failed:", singleFactor.code, err);
    }
  }
  if (!rows.length) return null;
  const best = rows.slice().sort((a, b) => {
    const sa = (snapshotNumber(a.ic_ir) ?? -99) + (snapshotNumber(a.rank_ic) ?? -99);
    const sb = (snapshotNumber(b.ic_ir) ?? -99) + (snapshotNumber(b.rank_ic) ?? -99);
    return sb - sa;
  })[0];
  return { rows, best };
}

async function comboValidationPayload(factors, N, constraintMode, startMonth, endMonth, options = {}) {
  if (normalizeConstraintMode(constraintMode) === "industry") {
    await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
  }
  const fullBt = await comboBacktest(factors, N, "cps_matrix", constraintMode);
  const bt = sliceBacktestByRange(fullBt, startMonth, endMonth);
  const metrics = computeMetrics(bt.retArr, bt.navArr);
  const icDecay = await comboIcDecay(factors, startMonth, endMonth);
  const rankSeries = icDecay?.series?.["1"] || [];
  const rankStats = rankIcStatsFromSeries(rankSeries);
  const rolling = comboRollingValidation(rankSeries, bt);
  const group10 = await comboGroupValidation(factors, startMonth, endMonth);
  const correlation = await comboCorrelationWarnings(factors);
  const singleComparison = await comboBestSingleComparison(factors, N, constraintMode, startMonth, endMonth);
  const bm = await ensureBenchmarkSnapshot();
  const bg = benchmarkMetrics(bm, startMonth, endMonth);
  const basePayload = {
    factors: cloneComposeFactors(factors),
    N,
    constraintMode: normalizeConstraintMode(constraintMode),
    backtest: bt,
    metrics,
    rankStats,
    icDecay,
    rolling,
    group10,
    correlation,
    singleComparison,
    benchmarkMetrics: bg,
  };
  if (options.includeCrowding !== false) {
    basePayload.crowdingDiagnostics = await comboCrowdingDiagnostics(basePayload);
  }
  if (options.includeParameterSensitivity !== false) {
    basePayload.parameterSensitivity = await comboParameterSensitivity(basePayload, startMonth, endMonth);
  }
  return basePayload;
}

function perturbComboCoreWeight(factors, direction) {
  const norm = cloneComposeFactors(factors);
  if (norm.length < 2) return norm;
  const originalAbs = norm.reduce((s, f) => s + Math.abs(Number(f.weight) || 0), 0) || 1;
  let coreIdx = 0;
  for (let i = 1; i < norm.length; i += 1) {
    if (Math.abs(Number(norm[i].weight) || 0) > Math.abs(Number(norm[coreIdx].weight) || 0)) coreIdx = i;
  }
  norm[coreIdx].weight = (Number(norm[coreIdx].weight) || 0) * (direction > 0 ? 1.2 : 0.8);
  const newAbs = norm.reduce((s, f) => s + Math.abs(Number(f.weight) || 0), 0) || 1;
  const scale = originalAbs / newAbs;
  return norm.map(f => ({ ...f, weight: (Number(f.weight) || 0) * scale }));
}

function comboParameterSensitivityScenarios(payload) {
  const factors = cloneComposeFactors(payload?.factors || []);
  const currentN = Number(payload?.N) || state.composeN || 30;
  const currentConstraint = normalizeConstraintMode(payload?.constraintMode);
  const scenarios = [];
  [10, 30, 50].forEach(n => {
    scenarios.push({
      group: "TopN 敏感性",
      label: `Top${n}`,
      factors: cloneComposeFactors(factors),
      N: n,
      constraintMode: currentConstraint,
    });
  });
  [
    { mode: "none", label: "无约束等权" },
    { mode: "industry", label: "行业中性约束" },
  ].forEach(item => {
    scenarios.push({
      group: "约束敏感性",
      label: item.label,
      factors: cloneComposeFactors(factors),
      N: currentN,
      constraintMode: item.mode,
    });
  });
  if (factors.length >= 2) {
    scenarios.push({
      group: "权重扰动敏感性",
      label: "核心权重+20%",
      factors: perturbComboCoreWeight(factors, 1),
      N: currentN,
      constraintMode: currentConstraint,
    });
    scenarios.push({
      group: "权重扰动敏感性",
      label: "核心权重-20%",
      factors: perturbComboCoreWeight(factors, -1),
      N: currentN,
      constraintMode: currentConstraint,
    });
  }
  return scenarios;
}

function valueSignFlipped(baseValue, testValue) {
  const a = snapshotNumber(baseValue);
  const b = snapshotNumber(testValue);
  return a !== null && b !== null && Math.abs(a) >= 0.005 && Math.sign(a) !== Math.sign(b);
}

function comboParameterSensitivityJudgement(basePayload, row) {
  const baseRank = snapshotNumber(basePayload?.rankStats?.mean);
  const baseIr = snapshotNumber(basePayload?.rankStats?.ir);
  const baseAnn = snapshotNumber(basePayload?.metrics?.annual);
  const baseMdd = snapshotNumber(basePayload?.metrics?.mdd);
  if (
    snapshotNumber(row.rank_ic) === null ||
    snapshotNumber(row.ic_ir) === null ||
    snapshotNumber(row.ann_return) === null ||
    snapshotNumber(row.max_drawdown) === null
  ) {
    return { label: "需复核", cls: "review", note: "关键指标缺失，需检查该参数场景的持仓或收益数据" };
  }
  if (valueSignFlipped(baseRank, row.rank_ic) || valueSignFlipped(baseAnn, row.ann_return)) {
    return { label: "需复核", cls: "review", note: "RankIC 或收益方向在该参数场景下反转" };
  }
  const irDrop = baseIr !== null && row.ic_ir !== null && baseIr - row.ic_ir >= 0.30;
  const annDrop = baseAnn !== null && row.ann_return !== null && baseAnn - row.ann_return >= 0.05;
  const mddWorse = baseMdd !== null && row.max_drawdown !== null && row.max_drawdown - baseMdd <= -0.05;
  if (irDrop || annDrop || mddWorse) {
    return { label: "敏感", cls: "sensitive", note: "IC_IR、收益或回撤对该参数变化较敏感" };
  }
  return { label: "稳健", cls: "robust", note: "关键指标未出现明显恶化" };
}

function comboParameterSensitivitySummary(rows) {
  const validRows = (rows || []).filter(r => !r.error);
  const reviewCount = validRows.filter(r => r.judgement?.label === "需复核").length;
  const sensitiveCount = validRows.filter(r => r.judgement?.label === "敏感").length;
  const weakRows = validRows.slice().sort((a, b) => {
    const scoreA = (snapshotNumber(a.ic_ir) ?? -99) + (snapshotNumber(a.ann_return) ?? -99);
    const scoreB = (snapshotNumber(b.ic_ir) ?? -99) + (snapshotNumber(b.ann_return) ?? -99);
    return scoreA - scoreB;
  });
  const overall = reviewCount > 0 ? "需复核" : (sensitiveCount > 0 ? "敏感" : "稳健");
  const cls = overall === "需复核" ? "review" : (overall === "敏感" ? "sensitive" : "robust");
  return {
    overall,
    cls,
    sensitiveCount: reviewCount + sensitiveCount,
    scenarioCount: validRows.length,
    weakest: weakRows[0] || null,
  };
}

async function comboParameterSensitivity(payload, startMonth, endMonth) {
  const scenarios = comboParameterSensitivityScenarios(payload);
  const rows = [];
  if (scenarios.some(s => normalizeConstraintMode(s.constraintMode) === "industry")) {
    await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
  }
  for (const scenario of scenarios) {
    try {
      const p = await comboValidationPayload(
        scenario.factors,
        scenario.N,
        scenario.constraintMode,
        startMonth,
        endMonth,
        { includeCrowding: false, includeParameterSensitivity: false },
      );
      const row = {
        group: scenario.group,
        label: scenario.label,
        N: scenario.N,
        constraintMode: normalizeConstraintMode(scenario.constraintMode),
        rank_ic: p.rankStats?.mean ?? null,
        ic_ir: p.rankStats?.ir ?? null,
        ann_return: p.metrics?.annual ?? null,
        max_drawdown: p.metrics?.mdd ?? null,
        monotonicity: p.group10?.monotonicity ?? null,
      };
      row.judgement = comboParameterSensitivityJudgement(payload, row);
      rows.push(row);
    } catch (err) {
      rows.push({
        group: scenario.group,
        label: scenario.label,
        N: scenario.N,
        constraintMode: normalizeConstraintMode(scenario.constraintMode),
        error: err.message || String(err),
        judgement: { label: "需复核", cls: "review", note: err.message || String(err) },
      });
    }
  }
  return { rows, summary: comboParameterSensitivitySummary(rows) };
}

function renderComboContributionTable(factors) {
  const norm = cloneComposeFactors(factors);
  const totalAbs = norm.reduce((s, f) => s + Math.abs(Number(f.weight) || 0), 0) || 1;
  const rows = norm.map(f => {
    const meta = state.catalog.find(x => x.code === f.code);
    const thr = f.thr === null || !Number.isFinite(Number(f.thr)) ? "不过滤" : `得分 ${f.op} ${f.thr}`;
    return `<tr>
      <td>${htmlText(f.code)}</td><td>${htmlText(meta?.name_cn || "")}</td><td>${htmlText(sideLabel(f.side))}</td><td>${htmlText(scoreModeLabel(f.scoreMode))}</td>
      <td>${numText(f.weight, 2)}</td><td>${pctText(Math.abs(Number(f.weight) || 0) / totalAbs)}</td><td>${htmlText(thr)}</td>
    </tr>`;
  }).join("");
  return `<table class="validation-table">
    <thead><tr><th>因子</th><th>名称</th><th>方向</th><th>口径</th><th>权重</th><th>权重占比</th><th>过滤</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function comboAblationDelta(fullValue, ablatedValue) {
  const a = snapshotNumber(fullValue);
  const b = snapshotNumber(ablatedValue);
  return a !== null && b !== null ? a - b : null;
}

function comboAblationJudgement(row) {
  const positiveSignals = [
    (row.delta_ic_ir ?? 0) >= 0.10,
    (row.delta_rank_ic ?? 0) >= 0.005,
    (row.delta_ann_return ?? 0) >= 0.02,
    (row.delta_monotonicity ?? 0) >= 0.10,
    (row.delta_ls_ann_return ?? 0) >= 0.02,
    (row.delta_mdd ?? 0) >= 0.05,
  ].filter(Boolean).length;
  const dragSignals = [
    (row.delta_ic_ir ?? 0) <= -0.10,
    (row.delta_rank_ic ?? 0) <= -0.005,
    (row.delta_ann_return ?? 0) <= -0.02,
    (row.delta_mdd ?? 0) <= -0.05,
  ].filter(Boolean).length;
  const smallMove =
    Math.abs(row.delta_ic_ir ?? 0) < 0.10 &&
    Math.abs(row.delta_rank_ic ?? 0) < 0.005 &&
    Math.abs(row.delta_ann_return ?? 0) < 0.02 &&
    Math.abs(row.delta_monotonicity ?? 0) < 0.10 &&
    Math.abs(row.delta_ls_ann_return ?? 0) < 0.02;
  if (dragSignals >= 2 || (dragSignals >= 1 && positiveSignals === 0)) {
    return { label: "拖累", cls: "drag", note: "剔除后关键指标改善" };
  }
  if (positiveSignals >= 2 || (positiveSignals >= 1 && dragSignals === 0 && !smallMove)) {
    return { label: "增益", cls: "gain", note: "剔除后关键指标变差" };
  }
  return { label: "冗余", cls: "neutral", note: "剔除前后变化较小" };
}

function comboAblationRows(fullPayload, ablationPayloads) {
  const fullRank = fullPayload?.rankStats || {};
  const fullMetrics = fullPayload?.metrics || {};
  const fullGroup = fullPayload?.group10 || {};
  return (ablationPayloads || []).map(item => {
    const p = item.payload || {};
    const rank = p.rankStats || {};
    const metrics = p.metrics || {};
    const group = p.group10 || {};
    const row = {
      factor: item.factor,
      name: item.name || "",
      delta_rank_ic: comboAblationDelta(fullRank.mean, rank.mean),
      delta_ic_ir: comboAblationDelta(fullRank.ir, rank.ir),
      delta_ann_return: comboAblationDelta(fullMetrics.annual, metrics.annual),
      delta_mdd: comboAblationDelta(fullMetrics.mdd, metrics.mdd),
      delta_monotonicity: comboAblationDelta(fullGroup.monotonicity, group.monotonicity),
      delta_ls_ann_return: comboAblationDelta(fullGroup.ls?.annual, group.ls?.annual),
      ablated_rank_ic: rank.mean ?? null,
      ablated_ic_ir: rank.ir ?? null,
      ablated_ann_return: metrics.annual ?? null,
      ablated_mdd: metrics.mdd ?? null,
      ablated_n_months: rank.n ?? null,
      error: item.error || "",
    };
    row.judgement = row.error ? { label: "失败", cls: "drag", note: row.error } : comboAblationJudgement(row);
    return row;
  });
}

function renderComboAblationShell(payload) {
  const factors = cloneComposeFactors(payload?.factors || []);
  if (factors.length < 2) {
    return `<div class="combo-ablation">
      <div class="combo-ablation-note">至少需要 2 个因子才支持剔除实验。单因子组合没有可剔除的对照组合。</div>
    </div>`;
  }
  return `<div class="combo-ablation">
    <div class="combo-ablation-note">
      逐个剔除当前组合中的一个因子，并用相同 TopN、约束和样本区间重算检验指标。表中 Δ 表示“完整组合 - 剔除后组合”：正数通常说明该因子有边际贡献，负数说明剔除后更好。
    </div>
    <div class="combo-ablation-actions">
      <button id="combo-ablation-run" class="cpsn-btn combo-ablation-run" type="button">运行剔除实验</button>
      <span>经验判断仅用于提示，仍需结合相关性、换手、样本切片和行业暴露复核。</span>
    </div>
    <div id="combo-ablation-result"><div class="empty">点击“运行剔除实验”后显示</div></div>
  </div>`;
}

function renderComboAblationTable(rows) {
  if (!rows || !rows.length) return `<div class="empty">暂无剔除实验结果</div>`;
  const body = rows.map(r => {
    if (r.error) {
      return `<tr>
        <td>${htmlText(r.factor)}</td><td>${htmlText(r.name || "")}</td>
        <td><span class="combo-ablation-judge combo-ablation-${r.judgement.cls}">${htmlText(r.judgement.label)}</span></td>
        <td colspan="9">${htmlText(r.error)}</td>
      </tr>`;
    }
    return `<tr>
      <td>${htmlText(r.factor)}</td>
      <td>${htmlText(r.name || "")}</td>
      <td><span class="combo-ablation-judge combo-ablation-${r.judgement.cls}" title="${htmlAttr(r.judgement.note)}">${htmlText(r.judgement.label)}</span></td>
      <td>${signalValue("rank_ic", r.delta_rank_ic, signedPctText(r.delta_rank_ic))}</td>
      <td>${signalValue("ic_ir", r.delta_ic_ir, signedNumText(r.delta_ic_ir, 2))}</td>
      <td>${signalValue("ann_return", r.delta_ann_return, signedPctText(r.delta_ann_return))}</td>
      <td>${signalValue("ann_return", r.delta_mdd, signedPctText(r.delta_mdd))}</td>
      <td>${signalValue("monotonicity", r.delta_monotonicity, signedNumText(r.delta_monotonicity, 2))}</td>
      <td>${signalValue("ann_return", r.delta_ls_ann_return, signedPctText(r.delta_ls_ann_return))}</td>
      <td>${signalValue("ic_ir", r.ablated_ic_ir, signedNumText(r.ablated_ic_ir, 2))}</td>
      <td>${signalValue("ann_return", r.ablated_ann_return, pctText(r.ablated_ann_return))}</td>
      <td>${signalValue("sample_months", r.ablated_n_months, numText(r.ablated_n_months, 0))}</td>
    </tr>`;
  }).join("");
  return `<div class="combo-ablation-scroll"><table class="validation-table combo-ablation-table">
    <thead><tr>
      <th>剔除因子</th><th>名称</th><th>判断</th><th>ΔRankIC</th><th>ΔIC_IR</th><th>ΔTopN年化</th><th>Δ最大回撤</th><th>Δ10组单调性</th><th>Δ多空年化</th><th>剔除后IC_IR</th><th>剔除后年化</th><th>剔除后月数</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function bindComboAblationHandlers() {
  const btn = document.getElementById("combo-ablation-run");
  if (!btn) return;
  btn.onclick = () => runComboAblation().catch(err => {
    console.error("run combo ablation failed:", err);
    const box = document.getElementById("combo-ablation-result");
    if (box) box.innerHTML = `<pre style="color:#c00;white-space:pre-wrap;font-size:11px">剔除实验失败：${htmlText(err.message || err)}</pre>`;
    btn.disabled = false;
    btn.textContent = "运行剔除实验";
  });
}

async function runComboAblation() {
  const btn = document.getElementById("combo-ablation-run");
  const box = document.getElementById("combo-ablation-result");
  if (!btn || !box) return;
  const original = {
    factors: cloneComposeFactors(state.composeFactors),
    N: state.composeN,
    constraintMode: state.composeConstraintMode,
    start: state.composeStart,
    end: state.composeEnd,
  };
  if (original.factors.length < 2) {
    box.innerHTML = `<div class="empty">至少需要 2 个因子才支持剔除实验</div>`;
    return;
  }
  btn.disabled = true;
  btn.textContent = "计算中…";
  box.innerHTML = `<div class="loading">正在计算完整组合基准…</div>`;
  const results = [];
  try {
    await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
    state.composeFactors = cloneComposeFactors(original.factors);
    state.composeN = original.N;
    state.composeConstraintMode = normalizeConstraintMode(original.constraintMode);
    state.composeStart = original.start;
    state.composeEnd = original.end;
    await ensureComposeBase();
    const fullPayload = await comboValidationPayload(state.composeFactors, state.composeN, state.composeConstraintMode, state.composeStart, state.composeEnd, { includeCrowding: false, includeParameterSensitivity: false });
    for (let i = 0; i < original.factors.length; i += 1) {
      const removed = original.factors[i];
      const meta = state.catalog.find(x => x.code === removed.code);
      const ablatedFactors = original.factors.filter((_, idx) => idx !== i);
      box.innerHTML = `<div class="loading">正在计算 ${i + 1}/${original.factors.length}：剔除 ${removed.code} 后的组合…</div>`;
      try {
        state.composeFactors = cloneComposeFactors(ablatedFactors);
        state.composeN = original.N;
        state.composeConstraintMode = normalizeConstraintMode(original.constraintMode);
        state.composeStart = original.start;
        state.composeEnd = original.end;
        await ensureComposeBase();
        const payload = await comboValidationPayload(state.composeFactors, state.composeN, state.composeConstraintMode, state.composeStart, state.composeEnd, { includeCrowding: false, includeParameterSensitivity: false });
        results.push({ factor: removed.code, name: meta?.name_cn || "", payload });
      } catch (err) {
        console.warn("combo ablation item failed:", removed.code, err);
        results.push({ factor: removed.code, name: meta?.name_cn || "", error: err.message || String(err) });
      }
    }
    const rows = comboAblationRows(fullPayload, results);
    box.innerHTML = renderComboAblationTable(rows);
  } finally {
    restoreComposeContext(original);
    await ensureComposeBase();
    btn.disabled = false;
    btn.textContent = "重新运行剔除实验";
  }
}

function renderComboCorrelationTable(correlation) {
  const rows = Array.isArray(correlation?.rows) ? correlation.rows : [];
  if (!rows.length) return `<div class="empty">暂无组合内相关性数据</div>`;
  return `<table class="validation-table">
    <thead><tr><th>因子A</th><th>因子B</th><th>相关系数</th><th>提示</th></tr></thead>
    <tbody>${rows.slice(0, 10).map(r => `<tr>
      <td>${htmlText(r.factor_a)}</td><td>${htmlText(r.factor_b)}</td><td>${signalValue("correlation", r.corr, numText(r.corr, 2))}</td>
      <td>${Math.abs(Number(r.corr)) >= 0.7 ? "相关性偏高" : "可观察"}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function renderCrowdingRiskBadge(level) {
  const safeLevel = ["low", "watch", "high", "alert"].includes(level) ? level : "watch";
  return `<span class="combo-crowding-risk combo-crowding-${safeLevel}">${comboRiskLabel(safeLevel)}</span>`;
}

function renderComboCrowdingExposureValue(row) {
  const v = snapshotNumber(row?.mean);
  if (v === null) return signalValue("sample_months", null, "—");
  const cls = row.risk === "high" ? "signal-alert" : "signal-muted";
  const mark = row.risk === "high" ? "▲" : "●";
  return `<span class="validation-signal ${cls}"><span class="signal-dot">${mark}</span>${signedNumText(v, 2)}</span>`;
}

function comboCrowdingExposureNote(row) {
  if (row?.error) return "暂无数据";
  if (!row?.n) return "暂无有效覆盖";
  return row.risk === "high" ? "高拥挤因子暴露" : "未触发高拥挤提示";
}

function renderComboCorrelationCrowdingDiagnostics(payload) {
  const corr = comboCorrelationSummary(payload.correlation, payload.factors?.length || 0);
  const crowd = payload.crowdingDiagnostics || null;
  if (!crowd) return `<div class="empty">暂无相关性 / 拥挤度诊断数据</div>`;
  const riskNotes = [];
  if ((corr.highPairCount || 0) > 0) riskNotes.push(`高相关因子对 ${corr.highPairCount} 组`);
  if ((crowd.avgTurnover ?? 0) >= 0.80) riskNotes.push("月均换手偏高");
  if ((crowd.top3IndustryShare ?? 0) >= 0.60) riskNotes.push("前三行业集中度偏高");
  if ((crowd.lowLiquidityShare ?? 0) >= 0.30) riskNotes.push("组合内相对低流动性持仓占比较高");
  if ((crowd.highCrowdingExposureCount ?? 0) > 0) riskNotes.push(`高拥挤因子暴露 ${crowd.highCrowdingExposureCount} 项`);
  const industryText = (crowd.topIndustries || [])
    .map(r => `${r.industry}:${pctText(r.weight)}`)
    .join("，") || "—";
  const exposureRows = (crowd.exposures || []).map(r => `<tr>
    <td>${htmlText(r.code)}</td>
    <td>${htmlText(r.label)}</td>
    <td>${renderComboCrowdingExposureValue(r)}</td>
    <td>${numText(r.n, 0)}</td>
    <td>${htmlText(comboCrowdingExposureNote(r))}</td>
  </tr>`).join("");
  return `<div class="combo-crowding">
    <div class="combo-crowding-grid">
      <div class="combo-crowding-card">
        <b>相关性风险</b>
        ${renderCrowdingRiskBadge(corr.risk)}
        <span>最高相关性 ${numText(corr.maxAbsCorr, 2)}，平均绝对相关性 ${numText(corr.avgAbsCorr, 2)}</span>
      </div>
      <div class="combo-crowding-card">
        <b>拥挤度风险</b>
        ${renderCrowdingRiskBadge(crowd.risk)}
        <span>${htmlText(riskNotes.length ? riskNotes.join("；") : "未触发主要拥挤风险提示")}</span>
      </div>
      <div class="combo-crowding-card">
        <b>有效因子数估算</b>
        <strong>${numText(corr.effectiveFactorCount, 1)}</strong>
        <span>基于平均绝对相关性的简化估算，数值越低说明冗余越高。</span>
      </div>
    </div>
    <table class="validation-table combo-crowding-table">
      <thead><tr><th>诊断项</th><th>数值</th><th>含义</th></tr></thead>
      <tbody>
        <tr><td>高相关因子对</td><td>${numText(corr.highPairCount, 0)} / ${numText(corr.pairCount, 0)}</td><td>绝对相关系数不低于 0.7 的因子对数量。</td></tr>
        <tr><td>持仓月均换手</td><td>${pctText(crowd.avgTurnover)}</td><td>换手越高，交易成本和调仓冲击越敏感。</td></tr>
        <tr><td>中位成交额</td><td>${crowd.medianAmount === null ? "—" : `${numText(crowd.medianAmount, 2)} 亿`}</td><td>越低说明组合容量和交易可实现性越需要复核。</td></tr>
        <tr><td>中位市值</td><td>${crowd.medianMarketCap === null ? "—" : `${numText(crowd.medianMarketCap / 1e4, 0)} 亿`}</td><td>用于判断是否偏小市值或容量受限。</td></tr>
        <tr><td>前三行业集中度</td><td>${pctText(crowd.top3IndustryShare)}</td><td>${htmlText(industryText)}</td></tr>
        <tr><td>组合内相对低流动性占比</td><td>${pctText(crowd.lowLiquidityShare)}</td><td>持仓中成交额和市值同时低于组合中位数的股票占比；该指标不是全市场低流动性股票占比。</td></tr>
      </tbody>
    </table>
    <table class="validation-table combo-crowding-table">
      <thead><tr><th>拥挤因子</th><th>名称</th><th>持仓均值</th><th>覆盖数</th><th>提示</th></tr></thead>
      <tbody>${exposureRows || `<tr><td colspan="5">暂无拥挤因子暴露数据</td></tr>`}</tbody>
    </table>
    <p class="validation-note">相关性 / 拥挤度诊断用于识别多因子组合是否过度依赖相近信号、短期热门交易或低容量股票；它是风险复核工具，不直接替代 RankIC、收益和样本外检验。</p>
  </div>`;
}

function renderComboSingleComparison(payload) {
  const comp = payload.singleComparison;
  if (!comp?.best) return `<div class="empty">暂无单因子对比数据</div>`;
  const combo = {
    label: "当前多因子",
    rank_ic: payload.rankStats.mean,
    ic_ir: payload.rankStats.ir,
    ann_return: payload.metrics?.annual ?? null,
    max_drawdown: payload.metrics?.mdd ?? null,
  };
  const best = comp.best;
  const bestLabel = best.label || `${best.code} ${best.name || ""}`;
  return `<table class="validation-table">
    <thead><tr><th>对象</th><th>RankIC均值</th><th>IC_IR</th><th>TopN年化</th><th>最大回撤</th></tr></thead>
    <tbody>
      <tr><td>${combo.label}</td><td>${signalValue("rank_ic", combo.rank_ic, signedPctText(combo.rank_ic))}</td><td>${signalValue("ic_ir", combo.ic_ir, signedNumText(combo.ic_ir, 2))}</td><td>${signalValue("ann_return", combo.ann_return, pctText(combo.ann_return))}</td><td>${pctText(combo.max_drawdown)}</td></tr>
      <tr><td>最佳单因子 ${htmlText(bestLabel)}</td><td>${signalValue("rank_ic", best.rank_ic, signedPctText(best.rank_ic))}</td><td>${signalValue("ic_ir", best.ic_ir, signedNumText(best.ic_ir, 2))}</td><td>${signalValue("ann_return", best.ann_return, pctText(best.ann_return))}</td><td>${pctText(best.max_drawdown)}</td></tr>
    </tbody>
  </table>`;
}

function renderComboParameterSensitivity(payload) {
  const sens = payload.parameterSensitivity;
  const rows = Array.isArray(sens?.rows) ? sens.rows : [];
  if (!rows.length) return `<div class="empty">暂无参数敏感性数据</div>`;
  const summary = sens.summary || comboParameterSensitivitySummary(rows);
  const weakest = summary.weakest
    ? `${summary.weakest.group} / ${summary.weakest.label}`
    : "—";
  const body = rows.map(r => {
    if (r.error) {
      return `<tr>
        <td>${r.group}</td><td>${r.label}</td><td colspan="5">${r.error}</td>
        <td><span class="combo-parameter-judge combo-parameter-review">需复核</span></td>
      </tr>`;
    }
    return `<tr>
      <td>${r.group}</td>
      <td>${r.label}</td>
      <td>${signalValue("rank_ic", r.rank_ic, signedPctText(r.rank_ic))}</td>
      <td>${signalValue("ic_ir", r.ic_ir, signedNumText(r.ic_ir, 2))}</td>
      <td>${signalValue("ann_return", r.ann_return, pctText(r.ann_return))}</td>
      <td>${pctText(r.max_drawdown)}</td>
      <td>${signalValue("monotonicity", r.monotonicity, numText(r.monotonicity, 2))}</td>
      <td><span class="combo-parameter-judge combo-parameter-${r.judgement?.cls || "review"}" title="${htmlAttr(r.judgement?.note || "")}">${r.judgement?.label || "需复核"}</span></td>
    </tr>`;
  }).join("");
  return `<div class="combo-parameter-sensitivity">
    <div class="combo-parameter-grid">
      <div class="combo-parameter-card">
        <b>总体判断</b>
        <strong class="combo-parameter-${summary.cls || "review"}">${summary.overall || "需复核"}</strong>
        <span>稳健 / 敏感 / 需复核</span>
      </div>
      <div class="combo-parameter-card">
        <b>最弱场景</b>
        <strong>${weakest}</strong>
        <span>按 IC_IR 与年化收益综合排序</span>
      </div>
      <div class="combo-parameter-card">
        <b>敏感项数量</b>
        <strong>${numText(summary.sensitiveCount, 0)} / ${numText(summary.scenarioCount, 0)}</strong>
        <span>包含“敏感”和“需复核”场景</span>
      </div>
    </div>
    <table class="validation-table combo-parameter-table">
      <thead><tr><th>参数组</th><th>场景</th><th>RankIC</th><th>IC_IR</th><th>TopN年化</th><th>最大回撤</th><th>10组单调性</th><th>判断</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="validation-note">参数敏感性用于检查组合结论是否依赖特定 TopN、约束方式或精确权重；该模块不做自动调参，也不用于寻找最优参数。</p>
  </div>`;
}

function renderComboRollingTable(payload) {
  const rows = payload.rolling?.windows || [];
  if (!rows.length) return `<div class="empty">暂无样本切片数据</div>`;
  const labels = { full: "全样本", recent_5y: "近5年", recent_3y: "近3年", train: "训练段", validation: "验证段", test: "测试段" };
  const body = rows.map(r => `<tr>
    <td>${labels[r.window_type] || r.window_type}</td><td>${r.window_start || "—"} ~ ${r.window_end || "—"}</td>
    <td>${signalValue("sample_months", r.ic_n_months, numText(r.ic_n_months, 0))}</td>
    <td>${signalValue("sample_months", r.bt_n_months, numText(r.bt_n_months, 0))}</td>
    <td>${signalValue("rank_ic", r.rank_ic_mean, signedPctText(r.rank_ic_mean))}</td>
    <td>${signalValue("ic_ir", r.rank_ic_ir, signedNumText(r.rank_ic_ir, 2))}</td>
    <td>${signalValue("win_rate", r.rank_ic_win_rate, pctText(r.rank_ic_win_rate))}</td>
    <td>${signalValue("ann_return", r.top30_ann_return, pctText(r.top30_ann_return))}</td>
    <td>${signalValue("sharpe", r.top30_sharpe, signedNumText(r.top30_sharpe, 2))}</td>
  </tr>`).join("");
  return `<table class="validation-table">
    <thead><tr><th>样本切片</th><th>区间</th><th>IC月数</th><th>收益月数</th><th>RankIC均值</th><th>IC_IR</th><th>IC胜率</th><th>TopN年化</th><th>夏普</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderComboGroup10Table(group10) {
  const rows = Array.isArray(group10?.rows) ? group10.rows : [];
  if (!rows.length) return `<div class="empty">暂无 10 组收益数据</div>`;
  return `<table class="validation-table">
    <thead><tr><th>10组</th><th>年化收益</th><th>夏普</th><th>最大回撤</th><th>月数</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${r.group}${r.group === "G10" ? " 高分" : (r.group === "G1" ? " 低分" : "")}</td>
      <td>${signalValue("ann_return", r.ann_return, pctText(r.ann_return))}</td>
      <td>${signalValue("sharpe", r.sharpe, signedNumText(r.sharpe, 2))}</td>
      <td>${pctText(r.max_drawdown)}</td>
      <td>${signalValue("sample_months", r.n_months, numText(r.n_months, 0))}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function renderComboGroup10Chart(payload) {
  const div = document.getElementById("combo-group10-chart");
  if (!div) return;
  if (comboGroup10Chart) { comboGroup10Chart.dispose(); comboGroup10Chart = null; }
  const rows = payload.group10?.rows || [];
  if (!rows.length) {
    div.innerHTML = `<div class="empty">暂无 10 组收益图数据</div>`;
    return;
  }
  div.innerHTML = "";
  comboGroup10Chart = echarts.init(div);
  comboGroup10Chart.setOption({
    grid: { left: 54, right: 20, top: 26, bottom: 30 },
    tooltip: { trigger: "axis", valueFormatter: v => pctText(v) },
    xAxis: { type: "category", data: rows.map(r => r.group), axisLabel: { fontSize: 11 } },
    yAxis: { type: "value", axisLabel: { formatter: v => `${(v * 100).toFixed(0)}%` } },
    series: [{ name: "10组年化收益", type: "bar", barMaxWidth: 22,
      data: rows.map(r => snapshotNumber(r.ann_return)), itemStyle: { color: "#1a4d80" } }],
  });
}

function renderComboRolling36mChart(payload) {
  const div = document.getElementById("combo-rolling36-chart");
  if (!div) return;
  if (comboRolling36mChart) { comboRolling36mChart.dispose(); comboRolling36mChart = null; }
  const rows = payload.rolling?.rolling_36m || [];
  if (!rows.length) {
    div.innerHTML = `<div class="empty">暂无 36 个月滚动 IC_IR 数据</div>`;
    return;
  }
  div.innerHTML = "";
  comboRolling36mChart = echarts.init(div);
  comboRolling36mChart.setOption({
    grid: { left: 46, right: 20, top: 24, bottom: 34 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: rows.map(r => r.window_end), axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", name: "IC_IR", scale: true },
    series: [{ name: "36个月滚动 IC_IR", type: "line", symbol: "none",
      data: rows.map(r => snapshotNumber(r.rank_ic_ir)), lineStyle: { width: 2, color: "#19734d" } }],
  });
}

function renderComboValidationWarning(payload) {
  const warnings = [];
  if ((payload.rankStats?.n || 0) < 36) {
    warnings.push(`样本不足：多因子合成有效月份 ${numText(payload.rankStats?.n, 0)}，不足 36，排序信号和组合收益只适合做初步观察`);
  }
  if (Array.isArray(payload.correlation?.warnings)) warnings.push(...payload.correlation.warnings);
  return warnings.length ? `<div class="validation-short-sample"><b>提示</b><span>${htmlText(warnings.join("；").replace(/。+$/u, ""))}。</span></div>` : "";
}

async function renderComposeValidation(renderSeq) {
  const target = document.getElementById("combo-validation");
  if (!target) return;
  if (isComposeRenderStale(renderSeq) || state.composeFactors.length === 0) {
    renderComposeValidationUnavailable("选因子后显示");
    return;
  }
  target.classList.add("combo-validation-scroll-target");
  target.innerHTML = `<div class="loading">正在计算多因子检验…</div>`;
  try {
    const payload = await comboValidationPayload(
      state.composeFactors,
      state.composeN,
      state.composeConstraintMode,
      state.composeStart,
      state.composeEnd,
    );
    if (isComposeRenderStale(renderSeq)) return;
    const m = payload.metrics;
    const rank = payload.rankStats || {};
    const ex300 = (m && payload.benchmarkMetrics?.HS300) ? m.annual - payload.benchmarkMetrics.HS300.annual : null;
    const ex800 = (m && payload.benchmarkMetrics?.CSI800) ? m.annual - payload.benchmarkMetrics.CSI800.annual : null;
    const groupMono = payload.group10?.monotonicity ?? null;
    const ls = payload.group10?.ls;
    const horizons = (payload.icDecay?.stats || []).map(s => `<tr>
      <td>${s.h}M</td><td>${signalValue("rank_ic", s.mean, signedPctText(s.mean))}</td><td>${signalValue("ic_ir", s.ir, signedNumText(s.ir, 2))}</td><td>${signalValue("sample_months", s.n, numText(s.n, 0))}</td>
    </tr>`).join("");
    target.innerHTML = `
      <div class="combo-validation">
        <div class="combo-validation-note">
          <b>多因子检验</b>：多因子检验先看合成分数的 RankIC 与 IC_IR，再看 TopN 组合收益和 10 组单调性。若多因子收益高但 RankIC 不稳定，或组合内因子高度相关，应降低结论权重。
        </div>
        ${renderComboValidationWarning(payload)}
        <div class="combo-validation-grid">
          <div class="combo-validation-section">
            <h4>排序信号</h4>
            ${validationValueBlock([
              ["RankIC均值", signalValue("rank_ic", rank.mean, signedPctText(rank.mean))],
              ["IC_IR", signalValue("ic_ir", rank.ir, signedNumText(rank.ir, 2))],
              ["IC胜率", signalValue("win_rate", rank.winRate, pctText(rank.winRate))],
              ["样本月数", signalValue("sample_months", rank.n, numText(rank.n, 0))],
            ])}
          </div>
          <div class="combo-validation-section">
            <h4>组合表现</h4>
            ${validationValueBlock([
              ["TopN年化", signalValue("ann_return", m?.annual, pctText(m?.annual))],
              ["夏普", signalValue("sharpe", m?.sharpe, signedNumText(m?.sharpe, 2))],
              ["最大回撤", pctText(m?.mdd)],
              ["月度胜率", signalValue("win_rate", m?.winRate, pctText(m?.winRate))],
              ["超额vs300", signalValue("ann_return", ex300, signedPctText(ex300))],
              ["超额vs800", signalValue("ann_return", ex800, signedPctText(ex800))],
            ])}
          </div>
          <div class="combo-validation-section">
            <h4>10组单调性</h4>
            ${validationValueBlock([
              ["10组单调性", signalValue("monotonicity", groupMono, numText(groupMono, 2))],
              ["LS年化", signalValue("ann_return", ls?.annual, pctText(ls?.annual))],
              ["LS夏普", signalValue("sharpe", ls?.sharpe, signedNumText(ls?.sharpe, 2))],
              ["组合约束", constraintModeLabel(payload.constraintMode)],
            ])}
          </div>
        </div>
        <h4 class="validation-subtitle">前瞻期 RankIC</h4>
        <table class="validation-table"><thead><tr><th>前瞻期</th><th>RankIC均值</th><th>IC_IR</th><th>样本月数</th></tr></thead><tbody>${horizons}</tbody></table>
        <h4 class="validation-subtitle">10组收益</h4>
        ${renderComboGroup10Table(payload.group10)}
        <div id="combo-group10-chart" class="combo-validation-chart"></div>
        <h4 class="validation-subtitle">样本切片</h4>
        ${renderComboRollingTable(payload)}
        <div id="combo-rolling36-chart" class="combo-validation-chart"></div>
        <h4 class="validation-subtitle">参数敏感性</h4>
        ${renderComboParameterSensitivity(payload)}
        <h4 class="validation-subtitle">因子贡献</h4>
        ${renderComboContributionTable(payload.factors)}
        <h4 class="validation-subtitle">剔除实验 / 边际贡献</h4>
        ${renderComboAblationShell(payload)}
        <h4 class="validation-subtitle">组合内相关性</h4>
        ${payload.correlation?.warnings?.length ? `<div class="combo-correlation-warning">${htmlText(payload.correlation.warnings.join("；"))}</div>` : ""}
        ${renderComboCorrelationTable(payload.correlation)}
        <h4 class="validation-subtitle">相关性 / 拥挤度诊断</h4>
        ${renderComboCorrelationCrowdingDiagnostics(payload)}
        <h4 class="validation-subtitle">与最佳单因子对比</h4>
        ${renderComboSingleComparison(payload)}
        <p class="validation-note">当前检验跟随多因子合成编辑器的方向、权重、阈值、TopN、回测区间和分数口径；行业中性约束影响组合表现，但 RankIC 检验仍衡量合成分数本身的排序能力。</p>
      </div>
    `;
    renderComboGroup10Chart(payload);
    renderComboRolling36mChart(payload);
    bindComboAblationHandlers();
  } catch (err) {
    if (isComposeRenderStale(renderSeq)) return;
    console.error("render compose validation failed:", err);
    target.innerHTML = `<pre style="color:#c00;white-space:pre-wrap;font-size:11px">多因子检验失败：${htmlText(err.message || err)}</pre>`;
  }
}

// ============ 暂存组合 + 多组合对比 ============

// 对比惰性补算用的并集基表（只在有未算组合时建一次；不再每次渲染重建）
let _cmpBaseKey = null, _cmpBaseBuild = null;
async function ensureCmpBase(factors) {
  const shards = composeFactorShards(factors);
  const key = shards.map(item => item.key).join(",");
  if (_cmpBaseBuild) { try { await _cmpBaseBuild; } catch (_) {} }
  if (key === _cmpBaseKey) return;
  _cmpBaseBuild = (async () => {
    _cmpBaseKey = null;
    if (!shards.length) { await state.db.query(`DROP TABLE IF EXISTS cps_cmp_base`); }
    else {
      await ensureComposeFiles(shards);
      await state.db.query(`CREATE OR REPLACE TABLE cps_cmp_base AS
        SELECT trade_date, return_date, stock_code, factor_code, score, fwd_return,
               CASE WHEN filename LIKE '%compose_scores_neutral/%' THEN 'neutral' ELSE 'raw' END AS score_mode
        FROM read_parquet([${shards.map(item => {
          const itemKey = item.key || composeShardKey(item.code, item.scoreMode);
          return `'${_composeFilePaths.get(itemKey) || composeScorePath(item.code, item.scoreMode)}'`;
        }).join(",")}], filename=true)
        WHERE score IS NOT NULL`);
    }
    _cmpBaseKey = key;
  })();
  try { await _cmpBaseBuild; } finally { _cmpBaseBuild = null; }
}

function buildBacktestFromRows(rows, N) {
  const byMonth = new Map();
  for (const r of rows) {
    const key = r.signal_dt || monthOfLabel(r.dt);
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        signalDt: key,
        returnDt: r.dt || key,
        holdings: [],
      });
    }
    const o = byMonth.get(key);
    if (r.dt && String(r.dt) > String(o.returnDt)) o.returnDt = String(r.dt);
    o.holdings.push({ stock_code: r.stock_code, ret: memberForwardReturn(r.fwd_return) });
  }
  const periods = [...byMonth.values()]
    .filter(o => o.returnDt && o.holdings.length)
    .sort((a, b) => a.returnDt.localeCompare(b.returnDt));
  let prev = null, nav = 1; const x = [], navArr = [1], retArr = [];
  if (periods.length) x.push(periods[0].signalDt);
  for (const o of periods) {
    const weight = 1 / Math.max(1, o.holdings.length);
    const gross = o.holdings.reduce((s, h) => s + weight * h.ret, 0);
    const cur = new Map(o.holdings.map(h => [h.stock_code, weight]));
    const turnover = weightedTurnover(cur, prev);
    const net = gross - tradingCostForTurnover(turnover, !prev);
    nav *= (1 + net);
    x.push(o.returnDt);
    navArr.push(nav);
    retArr.push(net);
    prev = cur;
  }
  return { x, navArr, retArr };
}

function industryNeutralPickRows(candidates, N) {
  const valid = (candidates || [])
    .filter(r => r && r.industry_sw1 && Number.isFinite(Number(r.cs ?? r.comp_score)));
  if (!valid.length) return [];
  const industryCounts = new Map();
  for (const r of valid) industryCounts.set(r.industry_sw1, (industryCounts.get(r.industry_sw1) || 0) + 1);
  const total = valid.length || 1;
  const industries = [...industryCounts.entries()].map(([industry, count]) => ({
    industry,
    targetWeight: count / total,
  }));
  const quotas = industries.map(item => {
    const raw = item.targetWeight * N;
    return { ...item, raw, quota: Math.floor(raw), frac: raw - Math.floor(raw) };
  });
  let allocated = quotas.reduce((s, q) => s + q.quota, 0);
  quotas.sort((a, b) => b.frac - a.frac || a.industry.localeCompare(b.industry));
  for (let i = 0; allocated < N && i < quotas.length; i++, allocated++) quotas[i].quota += 1;
  const quotaByIndustry = new Map(quotas.filter(q => q.quota > 0).map(q => [q.industry, q]));
  const rows = [];
  for (const q of quotaByIndustry.values()) {
    const picked = valid
      .filter(r => r.industry_sw1 === q.industry)
      .sort((a, b) => Number(b.cs ?? b.comp_score) - Number(a.cs ?? a.comp_score) || String(a.stock_code).localeCompare(String(b.stock_code)))
      .slice(0, q.quota);
    const weight = picked.length ? q.targetWeight / picked.length : 0;
    picked.forEach(r => rows.push({ ...r, weight }));
  }
  const sumW = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0) || 1;
  return rows
    .map(r => ({ ...r, weight: (Number(r.weight) || 0) / sumW }))
    .sort((a, b) => Number(b.cs ?? b.comp_score) - Number(a.cs ?? a.comp_score) || String(a.stock_code).localeCompare(String(b.stock_code)))
    .slice(0, N);
}

function buildWeightedBacktestFromRows(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const key = r.dt;
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        signalDt: r.signal_dt || monthOfLabel(r.dt),
        returnDt: r.dt,
        holdings: new Map(),
      });
    }
    const w = Number(r.weight);
    if (!Number.isFinite(w) || w <= 0) continue;
    byMonth.get(key).holdings.set(r.stock_code, {
      weight: w,
      ret: r.fwd_return,
    });
  }
  const periods = [...byMonth.values()].sort((a, b) => a.returnDt.localeCompare(b.returnDt));
  let prev = null, nav = 1;
  const x = [], navArr = [1], retArr = [];
  if (periods.length) x.push(periods[0].signalDt);
  for (const o of periods) {
    let gross = 0;
    for (const h of o.holdings.values()) {
      gross += h.weight * memberForwardReturn(h.ret);
    }
    const cur = new Map([...o.holdings.entries()].map(([code, h]) => [code, h.weight]));
    const turnover = weightedTurnover(cur, prev);
    const net = gross - tradingCostForTurnover(turnover, !prev);
    nav *= (1 + net);
    x.push(o.returnDt);
    navArr.push(nav);
    retArr.push(net);
    prev = cur;
  }
  return { x, navArr, retArr };
}

function groupIndustryNeutralRowsByMonth(rows, N) {
  const byMonth = new Map();
  for (const r of rows || []) {
    const key = r.dt;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  const out = [];
  for (const [dt, arr] of byMonth.entries()) {
    const picked = industryNeutralPickRows(arr, N);
    for (const r of picked) out.push({ ...r, dt });
  }
  return out.sort((a, b) => String(a.dt).localeCompare(String(b.dt)) || String(a.stock_code).localeCompare(String(b.stock_code)));
}

function matrixBacktestSql(factors, N, baseTable, constraintMode = state.composeConstraintMode) {
  const idxMap = new Map(_cpsMatrixCodes.map((key, i) => [key, i]));
  const terms = [];
  const conds = [];
  for (const f of factors) {
    const idx = idxMap.get(composeShardKey(f.code, f.scoreMode));
    if (idx === undefined) return null;
    const col = `f${idx}`;
    const weight = Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0;
    const eff = effectiveScoreSql(col, f.side);
    terms.push(`${eff} * ${weight}`);
    if (f.thr !== null && Number.isFinite(Number(f.thr))) conds.push(`${eff} ${f.op} ${Number(f.thr)}`);
  }
  const scoreExpr = terms.length ? terms.join(" + ") : "0";
  const condSql = conds.length ? "AND " + conds.join(" AND ") : "";
  return `
    WITH scored AS (
      SELECT m.trade_date, m.return_date, m.stock_code, m.fwd_return, ROUND(${scoreExpr}, 6) AS cs,
             d.industry_sw1
      FROM ${baseTable} m
      LEFT JOIN stock_descriptors d ON d.stock_code = m.stock_code
      WHERE TRUE ${condSql}
    ),
    ranked AS (
      SELECT trade_date, return_date, stock_code, fwd_return, cs, industry_sw1,
             ROW_NUMBER() OVER (PARTITION BY trade_date ORDER BY cs DESC, stock_code) AS rk
      FROM scored
    )
    SELECT strftime(trade_date, '%Y-%m') AS signal_dt,
           strftime(COALESCE(return_date, trade_date), '%Y-%m-%d') AS dt,
           stock_code, fwd_return, cs, industry_sw1
    FROM ranked WHERE rk <= ${normalizeConstraintMode(constraintMode) === "industry" ? Math.max(900, N * 30) : N} ORDER BY trade_date, rk`;
}

// 给定组合配置 + 基表 → 逐月净值/收益（口径同 renderComposeBacktest）。
// cps_matrix 是当前因子集宽表快路径；其它表保留长表 SQL 作为对比惰性补算兜底。
async function comboBacktest(factors, N, baseTable, constraintMode = state.composeConstraintMode) {
  const normalizedConstraint = normalizeConstraintMode(constraintMode);
  const cacheKey = baseTable === "cps_matrix" ? composeConfigKey(factors, N, normalizedConstraint) : null;
  if (cacheKey && _composeBtCache.has(cacheKey)) return cloneBacktest(_composeBtCache.get(cacheKey));
  if (cacheKey && _composeBtBuilds.has(cacheKey)) return cloneBacktest(await _composeBtBuilds.get(cacheKey));

  const fastSql = baseTable === "cps_matrix" ? matrixBacktestSql(factors, N, baseTable, normalizedConstraint) : null;
  if (fastSql) {
    const build = (async () => {
      const res = await state.db.query(fastSql);
      const rows = res.toArray();
      const bt = normalizedConstraint === "industry"
        ? buildWeightedBacktestFromRows(groupIndustryNeutralRowsByMonth(rows, N))
        : buildBacktestFromRows(rows, N);
      if (cacheKey) rememberComposeBacktest(cacheKey, bt);
      return bt;
    })();
    if (cacheKey) _composeBtBuilds.set(cacheKey, build);
    try {
      return cloneBacktest(await build);
    } finally {
      if (cacheKey) _composeBtBuilds.delete(cacheKey);
    }
  }
  if (baseTable === "cps_matrix") throw new Error("cps_matrix does not cover requested factors");

  const nF = factors.length;
  const vals = cloneComposeFactors(factors)
    .map(f => `('${f.code}','${normalizeScoreMode(f.scoreMode)}',${f.weight},${normalizeSide(f.side)})`)
    .join(",");
  const cond = composeCondFor(factors, baseTable);
  const res = await state.db.query(`
    WITH w(code, score_mode, weight, side) AS (VALUES ${vals}),
    ${cond.cte}
    comp AS (
      SELECT s.trade_date, s.stock_code, MAX(s.return_date) AS return_date,
             MAX(s.fwd_return) AS fwd_return,
             ROUND(SUM(s.score * w.side * w.weight), 6) AS cs, COUNT(*) AS cnt,
             ANY_VALUE(d.industry_sw1) AS industry_sw1
      FROM ${baseTable} s
      JOIN w ON s.factor_code = w.code AND s.score_mode = w.score_mode
      LEFT JOIN stock_descriptors d ON d.stock_code = s.stock_code
      WHERE s.score IS NOT NULL GROUP BY s.trade_date, s.stock_code
    ),
    ranked AS (
      SELECT c.trade_date, c.return_date, c.stock_code, c.fwd_return, c.cs, c.industry_sw1,
             ROW_NUMBER() OVER (PARTITION BY c.trade_date ORDER BY c.cs DESC, c.stock_code) AS rk
      FROM comp c
      ${cond.join}
      WHERE c.cnt = ${nF}
    )
    SELECT strftime(trade_date, '%Y-%m') AS signal_dt,
           strftime(COALESCE(return_date, trade_date), '%Y-%m-%d') AS dt,
           stock_code, fwd_return, cs, industry_sw1
    FROM ranked WHERE rk <= ${normalizedConstraint === "industry" ? Math.max(900, N * 30) : N} ORDER BY trade_date, rk`);
  const rows = res.toArray();
  return normalizedConstraint === "industry"
    ? buildWeightedBacktestFromRows(groupIndustryNeutralRowsByMonth(rows, N))
    : buildBacktestFromRows(rows, N);
}

async function saveCurrentCombo() {
  if (!state.composeFactors.length) return;
  const factors = cloneComposeFactors(state.composeFactors);
  const N = state.composeN;
  const constraintMode = normalizeConstraintMode(state.composeConstraintMode);
  const i = state.savedCombos.length;
  const comboKey = composeConfigKey(factors, N, constraintMode);
  const combo = {
    name: `组合${i + 1}`,
    factors,
    N,
    constraintMode,
    color: STRAT_COLORS[i % STRAT_COLORS.length],
    bt: _composeBtCache.has(comboKey)
      ? cloneBacktest(_composeBtCache.get(comboKey))
      : (comboKey === _latestComposeBtKey ? cloneBacktest(_latestComposeBt) : null),
  };
  state.savedCombos.push(combo);
  renderSavedCombos();                  // 先把 chip 显示出来
  // 立刻显示对比面板 + 计算中提示（回测在 wasm 里跑，可能要几秒）。
  // 注意：不要清空 navDiv，否则已有组合的图会先消失；用标题做「计算中」状态，已有图保留。
  const panel = document.getElementById("cps-compare-panel");
  const navDiv = document.getElementById("cps-compare-nav");
  const titleEl = document.getElementById("cps-compare-title");
  if (panel) panel.style.display = "";
  if (titleEl) titleEl.textContent = combo.bt ? "暂存组合对比" : `暂存组合对比 · 正在计算 ${combo.name}…`;
  if (navDiv && !cpsCompareChart && !combo.bt) navDiv.innerHTML = `<div class="loading">正在计算 ${combo.name} 的回测，请稍候…</div>`;
  const saveBtn = document.getElementById("cps-save");
  if (saveBtn && !combo.bt) { saveBtn.disabled = true; saveBtn.textContent = "计算中…"; }
  try {
    if (!combo.bt) {
      await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
      await ensureComposeData();
      try {
        await ensureComposeBase();
        const bt = await comboBacktest(factors, N, "cps_matrix", constraintMode);
        if (bt && bt.x && bt.x.length) combo.bt = bt;
      } catch (e) { console.warn("fast combo backtest failed, lazy recompute later:", e); }
    }
    renderSavedCombos();
    await renderComboCompare();
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "📌 加入临时对比"; }
  }
}
function removeSavedCombo(i) { state.savedCombos.splice(i, 1); renderSavedCombos(); renderComboCompare(); }
function renameSavedCombo(i) {
  const c = state.savedCombos[i]; if (!c) return;
  const v = prompt("组合名", c.name);
  if (!v || !v.trim()) return;
  const name = v.trim();
  if (state.savedCombos.some((combo, idx) => idx !== i && combo.name === name)) {
    alert(`“${name}”已存在，请换一个名称`);
    return;
  }
  c.name = name;
  renderSavedCombos();
  renderComboCompare();
}

function renderSavedCombos() {
  const box = document.getElementById("cps-saved-list");
  const saveAllBtn = document.getElementById("cps-save-all-mine");
  if (saveAllBtn) saveAllBtn.style.display = state.savedCombos.length ? "" : "none";
  if (!box) return;
  if (!state.savedCombos.length) {
    box.innerHTML = `<span style="color:#bbb;font-size:11px">还没有临时对比组合。设好权重/条件后点上面「📌 加入临时对比」，可存多个再对比。</span>`;
    return;
  }
  box.innerHTML = state.savedCombos.map((c, i) => {
    const summ = comboSummary(c);
    return `<div style="display:inline-flex;align-items:center;gap:6px;background:#f2f5f9;border:1px solid #e0e6ee;border-radius:14px;padding:3px 10px;margin:0 6px 6px 0;font-size:11px">
      <span style="width:10px;height:10px;border-radius:50%;background:${c.color};flex:none"></span>
      <b class="cps-saved-rename" data-idx="${i}" style="cursor:pointer" title="点击改名">${c.name}</b>
      <span style="color:#888">${summ}</span>
      <span class="cps-saved-rm" data-idx="${i}" style="cursor:pointer;color:#c14545;padding-left:2px">×</span>
    </div>`;
  }).join("");
  box.querySelectorAll(".cps-saved-rm").forEach(el => el.onclick = () => removeSavedCombo(parseInt(el.dataset.idx, 10)));
  box.querySelectorAll(".cps-saved-rename").forEach(el => el.onclick = () => renameSavedCombo(parseInt(el.dataset.idx, 10)));
}

let cpsCompareChart = null;
let _cpsCompareRows = null;
let _cpsCompareSort = { key: null, dir: -1 };

function drawCpsCompareTable() {
  const tblDiv = document.getElementById("cps-compare-table");
  if (!tblDiv || !_cpsCompareRows) return;
  const pct = v => (v == null || !Number.isFinite(v)) ? "—" : (v * 100).toFixed(1) + "%";
  const num = (v, d = 2) => (v == null || !Number.isFinite(v)) ? "—" : Number(v).toFixed(d);
  const COLS = [
    { key: "label",   label: "组合 / 基准", sortable: false, cell: r => r.labelHtml || r.label },
    { key: "annual",  label: "年化收益",   cell: r => pct(r.annual) },
    { key: "vol",     label: "年化波动率", cell: r => pct(r.vol) },
    { key: "sharpe",  label: "夏普",       cell: r => num(r.sharpe, 2) },
    { key: "mdd",     label: "最大回撤",   cell: r => pct(r.mdd) },
    { key: "winRate", label: "月度胜率",   cell: r => r.winRate == null ? "—" : (r.winRate * 100).toFixed(0) + "%" },
    { key: "ex300",   label: "超额vs300", cell: r => pct(r.ex300) },
    { key: "navEnd",  label: "期末净值",   cell: r => num(r.navEnd, 2) },
  ];
  const rows = _cpsCompareRows.slice();
  const sk = _cpsCompareSort.key;
  if (sk) {
    rows.sort((a, b) => {
      const va = a[sk], vb = b[sk];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * _cpsCompareSort.dir;
    });
  }
  const arrow = k => _cpsCompareSort.key === k ? (_cpsCompareSort.dir < 0 ? " ▼" : " ▲") : "";
  const thead = COLS.map(c => c.sortable === false
    ? `<th>${c.label}</th>`
    : `<th class="cmp-sort" data-key="${c.key}">${c.label}${arrow(c.key)}</th>`).join("");
  const body = rows.map(r => {
    if (r.noData) return `<tr><td>${r.labelHtml || r.label}</td><td colspan="${COLS.length - 1}" style="color:#aaa">无数据（过滤过严 / 因子覆盖不足）</td></tr>`;
    const tds = COLS.map(c => `<td>${c.cell(r)}</td>`).join("");
    return `<tr${r.isBench ? ' style="color:#888;border-top:2px solid #ddd"' : ""}>${tds}</tr>`;
  }).join("");
  tblDiv.innerHTML = `<table class="kpi-table"><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table>`;
  tblDiv.querySelectorAll("th.cmp-sort").forEach(th => th.onclick = () => {
    const k = th.dataset.key;
    if (_cpsCompareSort.key === k) _cpsCompareSort.dir = -_cpsCompareSort.dir;
    else { _cpsCompareSort.key = k; _cpsCompareSort.dir = -1; }
    drawCpsCompareTable();
  });
}

async function renderComboCompare() {
  const panel = document.getElementById("cps-compare-panel");
  if (!panel) return;
  if (!state.savedCombos.length) { panel.style.display = "none"; return; }
  panel.style.display = "";
  const navDiv = document.getElementById("cps-compare-nav");
  const tblDiv = document.getElementById("cps-compare-table");
  const titleEl = document.getElementById("cps-compare-title");
  // 惰性补算未缓存的组合（只在确有未算组合时建并集基表+算；之后只读缓存）。
  // 计算时保留已有的图（用标题做状态），只有还没图时才显示文字占位。
  const missing = state.savedCombos.filter(c => !c.bt);
  if (missing.length) {
    if (titleEl) titleEl.textContent = "暂存组合对比 · 计算中…";
    if (!cpsCompareChart) { navDiv.innerHTML = `<div class="loading">计算暂存组合回测…</div>`; tblDiv.innerHTML = ""; }
    try {
      await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
      await ensureComposeData();
      const unionFactors = state.savedCombos.flatMap(c => cloneComposeFactors(c.factors));
      await ensureCmpBase(unionFactors);
      for (const c of missing) c.bt = await comboBacktest(c.factors, c.N, "cps_cmp_base", c.constraintMode);
    } catch (e) {
      if (titleEl) titleEl.textContent = "暂存组合对比";
      navDiv.innerHTML = `<div class="empty">对比计算失败：${htmlText(e.message || e)}</div>`; return;
    }
  }
  if (titleEl) titleEl.textContent = "暂存组合对比";
  const rangedCombos = state.savedCombos.map(c => ({
    ...c,
    viewBt: sliceBacktestByRange(c.bt, state.composeStart, state.composeEnd),
  }));
  const withData = rangedCombos.filter(c => c.viewBt && c.viewBt.x && c.viewBt.x.length);
  const benchmarkRows = [];
  const bcolors = { HS300: "#c14545", CSI800: "#6e9a4f", CSI500: "#c89c2b" };
  const bcn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };

  // —— 净值叠加图（只画有数据的组合）——
  if (cpsCompareChart) { cpsCompareChart.dispose(); cpsCompareChart = null; }
  if (!withData.length) {
    navDiv.innerHTML = `<div class="empty">暂存组合暂无可画数据（可能过滤过严 / 因子覆盖不足）</div>`;
  } else {
    const allMonths = [...new Set(withData.flatMap(c => c.viewBt.x))].sort();
    const series = withData.map(c => {
      const mp = {}; c.viewBt.x.forEach((m, k) => mp[m] = c.viewBt.navArr[k]);
      return { name: c.name, type: "line", symbol: "none", connectNulls: true,
        data: allMonths.map(m => m in mp ? +mp[m].toFixed(3) : null),
        color: c.color, lineStyle: { width: 2 } };
    });
    if (allMonths.length) {
      const bmSnap = await ensureBenchmarkSnapshot();
      for (const idx of ["HS300", "CSI800", "CSI500"]) {
        const aligned = benchmarkSeries(bmSnap, allMonths.map(monthOfLabel), idx);
        const b = aligned.find(v => v !== null);
        series.push({ name: `${bcn[idx]}(基准)`, type: "line", symbol: "none", connectNulls: true,
          data: b ? aligned.map(v => v === null ? null : +(v / b).toFixed(3)) : aligned,
          color: bcolors[idx], lineStyle: { width: 1.2, type: "dashed" } });
        const navs = aligned.filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
        if (navs.length >= 2) {
          const rets = navs.slice(1).map((v, k) => v / navs[k] - 1);
          const m = computeMetrics(rets, navs);
          if (m) benchmarkRows.push({
            label: bcn[idx],
            labelHtml: `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${bcolors[idx]};margin-right:5px"></span>${bcn[idx]}`,
            annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd,
            winRate: m.winRate, ex300: null, navEnd: m.navEnd, isBench: true,
          });
        }
      }
    }
    navDiv.innerHTML = "";
    cpsCompareChart = echarts.init(navDiv);
    cpsCompareChart.setOption({
      grid: { left: 50, right: 20, top: 30, bottom: 30 },
      tooltip: { trigger: "axis" }, legend: { top: 0, textStyle: { fontSize: 11 }, itemWidth: 28 },
      xAxis: { type: "category", data: allMonths, axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", scale: true }, series,
    });
  }

  // —— 指标对比表：列出所有暂存组合和基准；点击表头可按指标排序 ——
  const hs300Annual = benchmarkRows.find(r => r.label === "沪深300")?.annual;
  const exBase = hs300Annual;
  const rows = [];
  for (const c of rangedCombos) {
    const dot = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c.color};margin-right:5px"></span>`;
    const m = (c.viewBt && c.viewBt.retArr && c.viewBt.retArr.length) ? computeMetrics(c.viewBt.retArr, c.viewBt.navArr) : null;
    if (!m) {
      rows.push({ label: c.name, labelHtml: `${dot}${c.name}`, noData: true });
      continue;
    }
    rows.push({
      label: c.name,
      labelHtml: `${dot}${c.name}`,
      annual: m.annual, vol: m.vol, sharpe: m.sharpe, mdd: m.mdd,
      winRate: m.winRate,
      ex300: Number.isFinite(exBase) ? m.annual - exBase : null,
      navEnd: m.navEnd,
    });
  }
  _cpsCompareRows = rows.concat(benchmarkRows);
  drawCpsCompareTable();
}

// ============ 最优权重网格搜索 ============

// 生成非负、和为 1、步长 step 的权重组合（nF 个因子）。用整数划分避免浮点误差。
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

// 在 JS 内存里对一组权重跑合成回测，返回指标。conds=[{idx,op,thr}] 先过滤再打分。
function backtestWeights(monthsArr, weights, N, conds) {
  let prev = null, nav = 1;
  const navArr = [], retArr = [];
  for (const mo of monthsArr) {
    let elig = mo.stocks;
    if (conds && conds.length) {
      elig = mo.stocks.filter(s => conds.every(c =>
        c.op === ">=" ? s.scores[c.idx] >= c.thr : s.scores[c.idx] <= c.thr));
    }
    if (elig.length === 0) {   // 该月无符合 → 空仓
      nav *= 1; navArr.push(nav); retArr.push(0); prev = new Map(); continue;
    }
    const scored = elig.map(s => {
      let c = 0; for (let i = 0; i < weights.length; i++) c += weights[i] * s.scores[i];
      return { code: s.code, comp: c, ret: s.ret };
    });
    scored.sort((a, b) => b.comp - a.comp);
    const picks = scored.slice(0, N);
    const weight = 1 / picks.length;
    const gross = picks.reduce((s, p) => s + weight * memberForwardReturn(p.ret), 0);
    const cur = new Map(picks.map(p => [p.code, weight]));
    const turnover = weightedTurnover(cur, prev);
    const net = gross - tradingCostForTurnover(turnover, !prev);
    nav *= (1 + net); navArr.push(nav); retArr.push(net); prev = cur;
  }
  return computeMetrics(retArr, navArr);
}

async function optimizeWeights() {
  const box = document.getElementById("cps-opt");
  const codes = state.composeFactors.map(f => f.code);
  const nF = codes.length;
  if (nF < 2) { box.innerHTML = `<div class="empty" style="color:#c14545">请先选 2 个以上因子</div>`; return; }
  if (nF > 4) { box.innerHTML = `<div class="empty" style="color:#c14545">最优权重仅支持 ≤4 个因子（组合爆炸）</div>`; return; }
  if (normalizeConstraintMode(state.composeConstraintMode) === "industry") {
    box.innerHTML = `<div class="empty" style="color:#c14545">最优权重暂仅支持「无约束等权」。请先切回无约束，再搜索权重。</div>`;
    return;
  }
  box.innerHTML = `<div class="loading">搜索中…</div>`;
  await ensureComposeData();
  await ensureComposeBase();

  const idxMap = new Map(_cpsMatrixCodes.map((key, i) => [key, i]));
  const matrixIndexes = state.composeFactors.map(f => idxMap.get(composeShardKey(f.code, f.scoreMode)));
  if (matrixIndexes.some(idx => idx === undefined)) {
    box.innerHTML = `<div class="empty" style="color:#c14545">当前因子数据未加载完整，请稍后重试</div>`;
    return;
  }
  const scoreCols = state.composeFactors
    .map((f, i) => `${effectiveScoreSql(`m.f${matrixIndexes[i]}`, f.side)} AS f${i}`)
    .join(", ");
  const scorePresenceSql = matrixIndexes.map(idx => `m.f${idx} IS NOT NULL`).join(" AND ");
  // 候选股裁剪：只保留"在任一所选因子排进前 500"的股。合成 top-N(N≤100) 的成分
  // 必在此并集内（全因子都排 500 外 → 加权和必偏低 → 进不了 top），裁剪不改结果但大幅提速。
  const res = await state.db.query(`
    WITH cand AS (
      ${state.composeFactors.map((f, i) => `
        SELECT trade_date, stock_code FROM (
          SELECT trade_date, stock_code,
                 ROW_NUMBER() OVER (PARTITION BY trade_date ORDER BY ${effectiveScoreSql(`f${matrixIndexes[i]}`, f.side)} DESC) AS rk
          FROM cps_matrix
          WHERE f${matrixIndexes[i]} IS NOT NULL
        ) WHERE rk <= 500
      `).join("\nUNION\n")}
    )
    SELECT strftime(COALESCE(m.return_date, m.trade_date),'%Y-%m') AS ym,
           m.stock_code,
           ${scoreCols},
           m.fwd_return
    FROM cps_matrix m
    JOIN cand c ON c.trade_date = m.trade_date AND c.stock_code = m.stock_code
    WHERE ${scorePresenceSql}
    ORDER BY m.trade_date
  `);
  // 组织成 months[ym] = { stocks: [{code, scores:[按codes顺序], ret}] }，仅保留所有因子都有得分的股
  const tmp = new Map();   // ym -> Map(code -> {scores:[], ret, cnt})
  for (const r of res.toArray()) {
    if (!tmp.has(r.ym)) tmp.set(r.ym, new Map());
    const mm = tmp.get(r.ym);
    if (!mm.has(r.stock_code)) {
      mm.set(r.stock_code, {
        scores: codes.map((_, i) => r[`f${i}`]),
        ret: r.fwd_return,
        cnt: nF,
      });
    }
  }
  const monthsArr = [];
  for (const [ym, mm] of tmp) {
    if (state.composeStart && ym < state.composeStart) continue;
    if (state.composeEnd && ym > state.composeEnd) continue;
    const stocks = [];
    for (const [code, o] of mm) if (o.cnt === nF) stocks.push({ code, scores: o.scores, ret: o.ret });
    if (stocks.length >= state.composeN) monthsArr.push({ ym, stocks });
  }
  monthsArr.sort((a, b) => a.ym < b.ym ? -1 : 1);

  // 过滤条件（JS 端）：因子在 codes 中的位置 idx + op + 阈值
  const conds = state.composeFactors
    .map((f, i) => (f.thr !== null && Number.isFinite(f.thr)) ? { idx: i, op: f.op, thr: f.thr } : null)
    .filter(Boolean);

  // 网格步长：因子越多步长越粗（控制组合数）
  const step = nF === 2 ? 0.05 : nF === 3 ? 0.1 : 0.2;
  const grid = weightGrid(nF, step);
  // 4 个目标各记录最优
  const best = {
    annual: { val: -Infinity, w: null, m: null },
    sharpe: { val: -Infinity, w: null, m: null },
    vol:    { val: Infinity,  w: null, m: null },
    mdd:    { val: -Infinity, w: null, m: null },   // mdd 是负数，越大(接近0)越好
  };
  for (const w of grid) {
    const m = backtestWeights(monthsArr, w, state.composeN, conds);
    if (!m) continue;
    if (m.annual > best.annual.val) best.annual = { val: m.annual, w, m };
    if (Number.isFinite(Number(m.sharpe)) && m.sharpe > best.sharpe.val) best.sharpe = { val: m.sharpe, w, m };
    if (m.vol < best.vol.val) best.vol = { val: m.vol, w, m };
    if (m.mdd > best.mdd.val) best.mdd = { val: m.mdd, w, m };
  }

  const pct = v => (v * 100).toFixed(1) + "%";
  const wstr = w => codes.map((c, i) => `${c} ${(w[i] * 100).toFixed(0)}%`).join(" / ");
  const targets = [
    ["年化收益最高", best.annual], ["夏普比率最高", best.sharpe],
    ["年化波动率最低", best.vol], ["最大回撤最小", best.mdd],
  ];
  let rows = "";
  targets.forEach(([label, b], ti) => {
    if (!b.w) return;
    rows += `<tr>
      <td>${label}</td>
      <td>${wstr(b.w)}</td>
      <td>${pct(b.m.annual)}</td><td>${pct(b.m.vol)}</td><td>${numText(b.m.sharpe, 2)}</td>
      <td>${pct(b.m.mdd)}</td>
      <td><button class="cpsn-btn cps-apply" data-ti="${ti}">应用</button></td>
    </tr>`;
  });
  box.innerHTML = `
    <table class="opt-table">
      <thead><tr><th>优化目标</th><th>最优权重</th><th>年化收益</th><th>年化波动率</th><th>夏普</th><th>回撤</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:4px">网格步长 ${step}（${grid.length} 组组合），目标基于 top-${state.composeN}、${composeRangeLabel()} 历史回测。点"应用"把权重填回。</p>
    <p style="color:#c08040;font-size:11px;margin-top:2px">⚠ 这是<b>样本内</b>最优（当前回测区间内最好的权重），不保证未来同样最优——实务中需警惕过拟合，建议结合因子逻辑而非只追历史最优。</p>`;
  // 应用按钮：把最优权重填回 composeFactors
  box.querySelectorAll(".cps-apply").forEach(btn => {
    btn.onclick = () => {
      const b = targets[parseInt(btn.dataset.ti, 10)][1];
      if (!b.w) return;
      b.w.forEach((wv, i) => { state.composeFactors[i].weight = +(wv).toFixed(3); });
      renderCompose();
    };
  });
}


function bindComposeButtons() {
  const optBtn = document.getElementById("cps-optimize");
  if (optBtn) optBtn.onclick = () => optimizeWeights().catch(e => {
    document.getElementById("cps-opt").innerHTML = `<pre style="color:#c00;font-size:11px">最优权重失败：${htmlText(e.message || e)}</pre>`;
  });
  const saveBtn = document.getElementById("cps-save");
  if (saveBtn) saveBtn.onclick = () => {
    if (!state.composeFactors.length) { alert("先选至少一个因子并设好权重，再加入临时对比"); return; }
    saveCurrentCombo().catch(e => console.error("save combo failed", e));
  };
  const saveMineBtn = document.getElementById("cps-save-mine");
  if (saveMineBtn) saveMineBtn.onclick = () => saveCurrentComboToMine();
  const saveAllMineBtn = document.getElementById("cps-save-all-mine");
  if (saveAllMineBtn) saveAllMineBtn.onclick = () => saveAllTempCombosToMine();
  const copyBtn = document.getElementById("cps-copy-json");
  if (copyBtn) copyBtn.onclick = () => copyPublishRequest().catch(e => console.error("copy publish request failed", e));
  const resetBtn = document.getElementById("cps-reset");
  if (resetBtn) resetBtn.onclick = () => {
    state.composeFactors = [];
    updateTreeHighlight();
    renderComposeSoon(0);
  };
  document.querySelectorAll(".cpsn-btn[data-n]").forEach(b => {
    b.onclick = () => {
      state.composeN = parseInt(b.dataset.n, 10);
      syncComposeNButtons();
      renderComposeSoon();
    };
  });
  const inp = document.getElementById("cpsn-input");
  document.getElementById("cpsn-add").onclick = () => {
    const n = parseInt(inp.value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) { inp.value = ""; return; }
    state.composeN = n;
    syncComposeNButtons();
    renderComposeSoon();
  };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("cpsn-add").onclick(); });
}

function bindScanButtons() {
  document.querySelectorAll(".scan-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".scan-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.scanMetric = btn.dataset.metric;
      if (state.activeFactor) {
        loadSingleSnapshot(state.activeFactor)
          .then(snap => {
            const viewSnap = activeSingleSnapshot(snap);
            if (state.singleSide === 1) return renderNScanFast(state.activeFactor, viewSnap);
            return renderNScanSide(state.activeFactor, state.singleSide, viewSnap);
          })
          .catch(() => renderNScan(state.activeFactor));
      }
    };
  });
}

// ===================== 个股「为什么入选」弹窗 =====================
// 标准正态 CDF（Abramowitz-Stegun 近似）：把标准正态分数转成「强于全市场 X%」
function _ncdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function closeStockModal() {
  const o = document.getElementById("stock-modal");
  if (o) o.style.display = "none";
}

function metaRowFromSnapshot(code) {
  const mp = state.stockMetaSnapshot;
  const row = mp ? mp.get(code) : null;
  return row ? {
    industry_sw1: row.industry_sw1,
    industry_sw2: row.industry_sw2,
    market_cap: row.market_cap,
    pe: row.pe,
    pb: row.pb,
  } : null;
}

function renderStockDetailBody(scoreRows, metaRow) {
  const cat = new Map((state.catalog || []).map(f => [f.code, f]));
  const groups = new Map();
  for (const r of scoreRows) {
    const f = cat.get(r.factor_code);
    if (!f) continue;
    if (!groups.has(f.l1)) groups.set(f.l1, []);
    groups.get(f.l1).push({ ...r, name_cn: f.name_cn, l2: f.l2 });
  }
  const active = state.activeFactor;
  let head = `<div class="sd-meta">`;
  if (metaRow) {
    const mv = metaRow.market_cap != null ? (Number(metaRow.market_cap) / 1e4).toFixed(0) + " 亿" : "—";
    head += `<span>申万：${metaRow.industry_sw1 || "—"} / ${metaRow.industry_sw2 || "—"}</span>`
          + `<span>市值 ${mv}</span><span>PE ${metaRow.pe != null ? Number(metaRow.pe).toFixed(1) : "—"}</span>`
          + `<span>PB ${metaRow.pb != null ? Number(metaRow.pb).toFixed(2) : "—"}</span>`;
  }
  head += `</div><p class="sd-note">每行一个因子：<b>原始值</b>＝因子原始数值（分位类显示为 %）；`
        + `<b>得分z</b>＝横截面标准化（已统一方向，越大越好）；<b>百分位</b>＝该股强于全市场的比例。`
        + `${active && cat.has(active) ? ` 当前因子 <b>${cat.get(active).name_cn}</b> 已高亮。` : ""}</p>`;
  let bodyHtml = "";
  for (const [l1, arr] of groups) {
    arr.sort((a, b) => b.score - a.score);
    bodyHtml += `<div class="sd-group"><h4>${l1}（${arr.length}）</h4><table class="sd-table">`
      + `<thead><tr><th class="sd-name">因子</th><th class="sd-raw">原始值</th>`
      + `<th class="sd-bar">强弱</th><th class="sd-z">得分z</th><th class="sd-pct">百分位</th></tr></thead><tbody>`;
    for (const r of arr) {
      const pct = Math.min(99, Math.max(1, Math.round(_ncdf(r.score) * 100)));
      const pos = r.score >= 0;
      const hl = (r.factor_code === active) ? " sd-active" : "";
      const isPct = (r.name_cn || "").includes("分位");
      const raw = (r.raw_value != null)
        ? (isPct ? (Number(r.raw_value) * 100).toFixed(2) + "%" : Number(r.raw_value).toPrecision(4))
        : "—";
      bodyHtml += `<tr class="sd-row${hl}">`
        + `<td class="sd-name">${r.name_cn || r.factor_code}<span class="sd-l2">${r.l2}</span></td>`
        + `<td class="sd-raw">${raw}</td>`
        + `<td class="sd-bar"><div class="sd-barwrap"><div class="sd-barfill ${pos ? "pos" : "neg"}" style="width:${pct}%"></div></div></td>`
        + `<td class="sd-z">${r.score.toFixed(2)}</td>`
        + `<td class="sd-pct">${pct}%</td>`
        + `</tr>`;
    }
    bodyHtml += `</tbody></table></div>`;
  }
  return head + bodyHtml;
}

async function showStockDetail(code, name) {
  const overlay = document.getElementById("stock-modal");
  const titleEl = document.getElementById("stock-modal-title");
  const body = document.getElementById("stock-modal-body");
  overlay.style.display = "flex";
  titleEl.textContent = `${code}${name ? " · " + name : ""}`;
  if (!isListedStockCode(code)) {
    body.innerHTML = `<div class="empty">这不是正常上市股票代码，通常是 Wind 的 IPO 终止/未上市占位码，已从组合持仓中剔除。</div>`;
    return;
  }
  body.innerHTML = `<div class="loading">查询中…</div>`;
  try {
    await ensureStockMetaSnapshot();
    let scoreRows = await loadStockFactorDetails(code);
    let metaRow = metaRowFromSnapshot(code);
    if (!scoreRows.length) {
      body.innerHTML = `<div class="empty">该股在当前截面没有任何因子打分（可能已停牌/退市，或不在因子覆盖域）</div>`;
      return;
    }
    body.innerHTML = renderStockDetailBody(scoreRows, metaRow);
  } catch (e) {
    console.warn("stock detail fast path failed, falling back to DuckDB:", e);
    try {
      await ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
      await ensureAllFactorData({ backtest: false, ic: false });
      const esc = code.replace(/'/g, "''");
      const scoreRows = (await state.db.query(
        `SELECT factor_code, score, raw_value FROM (
           SELECT factor_code, score, raw_value,
                  ROW_NUMBER() OVER (PARTITION BY factor_code ORDER BY trade_date DESC) rn
           FROM factor_score WHERE stock_code = '${esc}' AND score IS NOT NULL
         ) WHERE rn = 1`)).toArray();
      const metaRow = (await state.db.query(
        `SELECT industry_sw1, industry_sw2, market_cap, pe, pb
         FROM stock_descriptors WHERE stock_code = '${esc}' LIMIT 1`)).toArray()[0];
      if (!scoreRows.length) {
        body.innerHTML = `<div class="empty">该股在当前截面没有任何因子打分（可能已停牌/退市，或不在因子覆盖域）</div>`;
        return;
      }
      body.innerHTML = renderStockDetailBody(scoreRows, metaRow);
    } catch (fallbackErr) {
      body.innerHTML = `<div class="empty">查询失败：${htmlText(fallbackErr.message || fallbackErr)}</div>`;
    }
  }
}

// 事件委托：点任意 .stock-row 开弹窗；点遮罩/× 关闭；Esc 关闭
document.addEventListener("click", (e) => {
  const row = e.target.closest ? e.target.closest("tr.stock-row") : null;
  if (row && row.dataset.stock) { showStockDetail(row.dataset.stock, row.dataset.name || ""); return; }
  if (e.target.id === "stock-modal" || (e.target.classList && e.target.classList.contains("sd-close"))) closeStockModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeStockModal(); });
window.addEventListener("resize", () => {
  [
    navChart, quantileChart, scanChart,
    icDecayChart,
    group10ValidationChart, rolling36mChart, segmentHeatmapChart, segmentPortfolioChart,
    cmpNavChart, cmpIcChart, cmpCorrChart,
    cpsNavChart, cpsIcDecayChart, cpsCompareChart,
    topMktcapChart, topIndustryChart,
  ].forEach(ch => { if (ch && ch.resize) ch.resize(); });
});

bindScanButtons();
bindModeButtons();
bindCmpDefaultButtons();
bindComposeButtons();
init();
