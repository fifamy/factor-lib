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

  function turnover(current, previous) {
    if (!previous) return current.size ? 1 : 0;
    const codes = new Set([...current.keys(), ...previous.keys()]);
    let change = 0;
    codes.forEach(code => {
      change += Math.abs((current.get(code) || 0) - (previous.get(code) || 0));
    });
    return change * 0.5;
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

  function build(rows, options = {}) {
    const weighted = options.weighted === true;
    const costPerSide = Math.max(0, finiteNumber(options.costPerSide) || 0);
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
      .filter(period => period.completed && (
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
      if (weighted) {
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

      let weightedReturn = 0;
      let observedWeight = 0;
      const holdings = period.rows.map(row => {
        const code = String(row.stock_code);
        const weight = current.get(code) || 0;
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
      const grossReturn = observedWeight > 0 ? weightedReturn / observedWeight : 0;
      const initialPosition = previous === null;
      const periodTurnover = turnover(current, previous);
      const costRate = (initialPosition ? costPerSide : 2 * costPerSide) * periodTurnover;
      const netReturn = Math.max(-1, (1 + grossReturn) * (1 - costRate) - 1);
      const changes = changeRows(current, previous);
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
      previous = current;
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

  const api = { build, turnover, changeRows, regularTurnoverStats, appendOnlyAfterCutoff };
  global.FactorPortfolioLedger = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
