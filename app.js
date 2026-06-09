// 因子库前端入口。M1 范围：目录树 + 单因子选中 → 表格 + 净值图 + KPI。

// DuckDB-Wasm runs in a Worker with no notion of the page's "data/" relative path.
// Use absolute URLs (resolved against page origin) for every read_parquet() call.
const DATA_DIR = new URL("data/", document.baseURI).toString();
// Cache-busting 版本号。部署时 deploy 脚本会把 "20260609093738" 替换成提交版本号：
//   - 本地（serve.py，未替换）→ 用 Date.now() 每次刷新强制重下，重跑流水线换数据后立即生效；
//   - 部署后（已替换成稳定版本号）→ 浏览器可缓存 parquet，刷新/再访问秒开，只有重新部署才重下。
// 用 "DEPLOY"+"_VERSION" 拼接判断，避免这行自己被替换。
const _DEPLOY = "20260609093738";
const V = _DEPLOY === ("DEPLOY" + "_VERSION") ? `?v=${Date.now()}` : `?v=${_DEPLOY}`;
const F_META  = DATA_DIR + "stock_meta.parquet" + V;
const SAVED_COMBOS = DATA_DIR + "saved_combos.json" + V;
const SINGLE_SNAPSHOT_DIR = DATA_DIR + "single_snapshots/";
const STOCK_FACTOR_DETAIL_DIR = DATA_DIR + "stock_factor_details/";
const STOCK_META_SNAPSHOT = DATA_DIR + "stock_meta_snapshot.json" + V;
const BENCHMARK_SNAPSHOT = DATA_DIR + "benchmark_snapshot.json" + V;
const RANKING_SNAPSHOT = DATA_DIR + "factor_ranking_snapshot.json" + V;
const CORR_SNAPSHOT = DATA_DIR + "factor_corr_snapshot.json" + V;
const SCORE_LATEST_DIR = DATA_DIR + "factor_scores_latest/";
const BACKTEST_DIR = DATA_DIR + "backtests/";
const FACTOR_IC_DIR = DATA_DIR + "factor_ics/";
const COMPOSE_SCORE_DIR = DATA_DIR + "compose_scores/";
const MY_COMBOS_KEY = "factorlib.compose.myCombos.v1";
const SUPABASE_URL = "https://tsyplhfshxzoduynzixk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6osvaEI8pookLkmkzBUbHQ_kyUU2SKn";
let _myComboIdSeq = 0;

const state = {
  catalog: [],
  activeFactor: null,
  selectedNs: [30],        // 单因子模式：要对比的持仓数集合（至少 1 个）
  scanMetric: "annual",    // 指标-N 曲线的纵轴：annual / sharpe / mdd / vol
  singleStart: null,       // 单因子回测区间起/止月（YYYY-MM）；null=不限
  singleEnd: null,
  mode: "single",          // single | compare | compose | library | ranking
  compareFactors: [],      // 对比模式：[{code, n}]，每个因子可设不同持仓数
  compareDefaultN: 30,     // 新加入因子的默认持仓数
  compareStart: null,      // 多因子对比回测区间；null=不限
  compareEnd: null,
  // 合成模式：[{code, weight, op:'>='|'<=', thr:number|null}]，thr=null 表示该因子不参与过滤
  composeFactors: [],
  composeN: 30,
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
  adminSession: null,
  adminRequests: [],
  adminPublishedCombos: [],
  singleSnapshots: new Map(),
  stockFactorDetailBuckets: new Map(),
  stockMetaSnapshot: null,
  benchmarkSnapshot: null,
  rankingSnapshot: null,
  corrSnapshot: null,
  hasStockMeta: false,
  hasDescriptors: false,
  hasBenchmarks: false,
  hasCorr: false,
  duckdb: null,
  db: null,
};

let navChart = null;
let scanChart = null;
let cmpNavChart = null, cmpIcChart = null, cmpCorrChart = null;
let cpsNavChart = null;

// 多条策略线的配色（按 selectedNs 顺序取）
const STRAT_COLORS = ["#1a4d80", "#e07b39", "#3a9d6e", "#9b59b6", "#c0392b", "#16a085"];

async function init() {
  await loadCatalog();
  await loadPublishedCombos();
  loadMyCombos();
  renderTree();
  bindFactorSearch();
  document.getElementById("meta").textContent =
    `${state.catalog.length} 因子可用`;
  runWhenIdle(() => scheduleDuckDbWarmup(0), 5000, 3000);
}

