// Shared copy helpers for latest-holdings panels.
function holdingAsOfDate(row) {
  return row?.as_of_date || row?.dt || "—";
}

function holdingPoolDate(row) {
  return row?.pool_date || row?.as_of_date || row?.dt || "—";
}

function latestHoldingScopeNote(rows, opts = {}) {
  const validRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const asOfs = [...new Set(validRows.map(holdingAsOfDate).filter(v => v && v !== "—"))].sort();
  const poolDates = [...new Set(validRows.map(holdingPoolDate).filter(v => v && v !== "—"))].sort();
  const asOfText = asOfs.length > 1 ? `${asOfs[0]} ~ ${asOfs[asOfs.length - 1]}` : (asOfs[0] || "—");
  const poolText = poolDates.length > 1 ? `${poolDates[0]} ~ ${poolDates[poolDates.length - 1]}` : (poolDates[0] || "—");
  const eventText = opts.isEvent ? "事件因子可能汇总多个公告/快报截面，表内每行的得分截面以 as_of_date 为准；" : "";
  return `当前最新持仓展示：本表用于查看最新可持有/可交易股票池，不是历史回测持仓；仅保留当前 active、非 ST 股票。${eventText}as_of_date=${asOfText}，pool_date=${poolText}。历史回测股票池仍按每月末 Word 股票池和当期可交易状态执行，不按最新 active 过滤。`;
}
