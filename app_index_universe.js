// 指数股票池配置与选股约束。保持为无依赖纯函数，供页面和自动化测试共用。
const INDEX_UNIVERSE_OPTIONS = [
  { alias: "HS300", code: "000300.SH", label: "沪深300", firstWeightDate: "2015-01-05" },
  { alias: "CSI500", code: "000905.SH", label: "中证500", firstWeightDate: "2015-01-05" },
  { alias: "CSI800", code: "000906.SH", label: "中证800", firstWeightDate: "2015-01-05" },
  { alias: "CSI1000", code: "000852.SH", label: "中证1000", firstWeightDate: "2015-01-05" },
  { alias: "CSI2000", code: "932000.CSI", label: "中证2000", firstWeightDate: "2023-08-14" },
  { alias: "CSIA500", code: "000510.SH", label: "中证A500", firstWeightDate: "2024-09-24" },
];

function normalizeIndexUniverseConfig(raw) {
  const mode = ["all", "index_only", "min_share", "stock_pool"].includes(raw?.mode) ? raw.mode : "all";
  const aliases = new Set(INDEX_UNIVERSE_OPTIONS.map(item => item.alias));
  const indexAlias = aliases.has(raw?.indexAlias) ? raw.indexAlias : "HS300";
  const poolId = /^[A-Z0-9_]+$/.test(String(raw?.poolId || "")) ? String(raw.poolId) : "";
  const poolName = String(raw?.poolName || poolId || "").trim();
  const poolType = ["sw1", "broad_index", "custom"].includes(raw?.poolType) ? raw.poolType : "";
  let minShare = Number(raw?.minShare);
  if (!Number.isFinite(minShare)) minShare = 0.8;
  if (minShare > 1) minShare /= 100;
  minShare = Math.min(1, Math.max(0.5, minShare));
  return {
    mode: mode === "stock_pool" && !poolId ? "all" : mode,
    indexAlias,
    minShare,
    poolId,
    poolName,
    poolType,
  };
}

function indexUniverseMeta(config) {
  const normalized = normalizeIndexUniverseConfig(config);
  return INDEX_UNIVERSE_OPTIONS.find(item => item.alias === normalized.indexAlias) || INDEX_UNIVERSE_OPTIONS[0];
}

function indexUniverseModeLabel(config) {
  const normalized = normalizeIndexUniverseConfig(config);
  const meta = indexUniverseMeta(normalized);
  if (normalized.mode === "stock_pool") return `仅${normalized.poolName || normalized.poolId}历史成分`;
  if (normalized.mode === "index_only") return `仅${meta.label}成分`;
  if (normalized.mode === "min_share") return `至少${Math.round(normalized.minShare * 100)}%来自${meta.label}`;
  return "全市场";
}

function _indexScoreValue(row) {
  const value = row?.cs ?? row?.comp_score ?? row?.score;
  return value === null || value === undefined ? null : Number(value);
}

function _isIndexMember(row) {
  return row?.is_index_member === true || row?.is_index_member === 1;
}

function _indexAvailable(row) {
  return row?.index_available === true || row?.index_available === 1;
}

function _rankIndexCandidates(rows) {
  return (rows || [])
    .filter(row => Number.isFinite(_indexScoreValue(row)))
    .slice()
    .sort((a, b) => _indexScoreValue(b) - _indexScoreValue(a)
      || String(a.stock_code).localeCompare(String(b.stock_code)));
}

function _competitionIndexTopN(rows, nominalN) {
  const ranked = _rankIndexCandidates(rows);
  const n = Math.max(1, Math.floor(Number(nominalN) || 1));
  if (ranked.length <= n) return ranked;
  const boundary = _indexScoreValue(ranked[n - 1]);
  return ranked.filter(row => _indexScoreValue(row) >= boundary);
}

function selectRowsByIndexUniverse(candidateRows, nominalN, rawConfig) {
  const config = normalizeIndexUniverseConfig(rawConfig);
  const ranked = _rankIndexCandidates(candidateRows);
  const n = Math.max(1, Math.floor(Number(nominalN) || 1));
  const active = config.mode !== "all";
  const available = !active || ranked.some(_indexAvailable);
  const empty = {
    rows: [],
    stats: {
      nominal_n: n,
      actual_n: 0,
      index_member_n: 0,
      index_member_share: null,
      required_index_member_n: 0,
      universe_mode: config.mode,
      index_alias: config.indexAlias,
      pool_id: config.poolId,
      index_available: available,
      requirement_met: false,
    },
  };
  if (!available) return empty;

  let picked;
  let required = 0;
  if (config.mode === "index_only" || config.mode === "stock_pool") {
    picked = _competitionIndexTopN(ranked.filter(_isIndexMember), n);
    required = Math.min(n, picked.length);
  } else if (config.mode === "min_share") {
    const targetSize = Math.min(n, ranked.length);
    required = Math.ceil(targetSize * config.minShare);
    const members = ranked.filter(_isIndexMember);
    if (members.length < required) {
      return {
        ...empty,
        stats: {
          ...empty.stats,
          required_index_member_n: required,
          available_index_member_n: members.length,
        },
      };
    }
    const requiredMembers = members.slice(0, required);
    const selectedCodes = new Set(requiredMembers.map(row => row.stock_code));
    const fillers = ranked.filter(row => !selectedCodes.has(row.stock_code)).slice(0, targetSize - requiredMembers.length);
    picked = [...requiredMembers, ...fillers]
      .sort((a, b) => _indexScoreValue(b) - _indexScoreValue(a)
        || String(a.stock_code).localeCompare(String(b.stock_code)));
  } else {
    picked = _competitionIndexTopN(ranked, n);
  }

  const memberN = picked.filter(_isIndexMember).length;
  const memberShare = picked.length ? memberN / picked.length : null;
  const requirementMet = config.mode === "all"
    || (["index_only", "stock_pool"].includes(config.mode) ? memberN === picked.length : memberN >= required);
  const equalWeight = picked.length ? 1 / picked.length : 0;
  return {
    rows: picked.map(row => ({ ...row, weight: equalWeight })),
    stats: {
      nominal_n: n,
      actual_n: picked.length,
      index_member_n: memberN,
      index_member_share: memberShare,
      required_index_member_n: required,
      universe_mode: config.mode,
      index_alias: config.indexAlias,
      pool_id: config.poolId,
      index_available: available,
      requirement_met: requirementMet,
    },
  };
}

Object.assign(globalThis, {
  INDEX_UNIVERSE_OPTIONS,
  normalizeIndexUniverseConfig,
  indexUniverseMeta,
  indexUniverseModeLabel,
  selectRowsByIndexUniverse,
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    INDEX_UNIVERSE_OPTIONS,
    normalizeIndexUniverseConfig,
    indexUniverseMeta,
    indexUniverseModeLabel,
    selectRowsByIndexUniverse,
  };
}
