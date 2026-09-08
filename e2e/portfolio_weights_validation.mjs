import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:8798/';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
// Test-only module access; no diagnostic global is shipped.
await page.route('**/app.js?*', async route => {
  const response = await route.fetch();
  await route.fulfill({ response, body: await response.text() + '\n;globalThis.portfolioTest = { state, comboBacktest, currentComboPublishPayload, rawComboFromCurrent, validatePublishedCombo, comboToTempCompare, renderCompose, ensureDB, ensureComposeBase, loadComposeOptimizerMonths, searchOptimalWeights, rollingWeightWalkForward, monthEndDisplayDate };' });
});
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  await page.locator('.tree-l3[data-code="MOM12_1"]').click();
  await page.waitForSelector('#single-open-ledger', { timeout: 120000 });
  await page.locator('#single-open-ledger').click();
  await page.waitForSelector('#cps-ledger-month', { timeout: 180000 });
  const evidence = await page.evaluate(async () => {
    const t = portfolioTest, s = t.state;
    const args = [s.composeFactors, 30, 'cps_matrix', 'none', { mode: 'all' }, 20];
    const defaults = await t.comboBacktest(...args, 'equal', 1, 1);
    const score = await t.comboBacktest(...args, 'score', .1, 1);
    const cap = await t.comboBacktest(...args, 'market_cap', .1, 1);
    const limited = await t.comboBacktest(...args, 'score', .1, .25);
    const validate = (bt, ceiling = 1) => {
      if (bt.ledger.length < 100) throw Error('历史覆盖不足');
      for (const period of bt.ledger) {
        const weight = period.holdings.reduce((sum, h) => sum + h.weight, 0);
        if (Math.abs(weight + period.cash_weight - 1) > 1e-9) throw Error('权重与现金不守恒');
        if (period.holdings.some(h => h.weight > .1 + 1e-9)) throw Error('个股超过上限');
        if (!period.initial_position && !period.turnover_cap_overridden && period.turnover > ceiling + 1e-9) throw Error('非强制换手超过上限');
        const gross = period.holdings.reduce((sum, h) => sum + h.weight * (h.fwd_return ?? 0), 0);
        if (Math.abs(gross - period.gross_return) > 1e-10) throw Error('毛收益与实际持仓不一致');
        const cost = period.turnover * (period.initial_position ? .002 : .004);
        if (Math.abs(period.net_return - Math.max(-1, (1 + gross) * (1 - cost) - 1)) > 1e-10) throw Error('成本后收益不一致');
      }
    };
    validate(score); validate(cap); validate(limited, .25);
    const indexLimited = await t.comboBacktest(s.composeFactors, 30, 'cps_matrix', 'none',
      { mode: 'index_only', indexAlias: 'HS300' }, 20, 'score', .1, .25);
    await t.ensureDB({ stockMeta: false, descriptors: true, benchmarks: false, corr: false });
    const industryLimited = await t.comboBacktest(s.composeFactors, 30, 'cps_matrix', 'industry',
      { mode: 'all' }, 20, 'score', .1, .25);
    validate(indexLimited, .25); validate(industryLimited, .25);
    for (const period of indexLimited.ledger) {
      if (period.holdings.some(holding => !holding.is_index_member)) throw Error(`指数组合持有非成分：${period.signal_date}`);
    }
    for (const period of industryLimited.ledger) {
      if (period.holdings.some(holding => !holding.industry_sw1)) throw Error(`行业组合存在无行业持仓：${period.signal_date}`);
    }
    const portfolio = { weightingMode: 'score', maxStockWeight: .1, turnoverCap: .25 };
    const optimizerMonths = await t.loadComposeOptimizerMonths(s.composeFactors, { mode: 'all' }, null,
      { constraintMode: 'none', portfolio });
    const optimized = await t.searchOptimalWeights(optimizerMonths, [[1]], 30, [], {
      universe: { mode: 'all' }, constraintMode: 'none', portfolio, costPerSide: .002,
    });
    if (!optimized.sharpe.w || !Number.isFinite(optimized.sharpe.m?.sharpe)) throw Error('高级持仓规则下样本内搜索失败');
    const rolling = await t.rollingWeightWalkForward(optimizerMonths, [[1]], 30, [], {
      trainWindows: [12], horizons: [3], minCoverage: .75, currentWeights: [1],
      topNCandidates: [30], thresholdProfiles: [{ name: '当前阈值', conds: [] }],
      universe: { mode: 'all' }, constraintMode: 'none', portfolio, costPerSide: .002, yieldEvery: 999,
    });
    if (!rolling.folds.length || rolling.folds.some(fold => fold.trainEndDate > fold.selectionDate || fold.testEndDate <= fold.selectionDate)) {
      throw Error('高级持仓规则下参数滚动样本外失败或发生时点泄漏');
    }
    const industryOptimizerMonths = await t.loadComposeOptimizerMonths(s.composeFactors, { mode: 'all' }, null,
      { constraintMode: 'industry', portfolio });
    const industryOptimized = await t.searchOptimalWeights(industryOptimizerMonths, [[1]], 30, [], {
      universe: { mode: 'all' }, constraintMode: 'industry', portfolio, costPerSide: .002,
    });
    if (!industryOptimized.sharpe.w) throw Error('行业约束下样本内搜索失败');
    if (t.monthEndDisplayDate(limited.ledger.at(-1).exit_date) !== '2026-07-31') throw Error('最新月频净值没有显示在7月末');
    s.composeWeightingMode = 'score'; s.composeMaxStockWeight = .1; s.composeTurnoverCap = .25;
    const raw = t.rawComboFromCurrent('权重回归', new Set(), limited);
    const restored = t.validatePublishedCombo(JSON.parse(JSON.stringify(raw)), 0, new Set(s.catalog.map(f => f.code)));
    if (!restored.valid) throw Error(restored.invalidReason);
    const temp = t.comboToTempCompare(restored);
    for (const item of [raw, restored, temp, t.currentComboPublishPayload()]) {
      if (item.weightingMode !== 'score' || item.maxStockWeight !== .1 || item.turnoverCap !== .25) throw Error('快照丢失持仓规则');
    }
    const copy = await t.comboBacktest(...args, temp.weightingMode, temp.maxStockWeight, temp.turnoverCap);
    if (JSON.stringify(copy.retArr) !== JSON.stringify(limited.retArr)) throw Error('重新加载结果不同');
    await t.renderCompose();
    return {
      periods: limited.ledger.length,
      maxTurnover: Math.max(...limited.ledger.filter(p => !p.initial_position).map(p => p.turnover)),
      limitedMonths: limited.ledger.filter(p => p.turnover_limited).length,
      indexLimitedMonths: indexLimited.ledger.filter(p => p.turnover_limited).length,
      industryLimitedMonths: industryLimited.ledger.filter(p => p.turnover_limited).length,
      advancedOptimizerMonths: optimizerMonths.length,
      advancedWalkForwardFolds: rolling.folds.length,
      nav: { equal: defaults.navArr.at(-1), score: score.navArr.at(-1), marketCap: cap.navArr.at(-1), limited: limited.navArr.at(-1) },
    };
  });
  assert(evidence.limitedMonths > 0);
  assert(evidence.indexLimitedMonths > 0);
  assert(evidence.industryLimitedMonths > 0);
  assert.notEqual(evidence.nav.equal, evidence.nav.score);
  assert.notEqual(evidence.nav.score, evidence.nav.marketCap);
  await page.waitForSelector('#cps-ledger-month', { timeout: 180000 });
  assert.equal(await page.locator('#cps-weighting-mode').inputValue(), 'score');
  assert.equal(await page.locator('#cps-turnover-cap').inputValue(), '0.25');
  page.once('dialog', dialog => dialog.accept('E2E高级权重冻结'));
  await page.locator('#cps-save-mine').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('factorlib.compose.myCombos.v1') || '[]')
    .some(c => c.name === 'E2E高级权重冻结' && c.weightingMode === 'score' && c.maxStockWeight === .1 && c.turnoverCap === .25), null, { timeout: 180000 });
  await page.reload({ waitUntil: 'networkidle', timeout: 90000 });
  await page.locator('#combo-manager-btn').click();
  await page.locator('.combo-tab[data-tab="mine"]').click();
  await page.locator('.my-combo-card', { hasText: 'E2E高级权重冻结' }).getByRole('button', { name: '载入', exact: true }).click();
  await page.waitForSelector('#cps-ledger-month', { timeout: 180000 });
  assert.equal(await page.locator('#cps-weighting-mode').inputValue(), 'score');
  assert.equal(await page.locator('#cps-max-stock-weight').inputValue(), '0.1');
  assert.equal(await page.locator('#cps-turnover-cap').inputValue(), '0.25');
  await page.waitForSelector('.combo-validation', { timeout: 300000 });
  assert.equal(await page.locator('#combo-walk-forward-run').isDisabled(), false);
  assert.equal(await page.locator('#cps-optimize').isDisabled(), false);
  await page.evaluate(() => scrollTo(0, 0));
  if (process.env.PORTFOLIO_WEIGHTS_SCREENSHOT) await page.screenshot({ path: process.env.PORTFOLIO_WEIGHTS_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 2, null, { timeout: 5000 }).catch(() => {});
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const wide = overflow > 2 ? await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter(el => el.getBoundingClientRect().right > innerWidth + 2)
    .slice(0, 20).map(el => ({ tag: el.tagName, id: el.id, class: el.className, width: el.getBoundingClientRect().width }))) : [];
  assert(overflow <= 2, `页面溢出 ${overflow}px: ${JSON.stringify(wide)}`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, ...evidence, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