async function loadCatalog() {
  const res = await fetch("data/factor_catalog.json" + V);
  state.catalog = await res.json();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function singleSnapshotUrl(code) {
  return `${SINGLE_SNAPSHOT_DIR}${code}.json${V}`;
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

function normalizeComposeFactor(f) {
  return {
    code: f.code,
    weight: Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0,
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
          CREATE OR REPLACE TABLE factor_corr (factor_a VARCHAR, factor_b VARCHAR, corr DOUBLE)
        `);
      _optionalReady.corr = true;
    }
    console.log(`Optional: stockMeta=${state.hasStockMeta}, descriptors=${state.hasDescriptors}, benchmarks=${state.hasBenchmarks}, corr=${state.hasCorr}`);
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
        trade_date DATE, port_ret DOUBLE, nav DOUBLE, factor_code VARCHAR, top_n INTEGER
      )
    `);
    await state.db.query(`
      CREATE TABLE factor_ic (
        month DATE, factor_code VARCHAR, ic DOUBLE, rank_ic DOUBLE, ic_ir_12m DOUBLE
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
      CREATE TABLE factor_corr (factor_a VARCHAR, factor_b VARCHAR, corr DOUBLE)
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
        SELECT trade_date, port_ret, nav, factor_code, top_n
        FROM ${factorReadExpr(BACKTEST_DIR, missingBacktests)}
      `);
      missingBacktests.forEach(code => _loadedBacktests.add(code));
    }
    if (missingIcs.length) {
      await state.db.query(`
        INSERT INTO factor_ic
        SELECT month, factor_code, ic, rank_ic, ic_ir_12m
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
  detail.innerHTML = `<h3 style="color:#c00">错误</h3><pre style="color:#c00;white-space:pre-wrap;font-size:11px">${msg}</pre>`;
}

async function selectFactor(code) {
  const seq = ++_singleRenderSeq;
  state.activeFactor = code;
  document.querySelectorAll(".tree-l3").forEach(el => {
    el.classList.toggle("active", el.dataset.code === code);
  });
  const meta = state.catalog.find(f => f.code === code);
  try {
    const tAll = performance.now();
    const [snap] = await Promise.all([
      loadSingleSnapshot(code),
      ensureBenchmarkSnapshot(),
    ]);
    if (seq !== _singleRenderSeq) return;
    await initSingleRangeControlsFast(snap);
    renderFactorDetail(meta);
    const tQ = performance.now();
    await Promise.all([
      (async () => { const t = performance.now(); await renderTopStocksFast(code, snap); console.log(`  top table: ${(performance.now()-t).toFixed(0)}ms`); })(),
      (async () => { const t = performance.now(); await renderKpiTableFast(code, snap); console.log(`  kpi: ${(performance.now()-t).toFixed(0)}ms`); })(),
    ]);
    if (seq !== _singleRenderSeq) return;
    console.log(`selectFactor(${code}, N=[${state.selectedNs}]) fast critical ${(performance.now()-tAll).toFixed(0)}ms (render ${(performance.now()-tQ).toFixed(0)}ms)`);
    renderSingleDeferredCharts(code, snap, seq);
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
      const tQ = performance.now();
      await Promise.all([
        (async () => { const t = performance.now(); await renderTopStocks(code); console.log(`  top table: ${(performance.now()-t).toFixed(0)}ms`); })(),
        (async () => { const t = performance.now(); await renderNavChart(code); console.log(`  nav chart: ${(performance.now()-t).toFixed(0)}ms`); })(),
        (async () => { const t = performance.now(); await renderNScan(code); console.log(`  N-scan:    ${(performance.now()-t).toFixed(0)}ms`); })(),
        (async () => { const t = performance.now(); await renderKpiTable(code); console.log(`  kpi: ${(performance.now()-t).toFixed(0)}ms`); })(),
      ]);
      console.log(`selectFactor(${code}, N=[${state.selectedNs}]) fallback total ${(performance.now()-tAll).toFixed(0)}ms (queries ${(performance.now()-tQ).toFixed(0)}ms)`);
    } catch (fallbackErr) {
      if (seq !== _singleRenderSeq) return;
      console.error("selectFactor failed:", fallbackErr);
      showError(`选择因子 ${code} 失败: ${fallbackErr.message || fallbackErr}\n\n${fallbackErr.stack || ""}`);
    }
  }
}

function renderSingleDeferredCharts(code, snap, seq) {
  runWhenIdle(async () => {
    if (seq !== _singleRenderSeq || state.activeFactor !== code) return;
    const t = performance.now();
    try {
      await renderNavChartFast(code, snap);
      console.log(`  nav chart: ${(performance.now() - t).toFixed(0)}ms`);
    } catch (err) {
      console.warn("deferred nav chart failed:", err);
    }
  }, 0, 800);
  runWhenIdle(async () => {
    if (seq !== _singleRenderSeq || state.activeFactor !== code) return;
    const t = performance.now();
    try {
      await renderNScanFast(code, snap);
      console.log(`  N-scan:    ${(performance.now() - t).toFixed(0)}ms`);
      if (seq === _singleRenderSeq) {
        console.log(`selectFactor(${code}, N=[${state.selectedNs}]) fast complete`);
      }
    } catch (err) {
      console.warn("deferred N-scan failed:", err);
    }
  }, 80, 900);
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

function renderFactorDetail(meta) {
  const dirArrow = meta.direction === 1 ? "↑（越高越好）" : "↓（越低越好）";
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
    <p><b>${meta.l1} → ${meta.l2}</b>　方向：${dirArrow}</p>
    ${tagBlock}
    <p>${meta.description}</p>
    ${formulaBlock}
    ${sourceBlock}
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
      口径：每月末按 <b>${meta.code}</b> z-score 排序选非 ST 股等权持有，扣 0.2% 双边成本，2015-01 ~ 2025-12。
    </p>
  `;
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
    head = `<h3>${code} · Top ${N} 股票（近6月快报池，按 z-score 降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
      <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">
        事件因子：每股取其<b>最近一期业绩快报</b>（池含 ${lo} ~ ${hi} 的快报月，去重后取最高一期）；
        年末三季报快报稀少，故按近 6 个快报月汇总。申万行业 / 市值 / PE / PB 为最新快照。
      </p>`;
  } else {
    const dt = rows[0].dt;
    head = `<h3>${code} · Top ${N} 股票（截面日 ${dt}，按 z-score 降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
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

async function renderTopStocksFast(code, snap) {
  const N = maxN();
  const target = document.getElementById("top-stocks");
  const meta = state.catalog.find(f => f.code === code) || {};
  const isEvent = !!meta.is_event;
  const rows = (snap.top_stocks || []).slice(0, N);
  if (!rows.length) {
    target.innerHTML = `<h3>${code} · Top ${N} 股票</h3><div class="empty">无数据（该因子该截面无有效得分）</div>`;
    return;
  }
  const descNote = " <span style='color:#aaa;font-size:11px'>(快照)</span>";
  let head;
  if (isEvent) {
    const dts = rows.map(r => r.dt).filter(Boolean).sort();
    const lo = dts[0] || "—", hi = dts[dts.length - 1] || "—";
    head = `<h3>${code} · Top ${N} 股票（近6月快报池，按 z-score 降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
      <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">
        事件因子：每股取其<b>最近一期业绩快报</b>（池含 ${lo} ~ ${hi} 的快报月，去重后取最高一期）；
        年末三季报快报稀少，故按近 6 个快报月汇总。申万行业 / 市值 / PE / PB 为最新快照。
      </p>`;
  } else {
    const dt = rows[0].dt || "—";
    head = `<h3>${code} · Top ${N} 股票（截面日 ${dt}，按 z-score 降序）${descNote} <span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
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
    `${code} · 组合净值对比 top-[${ns.join(", ")}]（起点=1.0；${rng}，月末等权，0.2%双边成本）`;

  const chartDiv = document.getElementById("nav-chart");
  if (navChart) { navChart.dispose(); navChart = null; }
  chartDiv.innerHTML = "";

  // 查所选各 N 在区间内的月度收益，区间内从 1.0 重建净值（口径对齐所选区间）
  const inList = ns.join(",");
  const res = await state.db.query(`
    SELECT top_n, strftime(trade_date, '%Y-%m') AS dt, port_ret
    FROM preset_backtest
    WHERE factor_code = '${code}' AND top_n IN (${inList})
      ${rangeWhere(state.singleStart, state.singleEnd)}
    ORDER BY top_n, trade_date
  `);
  const byN = {};
  for (const r of res.toArray()) {
    if (!byN[r.top_n]) byN[r.top_n] = { dt: [], nav: [], _pr: null };
    const o = byN[r.top_n];
    o.dt.push(r.dt);
    // 起点=1.0；port_ret 是「未来收益」(T→T+1)，当月收益体现在下一个点，
    // 与基准（月末价归一、首点=1.0）口径一致，避免净值首点≠1、且因 N 不同而异。
    o.nav.push(o.nav.length ? o.nav[o.nav.length - 1] * (1 + (o._pr ?? 0)) : 1.0);
    o._pr = r.port_ret;
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
      WHERE strftime(trade_date, '%Y-%m') >= '${x[0]}'
        AND strftime(trade_date, '%Y-%m') <= '${x[x.length - 1]}'
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
      const aligned = x.map(m => (m in monthMap ? monthMap[m] : null));
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
    `${code} · 组合净值对比 top-[${ns.join(", ")}]（起点=1.0；${rng}，月末等权，0.2%双边成本）`;

  const chartDiv = document.getElementById("nav-chart");
  if (navChart) { navChart.dispose(); navChart = null; }
  chartDiv.innerHTML = "";

  const months = monthsFromSnapshot(snap);
  const idxs = rangeFilterIndexes(months, state.singleStart, state.singleEnd);
  const x = idxs.map(i => months[i]);
  const series = [];
  ns.forEach((n, i) => {
    const bt = snap.backtests?.[String(n)];
    if (!bt) return;
    const rets = sliceByIndexes(bt.ret, idxs);
    series.push({
      name: `top${n}`,
      type: "line",
      data: navFromReturnsForChart(rets),
      symbol: "none",
      color: STRAT_COLORS[i % STRAT_COLORS.length],
      lineStyle: { width: 2 },
    });
  });

  const bm = await ensureBenchmarkSnapshot();
  const colors = { "HS300": "#c14545", "CSI800": "#6e9a4f", "CSI500": "#c89c2b" };
  const cnNames = { "HS300": "沪深300", "CSI800": "中证800", "CSI500": "中证500" };
  for (const idxCode of ["HS300", "CSI800", "CSI500"]) {
    const rebased = rebaseNav(benchmarkSeries(bm, x, idxCode));
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
  const std = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const sharpe = std > 0 ? mean / std * Math.sqrt(12) : 0;
  let peak = navs[0], mdd = 0;
  for (const v of navs) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  const winRate = rets.filter(r => r > 0).length / n;
  const navEnd = navs[navs.length - 1] / navs[0];
  const vol = std * Math.sqrt(12);   // 年化波动率
  return { annual, sharpe, mdd, winRate, navEnd, vol };
}

function metricsFromReturns(rets) {
  const clean = (rets || []).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  if (!clean.length) return null;
  const navs = [1];
  for (const r of clean) navs.push(navs[navs.length - 1] * (1 + r));
  return computeMetrics(clean, navs);
}

function monthsFromSnapshot(snap) {
  return (snap && Array.isArray(snap.months)) ? snap.months : [];
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
  const idxs = rangeFilterIndexes(bt.x, startMonth, endMonth);
  const x = [], retArr = [];
  for (const i of idxs) {
    const r = bt.retArr[i];
    if (r === null || r === undefined || !Number.isFinite(Number(r))) continue;
    x.push(bt.x[i]);
    retArr.push(Number(r));
  }
  return { x, retArr, navArr: navFromReturnsForChart(retArr) };
}

function navFromReturnsForChart(rets) {
  const out = [];
  let nav = 1;
  for (const r of rets) {
    out.push(+nav.toFixed(6));
    nav *= 1 + r;
  }
  return out;
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
      ${rangeWhere(state.singleStart, state.singleEnd)}
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

  // 因子级 IC_IR（与 N 无关）：区间内 RankIC 均值 / 标准差 × √12（年化）
  const icRes = await state.db.query(`
    SELECT AVG(rank_ic) m, STDDEV_SAMP(rank_ic) s, COUNT(rank_ic) n FROM factor_ic
    WHERE factor_code = '${code}' AND NOT ISNAN(rank_ic)
      ${rangeWhere(state.singleStart, state.singleEnd, "month")}
  `);
  const icRow = icRes.toArray()[0];
  const icir = (icRow && icRow.s > 0 && icRow.n >= 2)
    ? (icRow.m / icRow.s * Math.sqrt(12)).toFixed(2) : "—";

  const pct = (v) => (v * 100).toFixed(1) + "%";
  const signed = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
  let rows = "";
  for (const n of state.selectedNs) {
    const d = byN[n];
    const m = d ? computeMetrics(d.rets, d.navs) : null;
    if (!m) { rows += `<tr><td>top${n}</td><td colspan="6">无数据</td></tr>`; continue; }
    const ex300 = ("HS300" in ba) ? signed(m.annual - ba.HS300) : "—";
    const ex800 = ("CSI800" in ba) ? signed(m.annual - ba.CSI800) : "—";
    rows += `<tr>
      <td>top${n}</td>
      <td>${pct(m.annual)}</td>
      <td>${m.sharpe.toFixed(2)}</td>
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
        <td>${m.sharpe.toFixed(2)}</td>
        <td>${pct(m.mdd)}</td>
        <td>${(m.winRate * 100).toFixed(0)}%</td>
        <td>—</td><td>—</td>
      </tr>`;
    }
  }

  target.innerHTML = `
    <table class="kpi-table">
      <thead><tr>
        <th>组合 / 基准</th><th>年化收益</th><th>夏普</th><th>最大回撤</th>
        <th>月度胜率</th><th>超额 vs 300</th><th>超额 vs 800</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">区间内 RankIC IC_IR：${icir}（与持仓数无关）</p>
  `;
}

async function renderKpiTableFast(code, snap) {
  const target = document.getElementById("kpi");
  const months = monthsFromSnapshot(snap);
  const idxs = rangeFilterIndexes(months, state.singleStart, state.singleEnd);
  const bm = await ensureBenchmarkSnapshot();
  const bmMetrics = benchmarkMetrics(bm, state.singleStart, state.singleEnd);
  const icMonths = snap.ic?.months || [];
  const icIdxs = rangeFilterIndexes(icMonths, state.singleStart, state.singleEnd);
  const rankIcs = sliceByIndexes(snap.ic?.rank_ic, icIdxs);
  const mean = rankIcs.length ? rankIcs.reduce((s, v) => s + v, 0) / rankIcs.length : null;
  const std = rankIcs.length > 1
    ? Math.sqrt(rankIcs.reduce((s, v) => s + (v - mean) ** 2, 0) / (rankIcs.length - 1))
    : null;
  const icir = std && std > 0 ? (mean / std * Math.sqrt(12)).toFixed(2) : "—";

  let rows = "";
  for (const n of state.selectedNs) {
    const bt = snap.backtests?.[String(n)];
    const m = bt ? metricsFromReturns(sliceByIndexes(bt.ret, idxs)) : null;
    if (!m) { rows += `<tr><td>top${n}</td><td colspan="6">无数据</td></tr>`; continue; }
    rows += `<tr>
      <td>top${n}</td>
      <td>${pctText(m.annual)}</td>
      <td>${m.sharpe.toFixed(2)}</td>
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
      <td>${m.sharpe.toFixed(2)}</td>
      <td>${pctText(m.mdd)}</td>
      <td>${(m.winRate * 100).toFixed(0)}%</td>
      <td>—</td><td>—</td>
    </tr>`;
  }

  target.innerHTML = `
    <table class="kpi-table">
      <thead><tr>
        <th>组合 / 基准</th><th>年化收益</th><th>夏普</th><th>最大回撤</th>
        <th>月度胜率</th><th>超额 vs 300</th><th>超额 vs 800</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;margin-top:6px">区间内 RankIC IC_IR：${icir}（与持仓数无关）</p>
  `;
}

// 指标-N 曲线：横轴持仓数 1-100，纵轴当前选定指标
async function renderNScan(code) {
  const metricLabels = { annual: "年化收益", sharpe: "夏普比率", mdd: "最大回撤", vol: "波动率" };
  document.getElementById("scan-title").textContent =
    `${code} · ${metricLabels[state.scanMetric]} vs 持仓数（top-1 ~ top-100 全扫描）`;
  const chartDiv = document.getElementById("scan-chart");
  if (scanChart) { scanChart.dispose(); scanChart = null; }
  chartDiv.innerHTML = "";

  const res = await state.db.query(`
    SELECT top_n, port_ret FROM preset_backtest
    WHERE factor_code = '${code}'
      ${rangeWhere(state.singleStart, state.singleEnd)}
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
    if (state.scanMetric === "sharpe") return +m.sharpe.toFixed(3);
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
  const metricLabels = { annual: "年化收益", sharpe: "夏普比率", mdd: "最大回撤", vol: "波动率" };
  document.getElementById("scan-title").textContent =
    `${code} · ${metricLabels[state.scanMetric]} vs 持仓数（top-1 ~ top-100 全扫描）`;
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
    if (state.scanMetric === "sharpe") return +m.sharpe.toFixed(3);
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
    selectFactor(code);
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
  state.compareFactors.push({ code, n: state.compareDefaultN });
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
  box.innerHTML = state.compareFactors.map((f, i) => `
    <span class="cmp-frow" style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 6px 0">
      <span style="width:10px;height:10px;border-radius:50%;background:${STRAT_COLORS[i % STRAT_COLORS.length]};display:inline-block"></span>
      <b style="font-size:12px">${f.code}</b>
      <span style="color:#888;font-size:11px">top</span>
      <input class="cmp-n-input" data-idx="${i}" type="number" min="1" max="100" value="${f.n}"
             style="width:52px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:12px" />
      <span class="cmp-remove" data-idx="${i}"
            style="cursor:pointer;color:#c14545;font-size:13px;padding:0 2px">×</span>
    </span>
  `).join("");
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
  box.querySelectorAll(".cmp-remove").forEach(x => {
    x.onclick = () => removeCompareAt(parseInt(x.dataset.idx, 10));
  });
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
      ${rangeWhere(state.compareStart, state.compareEnd)}
    ORDER BY factor_code, top_n, trade_date
  `);
  const byKey = {};
  for (const r of res.toArray()) {
    const k = `${r.factor_code}_${r.top_n}`;
    if (!byKey[k]) byKey[k] = { rets: [], navs: [] };
    if (r.port_ret !== null) byKey[k].rets.push(r.port_ret);
    if (r.nav !== null) byKey[k].navs.push(r.nav);
  }
  // 各因子 IC 统计（与 N 无关）
  const icRes = await state.db.query(`
    SELECT factor_code,
           AVG(ic) AS ic_mean, AVG(rank_ic) AS rankic_mean
    FROM factor_ic WHERE factor_code IN (${inList}) AND NOT ISNAN(ic)
      ${rangeWhere(state.compareStart, state.compareEnd, "month")}
    GROUP BY factor_code
  `);
  const icMap = {};
  for (const r of icRes.toArray()) icMap[r.factor_code] = r;
  const icirRes = await state.db.query(`
    SELECT factor_code, ic_ir_12m FROM factor_ic
    WHERE factor_code IN (${inList}) AND ic_ir_12m IS NOT NULL AND NOT ISNAN(ic_ir_12m)
      ${rangeWhere(state.compareStart, state.compareEnd, "month")}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY factor_code ORDER BY month DESC) = 1
  `);
  const icirMap = {};
  for (const r of icirRes.toArray()) icirMap[r.factor_code] = r.ic_ir_12m;

  const ba = await benchAnnuals();
  const pct = (v) => (v * 100).toFixed(1) + "%";
  const num = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v).toFixed(d));

  // 收集成行对象（数值留原始值，渲染时再格式化），供点表头排序用
  const factors = [];
  for (const f of state.compareFactors) {
    const code = f.code;
    const d = byKey[`${code}_${f.n}`];
    const m = d ? computeMetrics(d.rets, d.navs) : null;
    const ic = icMap[code] || {};
    const label = `${code} <span style="color:#888;font-weight:400">top${f.n}</span>`;
    if (!m) { factors.push({ label, noData: true }); continue; }
    factors.push({
      label, annual: m.annual, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      ex300: ("HS300" in ba) ? (m.annual - ba.HS300) : null,
      ic_mean: (ic.ic_mean ?? null), icir: (icirMap[code] ?? null),
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
      benches.push({ label: cn[idx], annual: m.annual, sharpe: m.sharpe, mdd: m.mdd,
                     winRate: m.winRate, ex300: null, ic_mean: null, icir: null });
    }
  }
  _cmpRows = { factors, benches };
  drawCmpTable();
}

async function renderCmpTableFast() {
  const target = document.getElementById("cmp-table");
  document.getElementById("cmp-table-title").textContent = `因子指标对比表（各因子可设不同持仓数）`;
  if (state.compareFactors.length === 0) {
    target.innerHTML = `<div class="empty">从左侧选 1 个以上因子开始对比</div>`;
    return;
  }
  const bm = await ensureBenchmarkSnapshot();
  const ba = benchmarkMetrics(bm, state.compareStart, state.compareEnd);
  const factors = [];
  for (const f of state.compareFactors) {
    const snap = await loadSingleSnapshot(f.code);
    const bt = snap.backtests?.[String(f.n)];
    const months = monthsFromSnapshot(snap);
    const idxs = rangeFilterIndexes(months, state.compareStart, state.compareEnd);
    const m = bt ? metricsFromReturns(sliceByIndexes(bt.ret, idxs)) : null;
    const icMonths = snap.ic?.months || [];
    const icIdxs = rangeFilterIndexes(icMonths, state.compareStart, state.compareEnd);
    const rankIc = sliceByIndexes(snap.ic?.rank_ic, icIdxs);
    const icVals = sliceByIndexes(snap.ic?.ic, icIdxs);
    const label = `${f.code} <span style="color:#888;font-weight:400">top${f.n}</span>`;
    if (!m) { factors.push({ label, noData: true }); continue; }
    const ricMean = rankIc.length ? rankIc.reduce((s, v) => s + v, 0) / rankIc.length : null;
    const icMean = icVals.length ? icVals.reduce((s, v) => s + v, 0) / icVals.length : null;
    const icirs = icIdxs.map(i => snap.ic?.ic_ir_12m?.[i]);
    const latestIcir = [...icirs].reverse()
      .find(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
    factors.push({
      label, annual: m.annual, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      ex300: ba.HS300 ? (m.annual - ba.HS300.annual) : null,
      ic_mean: icMean ?? ricMean, icir: latestIcir ?? null,
    });
  }

  const benches = [];
  const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
  for (const idx of ["HS300", "CSI800", "CSI500"]) {
    const m = ba[idx];
    if (!m) continue;
    benches.push({ label: cn[idx], annual: m.annual, sharpe: m.sharpe, mdd: m.mdd,
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
    { key: "sharpe",  label: "夏普",       cell: r => num(r.sharpe, 2) },
    { key: "mdd",     label: "最大回撤",   cell: r => pct(r.mdd) },
    { key: "winRate", label: "月度胜率",   cell: r => r.winRate == null ? "—" : (r.winRate * 100).toFixed(0) + "%" },
    { key: "ex300",   label: "超额 vs 300", cell: r => pct(r.ex300) },
    { key: "ic_mean", label: "IC 均值",    cell: r => num(r.ic_mean, 3) },
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
    if (r.noData) return `<tr><td>${r.label}</td><td colspan="7">无数据</td></tr>`;
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
    SELECT factor_code, top_n, strftime(trade_date,'%Y-%m') AS dt, nav
    FROM preset_backtest WHERE ${cmpPairCond()}
      ${rangeWhere(state.compareStart, state.compareEnd)}
    ORDER BY factor_code, top_n, trade_date
  `);
  const byKey = {};
  for (const r of res.toArray()) { const k = `${r.factor_code}_${r.top_n}`; (byKey[k] ||= { dt: [], nav: [] }); byKey[k].dt.push(r.dt); byKey[k].nav.push(r.nav); }
  const first = state.compareFactors[0];
  const x = (byKey[`${first.code}_${first.n}`] || { dt: [] }).dt;
  const series = state.compareFactors.map((f, i) => {
    const s = byKey[`${f.code}_${f.n}`]; if (!s) return null;
    const base = s.nav[0] || 1;
    return { name: `${f.code} top${f.n}`, type: "line", symbol: "none",
             data: s.nav.map(v => v / base),
             color: STRAT_COLORS[i % STRAT_COLORS.length],
             lineStyle: { width: 2 } };
  }).filter(Boolean);

  if (state.hasBenchmarks && x.length) {
    const bmRes = await state.db.query(`
      SELECT index_code, strftime(trade_date,'%Y-%m') AS dt, nav FROM benchmarks
      WHERE strftime(trade_date,'%Y-%m') >= '${x[0]}' AND strftime(trade_date,'%Y-%m') <= '${x[x.length-1]}'
      ORDER BY index_code, trade_date
    `);
    const byIdx = {};
    for (const r of bmRes.toArray()) { (byIdx[r.index_code] ||= {})[r.dt] = r.nav; }
    const colors = { HS300: "#c14545", CSI800: "#6e9a4f", CSI500: "#c89c2b" };
    const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
    for (const idx of ["HS300", "CSI800", "CSI500"]) {
      const mm = byIdx[idx]; if (!mm) continue;
      const aligned = x.map(m => (m in mm ? mm[m] : null));
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
  document.getElementById("cmp-nav-title").textContent = `组合净值叠加（各因子按各自持仓数，起点=1.0；${rng}）`;
  const div = document.getElementById("cmp-nav-chart");
  if (cmpNavChart) { cmpNavChart.dispose(); cmpNavChart = null; }
  div.innerHTML = "";
  if (state.compareFactors.length === 0) { div.innerHTML = `<div class="empty">选因子后显示</div>`; return; }

  const snaps = await Promise.all(state.compareFactors.map(f => loadSingleSnapshot(f.code)));
  const months = monthsFromSnapshot(snaps[0] || {});
  const idxs = rangeFilterIndexes(months, state.compareStart, state.compareEnd);
  const x = idxs.map(i => months[i]);
  const series = state.compareFactors.map((f, i) => {
    const snap = snaps[i];
    const bt = snap.backtests?.[String(f.n)];
    if (!bt) return null;
    const rets = sliceByIndexes(bt.ret, idxs);
    return { name: `${f.code} top${f.n}`, type: "line", symbol: "none",
             data: navFromReturnsForChart(rets),
             color: STRAT_COLORS[i % STRAT_COLORS.length],
             lineStyle: { width: 2 } };
  }).filter(Boolean);

  const bm = await ensureBenchmarkSnapshot();
  const colors = { HS300: "#c14545", CSI800: "#6e9a4f", CSI500: "#c89c2b" };
  const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
  for (const idx of ["HS300", "CSI800", "CSI500"]) {
    const rebased = rebaseNav(benchmarkSeries(bm, x, idx));
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

  // IC 与持仓数无关 → 按因子去重
  const uniqCodes = [...new Set(state.compareFactors.map(f => f.code))];
  const inList = uniqCodes.map(c => `'${c}'`).join(",");
  // 12 月滚动 IC 均值，平滑噪声，更易对比
  const res = await state.db.query(`
    SELECT factor_code, strftime(month,'%Y-%m') AS dt,
           AVG(ic) OVER (PARTITION BY factor_code ORDER BY month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS ic12
    FROM factor_ic WHERE factor_code IN (${inList}) AND NOT ISNAN(ic)
      ${rangeWhere(state.compareStart, state.compareEnd, "month")}
    ORDER BY factor_code, month
  `);
  const byF = {};
  for (const r of res.toArray()) { (byF[r.factor_code] ||= { dt: [], ic: [] }); byF[r.factor_code].dt.push(r.dt); byF[r.factor_code].ic.push(r.ic12); }
  const x = (byF[uniqCodes[0]] || { dt: [] }).dt;
  const series = uniqCodes.map((code, i) => {
    const s = byF[code]; if (!s) return null;
    return { name: code, type: "line", symbol: "none", data: s.ic,
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

  const uniqCodes = [...new Set(state.compareFactors.map(f => f.code))];
  const snaps = await Promise.all(uniqCodes.map(code => loadSingleSnapshot(code)));
  const icMonths = snaps[0]?.ic?.months || [];
  const idxs = rangeFilterIndexes(icMonths, state.compareStart, state.compareEnd);
  const x = idxs.map(i => icMonths[i]);
  const series = snaps.map((snap, i) => {
    const vals = snap.ic?.ic || [];
    const rolling = vals.map((_, idx) => {
      const win = vals.slice(Math.max(0, idx - 11), idx + 1)
        .filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
      return win.length ? +(win.reduce((s, v) => s + v, 0) / win.length).toFixed(6) : null;
    });
    return { name: uniqCodes[i], type: "line", symbol: "none", data: idxs.map(idx => rolling[idx]),
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
    SELECT factor_a, factor_b, corr FROM factor_corr
    WHERE factor_a IN (${inList}) AND factor_b IN (${inList})
  `);
  const cmap = {};
  for (const r of res.toArray()) cmap[`${r.factor_a}|${r.factor_b}`] = r.corr;
  const data = [];
  codes.forEach((a, i) => codes.forEach((b, j) => {
    const c = cmap[`${a}|${b}`];
    data.push([j, i, c === null || c === undefined ? "-" : +c.toFixed(2)]);
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
    tooltip: { position: "top", formatter: p => `${codes[p.data[1]]} × ${codes[p.data[0]]}<br/>corr: ${p.data[2]}` },
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
  const corrSnap = await ensureCorrSnapshot();
  if (!corrSnap.rows || !corrSnap.rows.length) {
    div.innerHTML = `<div class="empty">相关性数据未生成（需跑 scripts/08_factor_corr.py）</div>`;
    return;
  }
  const uniq = [...new Set(state.compareFactors.map(f => f.code))];
  const isAll = uniq.length < 2;
  let codes;
  if (isAll) {
    codes = [...state.catalog]
      .sort((a, b) => (a.l1 + a.l2).localeCompare(b.l1 + b.l2) || a.code.localeCompare(b.code))
      .map(f => f.code);
  } else {
    codes = uniq;
  }
  const want = new Set(codes);
  const cmap = {};
  for (const [a, b, c] of corrSnap.rows) {
    if (want.has(a) && want.has(b)) cmap[`${a}|${b}`] = c;
  }
  const data = [];
  codes.forEach((a, i) => codes.forEach((b, j) => {
    const c = cmap[`${a}|${b}`];
    data.push([j, i, c === null || c === undefined ? "-" : +Number(c).toFixed(2)]);
  }));

  const n = codes.length;
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
    tooltip: { position: "top", formatter: p => `${codes[p.data[1]]} × ${codes[p.data[0]]}<br/>corr: ${p.data[2]}` },
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
  { key: "rank",      label: "#",       lcol: true,  fmt: v => v },
  { key: "code",      label: "因子",    lcol: true,  fmt: v => v },
  { key: "name_cn",   label: "名称",    lcol: true,  fmt: v => v },
  { key: "score",     label: "综合分",  fmt: v => v.toFixed(2), cls: "score-cell" },
  { key: "annual",    label: "年化",    fmt: v => (v * 100).toFixed(1) + "%" },
  { key: "sharpe",    label: "夏普",    fmt: v => v.toFixed(2) },
  { key: "mdd",       label: "最大回撤", fmt: v => (v * 100).toFixed(1) + "%" },
  { key: "winRate",   label: "月胜率",  fmt: v => (v * 100).toFixed(0) + "%" },
  { key: "rankIC",    label: "RankIC均值", fmt: v => v.toFixed(3) },
  { key: "icir",      label: "IC_IR",   fmt: v => v.toFixed(2) },
  { key: "medCap",    label: "中位市值(亿)", fmt: v => v === null ? "—" : Math.round(v).toLocaleString() },
  { key: "capStyle",  label: "市值风格", lcol: true, fmt: v => v },
  { key: "tags",      label: "标签", lcol: true, sortable: false,
    fmt: (_, r) => `<span class="ftag ftag-${r.env_tag}">${r.env_tag}</span> <span class="ftag ftag-${r.time_tag}">${r.time_tag}</span>` },
  { key: "top3ind",   label: "前三行业(最新选股)", lcol: true, fmt: v => v },
];

let _rankState = { rows: null, sortKey: "score", desc: true, checked: new Set(),
                   range: "all", start: null, end: null, tagFilters: new Set() };

const ENV_TAGS = ["牛市进攻型", "熊市防御型", "全天候型", "震荡占优型"];
const TIME_TAGS = ["长期稳定型", "近期转强", "近期失效", "持续低效"];

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

let _rankBarBound = false;
async function renderRanking() {
  const box = document.getElementById("rank-table");
  try {
    if (!_rankBarBound) {
      document.getElementById("rank-to-compare").onclick = () => rankSendTo("compare");
      document.getElementById("rank-to-compose").onclick = () => rankSendTo("compose");
      document.getElementById("rank-clear-sel").onclick = () => { _rankState.checked.clear(); drawRankTable(); };
      buildTagFilters();
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
        document.getElementById("rank-to-compare").onclick = () => rankSendTo("compare");
        document.getElementById("rank-to-compose").onclick = () => rankSendTo("compose");
        document.getElementById("rank-clear-sel").onclick = () => { _rankState.checked.clear(); drawRankTable(); };
        buildTagFilters();
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
      box.innerHTML = `<pre style="color:#c00;white-space:pre-wrap;font-size:11px">排行榜失败：${fallbackErr.message || fallbackErr}</pre>`;
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
    `SELECT DISTINCT strftime(trade_date,'%Y-%m') m FROM preset_backtest ORDER BY m`);
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
  const box = document.getElementById("rank-table");
  box.innerHTML = `<div class="empty">按区间重新计算中…</div>`;
  _rankState.rows = fastMode
    ? await computeRankingFast(_rankState.start, _rankState.end)
    : await computeRanking(_rankState.start, _rankState.end);
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
  const idxs = rangeFilterIndexes(months, startMonth, endMonth);
  const rows = [];
  for (const f of snap.factors || []) {
    const rets = sliceByIndexes(f.top30_ret, idxs);
    const m = metricsFromReturns(rets);
    if (!m) continue;
    const rankIcs = sliceByIndexes(f.rank_ic, idxs);
    const rankIC = rankIcs.length ? rankIcs.reduce((s, v) => s + v, 0) / rankIcs.length : 0;
    let icir = 0;
    if (rankIcs.length > 1) {
      const mean = rankIC;
      const std = Math.sqrt(rankIcs.reduce((s, v) => s + (v - mean) ** 2, 0) / (rankIcs.length - 1));
      icir = std > 0 ? mean / std * Math.sqrt(12) : 0;
    }
    rows.push({
      code: f.code, name_cn: f.name_cn, l1: f.l1, l2: f.l2,
      annual: m.annual, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      rankIC, icir,
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
  // 区间过滤条件（作用于 trade_date / month）
  const btWhere = ["top_n = 30"];
  // 剔除 NaN 的 RankIC 月（稀疏因子在某些月份截面 <3 只票，04 算 IC 得 NaN）。
  // 否则 AVG/STDDEV 遇 NaN 会传染成 NaN → 排行榜 RankIC/IC_IR 显示 0。与 602/856/993 行其它 IC 查询口径一致。
  const icWhere = ["NOT ISNAN(rank_ic)"];
  if (startMonth) { btWhere.push(`strftime(trade_date,'%Y-%m') >= '${startMonth}'`); icWhere.push(`strftime(month,'%Y-%m') >= '${startMonth}'`); }
  if (endMonth)   { btWhere.push(`strftime(trade_date,'%Y-%m') <= '${endMonth}'`);   icWhere.push(`strftime(month,'%Y-%m') <= '${endMonth}'`); }
  const icWhereSql = icWhere.length ? "WHERE " + icWhere.join(" AND ") : "";

  // 1) top-30 区间内的月度收益 → 在区间内重建 NAV（从 1.0 起），再算年化/夏普/回撤/胜率
  const btRes = await state.db.query(`
    SELECT factor_code, port_ret FROM preset_backtest
    WHERE ${btWhere.join(" AND ")} ORDER BY factor_code, trade_date
  `);
  const series = new Map();   // code → {rets, navs}
  for (const r of btRes.toArray()) {
    if (!series.has(r.factor_code)) series.set(r.factor_code, { rets: [], navs: [] });
    const o = series.get(r.factor_code);
    o.rets.push(r.port_ret);
    const prev = o.navs.length ? o.navs[o.navs.length - 1] : 1;
    o.navs.push(prev * (1 + r.port_ret));   // 区间内重建净值，保证回撤/年化口径对齐区间
  }
  // 2) IC 统计：区间内 RankIC 均值 + IC_IR（= RankIC均值 / RankIC标准差 × √12，年化）
  const icRes = await state.db.query(`
    SELECT factor_code,
           AVG(rank_ic) AS rank_ic_mean,
           STDDEV_SAMP(rank_ic) AS rank_ic_std,
           COUNT(rank_ic) AS n
    FROM factor_ic ${icWhereSql} GROUP BY factor_code
  `);
  const icStat = new Map();
  for (const r of icRes.toArray()) {
    const ir = (r.rank_ic_std && r.rank_ic_std > 0) ? r.rank_ic_mean / r.rank_ic_std * Math.sqrt(12) : 0;
    icStat.set(r.factor_code, { rankIC: r.rank_ic_mean ?? 0, icir: ir });
  }
  // 2.5) 每因子 top-30 选股的前三行业 + 市值特征（最新截面，与时间区间无关，缓存只查一次）
  const ind3 = await factorTop3Industries();
  const mcap = await factorMarketCap();

  // 3) 每因子汇总指标
  const rows = [];
  for (const f of state.catalog) {
    const s = series.get(f.code);
    const m = s ? computeMetrics(s.rets, s.navs) : null;
    const ic = icStat.get(f.code) || { rankIC: 0, icir: 0 };
    if (!m) continue;
    const mc = mcap.get(f.code);
    rows.push({
      code: f.code, name_cn: f.name_cn, l1: f.l1, l2: f.l2,
      annual: m.annual, sharpe: m.sharpe, mdd: m.mdd, winRate: m.winRate,
      rankIC: ic.rankIC, icir: ic.icir,
      nMonths: s.rets.length,
      top3ind: ind3.get(f.code) || "—",
      medCap: mc ? mc.medCap : null,
      capStyle: mc ? mc.style : "—",
      env_tag: f.env_tag || "—",
      time_tag: f.time_tag || "—",
    });
  }
  // 4) 综合分：各分项在全因子截面 z-score 后加权。
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

// 返回一个 (key, value) → z-score 的函数（基于 rows 中该 key 的均值/标准差）
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
    return desc ? bv - av : av - bv;
  });
  const ths = RANK_COLS.map(c =>
    `<th class="${c.lcol ? "lcol " : ""}${c.key === sortKey ? "sorted" : ""}" data-key="${c.key}">${c.label}${c.key === sortKey ? (desc ? " ▼" : " ▲") : ""}</th>`
  ).join("");
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
  if (mode === "compare") {
    state.compareFactors = codes.map(code => ({ code, n: state.compareDefaultN }));
  } else {
    state.composeFactors = codes.map(code => ({ code, weight: 1, op: ">=", thr: null }));
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

function composeScorePath(code) {
  return `${COMPOSE_SCORE_DIR}${code}.parquet${V}`;
}

async function ensureComposeFiles(codes) {
  const wanted = uniqueValidCodes(codes);
  await Promise.all(wanted.map(async (code) => {
    if (_composeFilePaths.has(code)) return;
    if (!_composeFileLoads.has(code)) {
      _composeFileLoads.set(code, (async () => {
        const res = await fetch(composeScorePath(code));
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${composeScorePath(code)}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const path = `/compose_scores/${code}.parquet`;
        await state.duckdb.registerFileBuffer(path, bytes);
        _composeFilePaths.set(code, path);
      })());
    }
    await _composeFileLoads.get(code);
  }));
}

function composeScoreReadExpr(codes) {
  const paths = codes.map(code => `'${_composeFilePaths.get(code) || composeScorePath(code)}'`).join(",");
  return `read_parquet([${paths}])`;
}

function composeConfigKey(factors = state.composeFactors, N = state.composeN) {
  const norm = cloneComposeFactors(factors).sort((a, b) => a.code.localeCompare(b.code));
  return JSON.stringify({ N, factors: norm });
}

function cloneBacktest(bt) {
  return bt ? { x: bt.x.slice(), navArr: bt.navArr.slice(), retArr: bt.retArr.slice() } : null;
}

function rememberComposeBacktest(key, bt) {
  _composeBtCache.set(key, cloneBacktest(bt));
  while (_composeBtCache.size > 12) _composeBtCache.delete(_composeBtCache.keys().next().value);
}

function matrixCondSql(factors = state.composeFactors) {
  const idxMap = new Map(_cpsMatrixCodes.map((code, i) => [code, i]));
  const parts = [];
  for (const f of factors) {
    if (f.thr === null || !Number.isFinite(Number(f.thr))) continue;
    const idx = idxMap.get(f.code);
    if (idx === undefined) return null;
    parts.push(`f${idx} ${f.op} ${Number(f.thr)}`);
  }
  return parts.length ? "AND " + parts.join(" AND ") : "";
}

function matrixScoreSql(factors = state.composeFactors) {
  const idxMap = new Map(_cpsMatrixCodes.map((code, i) => [code, i]));
  const terms = [];
  for (const f of factors) {
    const idx = idxMap.get(f.code);
    if (idx === undefined) return null;
    const weight = Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0;
    terms.push(`f${idx} * ${weight}`);
  }
  return terms.length ? terms.join(" + ") : "0";
}

async function ensureComposeBase() {
  const codes = state.composeFactors.map(f => f.code).sort();
  const key = codes.join(",");
  // 若已有重建在跑，先等它结束（快速连点多个因子时，多次 renderCompose 并发调用本函数；
  // 不串行化会让 DROP/CREATE 交错 → "Table cps_base already exists"）。等完后用最新 key 复判。
  if (_cpsBaseBuild) { try { await _cpsBaseBuild; } catch (_) {} }
  if (key === _cpsBaseKey) return;          // 因子集未变，复用缓存
  _cpsBaseBuild = (async () => {
    // DROP→CREATE 用 CREATE OR REPLACE 保证幂等；先置 key 失效，建好再写回。
    _cpsBaseKey = null;
    if (codes.length === 0) {
      await state.db.query(`DROP TABLE IF EXISTS cps_matrix`);
      await state.db.query(`DROP TABLE IF EXISTS cps_latest_matrix`);
      _cpsMatrixCodes = [];
    } else {
      await ensureComposeFiles(codes);
      // 只读取选中因子的历史分片。后续所有合成查询不再碰远程 parquet。
      const scoreCols = codes.map((c, i) =>
        `MAX(CASE WHEN factor_code = '${c}' THEN score END) AS f${i}`
      ).join(",\n               ");
      const matrixCols = codes.map((_, i) => `w.f${i}`).join(", ");
      await state.db.query(`
        CREATE OR REPLACE TABLE cps_matrix AS
        WITH src AS (
          SELECT trade_date, stock_code, factor_code, score, fwd_return
          FROM ${composeScoreReadExpr(codes)}
          WHERE score IS NOT NULL
        ),
        wide AS (
          SELECT trade_date, stock_code,
                 ${scoreCols},
                 MAX(fwd_return) AS fwd_return,
                 COUNT(DISTINCT factor_code) AS factor_count
          FROM src
          GROUP BY trade_date, stock_code
        )
        SELECT w.trade_date, w.stock_code, ${matrixCols}, w.fwd_return
        FROM wide w
        WHERE w.factor_count = ${codes.length}
      `);
      await state.db.query(`
        CREATE OR REPLACE TABLE cps_latest_matrix AS
        SELECT * FROM cps_matrix WHERE trade_date = (SELECT MAX(trade_date) FROM cps_matrix)
      `);
      _cpsMatrixCodes = codes;
    }
    _latestComposeBtKey = null;
    _latestComposeBt = null;
    _composeBtCache.clear();
    _composeBtBuilds.clear();
    _cpsBaseKey = key;
  })();
  try { await _cpsBaseBuild; } finally { _cpsBaseBuild = null; }
}

function toggleComposeFactor(code) {
  const i = state.composeFactors.findIndex(f => f.code === code);
  if (i >= 0) state.composeFactors.splice(i, 1);
  else state.composeFactors.push({ code, weight: 1, op: ">=", thr: null });
  updateTreeHighlight();
  renderComposeSoon(20);
}

// 参数化版过滤条件 SQL 片段。基于设了阈值(thr非null)的因子。
function composeCondFor(factors, baseTable) {
  const conds = factors.filter(f => f.thr !== null && Number.isFinite(f.thr));
  if (conds.length === 0) return { cte: "", join: "", nConds: 0 };
  const orC = conds.map(f => `(factor_code='${f.code}' AND score ${f.op} ${f.thr})`).join(" OR ");
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
  return cloneComposeFactors(combo.factors)
    .map(f => `${f.code}×${f.weight}${f.thr !== null ? `(${f.op}${f.thr})` : ""}`)
    .join(" + ") + `，top${combo.N}`;
}

function comboDetailHtml(combo) {
  const rows = cloneComposeFactors(combo.factors).map(f => {
    const meta = state.catalog.find(x => x.code === f.code);
    const thr = f.thr === null ? "不过滤" : `得分 ${f.op} ${f.thr}`;
    return `<tr><td>${f.code}</td><td>${meta?.name_cn || ""}</td><td>${f.weight}</td><td>${thr}</td></tr>`;
  }).join("");
  return `<div class="published-detail">
    ${combo.description ? `<p>${combo.description}</p>` : ""}
    <table class="published-detail-table"><thead><tr><th>因子</th><th>名称</th><th>权重</th><th>过滤</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="published-meta">${combo.created_at ? "创建：" + combo.created_at + " · " : ""}ID：${combo.id}</p>
  </div>`;
}

function comboToTempCompare(combo) {
  return {
    name: combo.name,
    factors: cloneComposeFactors(combo.factors),
    N: combo.N,
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
  syncComposeNButtons();
  switchMode("compose");
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
    box.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  const openSet = source === "mine" ? state.myComboOpen : state.publishedComboOpen;
  const cardClass = source === "mine" ? "my-combo-card" : "published-combo-card";
  box.innerHTML = combos.map(combo => {
    const tags = combo.tags.length
      ? combo.tags.map(t => `<span class="published-tag">${t}</span>`).join("")
      : "";
    const detail = openSet.has(combo.id) ? comboDetailHtml(combo) : "";
    const disabled = combo.valid ? "" : " disabled";
    const invalid = combo.valid ? "" : `<div class="published-invalid">配置无效：${combo.invalidReason}</div>`;
    const deleteBtn = source === "mine"
      ? `<button class="cpsn-btn my-delete" data-source="${source}" data-id="${combo.id}"${disabled}>删除</button>`
      : "";
    const renameBtn = source === "mine"
      ? `<button class="cpsn-btn my-rename" data-source="${source}" data-id="${combo.id}"${disabled}>改名</button>`
      : "";
    const publishBtn = source === "mine"
      ? `<button class="cpsn-btn my-publish" data-source="${source}" data-id="${combo.id}"${disabled}>申请发布</button>`
      : "";
    const deleteRequestBtn = source === "published" && combo.source === "supabase"
      ? `<button class="cpsn-btn published-delete-request" data-id="${combo.id}"${disabled}>申请删除</button>`
      : "";
    return `<div class="published-combo-card ${cardClass}${combo.valid ? "" : " invalid"}" data-id="${combo.id}">
      <div class="published-combo-head">
        <div>
          <b class="published-combo-name">${combo.name}</b>
          <span class="published-n">top${combo.N}</span>
          ${tags}
        </div>
        <div class="published-actions">
          <button class="cpsn-btn library-load" data-source="${source}" data-id="${combo.id}"${disabled}>载入</button>
          <button class="cpsn-btn library-compare" data-source="${source}" data-id="${combo.id}"${disabled}>加入对比</button>
          <button class="cpsn-btn library-detail-toggle" data-source="${source}" data-id="${combo.id}">${openSet.has(combo.id) ? "收起" : "详情"}</button>
          ${renameBtn}
          ${publishBtn}
          ${deleteRequestBtn}
          ${deleteBtn}
        </div>
      </div>
      <div class="published-summary">${comboSummary(combo)}</div>
      ${combo.description ? `<div class="published-desc">${combo.description}</div>` : ""}
      ${invalid}
      ${detail}
    </div>`;
  }).join("");
  box.querySelectorAll(".library-load").forEach(btn => {
    btn.onclick = () => loadLibraryCombo(btn.dataset.source, btn.dataset.id);
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
    box.innerHTML = `<div class="empty" style="color:#c14545">${state.publishedComboErrors.join("；")}</div>`;
    return;
  }
  renderComboCards(box, state.publishedCombos, "published", "暂无已发布组合");
  if (state.publishedComboErrors.length) {
    box.insertAdjacentHTML("afterbegin", `<div class="empty" style="margin-bottom:8px;color:#c14545">${state.publishedComboErrors.join("；")}</div>`);
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
  renderPublishedCombos();
  renderMyCombos();
  document.querySelectorAll(".combo-tab").forEach(btn => {
    btn.onclick = () => {
      state.comboLibraryTab = btn.dataset.tab === "mine" ? "mine" : "published";
      renderComboLibrary();
    };
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
    if (list) list.innerHTML = `<div class="empty" style="color:#c14545">已发布组合加载失败：${err.message || err}</div>`;
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
    return `<div class="admin-published-card" data-id="${row.id}">
      <div>
        <b>${payload.name || row.name || row.combo_id}</b>
        <span class="published-n">top${payload.N || "?"}</span>
        <div class="admin-request-meta">${created}</div>
        <div class="published-summary">${payload.factors ? comboSummary(validatePublishedCombo(payload, 0, new Set(state.catalog.map(f => f.code)))) : "无组合配置"}</div>
      </div>
      <button class="cpsn-btn admin-published-delete" data-id="${row.id}" data-name="${payload.name || row.name || row.combo_id}">删除</button>
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
    return `<div class="admin-request-card ${pending ? "" : "reviewed"}" data-id="${req.id}">
      <div class="admin-request-head">
        <div>
          <div class="admin-request-kind">${isDelete ? "申请删除" : "申请发布"}</div>
          <b class="admin-request-title">${payload.name || req.combo_name || "未命名组合"}</b>
          <span class="published-n">top${payload.N || "?"}</span>
          <div class="admin-request-meta">状态：${statusText} · ${created}</div>
          <div class="published-summary">${payload.factors ? comboSummary(validatePublishedCombo(payload, 0, new Set(state.catalog.map(f => f.code)))) : `目标组合：${req.combo_name || req.combo_id}`}</div>
        </div>
        <div class="admin-request-actions">
          <button class="cpsn-btn admin-approve" data-id="${req.id}"${pending ? "" : " disabled"}>同意</button>
          <button class="cpsn-btn admin-reject" data-id="${req.id}"${pending ? "" : " disabled"}>拒绝</button>
        </div>
      </div>
      <pre class="admin-request-json">${JSON.stringify(payload, null, 2)}</pre>
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
    factors: cloneComposeFactors(combo.factors),
    tags: combo.tags || [],
    created_at: combo.created_at || new Date().toISOString().slice(0, 10),
  };
}

function comboPublishRequestText(payload) {
  const factorLines = cloneComposeFactors(payload.factors).map(f => {
    const meta = state.catalog.find(x => x.code === f.code);
    const thr = f.thr === null ? "不过滤" : `过滤：得分 ${f.op} ${f.thr}`;
    return `- ${f.code}${meta?.name_cn ? `（${meta.name_cn}）` : ""}：权重 ${f.weight}，${thr}`;
  }).join("\n");
  return [
    "申请发布组合",
    "",
    "请发给管理员审核。审核通过后，管理员会发布到全站组合库，其他人打开页面也能看到。",
    "",
    `组合名称：${payload.name}`,
    `选股数：top${payload.N}`,
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
  box.innerHTML = state.composeFactors.map((f, i) => {
    const pctw = (f.weight / wsum * 100).toFixed(0);
    return `<div class="cps-frow" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
      <span style="width:10px;height:10px;border-radius:50%;background:${STRAT_COLORS[i % STRAT_COLORS.length]};display:inline-block"></span>
      <b style="font-size:12px;min-width:72px">${f.code}</b>
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
      return;
    }
    await ensureComposeBase();   // 因子集变了才重建窄表；权重/阈值/N 变则复用缓存
    if (isComposeRenderStale(renderSeq)) return;
    await Promise.all([renderComposeStocks(renderSeq), renderComposeBacktest(renderSeq)]);
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
  const candidateLimit = Math.min(Math.max(state.composeN + 180, state.composeN * 4), 700);
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
  const rows = res.toArray()
    .map(r => ({ ...r, meta: metaMap.get(r.stock_code) }))
    .filter(r => r.meta && !r.meta.is_st && r.meta.is_active_latest)
    .slice(0, state.composeN)
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
  const condDesc = state.composeFactors.filter(f => f.thr !== null && Number.isFinite(f.thr))
    .map(f => `${f.code}得分${f.op}${f.thr}`).join(" 且 ");
  if (rows.length === 0) {
    target.innerHTML = `<h3>合成 Top 股票</h3><div class="empty">无股票满足条件${condDesc ? "：" + condDesc : ""}（过滤可能过严，放宽阈值）</div>`;
    return;
  }
  const dt = rows[0].dt;
  const wdesc = state.composeFactors.map(f => `${f.code}×${f.weight}`).join(" + ");
  const fmt = (v, dp = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(dp));
  const fmtMV = (v) => (v === null || v === undefined ? "—" : (Number(v) / 1e4).toFixed(0));
  let html = `<h3>合成 Top ${state.composeN} 股票（截面日 ${dt}）<span class="click-hint">🔍 点任一行 → 看该股「为什么入选」</span></h3>
    <p style="color:#888;font-size:11px;margin:-4px 0 8px 0">合成得分 = ${wdesc}（z-score 加权和）${condDesc ? "；过滤：" + condDesc : ""}（已剔 ST/停牌）</p>
    <table class="stock-table"><thead><tr>
      <th>#</th><th>代码</th><th>名称</th><th>申万一级</th><th>市值(亿)</th><th>PE</th><th>PB</th><th>合成得分</th>
    </tr></thead><tbody>`;
  rows.forEach((r, i) => {
    html += `<tr class="stock-row" data-stock="${r.stock_code}" data-name="${r.name || ""}" title="点击看该股各因子打分（为什么入选）"><td>${i + 1}</td><td>${r.stock_code}</td><td>${r.name || ""}</td>
      <td>${r.industry_sw1 || "—"}</td><td>${fmtMV(r.market_cap)}</td>
      <td>${fmt(r.pe, 1)}</td><td>${fmt(r.pb, 2)}</td><td>${fmt(r.comp_score, 3)}</td></tr>`;
  });
  target.innerHTML = html + "</tbody></table>";
}

async function renderComposeBacktest(renderSeq) {
  if (isComposeRenderStale(renderSeq) || state.composeFactors.length === 0) return;
  document.getElementById("cps-nav-title").textContent =
    `合成组合净值（top-${state.composeN}，月末等权调仓，0.2% 双边成本，起点=1.0；${composeRangeLabel()}）`;
  const key = composeConfigKey();
  const fullBt = await comboBacktest(state.composeFactors, state.composeN, "cps_matrix");
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
      const aligned = benchmarkSeries(bm, x, idx);
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
  let krows = `<tr><td><b>合成组合</b></td><td>${pct(m.annual)}</td><td>${m.sharpe.toFixed(2)}</td><td>${pct(m.mdd)}</td>
      <td>${(m.winRate*100).toFixed(0)}%</td><td>${ex300}</td><td>${ex800}</td></tr>`;
  // 三基准行（绝对指标）
  {
    const cn = { HS300: "沪深300", CSI800: "中证800", CSI500: "中证500" };
    for (const idx of ["HS300", "CSI800", "CSI500"]) {
      const bm = bg[idx]; if (!bm) continue;
      krows += `<tr style="color:#888;border-top:2px solid #ddd">
        <td style="color:#888">${cn[idx]}</td><td>${pct(bm.annual)}</td><td>${bm.sharpe.toFixed(2)}</td>
        <td>${pct(bm.mdd)}</td><td>${(bm.winRate*100).toFixed(0)}%</td><td>—</td><td>—</td></tr>`;
    }
  }
  kdiv.innerHTML = `<table class="kpi-table">
    <thead><tr><th>组合 / 基准</th><th>年化收益</th><th>夏普</th><th>最大回撤</th><th>月度胜率</th><th>超额vs300</th><th>超额vs800</th></tr></thead>
    <tbody>${krows}</tbody></table>`;
}

// ============ 暂存组合 + 多组合对比 ============

// 对比惰性补算用的并集基表（只在有未算组合时建一次；不再每次渲染重建）
let _cmpBaseKey = null, _cmpBaseBuild = null;
async function ensureCmpBase(codes) {
  const sorted = [...new Set(codes)].sort();
  const key = sorted.join(",");
  if (_cmpBaseBuild) { try { await _cmpBaseBuild; } catch (_) {} }
  if (key === _cmpBaseKey) return;
  _cmpBaseBuild = (async () => {
    _cmpBaseKey = null;
    if (!sorted.length) { await state.db.query(`DROP TABLE IF EXISTS cps_cmp_base`); }
    else {
      await state.db.query(`CREATE OR REPLACE TABLE cps_cmp_base AS
        SELECT trade_date, stock_code, factor_code, score, fwd_return
        FROM ${composeScoreReadExpr(sorted)}
        WHERE score IS NOT NULL`);
    }
    _cmpBaseKey = key;
  })();
  try { await _cmpBaseBuild; } finally { _cmpBaseBuild = null; }
}

function buildBacktestFromRows(rows, N) {
  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.dt)) byMonth.set(r.dt, { rets: [], stocks: new Set() });
    const o = byMonth.get(r.dt);
    o.stocks.add(r.stock_code);
    if (r.fwd_return != null) o.rets.push(r.fwd_return);
  }
  const months = [...byMonth.keys()].sort();
  const COST = 0.002; let prev = null, nav = 1; const x = [], navArr = [], retArr = [];
  for (const mth of months) {
    const o = byMonth.get(mth);
    const gross = o.rets.length ? o.rets.reduce((s, v) => s + v, 0) / o.rets.length : 0;
    let turnover = 1;
    if (prev) { let diff = 0; for (const s of o.stocks) if (!prev.has(s)) diff++; for (const s of prev) if (!o.stocks.has(s)) diff++; turnover = diff / (2 * N); }
    const net = gross - 2 * COST * turnover;
    x.push(mth); navArr.push(nav); retArr.push(net);
    nav *= (1 + net);
    prev = o.stocks;
  }
  return { x, navArr, retArr };
}

function matrixBacktestSql(factors, N, baseTable) {
  const idxMap = new Map(_cpsMatrixCodes.map((code, i) => [code, i]));
  const terms = [];
  const conds = [];
  for (const f of factors) {
    const idx = idxMap.get(f.code);
    if (idx === undefined) return null;
    const col = `f${idx}`;
    const weight = Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0;
    terms.push(`${col} * ${weight}`);
    if (f.thr !== null && Number.isFinite(Number(f.thr))) conds.push(`${col} ${f.op} ${Number(f.thr)}`);
  }
  const scoreExpr = terms.length ? terms.join(" + ") : "0";
  const condSql = conds.length ? "AND " + conds.join(" AND ") : "";
  return `
    WITH scored AS (
      SELECT trade_date, stock_code, fwd_return, ROUND(${scoreExpr}, 6) AS cs
      FROM ${baseTable}
      WHERE fwd_return IS NOT NULL ${condSql}
    ),
    ranked AS (
      SELECT trade_date, stock_code, fwd_return,
             ROW_NUMBER() OVER (PARTITION BY trade_date ORDER BY cs DESC, stock_code) AS rk
      FROM scored
    )
    SELECT strftime(trade_date, '%Y-%m') AS dt, stock_code, fwd_return
    FROM ranked WHERE rk <= ${N} ORDER BY trade_date`;
}

// 给定组合配置 + 基表 → 逐月净值/收益（口径同 renderComposeBacktest）。
// cps_matrix 是当前因子集宽表快路径；其它表保留长表 SQL 作为对比惰性补算兜底。
async function comboBacktest(factors, N, baseTable) {
  const cacheKey = baseTable === "cps_matrix" ? composeConfigKey(factors, N) : null;
  if (cacheKey && _composeBtCache.has(cacheKey)) return cloneBacktest(_composeBtCache.get(cacheKey));
  if (cacheKey && _composeBtBuilds.has(cacheKey)) return cloneBacktest(await _composeBtBuilds.get(cacheKey));

  const fastSql = baseTable === "cps_matrix" ? matrixBacktestSql(factors, N, baseTable) : null;
  if (fastSql) {
    const build = (async () => {
      const res = await state.db.query(fastSql);
      const bt = buildBacktestFromRows(res.toArray(), N);
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
  const vals = factors.map(f => `('${f.code}',${f.weight})`).join(",");
  const cond = composeCondFor(factors, baseTable);
  const res = await state.db.query(`
    WITH w(code, weight) AS (VALUES ${vals}),
    ${cond.cte}
    comp AS (
      SELECT s.trade_date, s.stock_code, ROUND(SUM(s.score * w.weight), 6) AS cs, COUNT(*) AS cnt
      FROM ${baseTable} s JOIN w ON s.factor_code = w.code
      WHERE s.score IS NOT NULL GROUP BY s.trade_date, s.stock_code
    ),
    ranked AS (
      SELECT c.trade_date, c.stock_code, c.fwd_return,
             ROW_NUMBER() OVER (PARTITION BY c.trade_date ORDER BY c.cs DESC, c.stock_code) AS rk
      FROM comp c
      ${cond.join}
      WHERE c.cnt = ${nF} AND c.fwd_return IS NOT NULL
    )
    SELECT strftime(trade_date, '%Y-%m') AS dt, stock_code, fwd_return
    FROM ranked WHERE rk <= ${N} ORDER BY trade_date`);
  return buildBacktestFromRows(res.toArray(), N);
}

async function saveCurrentCombo() {
  if (!state.composeFactors.length) return;
  const factors = state.composeFactors.map(f => ({ ...f }));
  const N = state.composeN;
  const i = state.savedCombos.length;
  const comboKey = composeConfigKey(factors, N);
  const combo = {
    name: `组合${i + 1}`,
    factors,
    N,
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
      await ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: false });
      await ensureComposeData();
      try {
        await ensureComposeBase();
        const bt = await comboBacktest(factors, N, "cps_matrix");
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
    const summ = c.factors.map(f => `${f.code}×${f.weight}${f.thr != null ? `(${f.op}${f.thr})` : ""}`).join(" + ") + `，top${c.N}`;
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
      await ensureDB({ stockMeta: false, descriptors: false, benchmarks: false, corr: false });
      await ensureComposeData();
      const union = [...new Set(state.savedCombos.flatMap(c => c.factors.map(f => f.code)))];
      await ensureCmpBase(union);
      for (const c of missing) c.bt = await comboBacktest(c.factors, c.N, "cps_cmp_base");
    } catch (e) {
      if (titleEl) titleEl.textContent = "暂存组合对比";
      navDiv.innerHTML = `<div class="empty">对比计算失败：${e.message || e}</div>`; return;
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
        const aligned = benchmarkSeries(bmSnap, allMonths, idx);
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
            annual: m.annual, sharpe: m.sharpe, mdd: m.mdd,
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
      annual: m.annual, sharpe: m.sharpe, mdd: m.mdd,
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
  const COST = 0.002;
  let prev = null, nav = 1;
  const navArr = [], retArr = [];
  for (const mo of monthsArr) {
    let elig = mo.stocks;
    if (conds && conds.length) {
      elig = mo.stocks.filter(s => conds.every(c =>
        c.op === ">=" ? s.scores[c.idx] >= c.thr : s.scores[c.idx] <= c.thr));
    }
    if (elig.length === 0) {   // 该月无符合 → 空仓
      nav *= 1; navArr.push(nav); retArr.push(0); prev = new Set(); continue;
    }
    const scored = elig.map(s => {
      let c = 0; for (let i = 0; i < weights.length; i++) c += weights[i] * s.scores[i];
      return { code: s.code, comp: c, ret: s.ret };
    });
    scored.sort((a, b) => b.comp - a.comp);
    const picks = scored.slice(0, N);
    const gross = picks.reduce((s, p) => s + p.ret, 0) / picks.length;
    const cur = new Set(picks.map(p => p.code));
    let turnover = 1;
    if (prev) {
      let diff = 0;
      for (const c of cur) if (!prev.has(c)) diff++;
      for (const c of prev) if (!cur.has(c)) diff++;
      turnover = diff / (cur.size + prev.size || 1);
    }
    const net = gross - 2 * COST * turnover;
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
  box.innerHTML = `<div class="loading">搜索中…</div>`;
  await ensureComposeData();
  await ensureComposeBase();

  const scoreCols = codes.map((_, i) => `f${i}`).join(", ");
  // 候选股裁剪：只保留"在任一所选因子排进前 500"的股。合成 top-N(N≤100) 的成分
  // 必在此并集内（全因子都排 500 外 → 加权和必偏低 → 进不了 top），裁剪不改结果但大幅提速。
  const res = await state.db.query(`
    WITH cand AS (
      ${codes.map((_, i) => `
        SELECT trade_date, stock_code FROM (
          SELECT trade_date, stock_code,
                 ROW_NUMBER() OVER (PARTITION BY trade_date ORDER BY f${i} DESC) AS rk
          FROM cps_matrix
          WHERE fwd_return IS NOT NULL
        ) WHERE rk <= 500
      `).join("\nUNION\n")}
    )
    SELECT strftime(m.trade_date,'%Y-%m') AS ym,
           m.stock_code,
           ${scoreCols},
           m.fwd_return
    FROM cps_matrix m
    JOIN cand c ON c.trade_date = m.trade_date AND c.stock_code = m.stock_code
    WHERE m.fwd_return IS NOT NULL
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
    if (m.sharpe > best.sharpe.val) best.sharpe = { val: m.sharpe, w, m };
    if (m.vol < best.vol.val) best.vol = { val: m.vol, w, m };
    if (m.mdd > best.mdd.val) best.mdd = { val: m.mdd, w, m };
  }

  const pct = v => (v * 100).toFixed(1) + "%";
  const wstr = w => codes.map((c, i) => `${c} ${(w[i] * 100).toFixed(0)}%`).join(" / ");
  const targets = [
    ["年化收益最高", best.annual], ["夏普比率最高", best.sharpe],
    ["波动率最低", best.vol], ["最大回撤最小", best.mdd],
  ];
  let rows = "";
  targets.forEach(([label, b], ti) => {
    if (!b.w) return;
    rows += `<tr>
      <td>${label}</td>
      <td>${wstr(b.w)}</td>
      <td>${pct(b.m.annual)}</td><td>${b.m.sharpe.toFixed(2)}</td>
      <td>${pct(b.m.vol)}</td><td>${pct(b.m.mdd)}</td>
      <td><button class="cpsn-btn cps-apply" data-ti="${ti}">应用</button></td>
    </tr>`;
  });
  box.innerHTML = `
    <table class="opt-table">
      <thead><tr><th>优化目标</th><th>最优权重</th><th>年化</th><th>夏普</th><th>波动</th><th>回撤</th><th>操作</th></tr></thead>
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
    document.getElementById("cps-opt").innerHTML = `<pre style="color:#c00;font-size:11px">最优权重失败：${e.message}</pre>`;
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
          .then(snap => renderNScanFast(state.activeFactor, snap))
          .catch(() => renderNScan(state.activeFactor));
      }
    };
  });
}

// ===================== 个股「为什么入选」弹窗 =====================
// 标准正态 CDF（Abramowitz-Stegun 近似）：把 z-score 转成「强于全市场 X%」
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
      body.innerHTML = `<div class="empty">查询失败：${fallbackErr.message || fallbackErr}</div>`;
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

bindScanButtons();
bindModeButtons();
bindCmpDefaultButtons();
bindComposeButtons();
init();
