// 月度组合账本纯函数。无页面依赖，供多因子合成、单因子 TopN 与自动化测试共用。
(function initPortfolioLedger(global) {
  "use strict";

  const MIN_VALID_FORWARD_RETURN = -1.0;

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function validForwardReturn(value) {
    const parsed = finiteNumber(value);
    return parsed !== null && parsed >= MIN_VALID_FORWARD_RETURN ? parsed : null;
  }

  function monthLabel(value) {
    return String(value || "").slice(0, 7);
  }

  function exactDate(value, fallback = "") {
    const text = String(value || fallback || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : (text ? `${text.slice(0, 7)}-01` : "");
  }

  function normalizeWeightingMode(value) {
    return ["equal", "score", "market_cap"].includes(value) ? value : "equal";
  }

  function normalizeFraction(value, fallback = 1) {
    let parsed = finiteNumber(value);
    if (parsed === null) parsed = fallback;
    if (parsed > 1) parsed /= 100;
    return Math.min(1, Math.max(0, parsed));
  }

  function normalizeWeightMap(raw) {
    const entries = raw instanceof Map ? [...raw.entries()] : [];
    const positive = entries
      .map(([code, value]) => [String(code), Math.max(0, finiteNumber(value) || 0)])
      .filter(([, value]) => value > 1e-12);
    const total = positive.reduce((sum, [, value]) => sum + value, 0);
    return new Map(positive.map(([code, value]) => [code, total > 0 ? value / total : 0]));
  }

  function allocationSignals(rows, weightingMode) {
    const mode = normalizeWeightingMode(weightingMode);
    if (mode === "equal") return rows.map(() => 1);
    if (mode === "score") {
      const scores = rows.map(row => finiteNumber(row.cs ?? row.comp_score ?? row.score));
      if (scores.some(value => value === null)) throw new Error("score weighting requires a finite score for every holding");
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const floor = max > min ? (max - min) * 0.05 : 1;
      return scores.map(value => value - min + floor);
    }
    const logCaps = rows.map(row => finiteNumber(row.ln_mv));
    if (logCaps.every(value => value !== null)) {
      const maxLogCap = Math.max(...logCaps);
      return logCaps.map(value => Math.exp(Math.max(-700, value - maxLogCap)));
    }
    const marketCaps = rows.map(row => finiteNumber(row.market_cap));
    if (marketCaps.every(value => value !== null && value > 0)) return marketCaps;
    throw new Error("market-cap weighting requires market cap for every holding");
  }

  function cappedAllocation(rows, budget, weightingMode, maxStockWeight) {
    if (!rows.length || budget <= 0) return new Map();
    const cap = normalizeFraction(maxStockWeight, 1);
    if (cap <= 0 || cap * rows.length + 1e-10 < budget) {
      throw new Error(`stock weight cap ${(cap * 100).toFixed(2)}% is infeasible for ${rows.length} holdings and ${(budget * 100).toFixed(2)}% group budget`);
    }
    const signals = allocationSignals(rows, weightingMode);
    const result = new Map();
    let active = rows.map((row, index) => ({ code: String(row.stock_code), signal: Math.max(0, signals[index] || 0) }));
    let remaining = budget;
    while (active.length) {
      const signalTotal = active.reduce((sum, item) => sum + item.signal, 0);
      const equalFallback = signalTotal <= 0;
      const proposed = active.map(item => ({
        ...item,
        weight: remaining * (equalFallback ? 1 / active.length : item.signal / signalTotal),
      }));
      const capped = proposed.filter(item => item.weight > cap + 1e-12);
      if (!capped.length) {
        proposed.forEach(item => result.set(item.code, item.weight));
        break;
      }
      const cappedCodes = new Set(capped.map(item => item.code));
      capped.forEach(item => result.set(item.code, cap));
      remaining -= cap * capped.length;
      active = active.filter(item => !cappedCodes.has(item.code));
    }
    return result;
  }

  function targetWeights(rows, options = {}) {
    const unique = new Map();
    for (const row of rows || []) {
      if (row?.stock_code && !unique.has(String(row.stock_code))) unique.set(String(row.stock_code), row);
    }
    const holdings = [...unique.values()];
    if (!holdings.length) return new Map();
    const weightingMode = normalizeWeightingMode(options.weightingMode);
    const maxStockWeight = normalizeFraction(options.maxStockWeight, 1);
    const groupField = options.groupField || "";
    if (!groupField) return cappedAllocation(holdings, 1, weightingMode, maxStockWeight);

    const groups = new Map();
    for (const row of holdings) {
      const group = String(row[groupField] || "未分类");
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    const rawBudgets = new Map();
    let budgetTotal = 0;
    for (const [group, members] of groups) {
      const budget = members.reduce((sum, row) => sum + Math.max(0, finiteNumber(row.weight) || 0), 0);
      rawBudgets.set(group, budget);
      budgetTotal += budget;
    }
    if (budgetTotal <= 0) {
      groups.forEach((members, group) => rawBudgets.set(group, members.length / holdings.length));
      budgetTotal = 1;
    }
    const result = new Map();
    for (const [group, members] of groups) {
      const budget = (rawBudgets.get(group) || 0) / budgetTotal;
      cappedAllocation(members, budget, weightingMode, maxStockWeight)
        .forEach((weight, code) => result.set(code, weight));
    }
    return result;
  }

  function turnover(current, previous) {
    if (!previous) return current.size ? 1 : 0;
    const codes = new Set([...current.keys(), ...previous.keys()]);
    let change = 0;
    codes.forEach(code => {
      change += Math.abs((current.get(code) || 0) - (previous.get(code) || 0));
    });
    return change * 0.5;
  }

  function limitTurnover(target, previous, rawCap) {
    if (!previous) return new Map(target);
    const cap = normalizeFraction(rawCap, 1);
    const desired = normalizeWeightMap(target);
    const rawTurnover = turnover(desired, previous);
    if (rawTurnover <= cap + 1e-12 || rawTurnover <= 0) return desired;
    const alpha = cap / rawTurnover;
    const codes = new Set([...desired.keys(), ...previous.keys()]);
    const limited = new Map();
    codes.forEach(code => {
      const weight = (previous.get(code) || 0) + alpha * ((desired.get(code) || 0) - (previous.get(code) || 0));
      if (weight > 1e-12) limited.set(code, weight);
    });
    return limited;
  }

  function changeRows(current, previous) {
    const prior = previous || new Map();
    const codes = new Set([...current.keys(), ...prior.keys()]);
    return [...codes].map(code => {
      const currentWeight = current.get(code) || 0;
      const previousWeight = prior.get(code) || 0;
      const action = !prior.has(code) && current.has(code)
        ? "added"
        : (prior.has(code) && !current.has(code) ? "removed" : "held");
      return {
        stock_code: code,
        action,
        current_weight: currentWeight,
        previous_weight: previousWeight,
        weight_change: currentWeight - previousWeight,
      };
    }).sort((left, right) => {
      const order = { added: 0, removed: 1, held: 2 };
      return order[left.action] - order[right.action]
        || Math.abs(right.weight_change) - Math.abs(left.weight_change)
        || left.stock_code.localeCompare(right.stock_code);
    });
  }

  function executionOrders(period, facts, options = {}) {
    const factByCode = facts instanceof Map
      ? facts
      : new Map((facts || []).filter(row => row?.stock_code).map(row => [String(row.stock_code), row]));
    const capitalWan = finiteNumber(options.capitalWan);
    const participationPct = finiteNumber(options.participationPct);
    const capitalCny = capitalWan !== null && capitalWan > 0 ? capitalWan * 10000 : null;
    const participationRate = participationPct === null
      ? 0.05
      : Math.min(1, Math.max(0, participationPct / 100));
    return (period?.changes || [])
      .filter(change => Math.abs(finiteNumber(change.weight_change) || 0) > 1e-12)
      .map(change => {
        const stockCode = String(change.stock_code || "");
        const fact = factByCode.get(stockCode) || null;
        const weightChange = finiteNumber(change.weight_change) || 0;
        const side = weightChange > 0 ? "buy" : "sell";
        const plannedTradeValueCny = capitalCny === null ? null : Math.abs(weightChange) * capitalCny;
        const rawAmount = finiteNumber(fact?.entry_amount);
        // Wind S_DQ_AMOUNT 的本地标准单位是千元，转换为人民币元后再应用参与率。
        const entryAmountCny = rawAmount === null ? null : Math.max(0, rawAmount) * 1000;
        const maxParticipationValueCny = entryAmountCny === null ? null : entryAmountCny * participationRate;
        const capacityUtilization = plannedTradeValueCny !== null && maxParticipationValueCny !== null
          && maxParticipationValueCny > 0
          ? plannedTradeValueCny / maxParticipationValueCny
          : null;
        const limitRaw = finiteNumber(fact?.entry_limit_status);
        const limitStatus = [-1, 0, 1].includes(limitRaw) ? limitRaw : null;
        const riskCodes = [];
        if (!fact) {
          riskCodes.push("execution_data_unavailable");
        } else if (fact.entry_is_suspended === true || fact.entry_is_suspended === 1) {
          riskCodes.push("suspended");
        } else {
          if (limitStatus === null) riskCodes.push("limit_status_unavailable");
          if (side === "buy" && limitStatus === 1) riskCodes.push("limit_up_buy_risk");
          if (side === "sell" && limitStatus === -1) riskCodes.push("limit_down_sell_risk");
          if (entryAmountCny === null) riskCodes.push("amount_unavailable");
          else if (entryAmountCny <= 0) riskCodes.push("no_turnover");
          else if (capacityUtilization !== null && capacityUtilization > 1 + 1e-12) riskCodes.push("capacity_exceeded");
        }
        if (!riskCodes.length) riskCodes.push("estimated_within_capacity");
        return {
          stock_code: stockCode,
          action: change.action,
          side,
          previous_weight: finiteNumber(change.previous_weight) || 0,
          current_weight: finiteNumber(change.current_weight) || 0,
          weight_change: weightChange,
          planned_trade_value_cny: plannedTradeValueCny,
          entry_amount_cny: entryAmountCny,
          max_participation_value_cny: maxParticipationValueCny,
          capacity_utilization: capacityUtilization,
          capital_wan: capitalWan,
          participation_rate: participationRate,
          entry_is_suspended: fact ? (fact.entry_is_suspended === true || fact.entry_is_suspended === 1) : null,
          entry_limit_status: limitStatus,
          risk_codes: riskCodes,
        };
      });
  }

  function build(rows, options = {}) {
    const weighted = options.weighted === true;
    const costPerSide = Math.max(0, finiteNumber(options.costPerSide) || 0);
    const turnoverCap = normalizeFraction(options.turnoverCap, 1);
    const targetWeightField = String(options.targetWeightField || "");
    const bySignal = new Map();

    for (const raw of rows || []) {
      const signalDate = exactDate(raw.signal_date || raw.signal_dt || raw.trade_date);
      if (!signalDate) continue;
      if (!bySignal.has(signalDate)) {
        bySignal.set(signalDate, {
          signal_date: signalDate,
          signal_month: monthLabel(signalDate),
          entry_date: exactDate(raw.entry_date || raw.entry_dt, signalDate),
          exit_date: exactDate(raw.exit_date || raw.return_date || raw.dt, signalDate),
          completed: false,
          rows: [],
        });
      }
      const period = bySignal.get(signalDate);
      const entryDate = exactDate(raw.entry_date || raw.entry_dt);
      const exitDate = exactDate(raw.exit_date || raw.return_date || raw.dt);
      if (entryDate && (!period.entry_date || entryDate < period.entry_date)) period.entry_date = entryDate;
      if (exitDate && (!period.exit_date || exitDate > period.exit_date)) period.exit_date = exitDate;
      if (raw.period_complete === true || raw.period_complete === 1) period.completed = true;
      if (raw.stock_code) period.rows.push(raw);
    }

    const periods = [...bySignal.values()]
      .filter(period => period.completed && (targetWeightField ||
        period.rows.length === 0
        || period.rows.some(row => validForwardReturn(row.fwd_return ?? row.ret) !== null)
      ))
      .sort((left, right) => left.signal_date.localeCompare(right.signal_date));

    let previous = null;
    let nav = 1;
    const ledger = [];
    const x = [];
    const navArr = [1];
    const retArr = [];
    const turnoverArr = [];
    if (periods.length) x.push(periods[0].signal_date);

    for (const period of periods) {
      const rawWeights = new Map();
      if (targetWeightField) {
        for (const row of period.rows) {
          const value = finiteNumber(row[targetWeightField]);
          if (value !== null && value > 0) rawWeights.set(String(row.stock_code), value);
        }
      } else if (options.weightingMode) {
        targetWeights(period.rows, options).forEach((value, code) => rawWeights.set(code, value));
      } else if (weighted) {
        for (const row of period.rows) {
          const value = finiteNumber(row.weight);
          if (value !== null && value > 0) rawWeights.set(String(row.stock_code), value);
        }
      } else {
        const uniqueCodes = [...new Set(period.rows.map(row => String(row.stock_code)))];
        const weight = uniqueCodes.length ? 1 / uniqueCodes.length : 0;
        uniqueCodes.forEach(code => rawWeights.set(code, weight));
      }
      const totalWeight = [...rawWeights.values()].reduce((sum, value) => sum + value, 0);
      const current = new Map([...rawWeights.entries()].map(([code, value]) => [
        code,
        totalWeight > 0 ? value / totalWeight : 0,
      ]));
      const constrainedCurrent = previous === null || turnoverCap >= 1 ? current : limitTurnover(current, previous, turnoverCap);

      let weightedReturn = 0;
      let observedWeight = 0;
      const rowByCode = new Map(period.rows.map(row => [String(row.stock_code), row]));
      const holdings = [...constrainedCurrent.entries()].map(([code, weight]) => {
        if (turnoverCap < 1 && !rowByCode.has(code)) {
          throw new Error(`${period.signal_date}：保留持仓${code}缺少当期收益记录，已停止回测`);
        }
        const row = rowByCode.get(code) || { stock_code: code };
        const memberReturn = validForwardReturn(row.fwd_return ?? row.ret);
        if (memberReturn !== null && weight > 0) {
          weightedReturn += weight * memberReturn;
          observedWeight += weight;
        }
        return {
          stock_code: code,
          weight,
          score: finiteNumber(row.cs ?? row.comp_score ?? row.score),
          fwd_return: memberReturn,
          industry_sw1: row.industry_sw1 || null,
          is_index_member: row.is_index_member === true || row.is_index_member === 1,
        };
      }).sort((left, right) => (
        (right.score ?? -Infinity) - (left.score ?? -Infinity)
        || left.stock_code.localeCompare(right.stock_code)
      ));
      const investedWeight = [...constrainedCurrent.values()].reduce((sum, value) => sum + value, 0);
      const grossReturn = options.missingReturnPolicy === "cash" ? weightedReturn
        : (observedWeight > 0 ? (weightedReturn / observedWeight) * investedWeight : 0);
      const initialPosition = previous === null;
      const periodTurnover = turnover(constrainedCurrent, previous);
      const costRate = (initialPosition ? costPerSide : 2 * costPerSide) * periodTurnover;
      const netReturn = Math.max(-1, (1 + grossReturn) * (1 - costRate) - 1);
      const changes = changeRows(constrainedCurrent, previous);
      nav *= 1 + netReturn;

      ledger.push({
        signal_date: period.signal_date,
        signal_month: period.signal_month,
        entry_date: period.entry_date,
        exit_date: period.exit_date,
        initial_position: initialPosition,
        turnover: periodTurnover,
        gross_return: grossReturn,
        net_return: netReturn,
        cost_rate: costRate,
        cash_weight: Math.max(0, 1 - investedWeight),
        missing_return_weight: Math.max(0, investedWeight - observedWeight),
        target_turnover: turnover(current, previous),
        turnover_limited: turnoverCap < 1 && previous !== null && turnover(current, previous) > turnoverCap + 1e-12,
        nav,
        holdings,
        changes,
        added: changes.filter(row => row.action === "added").map(row => row.stock_code),
        removed: changes.filter(row => row.action === "removed").map(row => row.stock_code),
      });
      x.push(period.exit_date);
      navArr.push(nav);
      retArr.push(netReturn);
      turnoverArr.push(periodTurnover);
      previous = constrainedCurrent;
    }

    return { x, navArr, retArr, turnoverArr, ledger };
  }

  function regularTurnoverStats(ledger) {
    const regular = (ledger || [])
      .filter(period => !period.initial_position)
      .map(period => finiteNumber(period.turnover))
      .filter(value => value !== null);
    if (!regular.length) return { average: null, annualized: null, count: 0 };
    const average = regular.reduce((sum, value) => sum + value, 0) / regular.length;
    return { average, annualized: average * 12, count: regular.length };
  }

  function clonePeriod(period) {
    return {
      ...period,
      holdings: (period?.holdings || []).map(row => ({ ...row })),
      changes: (period?.changes || []).map(row => ({ ...row })),
      added: (period?.added || []).slice(),
      removed: (period?.removed || []).slice(),
    };
  }

  function appendOnlyAfterCutoff(fullLedger, storedLedger, cutoff) {
    const stored = [];
    const known = new Set();
    for (const period of storedLedger || []) {
      const signalDate = String(period?.signal_date || "");
      if (!signalDate || known.has(signalDate)) continue;
      stored.push(clonePeriod(period));
      known.add(signalDate);
    }
    const appendedSignalDates = [];
    for (const period of fullLedger || []) {
      const signalDate = String(period?.signal_date || "");
      if (!signalDate || signalDate <= cutoff || known.has(signalDate)) continue;
      stored.push(clonePeriod(period));
      known.add(signalDate);
      appendedSignalDates.push(signalDate);
    }
    stored.sort((left, right) => String(left.signal_date).localeCompare(String(right.signal_date)));
    return { trackingLedger: stored, appendedSignalDates };
  }

  const api = {
    build,
    turnover,
    limitTurnover,
    targetWeights,
    normalizeWeightingMode,
    changeRows,
    executionOrders,
    regularTurnoverStats,
    appendOnlyAfterCutoff,
  };
  global.FactorPortfolioLedger = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
